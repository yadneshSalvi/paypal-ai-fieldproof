import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PaymentCore, PostgresDatabase, ProviderError, canonicalJson, sha256, type CommerceRestResult, type DraftInvoice, type InvoiceObservation, type PaymentCommand, type ProviderAdapter, type ProviderReceipt, type ProviderResource } from "@fracture/paypal-core";
import type { Session } from "../lib/server/auth";
import { database, initializeDatabase, query } from "../lib/server/db";
import { beginWalletApproval, completeWalletApproval, createCommitment } from "../lib/server/commitments";
import { advanceCollection, collectionView, freezeCollection, processCollectionItem, type CollectionDependencies } from "../lib/server/collections";
import { authorizePayment, paymentStore } from "../lib/server/payments";
import { createProject, sampleReceipt } from "../lib/server/seed";
import type { VaultGateway } from "../lib/server/vault";
import { cancelRecoveryInvoice, checkRecoveryInvoice, createRecoveryInvoice, recoveryInvoiceView, shareRecoveryInvoice, type RecoveryDependencies } from "../lib/server/recovery-invoices";
import type { InvoiceCaptureResult } from "../lib/server/commerce";
import { expireCollectionRounds } from "../lib/server/collection-projection";
import { cancelUnspentCollection, processCompensation } from "../lib/server/compensation";
import { checkRefund, compensateReceipt, ingestRefundOperation, readRefundBudget, requestRefund, type RefundDependencies } from "../lib/server/refunds";
import type { SettlementReceipt } from "../lib/contracts";
import { refundParentMatches } from "../lib/domain/refunds";
import { receivePayPalWebhook } from "../lib/server/webhooks";
import { processVerifiedWebhooks } from "../lib/server/webhook-worker";
import { readCancellationReview } from "../lib/server/cancellation-review";

const schema = `fp_collection_test_${randomUUID().replaceAll("-", "")}`;
const originalUrl = process.env.DATABASE_URL!;
const originalMerchant = process.env.PAYPAL_SANDBOX_SELLER_EMAIL;
const admin = new PostgresDatabase(originalUrl);
before(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(originalUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.href;
  process.env.PAYPAL_SANDBOX_SELLER_EMAIL = "fixture-merchant@example.test";
  await initializeDatabase();
});
afterEach(async () => {
  const tables = await query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname=$1", [schema]);
  if (tables.length) await database().query(`TRUNCATE ${tables.map(row => `"${schema}"."${row.tablename}"`).join(",")} RESTART IDENTITY CASCADE`);
});
after(async () => {
  await database().close();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.close();
  process.env.DATABASE_URL = originalUrl;
  if (originalMerchant === undefined) delete process.env.PAYPAL_SANDBOX_SELLER_EMAIL;
  else process.env.PAYPAL_SANDBOX_SELLER_EMAIL = originalMerchant;
});
const result = <T>(value: T) => ({ outcome: "succeeded" as const, value, httpStatus: 200, bodyHash: "fixture-observation", debugId: null });
const vault: VaultGateway = {
  async createSetup() { return result({ id: "FIXTURESETUP001", status: "APPROVED", customer: { id: "FIXTURECUSTOMER001" } }); },
  async readSetup() { return result({ id: "FIXTURESETUP001", status: "APPROVED", customer: { id: "FIXTURECUSTOMER001" } }); },
  async exchangeSetup() { return result({ id: "FIXTURETOKEN001", customer: { id: "FIXTURECUSTOMER001" }, paymentSource: { paypal: { usageType: "MERCHANT", payerId: "FIXTUREPAYER001", emailAddress: "fixture-buyer@example.test" } } }); },
  async readToken() { return result({ id: "FIXTURETOKEN001", customer: { id: "FIXTURECUSTOMER001" }, paymentSource: { paypal: { usageType: "MERCHANT", payerId: "FIXTUREPAYER001", emailAddress: "fixture-buyer@example.test" } } }); },
  async deleteToken() { return result(undefined); },
};
async function fixture(count = 8) {
  const session: Session = { id: randomUUID(), tenantId: randomUUID(), projectId: randomUUID(), actorId: randomUUID(), role: "donor", expiresAt: new Date(Date.now() + 600000).toISOString(), mode: "live_sandbox" };
  await database().transaction(async tx => {
    await createProject(tx, session.tenantId, session.projectId, `collection-fixture-${randomUUID()}`, "live_sandbox");
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'donor',$6)", [session.id, randomUUID(), session.tenantId, session.projectId, session.actorId, session.expiresAt]);
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,$4::jsonb)", [session.tenantId, session.projectId, session.actorId, JSON.stringify(["donor", "volunteer", "organizer", "auditor"])]);
  });
  const consents = [];
  for (let slotIndex = 0; slotIndex < count; slotIndex++) {
    const consent = await createCommitment(session, { slotIndex, expectedVersion: 1, intentId: randomUUID(), accepted: true, policyVersion: 1 });
    await beginWalletApproval(session, consent.id, vault);
    await completeWalletApproval(session, consent.id, vault);
    consents.push(consent);
  }
  await query("UPDATE fp_sessions SET role='organizer' WHERE id=$1", [session.id]);
  session.role = "organizer";
  return { session, consents, intentId: randomUUID() };
}
type Behavior = "complete" | "decline" | "unknown" | "invalid" | "approved" | "completed-on-read";
function providerFixture(behavior: (command: PaymentCommand) => Behavior = () => "complete") {
  const calls: PaymentCommand[] = [], orders = new Map<string, PaymentCommand>();
  const resource = (command: PaymentCommand, kind: ProviderResource["kind"], status: string, orderId: string): ProviderResource => ({ kind, id: kind === "order" ? orderId : `FIXCAP${command.operationId.replaceAll("-", "").slice(0, 18)}`, status, money: kind === "order" ? null : command.action.money, parentId: kind === "order" ? null : orderId, customId: kind === "order" ? null : command.intentId, source: "live_sandbox", observedAt: new Date().toISOString(), links: [] });
  const receipt = (command: PaymentCommand, resources: ProviderResource[]): ProviderReceipt => ({ id: randomUUID(), operationId: command.operationId, providerRequestId: command.providerRequestId, source: "live_sandbox", transport: "local_fixture", status: 201, observedAt: new Date().toISOString(), resources, debugId: null, bodyHash: sha256(canonicalJson(resources)), reconciled: false });
  const provider: ProviderAdapter = {
    source: "live_sandbox",
    async execute(command) {
      calls.push(command);
      const mode = behavior(command);
      if (mode === "decline") throw new ProviderError("api", "INSTRUMENT_DECLINED: Choose another payment method.", "rejected", 422);
      if (mode === "unknown") throw new ProviderError("timeout", "Fixture response lost; outcome unknown.", "unknown", 502);
      if (mode === "invalid") throw new ProviderError("api", "INVALID_REQUEST: Review the request format and required fields.", "rejected", 400);
      const orderId = command.action.kind === "capture_order" ? command.action.orderId : `FIXORDER${command.operationId.replaceAll("-", "").slice(0, 16)}`;
      if (command.action.kind === "create_order") orders.set(orderId, command);
      const needsCapture = command.action.kind === "create_order" && ["approved", "completed-on-read"].includes(mode);
      return receipt(command, [resource(command, "order", needsCapture ? "APPROVED" : "COMPLETED", orderId), ...needsCapture ? [] : [resource(command, "capture", "COMPLETED", orderId)]]);
    },
    async read(kind, id) {
      assert.equal(kind, "order");
      const command = orders.get(id);
      assert.ok(command);
      return behavior(command) === "completed-on-read" ? [resource(command, "order", "COMPLETED", id), resource(command, "capture", "COMPLETED", id)] : [resource(command, "order", "APPROVED", id)];
    },
    async reconcile() { return null; },
  };
  const core = new PaymentCore({ store: paymentStore(), provider, policy: { authorize: authorizePayment } });
  return { calls, provider, core, deps: { vault, provider, core } satisfies CollectionDependencies };
}

