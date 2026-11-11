import { cancellationPosition, type CancellationSource } from "./cancellation-position";
import { assertMinor, DomainError } from "./money";

export interface WeightedContribution { id: string; weightMinor: number }
export interface ApportionedContribution extends WeightedContribution {
  amountMinor: number;
  remainderNumerator: string;
}
function compareId(a: string, b: string): number {
  const left=Array.from(a,character=>character.codePointAt(0)!), right=Array.from(b,character=>character.codePointAt(0)!);
  for(let i=0;i<Math.min(left.length,right.length);i++) if(left[i]!==right[i]) return left[i]-right[i];
  return left.length-right.length;
}

/** Exact largest-remainder allocation. Products use BigInt because two safe
 * integer amounts can have a product outside JavaScript's exact number range.
 * Equal remainders use code-point ID order, independent of locale/input order. */
export function apportionMinorUnits(totalMinor: number, contributions: WeightedContribution[]): {
  totalMinor: number; denominatorMinor: number; rows: ApportionedContribution[];
} {
  assertMinor(totalMinor);
  const ids = new Set<string>();
  let denominator = 0n;
  for (const contribution of contributions) {
    if (!contribution.id || ids.has(contribution.id))
      throw new DomainError("APPORTIONMENT_IDENTITY", "Every contribution needs one unique saved identity.");
    ids.add(contribution.id); assertMinor(contribution.weightMinor);
    denominator += BigInt(contribution.weightMinor);
  }
  if (denominator > BigInt(Number.MAX_SAFE_INTEGER))
    throw new DomainError("APPORTIONMENT_DENOMINATOR", "The frozen contribution total exceeds the supported amount.");
  if (BigInt(totalMinor) > denominator)
    throw new DomainError("APPORTIONMENT_EXCEEDS_SOURCE", "A cancellation cannot distribute more than its retained contributions.");
  const rows = [...contributions].sort((a,b)=>compareId(a.id,b.id)).map(contribution => {
    const numerator = BigInt(totalMinor) * BigInt(contribution.weightMinor);
    return { ...contribution, amountMinor: denominator ? Number(numerator / denominator) : 0,
      remainderNumerator: (denominator ? numerator % denominator : 0n).toString() };
  });
  let remaining = totalMinor - rows.reduce((sum,row)=>sum+row.amountMinor,0);
  const ranked = [...rows].sort((a,b) => {
    const difference = BigInt(b.remainderNumerator) - BigInt(a.remainderNumerator);
    return difference > 0n ? 1 : difference < 0n ? -1 : compareId(a.id,b.id);
  });
  for (const row of ranked) { if (!remaining) break; row.amountMinor++; remaining--; }
  if (remaining || rows.reduce((sum,row)=>sum+row.amountMinor,0) !== totalMinor)
    throw new DomainError("APPORTIONMENT_CONSERVATION", "The cancellation allocation did not conserve every cent.");
  return { totalMinor, denominatorMinor: Number(denominator), rows };
}

export type CancellationApportionmentConflict = {
  receiptId: string;
  code: "pending_refund" | "reserved_spending" | "route_unqualified" | "source_capacity";
  amountMinor: number;
};

/** A version-bound proposal for a cancellation case, not refund authority.
 * Fair shares use retained contributions after completed returns. A share that
 * cannot be returned through its OWN source is a conflict, never a reason to
 * reduce that donor's share or debit another donor's capture. Pending uses hold
 * the entire proposal until reconciled and a new case snapshot is reviewed. */
export function planProRataCancellation(sources: CancellationSource[],
  scope: Parameters<typeof cancellationPosition>[1]) {
  const position = cancellationPosition(sources,scope);
  const allocation = apportionMinorUnits(position.uncommittedMinor,position.sources.map(source => ({
    id: source.receiptId, weightMinor: source.creditedMinor-source.refundedMinor,
  })));
  const conflicts: CancellationApportionmentConflict[] = [];
  const rows = allocation.rows.map(share => {
    const source = position.sources.find(row=>row.receiptId===share.id)!;
    if (source.pendingRefundMinor) conflicts.push({receiptId:share.id,code:"pending_refund",amountMinor:source.pendingRefundMinor});
    if (source.reservedMinor) conflicts.push({receiptId:share.id,code:"reserved_spending",amountMinor:source.reservedMinor});
    if (share.amountMinor && !source.refundRouteQualified) conflicts.push({receiptId:share.id,code:"route_unqualified",amountMinor:share.amountMinor});
    if (share.amountMinor > source.uncommittedMinor) conflicts.push({receiptId:share.id,code:"source_capacity",amountMinor:share.amountMinor-source.uncommittedMinor});
    return { ...share, receiptVersion:source.receiptVersion, sourceKind:source.sourceKind,
      originalRouteCapacityMinor:source.uncommittedMinor, paidMinor:source.paidMinor,
      reservedMinor:source.reservedMinor, pendingRefundMinor:source.pendingRefundMinor,
      excludedFromSpendingMinor:source.excludedMinor };
  });
  return { schemaVersion:1 as const, method:"largest-remainder-v1" as const,
    denominatorPolicy:"credited_less_completed_returns" as const,
    tieBreak:"receipt_id_codepoint_ascending" as const,
    ...scope, currency:"USD" as const, totalMinor:allocation.totalMinor,
    denominatorMinor:allocation.denominatorMinor, position, rows, conflicts,
    state:conflicts.length?"review_required" as const:allocation.totalMinor?"ready_for_case_review" as const:"no_uncommitted_funds" as const,
    authorizesRefund:false as const, providerAllowanceObserved:false as const,
  };
}
