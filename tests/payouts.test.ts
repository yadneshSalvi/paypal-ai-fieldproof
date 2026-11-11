import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresDatabase, canonicalJson, sha256, type CommerceRestResult, type CreatePayout, type PayoutBatchObservation, type PayoutItemObservation } from "@fracture/paypal-core";
import { database, initializeDatabase, query } from "../lib/server/db";
import type { Session } from "../lib/server/auth";
import { createProject, sampleReceipt } from "../lib/server/seed";
import { importSampleReceipt } from "../lib/server/documents";
import type { DocumentStorage } from "../lib/server/document-storage";
import { createClaim, reviewClaim, saveClaimDraft } from "../lib/server/claims";
import { sealDestination, openDestination } from "../lib/server/identity";
import { approvePayout, cancelUnclaimedPayout, checkPayout, claimPaymentView, observeOwnedPayout, preparePayoutReview, reconcilePayouts, releasePayout, sendPayout, type PayoutDependencies } from "../lib/server/payouts";
import { assertUsableBalance, normalizeBalance, type BalanceEvidence } from "../lib/server/balance";
import { splitFeeAllowance } from "../lib/domain/payouts";
import { cancelUnspentCollection } from "../lib/server/compensation";
import { openPrivate } from "../lib/server/private-values";
import { geminiOutputShape } from "../lib/domain/ai-schema";
import { extractedReceiptSchema } from "../lib/domain/evidence";
import { z } from "zod";

