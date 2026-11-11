import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { PostgresDatabase } from "@fracture/paypal-core";
import { DomainError } from "../lib/domain/money";
import { executionQuiescence, RUNTIME_CONTROL_SCHEMA, setRuntimeHold } from "../lib/server/runtime-control";

const args = process.argv.slice(2), action = args[0];
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
let db: PostgresDatabase | null = null;
try {
  if (!["hold", "status", "resume"].includes(action)) throw new DomainError("MAINTENANCE_USAGE", "Use hold/status/resume, optionally --target-env /private/hosted.env. Hold/resume require --reason. Resume also requires --confirm-single-writer.", 400);
  const file = option("--target-env");
  let url = process.env.DATABASE_URL;
  if (file) {
    if ([resolve(".env"), resolve("../.env")].includes(resolve(file))) throw new DomainError("MAINTENANCE_TARGET_INVALID", "Use the isolated hosted environment snapshot.", 400);
    const env = parseEnv(await readFile(resolve(file), "utf8"));
    if (env.PAYPAL_ENVIRONMENT !== "sandbox" || env.PAYPAL_PROJECT_ISOLATED !== "true" || env.PAYPAL_CLIENT_ID !== process.env.PAYPAL_CLIENT_ID || !env.DATABASE_URL || /\[SENSITIVE\]|\[REDACTED\]/.test(env.DATABASE_URL)) throw new DomainError("MAINTENANCE_TARGET_INVALID", "The current isolated hosted database configuration is required.", 409);
    url = env.DATABASE_URL;
  }
  if (!url) throw new DomainError("MAINTENANCE_DATABASE_MISSING", "A configured database is required.", 409);
  db = new PostgresDatabase(url);
  const exists = (await db.query<{ present: string | null }>("SELECT to_regclass('fp_runtime_control')::text AS present")).rows[0].present;
  if (action === "status" && !exists) {
    console.log(JSON.stringify({ configured: false, held: false, quiescent: false, database: file ? "hosted" : "local" }));
  } else {
    if (action !== "status") {
      const reason = option("--reason");
      if (!reason) throw new DomainError("MAINTENANCE_REASON_REQUIRED", "Record the operator reason using --reason.", 400);
      if (action === "resume" && !args.includes("--confirm-single-writer")) throw new DomainError("SINGLE_WRITER_CONFIRMATION_REQUIRED", "Resume only the designated current writer, using --confirm-single-writer.", 409);
      await db.transaction(tx => tx.query(RUNTIME_CONTROL_SCHEMA));
      await setRuntimeHold(db, action === "hold", reason);
    }
    console.log(JSON.stringify({ configured: true, database: file ? "hosted" : "local", ...await executionQuiescence(db), providerCalls: 0 }));
  }
} catch (error) {
  console.error(JSON.stringify(error instanceof DomainError ? { code: error.code, error: error.message } : { code: "MAINTENANCE_UNAVAILABLE", error: "The execution-control check did not finish. Inspect the current isolated database configuration without changing secrets." }));
  process.exitCode = 1;
} finally { await db?.close(); }