describe("read-only cancellation review", () => {
  it("shows paid uses before cancellation and preserves the financial records", async () => {
    const f = await refundFixture();
    const first = await readCancellationReview(f.session, f.round.id);
    assert.equal(first.canCancelUnspent, true); assert.equal(first.uncommittedMinor, 20000);
    await query("INSERT INTO fp_receipt_allocations(id,tenant_id,project_id,receipt_id,claim_id,claim_line_id,package_id,amount_minor,state) VALUES($1,$2,$3,$4,$5,$6,'electronics',6625,'paid')", [randomUUID(),f.session.tenantId,f.session.projectId,f.receipt.id,randomUUID(),randomUUID()]);
    const before = await query("SELECT data,version FROM fp_settlement_receipts ORDER BY id");
    const result = await readCancellationReview(f.session,f.round.id);
    assert.equal(result.canCancelUnspent,false); assert.equal(result.limitation,"committed_uses");
    assert.equal(result.paidMinor,6625); assert.equal(result.uncommittedMinor,13375); assert.notEqual(result.digest,first.digest);
    assert.deepEqual(await query("SELECT data,version FROM fp_settlement_receipts ORDER BY id"),before);
    assert.equal(f.calls.length,0); assert.equal((await query("SELECT id FROM fp_refunds")).length,0);
  });
  it("allows the current Auditor to inspect the same exact records and denies donor or foreign-round access",async()=>{
    const f=await refundFixture();
    await query("UPDATE fp_sessions SET role='auditor' WHERE id=$1",[f.session.id]);
    const auditor={...f.session,role:'auditor' as const};
    assert.equal((await readCancellationReview(auditor,f.round.id)).creditedMinor,20000);
    await assert.rejects(()=>readCancellationReview({...auditor,role:'donor'},f.round.id),{code:'ROLE_DENIED'});
    await assert.rejects(()=>readCancellationReview(auditor,randomUUID()),{code:'ROUND_NOT_FOUND'});
    await query("UPDATE fp_memberships SET state='revoked' WHERE actor_id=$1",[f.session.actorId]);
    await assert.rejects(()=>readCancellationReview(auditor,f.round.id),{code:'MEMBERSHIP_DENIED'});
  });
  it("changes the saved review when a pending refund, package or session changes",async()=>{
    const f=await refundFixture('pending');
    await cancelUnspentCollection(f.session,{roundId:f.round.id,expectedVersion:1,acknowledged:true});
    await compensateReceipt(f.session,f.receipt.id,'package_cancelled',f.deps);
    const result=await readCancellationReview(f.session,f.round.id);
    assert.equal(result.pendingRefundMinor,20000); assert.equal(result.uncommittedMinor,0); assert.equal(result.limitation,'already_compensating');
    await query("UPDATE fp_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.session.id]);
    await assert.rejects(()=>readCancellationReview(f.session,f.round.id),{code:'ROLE_DENIED'});
  });
  it("reads canonical invoice settlement alongside Orders receipts without manufacturing a second credit",async()=>{
    const f=await recoveryFixture(),invoice=await f.create();
    await shareRecoveryInvoice(f.session,invoice.id,f.deps); f.pay(); await checkRecoveryInvoice(f.session,invoice.id,f.deps);
    const result=await readCancellationReview(f.session,f.round.id);
    assert.equal(result.creditedMinor,96000); assert.equal(result.sources.length,8);
    assert.equal(result.sources.filter(row=>row.sourceKind==='invoice_payment').length,1);
    assert.equal(result.canCancelUnspent,true); assert.equal(result.unqualifiedRouteCount,0);
  });
});

const commerceResult = <T>(value: T): CommerceRestResult<T> => ({ outcome: "succeeded", value, source: "live_sandbox", observedAt: new Date().toISOString(), httpStatus: 200, debugId: null, recovered: false });
async function recoveryFixture(mode: Behavior = "decline") {
  const f = await fixture(), p = providerFixture(command => command.action.money.minor === 3500 ? mode : "complete");
  const round = await freezeCollection(f.session, { expectedVersion: 1, intentId: f.intentId });
  for (const consent of f.consents) await processCollectionItem(round.id, consent.id, p.deps);
  const calls: string[] = [];
  let invoice: InvoiceObservation | null = null, loseCreate = false, raceCancellation = false, captureOverride: InvoiceCaptureResult | null = null;
  const pay = (type = "PAYPAL") => {
    assert.ok(invoice);
    invoice.status = "PAID"; invoice.due = { currency: "USD", minor: 0 };
    invoice.payments = [{ id: "FIXTUREINVOICECAPTURE", type, method: type === "PAYPAL" ? "PAYPAL" : "CASH", money: { currency: "USD", minor: 3500 }, date: new Date().toISOString() }];
  };
  const gateway: RecoveryDependencies["gateway"] = {
    async createInvoice(request: DraftInvoice) {
      calls.push("create");
      invoice = { id: "INV2-FIXTURE-RECOVERY", invoiceNumber: request.invoiceNumber, reference: request.reference, status: "DRAFT", invoiceDate: new Date().toISOString().slice(0, 10), money: request.money, due: request.money, recipientEmails: [request.recipientEmail], payerUrl: "https://www.sandbox.paypal.com/invoice/p/FIXTURE", payments: [], refunds: [] };
      return loseCreate ? { outcome: "unknown", code: "RESPONSE_UNCERTAIN", message: "Fixture lost response", originalPayoutBatchId: null, source: "live_sandbox", observedAt: new Date().toISOString(), httpStatus: null, debugId: null } : commerceResult(structuredClone(invoice));
    },
    async getInvoice(id) { calls.push("read"); assert.equal(id, invoice!.id); return commerceResult(structuredClone(invoice!)); },
    async findInvoices(match) { calls.push("search"); assert.equal(match.invoiceNumber, invoice!.invoiceNumber); assert.equal(match.reference, invoice!.reference); return commerceResult([structuredClone(invoice!)]); },
    async sendInvoice(owned) { calls.push("share"); assert.equal(owned.id, invoice!.id); invoice!.status = "UNPAID"; return commerceResult(structuredClone(invoice!)); },
    async cancelInvoice(owned) { calls.push("cancel"); assert.equal(owned.id, invoice!.id); if (raceCancellation) pay(); else invoice!.status = "CANCELLED"; return commerceResult(structuredClone(invoice!)); },
  };
  const deps: RecoveryDependencies = { gateway, payments: p.provider, vault, reader: { async readCapture(id) {
    calls.push("capture-read");
    return captureOverride ?? { outcome: "succeeded", value: { id, status: "COMPLETED", money: { currency: "USD", minor: 3500 }, invoiceId: invoice!.invoiceNumber, orderId: null, merchantEmail: "fixture-merchant@example.test", observedAt: new Date().toISOString(), bodyHash: "fixture-capture-body", source: "live_sandbox" } };
  } } };
  const create = () => createRecoveryInvoice(f.session, { consentId: f.consents[7].id, expectedVersion: 1, acknowledged: true }, deps);
  return { ...f, round, calls, deps, create, pay, current: () => invoice!, loseCreate: () => { loseCreate = true; }, raceCancellation: () => { raceCancellation = true; }, capture: (value: InvoiceCaptureResult) => { captureOverride = value; } };
}

async function refundFixture(mode: "complete" | "pending" | "lost" | "refused" = "complete") {
  const f = await fixture(), p = providerFixture();
  const round = await freezeCollection(f.session, { expectedVersion: 1, intentId: f.intentId });
  await processCollectionItem(round.id, f.consents[0].id, p.deps);
  const [stored] = await query<{ data: SettlementReceipt }>("SELECT data FROM fp_settlement_receipts");
  const receipt = stored.data, calls: PaymentCommand[] = [], effects = new Map<string, ProviderResource>();
  let recover = false, badParent = false, externalConsumed = 0;
  const base = (kind: ProviderResource["kind"], id: string, status: string): ProviderResource => ({ kind, id, status, money: kind === "order" ? null : { currency: "USD", minor: receipt.grossSettledMinor }, customId: null, parentId: null, source: "live_sandbox", observedAt: new Date().toISOString(), links: [] });
  const result = (command: PaymentCommand, resource: ProviderResource): ProviderReceipt => ({ id: randomUUID(), operationId: command.operationId, providerRequestId: command.providerRequestId, source: "live_sandbox", transport: "local_fixture", status: 201, debugId: null, observedAt: new Date().toISOString(), resources: [resource], bodyHash: sha256(canonicalJson(resource)), reconciled: false });
  const provider: ProviderAdapter = {
    source: "live_sandbox",
    async execute(command) {
      assert.equal(command.action.kind, "refund_capture"); calls.push(command);
      if (mode === "refused") throw new ProviderError("api", "REFUND_NOT_ALLOWED: Fixture refusal", "rejected", 422);
      const resource = { ...base("refund", `FIXREF${command.operationId.replaceAll("-", "").slice(0, 18)}`, mode === "pending" ? "PENDING" : "COMPLETED"), money: command.action.money, customId: command.operationId,
        links: [{ rel: "up", method: "GET", href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${badParent ? "OTHER_CAPTURE" : receipt.provenRefundableRef}` }] };
      effects.set(command.operationId, resource);
      if (mode === "lost") throw new ProviderError("timeout", "Fixture provider response lost.", "unknown", 502);
      return result(command, resource);
    },
    async read(kind, id) {
      if (kind === "capture") {
        assert.equal(id, receipt.provenRefundableRef);
        const consumed = externalConsumed + [...effects.values()].filter(effect => effect.status === "COMPLETED").reduce((sum, effect) => sum + effect.money!.minor, 0);
        return [{ ...base("capture", id, consumed >= receipt.grossSettledMinor ? "REFUNDED" : consumed > 0 ? "PARTIALLY_REFUNDED" : "COMPLETED"), links: [{ rel: "up", method: "GET", href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${receipt.sourceOrderId}` }] }];
      }
      if (kind === "order") {
        assert.equal(id, receipt.sourceOrderId);
        return [base("order", id, "COMPLETED"), ...(await provider.read("capture", receipt.provenRefundableRef!)), ...effects.values(), ...(externalConsumed ? [{ ...base("refund", "FIXEXTERNALREFUND", "COMPLETED"), money: { currency: "USD", minor: externalConsumed }, links: [{ rel: "up", method: "GET", href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${receipt.provenRefundableRef}` }] }] : [])];
      }
      assert.equal(kind, "refund");
      if (id === "FIXEXTERNALREFUND") return [{ ...base("refund", id, "COMPLETED"), money: { currency: "USD", minor: externalConsumed }, links: [{ rel: "up", method: "GET", href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${receipt.provenRefundableRef}` }] }];
      const current = [...effects.values()].find(effect => effect.id === id); assert.ok(current); return [current];
    },
    async reconcile(operation) {
      const effect = effects.get(operation.command.operationId);
      if (!effect || !recover) return null;
      effect.status = "COMPLETED";
      return { ...result(operation.command, effect), reconciled: true };
    },
  };
  const core = new PaymentCore({ store: paymentStore(), provider, policy: { authorize: authorizePayment } });
  const deps = { provider, core } satisfies RefundDependencies;
  return { ...f, round, receipt, calls, deps, effects, recover: () => { recover = true; }, badParent: () => { badParent = true; }, external: (minor: number) => { externalConsumed = minor; } };
}

describe("frozen conditional collection — isolated PostgreSQL schema and fixture provider", () => {
  it("does not start the collection clock when an exact contribution is missing", async () => {
    const f = await fixture(7);
    await assert.rejects(() => freezeCollection(f.session, { expectedVersion: 1, intentId: f.intentId }), /total exactly/);
    assert.equal((await query("SELECT id FROM fp_collection_rounds")).length, 0);
    assert.equal((await query("SELECT operation_id FROM fp_payment_commands")).length, 0);
  });
  it("concurrent freeze requests persist one exact set and one unextendable 48-hour window", async () => {
    const f = await fixture();
    const rounds = await Promise.all(Array.from({ length: 5 }, () => freezeCollection(f.session, { expectedVersion: 1, intentId: f.intentId })));
    assert.equal(new Set(rounds.map(round => round.id)).size, 1);
    assert.equal(Date.parse(rounds[0].recoveryEndsAt) - Date.parse(rounds[0].startedAt), 48 * 60 * 60 * 1000);
    assert.equal((await query("SELECT consent_id FROM fp_collection_items")).length, 8);
    assert.equal((await query("SELECT id FROM fp_outbox WHERE kind='collection.collect'")).length, 8);
    await assert.rejects(() => freezeCollection(f.session, { expectedVersion: 1, intentId: randomUUID() }), /already recorded/);
    assert.equal((await collectionView(f.session))!.recoveryEndsAt, rounds[0].recoveryEndsAt);
  });
  it("concurrent processing creates one actual command and receipt, with wallet secrets encrypted in both stores", async () => {
    const f = await fixture(), p = providerFixture();
    const round = await freezeCollection(f.session, { expectedVersion: 1, intentId: f.intentId });
    await Promise.all(Array.from({ length: 5 }, () => processCollectionItem(round.id, f.consents[0].id, p.deps)));
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].action.kind, "create_order");
    const view = (await collectionView(f.session))!;
    assert.equal(view.collectedMinor, 20000);
    assert.equal(view.items[0].state, "collected");
    assert.equal((await query("SELECT id FROM fp_settlement_receipts")).length, 1);
    const [domain] = await query<{ command: PaymentCommand }>("SELECT command FROM fp_payment_commands");
    const [core] = await query<{ document: string }>("SELECT document FROM paycore_operations");
    assert.ok(!JSON.stringify(domain.command).includes("FIXTURETOKEN001"));
    assert.ok(!core.document.includes("FIXTURETOKEN001"));
    assert.equal(JSON.parse(core.document).paycoreEncoding, "operation-v1");
    assert.equal((await paymentStore().get(p.calls[0].scope, p.calls[0].operationId))?.status, "succeeded");
    const [journal] = await query<{ net: string; count: string }>("SELECT sum(CASE WHEN side='debit' THEN amount_minor ELSE -amount_minor END) net,count(*) count FROM fp_journal");
    assert.equal(Number(journal.net), 0);
    assert.equal(Number(journal.count), 2);
  });
  it("holds an unknown original channel without retrying or opening recovery", async () => {
    const f = await fixture(), p = providerFixture(() => "unknown");
    const round = await freezeCollection(f.session, { expectedVersion: 1, intentId: f.intentId });
    await processCollectionItem(round.id, f.consents[0].id, p.deps);
    await processCollectionItem(round.id, f.consents[0].id, p.deps);
    const view = (await collectionView(f.session))!;
    assert.equal(p.calls.length, 1);
    assert.equal(view.items[0].channel, "unknown_reconciling");
    assert.equal(view.collectedMinor, 0);
    assert.equal(view.state, "collecting");
  });
  it("does not mislabel a request-format refusal as a native payment decline", async () => {
    const f = await fixture(), p = providerFixture(() => "invalid");
    const round = await freezeCollection(f.session, { expectedVersion: 1, intentId: f.intentId });
    await processCollectionItem(round.id, f.consents[0].id, p.deps);
    const view = (await collectionView(f.session))!;
    assert.equal(view.items[0].state, "review_required");
    assert.notEqual(view.items[0].channel, "definitively_declined");
    assert.equal(view.collectedMinor, 0);
  });
  it("keeps seven $925 fixture settlements and a definitive $35 decline on their original obligations", async () => {
    const f = await fixture(), p = providerFixture(command => command.action.money.minor === 3500 ? "decline" : "complete");
    const round = await freezeCollection(f.session, { expectedVersion: 1, intentId: f.intentId });
    for (const consent of f.consents) await processCollectionItem(round.id, consent.id, p.deps);
    const before = (await collectionView(f.session))!;
    assert.equal(before.state, "recovering");
    assert.equal(before.collectedMinor, 92500);
    assert.equal(before.shortfallMinor, 3500);
    assert.equal(before.items[7].obligationId, f.consents[7].obligationId);
    assert.equal(before.items[7].channel, "definitively_declined");
    const unrelated = `${f.session.tenantId}:unrelated-fixture`;
    await query("INSERT INTO fp_obligations(id,tenant_id,project_id,package_id,actor_id,amount_minor,channel,purpose,data) VALUES($1,$2,$3,'electronics',$4,100,'collected','sandbox_test','{}')", [unrelated, f.session.tenantId, f.session.projectId, f.session.actorId]);
    const receipt = { ...sampleReceipt(f.session.tenantId, f.session.projectId, unrelated, "electronics", 100, "unrelated"), provenance: "live_sandbox" };
    await query("INSERT INTO fp_settlement_receipts(id,tenant_id,project_id,obligation_id,package_id,provider_ref,provenance,data) VALUES($1,$2,$3,$4,'electronics',$5,'live_sandbox',$6::jsonb)", [receipt.id, f.session.tenantId, f.session.projectId, unrelated, receipt.actualProviderPaymentRef, JSON.stringify(receipt)]);
    assert.equal((await collectionView(f.session))!.collectedMinor, 92500);
    assert.equal(p.calls.length, 8);
  });
  it("uses an already completed fresh order read without a second capture", async () => {
    const f = await fixture(), p = providerFixture(() => "completed-on-read");
    const round = await freezeCollection(f.session, { expectedVersion: 1, intentId: f.intentId });
    await processCollectionItem(round.id, f.consents[0].id, p.deps);
    assert.deepEqual(p.calls.map(command => command.action.kind), ["create_order"]);
    assert.equal((await collectionView(f.session))!.collectedMinor, 20000);
  });
  it("captures only the exact owned approved order when a continuation is required", async () => {
    const f = await fixture(), p = providerFixture(() => "approved");
    const round = await freezeCollection(f.session, { expectedVersion: 1, intentId: f.intentId });
    await processCollectionItem(round.id, f.consents[0].id, p.deps);
    assert.deepEqual(p.calls.map(command => command.action.kind), ["create_order", "capture_order"]);
    assert.equal(new Set(p.calls.map(command => command.intentId)).size, 1);
    const [order] = await query<{ order_id: string }>("SELECT order_id FROM fp_provider_orders");
    assert.equal(p.calls[1].action.kind === "capture_order" && p.calls[1].action.orderId, order.order_id);
    assert.equal((await collectionView(f.session))!.collectedMinor, 20000);
  });
  it("rechecks membership after command claim and blocks dispatch after revocation", async () => {
    const f = await fixture(), p = providerFixture();
    const round = await freezeCollection(f.session, { expectedVersion: 1, intentId: f.intentId });
    let checks = 0;
    const core = new PaymentCore({ store: paymentStore(), provider: p.provider, policy: { async authorize(command) {
      const result = await authorizePayment(command);
      if (++checks === 1) await query("UPDATE fp_memberships SET state='revoked',version=version+1 WHERE project_id=$1", [f.session.projectId]);
      return result;
    } } });
    await processCollectionItem(round.id, f.consents[0].id, { ...p.deps, core });
    assert.equal(p.calls.length, 0);
    const [operation] = await query<{ status: string }>("SELECT status FROM paycore_operations");
    assert.equal(operation.status, "not_sent");
    await assert.rejects(() => advanceCollection(f.session, round.id), /membership/);
  });
  it("enforces the explicit global $960 original-collection allowance", async () => {
    const f = await fixture(), p = providerFixture();
    const round = await freezeCollection(f.session, { expectedVersion: 1, intentId: f.intentId });
    for (const consent of f.consents) await processCollectionItem(round.id, consent.id, p.deps);
    assert.equal((await collectionView(f.session))!.state, "funded");
    const next = await fixture(), nextRound = await freezeCollection(next.session, { expectedVersion: 1, intentId: next.intentId });
    await assert.rejects(() => processCollectionItem(nextRound.id, next.consents[0].id, p.deps), /allowance has already been claimed/);
    assert.equal(p.calls.length, 8);
  });
});

