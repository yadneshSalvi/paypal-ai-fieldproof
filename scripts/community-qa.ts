import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { PostgresDatabase } from "@fracture/paypal-core";

// Set every supported provider credential BEFORE Next's environment loader.
// An empty process value takes precedence over .env/.env.local. No original DB is opened.
const secretNames = ["DATABASE_URL", "AUTH_SECRET", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "BLOB_READ_WRITE_TOKEN", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_MERCHANT_ID", "PAYPAL_WEBHOOK_ID", "PAYPAL_SANDBOX_SELLER_EMAIL", "PAYPAL_SANDBOX_BUYER_EMAIL", "PAYPAL_SANDBOX_BUYER_PASSWORD", "NEXT_PUBLIC_PAYPAL_CLIENT_ID", "PAYPAL_API_BASE_URL"];
for (const key of [...Object.keys(process.env).filter(key => /^(?:PAYPAL_|NEXT_PUBLIC_PAYPAL_)/.test(key)), ...secretNames]) process.env[key] = "";
process.env.FIELDPROOF_PROVIDER_ACCESS = "disabled";
process.env.FIELDPROOF_COMMUNITY_QA = "true";
process.env.FIELDPROOF_PLANNING_QA = "false";
process.env.FIELDPROOF_STUDIO_QA = "false";
const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as typeof import("@next/env");
loadEnvConfig(process.cwd(), true, { info() {}, error() { throw new Error("The development environment could not be read safely."); } });
// Also erase unknown provider variables introduced by a local environment file.
for (const key of Object.keys(process.env)) if (/^(?:PAYPAL_|NEXT_PUBLIC_PAYPAL_)/.test(key) || secretNames.includes(key)) process.env[key] = "";
const args = process.argv.slice(2);
if (args.some(arg => !["--prepare", "--resume", "--local-admin", "--test", "--build"].includes(arg) && !/^tests\/[a-z0-9-]+\.test\.ts$/.test(arg))) throw new Error("Use --prepare --local-admin, --resume, --build, or --test with optional test paths.");
const savedPath = resolve(".local/community-qa/runtime.json"), port = 4512;
interface QaRuntime { databaseName: string; databaseUrl: string; authSecret: string; createdAt: string; }
let runtime: QaRuntime;
if (args.includes("--resume") || args.includes("--test") || args.includes("--build")) {
  if ((await stat(savedPath)).mode & 0o077) throw new Error("The private community runtime must have mode 0600.");
  runtime = JSON.parse(await readFile(savedPath, "utf8"));
} else {
  let exists = false; try { await stat(savedPath); exists = true; } catch { /* new isolated runtime */ }
  if (exists) throw new Error("A community QA runtime already exists. Resume it to preserve saved work.");
  if (!args.includes("--prepare") || !args.includes("--local-admin")) throw new Error("Create the separate QA database with --prepare --local-admin first.");
  const name = `fp_community_qa_${randomUUID().replaceAll("-", "")}`, password = randomBytes(48).toString("base64url");
  const adminUrl = new URL("postgresql://127.0.0.1:5432/postgres"); adminUrl.username = userInfo().username;
  const admin = new PostgresDatabase(adminUrl.href);
  try {
    await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await admin.query(`CREATE DATABASE "${name}" OWNER "${name}"`);
    await admin.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
  } catch { throw new Error("The separate local PostgreSQL service could not create the community QA role and database. No original database was changed."); }
  finally { await admin.close(); }
  const url = new URL(`postgresql://127.0.0.1:5432/${name}`); url.username = name; url.password = password;
  runtime = { databaseName: name, databaseUrl: url.href, authSecret: randomBytes(48).toString("base64url"), createdAt: new Date().toISOString() };
  await mkdir(resolve(".local/community-qa"), { recursive: true, mode: 0o700 });
  await writeFile(savedPath, JSON.stringify(runtime), { mode: 0o600, flag: "wx" });
}
const target = new URL(runtime.databaseUrl);
if (target.hostname !== "127.0.0.1" || target.port !== "5432" || !/^fp_community_qa_[a-z0-9_]+$/.test(runtime.databaseName) || target.pathname !== `/${runtime.databaseName}` || target.username !== runtime.databaseName || runtime.authSecret.length < 32) throw new Error("The saved community database failed isolation checks.");
const environment: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: runtime.databaseUrl, AUTH_SECRET: runtime.authSecret, APP_URL: `http://localhost:${port}`, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", CRON_SECRET: randomBytes(48).toString("base64url"), PAYPAL_ENVIRONMENT: "sandbox", PAYPAL_PROJECT_ISOLATED: "false", FIELDPROOF_PROVIDER_ACCESS: "disabled" };
Object.assign(process.env, environment);
const { initializeDatabaseAt } = await import("../lib/server/db");
const qa = new PostgresDatabase(runtime.databaseUrl);
try {
  const [identity] = (await qa.query<{ name: string }>("SELECT current_database() AS name")).rows;
  if (identity.name !== runtime.databaseName) throw new Error("The community connection points to a different database.");
  await initializeDatabaseAt(qa);
} finally { await qa.close(); }
console.log(JSON.stringify({ url: `http://localhost:${port}/community`, isolated: true, providers: "disabled before environment loading", storage: "private community QA only", cookie: "separate community QA cookies" }));
let child: ReturnType<typeof spawn> | null = null;
if (args.includes("--build")) child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "build"], { env: { ...environment, NODE_ENV: "production", FIELDPROOF_COMMUNITY_BUILD: "true", FIELDPROOF_COMMUNITY_QA: "false" }, stdio: "inherit" });
else if (args.includes("--test")) child = spawn(process.execPath, ["--import", "tsx", "scripts/test-isolated.ts", ...args.filter(arg => arg.startsWith("tests/"))], { env: {
  ...environment, FIELDPROOF_COMMUNITY_QA: "false", FIELDPROOF_PROVIDER_ACCESS: "fixtures", APP_URL: "http://localhost:4102",
  PAYPAL_PROJECT_ISOLATED: "true", PAYPAL_CLIENT_ID: "controlled-community-test-client", PAYPAL_CLIENT_SECRET: "controlled-community-test-secret", PAYPAL_API_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_MERCHANT_ID: "CONTROLLED-COMMUNITY-MERCHANT", PAYPAL_SANDBOX_SELLER_EMAIL: "community-fixture@example.test", PAYPAL_WEBHOOK_ID: "controlled-community-test-webhook", BLOB_READ_WRITE_TOKEN: "controlled-community-test-blob", OPENAI_API_KEY: "controlled-community-test-model-key", GEMINI_API_KEY: "controlled-community-test-model-key", GOOGLE_API_KEY: "controlled-community-test-model-key",
}, stdio: "inherit" });
else if (args.includes("--resume")) {
  await new Promise<void>((accept, reject) => { const probe = createServer(); probe.once("error", () => reject(new Error("Port 4512 is occupied. No process was stopped."))); probe.listen(port, "127.0.0.1", () => probe.close(error => error ? reject(error) : accept())); });
  child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)], { env: environment, stdio: "inherit" });
}
if (child) {
  const running = child; process.once("SIGINT", () => running.kill("SIGINT")); process.once("SIGTERM", () => running.kill("SIGTERM"));
  process.exitCode = await new Promise<number>((accept, reject) => { running.once("error", reject); running.once("exit", code => accept(code ?? 1)); });
}
