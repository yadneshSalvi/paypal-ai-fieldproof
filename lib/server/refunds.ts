import { randomUUID } from "node:crypto";
import { canonicalJson, payloadHash, sha256, type PaymentCommand, type PaymentCore, type PaymentOperation, type ProviderAdapter, type ProviderResource, type ResourceReservation, type SqlConnection } from "@fracture/paypal-core";
import type { ApprovalRecord, SettlementReceipt } from "../contracts";
import { assertBalanced, assertMinor, DomainError, validateReceipt } from "../domain/money";
import { REFUND_POLICY, refundParentMatches, refundReceiptDigest, relatedProviderId, type RefundReason, type RefundView } from "../domain/refunds";
import type { Session } from "./auth";
import { database, initializeDatabase, query } from "./db";
import { requireCurrentRole, requireMembership } from "./membership";
import { paymentCore, paymentStore, paypalProvider } from "./payments";
import { appendEvent } from "./repository";
import { readPaymentCommand, storePaymentCommand } from "./stored-commands";

interface ReceiptRow {
  id: string; tenant_id: string; project_id: string; obligation_id: string; version: number; data: SettlementReceipt;
  actor_id: string; purpose: string; round_id: string | null; round_state: string | null; consent_session: string | null;
}
interface RefundRow {
  id: string; tenant_id: string; project_id: string; receipt_id: string; obligation_id: string; actor_id: string; session_id: string;
  approved_role: Session["role"]; reason: RefundReason; amount_minor: string; attributed_minor: string; excess_minor: string;
  state: string; operation_id: string; last_code: string | null; created_at: Date; completed_at: Date | null;
}
export interface RefundDependencies { provider: ProviderAdapter; core: PaymentCore }
function dependencies(): RefundDependencies { return { provider: paypalProvider(), core: paymentCore() }; }
async function receiptRow(scope: Pick<Session, "tenantId" | "projectId">, id: string, tx: SqlConnection = database(), lock = false): Promise<ReceiptRow> {
  if (lock) await tx.query("SELECT r.id FROM fp_collection_rounds r JOIN fp_collection_items i ON i.round_id=r.id JOIN fp_settlement_receipts sr ON sr.obligation_id=i.obligation_id WHERE sr.id=$1 AND sr.tenant_id=$2 AND sr.project_id=$3 FOR UPDATE OF r", [id, scope.tenantId, scope.projectId]);
  const [row] = await query<ReceiptRow>(`SELECT sr.*,o.actor_id,o.purpose,c.round_id,r.state round_state,c.session_id consent_session
    FROM fp_settlement_receipts sr JOIN fp_obligations o ON o.id=sr.obligation_id
    LEFT JOIN fp_conditional_consents c ON c.obligation_id=o.id LEFT JOIN fp_collection_rounds r ON r.id=c.round_id
    WHERE sr.id=$1 AND sr.tenant_id=$2 AND sr.project_id=$3 ${lock ? "FOR UPDATE OF sr,o" : ""}`, [id, scope.tenantId, scope.projectId], tx);
  if (!row) throw new DomainError("RECEIPT_NOT_FOUND", "That original receipt is outside this project.", 404);
  return row;
}
async function refundRow(scope: Pick<Session, "tenantId" | "projectId">, id: string, tx: SqlConnection = database(), lock = false): Promise<RefundRow> {
  const [row] = await query<RefundRow>(`SELECT * FROM fp_refunds WHERE id=$1 AND tenant_id=$2 AND project_id=$3 ${lock ? "FOR UPDATE" : ""}`, [id, scope.tenantId, scope.projectId], tx);
  if (!row) throw new DomainError("REFUND_NOT_FOUND", "That refund is outside this project.", 404);
  return row;
}
function view(row: RefundRow): RefundView {
  return { id: row.id, receiptId: row.receipt_id, obligationId: row.obligation_id, amountMinor: Number(row.amount_minor), attributedMinor: Number(row.attributed_minor), excessMinor: Number(row.excess_minor), reason: row.reason, state: row.state, createdAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null, lastCode: row.last_code, canRetry: ["refused", "not_sent"].includes(row.state) };
}
export async function refundViews(session: Session): Promise<RefundView[]> {
  await requireMembership(session.tenantId, session.projectId, session.actorId, session.role);
  const rows = await query<RefundRow>(`SELECT f.* FROM fp_refunds f JOIN fp_obligations o ON o.id=f.obligation_id WHERE f.tenant_id=$1 AND f.project_id=$2 AND ($3::boolean OR o.actor_id=$4) ORDER BY f.created_at DESC`, [session.tenantId, session.projectId, ["organizer", "auditor"].includes(session.role), session.actorId]);
  return rows.map(view);
}

