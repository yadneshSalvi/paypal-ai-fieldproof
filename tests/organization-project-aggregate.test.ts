import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { communityTemplate, TEMPLATE_IDS } from "../lib/community/templates";
import { DomainError } from "../lib/domain/money";
import { packagePositionTotals, projectFundingPositions } from "../lib/domain/funding-positions";
import { loadOrganizationProjectAggregate, collectOrganizationProjectAggregateDependencies } from "../lib/server/organization-project-aggregate";
import { database, query } from "../lib/server/db";
import { sampleReceipt } from "../lib/server/seed";
import { readFundingJournal } from "../lib/server/funding-positions";
import { createPurposePledge } from "../lib/server/purpose-pledges";
import { acceptSponsorOffer, createSponsorOffer, sponsorViews } from "../lib/server/sponsors";
import { buildOrganizationPortfolioSnapshot } from "../lib/organizations/portfolio-projection";
import { organizationTestDatabase } from "./helpers/organization-database";
import { organizationAggregateFixture, organizationAggregateInput, organizationAggregateRead, organizationExpenseFixture } from "./helpers/organization-aggregate";
import { projectFingerprint, storyCase, storyChoice, storyPolicy, storyReceipt } from "./helpers/supporter-story";

organizationTestDatabase();
const code = (value: string) => (error: unknown) => error instanceof DomainError && error.code === value;
const allFilters = { templateIds: [], currencies: [], provenance: [], linkIds: [] };

