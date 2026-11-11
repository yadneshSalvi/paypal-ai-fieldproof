import type { SqlConnection } from "@fracture/paypal-core";
import { canonicalJson, sha256 } from "@fracture/paypal-core";
import type { FundingState, SettlementReceipt } from "../contracts";
import type { ClaimPrivateData } from "../domain/claims";
import { DomainError } from "../domain/money";
import { assertCurrentFundingLots, projectFundingLots, type FundingJournal, type FundingLot } from "../domain/funding-lots";
import { packagePositionTotals, projectFundingPositions } from "../domain/funding-positions";
import { assessPackageFunding } from "../domain/package-funding";
import { PAYOUT_FEE_ALLOWANCE_MINOR, splitFeeAllowance } from "../domain/payouts";
import type { Session } from "./auth";
import type { ClaimRow } from "./claims";
import { query } from "./db";
import { lockFundingScope, readFundingJournal, readFundingOrigins } from "./funding-positions";
import { assertCommittedFundingChoices } from "./funding-authority";

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
/** Preserve every byte of historical unassigned approvals. Assigned sources
 * additionally bind the complete journal, current deduction attribution and
 * versioned lots, but never their own payout reservation or paid counters. */
export function currentFundingReceiptDigest(receipt: SettlementReceipt, journal: FundingJournal, lots: FundingLot[], packageId: string): string {
  const assignments=journal.assignments.filter(entry=>entry.receiptId===receipt.id);
  if (!assignments.length) return allocationReceiptDigest(receipt);
  return sha256(canonicalJson({version:"expense-funding-v2",original:allocationReceiptDigest(receipt),packageId,
    assignments:assignments.sort((a,b)=>a.sequence-b.sequence),deductions:journal.deductions.find(row=>row.receiptId===receipt.id)??null,
    lots:lots.filter(lot=>lot.receiptId===receipt.id).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)}));
}
export async function canonicalExpenseReadiness(tx: SqlConnection, session: Pick<Session,"tenantId"|"projectId"|"mode">): Promise<Map<string,{ready:boolean;code:string|null}>> {
  const packages=await query<{id:string;version:number;budget_minor:string;state:FundingState}>("SELECT id,version,budget_minor,data->>'fundingState' state FROM fp_packages WHERE project_id=$1",[session.projectId],tx);
  const result=new Map(packages.map(pkg=>[pkg.id,{ready:false,code:"PACKAGE_NOT_FUNDED" as string|null}]));
  if (session.mode!=="live_sandbox") return result;
  try {
    const scope={tenantId:session.tenantId,projectId:session.projectId,provenance:session.mode},journal=await readFundingJournal(scope,tx);
    const projection=projectFundingPositions(journal,scope),lots=projectFundingLots(journal,scope,await readFundingOrigins(scope,tx));
    await assertCommittedFundingChoices(scope,journal.assignments,tx);
    const rounds=await query<{id:string;package_id:string;package_version:number;state:string;target_minor:string}>("SELECT id,package_id,package_version,state,target_minor FROM fp_collection_rounds WHERE tenant_id=$1 AND project_id=$2 ORDER BY collection_started_at DESC,id DESC",[session.tenantId,session.projectId],tx);
    for (const pkg of packages) {
      const round=rounds.find(round=>round.package_id===pkg.id&&round.package_version===pkg.version);
      const totals=packagePositionTotals(projection.positions,pkg.id,Number(pkg.budget_minor));
      if (!round || Number(round.target_minor)!==Number(pkg.budget_minor) || !assessPackageFunding({state:pkg.state,version:pkg.version,budgetMinor:Number(pkg.budget_minor),eligibleMinor:totals.fundingEligibleMinor,provenance:session.mode,round:{packageVersion:round.package_version,state:round.state}}).complete) continue;
      try { assertCurrentFundingLots(lots,pkg.id,pkg.version);const {assertFundedPurposePolicy}=await import("./funding-lifecycle");await assertFundedPurposePolicy(session,pkg.id,round.id,tx); result.set(pkg.id,{ready:true,code:null}); }
      catch(error) { if (!(error instanceof DomainError)) throw error; result.set(pkg.id,{ready:false,code:error.code}); }
    }
  } catch(error) {
    if (!(error instanceof DomainError)) throw error;
    for (const pkg of packages) result.set(pkg.id,{ready:false,code:error.code});
  }
  return result;
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
  await lockFundingScope(session,tx);
  const lines = await reviewedPayoutLines(tx, session, claim, data, lineIds, exceptPayableId);
  const packageIds = [...new Set(lines.map(line => line.packageId))].sort();
  const principals = packageIds.map(packageId => ({ packageId, amountMinor: lines.filter(line => line.packageId === packageId).reduce((sum, line) => sum + line.amountMinor, 0) }));
  const fees = splitFeeAllowance(principals), allocations: PlannedAllocation[] = [], packages: PayoutFunding["packages"] = [];
  const rounds = await query<{ id: string; package_id: string; package_version: number; target_minor: string; state: string }>(
    "SELECT id,package_id,package_version,target_minor,state FROM fp_collection_rounds WHERE tenant_id=$1 AND project_id=$2 ORDER BY collection_started_at DESC,id DESC", [session.tenantId, session.projectId], tx);
  const scope={...session,provenance:"live_sandbox" as const},journal=await readFundingJournal(scope,tx);
  const projection=projectFundingPositions(journal,scope),origins=await readFundingOrigins(scope,tx),lots=projectFundingLots(journal,scope,origins);
  // An unresolved receipt elsewhere does not become usable by choosing only a
  // convenient last journal entry. Complete lineage and current authority agree.
  await assertCommittedFundingChoices(scope,journal.assignments,tx);
  const own=exceptPayableId?await query<{receipt_id:string;package_id:string;amount:string}>(
    `SELECT receipt_id,package_id,sum(amount_minor) amount FROM fp_receipt_allocations
     WHERE payable_id=$1 AND tenant_id=$2 AND project_id=$3 AND state='reserved' GROUP BY receipt_id,package_id`,
    [exceptPayableId,session.tenantId,session.projectId],tx):[];
  for (const packageId of packageIds) {
    const line = lines.find(item => item.packageId === packageId)!;
    const funded = rounds.filter(round => round.package_id === packageId && round.package_version === line.packageVersion && round.state === "funded");
    const latest = rounds.find(round => round.package_id === packageId && round.package_version === line.packageVersion);
    if (!funded.length || latest?.state !== "funded") throw new DomainError("PACKAGE_NOT_FUNDED", `${line.packageTitle} has no current fully collected eligible round. A closed or changed purpose cannot fund repayment.`, 409);
    const [pkg]=await query<{version:number;budget_minor:string;state:FundingState}>("SELECT version,budget_minor,data->>'fundingState' state FROM fp_packages WHERE project_id=$1 AND id=$2",[session.projectId,packageId],tx);
    const totals=packagePositionTotals(projection.positions,packageId,Number(pkg.budget_minor));
    if (!assessPackageFunding({state:pkg.state,version:pkg.version,budgetMinor:Number(pkg.budget_minor),eligibleMinor:totals.fundingEligibleMinor,provenance:"live_sandbox",round:{packageVersion:funded[0].package_version,state:funded[0].state}}).complete ||
      funded.some(round=>Number(round.target_minor)!==Number(pkg.budget_minor)))
      throw new DomainError("ROUND_FUNDING_CHANGED","This current purpose no longer meets its approved funding policy. Resolve its changes before new spending.",409);
    assertCurrentFundingLots(lots,packageId,line.packageVersion);
    const {assertFundedPurposePolicy}=await import("./funding-lifecycle");await assertFundedPurposePolicy(session,packageId,latest.id,tx);
    const pool=projection.positions.filter(position=>position.packageId===packageId&&position.fundingEligibleMinor>0).map(position=>{
      const source=journal.sources.find(source=>source.receipt.id===position.receiptId)!,origin=origins.find(origin=>origin.receiptId===position.receiptId)!;
      const addback=own.find(row=>row.receipt_id===position.receiptId&&row.package_id===packageId);
      return {id:position.receiptId,version:source.version,data:source.receipt,available:position.availableMinor+Number(addback?.amount??0),origin};
    }).sort((a,b)=>a.origin.roundId<b.origin.roundId?-1:a.origin.roundId>b.origin.roundId?1:
      Date.parse(a.origin.receiptCreatedAt)-Date.parse(b.origin.receiptCreatedAt)||(a.id<b.id?-1:a.id>b.id?1:0));
    const principal = principals.find(item => item.packageId === packageId)!.amountMinor, fee = fees.get(packageId)!;
    if (pool.reduce((sum, source) => sum + source.available, 0) < principal + fee)
      throw new DomainError("PACKAGE_AVAILABLE_BUDGET", `${line.packageTitle} does not have enough unallocated eligible funding for these lines and its disclosed fee allowance.`, 409);
    const uses = [...lines.filter(item => item.packageId === packageId).map(item => ({ lineId: item.id, amount: item.amountMinor, kind: "claim" as const })), { lineId: `fee:${packageId}`, amount: fee, kind: "fee" as const }];
    for (const use of uses) {
      let remaining = use.amount;
      for (const source of pool) {
        const take = Math.min(remaining, source.available); if (!take) continue;
        allocations.push({ receiptId: source.id, receiptVersion: source.version, receiptDigest: currentFundingReceiptDigest(source.data,journal,lots,packageId), packageId,
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
