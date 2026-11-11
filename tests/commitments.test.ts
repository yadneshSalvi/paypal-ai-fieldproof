import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "@fracture/paypal-core";
import type { PaymentTokenResponse, SetupTokenRequest, SetupTokenResponse } from "paypal";
import { CONDITIONAL_AMOUNTS, conditionalPolicy, providerConsentDescription, safeApprovalUrl } from "../lib/domain/consent";
import { beginWalletApproval, commitmentOverview, commitmentView, completeWalletApproval, createCommitment, ownedWallet, walletContext, withdrawCommitment, type ConsentRow } from "../lib/server/commitments";
import type { Session } from "../lib/server/auth";
import { database, initializeDatabase, query } from "../lib/server/db";
import { createProject } from "../lib/server/seed";
import type { VaultGateway, VaultResult } from "../lib/server/vault";
import { sealPrivate } from "../lib/server/private-values";

const fixtures: Session[] = [];
async function fixture(): Promise<Session> {
  const session: Session = { id: randomUUID(), tenantId: randomUUID(), projectId: randomUUID(), actorId: randomUUID(), role: "donor", expiresAt: new Date(Date.now() + 600000).toISOString(), mode: "live_sandbox" };
  await database().transaction(async tx => {
    await createProject(tx, session.tenantId, session.projectId, `consent-test-${randomUUID()}`, "live_sandbox");
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'donor',$6)", [session.id, randomUUID(), session.tenantId, session.projectId, session.actorId, session.expiresAt]);
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,'[\"donor\"]'::jsonb)", [session.tenantId, session.projectId, session.actorId]);
  });
  fixtures.push(session);
  return session;
}
const success = <T>(value: T): VaultResult<T> => ({ outcome: "succeeded", value, httpStatus: 200, bodyHash: "fixture-body-hash", debugId: null });
class FixtureVault implements VaultGateway {
  setupCalls = 0; exchangeCalls = 0; readCalls = 0; requestIds: string[] = [];
  approved = true; tokenId = "FIXTURETOKEN0001"; customerId = "FIXTURECUSTOMER0001";
  onSetup: (() => Promise<void>) | null = null;
  exchangeResult: VaultResult<PaymentTokenResponse> | null = null;
  setupResult: VaultResult<SetupTokenResponse> | null = null;
  readCustomerId: string | null = null;
  readUsage: string | undefined = "MERCHANT";
  lastSetupBody: SetupTokenRequest | null = null;
  async createSetup(body: SetupTokenRequest, requestId: string) {
    this.lastSetupBody = body;
    this.setupCalls++; this.requestIds.push(requestId);
    assert.equal(body.paymentSource.paypal?.usageType, "MERCHANT");
    assert.equal(body.paymentSource.paypal?.usagePattern, "UNSCHEDULED_PREPAID");
    assert.match(body.paymentSource.paypal?.description ?? "", /No charge to save/);
    assert.ok((body.paymentSource.paypal?.description?.length ?? 0) <= 128);
    if (this.onSetup) await this.onSetup();
    return this.setupResult ?? success({ id: "FIXTURESETUP0001", status: "PAYER_ACTION_REQUIRED", customer: { id: this.customerId }, links: [{ href: "https://www.sandbox.paypal.com/agreements/approve?fixture=1", rel: "approve", method: "GET" }] });
  }
  async readSetup() { return success({ id: "FIXTURESETUP0001", status: this.approved ? "APPROVED" : "PAYER_ACTION_REQUIRED", customer: { id: this.customerId } }); }
  async exchangeSetup(id: string, requestId: string) {
    this.exchangeCalls++; this.requestIds.push(requestId);
    assert.equal(id, "FIXTURESETUP0001");
    return this.exchangeResult ?? success({ id: this.tokenId, customer: { id: this.customerId }, paymentSource: { paypal: { payerId: "FIXTUREPAYER0001", usageType: "MERCHANT" } } });
  }
  async readToken(id: string) {
    this.readCalls++;
    assert.equal(id, this.tokenId);
    return success({ id: this.tokenId, customer: { id: this.readCustomerId ?? this.customerId }, paymentSource: { paypal: { payerId: "FIXTUREPAYER0001", usageType: this.readUsage } } });
  }
  async deleteToken() { return success(undefined); }
}
class ReusedFixtureVault extends FixtureVault {
  setupId = "FIXTUREREUSESETUP2";
  sourceConsentId: string;
  setupPayer = "FIXTUREPAYER0001";
  setupDescription: string | null = null;
  setupUsage = "MERCHANT";
  setupMerchant: string | null = null;
  forceVaulted = false;
  constructor(sourceConsentId: string) {
    super();
    this.sourceConsentId = sourceConsentId;
    this.customerId = "FIXTURETEMPORARYCUSTOMER";
  }
  async createSetup(body: SetupTokenRequest, requestId: string) {
    this.lastSetupBody = body; this.setupCalls++; this.requestIds.push(requestId);
    return success({ id: this.setupId, status: "PAYER_ACTION_REQUIRED", customer: { id: this.customerId, merchantCustomerId: body.customer?.merchantCustomerId } });
  }
  async readSetup() {
    return success({ id: this.setupId, status: this.forceVaulted || this.exchangeCalls ? "VAULTED" : "APPROVED",
      customer: { id: this.customerId, merchantCustomerId: this.setupMerchant ?? this.lastSetupBody?.customer?.merchantCustomerId },
      paymentSource: { paypal: { payerId: this.setupPayer, description: this.setupDescription ?? this.lastSetupBody?.paymentSource.paypal?.description,
        usageType: this.setupUsage, usagePattern: "UNSCHEDULED_PREPAID" } } });
  }
  async exchangeSetup(id: string, requestId: string) {
    this.exchangeCalls++; this.requestIds.push(requestId); assert.equal(id, this.setupId);
    return success({ id: this.tokenId, customer: { id: "FIXTURECUSTOMER0001", merchantCustomerId: `fp-${this.sourceConsentId}` }, paymentSource: { paypal: { payerId: "FIXTUREPAYER0001", usageType: "MERCHANT" } } });
  }
  async readToken(id: string) {
    this.readCalls++; assert.equal(id, this.tokenId);
    return success({ id, customer: { id: "FIXTURECUSTOMER0001", merchantCustomerId: `fp-${this.sourceConsentId}` }, paymentSource: { paypal: { payerId: "FIXTUREPAYER0001", usageType: "MERCHANT" } } });
  }
}
async function reuseFixture() {
  const session = await fixture(), original = await savedConsent(session), gateway = new FixtureVault();
  await beginWalletApproval(session, original.id, gateway);
  await completeWalletApproval(session, original.id, gateway);
  const next = await savedConsent(session, 0), reused = new ReusedFixtureVault(original.id);
  await beginWalletApproval(session, next.id, reused);
  return { session, original, next, reused };
}
async function savedConsent(session: Session, slotIndex = 7) {
  return createCommitment(session, { slotIndex, expectedVersion: 1, intentId: randomUUID(), accepted: true, policyVersion: 1 });
}
before(initializeDatabase);
after(async () => {
  for (const session of fixtures) {
    for (const table of ["fp_provider_operations", "fp_conditional_consents", "fp_outbox", "fp_events", "fp_obligations", "fp_sessions", "fp_memberships"]) await query(`DELETE FROM ${table} WHERE tenant_id=$1`, [session.tenantId]);
    await query("DELETE FROM fp_packages WHERE project_id=$1", [session.projectId]);
    await query("DELETE FROM fp_projects WHERE id=$1", [session.projectId]);
    await query("DELETE FROM fp_tenants WHERE id=$1", [session.tenantId]);
  }
  await database().close();
});

