import { randomUUID } from "node:crypto";
import { canonicalJson, sha256, type CommerceRestResult, type CreatePayout, type PayoutBatchObservation, type PayoutItemObservation, type SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import type { ClaimPrivateData } from "../domain/claims";
import { DomainError } from "../domain/money";
import { PAYOUT_APPROVAL_MS, PAYOUT_DUPLICATE_WINDOW_MS, PAYOUT_POLICY_VERSION, RECIPIENT_VERIFICATION_MS, payoutApprovalSchema, payoutReviewDigest, payoutSelectionSchema,
  type ClaimPaymentView, type PayableState, type PayableView, type PayoutReviewView } from "../domain/payouts";
import type { Session } from "./auth";
import { assertUsableBalance, liveBalanceReader, observeBalance, payoutMerchantScope, type BalanceEvidence, type BalanceReader } from "./balance";
import { claimPrivate, projectClaimLock, requireClaim, type ClaimRow } from "./claims";
import { commerceGateway, type CommerceGateway } from "./commerce";
import { database, query } from "./db";
import { requireDocument } from "./documents";
import { openDestination } from "./identity";
import { requireCurrentRole, requireMembership } from "./membership";
import { canonicalExpenseReadiness, planPayoutFunding, type PlannedAllocation, type PayoutFunding } from "./payout-funding";
import { lockFundingScope } from "./funding-positions";
import { openPrivate, sealPrivate } from "./private-values";
import { appendEvent } from "./repository";
import { assertProjectPolicyReview, bindProjectPolicyArtifacts, enforceProjectFundDecision, recordProjectPolicyReview } from "./project-policy";

interface RecipientRow { id: string; tenant_id: string; actor_id: string; encrypted_destination: string; masked_label: string; verification_method: string; account_verified: boolean; version: number; verified_at: Date }
interface PayoutSnapshot {
  policyVersion: string; claimId: string; claimVersion: number; claimantActorId: string; claimDigest: string;
  documentId: string; sourceHash: string; documentVersion: number; sourceClass: "sample_document" | "user_upload";
  groupId: string; groupVersion: number; reviewedTotalMinor: number; membershipVersion: number;
  recipient: { id: string; version: number; label: string; verifiedAt: string; destinationHash: string };
  funding: PayoutFunding; payableId: string | null;
}
interface PayableData {
  request: CreatePayout; snapshot: PayoutSnapshot; batchId: string | null; itemId: string | null;
  candidateBatchIds: string[]; candidateItemIds: string[];
}
interface PayableRow {
  id: string; tenant_id: string; project_id: string; merchant_scope: string; claim_id: string; claim_version: number;
  actor_id: string; session_id: string; membership_version: number; intent_id: string;
  recipient_id: string; recipient_version: number; recipient_label: string; amount_minor: string; fee_allowance_minor: string;
  actual_fee_minor: string | null; fee_state: PayableView["feeState"]; approval_id: string; request_hash: string;
  encrypted_data: string; state: PayableState; provider_status: string | null; batch_hash: string | null; item_hash: string | null;
  uncertain_create: boolean; balance_observation_id: string | null; last_code: string | null;
  lease_id: string | null; lease_until: Date | null; attempt: number; first_dispatched_at: Date | null;
  observed_at: Date | null; completed_at: Date | null; principal_paid_at: Date | null; principal_returned_at: Date | null;
  created_at: Date; updated_at: Date;
}
interface ReviewRow { id: string; tenant_id: string; project_id: string; actor_id: string; claim_id: string; claim_version: number; digest: string; encrypted_data: string; expires_at: Date }
interface ApprovalData { operation: "payout"; payableId: string; recipientActorId: string; snapshotDigest: string; requestHash: string; policyVersion: string; actorId: string; membershipVersion: number; recipientVersion: number; amountMinor: number; currency: "USD"; feeAllowanceMinor: number; expiresAt: string }
interface ApprovalRow { id: string; digest: string; expires_at: Date; revoked_at: Date | null; data: ApprovalData }
interface AllocationRow { id: string; receipt_id: string; payable_id: string; package_id: string; claim_line_id: string; amount_minor: string; initial_amount_minor: string; kind: "claim" | "fee"; state: string; revision: number }
export interface PayoutDependencies { gateway: Pick<CommerceGateway, "createPayout" | "getPayoutBatch" | "getPayoutItem" | "cancelUnclaimedPayout">; balance: BalanceReader }
const dependencies = (): PayoutDependencies => ({ gateway: commerceGateway(), balance: liveBalanceReader });
const context = (row: Pick<PayableRow, "tenant_id" | "project_id" | "id">) => `payable:${row.tenant_id}:${row.project_id}:${row.id}`;
const privatePayable = (row: PayableRow): PayableData => openPrivate(row.encrypted_data, context(row));
const reviewContext = (row: Pick<ReviewRow, "tenant_id" | "project_id" | "id">) => `payout-review:${row.tenant_id}:${row.project_id}:${row.id}`;
const safeProviderId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{5,128}$/.test(value);

async function recipientRow(tx: SqlConnection, tenantId: string, actorId: string, lock = false): Promise<RecipientRow | null> {
  return (await query<RecipientRow>(`SELECT * FROM fp_recipient_accounts WHERE tenant_id=$1 AND actor_id=$2${lock ? " FOR UPDATE" : ""}`, [tenantId, actorId], tx))[0] ?? null;
}
function assertRecipient(row: RecipientRow | null, now = Date.now()): asserts row is RecipientRow {
  if (!row || row.verification_method !== "paypal_identity" || !row.account_verified) throw new DomainError("RECIPIENT_NOT_VERIFIED", "The claimant must link their own verified PayPal account before repayment.", 409);
  if (row.verified_at.getTime() > now || now - row.verified_at.getTime() > RECIPIENT_VERIFICATION_MS) throw new DomainError("RECIPIENT_VERIFICATION_EXPIRED", "The claimant needs a fresh PayPal account verification. Verification lasts seven days for this payment policy.", 409);
}
async function snapshot(tx: SqlConnection, session: Session, claim: ClaimRow, data: ClaimPrivateData, lineIds: string[], payableId: string | null): Promise<PayoutSnapshot> {
  const membership = await requireCurrentRole(session, "organizer", tx);
  if (session.mode !== "live_sandbox") throw new DomainError("LIVE_PAYOUT_REQUIRED", "Repayment requires a live sandbox workspace and actual collected funding.", 409);
  await requireMembership(session.tenantId, session.projectId, claim.actor_id, "volunteer", tx);
  const document = await requireDocument(session, claim.document_id, tx);
  if (document.state !== "ready" || document.sha256 !== data.sourceHash || document.version !== data.sourceDocumentVersion) throw new DomainError("CLAIM_SOURCE_CHANGED", "The claim's source changed after its review.", 409);
  const recipient = await recipientRow(tx, session.tenantId, claim.actor_id, true); assertRecipient(recipient);
  const destination = openDestination(recipient.encrypted_destination, session.tenantId, claim.actor_id);
  const [group] = await query<{ version: number; reviewed_total_minor: string | null; currency: string }>("SELECT version,reviewed_total_minor,currency FROM fp_receipt_groups WHERE id=$1 FOR UPDATE", [claim.group_id], tx);
  if (!group || group.currency !== "USD" || !group.reviewed_total_minor || !data.review || Number(group.reviewed_total_minor) !== data.review.sourceTotalMinor)
    throw new DomainError("RECEIPT_BUDGET_CHANGED", "The receipt's shared review budget changed.", 409);
  const funding = await planPayoutFunding(tx, session, claim, data, lineIds, payableId);
  return { policyVersion: PAYOUT_POLICY_VERSION, claimId: claim.id, claimVersion: claim.version, claimantActorId: claim.actor_id,
    claimDigest: sha256(canonicalJson(data)), documentId: document.id, sourceHash: document.sha256!, documentVersion: document.version,
    sourceClass: document.provenance, groupId: claim.group_id, groupVersion: group.version, reviewedTotalMinor: Number(group.reviewed_total_minor),
    membershipVersion: membership.membershipVersion, recipient: { id: recipient.id, version: recipient.version, label: recipient.masked_label,
      verifiedAt: recipient.verified_at.toISOString(), destinationHash: sha256(destination) }, funding, payableId };
}
function reviewView(row: ReviewRow, value: PayoutSnapshot, title: string): PayoutReviewView {
  return { id: row.id, digest: row.digest, expiresAt: row.expires_at.toISOString(), claimId: row.claim_id, claimVersion: row.claim_version,
    title, amountMinor: value.funding.amountMinor, currency: "USD", feeAllowanceMinor: value.funding.feeAllowanceMinor,
    recipient: { label: value.recipient.label, verifiedAt: value.recipient.verifiedAt, version: value.recipient.version }, sourceClass: value.sourceClass,
    lines: value.funding.lines, funding: value.funding.packages.map(pkg => ({ packageId: pkg.packageId, packageTitle: pkg.packageTitle,
      amountMinor: pkg.principalMinor, feeAllowanceMinor: pkg.feeAllowanceMinor,
      receiptCount: new Set(value.funding.allocations.filter(allocation => allocation.packageId === pkg.packageId).map(allocation => allocation.receiptId)).size })), payableId: value.payableId };
}
async function payableRow(scope: Pick<Session, "tenantId" | "projectId">, id: string, tx: SqlConnection = database(), lock = false): Promise<PayableRow> {
  const [row] = await query<PayableRow>(`SELECT * FROM fp_payables WHERE id=$1 AND tenant_id=$2 AND project_id=$3${lock ? " FOR UPDATE" : ""}`, [id, scope.tenantId, scope.projectId], tx);
  if (!row) throw new DomainError("PAYABLE_NOT_FOUND", "This repayment is not available in the current workspace.", 404);
  return row;
}
export async function preparePayoutReview(session: Session, claimId: string, raw: z.infer<typeof payoutSelectionSchema>): Promise<PayoutReviewView> {
  const input = payoutSelectionSchema.parse(raw);
  return database().transaction(async tx => {
    await requireCurrentRole(session, "organizer", tx); await projectClaimLock(tx, session.projectId);
    const claim = await requireClaim(session, claimId, tx, true), data = claimPrivate(claim);
    if (claim.version !== input.expectedVersion) throw new DomainError("CLAIM_VERSION_CHANGED", "Reload the latest expense review before preparing payment.", 409);
    if (input.payableId) {
      const current = await payableRow(session, input.payableId, tx, true), original = privatePayable(current);
      if (current.claim_id !== claimId || !["reserved", "unknown", "refused", "not_sent"].includes(current.state) || original.snapshot.funding.lines.map(line => line.id).sort().join() !== [...input.lineIds].sort().join())
        throw new DomainError("PAYOUT_REVIEW_CONFLICT", "Renew only the same unresolved repayment and its exact original lines.", 409);
    }
    const value = await snapshot(tx, session, claim, data, input.lineIds, input.payableId ?? null), id = randomUUID(), digest = payoutReviewDigest(value);
    const policyRules = value.payableId ? [] : await enforceProjectFundDecision(tx, session, { consumer: "payable_approval", packages: value.funding.packages.map(pkg => ({ packageId: pkg.packageId, expenseMinor: pkg.principalMinor, feeMinor: pkg.feeAllowanceMinor })) });
    const [row] = await query<ReviewRow>(`INSERT INTO fp_payable_reviews(id,tenant_id,project_id,actor_id,claim_id,claim_version,digest,encrypted_data,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [id, session.tenantId, session.projectId, session.actorId, claim.id, claim.version,
      digest, sealPrivate(value, reviewContext({ id, tenant_id: session.tenantId, project_id: session.projectId })), new Date(Date.now() + PAYOUT_APPROVAL_MS)], tx);
    if (!value.payableId) await recordProjectPolicyReview(tx, session, id, digest, policyRules);
    return reviewView(row, value, data.title);
  });
}
async function insertApproval(tx: SqlConnection, session: Session, payableId: string, value: PayoutSnapshot, requestHash: string): Promise<ApprovalRow> {
  const id = randomUUID(), expiresAt = new Date(Date.now() + PAYOUT_APPROVAL_MS).toISOString();
  const data: ApprovalData = { operation: "payout", payableId, recipientActorId: value.claimantActorId, snapshotDigest: payoutReviewDigest(value), requestHash,
    policyVersion: PAYOUT_POLICY_VERSION, actorId: session.actorId, membershipVersion: value.membershipVersion,
    recipientVersion: value.recipient.version, amountMinor: value.funding.amountMinor, currency: "USD", feeAllowanceMinor: value.funding.feeAllowanceMinor, expiresAt };
  const digest = sha256(canonicalJson(data));
  return (await query<ApprovalRow>(`INSERT INTO fp_approval_records(id,tenant_id,project_id,actor_id,resource_id,resource_version,digest,expires_at,data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`, [id, session.tenantId, session.projectId, session.actorId, value.claimId, value.claimVersion, digest, expiresAt, JSON.stringify(data)], tx))[0];
}
async function recordAllocation(tx: SqlConnection, row: AllocationRow, reason: string, previousId: string | null = null): Promise<void> {
  await tx.query(`INSERT INTO fp_allocation_revisions(id,allocation_id,revision,receipt_id,payable_id,package_id,purpose,amount_minor,state,reason,reversal_of)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [randomUUID(), row.id, row.revision, row.receipt_id, row.payable_id, row.package_id,
    row.kind === "fee" ? "provider_fee" : "reviewed_expense", Number(row.amount_minor), row.state, reason, previousId]);
}
export async function approvePayout(session: Session, claimId: string, raw: z.infer<typeof payoutApprovalSchema>): Promise<PayableView> {
  const input = payoutApprovalSchema.parse(raw);
  const id = await database().transaction(async tx => {
    await requireCurrentRole(session, "organizer", tx); await projectClaimLock(tx, session.projectId);
    const [existing] = await query<{ payable_id: string; project_id: string; input_hash: string; claim_id: string }>("SELECT i.*,p.claim_id FROM fp_payable_approval_intents i JOIN fp_payables p ON p.id=i.payable_id WHERE i.tenant_id=$1 AND i.actor_id=$2 AND i.intent_id=$3", [session.tenantId, session.actorId, input.intentId], tx);
    if (existing) {
      if (existing.project_id !== session.projectId || existing.claim_id !== claimId || existing.input_hash !== sha256(canonicalJson(input))) throw new DomainError("PAYOUT_INTENT_CHANGED", "This approval already belongs to a different exact review.", 409);
      return existing.payable_id;
    }
    const [review] = await query<ReviewRow>("SELECT * FROM fp_payable_reviews WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND actor_id=$4 AND claim_id=$5", [input.reviewId, session.tenantId, session.projectId, session.actorId, claimId], tx);
    if (!review || review.expires_at.getTime() <= Date.now() || review.digest !== input.reviewDigest) throw new DomainError("PAYOUT_REVIEW_EXPIRED", "Prepare a current exact payment review before approving it.", 409);
    const shown = openPrivate<PayoutSnapshot>(review.encrypted_data, reviewContext(review));
    const claim = await requireClaim(session, claimId, tx, true), data = claimPrivate(claim);
    const value = await snapshot(tx, session, claim, data, shown.funding.lines.map(line => line.id), shown.payableId);
    const policyRules = shown.payableId ? [] : await enforceProjectFundDecision(tx, session, { consumer: "payable_approval", packages: value.funding.packages.map(pkg => ({ packageId: pkg.packageId, expenseMinor: pkg.principalMinor, feeMinor: pkg.feeAllowanceMinor })) });
    if (!shown.payableId) await assertProjectPolicyReview(tx, session, review.id, review.digest, policyRules);
    if (payoutReviewDigest(shown) !== review.digest || payoutReviewDigest(value) !== review.digest || input.amountMinor !== value.funding.amountMinor)
      throw new DomainError("PAYOUT_REVIEW_CHANGED", "A source, recipient, package, allocation or authority changed. Review the updated payment before approving it.", 409);
    if (value.sourceClass === "sample_document" && !input.sampleAcknowledged) throw new DomainError("SAMPLE_ACK_REQUIRED", "This source is fictional. Acknowledge the repayment as a sandbox test.", 422);
    const recipient = await recipientRow(tx, session.tenantId, claim.actor_id, true); assertRecipient(recipient);
    const receiver = openDestination(recipient.encrypted_destination, session.tenantId, claim.actor_id);
    if (shown.payableId) {
      const row = await payableRow(session, shown.payableId, tx, true), old = privatePayable(row);
      if (!['reserved','unknown','refused','not_sent'].includes(row.state) || old.request.items[0]?.receiver !== receiver || row.recipient_version !== recipient.version
        || canonicalJson(old.snapshot.funding) !== canonicalJson(value.funding)) throw new DomainError("ORIGINAL_PAYOUT_CHANGED", "This original repayment cannot be redirected or replaced. Keep its reservations and reconcile it.", 409);
      await tx.query("UPDATE fp_approval_records SET revoked_at=now() WHERE id=$1", [row.approval_id]);
      const approval = await insertApproval(tx, session, row.id, value, row.request_hash);
      await tx.query("UPDATE fp_payables SET approval_id=$2,actor_id=$3,session_id=$4,membership_version=$5,encrypted_data=$6,updated_at=now() WHERE id=$1", [row.id, approval.id, session.actorId, session.id, value.membershipVersion, sealPrivate({ ...old, snapshot: value }, context(row))]);
      await tx.query("INSERT INTO fp_payable_approval_intents(tenant_id,project_id,actor_id,intent_id,payable_id,review_id,input_hash) VALUES($1,$2,$3,$4,$5,$6,$7)", [session.tenantId, session.projectId, session.actorId, input.intentId, row.id, review.id, sha256(canonicalJson(input))]);
      await appendEvent(tx, session, "payout.approval_renewed", "The original repayment was reviewed again", "Its recipient, selected lines, amount and provider request identity remain the same. No new Payout was created.");
      return row.id;
    }
    const id = randomUUID(), request: CreatePayout = { senderBatchId: `fp_${sha256(id).slice(0, 28)}`, requestId: randomUUID(), items: [
      { senderItemId: `expense_${sha256(`${id}:${claim.id}`).slice(0, 28)}`, recipientType: "PAYPAL_ID", receiver, money: { currency: "USD", minor: value.funding.amountMinor } },
    ] };
    const requestHash = sha256(canonicalJson(request)), approval = await insertApproval(tx, session, id, value, requestHash);
    const privateData: PayableData = { request, snapshot: value, batchId: null, itemId: null, candidateBatchIds: [], candidateItemIds: [] };
    await tx.query(`INSERT INTO fp_payables(id,tenant_id,project_id,merchant_scope,claim_id,claim_version,actor_id,session_id,membership_version,intent_id,
      recipient_id,recipient_version,recipient_label,amount_minor,fee_allowance_minor,approval_id,request_hash,encrypted_data)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [id, session.tenantId, session.projectId, payoutMerchantScope(), claim.id, claim.version,
      session.actorId, session.id, value.membershipVersion, input.intentId, recipient.id, recipient.version, recipient.masked_label, value.funding.amountMinor,
      value.funding.feeAllowanceMinor, approval.id, requestHash, sealPrivate(privateData, context({ id, tenant_id: session.tenantId, project_id: session.projectId }))]);
    await bindProjectPolicyArtifacts(tx, policyRules, "payable_approval", id, requestHash, session);
    for (const line of value.funding.lines) await tx.query("INSERT INTO fp_payable_lines(payable_id,claim_id,claim_line_id,amount_minor,package_id) VALUES($1,$2,$3,$4,$5)", [id, claim.id, line.id, line.amountMinor, line.packageId]);
    await tx.query("INSERT INTO fp_payable_approval_intents(tenant_id,project_id,actor_id,intent_id,payable_id,review_id,input_hash) VALUES($1,$2,$3,$4,$5,$6,$7)", [session.tenantId, session.projectId, session.actorId, input.intentId, id, review.id, sha256(canonicalJson(input))]);
    for (const allocation of value.funding.allocations) {
      const [last] = await query<{ revision: number }>("SELECT COALESCE(max(revision),0)::integer AS revision FROM fp_receipt_allocations WHERE claim_id=$1 AND claim_line_id=$2 AND receipt_id=$3", [claim.id, allocation.lineId, allocation.receiptId], tx);
      const [created] = await query<AllocationRow>(`INSERT INTO fp_receipt_allocations(id,tenant_id,project_id,receipt_id,claim_id,claim_line_id,package_id,amount_minor,initial_amount_minor,state,revision,payable_id,kind)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,'reserved',$9,$10,$11) RETURNING *`, [randomUUID(), session.tenantId, session.projectId, allocation.receiptId, claim.id,
        allocation.lineId, allocation.packageId, allocation.amountMinor, last.revision + 1, id, allocation.kind], tx);
      await recordAllocation(tx, created, "Current separate payment approval");
    }
    await tx.query("UPDATE fp_claims SET state='approved',updated_at=now() WHERE id=$1", [claim.id]);
    await appendEvent(tx, session, "payout.approved", "A separate exact repayment is approved", "The reviewed lines, PayPal recipient and eligible source amounts are reserved. A fresh balance check and provider item success are still required.");
    return id;
  });
  return payableView(session, id);
}

export async function payableView(session: Session, id: string): Promise<PayableView> {
  const row = await payableRow(session, id), data = privatePayable(row);
  await requireClaim(session, row.claim_id);
  const [approval] = await query<ApprovalRow>("SELECT * FROM fp_approval_records WHERE id=$1", [row.approval_id]);
  const [balance] = row.balance_observation_id ? await query<{ observed_at: Date; as_of_time: Date | null; last_refresh_time: Date | null; code: string | null }>("SELECT observed_at,as_of_time,last_refresh_time,code FROM fp_balance_observations WHERE id=$1", [row.balance_observation_id]) : [];
  const expired = !approval || !!approval.revoked_at || approval.expires_at.getTime() <= Date.now();
  const organizer = session.role === "organizer", leased = !!row.lease_until && row.lease_until.getTime() > Date.now();
  const inDuplicateWindow = !row.first_dispatched_at || Date.now() - row.first_dispatched_at.getTime() < PAYOUT_DUPLICATE_WINDOW_MS;
  return { id: row.id, claimId: row.claim_id, claimVersion: row.claim_version, state: row.state, amountMinor: Number(row.amount_minor), currency: "USD",
    feeAllowanceMinor: Number(row.fee_allowance_minor), actualFeeMinor: row.actual_fee_minor === null ? null : Number(row.actual_fee_minor), feeState: row.fee_state,
    lineIds: data.snapshot.funding.lines.map(line => line.id), recipientLabel: row.recipient_label, recipientVersion: row.recipient_version,
    approvalDigest: approval?.digest ?? "", approvalExpiresAt: approval?.expires_at.toISOString() ?? row.created_at.toISOString(), createdAt: row.created_at.toISOString(),
    dispatchedAt: row.first_dispatched_at?.toISOString() ?? null, observedAt: row.observed_at?.toISOString() ?? null, completedAt: row.completed_at?.toISOString() ?? null,
    providerStatus: row.provider_status, code: row.last_code, providerItemReference: data.itemId,
    balance: balance ? { observedAt: balance.observed_at.toISOString(), asOfTime: balance.as_of_time?.toISOString() ?? null,
      lastRefreshTime: balance.last_refresh_time?.toISOString() ?? null, code: balance.code ?? (row.last_code?.startsWith("BALANCE_") ? row.last_code : null) } : null,
    canSend: organizer && row.state === "reserved" && !expired && !leased,
    canRetryOriginal: organizer && ["unknown", "refused", "not_sent"].includes(row.state) && !expired && !leased && inDuplicateWindow && !data.batchId && data.candidateBatchIds.length === 0,
    canCheck: !!(data.batchId || data.candidateBatchIds.length || row.first_dispatched_at), canCancelUnclaimed: organizer && row.state === "unclaimed" && !leased,
    canRelease: organizer && ["reserved", "refused", "not_sent"].includes(row.state) && !row.uncertain_create && !data.batchId && data.candidateBatchIds.length === 0 && !leased,
    requiresNewApproval: expired && ["reserved", "unknown", "refused", "not_sent"].includes(row.state) };
}
export async function claimPaymentView(session: Session, claimId: string): Promise<ClaimPaymentView> {
  const claim = await requireClaim(session, claimId), data = claimPrivate(claim);
  const rows = await query<PayableRow>("SELECT * FROM fp_payables WHERE claim_id=$1 AND tenant_id=$2 AND project_id=$3 ORDER BY created_at", [claimId, session.tenantId, session.projectId]);
  const payables = await Promise.all(rows.map(row => payableView(session, row.id)));
  const recipient = await recipientRow(database(), session.tenantId, claim.actor_id);
  let recipientUsable = false; try { assertRecipient(recipient); recipientUsable = true; } catch { /* The projection states what still needs verification. */ }
  const readiness=await database().transaction(async tx=>{
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    return canonicalExpenseReadiness(tx,session);
  });
  const lines: ClaimPaymentView["lines"] = [];
  for (const line of data.lines) {
    const relevant = rows.filter(row => privatePayable(row).snapshot.funding.lines.some(item => item.id === line.id));
    const paidMinor = relevant.filter(row => row.principal_paid_at && !row.principal_returned_at).reduce((sum, row) => sum + privatePayable(row).snapshot.funding.lines.find(item => item.id === line.id)!.amountMinor, 0);
    const reservedMinor = relevant.filter(row => !row.principal_paid_at && !["returned", "failed", "cancelled"].includes(row.state)).reduce((sum, row) => sum + privatePayable(row).snapshot.funding.lines.find(item => item.id === line.id)!.amountMinor, 0);
    const fundingReady=readiness.get(line.packageId??"")?.ready??false;
    lines.push({ id: line.id, approvedMinor: line.approvedMinor, paidMinor, reservedMinor, availableMinor: Math.max(0, line.approvedMinor - paidMinor - reservedMinor), fundingReady,
      code: line.decision !== "approved" ? "LINE_NOT_APPROVED" : paidMinor > 0 ? "LINE_REPAID" : reservedMinor > 0 ? "LINE_ALREADY_PAYABLE" : !fundingReady ? readiness.get(line.packageId??"")?.code??"PACKAGE_NOT_FUNDED" : null });
  }
  return { payables, lines, recipient: recipient ? { label: recipient.masked_label, verifiedAt: recipient.verified_at.toISOString(), version: recipient.version, usable: recipientUsable } : null };
}
async function assertCurrentPayoutAuthority(tx: SqlConnection, session: Session, row: PayableRow, data: PayableData): Promise<void> {
  const role = await requireCurrentRole(session, "organizer", tx);
  if (row.merchant_scope !== payoutMerchantScope() || row.actor_id !== session.actorId || row.session_id !== session.id || role.membershipVersion !== row.membership_version)
    throw new DomainError("PAYOUT_AUTHORITY_CHANGED", "The current organizer must review the original repayment again before dispatch.", 409);
  const [approval] = await query<ApprovalRow>("SELECT * FROM fp_approval_records WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR UPDATE", [row.approval_id, session.tenantId, session.projectId], tx);
  if (!approval || approval.revoked_at || approval.expires_at.getTime() <= Date.now() || approval.data.policyVersion !== PAYOUT_POLICY_VERSION
    || approval.digest !== sha256(canonicalJson(approval.data)) || approval.data.snapshotDigest !== payoutReviewDigest(data.snapshot)
    || approval.data.requestHash !== row.request_hash || approval.data.amountMinor !== Number(row.amount_minor) || approval.data.recipientVersion !== row.recipient_version)
    throw new DomainError("PAYOUT_APPROVAL_EXPIRED", "The exact payment approval expired, changed or was revoked. Review the original repayment again.", 409);
  if (data.request.items.length !== 1 || data.request.items[0].money.currency !== "USD" || data.request.items[0].money.minor !== Number(row.amount_minor)
    || sha256(canonicalJson(data.request)) !== row.request_hash || data.request.items[0].recipientType !== "PAYPAL_ID")
    throw new DomainError("PAYOUT_REQUEST_CHANGED", "The immutable PayPal request could not be verified.", 409);
  const claim = await requireClaim(session, row.claim_id, tx, true), current = await snapshot(tx, session, claim, claimPrivate(claim), data.snapshot.funding.lines.map(line => line.id), row.id);
  current.payableId = data.snapshot.payableId;
  if (payoutReviewDigest(current) !== payoutReviewDigest(data.snapshot) || sha256(data.request.items[0].receiver) !== current.recipient.destinationHash)
    throw new DomainError("PAYOUT_REVIEW_CHANGED", "The current claim, source, recipient, package or shared receipt review differs from the payment approval.", 409);
  const allocations = await query<AllocationRow>("SELECT * FROM fp_receipt_allocations WHERE payable_id=$1 AND state='reserved' ORDER BY receipt_id,claim_line_id", [row.id], tx);
  const simplify = (items: PlannedAllocation[]) => items.map(item => ({ receiptId: item.receiptId, lineId: item.lineId, amountMinor: item.amountMinor, kind: item.kind, packageId: item.packageId })).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  if (canonicalJson(simplify(data.snapshot.funding.allocations)) !== canonicalJson(simplify(allocations.map(item => ({ receiptId: item.receipt_id, lineId: item.claim_line_id,
    amountMinor: Number(item.amount_minor), kind: item.kind, packageId: item.package_id, packageVersion: 0, receiptVersion: 0, receiptDigest: "", purpose: "" })))))
    throw new DomainError("PAYOUT_RESERVATION_CHANGED", "The repayment's exact receipt reservations are no longer intact.", 409);
}
async function assertLiquidity(tx: SqlConnection, row: PayableRow, balance: BalanceEvidence): Promise<void> {
  assertUsableBalance(balance);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`payout-liquidity:${row.merchant_scope}`]);
  const [priorAccount] = await query<{ account_hash: string }>("SELECT account_hash FROM fp_balance_observations WHERE merchant_scope=$1 AND account_hash IS NOT NULL AND account_hash<>$2 LIMIT 1", [row.merchant_scope, sha256(balance.accountId)], tx);
  if (priorAccount) throw new DomainError("BALANCE_ACCOUNT_CHANGED", "The merchant account behind balance observations changed. Reconcile the account before spending.", 409);
  const [other] = await query<{ total: string }>(`SELECT COALESCE(sum(
    CASE WHEN principal_paid_at IS NULL AND state NOT IN ('returned','failed','cancelled') THEN amount_minor
      WHEN principal_paid_at>$3 AND (principal_returned_at IS NULL OR principal_returned_at>$3) THEN amount_minor ELSE 0 END
    + CASE WHEN fee_state IN ('reserved','review_required') THEN GREATEST(fee_allowance_minor,COALESCE(actual_fee_minor,0))
      WHEN fee_state='confirmed' AND observed_at>$3 THEN COALESCE(actual_fee_minor,0) ELSE 0 END),0) AS total
    FROM fp_payables WHERE merchant_scope=$1 AND id<>$2`, [row.merchant_scope, row.id, balance.asOfTime], tx);
  const [refunds] = await query<{ total: string }>("SELECT COALESCE(sum(amount_minor),0) AS total FROM fp_refunds WHERE state<>'completed' OR completed_at>$1", [balance.asOfTime], tx);
  const required = Number(row.amount_minor) + Number(row.fee_allowance_minor) + Number(other.total) + Number(refunds.total);
  if (!Number.isSafeInteger(required) || required > balance.availableMinor)
    throw new DomainError("BALANCE_ALLOWANCE_UNAVAILABLE", "The observed available balance cannot cover this repayment, its fee allowance and other known reservations. The expense remains reserved.", 409);
}

async function refreshClaimPaymentState(tx: SqlConnection, claimId: string): Promise<void> {
  const [claim] = await query<{ approved_minor: string }>("SELECT approved_minor FROM fp_claims WHERE id=$1", [claimId], tx);
  const rows = await query<PayableRow>("SELECT * FROM fp_payables WHERE claim_id=$1", [claimId], tx);
  const paid = rows.filter(row => row.principal_paid_at && !row.principal_returned_at).reduce((sum, row) => sum + Number(row.amount_minor), 0);
  const unresolved = rows.filter(row => !row.principal_returned_at && !row.principal_paid_at && !["failed", "cancelled"].includes(row.state));
  const state = unresolved.some(row => ["unknown", "review_required", "refused", "not_sent", "blocked", "held"].includes(row.state)) ? "payout_review"
    : unresolved.some(row => row.state !== "reserved") ? "paying" : unresolved.length ? "approved"
      : paid >= Number(claim.approved_minor) && paid > 0 ? "paid" : paid > 0 ? "partially_paid" : "reviewed";
  await tx.query("UPDATE fp_claims SET state=$2,updated_at=now() WHERE id=$1", [claimId, state]);
}
async function changeAllocation(tx: SqlConnection, row: AllocationRow, state: string, amount: number, reason: string): Promise<AllocationRow> {
  if (row.state === state && Number(row.amount_minor) === amount) return row;
  const [previous] = await query<{ id: string }>("SELECT id FROM fp_allocation_revisions WHERE allocation_id=$1 ORDER BY revision DESC LIMIT 1", [row.id], tx);
  const [updated] = await query<AllocationRow>(`UPDATE fp_receipt_allocations SET state=$2,amount_minor=$3,
    revision=(SELECT COALESCE(max(a.revision),0)+1 FROM fp_receipt_allocations a WHERE a.claim_id=fp_receipt_allocations.claim_id AND a.claim_line_id=fp_receipt_allocations.claim_line_id AND a.receipt_id=fp_receipt_allocations.receipt_id)
    WHERE id=$1 RETURNING *`, [row.id, state, amount], tx);
  await recordAllocation(tx, updated, reason, previous?.id ?? null);
  return updated;
}
async function journalAllocation(tx: SqlConnection, row: PayableRow, allocation: AllocationRow, amount: number, returning = false): Promise<void> {
  if (!amount) return;
  const kind = allocation.kind === "fee" ? "provider_fee" : "reimbursement", prefix = `${row.id}:${allocation.id}:${returning ? "return" : "paid"}`;
  const expense = allocation.kind === "fee" ? "provider_fee_expense" : "reviewed_expense";
  for (const [account, side] of [[expense, returning ? "credit" : "debit"], ["provider_cash", returning ? "debit" : "credit"]]) {
    await tx.query(`INSERT INTO fp_journal(id,tenant_id,project_id,receipt_id,account,side,amount_minor,currency,operation_id,entry_kind)
      VALUES($1,$2,$3,$4,$5,$6,$7,'USD',$8,$9) ON CONFLICT(id) DO NOTHING`, [`${prefix}:${side}`, row.tenant_id, row.project_id, allocation.receipt_id, account, side, amount, row.id, returning ? `${kind}_return` : kind]);
  }
}
function feePortions(allocations: AllocationRow[], amount: number): Map<string, number> {
  const total = allocations.reduce((sum, allocation) => sum + Number(allocation.initial_amount_minor), 0);
  if (amount < 0 || amount > total || !Number.isSafeInteger(amount)) throw new DomainError("FEE_ALLOCATION_INVALID", "The observed fee needs separate reconciliation.", 409);
  if (!total) return new Map();
  const values = allocations.map(allocation => ({ id: allocation.id,
    amount: Number(BigInt(amount) * BigInt(allocation.initial_amount_minor) / BigInt(total)),
    remainder: BigInt(amount) * BigInt(allocation.initial_amount_minor) % BigInt(total) }));
  let left = amount - values.reduce((sum, value) => sum + value.amount, 0);
  values.sort((a, b) => a.remainder === b.remainder ? a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1);
  for (const value of values) if (left-- > 0) value.amount++;
  return new Map(values.map(value => [value.id, value.amount]));
}
async function applySuccessfulFee(tx: SqlConnection, row: PayableRow, allocations: AllocationRow[], fee: number | null): Promise<void> {
  if (fee === null) { await tx.query("UPDATE fp_payables SET fee_state='review_required',last_code='PAYOUT_FEE_UNPROVEN' WHERE id=$1", [row.id]); return; }
  if (row.actual_fee_minor !== null) {
    if (Number(row.actual_fee_minor) !== fee) await tx.query("UPDATE fp_payables SET fee_state='review_required',last_code='PAYOUT_FEE_CHANGED' WHERE id=$1", [row.id]);
    return;
  }
  const covered = Math.min(fee, Number(row.fee_allowance_minor)), portions = feePortions(allocations.filter(item => item.kind === "fee"), covered);
  for (const allocation of allocations.filter(item => item.kind === "fee")) {
    const actual = portions.get(allocation.id) ?? 0;
    const updated = await changeAllocation(tx, allocation, actual ? "paid" : "released", actual || Number(allocation.amount_minor), "Fresh item success established the actual fee; unused allowance released");
    if (actual) await journalAllocation(tx, row, updated, actual);
  }
  const uncovered = fee - covered;
  if (uncovered) {
    for (const [account, side] of [["unallocated_provider_fee", "debit"], ["provider_cash", "credit"]])
      await tx.query("INSERT INTO fp_merchant_journal(id,merchant_scope,payable_id,account,side,amount_minor,currency) VALUES($1,$2,$3,$4,$5,$6,'USD') ON CONFLICT(id) DO NOTHING", [`${row.id}:fee-exception:${side}`, row.merchant_scope, row.id, account, side, uncovered]);
  }
  await tx.query("UPDATE fp_payables SET actual_fee_minor=$2,fee_state=$3,last_code=$4 WHERE id=$1", [row.id, fee, uncovered ? "review_required" : "confirmed", uncovered ? "PAYOUT_FEE_EXCEEDS_ALLOWANCE" : null]);
}
async function lockPayableSources(tx: SqlConnection, row: PayableRow): Promise<AllocationRow[]> {
  await lockFundingScope({tenantId:row.tenant_id,projectId:row.project_id},tx);
  return query<AllocationRow>("SELECT * FROM fp_receipt_allocations WHERE payable_id=$1 ORDER BY receipt_id,claim_line_id FOR UPDATE", [row.id], tx);
}
async function persistObservation(tx: SqlConnection, row: PayableRow, kind: string, result: unknown, outcome: string, code: string | null, leaseId: string | null = null): Promise<void> {
  const id = randomUUID();
  await tx.query(`INSERT INTO fp_payout_observations(id,payable_id,kind,attempt,lease_id,outcome,code,body_hash,encrypted_data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, row.id, kind, row.attempt, leaseId, outcome, code, sha256(canonicalJson(result)),
    sealPrivate(result, `payout-observation:${row.tenant_id}:${row.project_id}:${row.id}:${id}`)]);
}
async function retainProviderResult(scope: Pick<Session, "tenantId" | "projectId">, id: string, result: CommerceRestResult<PayoutBatchObservation>, leaseId: string): Promise<void> {
  await database().transaction(async tx => {
    await projectClaimLock(tx, scope.projectId);
    const row = await payableRow(scope, id, tx, true), data = privatePayable(row);
    await persistObservation(tx, row, "create", result, result.outcome, result.outcome === "succeeded" ? null : result.code, leaseId);
    // Retain the candidate encrypted before any domain response validation. It
    // is an owned request's candidate, not yet a proven batch or item identity.
    const batchId = result.outcome === "succeeded" ? result.value.id : result.originalPayoutBatchId;
    if (safeProviderId(batchId) && !data.candidateBatchIds.includes(batchId)) data.candidateBatchIds.push(batchId);
    if (result.outcome === "succeeded") for (const item of result.value.items) if (safeProviderId(item.id) && !data.candidateItemIds.includes(item.id)) data.candidateItemIds.push(item.id);
    await tx.query("UPDATE fp_payables SET encrypted_data=$2,updated_at=now() WHERE id=$1", [id, sealPrivate(data, context(row))]);
    if (row.lease_id !== leaseId || row.principal_paid_at || row.principal_returned_at) return;
    const uncertain = row.uncertain_create || result.outcome === "unknown" || result.outcome === "succeeded" || !!batchId;
    const state = data.batchId ? row.state : uncertain ? "unknown" : result.outcome;
    await tx.query("UPDATE fp_payables SET state=$2,uncertain_create=$3,lease_id=NULL,lease_until=NULL,last_code=$4,updated_at=now() WHERE id=$1", [id, state, uncertain, result.outcome === "succeeded" ? "PAYOUT_ITEM_READ_REQUIRED" : result.code]);
    await refreshClaimPaymentState(tx, row.claim_id);
  });
}

function matchesItem(item: PayoutItemObservation, request: CreatePayout, batchId: string): boolean {
  const expected = request.items[0];
  return request.items.length === 1 && safeProviderId(item.id) && item.batchId === batchId && item.senderItemId === expected.senderItemId
    && item.recipientType === expected.recipientType && item.receiver === expected.receiver
    && item.money.currency === "USD" && item.money.minor === expected.money.minor;
}
function assertBatch(batch: PayoutBatchObservation, request: CreatePayout, candidateId: string): PayoutItemObservation {
  if (batch.id !== candidateId || batch.senderBatchId !== request.senderBatchId || !batch.complete || batch.items.length !== 1
    || !matchesItem(batch.items[0], request, batch.id) || batch.money && (batch.money.currency !== "USD" || batch.money.minor !== request.items[0].money.minor))
    throw new DomainError("PAYOUT_BATCH_IDENTITY_UNPROVEN", "The current complete batch does not match this exact approved repayment. Its reservation remains in place.", 409);
  return batch.items[0];
}
async function applyItem(scope: Pick<Session, "tenantId" | "projectId">, id: string, batch: PayoutBatchObservation, result: CommerceRestResult<PayoutItemObservation>): Promise<void> {
  await database().transaction(async tx => {
    await projectClaimLock(tx, scope.projectId);
    const row = await payableRow(scope, id, tx, true), data = privatePayable(row);
    if (result.outcome !== "succeeded" || result.source !== "live_sandbox") {
      await tx.query("UPDATE fp_payables SET last_code=$2,checked_at=now() WHERE id=$1", [id, result.outcome === "succeeded" ? "PAYOUT_SOURCE_UNPROVEN" : result.code]); return;
    }
    const item = result.value, expected = assertBatch(batch, data.request, batch.id);
    if (row.merchant_scope !== payoutMerchantScope() || !matchesItem(item, data.request, batch.id) || expected.id !== item.id || data.batchId && data.batchId !== batch.id || data.itemId && data.itemId !== item.id)
      throw new DomainError("PAYOUT_ITEM_IDENTITY_UNPROVEN", "The independently read item does not match the exact recipient, amount and original batch.", 409);
    const [collision] = await query<{ id: string }>("SELECT id FROM fp_payables WHERE id<>$1 AND (batch_hash=$2 OR item_hash=$3)", [id, sha256(batch.id), sha256(item.id)], tx);
    if (collision) throw new DomainError("PAYOUT_IDENTITY_ALREADY_OWNED", "This provider item is already attached to another repayment. Keep both for review.", 409);
    data.batchId = batch.id; data.itemId = item.id;
    await tx.query("UPDATE fp_payables SET batch_hash=$2,item_hash=$3,encrypted_data=$4,provider_status=$5,observed_at=$6,checked_at=now(),lease_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1", [id, sha256(batch.id), sha256(item.id), sealPrivate(data, context(row)), item.status, result.observedAt]);
    const allocations = await lockPayableSources(tx, row), eventScope = { tenantId: row.tenant_id, projectId: row.project_id, mode: "live_sandbox" as const };
    if (item.status === "SUCCESS") {
      if (row.principal_returned_at) {
        await tx.query("UPDATE fp_payables SET last_code='PAYOUT_TERMINAL_CONFLICT' WHERE id=$1", [id]); return;
      }
      if (!safeProviderId(item.transactionId)) {
        await tx.query("UPDATE fp_payables SET state='review_required',last_code='PAYOUT_TRANSACTION_UNPROVEN' WHERE id=$1", [id]);
        await refreshClaimPaymentState(tx, row.claim_id); return;
      }
      if (!row.principal_paid_at) {
        if (allocations.filter(allocation => allocation.kind === "claim" && allocation.state === "reserved").reduce((sum, allocation) => sum + Number(allocation.amount_minor), 0) !== Number(row.amount_minor))
          throw new DomainError("PAYOUT_PRINCIPAL_RESERVATION_LOST", "A successful item needs its exact original source reservations reconciled.", 409);
        for (const allocation of allocations.filter(allocation => allocation.kind === "claim")) {
          const updated = await changeAllocation(tx, allocation, "paid", Number(allocation.amount_minor), "Fresh owned Payout item SUCCESS");
          await journalAllocation(tx, row, updated, Number(updated.amount_minor));
        }
        await tx.query("UPDATE fp_payables SET principal_paid_at=$2,completed_at=$2 WHERE id=$1", [id, result.observedAt]);
        await appendEvent(tx, eventScope, "payout.succeeded", "PayPal confirmed the recipient repayment", "The exact owned Payout item succeeded. Its reviewed expense allocations and balanced journal entries are recorded once.");
      }
      await tx.query("UPDATE fp_payables SET state='succeeded',last_code=NULL WHERE id=$1", [id]);
      const fee = item.fee && item.fee.currency === "USD" && Number.isSafeInteger(item.fee.minor) && item.fee.minor >= 0 ? item.fee.minor : null;
      await applySuccessfulFee(tx, row, allocations, fee);
    } else if (["RETURNED", "REFUNDED", "CANCELED", "FAILED"].includes(item.status)) {
      if (item.status === "FAILED" && row.principal_paid_at && !row.principal_returned_at) {
        await tx.query("UPDATE fp_payables SET last_code='PAYOUT_TERMINAL_CONFLICT' WHERE id=$1", [id]); return;
      }
      if (!row.principal_returned_at) {
        for (const allocation of allocations.filter(allocation => allocation.kind === "claim")) {
          if (allocation.state === "paid") await journalAllocation(tx, row, allocation, Number(allocation.amount_minor), true);
          if (["reserved", "paid"].includes(allocation.state)) await changeAllocation(tx, allocation, allocation.state === "paid" ? "reversed" : "released", Number(allocation.amount_minor), `Fresh exact Payout item ${item.status}`);
        }
        await tx.query("UPDATE fp_payables SET principal_returned_at=$2 WHERE id=$1", [id, result.observedAt]);
        await appendEvent(tx, eventScope, row.principal_paid_at ? "payout.returned" : "payout.not_delivered", row.principal_paid_at ? "The recipient payment returned" : "The repayment was not delivered", "The exact provider item released the original principal. Fee reconciliation remains separate, and another payment requires a new deliberate review.");
      }
      const state = item.status === "FAILED" ? "failed" : "returned";
      if (!row.principal_paid_at && item.fee?.currency === "USD" && item.fee.minor === 0) {
        for (const allocation of allocations.filter(allocation => allocation.kind === "fee" && allocation.state === "reserved")) await changeAllocation(tx, allocation, "released", Number(allocation.amount_minor), "The returned or failed item reports zero fee");
        await tx.query("UPDATE fp_payables SET fee_state='released',actual_fee_minor=0,last_code=NULL WHERE id=$1", [id]);
      } else if (row.fee_state !== "confirmed" && row.fee_state !== "released") await tx.query("UPDATE fp_payables SET fee_state='review_required',last_code='PAYOUT_RETURN_FEE_UNPROVEN' WHERE id=$1", [id]);
      await tx.query("UPDATE fp_payables SET state=$2 WHERE id=$1", [id, state]);
    } else if (row.principal_paid_at || row.principal_returned_at) {
      await tx.query("UPDATE fp_payables SET last_code='PAYOUT_OLDER_STATE_IGNORED' WHERE id=$1", [id]);
    } else {
      const state: PayableState = item.status === "UNCLAIMED" ? "unclaimed" : item.status === "ONHOLD" || item.status === "HELD" ? "held" : item.status === "BLOCKED" ? "blocked" : ["PENDING", "PROCESSING", "NEW"].includes(item.status) ? "pending" : "review_required";
      await tx.query("UPDATE fp_payables SET state=$2,last_code=$3 WHERE id=$1", [id, state, state === "review_required" ? "PAYOUT_STATUS_REQUIRES_REVIEW" : null]);
    }
    await refreshClaimPaymentState(tx, row.claim_id);
  });
}
async function readOriginalPayout(scope: Pick<Session, "tenantId" | "projectId">, id: string, deps: PayoutDependencies): Promise<void> {
  let row = await payableRow(scope, id), data = privatePayable(row);
  if (row.merchant_scope !== payoutMerchantScope()) throw new DomainError("PAYOUT_MERCHANT_CHANGED", "Use the original isolated merchant to reconcile this repayment.", 409);
  if (row.state === "submitting" && row.lease_until && row.lease_until.getTime() <= Date.now()) {
    await database().transaction(async tx => {
      await projectClaimLock(tx, scope.projectId);
      await tx.query("UPDATE fp_payables SET state='unknown',uncertain_create=true,lease_id=NULL,lease_until=NULL,last_code='PAYOUT_RESPONSE_UNCERTAIN' WHERE id=$1 AND state='submitting' AND lease_until<=now()", [id]);
      await refreshClaimPaymentState(tx, row.claim_id);
    });
    row = await payableRow(scope, id); data = privatePayable(row);
  }
  const batchId = data.batchId ?? (data.candidateBatchIds.length === 1 ? data.candidateBatchIds[0] : null);
  if (!batchId) {
    const code = data.candidateBatchIds.length > 1 ? "PAYOUT_CANDIDATES_AMBIGUOUS" : row.first_dispatched_at && Date.now() - row.first_dispatched_at.getTime() >= PAYOUT_DUPLICATE_WINDOW_MS ? "PAYOUT_DUPLICATE_WINDOW_EXPIRED" : "PAYOUT_ORIGINAL_BATCH_UNRESOLVED";
    await query("UPDATE fp_payables SET last_code=$2,checked_at=now() WHERE id=$1", [id, code]); return;
  }
  try {
    const result = await deps.gateway.getPayoutBatch(batchId, data.request.senderBatchId, AbortSignal.timeout(15_000));
    await database().transaction(async tx => {
      const current = await payableRow(scope, id, tx, true);
      await persistObservation(tx, current, "batch_read", result, result.outcome, result.outcome === "succeeded" ? null : result.code);
      await tx.query("UPDATE fp_payables SET checked_at=now() WHERE id=$1", [id]);
    });
    if (result.outcome !== "succeeded" || result.source !== "live_sandbox") throw new DomainError("PAYOUT_BATCH_READ_UNAVAILABLE", "The original provider batch could not be confirmed. Its reservation remains in place.", 503);
    const item = assertBatch(result.value, data.request, batchId);
    // Persist the candidate before a later item fetch can fail or the process can exit.
    await database().transaction(async tx => {
      const current = await payableRow(scope, id, tx, true), retained = privatePayable(current);
      if (!retained.candidateItemIds.includes(item.id)) retained.candidateItemIds.push(item.id);
      await tx.query("UPDATE fp_payables SET encrypted_data=$2 WHERE id=$1", [id, sealPrivate(retained, context(current))]);
    });
    const read = await deps.gateway.getPayoutItem(item.id, AbortSignal.timeout(15_000));
    await database().transaction(async tx => {
      const current = await payableRow(scope, id, tx, true);
      await persistObservation(tx, current, "item_read", read, read.outcome, read.outcome === "succeeded" ? null : read.code);
    });
    await applyItem(scope, id, result.value, read);
  } catch (error) {
    const code = error instanceof DomainError ? error.code : "PAYOUT_READ_UNAVAILABLE";
    await query("UPDATE fp_payables SET last_code=$2,checked_at=now() WHERE id=$1", [id, code]);
  }
}

export async function checkPayout(session: Session, id: string, deps: PayoutDependencies = dependencies()): Promise<PayableView> {
  const row = await payableRow(session, id); await requireClaim(session, row.claim_id);
  await readOriginalPayout(session, id, deps);
  return payableView(session, id);
}
export async function sendPayout(session: Session, id: string, retryOriginal = false, deps: PayoutDependencies = dependencies()): Promise<PayableView> {
  await requireCurrentRole(session, "organizer");
  const initial = await payableRow(session, id); await requireClaim(session, initial.claim_id);
  const data = privatePayable(initial);
  if (data.batchId || data.candidateBatchIds.length) return checkPayout(session, id, deps);
  if (initial.state !== "reserved" && !(retryOriginal && ["unknown", "refused", "not_sent"].includes(initial.state)))
    throw new DomainError("PAYOUT_STATE_CHANGED", "This repayment needs an original-status check or a separate deliberate retry.", 409);
  if (initial.first_dispatched_at && Date.now() - initial.first_dispatched_at.getTime() >= PAYOUT_DUPLICATE_WINDOW_MS)
    throw new DomainError("PAYOUT_DUPLICATE_WINDOW_EXPIRED", "PayPal's 30-day duplicate window has ended. Keep this unresolved operation reserved for reconciliation; do not create a replacement.", 409);
  const balance = await observeBalance(deps.balance);
  await query("UPDATE fp_payables SET balance_observation_id=$2 WHERE id=$1 AND state IN ('reserved','unknown','refused','not_sent') AND (lease_until IS NULL OR lease_until<=now())", [id, balance.id]);
  if (balance.result.outcome !== "observed") {
    await query("UPDATE fp_payables SET last_code=$2 WHERE id=$1", [id, balance.result.code]);
    throw new DomainError(balance.result.code, "PayPal's available-balance observation is unavailable. The repayment remains reserved.", 503);
  }
  const leaseId = randomUUID();
  let row: PayableRow;
  try {
    row = await database().transaction(async tx => {
      await projectClaimLock(tx, session.projectId);
      const current = await payableRow(session, id, tx, true), value = privatePayable(current);
      if (current.lease_until && current.lease_until.getTime() > Date.now() || current.state !== initial.state || value.batchId || value.candidateBatchIds.length)
        throw new DomainError("PAYOUT_ALREADY_DISPATCHED", "The original repayment already advanced. Check its current status.", 409);
      await assertCurrentPayoutAuthority(tx, session, current, value);
      await assertLiquidity(tx, current, balance.result.outcome === "observed" ? balance.result.evidence : (() => { throw new Error("Balance changed"); })());
      if (current.first_dispatched_at && Date.now() - current.first_dispatched_at.getTime() >= PAYOUT_DUPLICATE_WINDOW_MS)
        throw new DomainError("PAYOUT_DUPLICATE_WINDOW_EXPIRED", "The original duplicate window ended before dispatch.", 409);
      const [claimed] = await query<PayableRow>("UPDATE fp_payables SET state='submitting',lease_id=$2,balance_observation_id=$3,lease_until=now()+interval '3 minutes',attempt=attempt+1,first_dispatched_at=COALESCE(first_dispatched_at,now()),last_code=NULL,updated_at=now() WHERE id=$1 RETURNING *", [id, leaseId, balance.id], tx);
      await persistObservation(tx, claimed, "create_dispatch", { requestHash: claimed.request_hash, approvalId: claimed.approval_id, balanceObservationId: balance.id, retryOriginal }, "claimed", null, leaseId);
      await refreshClaimPaymentState(tx, claimed.claim_id);
      return claimed;
    });
  } catch (error) {
    if (error instanceof DomainError) await query("UPDATE fp_payables SET last_code=$2 WHERE id=$1 AND state<>'submitting'", [id, error.code]);
    throw error;
  }
  let result: CommerceRestResult<PayoutBatchObservation>;
  try { result = await deps.gateway.createPayout(privatePayable(row).request, AbortSignal.timeout(25_000)); }
  catch { result = { outcome: "unknown", source: "live_sandbox", observedAt: new Date().toISOString(), httpStatus: null, debugId: null,
    code: "PAYOUT_RESPONSE_UNCERTAIN", message: "The original creation response could not be confirmed.", originalPayoutBatchId: null }; }
  await retainProviderResult(session, id, result, leaseId);
  const retained = privatePayable(await payableRow(session, id));
  if (retained.batchId || retained.candidateBatchIds.length) await readOriginalPayout(session, id, deps);
  return payableView(session, id);
}

export async function releasePayout(session: Session, id: string): Promise<PayableView> {
  await database().transaction(async tx => {
    await requireCurrentRole(session, "organizer", tx); await projectClaimLock(tx, session.projectId);
    const row = await payableRow(session, id, tx, true), data = privatePayable(row);
    await requireClaim(session, row.claim_id, tx);
    if (row.state === "cancelled") return;
    if (!["reserved", "refused", "not_sent"].includes(row.state) || row.uncertain_create || data.batchId || data.candidateBatchIds.length || row.lease_until && row.lease_until.getTime() > Date.now())
      throw new DomainError("PAYOUT_RELEASE_UNPROVEN", "An unresolved provider request cannot be released as though no payment happened. Check the original operation.", 409);
    const allocations = await lockPayableSources(tx, row);
    for (const allocation of allocations.filter(allocation => allocation.state === "reserved")) await changeAllocation(tx, allocation, "released", Number(allocation.amount_minor), "Organizer released a definitely undispatched or refused repayment");
    await tx.query("UPDATE fp_payables SET state='cancelled',fee_state='released',last_code=NULL,updated_at=now() WHERE id=$1", [id]);
    await tx.query("UPDATE fp_approval_records SET revoked_at=now() WHERE id=$1", [row.approval_id]);
    await refreshClaimPaymentState(tx, row.claim_id);
    await appendEvent(tx, session, "payout.released", "The unused repayment approval is released", "No provider payment was established. The original review remains, and a future repayment needs a new exact approval.");
  });
  return payableView(session, id);
}
export async function cancelUnclaimedPayout(session: Session, id: string, deps: PayoutDependencies = dependencies()): Promise<PayableView> {
  await requireCurrentRole(session, "organizer");
  const before = await payableRow(session, id); await requireClaim(session, before.claim_id);
  await readOriginalPayout(session, id, deps);
  const leaseId = randomUUID();
  const claimed = await database().transaction(async tx => {
    await requireCurrentRole(session, "organizer", tx); await projectClaimLock(tx, session.projectId);
    const row = await payableRow(session, id, tx, true), data = privatePayable(row);
    if (row.state !== "unclaimed" || !data.batchId || !data.itemId || row.merchant_scope !== payoutMerchantScope() || row.lease_until && row.lease_until.getTime() > Date.now()
      || !row.observed_at || Date.now() - row.observed_at.getTime() > 60_000)
      throw new DomainError("PAYOUT_NOT_UNCLAIMED", "Only an exact currently unclaimed provider item can be cancelled.", 409);
    const [updated] = await query<PayableRow>("UPDATE fp_payables SET state='cancelling',lease_id=$2,lease_until=now()+interval '3 minutes',attempt=attempt+1,last_code=NULL,updated_at=now() WHERE id=$1 RETURNING *", [id, leaseId], tx);
    await persistObservation(tx, updated, "cancel_dispatch", { batchIdHash: sha256(data.batchId), itemIdHash: sha256(data.itemId), actorId: session.actorId }, "claimed", null, leaseId);
    return { row: updated, item: { ...data.request.items[0], id: data.itemId, batchId: data.batchId } };
  });
  let result: CommerceRestResult<PayoutItemObservation>;
  try { result = await deps.gateway.cancelUnclaimedPayout(claimed.item, AbortSignal.timeout(25_000)); }
  catch { result = { outcome: "unknown", code: "PAYOUT_CANCEL_UNCERTAIN", message: "The original cancellation needs an item read.", source: "live_sandbox", observedAt: new Date().toISOString(), httpStatus: null, debugId: null, originalPayoutBatchId: null }; }
  await database().transaction(async tx => {
    await projectClaimLock(tx, session.projectId);
    const row = await payableRow(session, id, tx, true);
    await persistObservation(tx, row, "cancel", result, result.outcome, result.outcome === "succeeded" ? null : result.code, leaseId);
    await tx.query("UPDATE fp_payables SET lease_id=NULL,lease_until=NULL,last_code=$3 WHERE id=$1 AND lease_id=$2", [id, leaseId, result.outcome === "succeeded" ? "PAYOUT_RETURN_READ_REQUIRED" : result.code]);
  });
  await readOriginalPayout(session, id, deps);
  return payableView(session, id);
}

/** Signed messages are queue hints. This handler performs only provider GETs. */
export async function observeOwnedPayout(resourceId: string, kind: "batch" | "item", deps: PayoutDependencies = dependencies()): Promise<{ tenant_id: string; project_id: string }> {
  if (!safeProviderId(resourceId)) throw new DomainError("PAYOUT_RESOURCE_INVALID", "The Payout event resource is invalid.", 409);
  const [row] = await query<PayableRow>(`SELECT * FROM fp_payables WHERE merchant_scope=$1 AND ${kind === "batch" ? "batch_hash" : "item_hash"}=$2`, [payoutMerchantScope(), sha256(resourceId)]);
  if (!row || privatePayable(row)[kind === "batch" ? "batchId" : "itemId"] !== resourceId) throw new DomainError("PAYOUT_OWNERSHIP_UNRESOLVED", "This provider resource is not yet an exact owned repayment.", 409);
  await readOriginalPayout({ tenantId: row.tenant_id, projectId: row.project_id }, row.id, deps);
  const current = await payableRow({ tenantId: row.tenant_id, projectId: row.project_id }, row.id);
  if (!current.observed_at || current.observed_at.getTime() < Date.now() - 60_000 || current.last_code?.includes("UNPROVEN") || current.last_code?.includes("UNAVAILABLE") || current.last_code?.includes("CONFLICT"))
    throw new DomainError(current.last_code ?? "PAYOUT_OBSERVATION_PENDING", "The current owned Payout item still needs reconciliation.", 409);
  return { tenant_id: row.tenant_id, project_id: row.project_id };
}
/** Resume reads only; this never creates or retries a Payout. */
export async function reconcilePayouts(options: { limit?: number; deps?: PayoutDependencies } = {}): Promise<{ checked: number; financialWrites: 0 }> {
  const rows = await query<PayableRow>(`SELECT * FROM fp_payables WHERE merchant_scope=$1 AND
    (state IN ('submitting','cancelling','unknown','pending','unclaimed','held','blocked','review_required') OR fee_state='review_required')
    AND (lease_until IS NULL OR lease_until<=now()) ORDER BY checked_at NULLS FIRST,created_at LIMIT $2`, [payoutMerchantScope(), Math.max(1, Math.min(3, options.limit ?? 1))]);
  for (const row of rows) await readOriginalPayout({ tenantId: row.tenant_id, projectId: row.project_id }, row.id, options.deps ?? dependencies());
  return { checked: rows.length, financialWrites: 0 };
}