const schema = `fp_payout_test_${randomUUID().replaceAll("-", "")}`, originalUrl = process.env.DATABASE_URL!, admin = new PostgresDatabase(originalUrl);
before(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(originalUrl); url.searchParams.set("options", `-c search_path=${schema}`); process.env.DATABASE_URL = url.href;
  await initializeDatabase();
});
afterEach(async () => {
  const tables = await query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname=$1", [schema]);
  await database().query(`TRUNCATE ${tables.map(row => `"${schema}"."${row.tablename}"`).join(",")} RESTART IDENTITY CASCADE`);
});
after(async () => { await database().close(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.close(); process.env.DATABASE_URL = originalUrl; });
const result = <T>(value: T): CommerceRestResult<T> => ({ outcome: "succeeded", value, source: "live_sandbox", observedAt: new Date().toISOString(), httpStatus: 200, debugId: null, recovered: false });
const unknown = <T>(code = "FIXTURE_RESPONSE_LOST"): Exclude<CommerceRestResult<T>, { outcome: "succeeded" }> => ({ outcome: "unknown", code, message: "A test fixture dropped the response.", originalPayoutBatchId: null, source: "live_sandbox", observedAt: new Date().toISOString(), httpStatus: null, debugId: null });
async function role(session: Session, value: Session["role"]) { session.role = value; await query("UPDATE fp_sessions SET role=$2 WHERE id=$1", [session.id, value]); }
function balanceEvidence(availableMinor = 1_000_000): BalanceEvidence {
  const providerTime = new Date(Date.now() - 30_000).toISOString();
  return { accountId: "FIXTUREMERCHANT001", currency: "USD", availableMinor, totalMinor: availableMinor, withheldMinor: 0,
    asOfTime: providerTime, lastRefreshTime: providerTime, observedAt: new Date().toISOString(), bodyHash: "fixture-balance-hash", source: "live_sandbox" };
}
async function fundedFixture(session: Session, invoice = false, amount = 96000) {
  // A canonical settlement input fixture. This is not a provider qualification
  // or a replacement for the separately tested eight-consent collection flow.
  const obligationId = randomUUID(), consentId = randomUUID(), roundId = randomUUID();
  const start = new Date(), end = new Date(start.getTime() + 48 * 60 * 60_000);
  const receipt = { ...sampleReceipt(session.tenantId, session.projectId, obligationId, "electronics", amount, randomUUID(), invoice), provenance: "live_sandbox" as const };
  await database().transaction(async tx => {
    await tx.query("INSERT INTO fp_obligations(id,tenant_id,project_id,package_id,actor_id,amount_minor,channel,purpose,data) VALUES($1,$2,$3,'electronics',$4,96000,'collected','conditional_pledge','{}')", [obligationId, session.tenantId, session.projectId, session.actorId]);
    await tx.query("INSERT INTO fp_collection_rounds(id,tenant_id,project_id,package_id,package_version,target_minor,collection_started_at,recovery_ends_at,policy_hash,state,data) VALUES($1,$2,$3,'electronics',1,96000,$4,$5,'fixture-policy',$6,'{}')", [roundId, session.tenantId, session.projectId, start, end, amount < 96000 ? "recovering" : "funded"]);
    await tx.query(`INSERT INTO fp_conditional_consents(id,tenant_id,project_id,actor_id,session_id,obligation_id,intent_id,slot_index,package_id,package_version,amount_minor,status,policy_digest,policy,expires_at,round_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,0,'electronics',1,96000,'collected','fixture-digest','{}',$8,$9)`, [consentId, session.tenantId, session.projectId, session.actorId, session.id, obligationId, randomUUID(), end, roundId]);
    await tx.query("INSERT INTO fp_collection_items(round_id,consent_id,obligation_id,consent_version,consent_digest,amount_minor,state) VALUES($1,$2,$3,1,'fixture-digest',96000,'collected')", [roundId, consentId, obligationId]);
    await tx.query("INSERT INTO fp_settlement_receipts(id,tenant_id,project_id,obligation_id,package_id,provider_ref,provenance,data) VALUES($1,$2,$3,$4,'electronics',$5,'live_sandbox',$6::jsonb)", [receipt.id, session.tenantId, session.projectId, obligationId, receipt.actualProviderPaymentRef, JSON.stringify(receipt)]);
    for (const [account, side] of [["provider_cash", "debit"], ["restricted_contributions", "credit"]]) await tx.query("INSERT INTO fp_journal(id,tenant_id,project_id,receipt_id,account,side,amount_minor,currency) VALUES($1,$2,$3,$4,$5,$6,$7,'USD')", [randomUUID(), session.tenantId, session.projectId, receipt.id, account, side, amount]);
  });
  return { roundId, receipt };
}
async function fixture(options: { invoice?: boolean; funded?: number; secondPackage?: string } = {}) {
  const session: Session = { id: randomUUID(), tenantId: randomUUID(), projectId: randomUUID(), actorId: randomUUID(), role: "volunteer", mode: "live_sandbox", expiresAt: new Date(Date.now() + 600_000).toISOString() };
  await database().transaction(async tx => {
    await createProject(tx, session.tenantId, session.projectId, `payout-fixture-${randomUUID()}`, "live_sandbox");
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [session.id, randomUUID(), session.tenantId, session.projectId, session.actorId, session.role, session.expiresAt]);
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,$4::jsonb)", [session.tenantId, session.projectId, session.actorId, JSON.stringify(["volunteer", "organizer", "donor", "auditor"])]);
    await tx.query("INSERT INTO fp_recipient_accounts(id,tenant_id,actor_id,encrypted_destination,masked_label,verification_method,account_verified,verified_at) VALUES($1,$2,$3,$4,'PayPal •••0001','paypal_identity',true,now())", [randomUUID(), session.tenantId, session.actorId, sealDestination("FIXTUREPAYER0001", session.tenantId, session.actorId)]);
  });
  const files = new Map<string, { bytes: Buffer; contentType: string }>();
  const storage: DocumentStorage = { async write(pathname, bytes, contentType) { files.set(pathname, { bytes, contentType }); }, async read(pathname) { const file = files.get(pathname); assert.ok(file); return { ...file, pathname }; } };
  const document = await importSampleReceipt(session, randomUUID(), "original", storage);
  let claim = await createClaim(session, { documentId: document.id, runId: null, intentId: randomUUID() });
  const draftLines = [{ id: "line-1", description: "Solder wire", requestedMinor: 1800, packageId: "electronics" }, { id: "line-2", description: "Heat-shrink tubing", requestedMinor: 1250, packageId: options.secondPackage ?? "electronics" }];
  claim = await saveClaimDraft(session, claim.id, { expectedVersion: claim.version, title: "Controlled sample expense", note: "Two selected source lines; fixture only", currency: "USD", totalMinor: 8640, lines: draftLines }, true);
  await role(session, "organizer");
  claim = await reviewClaim(session, claim.id, { expectedVersion: claim.version, sourceTotalMinor: 8640, currency: "USD", note: "Fixture source and selected lines checked separately", sourceChecked: true, sampleAcknowledged: true, receiptSplit: false, duplicateResolutions: [],
    lines: draftLines.map((line, index) => ({ id: line.id, description: line.description, packageId: line.packageId, sourceMinor: line.requestedMinor, approvedMinor: line.requestedMinor, receiptLineKey: String(index + 1), decision: "approved" as const, reviewNote: "Fixture source amount and purpose checked", uncertaintyResolved: true })) });
  const funding = await fundedFixture(session, options.invoice, options.funded);
  const creates: CreatePayout[] = [], calls: string[] = [], batches = new Map<string, { request: CreatePayout; batch: PayoutBatchObservation; item: PayoutItemObservation }>();
  let status = "PENDING", batchStatus = "PROCESSING", fee: number | null = 50, loseNext = false, refuseNext = false, readMismatch = false, badBatch = false, readUnavailable = false, actualEffects = 0;
  let balance = balanceEvidence(), beforeBalance: (() => Promise<void>) | null = null;
  const gateway: PayoutDependencies["gateway"] = {
    async createPayout(request) {
      calls.push("create"); creates.push(structuredClone(request));
      if (refuseNext) { refuseNext = false; return { ...unknown<PayoutBatchObservation>(), outcome: "refused", code: "INSUFFICIENT_FUNDS" }; }
      let existing = batches.get(request.senderBatchId);
      if (!existing) {
        actualEffects++;
        const id = `FIXBATCH${randomUUID().replaceAll("-", "")}`;
        const item: PayoutItemObservation = { ...request.items[0], id: `FIXITEM${randomUUID().replaceAll("-", "")}`, batchId: id, status, transactionId: "FIXTRANSACTION001", fee: fee === null ? null : { currency: "USD", minor: fee }, processedAt: new Date().toISOString() };
        const batch: PayoutBatchObservation = { id, senderBatchId: request.senderBatchId, status: batchStatus, money: request.items[0].money, estimatedFees: null, items: [item], complete: true };
        existing = { request: structuredClone(request), batch, item }; batches.set(request.senderBatchId, existing);
      } else assert.equal(canonicalJson(existing.request), canonicalJson(request));
      if (loseNext) { loseNext = false; return unknown(); }
      return result({ ...existing.batch, items: [], complete: false });
    },
    async getPayoutBatch(id, senderBatchId) {
      calls.push("batch-read"); const value = batches.get(senderBatchId); assert.ok(value); assert.equal(value.batch.id, id);
      return result({ ...structuredClone(value.batch), status: batchStatus, items: [{ ...structuredClone(value.item), status, ...(badBatch ? { receiver: "OTHERFIXTUREPAYER" } : {}) }] });
    },
    async getPayoutItem(id) {
      calls.push("item-read"); const value = [...batches.values()].find(value => value.item.id === id); assert.ok(value);
      if (readUnavailable) return unknown("FIXTURE_READ_UNAVAILABLE");
      return result({ ...structuredClone(value.item), status, fee: fee === null ? null : { currency: "USD", minor: fee }, ...(readMismatch ? { receiver: "OTHERFIXTUREPAYER" } : {}) });
    },
    async cancelUnclaimedPayout(item) { calls.push("cancel"); assert.equal(status, "UNCLAIMED"); assert.equal(item.receiver, "FIXTUREPAYER0001"); status = "RETURNED"; fee = 0; return gateway.getPayoutItem(item.id); },
  };
  const deps: PayoutDependencies = { gateway, balance: { async read() { calls.push("balance"); if (beforeBalance) await beforeBalance(); return { outcome: "observed", evidence: { ...balance, observedAt: new Date().toISOString() } }; } } };
  const select = (lineIds = ["line-1", "line-2"], payableId?: string) => preparePayoutReview(session, claim.id, { expectedVersion: claim.version, lineIds, ...(payableId ? { payableId } : {}) });
  const approve = async (lineIds?: string[]) => { const review = await select(lineIds); return approvePayout(session, claim.id, { reviewId: review.id, reviewDigest: review.digest, intentId: randomUUID(), amountMinor: review.amountMinor, currency: "USD", recipientAndAmountChecked: true, feeAllowanceAcknowledged: true, sampleAcknowledged: true }); };
  return { session, claim, document, ...funding, deps, calls, creates, batches, select, approve, effects: () => actualEffects,
    status: (value: string) => { status = value; }, batchStatus: (value: string) => { batchStatus = value; }, fee: (value: number | null) => { fee = value; },
    lose: () => { loseNext = true; }, refuse: () => { refuseNext = true; }, mismatch: () => { readMismatch = true; }, badBatch: () => { badBatch = true; }, readUnavailable: () => { readUnavailable = true; },
    setBalance: (value: BalanceEvidence) => { balance = value; }, beforeBalance: (value: () => Promise<void>) => { beforeBalance = value; } };
}

