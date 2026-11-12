/** Only this reviewed entry point may run recognition PostgreSQL tests. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe } from "node:test";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(root, "/Users/yadneshsalvi/code/hackathons/paypal-ai-hackathon/fieldproof/.local/recognition-stage14");
assert.equal(process.cwd(), root, "Use the exact explicit independent-clone cwd.");
const files = process.argv.slice(2);
assert(files.length > 0 && files.length <= 5);
for (const file of files) assert(/^tests\/recognition[a-z-]*\.test\.ts$/.test(file));
const state = globalThis as typeof globalThis & { fieldproofDb?: unknown; fieldproofReady?: unknown };
assert.equal(state.fieldproofDb, undefined); assert.equal(state.fieldproofReady, undefined);
const directory = path.join(root, ".local/recognition-unit"), filename = path.join(directory, "private.json");
const [directoryStat, fileStat] = await Promise.all([lstat(directory), lstat(filename)]);
assert(directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && (directoryStat.mode & 0o777) === 0o700);
assert(fileStat.isFile() && !fileStat.isSymbolicLink() && (fileStat.mode & 0o777) === 0o600);
let config: Record<string, string>;
try { config = JSON.parse(await readFile(filename, "utf8")) as Record<string, string>; }
catch { throw new Error("The restricted recognition test configuration is invalid."); }
assert(Object.values(config).every(value => typeof value === "string"));
const allowed = new Set(["DATABASE_URL", "AUTH_SECRET", "APP_URL", "FIELDPROOF_GOVERNANCE_REVIEW", "FIELDPROOF_PROVIDER_ACCESS", "FIELDPROOF_PURPOSE_CHECKOUT_ENABLED", "PAYPAL_ENVIRONMENT"]);
const externalKeys = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "PAYPAL_MERCHANT_SCOPE", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "BLOB_READ_WRITE_TOKEN"];
for (const key of externalKeys) assert(!config[key], "Provider credentials are forbidden.");
for (const key of Object.keys(config)) assert(allowed.has(key) || externalKeys.includes(key) && !config[key], "Unexpected private configuration field.");
let original: URL;
try { original = new URL(config.DATABASE_URL); } catch { throw new Error("The exact owned PostgreSQL connection is required."); }
assert(["postgres:", "postgresql:"].includes(original.protocol));
assert.equal(original.hostname, "127.0.0.1"); assert.equal(original.port, "55571");
assert.equal(original.pathname, "/fp_governance_stage13"); assert.equal(original.username, "fp_governance_app");
assert(original.password.length > 0 && !original.search && !original.hash);
assert.equal(config.APP_URL, "http://localhost:4612");
assert.equal(config.FIELDPROOF_GOVERNANCE_REVIEW, "true");
assert.equal(config.FIELDPROOF_PROVIDER_ACCESS, "disabled");
assert.equal(config.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED, "false");
assert.equal(config.PAYPAL_ENVIRONMENT, "sandbox"); assert(config.AUTH_SECRET.length >= 32);
for (const key of Object.keys(process.env)) if (/(?:TOKEN|SECRET|API_KEY|CREDENTIAL|CLIENT_ID|DATABASE_URL|APP_URL|FIELDPROOF_|^AWS_|^AZURE_|^GOOGLE_|^GCP_|^OPENAI_|^GEMINI_|^PAYPAL_|^VERCEL_|^BLOB_)/i.test(key)) delete process.env[key];
for (const key of allowed) process.env[key] = config[key];
Object.assign(process.env, { NODE_ENV: "test", NEXT_TELEMETRY_DISABLED: "1" });
const denied = () => { throw new Error("Recognition tests allow only the exact owned PostgreSQL socket; HTTP, DNS, TLS, UDP and other sockets are denied."); };
globalThis.fetch = (async () => denied()) as typeof fetch;
http.request = denied as typeof http.request; http.get = denied as typeof http.get;
https.request = denied as typeof https.request; https.get = denied as typeof https.get;
tls.connect = denied as typeof tls.connect; dgram.createSocket = denied as typeof dgram.createSocket;
for (const owner of [dns, dns.promises]) for (const name of Object.keys(owner))
  if (/^(lookup|resolve|reverse|Resolver)/.test(name)) Reflect.set(owner, name, denied);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === "object" ? first as { host?: unknown; port?: unknown; path?: unknown } : { port: first, host: args[1], path: undefined };
  assert.equal(options.path, undefined); assert.equal(options.host, "127.0.0.1"); assert.equal(Number(options.port), 55571);
  return Reflect.apply(connect, this, args);
} as typeof connect;
syncBuiltinESMExports();
const { PostgresDatabase } = await import("@fracture/paypal-core");
const admin = new PostgresDatabase(original.href), schema = `recognition_test_${randomUUID().replaceAll("-", "")}`;
assert(/^recognition_test_[a-f0-9]{32}$/.test(schema));
let created = false, isolated: InstanceType<typeof PostgresDatabase> | null = null;
let app: typeof import("../../lib/server/db") | null = null, disposed = false;
async function dispose() {
  if (disposed) return; disposed = true;
  try { if (app && state.fieldproofDb) await app.database().close(); }
  finally { try { await isolated?.close(); } finally { try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.close(); } } }
}
try {
  await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  const own = new URL(original.href); own.searchParams.set("options", `-c search_path=${schema}`);
  isolated = new PostgresDatabase(own.href);
  const scope = (await isolated.query<{ own: string; paths: string[] }>("SELECT current_schema() own,current_schemas(false)::text[] paths")).rows[0];
  assert.equal(scope.own, schema); assert.deepEqual(scope.paths, [schema]);
  assert.equal(state.fieldproofDb, undefined); assert.equal(state.fieldproofReady, undefined);
  process.env.DATABASE_URL = own.href; process.env.FIELDPROOF_RECOGNITION_TEST_SCHEMA = schema;
  app = await import("../../lib/server/db"); await app.initializeDatabase();
  const current = (await app.query<{ own: string; paths: string[] }>("SELECT current_schema() own,current_schemas(false)::text[] paths"))[0];
  assert.equal(current.own, schema); assert.deepEqual(current.paths, [schema]);
  const { RECOGNITION_SCHEMA } = await import("../../lib/server/recognition-schema");
  await app.database().query(RECOGNITION_SCHEMA);
  await describe("Guarded recognition qualification", async () => {
    // Keep all dynamic suite registrations beneath one awaited parent. Without
    // this scope node:test can finish the first file and run cleanup before the
    // next imported suite has registered.
    after(dispose);
    for (const file of files) await import(pathToFileURL(path.join(root, file)).href);
  });
  console.log(`Recognition guard: fresh ${schema}; sole search_path; owned PostgreSQL only; providers denied.`);
} catch (error) { await dispose(); throw error; }
