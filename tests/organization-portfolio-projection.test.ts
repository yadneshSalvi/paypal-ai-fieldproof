import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import * as C from "../lib/organizations/contracts";
import { buildOrganizationPortfolioSnapshot, filterOrganizationProjectAggregates, groupOrganizationProjectAggregates, organizationPortfolioCoverage } from "../lib/organizations/portfolio-projection";
import { DomainError } from "../lib/domain/money";
import { ORG_UI_AS_OF, orgUiId, orgUiSnapshot } from "./helpers/organization-ui";

const all: C.OrgPortfolioFilter = { templateIds: [], provenance: [], currencies: [], linkIds: [] };
function project(number: number, template: "makerspace" | "community-garden" | "mutual-aid" = "makerspace", provenance: "sample" | "live_sandbox" = "sample"): C.OrgPortfolioProject {
  const value = orgUiSnapshot(template).projects[0]; value.linkId = orgUiId(200 + number); value.project!.id = orgUiId(300 + number); value.project!.title = `Synthetic project ${number}`; value.project!.mode = provenance;
  value.lineage!.aggregateHash = createHash("sha256").update(`synthetic aggregate ${number}`).digest("hex"); value.budget!.provenance = provenance; value.money.forEach(row => { row.provenance = provenance; }); value.evidence.forEach(row => { row.provenance = provenance; }); return value;
}
function withheld(number: number): C.OrgPortfolioProject { return { ...project(number), state: "withdrawn", project: null, lineage: null, budget: null, money: [], evidence: [], reasons: ["Synthetic disclosure withdrawn"], notices: [] }; }
describe("strict organization aggregate portfolio grouping", () => {
  it("sums canonical original/current/unpaid measures separately and preserves the500/200/300 lineage", () => {
    const first = project(1), second = project(2), group = groupOrganizationProjectAggregates([first, second])[0];
    assert.equal(group.funding!.originalGrossMinor, 1000); assert.equal(group.funding!.returnedMinor, 400); assert.equal(group.funding!.currentAssignedMinor, 1000); assert.equal(group.funding!.currentCollectedMinor, 600);
    assert.equal(group.funding!.unpaidCommitmentMinor, 1400); assert.equal(group.funding!.acceptedSponsorUnpaidMinor, 400); assert.equal(group.funding!.originalCommitmentRecordMinor, 3800);
    assert.notEqual(group.funding!.unpaidCommitmentMinor, group.funding!.originalCommitmentRecordMinor - group.funding!.currentCollectedMinor);
    assert.equal(group.funding!.paidMinor, 200); assert.equal(group.funding!.reservedMinor, 100); assert.equal(group.funding!.availableMinor, 300);
    assert.equal(group.expenses!.paidPrincipalMinor, 180); assert.equal(group.expenses!.knownPaidFeeMinor, 20); assert.equal(group.expenses!.reservedPrincipalMinor, 80); assert.equal(group.expenses!.reservedFeeMinor, 20);
    assert.equal(group.expenses!.returnedPrincipalMinor, 160); assert.equal(group.expenses!.undeliveredPrincipalMinor, 120); assert.equal(group.funding!.returnedMinor, 400);
  });
  it("keeps identical currency/provenance projects together and all other groups separate without conversion", () => {
    const sample = project(1), provider = project(2, "makerspace", "live_sandbox"), euro = project(3);
    euro.project!.currency = "EUR"; euro.budget!.currency = "EUR"; euro.money.forEach(row => { row.currency = "EUR"; });
    const groups = groupOrganizationProjectAggregates([provider, euro, sample]);
    assert.deepEqual(groups.map(group => [group.currency, group.provenance, group.projectCount, group.funding!.originalGrossMinor]), [["EUR", "sample", 1, 500], ["USD", "live_sandbox", 1, 500], ["USD", "sample", 1, 500]]);
    const selected = buildOrganizationPortfolioSnapshot({ projects: [sample, provider, euro], filters: { ...all, provenance: ["live_sandbox"] }, asOf: ORG_UI_AS_OF });
    assert.equal(selected.projects.length, 1); assert.equal(selected.groups.length, 1); assert.equal(selected.groups[0].provenance, "live_sandbox");
  });
  it("uses weighted compatible evidence counts and retains per-project plans rather than averaging project percentages", () => {
    const first = project(1), second = project(2);
    first.evidence[0].values = { ...first.evidence[0].values, acceptedReviewItems: 1, requiredReviewItems: 2, planRevision: 3 };
    second.evidence[0].values = { ...second.evidence[0].values, acceptedReviewItems: 2, requiredReviewItems: 8, planRevision: 7 };
    const snapshot = buildOrganizationPortfolioSnapshot({ projects: [first, second], filters: all, asOf: ORG_UI_AS_OF }), evidence = snapshot.groups[0].evidence!;
    assert.equal(evidence.acceptedReviewItems, 3); assert.equal(evidence.requiredReviewItems, 10); assert.equal(evidence.acceptedReviewItems / evidence.requiredReviewItems, .3);
    assert.notEqual(evidence.acceptedReviewItems / evidence.requiredReviewItems, (.5 + .25) / 2); assert.equal(evidence.planRevision, null);
    assert.deepEqual(snapshot.projects.map(row => row.evidence[0].values.planRevision), [3, 7]);
  });
  it("does not let a finance-only consent enlarge budget, expense or evidence denominators", () => {
    const complete = project(1), financeOnly = project(2); financeOnly.disclosedSections = ["funding"]; financeOnly.budget = null; financeOnly.money = financeOnly.money.map(row => ({ ...row, expenses: null })); financeOnly.evidence = [];
    const snapshot = buildOrganizationPortfolioSnapshot({ projects: [complete, financeOnly], filters: all, asOf: ORG_UI_AS_OF });
    assert.equal(snapshot.coverage.funding.denominatorProjects, 2); assert.equal(snapshot.coverage.evidence.denominatorProjects, 1); assert.equal(snapshot.coverage.expenses.denominatorProjects, 1); assert.equal(snapshot.coverage.budget.denominatorProjects, 1);
    assert.equal(snapshot.groups[0].evidence!.requiredReviewItems, 14); assert.equal(snapshot.groups[0].evidence!.planRevision, null); assert.equal(snapshot.groups[0].coverage.evidence.includedProjects, 1);
  });
  it("omits unavailable metrics with explicit coverage and null when no value exists instead of a fabricated zero", () => {
    const first = project(1), second = project(2); second.state = "partial"; second.money = second.money.map(row => ({ ...row, funding: null, expenses: null })); second.evidence = [];
    const snapshot = buildOrganizationPortfolioSnapshot({ projects: [first, second], filters: all, asOf: ORG_UI_AS_OF });
    assert.deepEqual([snapshot.coverage.funding.includedProjects, snapshot.coverage.funding.omittedProjects, snapshot.coverage.funding.denominatorProjects], [1, 1, 2]);
    assert.equal(snapshot.coverage.funding.complete, false); assert.equal(snapshot.groups[0].funding!.originalGrossMinor, 500);
    first.state = "partial"; first.money = first.money.map(row => ({ ...row, funding: null, expenses: null })); first.evidence = [];
    const missing = groupOrganizationProjectAggregates([first, second])[0]; assert.equal(missing.funding, null); assert.equal(missing.expenses, null); assert.equal(missing.evidence, null); assert.equal(missing.coverage.evidence.omittedProjects, 2);
  });
  it("retains metadata-only withdrawal without exposing or secretly classifying the earlier project identity", () => {
    const snapshot = buildOrganizationPortfolioSnapshot({ projects: [project(1), withheld(2)], filters: { ...all, templateIds: ["community-garden"] }, asOf: ORG_UI_AS_OF });
    assert.equal(snapshot.projects.length, 1); assert.equal(snapshot.projects[0].state, "withdrawn"); assert.equal(snapshot.projects[0].project, null); assert.deepEqual(snapshot.groups, []); assert.equal(snapshot.knownLinks, 1); assert.equal(snapshot.withdrawnLinks, 1);
    assert.equal(snapshot.coverage.evidence.denominatorProjects, 0); assert.equal(snapshot.coverage.evidence.complete, false); assert.match(snapshot.coverage.evidence.reasons.join(" "), /cannot be classified/);
    assert.doesNotMatch(JSON.stringify(snapshot), /Synthetic project 2|"receiptId"|"actorId"|"documentId"|"providerId"/);
  });
  it("counts a selected unavailable disclosure as an omission without adding it to a privately inferred provenance group", () => {
    const rows = [project(1), withheld(2)], coverage = organizationPortfolioCoverage(rows), groups = groupOrganizationProjectAggregates(rows);
    assert.equal(coverage.funding.denominatorProjects, 2); assert.equal(coverage.funding.omittedProjects, 1);
    assert.equal(groups.length, 1); assert.equal(groups[0].coverage.funding.denominatorProjects, 1); assert.equal(groups[0].coverage.funding.complete, false); assert.match(groups[0].coverage.funding.reasons.join(" "), /metadata-only/);
  });
  it("never broadens an unknown requested link filter to all organization projects", () => {
    const rows = [project(1), project(2)], filtered = filterOrganizationProjectAggregates(rows, { ...all, linkIds: [orgUiId(999)] });
    assert.deepEqual(filtered, []); assert.equal(buildOrganizationPortfolioSnapshot({ projects: rows, filters: { ...all, linkIds: [orgUiId(999)] }, asOf: ORG_UI_AS_OF }).knownLinks, 0);
  });
  it("applies template/link filters and rejects duplicated facts when coverage is requested directly", () => {
    const first = project(1), second = project(2, "community-garden");
    const coverage = organizationPortfolioCoverage([first, second], { filters: { ...all, templateIds: ["community-garden"], linkIds: [second.linkId] } });
    assert.equal(coverage.funding.denominatorProjects, 1); assert.equal(coverage.evidence.includedProjects, 1);
    assert.throws(() => organizationPortfolioCoverage([first, first]), DomainError);
  });
  it("rejects duplicate current project/link facts, inconsistent immutable policy revisions and unknown private fields", () => {
    const first = project(1), duplicateLink = project(2); duplicateLink.linkId = first.linkId;
    assert.throws(() => groupOrganizationProjectAggregates([first, duplicateLink]), DomainError);
    const duplicateProject = project(2); duplicateProject.project!.id = first.project!.id; assert.throws(() => groupOrganizationProjectAggregates([first, duplicateProject]), DomainError);
    const second = project(2); first.evidence[0].values.policyRevisions = [{ policyId: orgUiId(901), revision: 1, contentHash: "a".repeat(64) }]; second.evidence[0].values.policyRevisions = [{ policyId: orgUiId(901), revision: 1, contentHash: "b".repeat(64) }];
    assert.throws(() => groupOrganizationProjectAggregates([first, second]), DomainError);
    assert.throws(() => groupOrganizationProjectAggregates([{ ...first, receiptId: "PRIVATE_RECEIPT_CANARY" } as C.OrgPortfolioProject]));
  });
  it("keeps the capture basis stable across a moving wall clock or input order while binding actual projection/consent changes", () => {
    const rows = [project(2), project(1)], before = JSON.stringify(rows), first = buildOrganizationPortfolioSnapshot({ projects: rows, filters: all, asOf: ORG_UI_AS_OF });
    const laterRows = structuredClone(rows), later = "2030-05-01T11:00:00.000Z"; laterRows.forEach(row => { row.lineage!.asOf = later; });
    const second = buildOrganizationPortfolioSnapshot({ projects: laterRows.reverse(), filters: all, asOf: later }); assert.equal(first.basisHash, second.basisHash); assert.equal(JSON.stringify(rows), before);
    laterRows[0].lineage!.projectionVersion++; const changed = buildOrganizationPortfolioSnapshot({ projects: laterRows, filters: all, asOf: later }); assert.notEqual(changed.basisHash, first.basisHash);
    assert.throws(() => buildOrganizationPortfolioSnapshot({ projects: rows, filters: all, asOf: later }), DomainError);
  });
  it("fails safely on an unrepresentable sum and keeps zero denominators as0/0 without inventing completeness", () => {
    const first = project(1), second = project(2); first.budget!.amountMinor = Number.MAX_SAFE_INTEGER; assert.throws(() => groupOrganizationProjectAggregates([first, second]), DomainError);
    const empty = project(3); empty.evidence[0].values = { ...empty.evidence[0].values, acceptedReviewItems: 0, requiredReviewItems: 0, acceptedPackages: 0, packageCount: 0, currentScopedSignoffs: 0, reviewedIllustrations: 0 };
    const result = groupOrganizationProjectAggregates([empty])[0]; assert.equal(result.evidence!.acceptedReviewItems, 0); assert.equal(result.evidence!.requiredReviewItems, 0); assert.equal("percentage" in result.evidence!, false);
  });
});
