import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { PostgresDatabase } from "@fracture/paypal-core";

// Even older suites that seed through database() run in a disposable schema.
// process.env wins over --env-file; no application tenant in the base schema is written.
const configured = process.env.DATABASE_URL;
if (!configured) throw new Error("Set DATABASE_URL to a PostgreSQL service that allows temporary test schemas.");
const schema = `fp_suite_${randomUUID().replaceAll("-", "")}`;
const admin = new PostgresDatabase(configured);
const isolated = new URL(configured);
isolated.searchParams.set("options", `-c search_path=${schema}`);
await admin.query(`CREATE SCHEMA "${schema}"`);
try {
  const requested = process.argv.slice(2);
  const files = requested.length ? requested : (await readdir("tests")).filter(name => name.endsWith(".test.ts")).sort().map(name => `tests/${name}`);
  if (files.some(path => !/^tests\/[a-z0-9-]+\.test\.ts$/.test(path))) throw new Error("Choose test files from the tests directory.");
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...files], {
      env: { ...process.env, NODE_ENV: "test", DATABASE_URL: isolated.href }, stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.close();
}
