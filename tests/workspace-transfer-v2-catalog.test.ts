import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { SqlDatabase } from "@fracture/paypal-core";
import { readCatalog, readIdentity, readRows, readSequences } from "../lib/operations/catalog";
import { assertRegistry } from "../lib/operations/current-registry";
import { digest } from "../lib/operations/contracts";

const state = (globalThis as typeof globalThis & { fieldproofOperationsV2Test?: { source: SqlDatabase; target: SqlDatabase; schemas: { source: string; target: string } } }).fieldproofOperationsV2Test;
assert(state, "Use only the owned transport-denying two-schema runner.");
test("the 137-table schema21 catalog has exact keys, private columns, and normalized dependency guards", async () => {
  const observations = [];
  for (const kind of ["source", "target"] as const) observations.push(await state[kind].transaction(async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY; SET LOCAL timezone='UTC'");
    const catalog = await readCatalog(tx), tables = await readRows(tx, catalog), sequences = await readSequences(tx, catalog);
    assertRegistry(catalog, tables.find(table => table.name === "fp_schema_versions")!.rows.map(row => JSON.parse(row)));
    const identity = await readIdentity(tx, { endpoint: "owned-synthetic", schema: state.schemas[kind] }, true);
    assert.equal(catalog.extraRelations.length, 0); assert.equal(catalog.extraTypes.length, 0);
    for (const table of catalog.tables) assert(table.triggers.every(trigger => trigger.enabled === "O"));
    return { catalog, sequences, identity, tables };
  }));
  assert.deepEqual(observations[0].catalog, observations[1].catalog);
  await writeFile(path.resolve(process.cwd(), ".local/operations-v2-unit/catalog.private.json"), JSON.stringify(observations[0].catalog, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ tables: observations[0].catalog.tables.length, schemaVersion: 21, catalogHash: digest(observations[0].catalog), sequences: observations[0].sequences, initializedRows: observations[0].tables.reduce((sum, table) => sum + table.count, 0) }));
});
