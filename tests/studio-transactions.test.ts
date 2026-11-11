import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STUDIO_SEMANTIC_VERSION, type PackageRow, type StudioSnapshot } from "../lib/studio/contracts";
import { studioTransactions } from "../lib/studio/transactions";

function packageRow(id = "electronics"): PackageRow {
  return { id, packageId: id, title: "Controlled package", shortTitle: "Controlled", budgetMinor: 96000, pledgedMinor: 96000,
    collectedMinor: 92500, fundingEligibleMinor: 92500, shortfallMinor: 3500, pendingRefundMinor: 0,
    completedRefundMinor: 0, excessLiabilityMinor: 0, allocationReservedMinor: 0, availableAllocationMinor: 0,
    approvedExpenseMinor: 6600, paidExpenseMinor: 0, reviewedItemCount: 0, requiredItemCount: 3,
    reviewedExpenseLineCount: 5, fundingState: "collecting", workState: "planned", geometryRef: "controlled-geometry", provenance: "sample" };
}
function snapshot(): StudioSnapshot {
  return { semanticVersion: STUDIO_SEMANTIC_VERSION, scope: "fixture-scope", datasetHandle: "fixture-handle",
    role: "organizer", mode: "sample", projectTitle: "Controlled transaction fixture", projectionVersion: 7,
    eventCursor: 11, asOf: "2026-11-11T00:00:00Z", geometry: {}, notices: [],
    data: { packages: [packageRow(), packageRow("safety")], settlements: [], allocations: [], evidence: [], exceptions: [] } };
}
describe("Studio stable-key transactions", () => {
  it("produces actual add, update and remove sets while preserving independent money and evidence fields", () => {
    const before = snapshot(), after = structuredClone(before);
    after.projectionVersion++;
    after.data.packages = [{ ...packageRow(), collectedMinor: 96000, fundingEligibleMinor: 96000, shortfallMinor: 0, availableAllocationMinor: 96000, fundingState: "funded" }, packageRow("printing")];
    const result = studioTransactions(before, after);
    assert.equal(result.status, "ready");
    assert.equal(result.transactions.length, 1);
    assert.deepEqual(result.transactions[0].remove, ["safety"]);
    assert.equal(result.transactions[0].add[0].id, "printing");
    assert.equal(result.transactions[0].update[0].id, "electronics");
    assert.equal(result.transactions[0].update[0].reviewedItemCount, 0);
    assert.equal(result.transactions[0].update[0].paidExpenseMinor, 0);
    assert.equal(before.data.packages[0].collectedMinor, 92500);
    assert.deepEqual(after.data.allocations, [], "full collection alone must not invent expense allocations");
  });
  it("treats row order as presentation rather than identity", () => {
    const before = snapshot(), after = structuredClone(before);
    after.data.packages.reverse();
    assert.deepEqual(studioTransactions(before, after), { status: "ready", transactions: [] });
  });
  it("refuses stale projections and older report cutoffs", () => {
    const before = snapshot(), after = structuredClone(before);
    after.projectionVersion--;
    assert.equal(studioTransactions(before, after).status, "stale");
    after.projectionVersion = before.projectionVersion + 1;
    after.asOf = "2026-11-10T23:59:59Z";
    assert.equal(studioTransactions(before, after).status, "stale");
  });
  it("requires engine disposal when the actor, membership scope, or role changes", () => {
    const before = snapshot();
    for (const changes of [{ scope: "other-actor-scope" }, { role: "donor" as const }]) {
      const result = studioTransactions(before, { ...before, ...changes });
      assert.equal(result.status, "scope_changed");
      assert.deepEqual(result.transactions, []);
    }
  });
  it("rejects duplicate primary keys before returning a partial batch", () => {
    const before = snapshot(), after = structuredClone(before);
    after.data.packages.push(packageRow());
    assert.throws(() => studioTransactions(before, after), /duplicate primary key/);
  });
  it("rejects invalid numeric values instead of letting the engine display a plausible total", () => {
    const before = snapshot(), after = structuredClone(before);
    after.data.packages[0].collectedMinor = Number.NaN;
    assert.throws(() => studioTransactions(before, after), /invalid number/);
  });
});