describe("coherent scope-only organization project aggregates from real records", () => {
  it("uses actual empty canonical packages and prospective requirements in all three ordinary template workspaces", async () => {
    for (const templateId of TEMPLATE_IDS) {
      const f = await organizationAggregateFixture(templateId), input = organizationAggregateInput(f), template = communityTemplate(templateId), before = await projectFingerprint(f.projectId);
      const aggregate = await organizationAggregateRead(input, loadOrganizationProjectAggregate);
      assert.equal(aggregate.project!.templateId, templateId); assert.equal(aggregate.budget!.amountMinor, template.totalMinor); assert.equal(aggregate.budget!.basis, "current_canonical_packages");
      assert.equal(aggregate.budget!.packageCount, 6); assert.equal(aggregate.money[0].funding!.currentCollectedMinor, 0); assert.equal(aggregate.money[0].expenses!.claimCount, 0);
      assert.equal(aggregate.evidence[0].values.requiredReviewItems, template.packages.reduce((count, pkg) => count + pkg.requirements.length, 0));
      assert.equal(aggregate.evidence[0].values.acceptedPackages, 0); assert.equal(aggregate.evidence[0].values.acceptedReviewItems, 0); assert.equal(aggregate.evidence[0].values.planRevision, null);
      assert.deepEqual(await projectFingerprint(f.projectId), before, "Projection must not create source controls or any project/business record");
    }
  });
  it("preserves500original/200returned/300current across real cancellation choices and separate paid/reserved expense facts", async () => {
    const f = await organizationAggregateFixture(), receipts = [];
    for (const amount of [200, 100, 100, 100]) receipts.push(await storyReceipt(f, f.donors[0], "electronics", amount));
    const expense = await organizationExpenseFixture(f), invoice = await storyReceipt(f, f.donors[1], "safety", 35, true), material = await storyPolicy(f, "materials"), wood = await storyPolicy(f, "woodworking"), cancellation = await storyCase(f, "electronics");
    await storyChoice(f, f.donors[0], receipts[0], cancellation, null); await storyChoice(f, f.donors[0], receipts[1], cancellation, material); await storyChoice(f, f.donors[0], receipts[2], cancellation, material); await storyChoice(f, f.donors[0], receipts[3], cancellation, wood);
    const input = organizationAggregateInput(f), aggregate = await organizationAggregateRead(input, loadOrganizationProjectAggregate), funding = aggregate.money[0].funding!, expenses = aggregate.money[0].expenses!;
    assert.equal(funding.originalGrossMinor, 96535); assert.equal(funding.originalCreditedMinor, 96535); assert.equal(funding.invoiceGrossMinor, 35); assert.equal(funding.ordersGrossMinor, 96500);
    assert.equal(funding.currentAssignedMinor, 96535, "A completed return is a deduction, not a new assignment or receipt"); assert.equal(funding.returnedMinor, 200); assert.equal(funding.currentCollectedMinor, 96335);
    assert.equal(funding.paidMinor, 1825); assert.equal(funding.reservedMinor, 1325); assert.equal(funding.availableMinor, 93185); assert.equal(funding.unpaidCommitmentMinor, 0);
    assert.deepEqual(expenses, { approvedExpenseMinor: 3050, deliveredPrincipalMinor: 1800, returnedPrincipalMinor: 0, undeliveredPrincipalMinor: 0, paidPrincipalMinor: 1800, knownPaidFeeMinor: 25, unobservedFeeCount: 0, reservedPrincipalMinor: 1250, reservedFeeMinor: 75, claimCount: 1 });
    const scope = { tenantId: f.tenantId, projectId: f.projectId, provenance: "sample" as const }, positions = projectFundingPositions(await readFundingJournal(scope, database()), scope);
    assert.equal(packagePositionTotals(positions.positions, "electronics", 96000).collectedMinor, 0); assert.equal(packagePositionTotals(positions.positions, "materials", 90000).collectedMinor, 200); assert.equal(packagePositionTotals(positions.positions, "woodworking", 140000).collectedMinor, 100);
    const serialized = JSON.stringify(aggregate), privateValues = [...expense.canaries, expense.document.id, expense.claim.id, expense.receipt.id, ...expense.payables, invoice.id, ...receipts.map(row => row.actualProviderPaymentRef), ...f.actors.map(row => row.session.actorId)];
    for (const value of privateValues) assert.equal(serialized.includes(value), false, "Aggregate must not disclose a source, actor, provider reference or private value");
    assert.doesNotMatch(serialized, /documentId|receiptId|actorId|providerRef|previewUrl|encrypted_data|destination|merchant_scope/);
    const dependencies = await organizationAggregateRead(input, collectOrganizationProjectAggregateDependencies);
    assert.equal(dependencies.expenseDocuments.length, 1); assert.equal(dependencies.expenseDocuments[0].id, expense.document.id); assert.equal(dependencies.tenantId, f.tenantId);
  });
  it("derives unpaid promises from original collection and treats accepted sponsor promises as a subset", async () => {
    const f = await organizationAggregateFixture(), receipt = await storyReceipt(f, f.donors[0], "electronics", 500), target = await storyPolicy(f, "materials"), cancellation = await storyCase(f, "electronics");
    await storyChoice(f, f.donors[0], receipt, cancellation, target);
    await createPurposePledge(f.donors[0], { intentId: randomUUID(), policyId: target.id, policyDigest: target.digest, amountMinor: 500, acknowledged: true });
    const offer = await createSponsorOffer(f.organizer, { intentId: randomUUID(), kind: "grant", name: "Fictional aggregate sponsor", note: "Controlled synthetic accepted promise, not collected funding.", totalCapMinor: 200, matchBasisPoints: 1, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), packages: [{ policyId: target.id, policyDigest: target.digest, capMinor: 200 }], acknowledged: true });
    const view = (await sponsorViews(f.donors[1], database())).find(row => row.id === offer.id)!;
    await acceptSponsorOffer(f.donors[1], { intentId: randomUUID(), offerId: offer.id, digest: view.digest, expectedVersion: view.version, acknowledged: true });
    const aggregate = await organizationAggregateRead(organizationAggregateInput(f), loadOrganizationProjectAggregate), funding = aggregate.money[0].funding!;
    assert.equal(funding.originalGrossMinor, 500); assert.equal(funding.currentCollectedMinor, 500); assert.equal(funding.originalCommitmentRecordMinor, 1200); assert.equal(funding.unpaidCommitmentMinor, 700); assert.equal(funding.acceptedSponsorUnpaidMinor, 200);
  });
  it("distinguishes returned recipient principal and undelivered released principal from donor contribution returns", async () => {
    const f = await organizationAggregateFixture(); await organizationExpenseFixture(f, true);
    const aggregate = await organizationAggregateRead(organizationAggregateInput(f), loadOrganizationProjectAggregate), expenses = aggregate.money[0].expenses!, funding = aggregate.money[0].funding!;
    assert.equal(expenses.deliveredPrincipalMinor, 0); assert.equal(expenses.returnedPrincipalMinor, 1800); assert.equal(expenses.undeliveredPrincipalMinor, 1250); assert.equal(expenses.paidPrincipalMinor, 0);
    assert.equal(expenses.knownPaidFeeMinor, 25); assert.equal(expenses.reservedPrincipalMinor, 0); assert.equal(expenses.reservedFeeMinor, 0); assert.equal(funding.returnedMinor, 0); assert.equal(funding.currentCollectedMinor, 96000); assert.equal(funding.paidMinor, 25);
  });
  it("shows the full actually observed payout fee independently of the original covered fee allocation", async () => {
    const f = await organizationAggregateFixture(), expense = await organizationExpenseFixture(f);
    await query("UPDATE fp_payables SET actual_fee_minor=90,fee_state='review_required',last_code='PAYOUT_FEE_EXCEEDS_ALLOWANCE' WHERE id=$1 AND tenant_id=$2 AND project_id=$3", [expense.payables[0], f.tenantId, f.projectId]);
    const aggregate = await organizationAggregateRead(organizationAggregateInput(f), loadOrganizationProjectAggregate);
    assert.equal(aggregate.money[0].expenses!.knownPaidFeeMinor, 90); assert.equal(aggregate.money[0].expenses!.unobservedFeeCount, 0); assert.equal(aggregate.money[0].funding!.paidMinor, 1825);
  });
  it("withholds a prior fee value after a contradictory observation until the actual current fee is reconciled", async () => {
    const f = await organizationAggregateFixture(), expense = await organizationExpenseFixture(f);
    // This is the exact stored transition of recordActualFee when a later
    // observation disagrees: it retains the old scalar and marks a conflict.
    await query("UPDATE fp_payables SET fee_state='review_required',last_code='PAYOUT_FEE_CHANGED' WHERE id=$1 AND tenant_id=$2 AND project_id=$3", [expense.payables[0], f.tenantId, f.projectId]);
    const aggregate = await organizationAggregateRead(organizationAggregateInput(f), loadOrganizationProjectAggregate);
    assert.equal(aggregate.money[0].expenses!.knownPaidFeeMinor, 0); assert.equal(aggregate.money[0].expenses!.unobservedFeeCount, 1); assert.equal(aggregate.money[0].funding!.paidMinor, 1825);
  });
  it("withholds an unavailable private expense section without erasing its independent canonical funding position or substituting zero", async () => {
    const f = await organizationAggregateFixture(), expense = await organizationExpenseFixture(f), input = organizationAggregateInput(f);
    const before = await organizationAggregateRead(input, loadOrganizationProjectAggregate), original = JSON.stringify(before);
    await query("UPDATE fp_documents SET state='failed',version=version+1 WHERE id=$1 AND tenant_id=$2 AND project_id=$3", [expense.document.id, f.tenantId, f.projectId]);
    const after = await organizationAggregateRead(input, loadOrganizationProjectAggregate);
    assert.equal(after.state, "partial"); assert.equal(after.money[0].expenses, null); assert.equal(after.money[0].funding!.currentCollectedMinor, 96000); assert.equal(after.money[0].funding!.paidMinor, 1825); assert.match(after.reasons.join(" "), /unavailable or withdrawn source/);
    assert.equal(JSON.stringify(before), original, "Earlier immutable aggregate objects must remain unchanged");
    assert.notEqual(after.lineage!.aggregateHash, before.lineage!.aggregateHash);
    const snapshot = buildOrganizationPortfolioSnapshot({ projects: [after], filters: allFilters, asOf: after.lineage!.asOf }); assert.equal(snapshot.coverage.expenses.omittedProjects, 1); assert.equal(snapshot.groups[0].expenses, null);
  });
  it("never queries or returns unapproved expense/source/evidence sections under a funding-only disclosure", async () => {
    const f = await organizationAggregateFixture(), expense = await organizationExpenseFixture(f); await query("UPDATE fp_documents SET state='failed',version=version+1 WHERE id=$1", [expense.document.id]);
    const input = organizationAggregateInput(f, { disclosure: ["funding"] }), result = await organizationAggregateRead(input, async (tx, exact) => {
      const audited = { ...tx, query: async (sql: string, values?: unknown[]) => { assert.doesNotMatch(sql, /fp_claims|fp_payables|fp_plan_versions|fp_photo_alignments|fp_documents/); return tx.query(sql, values); } };
      return loadOrganizationProjectAggregate(audited as typeof tx, exact);
    });
    assert.equal(result.state, "included"); assert.equal(result.budget, null); assert.deepEqual(result.evidence, []); assert.equal(result.money[0].expenses, null);
  });
  it("withholds exact-scope mismatches and expired consent without revealing the linked project or its amounts", async () => {
    const f = await organizationAggregateFixture(), other = await organizationAggregateFixture(); await storyReceipt(f, f.donors[0], "electronics", 500);
    const wrong = await organizationAggregateRead(organizationAggregateInput(f, { tenantId: other.tenantId }), loadOrganizationProjectAggregate);
    assert.equal(wrong.state, "unavailable"); assert.equal(wrong.project, null); assert.equal(wrong.lineage, null); assert.deepEqual(wrong.money, []);
    const ended = await organizationAggregateRead(organizationAggregateInput(f, { consentExpiresAt: "2020-01-01T00:00:00.000Z" }), loadOrganizationProjectAggregate);
    assert.equal(ended.state, "expired"); assert.equal(ended.project, null); assert.deepEqual(ended.money, []); assert.equal(JSON.stringify(ended).includes(f.projectId), false);
  });
  it("rejects read-committed and arbitrary historical cutoffs instead of pretending a present projection reconstructs history", async () => {
    const f = await organizationAggregateFixture(), input = organizationAggregateInput(f);
    await assert.rejects(database().transaction(tx => loadOrganizationProjectAggregate(tx, input)), code("ORG_PROJECT_SOURCE_CHANGED"));
    await assert.rejects(organizationAggregateRead(input, (tx, exact) => loadOrganizationProjectAggregate(tx, { ...exact, asOf: "2020-01-01T00:00:00.000Z" })), code("ORG_PROJECT_SOURCE_CHANGED"));
  });
  it("keeps one coherent frozen financial cutoff even when a new receipt commits during the read", async () => {
    const f = await organizationAggregateFixture(), input = organizationAggregateInput(f); await storyReceipt(f, f.donors[0], "electronics", 200);
    const frozen = await organizationAggregateRead(input, async (tx, exact) => {
      const before = await loadOrganizationProjectAggregate(tx, exact);
      await storyReceipt(f, f.donors[0], "electronics", 100);
      const after = await loadOrganizationProjectAggregate(tx, exact); assert.deepEqual(after, before); return before;
    });
    const current = await organizationAggregateRead(input, loadOrganizationProjectAggregate); assert.equal(frozen.money[0].funding!.originalGrossMinor, 200); assert.equal(current.money[0].funding!.originalGrossMinor, 300); assert.notEqual(current.lineage!.aggregateHash, frozen.lineage!.aggregateHash);
  });
  it("labels the sandbox-test subset while excluding it from conditional project funding, expenses and promises", async () => {
    const f = await organizationAggregateFixture(); await storyReceipt(f, f.donors[0], "electronics", 500);
    const obligationId = randomUUID(), receipt = sampleReceipt(f.tenantId, f.projectId, obligationId, "electronics", 300, randomUUID());
    await database().transaction(async tx => {
      await tx.query("INSERT INTO fp_obligations(id,tenant_id,project_id,package_id,actor_id,amount_minor,channel,purpose,data) VALUES($1,$2,$3,'electronics',$4,300,'collected','sandbox_test','{\"eligible\":false}'::jsonb)", [obligationId, f.tenantId, f.projectId, f.donors[0].actorId]);
      await tx.query("INSERT INTO fp_settlement_receipts(id,tenant_id,project_id,obligation_id,package_id,provider_ref,provenance,data) VALUES($1,$2,$3,$4,'electronics',$5,'sample',$6::jsonb)", [receipt.id, f.tenantId, f.projectId, obligationId, receipt.actualProviderPaymentRef, JSON.stringify(receipt)]);
      await tx.query("INSERT INTO fp_economic_aliases(merchant_scope,alias,receipt_id) VALUES($1,$2,$3)", [f.tenantId, receipt.economicAliases[0], receipt.id]);
    });
    const aggregate = await organizationAggregateRead(organizationAggregateInput(f), loadOrganizationProjectAggregate), funding = aggregate.money[0].funding!;
    assert.equal(funding.originalGrossMinor, 800); assert.equal(funding.testGrossMinor, 300); assert.equal(funding.currentAssignedMinor, 500); assert.equal(funding.currentCollectedMinor, 500); assert.equal(funding.availableMinor, 500); assert.equal(funding.originalCommitmentRecordMinor, 500); assert.equal(funding.unpaidCommitmentMinor, 0);
  });
  it("does not relabel existing USD records as an unsupported project currency", async () => {
    const f = await organizationAggregateFixture(); await storyReceipt(f, f.donors[0], "electronics", 500);
    await query("UPDATE fp_projects SET metadata=jsonb_set(metadata,'{currency}','\"EUR\"'::jsonb),version=version+1 WHERE id=$1 AND tenant_id=$2", [f.projectId, f.tenantId]);
    const result = await organizationAggregateRead(organizationAggregateInput(f), loadOrganizationProjectAggregate);
    assert.equal(result.project!.currency, "EUR"); assert.equal(result.state, "partial"); assert.equal(result.budget, null); assert.deepEqual(result.money, []); assert.match(result.reasons.join(" "), /not converted or relabelled/);
  });
  it("keeps stable source basis across an unchanged cutoff and changes it when an actual canonical package changes", async () => {
    const f = await organizationAggregateFixture(), input = organizationAggregateInput(f), first = await organizationAggregateRead(input, loadOrganizationProjectAggregate), second = await organizationAggregateRead(input, loadOrganizationProjectAggregate);
    assert.equal(first.lineage!.aggregateHash, second.lineage!.aggregateHash);
    await query("UPDATE fp_packages SET budget_minor=budget_minor+100,version=version+1 WHERE project_id=$1 AND id='electronics'", [f.projectId]);
    const changed = await organizationAggregateRead(input, loadOrganizationProjectAggregate);
    assert.notEqual(changed.lineage!.aggregateHash, first.lineage!.aggregateHash); assert.notEqual(changed.lineage!.packageHash, first.lineage!.packageHash); assert.equal(changed.budget!.amountMinor, first.budget!.amountMinor + 100);
  });
});
