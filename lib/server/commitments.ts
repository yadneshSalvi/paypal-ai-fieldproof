import { requireMakerspaceScenario } from "./community-workspaces";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import type { PaymentTokenResponse, SetupTokenRequest, SetupTokenResponse } from "paypal";
import { CONDITIONAL_AMOUNTS, CONDITIONAL_PACKAGE, CONDITIONAL_TARGET_MINOR, CONSENT_EXPIRES_AT, conditionalPolicy, consentDigest, providerConsentDescription, safeApprovalUrl, type ConditionalPolicy, type ConsentStatus, type ConsentView } from "../domain/consent";
import { DomainError, formatMoney } from "../domain/money";
import type { Session } from "./auth";
import { database, initializeDatabase, query } from "./db";
import { applicationOrigin } from "./payments";
import { openPrivate, sealPrivate } from "./private-values";
import { claimExternalOperation, dispatchExternalOperation, finishExternalOperation, type ExternalOperation } from "./provider-operations";
import { appendEvent } from "./repository";
import { vaultGateway, type VaultGateway, type VaultResult } from "./vault";

export interface ConsentRow {
  id: string; tenant_id: string; project_id: string; actor_id: string; session_id: string; obligation_id: string;
  intent_id: string; slot_index: number; package_id: string; package_version: number; amount_minor: string;
  version: number; status: ConsentStatus; policy_digest: string; policy: ConditionalPolicy; expires_at: Date;
  acknowledged_at: Date; withdrawn_at: Date | null; round_id: string | null; encrypted_wallet: string | null;
  wallet_label: string | null; wallet_observed_at: Date | null; provider_status: string | null; last_code: string | null;
  channel?: string;
}
export interface PrivateWallet {
  setupId?: string; tokenId?: string; customerId?: string; payerId?: string; approvalUrl?: string;
  setupBodyHash?: string; tokenBodyHash?: string; usageType?: string; usagePattern?: string;
  setupCustomerId?: string; tokenMerchantCustomerId?: string;
  candidateToken?: { id?: string; customerId?: string; merchantCustomerId?: string; payerId?: string; bodyHash: string };
  binding?: { method: "setup_exchange" | "existing_owned_wallet"; sourceConsentId?: string; approvedSetupBodyHash: string; tokenBodyHash: string; observedAt: string };
}
export function walletContext(row: Pick<ConsentRow, "id" | "tenant_id" | "actor_id">): string { return `conditional-wallet:${row.tenant_id}:${row.actor_id}:${row.id}`; }
export function ownedWallet(row: ConsentRow): PrivateWallet { return row.encrypted_wallet ? openPrivate<PrivateWallet>(row.encrypted_wallet, walletContext(row)) : {}; }
function resourceId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{5,128}$/.test(value); }
function assertSession(session: Session): void {
  if (session.mode !== "live_sandbox" || session.role !== "donor") throw new DomainError("ROLE_DENIED", "Use your donor view in a live sandbox workspace to manage this commitment.", 403);
}
export async function requireCurrentConsentSession(tx: SqlConnection, session: Session): Promise<void> {
  assertSession(session);
  const rows = await query(`SELECT s.id FROM fp_sessions s JOIN fp_tenants t ON t.id=s.tenant_id
    WHERE s.id=$1 AND s.tenant_id=$2 AND s.project_id=$3 AND s.actor_id=$4 AND s.role='donor'
      AND s.revoked_at IS NULL AND s.expires_at>now() AND t.mode='live_sandbox' FOR UPDATE OF s`,
  [session.id, session.tenantId, session.projectId, session.actorId], tx);
  if (!rows.length) throw new DomainError("ROLE_DENIED", "Your current donor session is required.", 403);
}
export async function getOwnedConsent(session: Session, id: string, tx: SqlConnection = database(), lock = false): Promise<ConsentRow> {
  const [row] = await query<ConsentRow>(`SELECT c.*,o.channel FROM fp_conditional_consents c JOIN fp_obligations o ON o.id=c.obligation_id
    WHERE c.id=$1 AND c.tenant_id=$2 AND c.project_id=$3 AND c.actor_id=$4 ${lock ? "FOR UPDATE OF c" : ""}`,
  [id, session.tenantId, session.projectId, session.actorId], tx);
  if (!row) throw new DomainError("CONSENT_NOT_FOUND", "That commitment does not belong to your account.", 404);
  return row;
}
function assertOpenConsent(row: ConsentRow, allowExpired = false): void {
  if (row.withdrawn_at || row.status === "withdrawn") throw new DomainError("CONSENT_WITHDRAWN", "This commitment has been withdrawn.");
  if (!allowExpired && row.expires_at.getTime() <= Date.now()) throw new DomainError("CONSENT_EXPIRED", "This commitment expired. A new commitment needs your approval.");
  if (row.round_id) throw new DomainError("COLLECTION_ALREADY_STARTED", "Collection has started. Follow the payment and recovery record for this commitment.");
  const expected = conditionalPolicy(row.slot_index, row.package_version);
  const digest = consentDigest({ tenantId: row.tenant_id, projectId: row.project_id, actorId: row.actor_id, obligationId: row.obligation_id, version: row.version, policy: expected });
  if (canonicalJson(row.policy) !== canonicalJson(expected) || row.policy_digest !== digest || Number(row.amount_minor) !== expected.amountMinor || row.expires_at.toISOString() !== expected.expiresAt) throw new DomainError("CONSENT_CHANGED", "The saved commitment no longer matches its approved conditions.");
}
async function assertCurrentPackage(tx: SqlConnection, row: ConsentRow): Promise<void> {
  const [item] = await query<{ version: number; budget_minor: string }>("SELECT version,budget_minor FROM fp_packages WHERE project_id=$1 AND id=$2", [row.project_id, row.package_id], tx);
  if (!item || item.version !== row.package_version || Number(item.budget_minor) !== row.policy.targetMinor) throw new DomainError("VERSION_CHANGED", "The package changed after your consent. Review the current plan before connecting a wallet.");
}
function consentView(row: ConsentRow): ConsentView {
  const wallet = ownedWallet(row);
  return { id: row.id, obligationId: row.obligation_id, slotIndex: row.slot_index, amountMinor: Number(row.amount_minor),
    packageVersion: row.package_version, version: row.version, status: row.status, channel: row.channel ?? "uncollected",
    policy: row.policy, policyDigest: row.policy_digest, expiresAt: row.expires_at.toISOString(), acknowledgedAt: row.acknowledged_at.toISOString(),
    walletLabel: row.wallet_label, walletObservedAt: row.wallet_observed_at?.toISOString() ?? null,
    approvalUrl: !row.withdrawn_at && row.status === "wallet_pending" ? safeApprovalUrl(wallet.approvalUrl) : null,
    canWithdraw: !row.withdrawn_at && !row.round_id, lastCode: row.last_code, source: "live_sandbox" };
}
export async function commitmentView(session: Session, id: string): Promise<ConsentView> {
  await initializeDatabase();
  return consentView(await getOwnedConsent(session, id));
}
export async function commitmentOverview(session: Session): Promise<{ commitments: ConsentView[]; slots: { index: number; amountMinor: number; available: boolean }[]; eligibleMinor: number; targetMinor: number; expiresAt: string }> {
  await initializeDatabase();
  await requireMakerspaceScenario(session);
  const [owned, occupied] = await Promise.all([
    query<ConsentRow>(`SELECT c.*,o.channel FROM fp_conditional_consents c JOIN fp_obligations o ON o.id=c.obligation_id
      WHERE c.tenant_id=$1 AND c.project_id=$2 AND c.actor_id=$3 ORDER BY c.created_at`, [session.tenantId, session.projectId, session.actorId]),
    query<{ slot_index: number; amount_minor: string; status: string; expires_at: Date; package_version: number; current_version: number }>(`SELECT c.slot_index,c.amount_minor,c.status,c.expires_at,c.package_version,p.version current_version
      FROM fp_conditional_consents c JOIN fp_packages p ON p.project_id=c.project_id AND p.id=c.package_id
      WHERE c.tenant_id=$1 AND c.project_id=$2 AND c.package_id=$3 AND c.withdrawn_at IS NULL`, [session.tenantId, session.projectId, CONDITIONAL_PACKAGE]),
  ]);
  return { commitments: owned.map(consentView), slots: CONDITIONAL_AMOUNTS.map((amountMinor, index) => ({ index, amountMinor, available: !occupied.some(row => row.slot_index === index) })),
    eligibleMinor: occupied.filter(row => ["ready", "collecting", "collected"].includes(row.status) && row.expires_at.getTime() > Date.now() && row.package_version === row.current_version).reduce((sum, row) => sum + Number(row.amount_minor), 0),
    targetMinor: CONDITIONAL_TARGET_MINOR, expiresAt: CONSENT_EXPIRES_AT };
}
export async function createCommitment(session: Session, input: { slotIndex: number; expectedVersion: number; intentId: string; accepted: true; policyVersion: 1 }): Promise<ConsentView> {
  await requireMakerspaceScenario(session);
  assertSession(session);
  const policy = conditionalPolicy(input.slotIndex, input.expectedVersion);
  if (input.accepted !== true || input.policyVersion !== policy.version) throw new DomainError("CONSENT_REQUIRED", "Read and accept the exact collection policy first.", 400);
  if (Date.parse(policy.expiresAt) <= Date.now()) throw new DomainError("CONSENT_EXPIRED", "This collection period has ended.");
  await initializeDatabase();
  const id = await database().transaction(async tx => {
    await requireCurrentConsentSession(tx, session);
    const [existing] = await query<ConsentRow>("SELECT * FROM fp_conditional_consents WHERE tenant_id=$1 AND actor_id=$2 AND intent_id=$3", [session.tenantId, session.actorId, input.intentId], tx);
    if (existing) {
      if (existing.slot_index !== input.slotIndex || canonicalJson(existing.policy) !== canonicalJson(policy)) throw new DomainError("CONSENT_CONFLICT", "This request already has a different saved commitment.");
      return existing.id;
    }
    const [item] = await query<{ version: number; budget_minor: string }>("SELECT version,budget_minor FROM fp_packages WHERE project_id=$1 AND id=$2 FOR UPDATE", [session.projectId, CONDITIONAL_PACKAGE], tx);
    if (!item || item.version !== input.expectedVersion || Number(item.budget_minor) !== CONDITIONAL_TARGET_MINOR) throw new DomainError("VERSION_CHANGED", "Review the current Electronics Benches plan before committing.");
    if ((await query("SELECT id FROM fp_collection_rounds WHERE project_id=$1 AND package_id=$2", [session.projectId, CONDITIONAL_PACKAGE], tx)).length) throw new DomainError("ROUND_EXISTS", "This project's collection round has already been frozen.");
    if ((await query("SELECT id FROM fp_conditional_consents WHERE project_id=$1 AND package_id=$2 AND slot_index=$3 AND withdrawn_at IS NULL", [session.projectId, CONDITIONAL_PACKAGE, input.slotIndex], tx)).length) throw new DomainError("SLOT_TAKEN", "That contribution is already committed. Choose an available amount.");
    const consentId = randomUUID(), obligationId = `${session.tenantId}:conditional:${input.intentId}`;
    const digest = consentDigest({ tenantId: session.tenantId, projectId: session.projectId, actorId: session.actorId, obligationId, version: 1, policy });
    await tx.query(`INSERT INTO fp_obligations(id,tenant_id,project_id,package_id,actor_id,amount_minor,channel,purpose,data)
      VALUES($1,$2,$3,$4,$5,$6,'uncollected','conditional_pledge',$7::jsonb)`, [obligationId, session.tenantId, session.projectId, CONDITIONAL_PACKAGE, session.actorId, policy.amountMinor, JSON.stringify({ donorLabel: "You", provenance: "live_sandbox", consentId, eligible: false })]);
    await tx.query(`INSERT INTO fp_conditional_consents(id,tenant_id,project_id,actor_id,session_id,obligation_id,intent_id,slot_index,package_id,package_version,amount_minor,status,policy_digest,policy,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'awaiting_wallet',$12,$13::jsonb,$14)`,
    [consentId, session.tenantId, session.projectId, session.actorId, session.id, obligationId, input.intentId, input.slotIndex, CONDITIONAL_PACKAGE, input.expectedVersion, policy.amountMinor, digest, JSON.stringify(policy), policy.expiresAt]);
    await appendEvent(tx, session, "consent.acknowledged", "Your contribution has clear conditions", "The exact amount, package version and collection policy are recorded. Your wallet has not been charged.");
    return consentId;
  });
  return commitmentView(session, id);
}
function setupBody(row: ConsentRow): SetupTokenRequest {
  const origin = applicationOrigin(), route = `${origin}/commitment?consent=${encodeURIComponent(row.id)}`;
  return { customer: { merchantCustomerId: `fp-${row.id}` }, paymentSource: { paypal: {
    description: providerConsentDescription(row.policy), usageType: "MERCHANT", customerType: "CONSUMER", usagePattern: "UNSCHEDULED_PREPAID",
    experienceContext: { brandName: "Fieldproof", shippingPreference: "NO_SHIPPING", returnUrl: `${route}&wallet=returned`, cancelUrl: `${route}&wallet=cancelled` },
  } } };
}
async function recordFailure(session: Session, row: ConsentRow, operation: ExternalOperation, result: Exclude<VaultResult<unknown>, { outcome: "succeeded" }>, observation: Record<string, unknown> = {}): Promise<void> {
  await database().transaction(async tx => {
    await getOwnedConsent(session, row.id, tx, true);
    await finishExternalOperation(tx, operation.id, result.outcome, { code: result.code, httpStatus: result.httpStatus, observation: { ...observation, ...(result.debugId ? { debugId: result.debugId } : {}), ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) } });
    await tx.query("UPDATE fp_conditional_consents SET status=$2,last_code=$3 WHERE id=$1 AND withdrawn_at IS NULL", [row.id, result.outcome === "unknown" ? "review_required" : "unavailable", result.code]);
    await appendEvent(tx, session, "wallet.connection_issue", result.outcome === "unknown" ? "Wallet status needs a check" : "PayPal could not save this wallet", "No contribution has been charged. The provider operation is recorded; an uncertain response will not be repeated blindly.");
  });
}
export async function beginWalletApproval(session: Session, id: string, gateway: VaultGateway = vaultGateway()): Promise<ConsentView> {
  assertSession(session);
  const claim = await database().transaction(async tx => {
    await requireCurrentConsentSession(tx, session);
    const row = await getOwnedConsent(session, id, tx, true);
    assertOpenConsent(row);
    await assertCurrentPackage(tx, row);
    if (ownedWallet(row).setupId || row.status === "ready") return null;
    const body = setupBody(row);
    const [previous] = await query<ExternalOperation>("SELECT * FROM fp_provider_operations WHERE resource_id=$1 AND tenant_id=$2 AND kind='vault.setup' ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE", [id,session.tenantId], tx);
    let businessKey = previous?.business_key ?? `vault:setup:${id}:v${row.version}:body2`;
    if (previous && previous.payload_hash !== sha256(canonicalJson(body))) {
      const oldBody: SetupTokenRequest = { ...body, paymentSource: { paypal: { ...body.paymentSource.paypal, description: `${formatMoney(row.policy.amountMinor)} for Electronics Benches only if $960 is pledged by 31 Dec 2026. 48-hour collection; incomplete collection refunded. No charge to save wallet.` } } };
      if (previous.status !== "refused" || previous.http_status !== 400 || previous.diagnostic_code !== "INVALID_REQUEST" || previous.payload_hash !== sha256(canonicalJson(oldBody))) throw new DomainError("OPERATION_CONFLICT", "The existing provider request must be resolved before its payload can change.");
      businessKey = `vault:setup:${id}:v${row.version}:body2`;
      await appendEvent(tx, session, "wallet.request_corrected", "The same commitment has a corrected approval request", "The original request was definitively refused. The provider description now fits its documented limit; your amount, policy and obligation are unchanged.");
    }
    const operation = await claimExternalOperation(tx, { tenantId: session.tenantId, projectId: session.projectId, actorId: session.actorId, resourceId: id, kind: "vault.setup", businessKey, payload: body });
    const dispatch = await dispatchExternalOperation(tx, operation);
    return dispatch ? { row, body, operation } : null;
  });
  if (!claim) return commitmentView(session, id);
  const result = await gateway.createSetup(claim.body, claim.operation.request_id);
  if (result.outcome !== "succeeded") { await recordFailure(session, claim.row, claim.operation, result); return commitmentView(session, id); }
  await database().transaction(async tx => {
    const row = await getOwnedConsent(session, id, tx, true);
    const setup = result.value, approval = safeApprovalUrl(setup.links?.find(link => link.rel === "approve" || link.rel === "payer-action")?.href);
    const recognized = ["CREATED", "PAYER_ACTION_REQUIRED", "APPROVED", "VAULTED", "TOKENIZED"].includes(setup.status ?? "");
    if (!resourceId(setup.id) || !recognized || (setup.customer?.merchantCustomerId && setup.customer.merchantCustomerId !== `fp-${id}`)) {
      await finishExternalOperation(tx, claim.operation.id, "unknown", { code: "SETUP_IDENTITY_UNPROVEN", httpStatus: result.httpStatus, observation: { bodyHash: result.bodyHash } });
      await tx.query("UPDATE fp_conditional_consents SET status=CASE WHEN withdrawn_at IS NULL THEN 'review_required' ELSE status END,last_code='SETUP_IDENTITY_UNPROVEN' WHERE id=$1", [id]);
      return;
    }
    const wallet: PrivateWallet = { setupId: setup.id, ...(setup.customer?.id ? { customerId: setup.customer.id, setupCustomerId: setup.customer.id } : {}), ...(approval ? { approvalUrl: approval } : {}), setupBodyHash: result.bodyHash };
    await tx.query("UPDATE fp_conditional_consents SET encrypted_wallet=$2,provider_status=$3,status=CASE WHEN withdrawn_at IS NULL THEN 'wallet_pending' ELSE status END,last_code=$4 WHERE id=$1", [id, sealPrivate(wallet, walletContext(row)), setup.status, !approval && setup.status !== "APPROVED" ? "APPROVAL_LINK_UNAVAILABLE" : null]);
    await finishExternalOperation(tx, claim.operation.id, "succeeded", { httpStatus: result.httpStatus, observation: { bodyHash: result.bodyHash, providerStatus: setup.status, approvalLinkAvailable: !!approval } });
    await appendEvent(tx, session, "wallet.approval_requested", "Your PayPal approval is ready", "Saving this wallet does not move money. The consent applies to this exact contribution only.");
  });
  return commitmentView(session, id);
}
function tokenMatches(token: PaymentTokenResponse, wallet: PrivateWallet, id: string): boolean {
  return token.id === id && !!token.paymentSource?.paypal && (!wallet.customerId || !token.customer?.id || token.customer.id === wallet.customerId)
    && (!token.paymentSource.paypal.usageType || token.paymentSource.paypal.usageType === "MERCHANT")
    && (!token.paymentSource.paypal.usagePattern || token.paymentSource.paypal.usagePattern === "UNSCHEDULED_PREPAID");
}
function merchantMatches(token: PaymentTokenResponse, wallet: PrivateWallet, row: ConsentRow): boolean {
  return !token.customer?.merchantCustomerId || token.customer.merchantCustomerId === (wallet.tokenMerchantCustomerId ?? `fp-${row.id}`);
}
function approvedSetupMatches(row: ConsentRow, wallet: PrivateWallet, setup: SetupTokenResponse): boolean {
  const paypal = setup.paymentSource?.paypal;
  return setup.id === wallet.setupId && setup.status === "VAULTED"
    && setup.customer?.id === (wallet.setupCustomerId ?? wallet.customerId)
    && setup.customer?.merchantCustomerId === `fp-${row.id}`
    && paypal?.description === providerConsentDescription(row.policy)
    && paypal.usageType === "MERCHANT" && paypal.usagePattern === "UNSCHEDULED_PREPAID" && resourceId(paypal.payerId);
}
async function bindExistingOwnedWallet(session: Session, row: ConsentRow, wallet: PrivateWallet, setup: Extract<VaultResult<SetupTokenResponse>, { outcome: "succeeded" }>, gateway: VaultGateway): Promise<boolean> {
  if (!approvedSetupMatches(row, wallet, setup.value)) return false;
  const sources = await query<ConsentRow>(`SELECT * FROM fp_conditional_consents
    WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND id<>$4 AND withdrawn_at IS NULL
      AND status IN ('ready','collecting','collected') AND wallet_observed_at IS NOT NULL
    ORDER BY created_at,id`, [row.tenant_id, row.project_id, row.actor_id, row.id]);
  const candidates = new Map<string, { row: ConsentRow; wallet: PrivateWallet }>();
  for (const source of sources) {
    const owned = ownedWallet(source);
    if (owned.tokenId) candidates.set(owned.tokenId, candidates.get(owned.tokenId) ?? { row: source, wallet: owned });
  }
  // A prior wallet is authority only within this participant's existing ownership, never a search result.
  if (candidates.size !== 1) return false;
  const source = [...candidates.values()][0], sourceWallet = source.wallet;
  const payerId = setup.value.paymentSource!.paypal!.payerId!;
  if (!resourceId(sourceWallet.tokenId) || !resourceId(sourceWallet.payerId) || sourceWallet.payerId !== payerId) return false;
  if (wallet.candidateToken && (wallet.candidateToken.id !== sourceWallet.tokenId
    || (wallet.candidateToken.customerId && wallet.candidateToken.customerId !== sourceWallet.customerId)
    || (wallet.candidateToken.payerId && wallet.candidateToken.payerId !== payerId)
    || (wallet.candidateToken.merchantCustomerId && wallet.candidateToken.merchantCustomerId !== (sourceWallet.tokenMerchantCustomerId ?? `fp-${source.row.id}`)))) return false;
  const token = await gateway.readToken(sourceWallet.tokenId);
  if (token.outcome !== "succeeded" || !tokenMatches(token.value, sourceWallet, sourceWallet.tokenId)
    || !merchantMatches(token.value, sourceWallet, source.row) || token.value.paymentSource?.paypal?.payerId !== payerId
    || token.value.paymentSource.paypal.usageType !== "MERCHANT") return false;
  return database().transaction(async tx => {
    await requireCurrentConsentSession(tx, session);
    const current = await getOwnedConsent(session, row.id, tx, true);
    assertOpenConsent(current);
    await assertCurrentPackage(tx, current);
    const currentSources = await query<ConsentRow>(`SELECT * FROM fp_conditional_consents WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND id<>$4
      AND withdrawn_at IS NULL AND status IN ('ready','collecting','collected') AND wallet_observed_at IS NOT NULL`, [row.tenant_id, row.project_id, row.actor_id, row.id], tx);
    const currentTokens = new Set(currentSources.map(item => ownedWallet(item).tokenId).filter(Boolean));
    if (currentTokens.size !== 1 || !currentTokens.has(sourceWallet.tokenId)) return false;
    const original = await getOwnedConsent(session, source.row.id, tx, true), originalWallet = ownedWallet(original);
    if (original.withdrawn_at || !["ready", "collecting", "collected"].includes(original.status)
      || originalWallet.tokenId !== sourceWallet.tokenId || originalWallet.customerId !== sourceWallet.customerId
      || originalWallet.payerId !== payerId || !approvedSetupMatches(current, ownedWallet(current), setup.value)) return false;
    const confirmed: PrivateWallet = { ...ownedWallet(current), setupCustomerId: setup.value.customer!.id,
      tokenId: sourceWallet.tokenId, customerId: sourceWallet.customerId, payerId,
      tokenMerchantCustomerId: token.value.customer?.merchantCustomerId ?? sourceWallet.tokenMerchantCustomerId ?? `fp-${source.row.id}`,
      usageType: token.value.paymentSource!.paypal!.usageType,
      ...(token.value.paymentSource!.paypal!.usagePattern ? { usagePattern: token.value.paymentSource!.paypal!.usagePattern } : {}),
      tokenBodyHash: token.bodyHash,
      binding: { method: "existing_owned_wallet", sourceConsentId: original.id, approvedSetupBodyHash: setup.bodyHash, tokenBodyHash: token.bodyHash, observedAt: new Date().toISOString() } };
    delete confirmed.approvalUrl;
    await tx.query("UPDATE fp_conditional_consents SET status='ready',encrypted_wallet=$2,wallet_label=$3,wallet_observed_at=now(),provider_status='VAULTED',last_code=NULL WHERE id=$1", [current.id, sealPrivate(confirmed, walletContext(current)), original.wallet_label]);
    await tx.query("UPDATE fp_obligations SET data=jsonb_set(data,'{eligible}','true'::jsonb) WHERE id=$1", [current.obligation_id]);
    if (current.status !== "ready") await appendEvent(tx, session, "wallet.existing_owned_bound", "Your verified wallet is bound to this contribution", "The original approved setup and a fresh read identify the same participant's previously saved wallet. This separate binding preserves the earlier unproven exchange. No contribution was charged.");
    return true;
  });
}
async function confirmWallet(session: Session, row: ConsentRow, wallet: PrivateWallet, gateway: VaultGateway): Promise<void> {
  const result = await gateway.readToken(wallet.tokenId!);
  await database().transaction(async tx => {
    await requireCurrentConsentSession(tx, session);
    const current = await getOwnedConsent(session, row.id, tx, true);
    if (current.withdrawn_at || current.round_id) return;
    assertOpenConsent(current);
    await assertCurrentPackage(tx, current);
    if (result.outcome !== "succeeded" || !tokenMatches(result.value, wallet, wallet.tokenId!) || !merchantMatches(result.value, wallet, row)
      || (wallet.payerId && result.value.paymentSource?.paypal?.payerId !== wallet.payerId)) {
      await tx.query("UPDATE fp_conditional_consents SET status='review_required',last_code=$2 WHERE id=$1", [row.id, result.outcome === "succeeded" ? "TOKEN_IDENTITY_UNPROVEN" : result.code]);
      return;
    }
    const token = result.value, paypal = token.paymentSource!.paypal!;
    const confirmed: PrivateWallet = { ...wallet, ...(token.customer?.id ? { customerId: token.customer.id } : {}), ...(token.customer?.merchantCustomerId ? { tokenMerchantCustomerId: token.customer.merchantCustomerId } : {}), ...(paypal.payerId ? { payerId: paypal.payerId } : {}), ...(paypal.usageType ? { usageType: paypal.usageType } : {}), ...(paypal.usagePattern ? { usagePattern: paypal.usagePattern } : {}), tokenBodyHash: result.bodyHash };
    delete confirmed.approvalUrl;
    const label = paypal.emailAddress && /^[^@]+@[^@]+$/.test(paypal.emailAddress) ? `${paypal.emailAddress[0]}•••@${paypal.emailAddress.split("@")[1]}` : `PayPal wallet ··${wallet.tokenId!.slice(-4)}`;
    await tx.query("UPDATE fp_conditional_consents SET status='ready',encrypted_wallet=$2,wallet_label=$3,wallet_observed_at=now(),last_code=NULL,provider_status='VAULTED' WHERE id=$1", [row.id, sealPrivate(confirmed, walletContext(row)), label]);
    await tx.query("UPDATE fp_obligations SET data=jsonb_set(data,'{eligible}','true'::jsonb) WHERE id=$1", [row.obligation_id]);
    if (current.status !== "ready") await appendEvent(tx, session, "wallet.confirmed", "Your conditional contribution is ready", "PayPal confirmed the saved wallet. No contribution has been collected; the package must first meet its full pledge target.");
  });
}
export async function completeWalletApproval(session: Session, id: string, gateway: VaultGateway = vaultGateway()): Promise<ConsentView> {
  assertSession(session);
  let row = await getOwnedConsent(session, id);
  assertOpenConsent(row);
  let wallet = ownedWallet(row);
  if (wallet.tokenId) { await confirmWallet(session, row, wallet, gateway); return commitmentView(session, id); }
  if (!wallet.setupId) return commitmentView(session, id);
  const setup = await gateway.readSetup(wallet.setupId);
  const setupCustomerId = wallet.setupCustomerId ?? wallet.customerId;
  if (setup.outcome !== "succeeded" || setup.value.id !== wallet.setupId || (setupCustomerId && setup.value.customer?.id && setupCustomerId !== setup.value.customer.id)) {
    await query("UPDATE fp_conditional_consents SET last_code=$2 WHERE id=$1", [id, setup.outcome === "succeeded" ? "SETUP_IDENTITY_UNPROVEN" : setup.code]);
    return commitmentView(session, id);
  }
  if (setup.value.status !== "APPROVED") {
    if (await bindExistingOwnedWallet(session, row, wallet, setup, gateway)) return commitmentView(session, id);
    await query("UPDATE fp_conditional_consents SET provider_status=$2,last_code=$3 WHERE id=$1", [id, setup.value.status ?? "UNKNOWN", ["CREATED", "PAYER_ACTION_REQUIRED"].includes(setup.value.status ?? "") ? "BUYER_APPROVAL_PENDING" : "SETUP_STATE_UNPROVEN"]);
    return commitmentView(session, id);
  }
  const claim = await database().transaction(async tx => {
    await requireCurrentConsentSession(tx, session);
    row = await getOwnedConsent(session, id, tx, true);
    assertOpenConsent(row);
    await assertCurrentPackage(tx, row);
    const operation = await claimExternalOperation(tx, { tenantId: session.tenantId, projectId: session.projectId, actorId: session.actorId, resourceId: id, kind: "vault.exchange", businessKey: `vault:exchange:${id}:v${row.version}`, payload: { setupIdentityHash: sha256(wallet.setupId!), consentDigest: row.policy_digest } });
    return await dispatchExternalOperation(tx, operation) ? operation : null;
  });
  if (!claim) return commitmentView(session, id);
  const result = await gateway.exchangeSetup(wallet.setupId, claim.request_id);
  if (result.outcome !== "succeeded") { await recordFailure(session, row, claim, result); return commitmentView(session, id); }
  // A successful transport can still return an unexpected identity. Keep the exact candidate encrypted before interpreting it.
  wallet = { ...wallet, setupCustomerId, candidateToken: {
    ...(resourceId(result.value.id) ? { id: result.value.id } : {}),
    ...(result.value.customer?.id ? { customerId: result.value.customer.id } : {}),
    ...(result.value.customer?.merchantCustomerId ? { merchantCustomerId: result.value.customer.merchantCustomerId } : {}),
    ...(result.value.paymentSource?.paypal?.payerId ? { payerId: result.value.paymentSource.paypal.payerId } : {}), bodyHash: result.bodyHash,
  } };
  await database().transaction(async tx => {
    const current = await getOwnedConsent(session, id, tx, true);
    await tx.query("UPDATE fp_conditional_consents SET encrypted_wallet=$2 WHERE id=$1", [id, sealPrivate(wallet, walletContext(current))]);
  });
  if (!resourceId(result.value.id) || !tokenMatches(result.value, wallet, result.value.id) || (result.value.customer?.merchantCustomerId && result.value.customer.merchantCustomerId !== `fp-${id}`)) {
    await recordFailure(session, row, claim, { outcome: "unknown", code: "TOKEN_IDENTITY_UNPROVEN", httpStatus: result.httpStatus }, { bodyHash: result.bodyHash });
    const currentSetup = await gateway.readSetup(wallet.setupId!);
    if (currentSetup.outcome === "succeeded") await bindExistingOwnedWallet(session, row, wallet, currentSetup, gateway);
    return commitmentView(session, id);
  }
  const saved: PrivateWallet = { ...wallet, tokenId: result.value.id, ...(result.value.customer?.id ? { customerId: result.value.customer.id } : {}), ...(result.value.customer?.merchantCustomerId ? { tokenMerchantCustomerId: result.value.customer.merchantCustomerId } : {}), tokenBodyHash: result.bodyHash,
    binding: { method: "setup_exchange", approvedSetupBodyHash: setup.bodyHash, tokenBodyHash: result.bodyHash, observedAt: new Date().toISOString() } };
  await database().transaction(async tx => {
    row = await getOwnedConsent(session, id, tx, true);
    await tx.query("UPDATE fp_conditional_consents SET encrypted_wallet=$2,last_code=NULL WHERE id=$1", [id, sealPrivate(saved, walletContext(row))]);
    await finishExternalOperation(tx, claim.id, "succeeded", { httpStatus: result.httpStatus, observation: { bodyHash: result.bodyHash } });
  });
  await confirmWallet(session, row, saved, gateway);
  return commitmentView(session, id);
}
export async function withdrawCommitment(session: Session, id: string): Promise<ConsentView> {
  assertSession(session);
  await database().transaction(async tx => {
    await requireCurrentConsentSession(tx, session);
    const row = await getOwnedConsent(session, id, tx, true);
    if (row.withdrawn_at) return;
    assertOpenConsent(row, true);
    await tx.query("UPDATE fp_conditional_consents SET status='withdrawn',withdrawn_at=now(),version=version+1 WHERE id=$1", [id]);
    await tx.query("UPDATE fp_obligations SET version=version+1,data=jsonb_set(data,'{eligible}','false'::jsonb) WHERE id=$1", [row.obligation_id]);
    await tx.query("UPDATE fp_approval_records SET revoked_at=now() WHERE resource_id=$1 AND revoked_at IS NULL", [row.obligation_id]);
    await appendEvent(tx, session, "consent.withdrawn", "Your contribution was withdrawn", "Fieldproof can no longer collect this commitment. This application withdrawal is recorded separately from PayPal wallet removal.");
  });
  return commitmentView(session, id);
}