export async function readRefundBudget(receipt: SettlementReceipt, provider: ProviderAdapter): Promise<ResourceReservation> {
  if (receipt.provenance !== "live_sandbox" || receipt.refundAdapter !== "capture_refund" || !receipt.provenRefundableRef) throw new DomainError("REFUND_RAIL_UNQUALIFIED", "The financial refund adapter for this settlement still needs corroboration.");
  const captureId = receipt.provenRefundableRef;
  const capture = (await provider.read("capture", captureId, AbortSignal.timeout(15000))).find(resource => resource.kind === "capture" && resource.id === captureId && resource.source === "live_sandbox");
  if (!capture?.money || capture.money.currency !== "USD" || capture.money.minor !== receipt.grossSettledMinor || !["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(capture.status)) throw new DomainError("REFUND_CAPTURE_UNPROVEN", "The current capture does not establish this receipt's refund budget.");
  const orderId = receipt.sourceOrderId ?? relatedProviderId(capture, "/v2/checkout/orders/"), refunds: ProviderResource[] = [];
  if (orderId) {
    const resources = await provider.read("order", orderId, AbortSignal.timeout(15000));
    if (!resources.some(resource => resource.kind === "order" && resource.id === orderId && resource.source === "live_sandbox") || !resources.some(resource => resource.kind === "capture" && resource.id === captureId && resource.source === "live_sandbox")) throw new DomainError("REFUND_ORDER_UNPROVEN", "The capture is absent from its proven owning order.");
    const reported = resources.filter(resource => resource.kind === "refund");
    if (new Set(reported.map(resource => resource.id)).size !== reported.length) throw new DomainError("REFUND_HISTORY_UNPROVEN", "The refund history is ambiguous.");
    for (const candidate of reported) {
      const current = (await provider.read("refund", candidate.id, AbortSignal.timeout(15000))).find(resource => resource.kind === "refund" && resource.id === candidate.id && resource.source === "live_sandbox");
      if (!current || !relatedProviderId(current, "/v2/payments/captures/") && current.parentId !== captureId) throw new DomainError("REFUND_HISTORY_UNPROVEN", "A refund cannot yet be attributed to its exact capture.");
      if (refundParentMatches(current, captureId)) refunds.push(current);
    }
  }
  let consumed = 0;
  for (const refund of refunds) {
    if (!["COMPLETED", "PENDING"].includes(refund.status)) continue;
    if (!refund.money || refund.money.currency !== "USD") throw new DomainError("REFUND_HISTORY_UNPROVEN", "A provider refund amount could not be corroborated.");
    consumed += refund.money.minor;
  }
  if (capture.status === "PARTIALLY_REFUNDED" && consumed <= 0) throw new DomainError("REFUND_HISTORY_UNPROVEN", "A partly refunded capture needs its actual refund history before another refund.");
  if (capture.status === "REFUNDED") consumed = Math.max(consumed, capture.money.minor);
  assertMinor(consumed);
  return { resourceKey: `capture:${captureId}`, currency: "USD", totalMinor: capture.money.minor, externallyConsumedMinor: consumed,
    observedProviderIds: refunds.filter(resource => ["COMPLETED", "PENDING"].includes(resource.status)).map(resource => resource.id), observedAt: new Date().toISOString() };
}

async function reserveRefund(session: Session, input: { receiptId: string; intentId: string; amountMinor: number; reason: RefundReason; preapproved?: true }, deps: RefundDependencies): Promise<RefundRow> {
  assertMinor(input.amountMinor, false);
  const initial = await receiptRow(session, input.receiptId);
  if (session.mode !== "live_sandbox") throw new DomainError("LIVE_REFUND_REQUIRED", "A financial refund requires an actual sandbox settlement.");
  if (!input.preapproved) {
    if (!["donor", "organizer"].includes(session.role)) throw new DomainError("ROLE_DENIED", "A donor or organizer must deliberately approve the exact refund.", 403);
    await requireCurrentRole(session, session.role);
    if (session.role === "donor" && initial.actor_id !== session.actorId) throw new DomainError("RECEIPT_NOT_FOUND", "The original contribution does not belong to you.", 404);
  } else if (input.reason === "requested") throw new DomainError("REFUND_APPROVAL_REQUIRED", "An ordinary refund requires a current exact review.");
  const [prior] = await query<RefundRow>("SELECT * FROM fp_refunds WHERE tenant_id=$1 AND receipt_id=$2 AND intent_id=$3", [session.tenantId, input.receiptId, input.intentId]);
  if (prior) {
    if (Number(prior.amount_minor) !== input.amountMinor || prior.reason !== input.reason) throw new DomainError("REFUND_CONFLICT", "This refund request already has a different immutable amount or purpose.");
    return prior;
  }
  const budget = await readRefundBudget(initial.data, deps.provider);
  return database().transaction(async tx => {
    const owner = await receiptRow(session, input.receiptId, tx, true), receipt = owner.data;
    if (!input.preapproved) await requireCurrentRole(session, session.role, tx);
    const [existing] = await query<RefundRow>("SELECT * FROM fp_refunds WHERE tenant_id=$1 AND receipt_id=$2 AND intent_id=$3", [session.tenantId, input.receiptId, input.intentId], tx);
    if (existing) {
      if (Number(existing.amount_minor) !== input.amountMinor || existing.reason !== input.reason) throw new DomainError("REFUND_CONFLICT", "The original refund request is immutable.");
      return existing;
    }
    if (refundReceiptDigest(receipt) !== refundReceiptDigest(initial.data)) throw new DomainError("RECEIPT_CHANGED", "Read the current original receipt before requesting a refund.");
    if (["incomplete_round", "package_cancelled"].includes(input.reason) && owner.round_state !== "compensating") throw new DomainError("COMPENSATION_NOT_APPROVED", "The original collection rule does not currently authorize compensation.");
    if (input.reason === "requested" && owner.purpose !== "sandbox_test" && owner.round_state !== "compensating") throw new DomainError("CANCELLATION_REVIEW_REQUIRED", "Review cancellation of the unspent package before returning a conditional contribution.");
    const [allocated] = await query<{ total: string }>("SELECT COALESCE(sum(amount_minor),0) total FROM fp_receipt_allocations WHERE receipt_id=$1 AND state IN ('reserved','paid')", [receipt.id], tx);
    const [pending] = await query<{ total: string }>("SELECT COALESCE(sum(excess_minor),0) total FROM fp_refunds WHERE receipt_id=$1 AND state<>'completed'", [receipt.id], tx);
    const availableCredit = receipt.creditedMinor - receipt.completedAttributedRefundMinor - receipt.pendingAttributedRefundReserveMinor - Number(allocated.total);
    const availableExcess = Math.max(0, receipt.excessLiabilityMinor - Number(pending.total));
    const excess = input.reason === "excess_return" ? input.amountMinor : Math.min(availableExcess, input.amountMinor), attributed = input.amountMinor - excess;
    if (excess > availableExcess || attributed > availableCredit || input.amountMinor + budget.externallyConsumedMinor > budget.totalMinor) throw new DomainError("REFUND_EXCEEDS_AVAILABLE", "This amount is already spent, reserved, refunded, or outside the original receipt.");
    const id = randomUUID(), operationId = randomUUID(), expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const approval: ApprovalRecord = { id: randomUUID(), tenantId: session.tenantId, actorId: session.actorId, operation: "refund_capture", resourceId: receipt.id, resourceVersion: owner.version, amountMinor: input.amountMinor, currency: "USD", recipientVersion: null, policyHash: REFUND_POLICY, digest: "", expiresAt, revokedAt: null };
    approval.digest = sha256(canonicalJson(approval));
    const action: PaymentCommand["action"] = { kind: "refund_capture", captureId: receipt.provenRefundableRef!, money: { currency: "USD", minor: input.amountMinor }, ...(receipt.sourceOrderId ? { orderId: receipt.sourceOrderId } : {}) };
    const command: PaymentCommand = { scope: { tenantId: session.tenantId, projectId: session.projectId }, operationId, businessKey: `refund:${receipt.id}:${input.intentId}`, intentId: receipt.donorObligationId, providerRequestId: randomUUID(), action, payloadHash: payloadHash(action), approval: { id: approval.id, version: approval.resourceVersion, digest: approval.digest, expiresAt } };
    await tx.query("INSERT INTO fp_approval_records(id,tenant_id,project_id,actor_id,resource_id,resource_version,digest,expires_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)", [approval.id, session.tenantId, session.projectId, session.actorId, receipt.id, owner.version, approval.digest, expiresAt, JSON.stringify(approval)]);
    await tx.query(`INSERT INTO fp_refunds(id,tenant_id,project_id,receipt_id,obligation_id,actor_id,session_id,approved_role,intent_id,reason,amount_minor,attributed_minor,excess_minor,receipt_version,receipt_identity_digest,approval_digest,operation_id,budget,observed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)`, [id, session.tenantId, session.projectId, receipt.id, receipt.donorObligationId, session.actorId, session.id, session.role, input.intentId, input.reason, input.amountMinor, attributed, excess, owner.version, refundReceiptDigest(receipt), approval.digest, operationId, JSON.stringify(budget), budget.observedAt]);
    await tx.query("INSERT INTO fp_payment_commands(operation_id,tenant_id,project_id,obligation_id,session_id,business_key,payload_hash,command) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)", [operationId, session.tenantId, session.projectId, receipt.donorObligationId, session.id, command.businessKey, command.payloadHash, JSON.stringify(storePaymentCommand(command))]);
    receipt.pendingAttributedRefundReserveMinor += attributed;
    receipt.excludedMinor = Math.max(0, receipt.excludedMinor - attributed);
    validateReceipt(receipt);
    await tx.query("UPDATE fp_settlement_receipts SET data=$2::jsonb WHERE id=$1", [receipt.id, JSON.stringify(receipt)]);
    if (attributed) {
      await tx.query("UPDATE fp_conditional_consents SET status='refunding' WHERE obligation_id=$1", [receipt.donorObligationId]);
      await tx.query("UPDATE fp_collection_items SET state='refund_pending' WHERE obligation_id=$1", [receipt.donorObligationId]);
    }
    await appendEvent(tx, session, "refund.reserved", "The exact refund is reserved", "This amount is held out of spendable funds while the original payment route confirms the refund. A request is not a completed refund.");
    return refundRow(session, id, tx);
  });
}

export async function ingestRefundOperation(operation: PaymentOperation): Promise<void> {
  const command = operation.command;
  if (command.action.kind !== "refund_capture") throw new DomainError("REFUND_COMMAND_REQUIRED", "This observation is not an original-rail refund.");
  const [reference] = await query<{ id: string; receipt_id: string; command: PaymentCommand }>("SELECT f.id,f.receipt_id,pc.command FROM fp_refunds f JOIN fp_payment_commands pc ON pc.operation_id=f.operation_id WHERE f.operation_id=$1 AND f.tenant_id=$2 AND f.project_id=$3", [command.operationId, command.scope.tenantId, command.scope.projectId]);
  if (!reference || canonicalJson(readPaymentCommand(reference.command)) !== canonicalJson(command)) throw new DomainError("REFUND_OWNER_UNPROVEN", "The refund operation has no exact stored receipt owner.");
  const action = command.action;
  const resources = operation.receipt?.resources.filter(resource => resource.kind === "refund") ?? [];
  const refund = resources.length === 1 ? resources[0] : undefined;
  const verified = refund && refund.source === "live_sandbox" && refund.money?.currency === "USD" && refund.money.minor === action.money.minor
    && refundParentMatches(refund, action.captureId) && (!refund.customId || refund.customId === command.operationId);
  await database().transaction(async tx => {
    const owner = await receiptRow(command.scope, reference.receipt_id, tx, true), receipt = owner.data;
    const row = await refundRow(command.scope, reference.id, tx, true);
    if (row.state === "completed") return;
    if (!verified || refund.status !== "COMPLETED") {
      const state = ["refused", "not_sent"].includes(operation.status) ? operation.status : "pending_reconciliation";
      await tx.query("UPDATE fp_refunds SET state=$2,last_code=$3 WHERE id=$1", [row.id, state, operation.error?.kind ?? (verified ? `REFUND_${refund!.status}` : "REFUND_IDENTITY_UNPROVEN")]);
      return;
    }
    const attributed = Number(row.attributed_minor), excess = Number(row.excess_minor);
    if (receipt.pendingAttributedRefundReserveMinor < attributed || receipt.excessLiabilityMinor < excess) throw new DomainError("REFUND_RESERVATION_CHANGED", "The reserved refund accounting needs reconciliation before it can be completed.");
    receipt.pendingAttributedRefundReserveMinor -= attributed;
    receipt.completedAttributedRefundMinor += attributed;
    receipt.excessLiabilityMinor -= excess;
    validateReceipt(receipt);
    const entries = [{ account: "package_funds", side: "debit" as const, amountMinor: attributed }, { account: "excess_refund_liability", side: "debit" as const, amountMinor: excess }, { account: "paypal_clearing", side: "credit" as const, amountMinor: Number(row.amount_minor) }];
    assertBalanced(entries);
    await tx.query("UPDATE fp_refunds SET state='completed',provider_refund_hash=$2,completed_at=now(),last_code=NULL WHERE id=$1", [row.id, sha256(refund.id)]);
    await tx.query("UPDATE fp_settlement_receipts SET data=$2::jsonb WHERE id=$1", [receipt.id, JSON.stringify(receipt)]);
    for (const entry of entries) if (entry.amountMinor) await tx.query("INSERT INTO fp_journal(id,tenant_id,project_id,receipt_id,account,side,amount_minor,currency,operation_id,entry_kind) VALUES($1,$2,$3,$4,$5,$6,$7,'USD',$8,'refund')", [randomUUID(), row.tenant_id, row.project_id, receipt.id, entry.account, entry.side, entry.amountMinor, command.operationId]);
    const remaining = (await query<{ data: SettlementReceipt }>("SELECT data FROM fp_settlement_receipts WHERE obligation_id=$1", [row.obligation_id], tx)).reduce((sum, item) => sum + item.data.creditedMinor - item.data.completedAttributedRefundMinor + item.data.excessLiabilityMinor, 0);
    if (remaining === 0) {
      await tx.query("UPDATE fp_obligations SET channel='refunded' WHERE id=$1", [row.obligation_id]);
      await tx.query("UPDATE fp_conditional_consents SET status='refunded' WHERE obligation_id=$1", [row.obligation_id]);
      await tx.query("UPDATE fp_collection_items SET state='refunded' WHERE obligation_id=$1", [row.obligation_id]);
    }
    await appendEvent(tx, { ...command.scope, mode: "live_sandbox" }, "refund.completed", "PayPal confirmed the original-route refund", attributed ? "Confirmed returned value now reduces the original contribution's collected total. Its request, provider result and balanced journal remain connected." : "The uncredited excess has been returned. Legitimate contribution credit is unchanged.");
  });
}

async function executeRefund(row: RefundRow, deps: RefundDependencies, retry = false): Promise<RefundView> {
  const scope = { tenantId: row.tenant_id, projectId: row.project_id };
  const [stored] = await query<{ command: PaymentCommand }>("SELECT command FROM fp_payment_commands WHERE operation_id=$1 AND tenant_id=$2", [row.operation_id, row.tenant_id]);
  if (!stored) throw new DomainError("REFUND_COMMAND_MISSING", "The durable original refund command is unavailable.");
  const command = readPaymentCommand(stored.command), existing = await paymentStore().get(scope, row.operation_id);
  let operation: PaymentOperation;
  if (retry || !existing) {
    const owner = await receiptRow(scope, row.receipt_id), budget = await readRefundBudget(owner.data, deps.provider);
    await query("UPDATE fp_refunds SET budget=$2::jsonb,observed_at=$3 WHERE id=$1", [row.id, JSON.stringify(budget), budget.observedAt]);
    try { operation = retry && existing ? await deps.core.retry(scope, row.operation_id) : await deps.core.execute(command); }
    catch (error) {
      const concurrent = await paymentStore().get(scope, row.operation_id);
      if (!concurrent) throw error;
      operation = concurrent;
    }
  } else operation = await deps.core.reconcile(scope, row.operation_id);
  await ingestRefundOperation(operation);
  await query("UPDATE fp_refunds SET checked_at=now() WHERE id=$1", [row.id]);
  return view(await refundRow(scope, row.id));
}
export async function requestRefund(session: Session, input: { receiptId: string; intentId: string; amountMinor: number; acknowledged: true }, deps: RefundDependencies = dependencies()): Promise<RefundView> {
  await initializeDatabase();
  if (input.acknowledged !== true) throw new DomainError("REFUND_APPROVAL_REQUIRED", "Review and approve the exact original-route refund.");
  return executeRefund(await reserveRefund(session, { ...input, reason: "requested" }, deps), deps);
}
export async function checkRefund(session: Session, id: string, retry = false, deps: RefundDependencies = dependencies()): Promise<RefundView> {
  const allowed = await refundViews(session);
  if (!allowed.some(row => row.id === id)) throw new DomainError("REFUND_NOT_FOUND", "This refund is outside your allowed receipt records.", 404);
  const row = await refundRow(session, id);
  if (retry) {
    if (!["donor", "organizer"].includes(session.role)) throw new DomainError("ROLE_DENIED", "A current approver must review a retry of the same refund.", 403);
    await requireCurrentRole(session, session.role);
    if (!["refused", "not_sent"].includes(row.state)) throw new DomainError("REFUND_RECONCILE_REQUIRED", "An uncertain or completed refund must not be sent again.");
  }
  return executeRefund(row, deps, retry);
}

/** The original acknowledged rule returns only this receipt's unallocated value. */
export async function compensateReceipt(scope: Pick<Session, "tenantId" | "projectId">, receiptId: string, reason: "incomplete_round" | "package_cancelled" | "excess_return", deps: RefundDependencies = dependencies()): Promise<RefundView | null> {
  const owner = await receiptRow(scope, receiptId), receipt = owner.data;
  if (!owner.consent_session || !owner.round_id) throw new DomainError("COMPENSATION_OWNER_UNPROVEN", "This receipt has no original conditional consent authority.");
  const [sessionRow] = await query<{ expires_at: Date }>("SELECT expires_at FROM fp_sessions WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND actor_id=$4", [owner.consent_session, scope.tenantId, scope.projectId, owner.actor_id]);
  if (!sessionRow) throw new DomainError("COMPENSATION_OWNER_UNPROVEN", "The original participant record is unavailable.");
  const session: Session = { ...scope, id: owner.consent_session, actorId: owner.actor_id, role: "donor", mode: "live_sandbox", expiresAt: sessionRow.expires_at.toISOString() };
  const intentId = `policy:${owner.round_id}:${reason}`;
  const [existing] = await query<RefundRow>("SELECT * FROM fp_refunds WHERE receipt_id=$1 AND intent_id=$2", [receiptId, intentId]);
  if (existing) return executeRefund(existing, deps);
  const amountMinor = reason === "excess_return" ? receipt.excessLiabilityMinor : receipt.creditedMinor - receipt.completedAttributedRefundMinor - receipt.pendingAttributedRefundReserveMinor + receipt.excessLiabilityMinor;
  if (amountMinor <= 0) return null;
  return executeRefund(await reserveRefund(session, { receiptId, intentId, amountMinor, reason, preapproved: true }, deps), deps);
}

export async function reconcileRefunds(limit = 2, deps: RefundDependencies = dependencies()): Promise<number> {
  const rows = await query<RefundRow>("SELECT * FROM fp_refunds WHERE state NOT IN ('completed','refused','not_sent') ORDER BY checked_at NULLS FIRST,created_at LIMIT $1", [Math.max(1, Math.min(3, limit))]);
  for (const row of rows) await executeRefund(row, deps);
  return rows.length;
}

/** Match an owned immutable request; a merchant-wide event alone never assigns a refund. */
export async function observeOwnedRefund(providerRefundId: string, deps: RefundDependencies = dependencies()) {
  const resources = await deps.provider.read("refund", providerRefundId, AbortSignal.timeout(12000));
  const resource = resources.find(item => item.kind === "refund" && item.id === providerRefundId && item.source === "live_sandbox");
  if (!resource) throw new DomainError("REFUND_READ_UNAVAILABLE", "The current exact refund could not be read.");
  const rows = await query<RefundRow>("SELECT * FROM fp_refunds WHERE provider_refund_hash=$1 OR operation_id=$2", [sha256(providerRefundId), resource.customId ?? null]);
  if (rows.length !== 1) throw new DomainError("REFUND_OWNERSHIP_UNRESOLVED", "The refund does not yet match one owned original payment request.");
  const row = rows[0], scope = { tenantId: row.tenant_id, projectId: row.project_id };
  const existing = await paymentStore().get(scope, row.operation_id);
  if (!existing || existing.command.action.kind !== "refund_capture" || !refundParentMatches(resource, existing.command.action.captureId)) throw new DomainError("REFUND_OWNERSHIP_UNRESOLVED", "The refund's original capture is not corroborated.");
  // This event path is read-only even if the durable write was never dispatched.
  // Unknown original requests are not sent again from a webhook.
  await ingestRefundOperation(await deps.core.reconcile(scope, row.operation_id));
  await query("UPDATE fp_refunds SET checked_at=now() WHERE id=$1", [row.id]);
  return { tenant_id: row.tenant_id, project_id: row.project_id };
}
