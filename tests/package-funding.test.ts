import assert from "node:assert/strict";
import { it } from "node:test";
import { assessPackageFunding, fundingStateLabel } from "../lib/domain/package-funding";

const funded = { state: "funded" as const, version: 2, budgetMinor: 96000, eligibleMinor: 96000, provenance: "live_sandbox" as const, round: { packageVersion: 2, state: "funded" } };

it("a current fully funded round qualifies, but a later shortfall requires review", () => {
  assert.deepEqual(assessPackageFunding(funded), { state: "funded", complete: true });
  assert.deepEqual(assessPackageFunding({ ...funded, eligibleMinor: 95999 }), { state: "funding_review", complete: false });
  assert.equal(fundingStateLabel("funding_review"), "Funding needs review");
});
it("historical collected credit never reopens a cancelled or compensating purpose", () => {
  for (const state of ["cancelled", "compensating"] as const) {
    assert.deepEqual(assessPackageFunding({ ...funded, state, eligibleMinor: 120000 }), { state, complete: false });
    assert.deepEqual(assessPackageFunding({ ...funded, round: { packageVersion: 2, state } }), { state, complete: false });
  }
});
it("live credit needs the current package version and a funded policy, not just the amount", () => {
  for (const round of [undefined, { packageVersion: 1, state: "funded" }])
    assert.deepEqual(assessPackageFunding({ ...funded, round }), { state: "funding_review", complete: false });
  assert.deepEqual(assessPackageFunding({ ...funded, round: { packageVersion: 2, state: "collecting" } }), { state: "collecting", complete: false });
  assert.deepEqual(assessPackageFunding({ ...funded, round: { packageVersion: 2, state: "recovering" } }), { state: "recovering", complete: false });
});
it("an explicit Sample fixture can qualify without a provider round but cannot ignore a stale round", () => {
  assert.deepEqual(assessPackageFunding({ ...funded, provenance: "sample", round: undefined }), { state: "funded", complete: true });
  assert.deepEqual(assessPackageFunding({ ...funded, provenance: "sample", round: { packageVersion: 1, state: "funded" } }), { state: "funding_review", complete: false });
  for (const provenance of ["replay", "modelled"] as const) {
    assert.equal(assessPackageFunding({ ...funded, provenance, round: undefined }).complete, false);
    assert.equal(assessPackageFunding({ ...funded, provenance }).complete, false);
  }
});
it("unsafe counters and malformed package policy cannot become collected", () => {
  assert.throws(() => assessPackageFunding({ ...funded, eligibleMinor: -1 }));
  assert.throws(() => assessPackageFunding({ ...funded, version: 0 }), { code: "PACKAGE_FUNDING_POLICY" });
});
