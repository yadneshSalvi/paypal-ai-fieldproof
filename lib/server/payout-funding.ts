import type { SqlConnection } from "@fracture/paypal-core";
import { canonicalJson, sha256 } from "@fracture/paypal-core";
import type { SettlementReceipt } from "../contracts";
import type { ClaimPrivateData } from "../domain/claims";
import { DomainError, fundingTotals, validateReceipt } from "../domain/money";
import { PAYOUT_FEE_ALLOWANCE_MINOR, splitFeeAllowance } from "../domain/payouts";
import type { Session } from "./auth";
import type { ClaimRow } from "./claims";
import { query } from "./db";

export interface ReviewedPayoutLine {
  id: string; description: string; amountMinor: number; packageId: string; packageVersion: number; packageTitle: string; receiptLineKey: string;
}
export interface PlannedAllocation {
  receiptId: string; receiptVersion: number; receiptDigest: string; packageId: string; packageVersion: number;
  lineId: string; amountMinor: number; kind: "claim" | "fee"; purpose: string;
}
export interface PayoutFunding {
  lines: ReviewedPayoutLine[]; amountMinor: number; feeAllowanceMinor: number; allocations: PlannedAllocation[];
  packages: { packageId: string; packageTitle: string; version: number; principalMinor: number; feeAllowanceMinor: number; roundIds: string[] }[];
}
export function allocationReceiptDigest(receipt: SettlementReceipt): string {
  return sha256(canonicalJson({ id: receipt.id, tenant: receipt.tenantId, project: receipt.projectId, package: receipt.packageId,
    obligation: receipt.donorObligationId, provider: receipt.actualProviderPaymentRef, aliases: [...receipt.economicAliases].sort(),
    source: receipt.sourceKind, currency: receipt.currency, gross: receipt.grossSettledMinor, credited: receipt.creditedMinor,
    refunded: receipt.completedAttributedRefundMinor, reserved: receipt.pendingAttributedRefundReserveMinor,
    excluded: receipt.excludedMinor, status: receipt.authoritativeObservedState, provenance: receipt.provenance }));
}
const activePayableStates = ["reserved", "submitting", "cancelling", "unknown", "refused", "not_sent", "pending", "unclaimed", "held", "blocked", "succeeded", "review_required"];
export async function reviewedPayoutLines(tx: SqlConnection, session: Pick<Session, "tenantId" | "projectId">, claim: ClaimRow, data: ClaimPrivateData, lineIds: string[], exceptPayableId: string | null = null): Promise<ReviewedPayoutLine[]> {
  if (!lineIds.length || new Set(lineIds).size !== lineIds.length) throw new DomainError("PAYOUT_LINES_REQUIRED", "Choose each reviewed expense line once.", 422);
  if (claim.currency !== "USD" || !data.review || Number(claim.approved_minor) <= 0 || !["reviewed", "approved", "partially_paid", "paying", "payout_review", "paid"].includes(claim.state))
    throw new DomainError("CLAIM_NOT_APPROVED", "An organizer must finish the USD source review before approving repayment.", 409);
  const reviews = await query<{ claim_line_id: string; package_id: string; package_version: number; source_minor: string; approved_minor: string; decision: string; review_version: number; receipt_line_key: string }>("SELECT * FROM fp_claim_line_reviews WHERE claim_id=$1", [claim.id], tx);
  const occupied = await query<{ claim_line_id: string }>(`SELECT l.claim_line_id FROM fp_payable_lines l JOIN fp_payables p ON p.id=l.payable_id
    WHERE l.claim_id=$1 AND p.state=ANY($2::text[]) AND ($3::text IS NULL OR p.id<>$3)`, [claim.id, activePayableStates, exceptPayableId], tx);
  const result: ReviewedPayoutLine[] = [];
  for (const id of [...lineIds].sort()) {
    const line = data.lines.find(line => line.id === id), review = reviews.find(line => line.claim_line_id === id);
    if (!line || !review || line.decision !== "approved" || review.decision !== "approved" || line.approvedMinor <= 0 || line.approvedMinor !== Number(review.approved_minor) || review.review_version !== claim.version || line.packageId !== review.package_id || line.receiptLineKey !== review.receipt_line_key)
      throw new DomainError("LINE_NOT_APPROVED", "Every selected line must match the current recorded source review.", 409);
    if (occupied.some(item => item.claim_line_id === id)) throw new DomainError("LINE_ALREADY_PAYABLE", "This line already has a reserved, unresolved or successful repayment. Check that original operation.", 409);
    const [pkg] = await query<{ version: number; title: string; dependencies: string[] }>("SELECT version,data->>'title' AS title,COALESCE(data->'dependencies','[]'::jsonb) AS dependencies FROM fp_packages WHERE project_id=$1 AND id=$2", [session.projectId, line.packageId], tx);
    if (!pkg || pkg.version !== review.package_version) throw new DomainError("PACKAGE_VERSION_CHANGED", "A package changed after the expense review. Review its purpose and amount again.", 409);
    if (pkg.dependencies.length) {
      const prerequisites = await query<{ id: string; accepted: string }>("SELECT id,data->>'workState' AS accepted FROM fp_packages WHERE project_id=$1 AND id=ANY($2::text[])", [session.projectId, pkg.dependencies], tx);
      if (prerequisites.length !== pkg.dependencies.length || prerequisites.some(item => item.accepted !== "accepted")) throw new DomainError("PACKAGE_PREREQUISITE", "Complete the package's required safety or dependency review before approving its spending.", 409);
    }
    result.push({ id, description: line.description, amountMinor: line.approvedMinor, packageId: review.package_id,
      packageVersion: review.package_version, packageTitle: pkg.title, receiptLineKey: line.receiptLineKey });
  }
  return result;
}

