import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DomainError } from "../lib/domain/money";
import * as C from "../lib/procurement/contracts";
import { compareProcurementQuotes, procurementAmountInput, quoteArithmetic } from "../lib/procurement/arithmetic";
import { assessOperationsTransition, assertProcurementBasis, availableOperationsTargets, procurementBasisHash } from "../lib/procurement/state";
import { procurementDate, procurementMoney } from "../lib/procurement/presentation";
import { PR_END, PR_TIME, operationsObservation, prId, procurementBasis, procurementQuote, procurementQuoteDraft } from "./helpers/procurement";

describe("source-bound quote arithmetic and comparison", () => {
  it("retains exact declared components, discount and total without floating point or invented supplier acceptance", () => { const source = procurementQuoteDraft(), original = structuredClone(source), result = quoteArithmetic(source); assert.equal(result.subtotalMinor, 400); assert.equal(result.calculatedTotalMinor, 450); assert.equal(result.complete, true); assert.equal(result.differenceMinor, 0); assert.deepEqual(source, original); assert.equal(procurementQuote().supplier!.identityVerified, false); });
  it("keeps a missing component or line price unknown while preserving known source values, including explicit zero", () => {
    const source = procurementQuoteDraft(); source.deliveryMinor = null; const result = quoteArithmetic(source); assert.equal(result.calculatedTotalMinor, null); assert.equal(result.complete, false); assert.equal(result.statedTotalMinor, 450); assert.ok(result.missing.includes("Delivery not recorded"));
    const unread = procurementQuoteDraft(); unread.lines[0].lineMinor = null; assert.equal(quoteArithmetic(unread).subtotalMinor, null);
    const free = procurementQuoteDraft(); free.lines[0].unitMinor = 0; free.lines[0].lineMinor = 0; free.taxMinor = 0; free.deliveryMinor = 0; free.statedTotalMinor = 0; assert.equal(quoteArithmetic(free).complete, true);
  });
  it("rejects inconsistent unit/quantity, grand-total and negative-discount arithmetic without silently rewriting the original", () => {
    const unit = procurementQuoteDraft(); unit.lines[0].unitMinor = 199; assert.equal(quoteArithmetic(unit).complete, false); assert.match(quoteArithmetic(unit).errors[0], /quantity/);
    const total = procurementQuoteDraft(); total.statedTotalMinor = 451; assert.equal(quoteArithmetic(total).differenceMinor, 1); assert.equal(quoteArithmetic(total).complete, false);
    const discount = procurementQuoteDraft(); discount.discountMinor = 1000; const result = quoteArithmetic(discount); assert.equal(result.calculatedTotalMinor, null); assert.ok(result.errors.some(value => value.includes("discount")));
    const inclusive = procurementQuoteDraft(); inclusive.priceBasis = "all_inclusive"; inclusive.taxMinor = null; assert.equal(C.quoteDraftSchema.safeParse(inclusive).success, false);
  });
  it("uses reviewed internal package shares for bundled quotes instead of repeating the whole source amount for each purpose", () => {
    const source = procurementQuoteDraft(); source.packageIds = ["electronics", "materials"]; source.allocation = { kind: "reviewed_shares", shares: [{ packageId: "electronics", amountMinor: 300, note: "Controlled source-bound internal share." }, { packageId: "materials", amountMinor: 150, note: "Controlled source-bound internal remainder." }] };
    const arithmetic = quoteArithmetic(source); assert.equal(arithmetic.allocationComplete, true); assert.equal(arithmetic.allocationTotalMinor, 450);
    const view = { ...procurementQuote(), draft: source, arithmetic }, compare = (packageId: string) => compareProcurementQuotes({ packageId, currency: "USD", budgetMinor: 96000, capabilities: ["Basic electronics workspace"], observedAt: PR_TIME, quotes: [view] }).rows[0];
    assert.equal(compare("electronics").knownTotalMinor, 300); assert.equal(compare("materials").knownTotalMinor, 150); assert.equal(compare("materials").fullQuoteMinor, 450); assert.equal(compare("materials").priceBasis, "reviewed_internal_share");
    source.allocation.shares[1].amountMinor = 450; assert.equal(quoteArithmetic(source).allocationComplete, false); source.allocation.shares[1].amountMinor = null; assert.equal(quoteArithmetic(source).allocationTotalMinor, null);
    source.allocation = { kind: "single_package" }; assert.equal(C.quoteDraftSchema.safeParse(source).success, false);
  });
  it("keeps currencies/provenance separate and unknown capabilities/expiry unusable for selection", () => {
    const one = procurementQuote(), foreign = structuredClone(one), declared = structuredClone(one); foreign.id = prId(8); foreign.draft!.currency = "EUR"; declared.id = prId(9); declared.draft!.provenance = "user_declared";
    const rows = compareProcurementQuotes({ packageId: "electronics", currency: "USD", budgetMinor: 96000, capabilities: ["Basic electronics workspace", "Unreviewed safety capability"], observedAt: PR_TIME, quotes: [one, foreign, declared] }); assert.equal(rows.groups.length, 3); assert.equal(rows.rows[1].deltaToBudgetMinor, null); assert.equal(rows.rows[0].eligibleForSelection, false); assert.deepEqual(rows.rows[0].capabilityCoverage.unknown, ["Unreviewed safety capability"]);
    one.draft!.validUntil = null; assert.equal(compareProcurementQuotes({ packageId: "electronics", currency: "USD", budgetMinor: 96000, capabilities: [], observedAt: PR_TIME, quotes: [one] }).rows[0].eligibleForSelection, false);
    one.draft!.validUntil = PR_TIME; assert.equal(compareProcurementQuotes({ packageId: "electronics", currency: "USD", budgetMinor: 96000, capabilities: [], observedAt: PR_TIME, quotes: [one] }).rows[0].eligibleForSelection, false);
  });
  it("preserves unknown versus zero and the actual currency exponent in input and displayed amounts", () => {
    assert.equal(procurementAmountInput("", "USD"), null); assert.equal(procurementAmountInput("0", "USD"), 0); assert.equal(procurementAmountInput("1.05", "USD"), 105); assert.equal(procurementAmountInput("5", "JPY"), 5); assert.equal(procurementAmountInput("1.005", "KWD"), 1005);
    for (const value of ["1,200", "1e3", "-1", ".50", "1.005", "999999999"]) assert.throws(() => procurementAmountInput(value, "USD"), DomainError);
    assert.match(procurementMoney(105, "USD"), /1\.05/); assert.match(procurementMoney(1005, "KWD"), /1\.005/); assert.match(procurementDate(PR_TIME), /UTC$/);
  });
});

