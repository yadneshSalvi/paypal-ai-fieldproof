import { randomUUID } from "node:crypto";
import { before, after } from "node:test";
import { PostgresDatabase } from "@fracture/paypal-core";
import { database, initializeDatabase } from "../../lib/server/db";

/** Explicit disposable schema on the independently owned governance database.
 * Neither the public native fixture nor another project's database is eligible. */
export function organizationTestDatabase() {
  const original = process.env.DATABASE_URL ?? "", url = new URL(original || "postgresql://invalid/invalid");
  if (url.hostname !== "127.0.0.1" || url.port !== "55571" || url.pathname !== "/fp_governance_stage13" || url.username !== "fp_governance_app" || process.env.FIELDPROOF_GOVERNANCE_REVIEW !== "true" || process.env.FIELDPROOF_PROVIDER_ACCESS !== "disabled")
    throw new Error("Organization DB tests require the explicit isolated governance runner.");
  const schema = `org_test_${randomUUID().replaceAll("-", "")}`, admin = new PostgresDatabase(original);
  before(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const own = new URL(original); own.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = own.href;
    await initializeDatabase();
  });
  after(async () => {
    await database().close();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.close();
    process.env.DATABASE_URL = original;
  });
  return { schema };
}