describe("reviewed Payouts — isolated PostgreSQL and fixture gateways, no live requests", () => {
  it("requires funded original sources and a current verified claimant account", async () => {
    const f = await fixture({ funded: 92500 });
    await assert.rejects(f.select(), { code: "PACKAGE_NOT_FUNDED" });
    await query("UPDATE fp_collection_rounds SET state='funded' WHERE id=$1", [f.roundId]);
    await assert.rejects(f.select(), { code: "ROUND_FUNDING_CHANGED" });
    await query("UPDATE fp_recipient_accounts SET verified_at=now()-interval '8 days'");
    await assert.rejects(f.select(), { code: "RECIPIENT_VERIFICATION_EXPIRED" });
    assert.equal(f.effects(), 0);
  });
  it("does not borrow Electronics funding for a Safety line", async () => {
    const f = await fixture({ secondPackage: "safety" });
    await assert.rejects(f.select(), { code: "PACKAGE_NOT_FUNDED" });
    const one = await f.approve(["line-1"]); assert.equal(one.amountMinor, 1800);
  });
  it("binds approval input exactly and reserves each line only once under concurrency", async () => {
    const f = await fixture(), review = await f.select();
    const input = { reviewId: review.id, reviewDigest: review.digest, intentId: randomUUID(), amountMinor: review.amountMinor, currency: "USD" as const, recipientAndAmountChecked: true as const, feeAllowanceAcknowledged: true as const, sampleAcknowledged: true };
    const results = await Promise.all([approvePayout(f.session, f.claim.id, input), approvePayout(f.session, f.claim.id, input)]);
    assert.equal(results[0].id, results[1].id);
    await assert.rejects(approvePayout(f.session, f.claim.id, { ...input, amountMinor: input.amountMinor + 1 }), { code: "PAYOUT_INTENT_CHANGED" });
    await assert.rejects(f.select(), { code: "LINE_ALREADY_PAYABLE" });
    const [sum] = await query<{ amount: string }>("SELECT sum(amount_minor) AS amount FROM fp_receipt_allocations WHERE state='reserved'");
    assert.equal(Number(sum.amount), 3050 + 2000);
    const [privateRow] = await query<{ encrypted_data: string }>("SELECT encrypted_data FROM fp_payables");
    assert.ok(!privateRow.encrypted_data.includes("FIXTUREPAYER0001")); assert.equal(f.effects(), 0);
  });
  it("pays from an invoice settlement without assuming an Orders capture identity", async () => {
    const f = await fixture({ invoice: true }); f.status("SUCCESS");
    const p = await f.approve(), sent = await sendPayout(f.session, p.id, false, f.deps);
    assert.equal(sent.state, "succeeded"); assert.equal(sent.amountMinor, 3050); assert.equal(sent.actualFeeMinor, 50);
    assert.equal(f.receipt.sourceOrderId, null); assert.equal(f.receipt.provenRefundableRef, null);
    const [paid] = await query<{ total: string }>("SELECT sum(amount_minor) AS total FROM fp_receipt_allocations WHERE state='paid'"); assert.equal(Number(paid.total), 3100);
    const [journal] = await query<{ balance: string; count: string }>("SELECT sum(CASE WHEN side='debit' THEN amount_minor ELSE -amount_minor END) AS balance,count(*) AS count FROM fp_journal");
    assert.equal(Number(journal.balance), 0); assert.equal(Number(journal.count), 8);
    const view = await claimPaymentView(f.session, f.claim.id); assert.equal(view.lines.reduce((sum, line) => sum + line.paidMinor, 0), 3050);
  });
  it("requires fresh item success; accepted creation and batch SUCCESS are not payment", async () => {
    const f = await fixture(); f.batchStatus("SUCCESS");
    const p = await f.approve(), sent = await sendPayout(f.session, p.id, false, f.deps);
    assert.equal(sent.state, "pending"); assert.equal((await query("SELECT id FROM fp_journal WHERE operation_id=$1", [p.id])).length, 0);
    f.status("SUCCESS");
    await Promise.all([checkPayout(f.session, p.id, f.deps), checkPayout(f.session, p.id, f.deps)]);
    assert.equal((await query("SELECT id FROM fp_journal WHERE operation_id=$1", [p.id])).length, 6);
    assert.equal(f.effects(), 1);
    f.status("PENDING"); assert.equal((await checkPayout(f.session, p.id, f.deps)).state, "succeeded");
  });
  it("claims one outbound mutation when two dispatchers race", async () => {
    const f = await fixture(), p = await f.approve();
    const values = await Promise.allSettled([sendPayout(f.session, p.id, false, f.deps), sendPayout(f.session, p.id, false, f.deps)]);
    assert.ok(values.some(value => value.status === "fulfilled")); assert.equal(f.creates.length, 1); assert.equal(f.effects(), 1);
  });
  it("rechecks current membership, recipient and review versions immediately before dispatch", async () => {
    const f = await fixture(), p = await f.approve();
    f.beforeBalance(async () => { await query("UPDATE fp_memberships SET state='revoked'"); });
    await assert.rejects(sendPayout(f.session, p.id, false, f.deps), { code: "MEMBERSHIP_DENIED" }); assert.equal(f.creates.length, 0);
    await query("UPDATE fp_memberships SET state='active'"); f.beforeBalance(async () => { await query("UPDATE fp_recipient_accounts SET version=version+1"); });
    await assert.rejects(sendPayout(f.session, p.id, false, f.deps), { code: "PAYOUT_REVIEW_CHANGED" }); assert.equal(f.creates.length, 0);
  });
  it("a fetched old provider snapshot remains stale and cannot authorize a Payout", async () => {
    const f = await fixture(), p = await f.approve();
    f.setBalance({ ...balanceEvidence(), asOfTime: new Date(Date.now() - 4 * 60 * 60_000).toISOString() });
    await assert.rejects(sendPayout(f.session, p.id, false, f.deps), { code: "BALANCE_PROVIDER_STALE" });
    assert.equal(f.creates.length, 0);
    const [balance] = await query<{ as_of_time: Date; observed_at: Date }>("SELECT * FROM fp_balance_observations");
    assert.ok(balance.observed_at.getTime() - balance.as_of_time.getTime() > 3 * 60 * 60_000);
  });
  it("includes other approved payables and fee allowances in the locked merchant budget", async () => {
    const f = await fixture(), first = await f.approve(["line-1"]), second = await f.approve(["line-2"]);
    f.setBalance(balanceEvidence(5000));
    await assert.rejects(sendPayout(f.session, first.id, false, f.deps), { code: "BALANCE_ALLOWANCE_UNAVAILABLE" });
    assert.equal(f.creates.length, 0);
    await releasePayout(f.session, second.id);
    assert.equal((await sendPayout(f.session, first.id, false, f.deps)).state, "pending");
  });
  it("preserves unknown creation and explicitly retries its identical original within 30 days", async () => {
    const f = await fixture(), p = await f.approve(); f.lose();
    assert.equal((await sendPayout(f.session, p.id, false, f.deps)).state, "unknown");
    await reconcilePayouts({ deps: f.deps }); assert.equal(f.creates.length, 1);
    await assert.rejects(releasePayout(f.session, p.id), { code: "PAYOUT_RELEASE_UNPROVEN" });
    f.status("SUCCESS"); const recovered = await sendPayout(f.session, p.id, true, f.deps);
    assert.equal(recovered.state, "succeeded"); assert.equal(f.creates.length, 2); assert.equal(f.effects(), 1);
    assert.equal(canonicalJson(f.creates[0]), canonicalJson(f.creates[1]));
  });
  it("a later refusal cannot erase a prior unknown creation", async () => {
    const f = await fixture(), p = await f.approve(); f.lose(); await sendPayout(f.session, p.id, false, f.deps);
    f.refuse(); assert.equal((await sendPayout(f.session, p.id, true, f.deps)).state, "unknown");
    await assert.rejects(releasePayout(f.session, p.id), { code: "PAYOUT_RELEASE_UNPROVEN" });
  });
  it("never recreates an unknown request outside duplicate retention", async () => {
    const f = await fixture(), p = await f.approve(); f.lose(); await sendPayout(f.session, p.id, false, f.deps);
    await query("UPDATE fp_payables SET first_dispatched_at=now()-interval '31 days'");
    await assert.rejects(sendPayout(f.session, p.id, true, f.deps), { code: "PAYOUT_DUPLICATE_WINDOW_EXPIRED" }); assert.equal(f.creates.length, 1);
    assert.equal((await checkPayout(f.session, p.id, f.deps)).canRetryOriginal, false);
  });
  it("retains a mismatched private item response without crediting the recipient", async () => {
    const f = await fixture(), p = await f.approve(); f.status("SUCCESS"); f.mismatch();
    const view = await sendPayout(f.session, p.id, false, f.deps);
    assert.equal(view.code, "PAYOUT_ITEM_IDENTITY_UNPROVEN"); assert.notEqual(view.state, "succeeded");
    assert.equal((await query("SELECT id FROM fp_journal WHERE operation_id=$1", [p.id])).length, 0);
    const [observation] = await query<{ id: string; encrypted_data: string }>("SELECT id,encrypted_data FROM fp_payout_observations WHERE kind='item_read'");
    assert.ok(!observation.encrypted_data.includes("OTHERFIXTUREPAYER"));
    const stored = openPrivate<CommerceRestResult<PayoutItemObservation>>(observation.encrypted_data, `payout-observation:${f.session.tenantId}:${f.session.projectId}:${p.id}:${observation.id}`);
    assert.ok(stored.outcome === "succeeded" && stored.value.receiver === "OTHERFIXTUREPAYER");
  });
  it("blocks a complete batch with a conflicting item identity", async () => {
    const f = await fixture(), p = await f.approve(); f.status("SUCCESS"); f.badBatch();
    const view = await sendPayout(f.session, p.id, false, f.deps); assert.equal(view.code, "PAYOUT_BATCH_IDENTITY_UNPROVEN");
    assert.equal(f.calls.filter(call => call === "item-read").length, 0); assert.equal((await query("SELECT id FROM fp_journal WHERE operation_id=$1", [p.id])).length, 0);
  });
  it("an unclaimed item cancels only through its exact owned route and fresh return", async () => {
    const f = await fixture(), p = await f.approve(); f.status("UNCLAIMED"); await sendPayout(f.session, p.id, false, f.deps);
    const cancelled = await cancelUnclaimedPayout(f.session, p.id, f.deps);
    assert.equal(cancelled.state, "returned"); assert.equal(cancelled.feeState, "released"); assert.equal(f.calls.filter(call => call === "cancel").length, 1);
    assert.equal((await query("SELECT id FROM fp_receipt_allocations WHERE state IN ('reserved','paid')")).length, 0);
  });
  it("a later return reverses principal once and preserves the separately confirmed fee", async () => {
    const f = await fixture(), p = await f.approve(); f.status("SUCCESS"); await sendPayout(f.session, p.id, false, f.deps);
    f.status("REFUNDED"); await checkPayout(f.session, p.id, f.deps); await checkPayout(f.session, p.id, f.deps);
    const [spent] = await query<{ total: string }>("SELECT COALESCE(sum(amount_minor),0) AS total FROM fp_receipt_allocations WHERE state IN ('reserved','paid')"); assert.equal(Number(spent.total), 50);
    const [journal] = await query<{ balance: string; returns: string }>("SELECT sum(CASE WHEN side='debit' THEN amount_minor ELSE -amount_minor END) AS balance,count(*) FILTER(WHERE entry_kind='reimbursement_return') AS returns FROM fp_journal");
    assert.equal(Number(journal.balance), 0); assert.equal(Number(journal.returns), 4);
    const second = await f.approve(); assert.notEqual(second.id, p.id);
    assert.equal((await claimPaymentView(f.session, f.claim.id)).lines.reduce((sum, line) => sum + line.paidMinor, 0), 0);
  });
  it("keeps an unknown fee reserved and records above-allowance fees separately", async () => {
    const f = await fixture(), p = await f.approve(); f.status("SUCCESS"); f.fee(null);
    const sent = await sendPayout(f.session, p.id, false, f.deps); assert.equal(sent.state, "succeeded"); assert.equal(sent.feeState, "review_required");
    f.fee(2500); const checked = await checkPayout(f.session, p.id, f.deps); assert.equal(checked.actualFeeMinor, 2500); assert.equal(checked.code, "PAYOUT_FEE_EXCEEDS_ALLOWANCE");
    const [covered] = await query<{ total: string }>("SELECT sum(amount_minor) AS total FROM fp_receipt_allocations WHERE kind='fee' AND state='paid'"); assert.equal(Number(covered.total), 2000);
    const [exception] = await query<{ amount: string; balance: string }>("SELECT sum(amount_minor) FILTER(WHERE side='debit') AS amount,sum(CASE WHEN side='debit' THEN amount_minor ELSE -amount_minor END) AS balance FROM fp_merchant_journal");
    assert.equal(Number(exception.amount), 500); assert.equal(Number(exception.balance), 0);
  });
  it("known Payout observations reconcile read-only and reject unowned resources", async () => {
    const f = await fixture(), p = await f.approve(); await sendPayout(f.session, p.id, false, f.deps);
    const batch = [...f.batches.values()][0]; f.status("SUCCESS");
    const owner = await observeOwnedPayout(batch.item.id, "item", f.deps); assert.equal(owner.tenant_id, f.session.tenantId); assert.equal(f.creates.length, 1);
    await assert.rejects(observeOwnedPayout("OTHER_PAYOUT_ITEM", "item", f.deps), { code: "PAYOUT_OWNERSHIP_UNRESOLVED" });
  });
  it("an Auditor, a foreign tenant and a stale source review cannot approve repayment", async () => {
    const f = await fixture(); await role(f.session, "auditor"); await assert.rejects(f.select(), { code: "ROLE_DENIED" });
    await role(f.session, "organizer"); await assert.rejects(preparePayoutReview({ ...f.session, tenantId: randomUUID() }, f.claim.id, { expectedVersion: f.claim.version, lineIds: ["line-1"] }), { code: "ROLE_DENIED" });
    await query("UPDATE fp_packages SET version=version+1 WHERE id='electronics'"); await assert.rejects(f.select(), { code: "PACKAGE_VERSION_CHANGED" });
    assert.equal(f.creates.length, 0);
  });
  it("a reserved reimbursement blocks unspent-round cancellation until explicitly released", async () => {
    const f = await fixture(), p = await f.approve();
    await assert.rejects(cancelUnspentCollection(f.session, { roundId: f.roundId, expectedVersion: 1, acknowledged: true }));
    assert.equal((await query<{ state: string }>("SELECT state FROM fp_collection_rounds WHERE id=$1", [f.roundId]))[0].state, "funded");
    await releasePayout(f.session, p.id); assert.equal((await query("SELECT id FROM fp_receipt_allocations WHERE state IN ('reserved','paid')")).length, 0);
  });
  it("renews expired authority deliberately without replacing the original provider request", async () => {
    const f = await fixture(), p = await f.approve();
    const [before] = await query<{ request_hash: string; encrypted_data: string }>("SELECT request_hash,encrypted_data FROM fp_payables WHERE id=$1", [p.id]);
    await query("UPDATE fp_approval_records SET expires_at=now()-interval '1 minute'");
    await assert.rejects(sendPayout(f.session, p.id, false, f.deps), { code: "PAYOUT_APPROVAL_EXPIRED" });
    await query("UPDATE fp_receipt_groups SET version=version+1");
    const review = await f.select(["line-1", "line-2"], p.id);
    const input = { reviewId: review.id, reviewDigest: review.digest, intentId: randomUUID(), amountMinor: review.amountMinor, currency: "USD" as const, recipientAndAmountChecked: true as const, feeAllowanceAcknowledged: true as const, sampleAcknowledged: true };
    const renewed = await approvePayout(f.session, f.claim.id, input); assert.equal(renewed.id, p.id);
    assert.equal((await approvePayout(f.session, f.claim.id, input)).id, p.id);
    const [after] = await query<{ request_hash: string; encrypted_data: string }>("SELECT request_hash,encrypted_data FROM fp_payables WHERE id=$1", [p.id]); assert.equal(before.request_hash, after.request_hash);
    const aad = `payable:${f.session.tenantId}:${f.session.projectId}:${p.id}`;
    assert.equal(canonicalJson(openPrivate<{ request: CreatePayout }>(before.encrypted_data, aad).request), canonicalJson(openPrivate<{ request: CreatePayout }>(after.encrypted_data, aad).request));
    assert.equal((await query("SELECT id FROM fp_approval_records WHERE revoked_at IS NULL")).length, 1);
    assert.equal((await sendPayout(f.session, p.id, false, f.deps)).state, "pending");
  });
  it("never redirects an unknown original after the claimant changes destination", async () => {
    const f = await fixture(), p = await f.approve(); f.lose(); await sendPayout(f.session, p.id, false, f.deps);
    await query("UPDATE fp_recipient_accounts SET encrypted_destination=$1,version=version+1", [sealDestination("OTHERFIXTUREPAYER", f.session.tenantId, f.session.actorId)]);
    await assert.rejects(sendPayout(f.session, p.id, true, f.deps), { code: "PAYOUT_REVIEW_CHANGED" });
    const review = await f.select(["line-1", "line-2"], p.id);
    await assert.rejects(approvePayout(f.session, f.claim.id, { reviewId: review.id, reviewDigest: review.digest, intentId: randomUUID(), amountMinor: review.amountMinor, currency: "USD", recipientAndAmountChecked: true, feeAllowanceAcknowledged: true, sampleAcknowledged: true }), { code: "ORIGINAL_PAYOUT_CHANGED" });
    assert.equal(f.creates.length, 1);
  });
  it("recovering an expired dispatch lease performs no write until a deliberate identical retry", async () => {
    const f = await fixture(), p = await f.approve();
    await query("UPDATE fp_payables SET state='submitting',lease_id=$2,lease_until=now()-interval '1 minute',first_dispatched_at=now()-interval '4 minutes' WHERE id=$1", [p.id, randomUUID()]);
    const read = await checkPayout(f.session, p.id, f.deps); assert.equal(read.state, "unknown"); assert.equal(read.canRetryOriginal, true); assert.equal(f.creates.length, 0);
    await sendPayout(f.session, p.id, true, f.deps); assert.equal(f.creates.length, 1);
  });
  it("retains source reservations when a required item read is unavailable", async () => {
    const f = await fixture(), p = await f.approve(); f.status("SUCCESS"); f.readUnavailable();
    const sent = await sendPayout(f.session, p.id, false, f.deps); assert.notEqual(sent.state, "succeeded");
    const [reserved] = await query<{ amount: string }>("SELECT sum(amount_minor) AS amount FROM fp_receipt_allocations WHERE state='reserved'"); assert.equal(Number(reserved.amount), 5050);
    assert.equal((await query("SELECT id FROM fp_journal WHERE operation_id=$1", [p.id])).length, 0);
  });
  it("a new exclusion or changed source invalidates a queued repayment", async () => {
    const f = await fixture(), p = await f.approve();
    await query("UPDATE fp_settlement_receipts SET data=jsonb_set(data,'{excludedMinor}','1000'::jsonb) WHERE id=$1", [f.receipt.id]);
    await assert.rejects(sendPayout(f.session, p.id, false, f.deps), { code: "ROUND_FUNDING_CHANGED" });
    assert.equal(f.creates.length, 0);
    await query("UPDATE fp_documents SET version=version+1 WHERE id=$1", [f.document.id]);
    await assert.rejects(sendPayout(f.session, p.id, false, f.deps), { code: "CLAIM_SOURCE_CHANGED" });
  });
  it("explicit source review is required before correcting a foreign-currency proposal", async () => {
    const f = await fixture();
    await query("UPDATE fp_claims SET currency='EUR' WHERE id=$1", [f.claim.id]);
    const review = { expectedVersion: f.claim.version, sourceTotalMinor: 8640, currency: "USD" as const, note: "Fixture currency correction requires source review", sourceChecked: true as const, sampleAcknowledged: true, receiptSplit: false, duplicateResolutions: [],
      lines: f.claim.lines.map(line => ({ id: line.id, description: line.description, packageId: line.packageId, sourceMinor: line.reviewedSourceMinor!, approvedMinor: line.approvedMinor, receiptLineKey: line.receiptLineKey, decision: "approved" as const, reviewNote: "Fixture source amount and purpose checked", uncertaintyResolved: true })) };
    await assert.rejects(reviewClaim(f.session, f.claim.id, review), { code: "CLAIM_CURRENCY_REVIEW" });
    const corrected = await reviewClaim(f.session, f.claim.id, { ...review, currencyCorrectionNote: "Controlled source explicitly prints USD; the test changed only the draft currency." });
    assert.equal(corrected.currency, "USD"); assert.ok(corrected.review?.currencyCorrectionNote);
  });
});