/** Caller holds the project claim lock. Round -> obligation -> receipt is also
 * the refund/cancellation lock order, so a payable and refund cannot spend the
 * same contribution while each believes the other is still only a proposal. */
export async function planPayoutFunding(tx: SqlConnection, session: Pick<Session, "tenantId" | "projectId">, claim: ClaimRow, data: ClaimPrivateData, lineIds: string[], exceptPayableId: string | null = null): Promise<PayoutFunding> {
  const lines = await reviewedPayoutLines(tx, session, claim, data, lineIds, exceptPayableId);
  const packageIds = [...new Set(lines.map(line => line.packageId))].sort();
  const principals = packageIds.map(packageId => ({ packageId, amountMinor: lines.filter(line => line.packageId === packageId).reduce((sum, line) => sum + line.amountMinor, 0) }));
  const fees = splitFeeAllowance(principals), allocations: PlannedAllocation[] = [], packages: PayoutFunding["packages"] = [];
  const rounds = await query<{ id: string; package_id: string; package_version: number; target_minor: string; state: string }>(
    "SELECT id,package_id,package_version,target_minor,state FROM fp_collection_rounds WHERE tenant_id=$1 AND project_id=$2 AND package_id=ANY($3::text[]) ORDER BY id FOR UPDATE", [session.tenantId, session.projectId, packageIds], tx);
  for (const packageId of packageIds) {
    const line = lines.find(item => item.packageId === packageId)!;
    const funded = rounds.filter(round => round.package_id === packageId && round.package_version === line.packageVersion && round.state === "funded");
    if (!funded.length) throw new DomainError("PACKAGE_NOT_FUNDED", `${line.packageTitle} has no fully collected eligible round. A shortfall cannot fund repayment.`, 409);
    const pool: { id: string; version: number; data: SettlementReceipt; available: number }[] = [];
    for (const round of funded) {
      const rows = await query<{ id: string; version: number; data: SettlementReceipt; purpose: string; allocated: string }>(`SELECT sr.id,sr.version,sr.data,o.purpose,
        (SELECT COALESCE(sum(a.amount_minor),0) FROM fp_receipt_allocations a WHERE a.receipt_id=sr.id AND a.state IN ('reserved','paid') AND ($4::text IS NULL OR a.payable_id IS DISTINCT FROM $4)) AS allocated
        FROM fp_settlement_receipts sr JOIN fp_obligations o ON o.id=sr.obligation_id JOIN fp_collection_items i ON i.obligation_id=o.id
        WHERE i.round_id=$1 AND sr.tenant_id=$2 AND sr.project_id=$3 ORDER BY sr.created_at,sr.id FOR UPDATE OF sr,o`, [round.id, session.tenantId, session.projectId, exceptPayableId], tx);
      if (!rows.length || rows.some(row => row.purpose !== "conditional_pledge" || row.data.packageId !== packageId || row.data.provenance !== "live_sandbox") || fundingTotals(rows.map(row => row.data), Number(round.target_minor), "live_sandbox").shortfallMinor !== 0)
        throw new DomainError("ROUND_FUNDING_CHANGED", "A collected round no longer has all of its eligible contribution money. Resolve its refunds or exclusions before new spending.", 409);
      for (const row of rows) {
        validateReceipt(row.data);
        const available = row.data.creditedMinor - row.data.completedAttributedRefundMinor - row.data.pendingAttributedRefundReserveMinor - row.data.excludedMinor - Number(row.allocated);
        if (available < 0) throw new DomainError("ALLOCATION_OVERDRAWN", "Existing receipt allocations need reconciliation.", 409);
        pool.push({ ...row, available });
      }
    }
    const principal = principals.find(item => item.packageId === packageId)!.amountMinor, fee = fees.get(packageId)!;
    if (pool.reduce((sum, source) => sum + source.available, 0) < principal + fee)
      throw new DomainError("PACKAGE_AVAILABLE_BUDGET", `${line.packageTitle} does not have enough unallocated eligible funding for these lines and its disclosed fee allowance.`, 409);
    const uses = [...lines.filter(item => item.packageId === packageId).map(item => ({ lineId: item.id, amount: item.amountMinor, kind: "claim" as const })), { lineId: `fee:${packageId}`, amount: fee, kind: "fee" as const }];
    for (const use of uses) {
      let remaining = use.amount;
      for (const source of pool) {
        const take = Math.min(remaining, source.available); if (!take) continue;
        allocations.push({ receiptId: source.id, receiptVersion: source.version, receiptDigest: allocationReceiptDigest(source.data), packageId,
          packageVersion: line.packageVersion, lineId: use.lineId, amountMinor: take, kind: use.kind, purpose: use.kind === "fee" ? `Provider fee allowance for ${line.packageTitle}` : line.packageTitle });
        source.available -= take; remaining -= take;
        if (!remaining) break;
      }
      if (remaining) throw new DomainError("FUNDING_RESERVATION_CONFLICT", "These sources changed while the payment was being reviewed.", 409);
    }
    packages.push({ packageId, packageTitle: line.packageTitle, version: line.packageVersion, principalMinor: principal, feeAllowanceMinor: fee, roundIds: funded.map(round => round.id).sort() });
  }
  return { lines, amountMinor: lines.reduce((sum, line) => sum + line.amountMinor, 0), feeAllowanceMinor: PAYOUT_FEE_ALLOWANCE_MINOR, allocations, packages };
}
