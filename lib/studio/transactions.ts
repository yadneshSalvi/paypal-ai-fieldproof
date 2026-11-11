import { STUDIO_TABLES, type StudioRow, type StudioSnapshot, type StudioTable } from "./contracts";

export interface StudioTransaction { tableId: StudioTable; add: StudioRow[]; update: StudioRow[]; remove: string[]; }
const same = (a: StudioRow, b: StudioRow) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
};
function keyed(rows: StudioRow[]) {
  const result = new Map<string, StudioRow>();
  for (const row of rows) {
    if (!row.id || result.has(row.id)) throw new Error("A report dataset has a missing or duplicate primary key.");
    if (Object.values(row).some(value => value !== null && !["string", "number", "boolean"].includes(typeof value))) throw new Error("A report dataset contains an unsupported field value.");
    if (Object.values(row).some(value => typeof value === "number" && !Number.isFinite(value))) throw new Error("A report dataset contains an invalid number.");
    result.set(row.id, row);
  }
  return result;
}
/** A role/scope change requires disposal of the old engine, never an in-place privacy filter. */
export function studioTransactions(before: StudioSnapshot, after: StudioSnapshot): { status: "ready" | "stale" | "scope_changed"; transactions: StudioTransaction[] } {
  if (before.scope !== after.scope || before.role !== after.role || before.semanticVersion !== after.semanticVersion) return { status: "scope_changed", transactions: [] };
  if (before.datasetVersions?.funding_positions !== after.datasetVersions?.funding_positions) return { status: "scope_changed", transactions: [] };
  if (after.projectionVersion < before.projectionVersion || Date.parse(after.asOf) < Date.parse(before.asOf)) return { status: "stale", transactions: [] };
  const transactions = STUDIO_TABLES.map(tableId => {
    const prior = keyed(before.data[tableId] ?? []), next = keyed(after.data[tableId] ?? []);
    return {
      tableId,
      add: [...next].filter(([id]) => !prior.has(id)).map(([, row]) => row),
      update: [...next].filter(([id, row]) => prior.has(id) && !same(prior.get(id)!, row)).map(([, row]) => row),
      remove: [...prior.keys()].filter(id => !next.has(id)),
    };
  }).filter(change => change.add.length || change.update.length || change.remove.length);
  return { status: "ready", transactions };
}
