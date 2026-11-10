import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PaymentTokenResponse, SetupTokenRequest, SetupTokenResponse } from "paypal";
import { CONDITIONAL_AMOUNTS, conditionalPolicy, safeApprovalUrl } from "../lib/domain/consent";
import { beginWalletApproval, commitmentOverview, commitmentView, completeWalletApproval, createCommitment, withdrawCommitment } from "../lib/server/commitments";
import type { Session } from "../lib/server/auth";
import { database, initializeDatabase, query } from "../lib/server/db";
import { createProject } from "../lib/server/seed";
import type { VaultGateway, VaultResult } from "../lib/server/vault";

const fixtures: Session[] = [];
async function fixture(): Promise<Session> {
  const session: Session = { id: randomUUID(), tenantId: randomUUID(), projectId: randomUUID(), actorId: randomUUID(), role: "donor", expiresAt: new Date(Date.now() + 600000).toISOString(), mode: "live_sandbox" };
  await database().transaction(async tx => {
    await createProject(tx, session.tenantId, session.projectId, `consent-test-${randomUUID()}`, "live_sandbox");
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'donor',$6)", [session.id, randomUUID(), session.tenantId, session.projectId, session.actorId, session.expiresAt]);
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
  async createSetup(body: SetupTokenRequest, requestId: string) {
    this.setupCalls++; this.requestIds.push(requestId);
    assert.equal(body.paymentSource.paypal?.usageType, "MERCHANT");
    assert.equal(body.paymentSource.paypal?.usagePattern, "UNSCHEDULED_PREPAID");
    assert.match(body.paymentSource.paypal?.description ?? "", /No charge to save wallet/);
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
async function savedConsent(session: Session, slotIndex = 7) {
  return createCommitment(session, { slotIndex, expectedVersion: 1, intentId: randomUUID(), accepted: true, policyVersion: 1 });
}
before(initializeDatabase);
after(async () => {
  for (const session of fixtures) {
    for (const table of ["fp_provider_operations", "fp_conditional_consents", "fp_outbox", "fp_events", "fp_obligations", "fp_sessions"]) await query(`DELETE FROM ${table} WHERE tenant_id=$1`, [session.tenantId]);
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
});