describe("same-obligation recovery invoice — fixture transport, no live requests", () => {
  it("refuses recovery while the original payment is unknown", async () => {
    const f = await recoveryFixture("unknown");
    await assert.rejects(f.create, /original payment outcome/);
    assert.equal(f.calls.length, 0);
    assert.equal((await query("SELECT id FROM fp_recovery_invoices")).length, 0);
  });
  it("claims one immutable invoice for concurrent requests and keeps recipients encrypted", async () => {
    const f = await recoveryFixture();
    const invoices = await Promise.all(Array.from({ length: 5 }, f.create));
    assert.equal(new Set(invoices.map(invoice => invoice.id)).size, 1);
    assert.equal(f.calls.filter(call => call === "create").length, 1);
    assert.equal(invoices[0].obligationId, f.consents[7].obligationId);
    assert.equal(invoices[0].amountMinor, 3500);
    assert.equal((await collectionView(f.session))!.collectedMinor, 92500);
    const [row] = await query<{ encrypted_data: string; invoice_number: string; reference: string }>("SELECT encrypted_data,invoice_number,reference FROM fp_recovery_invoices");
    assert.ok(row.encrypted_data.startsWith("v1."));
    assert.ok(!row.encrypted_data.includes("fixture-buyer@example.test"));
    assert.ok(row.invoice_number.length <= 25 && row.reference.length <= 120);
    assert.ok(!JSON.stringify(invoices).includes("fixture-buyer@example.test"));
  });
  it("finds the original invoice after an unknown create without creating another one", async () => {
    const f = await recoveryFixture(); f.loseCreate();
    const first = await f.create();
    assert.equal(first.state, "review_required");
    const recovered = await checkRecoveryInvoice(f.session, first.id, f.deps);
    assert.equal(recovered.state, "draft");
    await f.create();
    const shared = await shareRecoveryInvoice(f.session, first.id, f.deps);
    assert.equal(shared.state, "open");
    assert.equal(shared.collectedMinor, 0);
    assert.ok(shared.payerUrl?.startsWith("https://www.sandbox.paypal.com/"));
    await shareRecoveryInvoice(f.session, first.id, f.deps);
    assert.equal(f.calls.filter(call => call === "create").length, 1);
    assert.equal(f.calls.filter(call => call === "share").length, 1);
    assert.equal((await collectionView(f.session))!.collectedMinor, 92500);
  });
  it("does not count a paid invoice label or an external recorded payment", async () => {
    for (const mode of ["label", "external"] as const) {
      const f = await recoveryFixture();
      const invoice = await f.create();
      await shareRecoveryInvoice(f.session, invoice.id, f.deps);
      if (mode === "label") f.current().status = "PAID";
      else f.pay("EXTERNAL");
      const checked = await checkRecoveryInvoice(f.session, invoice.id, f.deps);
      assert.equal(checked.paymentEvidencePending, true);
      assert.equal(checked.collectedMinor, 0);
      assert.equal(f.calls.filter(call => call === "capture-read").length, 0);
      assert.equal((await collectionView(f.session))!.collectedMinor, 92500);
      // Each scenario uses its own allowance, preserving the fixed global cap in this isolated schema.
      const tables = await query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname=$1", [schema]);
      await database().query(`TRUNCATE ${tables.map(row => `"${schema}"."${row.tablename}"`).join(",")} RESTART IDENTITY CASCADE`);
    }
  });
  it("joins a corroborated invoice payment once to reach $960 with balanced all-rail accounting", async () => {
    const f = await recoveryFixture(), invoice = await f.create();
    await shareRecoveryInvoice(f.session, invoice.id, f.deps);
    f.pay();
    await Promise.all(Array.from({ length: 5 }, () => checkRecoveryInvoice(f.session, invoice.id, f.deps)));
    const view = (await collectionView(f.session))!;
    assert.equal(view.state, "funded");
    assert.equal(view.collectedMinor, 96000);
    assert.equal(view.shortfallMinor, 0);
    assert.equal(view.items[7].obligationId, f.consents[7].obligationId);
    assert.equal((await query("SELECT id FROM fp_settlement_receipts")).length, 8);
    const [receipt] = await query<{ data: { sourceKind: string; economicAliases: string[] } }>("SELECT data FROM fp_settlement_receipts WHERE obligation_id=$1", [f.consents[7].obligationId]);
    assert.equal(receipt.data.sourceKind, "invoice_payment");
    assert.equal(receipt.data.economicAliases.length, 2);
    const [journal] = await query<{ net: string; count: string }>("SELECT sum(CASE WHEN side='debit' THEN amount_minor ELSE -amount_minor END) net,count(*) count FROM fp_journal");
    assert.equal(Number(journal.net), 0); assert.equal(Number(journal.count), 16);
  });
  it("holds unproved capture identity, amount, invoice, merchant, or settlement state", async () => {
    const f = await recoveryFixture(), invoice = await f.create();
    await shareRecoveryInvoice(f.session, invoice.id, f.deps); f.pay();
    const base = { id: "FIXTUREINVOICECAPTURE", status: "COMPLETED", money: { currency: "USD", minor: 3500 }, invoiceId: f.current().invoiceNumber, orderId: null, merchantEmail: "fixture-merchant@example.test", observedAt: new Date().toISOString(), bodyHash: "fixture-body", source: "live_sandbox" as const };
    for (const changed of [{ id: "OTHERPAYMENT" }, { status: "PENDING" }, { money: { currency: "USD", minor: 3501 } }, { invoiceId: "OTHERINVOICE" }, { merchantEmail: "other@example.test" }]) {
      f.capture({ outcome: "succeeded", value: { ...base, ...changed } });
      assert.equal((await checkRecoveryInvoice(f.session, invoice.id, f.deps)).collectedMinor, 0);
    }
    assert.equal((await collectionView(f.session))!.collectedMinor, 92500);
  });
  it("reconciles a payment racing cancellation without claiming a cancellation or refund", async () => {
    const f = await recoveryFixture(), invoice = await f.create();
    await shareRecoveryInvoice(f.session, invoice.id, f.deps); f.raceCancellation();
    const result = await cancelRecoveryInvoice(f.session, invoice.id, f.deps);
    assert.equal(result.state, "paid");
    assert.equal(result.collectedMinor, 3500);
    assert.equal((await collectionView(f.session))!.collectedMinor, 96000);
    await assert.rejects(() => cancelRecoveryInvoice(f.session, invoice.id, f.deps), /refund reconciliation/);
    assert.equal(f.calls.filter(call => call === "cancel").length, 1);
  });
  it("enforces the original deadline and holds late money for compensation", async () => {
    const f = await recoveryFixture(), invoice = await f.create();
    await shareRecoveryInvoice(f.session, invoice.id, f.deps);
    await query("UPDATE fp_collection_rounds SET collection_started_at=now()-interval '48 hours 1 minute',recovery_ends_at=now()-interval '1 minute' WHERE id=$1", [f.round.id]);
    await expireCollectionRounds();
    await assert.rejects(() => shareRecoveryInvoice(f.session, invoice.id, f.deps), /original collection deadline/);
    f.pay(); await checkRecoveryInvoice(f.session, invoice.id, f.deps);
    const view = (await collectionView(f.session))!;
    assert.equal(view.state, "compensating");
    assert.equal(view.collectedMinor, 96000);
    assert.equal(view.eligibleMinor, 0);
    assert.equal((await recoveryInvoiceView(f.session, invoice.id)).payerUrl, null);
  });
  it("does not expose another project's private recovery invoice", async () => {
    const f = await recoveryFixture(), invoice = await f.create();
    await assert.rejects(() => recoveryInvoiceView({ ...f.session, projectId: randomUUID() }, invoice.id), /outside this project/);
    await assert.rejects(() => recoveryInvoiceView({ ...f.session, actorId: randomUUID(), role: "donor" }, invoice.id), /membership/);
  });
});

