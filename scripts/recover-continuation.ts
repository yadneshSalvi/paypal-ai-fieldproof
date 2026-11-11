import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import { PostgresDatabase } from "@fracture/paypal-core";
import { DomainError } from "../lib/domain/money";
import { tokenHash } from "../lib/server/auth";
import { LOCAL_ORIGIN } from "../lib/server/workspace-handoff";
import { assertTransferConfiguration, openTransfer, type TransferEnvelope } from "../lib/server/workspace-transfer";
import { originalWorkspaceCookie, prepareWorkspaceRecovery, recoveryRequestDiagnostics, RECOVERY_REFERRER_POLICY, reissueImportedWorkspaceHandoff, validateRecoveryRequest } from "../lib/server/workspace-recovery";

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
let source: PostgresDatabase | undefined, target: PostgresDatabase | undefined;
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
const headers = {
  "Cache-Control": "private, no-store, max-age=0", "Referrer-Policy": RECOVERY_REFERRER_POLICY, "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://paypal-ai-fieldproof.vercel.app; base-uri 'none'; frame-ancestors 'none'",
};
const page = (content: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Continue your original workspace · Fieldproof</title><style>body{margin:0;background:#f4f1ea;color:#1e3a5f;font:17px/1.6 system-ui,sans-serif}main{max-width:620px;margin:10vh auto;padding:32px}small{letter-spacing:.12em;text-transform:uppercase;font-size:12px}h1{font-size:40px;line-height:1.15}button,a{display:inline-block;border:0;background:#1e3a5f;color:white;padding:16px 24px;border-radius:8px;font:inherit;cursor:pointer;text-decoration:none}button:focus-visible,a:focus-visible{outline:3px solid #b76700;outline-offset:4px}.note{border-top:1px solid #c7c6be;padding-top:20px;font-size:14px}</style><main><small>Fieldproof / private workspace continuation</small>${content}</main></html>`;

try {
  const bundleFile = option("--bundle"), envFile = option("--target-env");
  if (!bundleFile || !envFile || !args.includes("--source-writer-stopped")) throw new DomainError("RECOVERY_USAGE", "Use --bundle .private/transfers/ID.json --target-env /private/hosted.env --source-writer-stopped. Keep both databases held and the original application stopped.", 400);
  const bundlePath = resolve(bundleFile), privateRoot = resolve(".private");
  if (relative(privateRoot, bundlePath).startsWith("..") || bundlePath === privateRoot || [resolve(".env"), resolve("../.env")].includes(resolve(envFile))) throw new DomainError("RECOVERY_INPUT_INVALID", "Use the encrypted private transfer bundle and the isolated hosted environment snapshot.", 400);
  if ((await stat(resolve(envFile))).mode & 0o077) throw new DomainError("RECOVERY_ENV_PERMISSIONS", "The private hosted environment file must have mode 0600.", 409);
  const env = parseEnv(await readFile(resolve(envFile), "utf8"));
  if (["DATABASE_URL", "AUTH_SECRET", "PAYPAL_CLIENT_ID", "BLOB_READ_WRITE_TOKEN"].some(key => !env[key] || /\[SENSITIVE\]|\[REDACTED\]/.test(env[key]))
    || env.PAYPAL_ENVIRONMENT !== "sandbox" || env.PAYPAL_PROJECT_ISOLATED !== "true" || (env.APP_URL ?? "https://paypal-ai-fieldproof.vercel.app") !== "https://paypal-ai-fieldproof.vercel.app" || !process.env.DATABASE_URL)
    throw new DomainError("RECOVERY_ENV_INVALID", "Use the current isolated hosted configuration and the original local database configuration.", 409);
  const bundle = openTransfer(JSON.parse(await readFile(bundlePath, "utf8")) as TransferEnvelope);
  assertTransferConfiguration(bundle, { authSecret: env.AUTH_SECRET!, clientId: env.PAYPAL_CLIENT_ID!, blobToken: env.BLOB_READ_WRITE_TOKEN! });
  source = new PostgresDatabase(process.env.DATABASE_URL); target = new PostgresDatabase(env.DATABASE_URL!);
  const identitySql = "SELECT current_database() AS database,current_schema() AS schema,inet_server_addr()::text AS address,inet_server_port() AS port";
  const identities = await Promise.all([source.query(identitySql), target.query(identitySql)]);
  if (JSON.stringify(identities[0].rows[0]) === JSON.stringify(identities[1].rows[0])) throw new DomainError("RECOVERY_SAME_DATABASE", "The original and destination databases must be distinct.", 409);
  const context = await prepareWorkspaceRecovery(source, target, bundle);
  const nonces = new Map<string, { cookieHash: string; expiresAt: number }>();
  let running = false, finished = false;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 30_000 }, async (req, res) => {
    let requestMetadata: ReturnType<typeof recoveryRequestDiagnostics> | undefined;
    const reply = (status: number, content: string) => { res.writeHead(status, { ...headers, "Content-Type": "text/html; charset=utf-8", ...(status === 503 ? { "Retry-After": "30" } : {}) }); res.end(page(content)); };
    try {
      if (!["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") || req.headers.host !== "localhost:4102" || req.headers.forwarded || req.headers["x-forwarded-host"] || req.headers["x-forwarded-proto"]) throw new DomainError("RECOVERY_LOOPBACK_REQUIRED", "Open this page at http://localhost:4102/continue in the original browser.", 403);
      if (finished) return reply(410, "<h1>The continuation has moved.</h1><p>Use the hosted page opened by the original request.</p>");
      const url = new URL(req.url ?? "/", LOCAL_ORIGIN);
      if (req.method === "GET" && url.pathname === "/continue" && !url.search) {
        const cookieHash = tokenHash(originalWorkspaceCookie(req.headers.cookie ?? null));
        if (context.bindings.filter(binding => binding.originalSessionTokenHash === cookieHash).length !== 1) throw new DomainError("HANDOFF_RECOVERY_UNAVAILABLE", "This tab does not hold the original workspace's private session cookie.", 403);
        for (const [value, item] of nonces) if (item.expiresAt <= Date.now()) nonces.delete(value);
        if (nonces.size >= 8) nonces.clear();
        const nonce = randomBytes(32).toString("base64url"); nonces.set(nonce, { cookieHash, expiresAt: Date.now() + 120_000 });
        return reply(200, `<h1>Continue your original workspace.</h1><p>Your records have reached the hosted workspace. This button uses this browser's original private session to recover its continuation link.</p><form method="post" action="/continue/recover"><input type="hidden" name="nonce" value="${nonce}"><button type="submit">Continue to the hosted workspace</button></form><p class="note">The same participant, approvals and original expiry stay in place. Both workspaces remain paused. This action does not authorize or send a payment.</p>`);
      }
      if (req.method !== "POST" || url.pathname !== "/continue/recover" || url.search) return reply(404, "<h1>This page is unavailable.</h1>");
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 256) throw new DomainError("RECOVERY_INPUT_INVALID", "This request is invalid.", 400); chunks.push(Buffer.from(chunk)); }
      const body = Buffer.concat(chunks).toString("utf8"), nonce = new URLSearchParams(body).get("nonce") ?? "", challenge = nonces.get(nonce);
      if (!challenge || challenge.expiresAt <= Date.now()) throw new DomainError("RECOVERY_CHALLENGE_EXPIRED", "Refresh this local page, then use its Continue button.", 409);
      const requestHeaders = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (value) requestHeaders.set(name, Array.isArray(value) ? value.join(",") : value);
      const request = new Request(`${LOCAL_ORIGIN}/continue/recover`, { method: "POST", headers: requestHeaders, body });
      requestMetadata = recoveryRequestDiagnostics(request);
      const cookie = await validateRecoveryRequest(request, nonce);
      if (tokenHash(cookie) !== challenge.cookieHash) throw new DomainError("HANDOFF_RECOVERY_UNAVAILABLE", "The original browser session changed. Recovery is paused.", 403);
      if (running) return reply(409, "<h1>Your continuation is opening.</h1><p>Allow the original request to finish.</p>");
      running = true;
      try {
        const recovered = await reissueImportedWorkspaceHandoff(source!, target!, context, cookie);
        finished = true; nonces.clear();
        res.writeHead(303, { ...headers, Location: recovered.url }); res.end();
        console.log(JSON.stringify({ bridge: "continuation_reissued", sourceWrites: 0, providerCalls: 0, originalExpiryPreserved: true }));
        server.close(async () => { await Promise.allSettled([source!.close(), target!.close()]); });
      } finally { running = false; }
    } catch (error) {
      const problem = error instanceof DomainError ? error : new DomainError("RECOVERY_UNAVAILABLE", "The continuation could not be recovered. The original data and expiry remain unchanged; ask the operator to check the held destination.", 503);
      reply(problem.status, `<h1>Your records are still safe.</h1><p>${escape(problem.message)}</p><p><a href="/continue">Check this original session</a></p><small>${escape(problem.code)}</small>`);
      console.error(JSON.stringify({ bridge: "request_refused", code: problem.code, providerCalls: 0, ...(problem.code === "HANDOFF_RECOVERY_ORIGIN_DENIED" ? { requestMetadata } : {}) }));
    }
  });
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(4102, "127.0.0.1", () => { server.off("error", reject); resolveListen(); }); });
  console.log(JSON.stringify({ bridge: "ready", url: `${LOCAL_ORIGIN}/continue`, bind: "127.0.0.1:4102", source: "read_only_held", destination: "held", providerCalls: 0 }));
  const close = () => server.close(async () => { await Promise.allSettled([source!.close(), target!.close()]); });
  process.once("SIGINT", close); process.once("SIGTERM", close);
} catch (error) {
  console.error(JSON.stringify(error instanceof DomainError ? { code: error.code, error: error.message } : { code: "RECOVERY_BRIDGE_UNAVAILABLE", error: "The loopback recovery bridge could not start. Keep the original application stopped and both databases held." }));
  await Promise.allSettled([source?.close(), target?.close()]); process.exitCode = 1;
}
