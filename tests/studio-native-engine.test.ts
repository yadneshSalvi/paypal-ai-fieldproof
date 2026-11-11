import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDataEngine, type AgStudioQuery, type AgStudioQueryField } from "ag-studio";
import { STUDIO_SEMANTIC_VERSION, type StudioSnapshot } from "../lib/studio/contracts";
import { studioDataDefinition, studioMoney } from "../lib/studio/native-data";
import { studioTransactions } from "../lib/studio/transactions";

function fixture(): StudioSnapshot {
  return { semanticVersion: STUDIO_SEMANTIC_VERSION, scope: "controlled-native-engine", datasetHandle: "fixture", role: "organizer", mode: "sample",
    projectTitle: "Native engine test fixture", projectionVersion: 1, eventCursor: 1, asOf: "2026-11-11T00:00:00Z", geometry: {}, notices: [],
    data: { packages: [
      { id: "electronics", packageId: "electronics", title: "Electronics", budgetMinor: 96000, collectedMinor: 92500, fundingEligibleMinor: 92500 },
      { id: "safety", packageId: "safety", title: "Safety", budgetMinor: 72000, collectedMinor: 0, fundingEligibleMinor: 0 },
    ], settlements: [], allocations: [], exceptions: [], evidence: [
      { id: "source-a:electronics", packageId: "electronics", evidenceId: "source-a", itemCount: 1, amountMinor: 6600 },
      { id: "source-a:safety", packageId: "safety", evidenceId: "source-a", itemCount: 1, amountMinor: 1200 },
    ] } } as unknown as StudioSnapshot;
}
// Engine field ids are the hydrated table-qualified ids. The widget API supplies these
// itself; a standalone native-engine test must preserve that same identity convention.
const field = (sourceId: string, name: string, aggregation?: "sum"): AgStudioQueryField => ({ key: `${sourceId}.${name}${aggregation ? `.${aggregation}` : ""}`, sourceId, fieldId: `${sourceId}.${name}`, ...(aggregation ? { aggregation } : {}) });
function nativeEngine(snapshot: StudioSnapshot) {
  const engine = createDataEngine(studioDataDefinition(snapshot));
  engine.finalize?.();
  return engine;
}
async function rows(engine: ReturnType<typeof createDataEngine>, query: AgStudioQuery) {
  const [result] = await engine.execute({ query, options: { shape: "rows", strict: true } });
  assert.equal(result.metadata?.error, undefined);
  assert.equal(result.dataShape, "rows");
  if (result.dataShape !== "rows") throw new Error("Native engine returned columns unexpectedly.");
  return result.rows;
}
describe("Installed AG Studio built-in engine", () => {
  it("keeps actual minor-unit numeric measures and a distinct package budget grain", async () => {
    const engine = nativeEngine(fixture());
    const result = await rows(engine, { axes: [], measures: [
      { field: field("packages", "budgetMinor", "sum"), as: "budget" },
      { field: field("packages", "collectedMinor", "sum"), as: "collected" },
    ] });
    assert.deepEqual(result, [{ budget: 168000, collected: 92500 }]);
    assert.equal(studioMoney(Number(result[0].collected)), "$925.00");
  });
  it("applies a real atomic multi-table add/update/remove transaction", async () => {
    const before = fixture(), after = structuredClone(before);
    after.projectionVersion = 2;
    after.data.packages = [{ ...before.data.packages[0], collectedMinor: 96000, fundingEligibleMinor: 96000 },
      { ...before.data.packages[1], id: "printing", packageId: "printing", title: "Printing" }];
    after.data.evidence = [before.data.evidence[0]];
    const engine = nativeEngine(before);
    const read = () => rows(engine, { projection: [{ field: field("packages", "id"), as: "id" }, { field: field("packages", "collectedMinor"), as: "collected" }] });
    await read(); // prime the engine query/cache before the transaction
    assert.ok(engine.applyTransaction, "the installed built-in engine must support transactions");
    await engine.applyTransaction(studioTransactions(before, after).transactions);
    const result = await read();
    assert.deepEqual(result.sort((a, b) => String(a.id).localeCompare(String(b.id))), [{ id: "electronics", collected: 96000 }, { id: "printing", collected: 0 }]);
    assert.deepEqual(await rows(engine, { projection: [{ field: field("evidence", "id"), as: "id" }] }), [{ id: "source-a:electronics" }]);
    assert.equal(before.data.packages[0].collectedMinor, 92500, "the prior snapshot must stay immutable for the next diff");
  });
  it("filters source associations by their own package identity without repeating a receipt total", async () => {
    const engine = nativeEngine(fixture());
    const result = await rows(engine, { axes: [{ dimensions: [{ field: field("evidence", "packageId"), members: { include: ["electronics"] }, as: "package" }] }],
      measures: [{ field: field("evidence", "amountMinor", "sum"), as: "reviewed" }] });
    assert.deepEqual(result, [{ package: "electronics", reviewed: 6600 }]);
  });
  it("rejects an invalid batch before applying valid changes to another table", async () => {
    const engine = nativeEngine(fixture());
    assert.ok(engine.applyTransaction);
    await assert.rejects(engine.applyTransaction([
      { tableId: "packages", remove: ["safety"] },
      { tableId: "evidence", add: [{ id: "source-a:electronics", packageId: "electronics" }] },
    ]));
    assert.equal((await rows(engine, { projection: [{ field: field("packages", "id") }] })).length, 2);
  });
});
