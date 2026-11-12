import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { procurementTestDatabase } from "./helpers/procurement-database";

const unit = await procurementTestDatabase();
const { PROCUREMENT_SCHEMA, PROCUREMENT_TABLES, PROCUREMENT_GUARDS } = await import("../lib/server/procurement-schema");

describe("actual additive procurement schema in its exact owned namespace", () => {
  it("installs every declared table and enabled guard without creating a project, actor, session or financial record", async () => {
    const state = await unit.db.query<{ schema: string; search_path: string }>("SELECT current_schema() AS schema,current_setting('search_path') AS search_path"); assert.equal(state.rows[0].schema, unit.schema); assert.equal(state.rows[0].search_path, unit.schema);
    const tables = await unit.db.query<{ name: string }>("SELECT c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname", [unit.schema, [...PROCUREMENT_TABLES]]); assert.deepEqual(tables.rows.map(row => row.name).sort(), [...PROCUREMENT_TABLES].sort());
    const guards = await unit.db.query<{ name: string; table: string }>("SELECT t.tgname name,c.relname AS table FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgname=ANY($2::text[])", [unit.schema, PROCUREMENT_GUARDS.map(row => row.name)]); assert.equal(guards.rows.length, PROCUREMENT_GUARDS.length); for (const expected of PROCUREMENT_GUARDS) assert.ok(guards.rows.some(row => row.name === expected.name && row.table === expected.table));
    for (const table of ["fp_projects", "fp_sessions", "fp_memberships", "fp_settlement_receipts", "fp_payables", "fp_work_signoffs", "fp_procurement_access"]) { const value = await unit.db.query<{ count: string }>(`SELECT count(*) count FROM ${table}`); assert.equal(Number(value.rows[0].count), 0); }
  });
  it("can repeat its own additive installation without changing the namespace or materializing any fictional business outcome", async () => {
    await unit.db.query(PROCUREMENT_SCHEMA); const schema = await unit.db.query<{ schema: string }>("SELECT current_schema() schema"); assert.equal(schema.rows[0].schema, unit.schema); for (const table of PROCUREMENT_TABLES) { const rows = await unit.db.query<{ count: string }>(`SELECT count(*) count FROM ${table}`); assert.equal(Number(rows.rows[0].count), 0); }
  });
});