describe("original-route refunds and incomplete-round compensation — isolated fixture provider", () => {
  it("requires a deliberate cancellation review before refunding an active conditional package", async () => {
    const f = await refundFixture();
    await assert.rejects(() => requestRefund(f.session, { receiptId: f.receipt.id, intentId: randomUUID(), amountMinor: 5000, acknowledged: true }, f.deps), /cancellation/);
    assert.equal(f.calls.length, 0);
    assert.equal((await query("SELECT id FROM fp_refunds")).length, 0);
  });
  it("closes new collection immediately and completes one exact original-rail refund under concurrent delivery", async () => {
    const f = await refundFixture();
    const view = await cancelUnspentCollection(f.session, { roundId: f.round.id, expectedVersion: 1, acknowledged: true });
    assert.equal(view.state, "compensating"); assert.equal(view.collectedMinor, 20000); assert.equal(view.eligibleMinor, 0);
    const refunds = await Promise.all(Array.from({ length: 5 }, () => compensateReceipt(f.session, f.receipt.id, "package_cancelled", f.deps)));
    assert.equal(new Set(refunds.map(row => row!.id)).size, 1);
    assert.equal(f.calls.length, 1); assert.equal(refunds.at(-1)!.amountMinor, 20000);
    const [receipt] = await query<{ data: SettlementReceipt }>("SELECT data FROM fp_settlement_receipts WHERE id=$1", [f.receipt.id]);
    assert.equal(receipt.data.completedAttributedRefundMinor, 20000); assert.equal(receipt.data.pendingAttributedRefundReserveMinor, 0);
    const [journal] = await query<{ net: string; count: string }>("SELECT sum(CASE WHEN side='debit' THEN amount_minor ELSE -amount_minor END) net,count(*) count FROM fp_journal");
    assert.equal(Number(journal.net), 0); assert.equal(Number(journal.count), 4);
    const result = await processCompensation(f.session, f.round.id, f.deps);
    assert.equal(result.completed, true);
    assert.equal((await collectionView(f.session))!.state, "cancelled");
    assert.equal((await query<{ status: string }>("SELECT status FROM fp_conditional_consents WHERE id=$1", [f.consents[0].id]))[0].status, "refunded");
  });
  it("reserves pending refund credit without reducing collected money until the exact refund completes", async () => {
    const f = await refundFixture("pending");
    await cancelUnspentCollection(f.session, { roundId: f.round.id, expectedVersion: 1, acknowledged: true });
    const first = (await compensateReceipt(f.session, f.receipt.id, "package_cancelled", f.deps))!;
    assert.equal(first.state, "pending_reconciliation");
    let view = (await collectionView(f.session))!;
    assert.equal(view.collectedMinor, 20000); assert.equal(view.eligibleMinor, 0);
    await assert.rejects(() => checkRefund(f.session, first.id, true, f.deps), /must not be sent again/);
    assert.equal(f.calls.length, 1);
    f.recover();
    const final = await checkRefund(f.session, first.id, false, f.deps);
    assert.equal(final.state, "completed"); assert.equal(f.calls.length, 1);
    view = (await collectionView(f.session))!; assert.equal(view.collectedMinor, 0);
  });
  it("recovers a lost response with the same refund identity and no second provider mutation", async () => {
    const f = await refundFixture("lost");
    await cancelUnspentCollection(f.session, { roundId: f.round.id, expectedVersion: 1, acknowledged: true });
    const first = (await compensateReceipt(f.session, f.receipt.id, "package_cancelled", f.deps))!;
    assert.equal(first.state, "pending_reconciliation");
    await checkRefund(f.session, first.id, false, f.deps); assert.equal(f.calls.length, 1);
    f.recover();
    const completed = await checkRefund(f.session, first.id, false, f.deps);
    assert.equal(completed.state, "completed"); assert.equal(completed.id, first.id); assert.equal(f.calls.length, 1);
    const operation = await paymentStore().get(f.calls[0].scope, f.calls[0].operationId); assert.ok(operation);
    await ingestRefundOperation(operation);
    assert.equal((await query("SELECT id FROM fp_journal WHERE entry_kind='refund'")).length, 2);
  });
  it("keeps a refused refund reserved and does not advertise compensation as complete", async () => {
    const f = await refundFixture("refused");
    await cancelUnspentCollection(f.session, { roundId: f.round.id, expectedVersion: 1, acknowledged: true });
    const first = (await compensateReceipt(f.session, f.receipt.id, "package_cancelled", f.deps))!;
    assert.equal(first.state, "refused"); assert.equal(first.canRetry, true);
    const result = await processCompensation(f.session, f.round.id, f.deps);
    assert.equal(result.completed, false); assert.equal(f.calls.length, 1);
    const [receipt] = await query<{ data: SettlementReceipt }>("SELECT data FROM fp_settlement_receipts WHERE id=$1", [f.receipt.id]);
    assert.equal(receipt.data.pendingAttributedRefundReserveMinor, 20000);
    assert.equal(receipt.data.completedAttributedRefundMinor, 0);
  });
  it("requires exact capture lineage before recognizing a provider refund result", async () => {
    const f = await refundFixture(); f.badParent();
    await cancelUnspentCollection(f.session, { roundId: f.round.id, expectedVersion: 1, acknowledged: true });
    const result = (await compensateReceipt(f.session, f.receipt.id, "package_cancelled", f.deps))!;
    assert.equal(result.state, "pending_reconciliation"); assert.equal(result.lastCode, "REFUND_IDENTITY_UNPROVEN");
    assert.equal((await collectionView(f.session))!.collectedMinor, 20000);
    assert.equal((await query("SELECT id FROM fp_journal WHERE entry_kind='refund'")).length, 0);
  });
  it("subtracts independently observed external refunds before any further provider reservation", async () => {
    const f = await refundFixture(); f.external(5000);
    const budget = await readRefundBudget(f.receipt, f.deps.provider);
    assert.equal(budget.externallyConsumedMinor, 5000);
    assert.deepEqual(budget.observedProviderIds, ["FIXEXTERNALREFUND"]);
    await cancelUnspentCollection(f.session, { roundId: f.round.id, expectedVersion: 1, acknowledged: true });
    await assert.rejects(() => compensateReceipt(f.session, f.receipt.id, "package_cancelled", f.deps), /already spent, reserved, refunded/);
    assert.equal(f.calls.length, 0);
  });
  it("refuses cancellation of already allocated or committed funds", async () => {
    const f = await refundFixture();
    await query("INSERT INTO fp_receipt_allocations(id,tenant_id,project_id,receipt_id,claim_id,claim_line_id,package_id,amount_minor) VALUES($1,$2,$3,$4,$5,$6,'electronics',5000)", [randomUUID(), f.session.tenantId, f.session.projectId, f.receipt.id, randomUUID(), randomUUID()]);
    await assert.rejects(() => cancelUnspentCollection(f.session, { roundId: f.round.id, expectedVersion: 1, acknowledged: true }), /reviewed or paid expenses/);
    assert.equal((await collectionView(f.session))!.state, "collecting"); assert.equal(f.calls.length, 0);
  });
  it("denies another actor, project, or current Auditor a financial refund", async () => {
    const f = await refundFixture();
    await cancelUnspentCollection(f.session, { roundId: f.round.id, expectedVersion: 1, acknowledged: true });
    const request = { receiptId: f.receipt.id, intentId: randomUUID(), amountMinor: 1000, acknowledged: true as const };
    await assert.rejects(() => requestRefund({ ...f.session, projectId: randomUUID() }, request, f.deps), /outside this project/);
    await assert.rejects(() => requestRefund({ ...f.session, actorId: randomUUID(), role: "donor" }, request, f.deps), { code: "ROLE_DENIED" });
    await assert.rejects(() => requestRefund({ ...f.session, role: "auditor" }, request, f.deps), /donor or organizer/);
    assert.equal(f.calls.length, 0);
  });
  it("does not infer capture ownership from arbitrary provider links", () => {
    const resource: ProviderResource = { kind: "refund", id: "FIXREFUND", status: "COMPLETED", money: { currency: "USD", minor: 100 }, parentId: null, customId: null, source: "live_sandbox", observedAt: new Date().toISOString(), links: [{ rel: "up", method: "GET", href: "https://example.test/v2/payments/captures/CAPTURE123" }] };
    assert.equal(refundParentMatches(resource, "CAPTURE123"), false);
    resource.links[0].href = "https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE123";
    assert.equal(refundParentMatches(resource, "CAPTURE123"), true);
    resource.links.push({ rel: "up", method: "GET", href: "https://api-m.sandbox.paypal.com/v2/payments/captures/OTHER123" });
    assert.equal(refundParentMatches(resource, "CAPTURE123"), false);
  });
});

