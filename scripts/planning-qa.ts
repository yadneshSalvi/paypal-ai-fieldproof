import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { PostgresDatabase } from "@fracture/paypal-core";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env") as typeof import("@next/env");
loadEnvConfig(process.cwd(), true, { info() {}, error() { throw new Error("The development environment could not be read safely."); } });
const args = process.argv.slice(2);
if (args.some(arg => !["--prepare", "--resume", "--local-admin", "--test", "--build"].includes(arg) && !/^tests\/[a-z0-9-]+\.test\.ts$/.test(arg))) throw new Error("Use --prepare --local-admin, --resume, --build, or --test with optional test paths.");
if (args.includes("--resume") && args.includes("--local-admin")) throw new Error("Local administrator creation applies only to a new review database.");
const savedPath = resolve(".local/planning-qa/runtime.json"), port = 4502;
interface QaRuntime { databaseName: string; databaseUrl: string; authSecret: string; createdAt: string; }
let runtime: QaRuntime;
if (args.includes("--resume") || args.includes("--test") || args.includes("--build")) {
  if ((await stat(savedPath)).mode & 0o077) throw new Error("The private review runtime must have mode 0600.");
  runtime = JSON.parse(await readFile(savedPath, "utf8")) as QaRuntime;
} else {
  let exists = false; try { await stat(savedPath); exists = true; } catch { /* New review. */ }
  if (exists) throw new Error("An isolated planning database already exists. Use --resume to preserve its history.");
  // There is deliberately no fallback to the original application's PostgreSQL.
  if (!args.includes("--local-admin")) throw new Error("Use --local-admin to create a new, separate role and database on the local PostgreSQL service.");
  const name = `fp_planning_qa_${randomUUID().replaceAll("-", "")}`, password = randomBytes(48).toString("base64url");
  const adminUrl = new URL("postgresql://127.0.0.1:5432/postgres"); adminUrl.username = userInfo().username;
  const admin = new PostgresDatabase(adminUrl.href);
  try {
    await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await admin.query(`CREATE DATABASE "${name}" OWNER "${name}"`);
    await admin.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
  } catch { throw new Error("The separate local PostgreSQL service could not create the planning review role and database. No existing database was changed."); }
  finally { await admin.close(); }
  const target = new URL(`postgresql://127.0.0.1:5432/${name}`); target.username = name; target.password = password;
  runtime = { databaseName: name, databaseUrl: target.href, authSecret: randomBytes(48).toString("base64url"), createdAt: new Date().toISOString() };
  await mkdir(resolve(".local/planning-qa"), { recursive: true, mode: 0o700 });
  await writeFile(savedPath, JSON.stringify(runtime), { mode: 0o600, flag: "wx" });
}
const target = new URL(runtime.databaseUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.port !== "5432" || !/^fp_planning_qa_[a-z0-9_]+$/.test(runtime.databaseName)
  || target.pathname !== `/${runtime.databaseName}` || target.username !== runtime.databaseName || runtime.authSecret.length < 32) throw new Error("The saved planning database failed its isolation check.");
const environment: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: runtime.databaseUrl, AUTH_SECRET: runtime.authSecret, NODE_ENV: "development", FIELDPROOF_PLANNING_QA: "true", FIELDPROOF_STUDIO_QA: "false", NEXT_TELEMETRY_DISABLED: "1" };
for (const key of Object.keys(environment)) if (/^(?:PAYPAL_|NEXT_PUBLIC_PAYPAL_)|^BLOB_READ_WRITE_TOKEN$/.test(key)) environment[key] = "";
environment.PAYPAL_ENVIRONMENT = "sandbox"; environment.PAYPAL_PROJECT_ISOLATED = "false";
environment.CRON_SECRET = randomBytes(48).toString("base64url");
Object.assign(process.env, environment);
const { initializeDatabaseAt } = await import("../lib/server/db");
const qa = new PostgresDatabase(runtime.databaseUrl);
try {
  const [identity] = (await qa.query<{ name: string }>("SELECT current_database() AS name")).rows;
  if (identity.name !== runtime.databaseName) throw new Error("The planning connection points to a different database.");
  await initializeDatabaseAt(qa);
} finally { await qa.close(); }
console.log(JSON.stringify({ url: `http://localhost:${port}/planning`, database: runtime.databaseName, isolated: true, financialProviders: "disabled", storage: "private local QA only", modelConfigured: Boolean(environment.OPENAI_API_KEY), cookie: "separate planning QA cookie" }));
if (args.includes("--build")) {
  const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "build"], { env: { ...environment, NODE_ENV: "production", FIELDPROOF_PLANNING_QA: "false", FIELDPROOF_PLANNING_BUILD: "true" }, stdio: "inherit" });
  process.exitCode = await new Promise<number>((accept, reject) => { child.once("error", reject); child.once("exit", code => accept(code ?? 1)); });
} else if (args.includes("--test")) {
  const files = args.filter(arg => /^tests\//.test(arg));
  // Existing financial suites inject their transports, but still validate the
  // merchant/configuration boundary. Never give these fixtures real credentials.
  // These values exist only in the disposable test child, never the QA server.
  const fixtureEnvironment: NodeJS.ProcessEnv = {
    ...environment, FIELDPROOF_PLANNING_QA: "false",
    PAYPAL_ENVIRONMENT: "sandbox", PAYPAL_PROJECT_ISOLATED: "true",
    PAYPAL_CLIENT_ID: "controlled-planning-test-client", PAYPAL_CLIENT_SECRET: "controlled-planning-test-secret",
    PAYPAL_API_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_MERCHANT_ID: "CONTROLLED-PLANNING-MERCHANT",
    PAYPAL_SANDBOX_SELLER_EMAIL: "planning-fixture@example.test", PAYPAL_WEBHOOK_ID: "controlled-planning-test-webhook",
    BLOB_READ_WRITE_TOKEN: "controlled-planning-test-blob",
    OPENAI_API_KEY: "controlled-planning-test-model-key", GEMINI_API_KEY: "controlled-planning-test-model-key", GOOGLE_API_KEY: "controlled-planning-test-model-key",
  };
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/test-isolated.ts", ...files], { env: fixtureEnvironment, stdio: "inherit" });
  process.exitCode = await new Promise<number>((accept, reject) => { child.once("error", reject); child.once("exit", code => accept(code ?? 1)); });
} else if (!args.includes("--prepare")) {
  await new Promise<void>((accept, reject) => {
    const probe = createServer(); probe.once("error", () => reject(new Error("Port 4502 is already occupied; no process was stopped.")));
    probe.listen(port, "127.0.0.1", () => { probe.close(error => error ? reject(error) : accept()); });
  });
  const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)], { env: environment, stdio: "inherit" });
  process.once("SIGINT", () => child.kill("SIGINT")); process.once("SIGTERM", () => child.kill("SIGTERM"));
  process.exitCode = await new Promise<number>((accept, reject) => { child.once("error", reject); child.once("exit", code => accept(code ?? 0)); });
}