describe("exact conditional consent authority — fixture provider, no live writes", () => {
  it("keeps eight integer obligations totaling exactly $960 and rejects invalid slots", () => {
    assert.equal(CONDITIONAL_AMOUNTS.reduce((sum, value) => sum + value, 0), 96000);
    for (const index of [-1, 8, 2.5, Number.NaN]) assert.throws(() => conditionalPolicy(index, 1));
    assert.equal(conditionalPolicy(7, 1).amountMinor, 3500);
    assert.equal(conditionalPolicy(7, 1).recoveryHours, 48);
  });
  it("accepts approval links only on exact PayPal sandbox origins", () => {
    assert.ok(safeApprovalUrl("https://sandbox.paypal.com/agreements/approve?x=1"));
    assert.ok(safeApprovalUrl("https://www.sandbox.paypal.com/agreements/approve?x=1"));
    for (const url of ["https://paypal.com/approve", "https://sandbox.paypal.com.evil.example/", "http://sandbox.paypal.com/", "https://x@sandbox.paypal.com/", "https://sandbox.paypal.com:8443/", "javascript:alert(1)"]) assert.equal(safeApprovalUrl(url), null);
  });
  it("keeps every actual amount description inside PayPal's 128-character limit", () => {
    for (let slot=0; slot<8; slot++) {
      const description=providerConsentDescription(conditionalPolicy(slot,1));
      assert.ok(description.length<=128);
      assert.match(description,/Electronics Benches/);
      assert.match(description,/\$960/);
      assert.match(description,/31 Dec 2026/);
    }
  });
  it("concurrent duplicate submissions create one immutable consent and obligation", async () => {
    const session = await fixture(), input = { slotIndex: 7, expectedVersion: 1, intentId: randomUUID(), accepted: true as const, policyVersion: 1 as const };
    const results = await Promise.all(Array.from({ length: 6 }, () => createCommitment(session, input)));
    assert.equal(new Set(results.map(result => result.id)).size, 1);
    assert.equal((await query("SELECT id FROM fp_obligations WHERE tenant_id=$1", [session.tenantId])).length, 1);
    await assert.rejects(() => createCommitment(session, { ...input, slotIndex: 6 }), /different saved commitment/);
    await assert.rejects(() => savedConsent(session), /already committed/);
    assert.equal((await commitmentOverview(session)).eligibleMinor, 0);
  });
  it("claims one setup write across concurrent clicks and keeps identities private", async () => {
    const session = await fixture(), consent = await savedConsent(session), gateway = new FixtureVault();
    await Promise.all(Array.from({ length: 6 }, () => beginWalletApproval(session, consent.id, gateway)));
    assert.equal(gateway.setupCalls, 1);
    assert.equal(new Set(gateway.requestIds).size, 1);
    const publicView = await commitmentView(session, consent.id);
    assert.equal(publicView.status, "wallet_pending");
    assert.ok(publicView.approvalUrl);
    const [row] = await query<{ encrypted_wallet: string }>("SELECT encrypted_wallet FROM fp_conditional_consents WHERE id=$1", [consent.id]);
    assert.ok(row.encrypted_wallet.startsWith("v1."));
    assert.ok(!row.encrypted_wallet.includes("FIXTURESETUP"));
    assert.ok(!JSON.stringify(publicView).includes("FIXTURESETUP"));
  });
  it("rejects a different tenant and a revoked role before provider dispatch", async () => {
    const session = await fixture(), other = await fixture(), consent = await savedConsent(session), gateway = new FixtureVault();
    await assert.rejects(() => beginWalletApproval(other, consent.id, gateway), /does not belong/);
    await query("UPDATE fp_sessions SET role='auditor' WHERE id=$1", [session.id]);
    await assert.rejects(() => beginWalletApproval(session, consent.id, gateway), /current donor session/);
    assert.equal(gateway.setupCalls, 0);
  });
  it("rejects changed package versions before saving a wallet", async () => {
    const session = await fixture(), consent = await savedConsent(session), gateway = new FixtureVault();
    await query("UPDATE fp_packages SET version=2 WHERE project_id=$1 AND id='electronics'", [session.projectId]);
    await assert.rejects(() => beginWalletApproval(session, consent.id, gateway), /package changed/);
    assert.equal(gateway.setupCalls, 0);
  });
  it("does not exchange a callback until the exact owned setup is approved", async () => {
    const session = await fixture(), consent = await savedConsent(session), gateway = new FixtureVault();
    gateway.approved = false;
    await beginWalletApproval(session, consent.id, gateway);
    const pending = await completeWalletApproval(session, consent.id, gateway);
    assert.equal(pending.status, "wallet_pending");
    assert.equal(pending.lastCode, "BUYER_APPROVAL_PENDING");
    assert.equal(gateway.exchangeCalls, 0);
    gateway.approved = true;
    const ready = await completeWalletApproval(session, consent.id, gateway);
    assert.equal(ready.status, "ready");
    assert.equal(gateway.exchangeCalls, 1);
    assert.equal(gateway.readCalls, 1);
    assert.equal((await commitmentOverview(session)).eligibleMinor, 3500);
    assert.ok(!JSON.stringify(ready).includes(gateway.tokenId));
    assert.equal(ready.approvalUrl, null);
    assert.equal((await query("SELECT id FROM fp_settlement_receipts WHERE tenant_id=$1", [session.tenantId])).length, 0);
  });
  it("keeps an unknown exchange uncertain and never repeats it", async () => {
    const session = await fixture(), consent = await savedConsent(session), gateway = new FixtureVault();
    gateway.exchangeResult = { outcome: "unknown", code: "PAYPAL_TIMEOUT" };
    await beginWalletApproval(session, consent.id, gateway);
    assert.equal((await completeWalletApproval(session, consent.id, gateway)).status, "review_required");
    await completeWalletApproval(session, consent.id, gateway);
    assert.equal(gateway.exchangeCalls, 1);
    assert.equal((await commitmentOverview(session)).eligibleMinor, 0);
    const [operation] = await query<{ status: string }>("SELECT status FROM fp_provider_operations WHERE resource_id=$1 AND kind='vault.exchange'", [consent.id]);
    assert.equal(operation.status, "unknown");
  });
  it("records a same-owner binding separately from an unproven reused-token exchange", async () => {
    const { session, original, next, reused } = await reuseFixture();
    const result = await completeWalletApproval(session, next.id, reused);
    assert.equal(result.status, "ready");
    assert.equal(result.obligationId, next.obligationId);
    assert.equal(result.policyDigest, next.policyDigest);
    const [row] = await query<ConsentRow>("SELECT * FROM fp_conditional_consents WHERE id=$1", [next.id]);
    const wallet = ownedWallet(row);
    assert.equal(wallet.binding?.method, "existing_owned_wallet");
    assert.equal(wallet.binding?.sourceConsentId, original.id);
    assert.equal(wallet.candidateToken?.id, reused.tokenId);
    assert.equal(wallet.setupCustomerId, "FIXTURETEMPORARYCUSTOMER");
    assert.equal(wallet.customerId, "FIXTURECUSTOMER0001");
    assert.ok(!row.encrypted_wallet!.includes(reused.tokenId));
    const [operation] = await query<{status:string;diagnostic_code:string;http_status:number}>("SELECT status,diagnostic_code,http_status FROM fp_provider_operations WHERE resource_id=$1 AND kind='vault.exchange'", [next.id]);
    assert.deepEqual(operation, { status: "unknown", diagnostic_code: "TOKEN_IDENTITY_UNPROVEN", http_status: 200 });
    await completeWalletApproval(session, next.id, reused);
    assert.equal(reused.exchangeCalls, 1);
    assert.equal((await commitmentOverview(session)).eligibleMinor, 23500);
    assert.equal((await query("SELECT id FROM fp_settlement_receipts WHERE tenant_id=$1", [session.tenantId])).length, 0);
  });
  it("can bind the existing owned wallet after a legacy response lost its candidate, without rewriting the exchange", async () => {
    const { session, next, reused } = await reuseFixture();
    reused.setupPayer = "FIXTUREOTHERPAYER";
    assert.equal((await completeWalletApproval(session, next.id, reused)).status, "review_required");
    const [row] = await query<ConsentRow>("SELECT * FROM fp_conditional_consents WHERE id=$1", [next.id]);
    const wallet = ownedWallet(row); delete wallet.candidateToken;
    await query("UPDATE fp_conditional_consents SET encrypted_wallet=$2 WHERE id=$1", [row.id, sealPrivate(wallet, walletContext(row))]);
    const [before] = await query("SELECT * FROM fp_provider_operations WHERE resource_id=$1 AND kind='vault.exchange'", [next.id]);
    reused.setupPayer = "FIXTUREPAYER0001";
    assert.equal((await completeWalletApproval(session, next.id, reused)).status, "ready");
    const [after] = await query("SELECT * FROM fp_provider_operations WHERE resource_id=$1 AND kind='vault.exchange'", [next.id]);
    assert.deepEqual(after, before);
    assert.equal(reused.exchangeCalls, 1);
  });
  it("fails closed on a different owner, payer, amount, usage, merchant or ambiguous owned wallets", async () => {
    for (const mismatch of ["actor", "payer", "amount", "usage", "merchant", "ambiguous", "candidate"] as const) {
      const { session, original, next, reused } = await reuseFixture();
      if (mismatch === "actor") await query("UPDATE fp_conditional_consents SET actor_id=$2 WHERE id=$1", [original.id, randomUUID()]);
      if (mismatch === "payer") reused.setupPayer = "FIXTUREOTHERPAYER";
      if (mismatch === "amount") reused.setupDescription = "Different contribution";
      if (mismatch === "usage") reused.setupUsage = "PLATFORM";
      if (mismatch === "merchant") reused.setupMerchant = "another-merchant-customer";
      if (mismatch === "candidate") reused.tokenId = "FIXTUREUNOWNEDTOKEN";
      if (mismatch === "ambiguous") {
        const second = await savedConsent(session, 6), secondGateway = new FixtureVault();
        secondGateway.tokenId = "FIXTURESECONDOWNEDTOKEN";
        await beginWalletApproval(session, second.id, secondGateway);
        await completeWalletApproval(session, second.id, secondGateway);
      }
      const result = await completeWalletApproval(session, next.id, reused);
      assert.equal(result.status, "review_required", mismatch);
      const [row] = await query<ConsentRow>("SELECT * FROM fp_conditional_consents WHERE id=$1", [next.id]);
      assert.equal(ownedWallet(row).tokenId, undefined, mismatch);
      assert.equal(ownedWallet(row).candidateToken?.id, reused.tokenId, mismatch);
      assert.equal(reused.exchangeCalls, 1, mismatch);
    }
  });
  it("refuses readiness when the fresh token read returns a different customer or usage", async () => {
    for (const mismatch of ["customer", "usage"]) {
      const session = await fixture(), consent = await savedConsent(session), gateway = new FixtureVault();
      if (mismatch === "customer") gateway.readCustomerId = "ANOTHERFIXTURECUSTOMER";
      else gateway.readUsage = "PLATFORM";
      await beginWalletApproval(session, consent.id, gateway);
      const result = await completeWalletApproval(session, consent.id, gateway);
      assert.equal(result.status, "review_required");
      assert.equal(result.lastCode, "TOKEN_IDENTITY_UNPROVEN");
      assert.equal((await commitmentOverview(session)).eligibleMinor, 0);
    }
  });
  it("withdrawal remains revoked even if a previously dispatched setup returns late", async () => {
    const session = await fixture(), consent = await savedConsent(session), gateway = new FixtureVault();
    gateway.onSetup = async () => { await withdrawCommitment(session, consent.id); };
    const result = await beginWalletApproval(session, consent.id, gateway);
    assert.equal(result.status, "withdrawn");
    assert.equal(result.canWithdraw, false);
    assert.equal(result.approvalUrl, null);
    assert.equal((await commitmentOverview(session)).eligibleMinor, 0);
    await assert.rejects(() => completeWalletApproval(session, consent.id, gateway), /withdrawn/);
    assert.equal(gateway.exchangeCalls, 0);
  });
  it("malformed setup success cannot create a fresh operation on retry", async () => {
    const session = await fixture(), consent = await savedConsent(session), gateway = new FixtureVault();
    gateway.setupResult = success({ status: "APPROVED" });
    const result = await beginWalletApproval(session, consent.id, gateway);
    assert.equal(result.status, "review_required");
    await beginWalletApproval(session, consent.id, gateway);
    assert.equal(gateway.setupCalls, 1);
  });
  it("corrects only the known refused description payload without replacing consent or its old request", async () => {
    for (const outcome of ["refused", "unknown"] as const) {
      const session = await fixture(), consent = await savedConsent(session), gateway = new FixtureVault();
      gateway.setupResult = { outcome, code: "INVALID_REQUEST", httpStatus: 400 };
      await beginWalletApproval(session,consent.id,gateway);
      const oldBody = structuredClone(gateway.lastSetupBody!);
      oldBody.paymentSource.paypal!.description = "$35.00 for Electronics Benches only if $960 is pledged by 31 Dec 2026. 48-hour collection; incomplete collection refunded. No charge to save wallet.";
      const oldHash=sha256(canonicalJson(oldBody));
      await query("UPDATE fp_provider_operations SET payload_hash=$2,business_key=replace(business_key,':body2','') WHERE resource_id=$1",[consent.id,oldHash]);
      const [oldOperation]=await query<{id:string;request_id:string}>("SELECT id,request_id FROM fp_provider_operations WHERE resource_id=$1",[consent.id]);
      gateway.setupResult=null;
      if(outcome==="unknown") {
        await assert.rejects(()=>beginWalletApproval(session,consent.id,gateway),/must be resolved/);
        assert.equal(gateway.setupCalls,1);
      } else {
        const result=await beginWalletApproval(session,consent.id,gateway);
        assert.equal(result.id,consent.id);
        assert.equal(result.obligationId,consent.obligationId);
        assert.equal(result.policyDigest,consent.policyDigest);
        assert.equal(result.status,"wallet_pending");
        assert.equal(gateway.setupCalls,2);
        const [unchanged]=await query<{payload_hash:string;status:string;request_id:string}>("SELECT payload_hash,status,request_id FROM fp_provider_operations WHERE id=$1",[oldOperation.id]);
        assert.equal(unchanged.payload_hash,oldHash);
        assert.equal(unchanged.request_id,oldOperation.request_id);
        assert.equal(unchanged.status,"refused");
        assert.notEqual(gateway.requestIds[0],gateway.requestIds[1]);
        assert.equal((await query("SELECT id FROM fp_obligations WHERE tenant_id=$1",[session.tenantId])).length,1);
      }
    }
  });
});
