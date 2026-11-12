/** Test-only entry point. It never starts an app, calls HTTP, or uses a shared
 * schema. Run from the independently owned clone with an explicit cwd. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { after } from "node:test";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const expectedRoot = "/Users/yadneshsalvi/code/hackathons/paypal-ai-hackathon/fieldproof/.local/lifecycle-personal-stage14";
assert.equal(root, expectedRoot, "Use the independently owned personal-backend clone.");
assert.equal(process.cwd(), root, "Every test command requires this exact explicit absolute cwd.");
const files = process.argv.slice(2);
assert(files.length > 0 && files.length <= 5);
for (const file of files) assert(/^tests\/lifecycle-personal[a-z-]*\.test\.ts$/.test(file), "Only the owned focused personal suites are eligible.");
const state = globalThis as typeof globalThis & { fieldproofDb?: unknown; fieldproofReady?: unknown };
assert.equal(state.fieldproofDb, undefined, "A pre-existing application database cache is forbidden.");
assert.equal(state.fieldproofReady, undefined, "A pre-existing application initialization is forbidden.");
const directory = path.join(root, ".local/lifecycle-personal-unit"), filename = path.join(directory, "private.json");
const [directoryStat, fileStat] = await Promise.all([lstat(directory), lstat(filename)]);
assert(directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && (directoryStat.mode & 0o777) === 0o700);
assert(fileStat.isFile() && !fileStat.isSymbolicLink() && (fileStat.mode & 0o777) === 0o600);
let config: Record<string, string>;
try { config = JSON.parse(await readFile(filename, "utf8")) as Record<string, string>; }
catch { throw new Error("The private runner configuration is not valid JSON."); }
assert(Object.values(config).every(value => typeof value === "string"));
let original: URL;
try { original = new URL(config.DATABASE_URL); }
catch { throw new Error("The private runner requires its exact owned PostgreSQL connection."); }
assert(["postgres:", "postgresql:"].includes(original.protocol));
assert.equal(original.hostname, "127.0.0.1"); assert.equal(original.port, "55571");
assert.equal(original.pathname, "/fp_governance_stage13"); assert.equal(original.username, "fp_governance_app");
assert(original.password.length > 0 && original.search === "" && original.hash === "");
assert.equal(config.APP_URL, "http://localhost:4612");
assert.equal(config.FIELDPROOF_GOVERNANCE_REVIEW, "true");
assert.equal(config.FIELDPROOF_PROVIDER_ACCESS, "disabled");
assert.equal(config.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED, "false");
assert.equal(config.PAYPAL_ENVIRONMENT, "sandbox");
assert(config.AUTH_SECRET.length >= 32);
const credentials = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "PAYPAL_MERCHANT_SCOPE", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "BLOB_READ_WRITE_TOKEN"];
for (const key of credentials) assert((config[key] ?? "") === "", `External credential ${key} must be blank.`);
// Inherited credentials cannot survive the strict private runner.
for (const key of Object.keys(process.env)) if (/(?:TOKEN|SECRET|API_KEY|CREDENTIAL|CLIENT_ID|DATABASE_URL|APP_URL|FIELDPROOF_|^AWS_|^AZURE_|^GOOGLE_|^GCP_|^OPENAI_|^GEMINI_|^PAYPAL_|^VERCEL_|^BLOB_)/i.test(key)) delete process.env[key];
for (const [key, value] of Object.entries(config)) process.env[key] = value;
Object.assign(process.env, { NODE_ENV: "test", NEXT_TELEMETRY_DISABLED: "1" });

const denied = () => { throw new Error("Personal lifecycle tests permit no HTTP, TLS, UDP, app requests, or external sockets."); };
globalThis.fetch = (async () => denied()) as typeof fetch;
http.request = denied as typeof http.request; http.get = denied as typeof http.get;
https.request = denied as typeof https.request; https.get = denied as typeof https.get;
tls.connect = denied as typeof tls.connect; dgram.createSocket = denied as typeof dgram.createSocket;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options: { host?: unknown; port?: unknown; path?: unknown } = first && typeof first === "object" ? first as { host?: unknown; port?: unknown; path?: unknown } : { port: first, host: args[1] };
  assert.equal(options.path, undefined, "Unix sockets are forbidden.");
  assert.equal(options.host, "127.0.0.1", "Only the owned loopback PostgreSQL host is permitted.");
  assert.equal(Number(options.port), 55571, "Only the owned PostgreSQL port is permitted.");
  return Reflect.apply(connect, this, args);
} as typeof connect;
syncBuiltinESMExports();

// Importing the generic SQL driver is safe; application DB modules are loaded
// only AFTER a fresh schema and its sole search_path have been established.
const { PostgresDatabase } = await import("@fracture/paypal-core");
const admin = new PostgresDatabase(original.href), schema = `lifecycle_personal_test_${randomUUID().replaceAll("-", "")}`;
assert(/^lifecycle_personal_test_[a-f0-9]{32}$/.test(schema));
let created = false, isolated: InstanceType<typeof PostgresDatabase> | null = null;
let app: typeof import("../../lib/server/db") | null = null;
let disposed = false;
async function dispose() {
  if (disposed) return; disposed = true;
  try { if (app && state.fieldproofDb) await app.database().close(); }
  finally {
    try { await isolated?.close(); }
    finally {
      try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
      finally { await admin.close(); }
    }
  }
}
try {
  await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  const own = new URL(original.href); own.searchParams.set("options", `-c search_path=${schema}`);
  isolated = new PostgresDatabase(own.href);
  const scope = (await isolated.query<{ own: string; paths: string[] }>("SELECT current_schema() own,current_schemas(false)::text[] paths")).rows[0];
  assert.equal(scope.own, schema); assert.deepEqual(scope.paths, [schema]);
  assert.equal(state.fieldproofDb, undefined); assert.equal(state.fieldproofReady, undefined);
  process.env.DATABASE_URL = own.href;
  process.env.FIELDPROOF_LIFECYCLE_PERSONAL_TEST_SCHEMA = schema;
  app = await import("../../lib/server/db");
  await app.initializeDatabase();
  const current = (await app.query<{ own: string; paths: string[] }>("SELECT current_schema() own,current_schemas(false)::text[] paths"))[0];
  assert.equal(current.own, schema); assert.deepEqual(current.paths, [schema]);
  const { LIFECYCLE_SCHEMA } = await import("../../lib/server/lifecycle-schema");
  await app.database().query(LIFECYCLE_SCHEMA);
  after(dispose);
  for (const file of files) {
    await import(pathToFileURL(path.join(root, file)).href);
  }
  console.log(`Personal lifecycle guard: fresh ${schema}; sole search_path; owned PostgreSQL only; HTTP/providers disabled.`);
} catch (error) { await dispose(); throw error; }
