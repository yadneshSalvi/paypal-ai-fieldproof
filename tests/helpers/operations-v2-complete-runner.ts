/** Approved-scope test entry point only. No application server, public data,
 * provider access, new cluster/role/database or existing fixture is eligible. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe } from "node:test";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(root, "/Users/yadneshsalvi/code/hackathons/paypal-ai-hackathon/fieldproof/.local/operations-complete-stage14");
assert.equal(process.cwd(), root, "Use the explicit absolute owned operations clone cwd.");
const JOINED_DB_SOURCE_SHA256 = "ef608b878cf98565441d093908a672f4c3c8dba8b48d9c7ac0903b7933aed85d";
assert.equal(createHash("sha256").update(await readFile(path.join(root,"lib/server/db.ts"))).digest("hex"), JOINED_DB_SOURCE_SHA256, "Use only the exact reviewed joined schema24 registration; no initializer fallback is eligible.");
const files = process.argv.slice(2);
assert(files.length > 0 && files.length <= 2);
for (const file of files) assert(/^tests\/workspace-transfer-v2-extensions(?:-catalog)?\.test\.ts$/.test(file), "Only owned focused v2 suites are eligible.");
assert.equal(new Set(files).size,files.length,"Every owned suite may register only once.");
for(const file of files) { const stat=await lstat(path.join(root,file)); assert(stat.isFile() && !stat.isSymbolicLink(),"Resolve every exact owned suite before any database work."); }
const fragmentHashes = {"lib/server/lifecycle-schema.ts": "33e87485d4287ea94ef95dd7c0504e0b2ffd01be50147376955756402bc8a5d0", "lib/server/procurement-schema.ts": "7b8c0ffeeb76e56734b506c29bfd32b7f55ced665b7e29e0dbc69d59c723ad39", "lib/server/recognition-schema.ts": "a71c73a6a4fd7df98f22898da9445db62f7d17cd8c0a122166b254f8a2545c67"};
for(const [file, expected] of Object.entries(fragmentHashes)) assert.equal(createHash("sha256").update(await readFile(path.join(root,file))).digest("hex"), expected,"Pin every joined schema fragment before any database work.");
const state = globalThis as typeof globalThis & { fieldproofDb?: unknown; fieldproofReady?: unknown; fieldproofOperationsV2Test?: unknown };
assert.equal(state.fieldproofDb, undefined); assert.equal(state.fieldproofReady, undefined); assert.equal(state.fieldproofOperationsV2Test, undefined);
const directory = path.join(root, ".local/operations-complete-v2-unit"), filename = path.join(directory, "private.json");
const [directoryStat, fileStat] = await Promise.all([lstat(directory), lstat(filename)]);
assert(directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && (directoryStat.mode & 0o777) === 0o700);
assert(fileStat.isFile() && !fileStat.isSymbolicLink() && (fileStat.mode & 0o777) === 0o600);
let config: Record<string, string>;
try { config = JSON.parse(await readFile(filename, "utf8")) as Record<string, string>; }
catch { throw new Error("The private operations runner configuration is invalid."); }
const configKeys = ["DATABASE_URL", "AUTH_SECRET", "APP_URL", "FIELDPROOF_GOVERNANCE_REVIEW", "FIELDPROOF_PROVIDER_ACCESS", "FIELDPROOF_PURPOSE_CHECKOUT_ENABLED", "PAYPAL_ENVIRONMENT", "PAYPAL_PROJECT_ISOLATED", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_MERCHANT_SCOPE", "PAYPAL_WEBHOOK_ID", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "BLOB_READ_WRITE_TOKEN", "NEXT_TELEMETRY_DISABLED"];
assert.deepEqual(Object.keys(config).sort(), [...configKeys].sort(), "Only the exact reviewed private configuration keys are eligible.");
assert(Object.values(config).every(value => typeof value === "string"));
let original: URL;
try { original = new URL(config.DATABASE_URL); }
catch { throw new Error("Use the exact owned operations regression connection."); }
assert(["postgres:", "postgresql:"].includes(original.protocol));
assert.equal(original.hostname, "127.0.0.1"); assert.equal(original.port, "55571");
assert.equal(original.pathname, "/fp_governance_stage13"); assert.equal(original.username, "fp_governance_app");
assert(original.password.length > 0 && !original.search && !original.hash);
assert.equal(config.APP_URL, "http://localhost:4612");
assert.equal(config.FIELDPROOF_GOVERNANCE_REVIEW, "true");
assert.equal(config.FIELDPROOF_PROVIDER_ACCESS, "disabled");
assert.equal(config.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED, "false");
assert.equal(config.PAYPAL_ENVIRONMENT, "sandbox"); assert(config.AUTH_SECRET.length >= 32);
for (const key of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "PAYPAL_MERCHANT_SCOPE", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "BLOB_READ_WRITE_TOKEN"]) assert((config[key] ?? "") === "", `External credential ${key} must be blank.`);
for (const key of Object.keys(process.env)) if (/(?:TOKEN|SECRET|API_KEY|CREDENTIAL|CLIENT_ID|DATABASE_URL|APP_URL|FIELDPROOF_|^AWS_|^AZURE_|^GOOGLE_|^GCP_|^OPENAI_|^GEMINI_|^PAYPAL_|^VERCEL_|^BLOB_|^PG[A-Z_]*$)/i.test(key)) delete process.env[key];
for (const [key, value] of Object.entries(config)) process.env[key] = value;
Object.assign(process.env, { NODE_ENV: "test", NEXT_TELEMETRY_DISABLED: "1" });
const denied = () => { throw new Error("Operations v2 regressions permit no HTTP, TLS, UDP, app requests or external sockets."); };
globalThis.fetch = (async () => denied()) as typeof fetch;
http.request = denied as typeof http.request; http.get = denied as typeof http.get;
https.request = denied as typeof https.request; https.get = denied as typeof https.get;
tls.connect = denied as typeof tls.connect; dgram.createSocket = denied as typeof dgram.createSocket;
for (const api of [dns, dns.promises, dnsPromises]) {
  const mutable = api as unknown as Record<string, unknown>;
  for (const key of Object.keys(mutable)) if (/^(?:lookup|resolve|reverse|Resolver)/.test(key)) mutable[key] = denied;
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options: { host?: unknown; port?: unknown; path?: unknown } = first && typeof first === "object" ? first as { host?: unknown; port?: unknown; path?: unknown } : { port: first, host: args[1] };
  assert.equal(options.path, undefined); assert.equal(options.host, "127.0.0.1"); assert.equal(Number(options.port), 55571);
  return Reflect.apply(connect, this, args);
} as typeof connect;
syncBuiltinESMExports();

const { PostgresDatabase } = await import("@fracture/paypal-core");
const admin = new PostgresDatabase(original.href), id = randomUUID().replaceAll("-", "");
const schemas = { source: `operations_c_source_test_${id}`, target: `operations_c_target_test_${id}` };
for (const schema of Object.values(schemas)) assert(/^operations_c_(?:source|target)_test_[a-f0-9]{32}$/.test(schema));
const created: string[] = [], connections: InstanceType<typeof PostgresDatabase>[] = [];
let app: typeof import("../../lib/server/db") | null = null, disposed = false;
async function dispose() {
  if (disposed) return; disposed = true;
  try { if (app && state.fieldproofDb) await app.database().close(); }
  finally {
    try { await Promise.all(connections.map(connection => connection.close())); }
    finally {
      try { for (const schema of [...created].reverse()) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
      finally { await admin.close(); }
    }
  }
}
try {
  // BOTH namespaces and their sole search paths exist before application import.
  const endpoints: Record<string, { database: InstanceType<typeof PostgresDatabase>; url: string }> = {};
  for (const [kind, schema] of Object.entries(schemas)) {
    await admin.query(`CREATE SCHEMA "${schema}"`); created.push(schema);
    const url = new URL(original.href); url.searchParams.set("options", `-c search_path=${schema}`);
    const database = new PostgresDatabase(url.href); connections.push(database);
    const current = (await database.query<{ own: string; paths: string[] }>("SELECT current_schema() own,current_schemas(false)::text[] paths")).rows[0];
    assert.equal(current.own, schema); assert.deepEqual(current.paths, [schema]); endpoints[kind] = { database, url: url.href };
  }
  assert.equal(state.fieldproofDb, undefined); assert.equal(state.fieldproofReady, undefined);
  process.env.DATABASE_URL = endpoints.source.url;
  process.env.FIELDPROOF_OPERATIONS_V2_TEST_SCHEMAS = JSON.stringify(schemas);
  app = await import("../../lib/server/db");
  // Test setup initializes only these guard-created fresh catalogs. Product
  // plan/apply never call an initializer or backfill an existing/older schema.
  await app.initializeDatabase();
  await app.initializeDatabaseAt(endpoints.target.database);
  for (const [kind, endpoint] of Object.entries(endpoints)) {
    const current = (await endpoint.database.query<{ own: string; paths: string[] }>("SELECT current_schema() own,current_schemas(false)::text[] paths")).rows[0];
    assert.equal(current.own, schemas[kind as keyof typeof schemas]); assert.deepEqual(current.paths, [current.own]);
  }
  state.fieldproofOperationsV2Test = { source: app.database(), target: endpoints.target.database, schemas, artifactRoot: path.join(directory, `artifacts-${id}`) };
  await describe("operations v2 owned disposable namespaces", async () => {
    const { after } = await import("node:test");
    after(dispose);
    for (const file of files) await import(pathToFileURL(path.join(root, file)).href);
  });
  console.log(`Operations v2 guard: fresh ${schemas.source} and ${schemas.target}; sole search paths; owned PostgreSQL only; HTTP/providers disabled.`);
} catch (error) { await dispose(); throw error; }