describe("invoice and refund webhook domain adapters — fixture signature and fresh owned reads", () => {
  const admit = (type: string, id: string, eventId = `FIXTURE-${randomUUID()}`) => receivePayPalWebhook(JSON.stringify({ id: eventId, event_type: type, resource: { id, amount: { currency_code: "USD", value: "9999.00" } } }), new Headers(), { verify: async () => ({ verified: true, transmissionId: `fixture-${randomUUID()}` }) });
  it("ignores an alleged invoice payment and then applies a reordered event from fresh real-state fixtures", async () => {
    const f = await recoveryFixture(), invoice = await f.create();
    await shareRecoveryInvoice(f.session, invoice.id, f.deps);
    await admit("INVOICING.INVOICE.PAID", f.current().id);
    assert.equal((await processVerifiedWebhooks({ recovery: f.deps, provider: f.deps.payments })).processed, 1);
    assert.equal((await collectionView(f.session))!.collectedMinor, 92500);
    f.pay();
    const eventId = `FIXTURE-${randomUUID()}`;
    await Promise.all(Array.from({ length: 3 }, () => admit("INVOICING.INVOICE.SENT", f.current().id, eventId)));
    assert.equal((await processVerifiedWebhooks({ recovery: f.deps, provider: f.deps.payments })).processed, 1);
    assert.equal((await collectionView(f.session))!.collectedMinor, 96000);
    assert.equal((await query("SELECT id FROM fp_settlement_receipts")).length, 8);
    assert.equal(f.calls.filter(call => call === "create").length, 1);
    assert.equal(f.calls.filter(call => call === "share").length, 1);
  });
  it("reconciles the original pending refund without financial dispatch from the event worker", async () => {
    const f = await refundFixture("pending");
    await cancelUnspentCollection(f.session, { roundId: f.round.id, expectedVersion: 1, acknowledged: true });
    await compensateReceipt(f.session, f.receipt.id, "package_cancelled", f.deps);
    f.recover();
    await admit("PAYMENT.CAPTURE.REFUNDED", [...f.effects.values()][0].id);
    assert.equal((await processVerifiedWebhooks({ refunds: f.deps, provider: f.deps.provider })).processed, 1);
    assert.equal(f.calls.length, 1);
    assert.equal((await collectionView(f.session))!.collectedMinor, 0);
    assert.equal((await query("SELECT id FROM fp_journal WHERE entry_kind='refund'")).length, 2);
  });
  it("cannot assign an unknown invoice event to a tenant or create a financial operation", async () => {
    const f = await recoveryFixture();
    await admit("INVOICING.INVOICE.PAID", "INV2-UNKNOWN-FIXTURE");
    assert.equal((await processVerifiedWebhooks({ recovery: f.deps, provider: f.deps.payments })).retry, 1);
    assert.equal(f.calls.length, 0);
    assert.equal((await query("SELECT id FROM fp_recovery_invoices")).length, 0);
  });
});
