import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { PostgresDatabase } from "@fracture/paypal-core";
import { inspectExpiredSession, operatorSessionIntentSchema, recoverExpiredSession } from "../lib/server/operator-session-recovery";
import { HOSTED_ORIGIN } from "../lib/server/workspace-handoff";

// Run only after an operator has verified the target backup and the named
// participant. The credential file is the durable intent; retries reuse it.
async function main() {
const [sourceId, file, reason, ...extra] = process.argv.slice(2);
if (!sourceId || !file || !reason || extra.length || process.env.FIELDPROOF_OPERATOR_RECOVERY !== "true" || process.env.APP_URL !== HOSTED_ORIGIN)
  throw new Error("Use the hosted database operator environment and pass original-session-id, private-intent-file, and an audit reason.");
const uri = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["postgres:", "postgresql:"].includes(uri.protocol) || ["localhost", "127.0.0.1", "[::1]", "invalid"].includes(uri.hostname)) throw new Error("This hosted recovery command must not write a retired local database.");
const path = resolve(file);
if (!/(?:^|\/)(?:\.private|\.setup-evidence|\.artifacts|\.local)\//.test(path)) throw new Error("Store the private recovery intent inside an ignored private-evidence folder.");
const directory = await stat(dirname(path));
if (!directory.isDirectory() || (directory.mode & 0o077)) throw new Error("The private intent directory must have mode0700.");
const db = new PostgresDatabase(uri.href);
try {
  let intent;
  try {
    const saved = await stat(path); if (!saved.isFile() || (saved.mode & 0o077)) throw new Error("Private recovery intents require mode0600.");
    intent = operatorSessionIntentSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (intent.sourceSessionId !== sourceId || intent.reason !== reason) throw new Error("The saved intent belongs to a different reviewed recovery.");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    const { mode: _mode, ...binding } = await inspectExpiredSession(db, sourceId), preparedAt = new Date();
    intent = operatorSessionIntentSchema.parse({ version: 1, ...binding, sessionId: randomUUID(), token: randomBytes(32).toString("base64url"), preparedAt: preparedAt.toISOString(), expiresAt: new Date(preparedAt.getTime() + 12 * 60 * 60_000).toISOString(), reason });
    await writeFile(path, JSON.stringify(intent, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  }
  const session = await recoverExpiredSession(db, intent);
  console.log(JSON.stringify({ recoveredSessionId: session.id, sourceSessionId: sourceId, projectId: session.projectId, role: session.role, expiresAt: session.expiresAt, credentialFile: path, providerCalls: 0, financialAuthorityRenewed: false }));
} finally { await db.close(); }
}
await main().catch(error => {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z_]+$/.test(error.code) ? error.code : "RECOVERY_NOT_COMPLETED";
  console.error(JSON.stringify({ code, message: "Private recovery did not complete. Check the reviewed intent, target environment and current membership; no credentials are shown." }));
  process.exitCode = 1;
});
