/** Fresh-process, read-only recovery. Launched only by the reviewed fresh-schema
 * suite with one owner-only descriptor. No connection to a default schema. */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lstat, readFile } from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
import { z } from "zod";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(root, "/Users/yadneshsalvi/code/hackathons/paypal-ai-hackathon/fieldproof/.local/recognition-stage14"); assert.equal(process.cwd(), root);
const identifier = z.uuid().parse(process.argv[2]); assert.equal(process.argv.length, 3);
const dir = path.join(root, ".local/recognition-unit");
for (const [filename, mode] of [[dir, 0o700], [path.join(dir, "private.json"), 0o600], [path.join(dir, `reopen-${identifier}.json`), 0o600]] as const) {
  const stat = await lstat(filename); assert(!stat.isSymbolicLink() && (stat.mode & 0o777) === mode && (mode === 0o700 ? stat.isDirectory() : stat.isFile()));
}
const descriptor = z.object({ parentPid: z.number().int().positive(), schema: z.string().regex(/^recognition_test_[a-f0-9]{32}$/), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  slug: z.string().regex(/^[A-Za-z0-9_-]{24}$/), accessId: z.string().regex(/^[a-f0-9]{64}$/), intentId: z.uuid() }).strict().parse(JSON.parse(await readFile(path.join(dir, `reopen-${identifier}.json`), "utf8")));
assert.equal(descriptor.parentPid, process.ppid, "Only the live owning test process can request a reopen.");
const config = z.object({ DATABASE_URL: z.string(), AUTH_SECRET: z.string().min(32), APP_URL: z.literal("http://localhost:4612"), FIELDPROOF_GOVERNANCE_REVIEW: z.literal("true"),
  FIELDPROOF_PROVIDER_ACCESS: z.literal("disabled"), FIELDPROOF_PURPOSE_CHECKOUT_ENABLED: z.literal("false"), PAYPAL_ENVIRONMENT: z.literal("sandbox") }).strict().parse(JSON.parse(await readFile(path.join(dir, "private.json"), "utf8")));
const url = new URL(config.DATABASE_URL);
assert(["postgres:", "postgresql:"].includes(url.protocol)); assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55571");
assert.equal(url.pathname, "/fp_governance_stage13"); assert.equal(url.username, "fp_governance_app"); assert(url.password && !url.search && !url.hash);
for (const key of Object.keys(process.env)) if (/(?:TOKEN|SECRET|API_KEY|CREDENTIAL|CLIENT_ID|DATABASE_URL|APP_URL|FIELDPROOF_|^AWS_|^AZURE_|^GOOGLE_|^GCP_|^OPENAI_|^GEMINI_|^PAYPAL_|^VERCEL_|^BLOB_)/i.test(key)) delete process.env[key];
Object.assign(process.env, config, { NODE_ENV: "test", NEXT_TELEMETRY_DISABLED: "1" });
url.searchParams.set("options", `-c search_path=${descriptor.schema}`); process.env.DATABASE_URL = url.href;
const denied = () => { throw new Error("Fresh recovery permits only the owning disposable PostgreSQL schema."); };
globalThis.fetch = (async () => denied()) as typeof fetch;
http.request = denied as typeof http.request; http.get = denied as typeof http.get; https.request = denied as typeof https.request; https.get = denied as typeof https.get;
tls.connect = denied as typeof tls.connect; dgram.createSocket = denied as typeof dgram.createSocket;
for (const owner of [dns, dns.promises]) for (const key of Object.keys(owner)) if (/^(lookup|resolve|reverse|Resolver)/.test(key)) Reflect.set(owner, key, denied);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0], options = first && typeof first === "object" ? first as { path?: unknown; host?: unknown; port?: unknown } : { path: undefined, port: first, host: args[1] };
  assert.equal(options.path, undefined); assert.equal(options.host, "127.0.0.1"); assert.equal(Number(options.port), 55571); return Reflect.apply(connect, this, args);
} as typeof connect;
syncBuiltinESMExports();
const cache = globalThis as typeof globalThis & { fieldproofDb?: unknown; fieldproofReady?: unknown };
assert.equal(cache.fieldproofDb, undefined); assert.equal(cache.fieldproofReady, undefined);
const { PostgresDatabase } = await import("@fracture/paypal-core"); const check = new PostgresDatabase(url.href);
try {
  const scope = (await check.query<{ own: string; paths: string[] }>("SELECT current_schema() own,current_schemas(false)::text[] paths")).rows[0];
  assert.equal(scope.own, descriptor.schema); assert.deepEqual(scope.paths, [descriptor.schema]);
} finally { await check.close(); }
const app = await import("../../lib/server/db");
try {
  const { readRecognitionCommand } = await import("../../lib/server/recognition-commands"), { readRecognitionDesk, readPublicRecognition } = await import("../../lib/server/recognition-store");
  const request = { projectToken: descriptor.token }, receipt = await readRecognitionCommand(request, descriptor.intentId, descriptor.accessId);
  const desk = await readRecognitionDesk(request, descriptor.slug), page = await readPublicRecognition(descriptor.slug);
  console.log(JSON.stringify({ intentId: receipt.intentId, commandId: receipt.commandId, ownState: desk.own?.state, ownHasLabel: desk.own?.label !== null,
    publicLabels: page.entries.length, originalSessionExpiresAt: desk.access.sessionExpiresAt }));
} finally { await app.database().close(); }
