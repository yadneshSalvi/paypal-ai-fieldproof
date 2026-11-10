import { canonicalJson, payloadHash, type AuthorizationDecision, type PaymentCommand, type ResourceReservation } from "@fracture/paypal-core";
import type { ApprovalRecord, SettlementReceipt } from "../contracts";
import { REFUND_POLICY, refundReceiptDigest, type RefundReason } from "../domain/refunds";
import { query } from "./db";
import { requireCurrentRole } from "./membership";
import { readPaymentCommand } from "./stored-commands";
import type { Session } from "./auth";

export async function authorizeRefund(command: PaymentCommand): Promise<AuthorizationDecision> {
  const denied = (reason: string): AuthorizationDecision => ({ allowed: false, reason, resourceIds: [], currency: "USD", maximumMinor: 0, approvalId: command.approval.id, approvalVersion: command.approval.version, approvalDigest: command.approval.digest });
  const [row] = await query<{
    command: PaymentCommand; data: SettlementReceipt; receipt_version: number; receipt_identity_digest: string; approval_digest: string;
    amount_minor: string; attributed_minor: string; excess_minor: string; reason: RefundReason; actor_id: string; approved_role: Session["role"];
    session_id: string; state: string; budget: ResourceReservation; observed_at: Date; round_state: string | null;
    approval: ApprovalRecord; revoked_at: Date | null; approval_expires: Date; mode: Session["mode"]; expires_at: Date;
  }>(`SELECT pc.command,sr.data,f.receipt_version,f.receipt_identity_digest,f.approval_digest,f.amount_minor,f.attributed_minor,f.excess_minor,
    f.reason,f.actor_id,f.approved_role,f.session_id,f.state,f.budget,f.observed_at,r.state round_state,
    a.data approval,a.revoked_at,a.expires_at approval_expires,t.mode,s.expires_at
    FROM fp_refunds f JOIN fp_payment_commands pc ON pc.operation_id=f.operation_id
    JOIN fp_settlement_receipts sr ON sr.id=f.receipt_id JOIN fp_obligations o ON o.id=f.obligation_id
    LEFT JOIN fp_collection_items i ON i.obligation_id=o.id LEFT JOIN fp_collection_rounds r ON r.id=i.round_id
    JOIN fp_approval_records a ON a.id=(pc.command->'approval'->>'id') JOIN fp_tenants t ON t.id=f.tenant_id
    JOIN fp_sessions s ON s.id=f.session_id WHERE f.operation_id=$1 AND f.tenant_id=$2 AND f.project_id=$3`, [command.operationId, command.scope.tenantId, command.scope.projectId]);
  if (!row || row.mode !== "live_sandbox" || command.action.kind !== "refund_capture") return denied("This command has no owned live refund approval.");
  const receipt = row.data, action = command.action;
  if (receipt.provenance !== "live_sandbox" || receipt.refundAdapter !== "capture_refund" || receipt.provenRefundableRef !== action.captureId || refundReceiptDigest(receipt) !== row.receipt_identity_digest) return denied("The original receipt or refund rail changed.");
  if (row.state === "completed" || canonicalJson(readPaymentCommand(row.command)) !== canonicalJson(command) || payloadHash(action) !== command.payloadHash) return denied("The immutable refund request changed or is already completed.");
  if (action.money.currency !== "USD" || action.money.minor !== Number(row.amount_minor) || Number(row.attributed_minor) > receipt.pendingAttributedRefundReserveMinor || Number(row.excess_minor) > receipt.excessLiabilityMinor) return denied("The exact refund reservation is no longer available.");
  const approval = row.approval;
  if (row.revoked_at || row.approval_expires.getTime() <= Date.now() || approval.policyHash !== REFUND_POLICY || approval.digest !== command.approval.digest || approval.digest !== row.approval_digest || approval.resourceId !== receipt.id || approval.resourceVersion !== row.receipt_version) return denied("The approved refund amount or authority is no longer valid.");
  if (["incomplete_round", "package_cancelled"].includes(row.reason)) {
    if (row.round_state !== "compensating") return denied("This round does not currently authorize compensation.");
  } else if (row.reason === "excess_return") {
    if (Number(row.attributed_minor) !== 0 || Number(row.excess_minor) <= 0) return denied("An excess return may not consume legitimate contribution credit.");
  } else {
    try { await requireCurrentRole({ ...command.scope, id: row.session_id, actorId: row.actor_id, role: row.approved_role, mode: row.mode, expiresAt: row.expires_at.toISOString() }, row.approved_role); }
    catch { return denied("The current refund approver no longer has authority."); }
  }
  const budget = row.budget;
  if (Date.now() - row.observed_at.getTime() > 60000 || budget.resourceKey !== `capture:${action.captureId}` || budget.currency !== "USD" || budget.totalMinor !== receipt.grossSettledMinor) return denied("Refresh the exact capture and refund budget before dispatch.");
  return { allowed: true, reason: "Exact original-rail refund with reserved receipt value", resourceIds: [action.captureId, ...(action.orderId ? [action.orderId] : [])], currency: "USD", maximumMinor: Number(row.amount_minor), approvalId: approval.id, approvalVersion: approval.resourceVersion, approvalDigest: approval.digest, reservation: budget };
}
