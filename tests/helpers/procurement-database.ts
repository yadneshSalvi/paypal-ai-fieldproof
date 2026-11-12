import { randomUUID } from "node:crypto";
import { after } from "node:test";
import { PostgresDatabase } from "@fracture/paypal-core";

/** Call before dynamically importing any server service. A module cache must
 * never point to public, an old runtime, another DB or a reused test schema. */
export async function procurementTestDatabase() {
  const original = process.env.DATABASE_URL ?? "", url = new URL(original || "postgresql://invalid/invalid"), state = globalThis as typeof globalThis & { fieldproofDb?: unknown; fieldproofReady?: unknown };
  if (url.hostname !== "127.0.0.1" || url.port !== "55571" || url.pathname !== "/fp_governance_stage13" || url.username !== "fp_governance_app" || url.searchParams.has("options") || process.env.FIELDPROOF_GOVERNANCE_REVIEW !== "true" || process.env.FIELDPROOF_PROVIDER_ACCESS !== "disabled" || process.env.FIELDPROOF_PROCUREMENT_TEST_ONLY !== "true" || state.fieldproofDb || state.fieldproofReady) throw new Error("Procurement tests need the exact disposable-schema runner before any server imports.");
  const schema = `procurement_test_${randomUUID().replaceAll("-", "")}`, admin = new PostgresDatabase(original);
  let created = false, close: (() => Promise<void>) | null = null;
  const cleanup = async () => {
    if (close) { await close(); close = null; }
    if (created && /^procurement_test_[a-f0-9]{32}$/.test(schema)) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); created = false; }
    await admin.close();
    // Keep the own now-closed search_path. Never restore DATABASE_URL to public
    // while imported server modules and their caches still exist.
  };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
    const own = new URL(original); own.searchParams.set("options", `-c search_path=${schema}`); process.env.DATABASE_URL = own.href;
    const { database, initializeDatabase } = await import("../../lib/server/db");
    const db = database(); close = () => db.close();
    const current = await db.query<{ schema: string }>("SELECT current_schema() AS schema");
    if (current.rows[0]?.schema !== schema) throw new Error("The owned disposable schema was not installed before initialization.");
    await initializeDatabase();
    const { PROCUREMENT_SCHEMA } = await import("../../lib/server/procurement-schema");
    await db.query(PROCUREMENT_SCHEMA);
    const final = await db.query<{ schema: string }>("SELECT current_schema() AS schema");
    if (final.rows[0]?.schema !== schema) throw new Error("The owned disposable schema changed during initialization.");
    after(cleanup);
    return { schema, db };
  } catch (error) { await cleanup(); throw error; }
}