describe("separate operational and financial/physical authority", () => {
  it("allows current internal readiness but explicitly keeps provider liquidity and actual purchasing unauthorized", () => { const original = operationsObservation(), before = structuredClone(original), result = assessOperationsTransition(original); assert.equal(result.allowed, true); assert.match(result.warnings.join(" "), /liquidity is unchecked/); assert.match(result.warnings.join(" "), /no merchant order or payment/); assert.deepEqual(original, before); });
  it("blocks unknown cost, incomplete funding, currency mismatch, stale source, missing responsibility and unmet prerequisites", () => {
    const mutations: ((value: ReturnType<typeof operationsObservation>) => void)[] = [value => { value.selection!.amountMinor = null; }, value => { value.financialReady = false; }, value => { value.selection!.currency = "EUR"; }, value => { value.selection!.sourceCurrent = false; }, value => { value.responsibility = null; }, value => { value.prerequisitesCurrent = false; }, value => { value.accountingAvailableMinor = null; }, value => { value.basis.fundingState = "cancelled"; }];
    for (const mutation of mutations) { const input = operationsObservation(); mutation(input); assert.equal(assessOperationsTransition(input).allowed, false); }
  });
  it("enforces original responsibility cycle/current membership/deadline and never lets donor/auditor roles operate", () => {
    const deadline = operationsObservation(); deadline.observedAt = PR_END; assert.equal(assessOperationsTransition(deadline).allowed, false);
    const cycle = operationsObservation(); cycle.responsibility!.cycle = 2; assert.equal(assessOperationsTransition(cycle).allowed, false);
    const membership = operationsObservation(); membership.responsibility!.authorityCurrent = false; assert.equal(assessOperationsTransition(membership).allowed, false);
    for (const role of ["donor", "auditor"] as const) { const input = operationsObservation(); input.role = role; assert.deepEqual(availableOperationsTargets(input), []); }
    const ended = operationsObservation(); ended.originalAuthorityCurrent = false; assert.equal(assessOperationsTransition(ended).code, "PROCUREMENT_AUTHORITY_ENDED");
  });
  it("lets only the current accepted volunteer report their own step and blocks approval/acceptance/cancellation escalation", () => {
    const input = operationsObservation(); input.role = "volunteer"; input.ownAcceptedResponsibility = true; input.from = "procurement_ready"; input.to = "in_progress"; assert.equal(assessOperationsTransition(input).allowed, true);
    input.ownAcceptedResponsibility = false; assert.equal(assessOperationsTransition(input).code, "PROCUREMENT_ROLE_DENIED"); input.ownAcceptedResponsibility = true;
    for (const [from, to] of [["draft", "approved"], ["review_pending", "accepted"], ["in_progress", "canceled"], ["canceled", "reopened"]] as const) { input.from = from; input.to = to; assert.equal(assessOperationsTransition(input).allowed, false); }
  });
  it("does not use a block to skip readiness or approval and resumes only its exact prior step", () => {
    const input = operationsObservation(); input.from = "blocked"; input.blockedFrom = "approved"; input.to = "in_progress"; assert.equal(assessOperationsTransition(input).allowed, false); input.to = "approved"; assert.equal(assessOperationsTransition(input).allowed, true); input.to = "draft"; assert.equal(assessOperationsTransition(input).allowed, true);
    input.role = "volunteer"; input.ownAcceptedResponsibility = true; input.blockedFrom = "in_progress"; input.to = "in_progress"; assert.equal(assessOperationsTransition(input).allowed, true); input.to = "review_pending"; assert.equal(assessOperationsTransition(input).allowed, false);
  });
  it("requires current-cycle physical decisions for acceptance, preserves originals on reopen, and never equates payment with physical work", () => {
    const input = operationsObservation(); input.from = "review_pending"; input.to = "accepted"; input.requirements[1].currentCycle = false; assert.equal(assessOperationsTransition(input).code, "PROCUREMENT_PHYSICAL_REVIEW_REQUIRED"); input.requirements[1].currentCycle = true; input.financialReady = false; input.accountingAvailableMinor = 0; assert.equal(assessOperationsTransition(input).allowed, true);
    input.from = "accepted"; input.to = "reopened"; const before = structuredClone(input), result = assessOperationsTransition(input); assert.equal(result.allowed, true); assert.match(result.effects.join(" "), /next operational cycle/); assert.match(result.effects.join(" "), /new current physical/); assert.deepEqual(input, before);
  });
  it("records cancellation with unknown money/source readiness while preserving all independent financial obligations", () => {
    const input = operationsObservation(); input.to = "canceled"; input.planCurrent = false; input.financialReady = false; input.selection = null; input.responsibility = null; const result = assessOperationsTransition(input); assert.equal(result.allowed, true); assert.match(result.effects.join(" "), /funding, donor choices, expense approvals, payables/); assert.match(result.warnings.join(" "), /does not cancel or return a payment/);
  });
  it("detects a changed source, policy, funding, package, assignment or evidence basis without modifying a past decision", () => {
    const original = procurementBasis(), digest = procurementBasisHash(original); assert.doesNotThrow(() => assertProcurementBasis(digest, original)); for (const property of ["fundingHash", "policyHash", "evidenceHash", "sourcePermissionHash", "dependencyHash", "assignmentHash", "selectionHash", "claimsHash"] as const) { const changed = structuredClone(original); changed[property] = "0".repeat(64); assert.throws(() => assertProcurementBasis(digest, changed), DomainError); } assert.equal(procurementBasisHash(original), digest);
  });
});
