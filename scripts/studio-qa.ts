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
// Read all of Next's actual development env sources first. The Node --env-file and
// inherited process variables win. No file is rewritten and no value is logged.
loadEnvConfig(process.cwd(), true, { info() {}, error() { throw new Error("The development environment could not be read safely."); } });
const args = process.argv.slice(2);
if (args.some(arg => !["--prepare", "--resume", "--local-admin"].includes(arg))) throw new Error("Use --prepare for a new isolated database, --local-admin for local OS-authorized creation, or --resume for the saved review process.");
if (args.includes("--resume") && args.includes("--local-admin")) throw new Error("Local administrator creation applies only to a new review database.");
const savedPath = resolve(".local/studio-qa/runtime.json"), port = 4202;
interface QaRuntime { databaseName: string; databaseUrl: string; authSecret: string; createdAt: string; }
let runtime: QaRuntime;
if (args.includes("--resume")) {
  if ((await stat(savedPath)).mode & 0o077) throw new Error("The private review runtime must have mode 0600.");
  runtime = JSON.parse(await readFile(savedPath, "utf8")) as QaRuntime;
} else {
  let exists = false; try { await stat(savedPath); exists = true; } catch { /* A fresh review has no runtime yet. */ }
  if (exists) throw new Error("An isolated review database already exists. Use --resume to preserve its report and chat history.");
  const configured = process.env.DATABASE_URL;
  if (!configured) throw new Error("A local PostgreSQL service is required for an isolated review.");
  const base = new URL(configured);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) throw new Error("The review launcher only creates a new database on a local PostgreSQL service. It never provisions on the hosted writer.");
  const name = `fp_studio_qa_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(base); adminUrl.pathname = "/postgres"; adminUrl.searchParams.delete("options");
  let target = new URL(base); target.pathname = `/${name}`; target.searchParams.delete("options");
  if (args.includes("--local-admin")) {
    // Explicit alternative: a separate OS-managed local PostgreSQL service on
    // 5432. Its existing administrator creates a dedicated, unprivileged QA role.
    // The source app's PostgreSQL service and its role privileges are unchanged.
    const localAdmin = new URL("postgresql://127.0.0.1:5432/postgres");
    localAdmin.username = userInfo().username;
    const password = randomBytes(48).toString("base64url");
    const admin = new PostgresDatabase(localAdmin.href);
    try {
      await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      await admin.query(`CREATE DATABASE "${name}" OWNER "${name}"`);
      await admin.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
    } catch {
      throw new Error("The separate local PostgreSQL service could not create the isolated review role and database. No existing database was changed.");
    } finally { await admin.close(); }
    target = new URL(`postgresql://127.0.0.1:5432/${name}`); target.username = name; target.password = password;
  } else {
    const admin = new PostgresDatabase(adminUrl.href);
    try { await admin.query(`CREATE DATABASE "${name}"`); } finally { await admin.close(); }
  }
  runtime = { databaseName: name, databaseUrl: target.href, authSecret: randomBytes(48).toString("base64url"), createdAt: new Date().toISOString() };
  await mkdir(resolve(".local/studio-qa"), { recursive: true, mode: 0o700 });
  await writeFile(savedPath, JSON.stringify(runtime), { mode: 0o600, flag: "wx" });
}
const target = new URL(runtime.databaseUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || !/^fp_studio_qa_[a-z0-9_]+$/.test(runtime.databaseName)
  || target.pathname !== `/${runtime.databaseName}` || runtime.authSecret.length < 32) throw new Error("The saved review database failed its isolation check.");
const environment: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: runtime.databaseUrl, AUTH_SECRET: runtime.authSecret, NODE_ENV: "development", FIELDPROOF_STUDIO_QA: "true", NEXT_TELEMETRY_DISABLED: "1" };
// Deliberate QA capability boundary. Only model/report work is enabled in this process.
// An explicit empty inherited value also prevents Next's env files from restoring it.
for (const key of Object.keys(environment)) if (/^(?:PAYPAL_|NEXT_PUBLIC_PAYPAL_)|^BLOB_READ_WRITE_TOKEN$/.test(key)) environment[key] = "";
environment.PAYPAL_ENVIRONMENT = "sandbox"; environment.PAYPAL_PROJECT_ISOLATED = "false";
environment.CRON_SECRET = randomBytes(48).toString("base64url");
Object.assign(process.env, environment);
const { initializeDatabaseAt } = await import("../lib/server/db");
const qa = new PostgresDatabase(runtime.databaseUrl);
try {
  const [identity] = (await qa.query<{ name: string }>("SELECT current_database() AS name")).rows;
  if (identity.name !== runtime.databaseName) throw new Error("The review connection points to a different database.");
  await initializeDatabaseAt(qa);
} finally { await qa.close(); }
console.log(JSON.stringify({ url: `http://localhost:${port}/studio`, database: runtime.databaseName, isolated: true, financialProviders: "disabled", privateBlob: "disabled", modelConfigured: Boolean(environment.OPENAI_API_KEY), cookie: "separate QA cookie" }));
if (!args.includes("--prepare")) {
  await new Promise<void>((accept, reject) => {
    const probe = createServer(); probe.once("error", () => reject(new Error("Port 4202 is already occupied; no process was stopped.")));
    probe.listen(port, "127.0.0.1", () => { probe.close(error => error ? reject(error) : accept()); });
  });
  // A fresh Node process means Next captures these isolated overrides as initialEnv.
  // The retired source application on 4102 is never started by this launcher.
  const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)], { env: environment, stdio: "inherit" });
  process.once("SIGINT", () => child.kill("SIGINT")); process.once("SIGTERM", () => child.kill("SIGTERM"));
  process.exitCode = await new Promise<number>((accept, reject) => { child.once("error", reject); child.once("exit", code => accept(code ?? 0)); });
}