describe("balance clocks, currency, recipient encryption and constrained output", () => {
  it("validates real SDK balance fields and zero available money without inventing freshness", () => {
    const stamp = new Date(Date.now() - 1000).toISOString();
    const zero = normalizeBalance({ accountId: "FIXMERCHANT01", asOfTime: stamp, lastRefreshTime: stamp, balances: [{ currency: "USD", totalBalance: { currencyCode: "USD", value: "20.00" }, availableBalance: { currencyCode: "USD", value: "0.00" }, withheldBalance: { currencyCode: "USD", value: "20.00" } }] }, new Date().toISOString());
    assert.equal(zero.availableMinor, 0); assertUsableBalance(zero);
    assert.throws(() => normalizeBalance({ balances: [] }, stamp));
    assert.throws(() => assertUsableBalance({ ...zero, lastRefreshTime: new Date(Date.now() - 4 * 60 * 60_000).toISOString() }), { code: "BALANCE_PROVIDER_STALE" });
    assert.throws(() => assertUsableBalance({ ...zero, asOfTime: new Date(Date.now() + 10000).toISOString() }), { code: "BALANCE_CLOCK_UNPROVEN" });
    assert.throws(() => assertUsableBalance({ ...zero, observedAt: new Date(Date.now() - 61000).toISOString() }), { code: "BALANCE_FETCH_EXPIRED" });
  });
  it("keeps integer fee allocation exact across changing package proportions", () => {
    for (let count = 1; count <= 12; count++) for (let total = 0; total <= 103; total++) {
      const amounts = Array.from({ length: count }, (_, index) => ({ packageId: String(index), amountMinor: 1 + (index * 17 + total * 13) % 2047 }));
      const result = splitFeeAllowance(amounts, total); assert.equal([...result.values()].reduce((sum, value) => sum + value, 0), total); assert.ok([...result.values()].every(Number.isSafeInteger));
    }
  });
  it("binds the recipient ciphertext to its owner and tenant", () => {
    const value = sealDestination("FIXTUREPAYER0001", "tenant-a", "actor-a"); assert.equal(openDestination(value, "tenant-a", "actor-a"), "FIXTUREPAYER0001");
    assert.throws(() => openDestination(value, "tenant-b", "actor-a")); assert.throws(() => openDestination(value, "tenant-a", "actor-b"));
  });
  it("removes costly provider grammar bounds while preserving independent strict validation", () => {
    const source = z.toJSONSchema(extractedReceiptSchema), reduced = geminiOutputShape(source);
    assert.ok(JSON.stringify(source).includes('"maxItems":120')); assert.ok(!JSON.stringify(reduced).includes('"maxItems"'));
    assert.ok(JSON.stringify(reduced).includes('"additionalProperties":false'));
    assert.equal(extractedReceiptSchema.safeParse({ executePayout: true }).success, false);
  });
});
