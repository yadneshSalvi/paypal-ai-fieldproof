import type { Provenance, SettlementReceipt } from "../contracts";
import { assertMinor, DomainError, validateReceipt } from "./money";
import { projectFundingPositions, type FundingScope } from "./funding-positions";
import type { FundingJournal } from "./funding-lots";

export interface CancellationSource {
  receipt: SettlementReceipt;
  version: number;
  reservedMinor: number;
  paidMinor: number;
}
export interface CancellationPosition {
  sources: {
    receiptId: string;
    receiptVersion: number;
    sourceKind: SettlementReceipt["sourceKind"];
    creditedMinor: number;
    refundedMinor: number;
    pendingRefundMinor: number;
    reservedMinor: number;
    paidMinor: number;
    excludedMinor: number;
    uncommittedMinor: number;
    refundRouteQualified: boolean;
  }[];
  creditedMinor: number;
  refundedMinor: number;
  pendingRefundMinor: number;
  reservedMinor: number;
  paidMinor: number;
  excludedMinor: number;
  uncommittedMinor: number;
  unqualifiedRouteCount: number;
  hasCommittedUses: boolean;
}

/** A read-only application position, never a fresh provider refund allowance.
 * Paid and reserved uses include the actual fee/remaining fee allowance.
 * Exclusions are disclosed separately: a cancellation itself may exclude money
 * from spending while its original-route return remains unresolved. */
export function cancellationPosition(sources: CancellationSource[], scope: {
  tenantId: string; projectId: string; packageId: string; provenance: Provenance;
}): CancellationPosition {
  const ids = new Set<string>(), aliases = new Set<string>();
  const result: CancellationPosition = {
    sources: [], creditedMinor: 0, refundedMinor: 0, pendingRefundMinor: 0,
    reservedMinor: 0, paidMinor: 0, excludedMinor: 0, uncommittedMinor: 0,
    unqualifiedRouteCount: 0, hasCommittedUses: false,
  };
  for (const { receipt, version, reservedMinor, paidMinor } of [...sources].sort((a, b) => a.receipt.id.localeCompare(b.receipt.id))) {
    validateReceipt(receipt);
    if (receipt.tenantId !== scope.tenantId || receipt.projectId !== scope.projectId || receipt.packageId !== scope.packageId || receipt.provenance !== scope.provenance)
      throw new DomainError("CANCELLATION_SCOPE_MISMATCH", "A contribution does not match this exact package and workspace.");
    if (!Number.isSafeInteger(version) || version < 1) throw new DomainError("CANCELLATION_VERSION_INVALID", "A contribution has no valid saved version.");
    [reservedMinor, paidMinor].forEach(value => assertMinor(value));
    if (ids.has(receipt.id) || new Set(receipt.economicAliases).size !== receipt.economicAliases.length || receipt.economicAliases.some(alias => aliases.has(alias)))
      throw new DomainError("DUPLICATE_PAYMENT_ALIAS", "Two cancellation sources refer to the same payment.");
    ids.add(receipt.id);
    receipt.economicAliases.forEach(alias => aliases.add(alias));
    const uncommittedMinor = receipt.creditedMinor - receipt.completedAttributedRefundMinor - receipt.pendingAttributedRefundReserveMinor - reservedMinor - paidMinor;
    if (!Number.isSafeInteger(uncommittedMinor) || uncommittedMinor < 0 || uncommittedMinor < receipt.excludedMinor)
      throw new DomainError("CANCELLATION_POSITION_CONFLICT", "This receipt's refunds, exclusions and committed uses need reconciliation before cancellation.");
    const row = {
      receiptId: receipt.id, receiptVersion: version, sourceKind: receipt.sourceKind,
      creditedMinor: receipt.creditedMinor, refundedMinor: receipt.completedAttributedRefundMinor,
      pendingRefundMinor: receipt.pendingAttributedRefundReserveMinor, reservedMinor, paidMinor,
      excludedMinor: receipt.excludedMinor, uncommittedMinor,
      refundRouteQualified: receipt.refundAdapter === "capture_refund" && !!receipt.provenRefundableRef,
    };
    result.sources.push(row);
    for (const key of ["creditedMinor", "refundedMinor", "pendingRefundMinor", "reservedMinor", "paidMinor", "excludedMinor", "uncommittedMinor"] as const) {
      result[key] += row[key];
      assertMinor(result[key]);
    }
    if (!row.refundRouteQualified && uncommittedMinor > 0) result.unqualifiedRouteCount++;
    result.hasCommittedUses ||= reservedMinor > 0 || paidMinor > 0;
  }
  return result;
}

/** Current-purpose view over complete economic lineage. Assigned credit is a
 * position, not a relabelled payment. Excluded value remains disclosed as part
 * of the uncommitted return position, never available for new expenses. */
export function currentCancellationPosition(journal: FundingJournal, scope: FundingScope, packageId: string): CancellationPosition {
  const projection = projectFundingPositions(journal, scope);
  const result: CancellationPosition = { sources: [], creditedMinor: 0, refundedMinor: 0, pendingRefundMinor: 0,
    reservedMinor: 0, paidMinor: 0, excludedMinor: 0, uncommittedMinor: 0, unqualifiedRouteCount: 0, hasCommittedUses: false };
  for (const position of projection.positions.filter(position => position.packageId === packageId)) {
    const receipt = journal.sources.find(source => source.receipt.id === position.receiptId)!.receipt;
    const row = { receiptId: position.receiptId, receiptVersion: position.receiptVersion, sourceKind: position.sourceKind,
      creditedMinor: position.assignedMinor, refundedMinor: position.refundedMinor, pendingRefundMinor: position.pendingRefundMinor,
      reservedMinor: position.reservedMinor, paidMinor: position.paidMinor, excludedMinor: position.excludedMinor,
      uncommittedMinor: position.availableMinor + position.excludedMinor,
      refundRouteQualified: receipt.refundAdapter === "capture_refund" && !!receipt.provenRefundableRef };
    if (!row.creditedMinor && !row.refundedMinor && !row.pendingRefundMinor && !row.reservedMinor && !row.paidMinor) continue;
    result.sources.push(row);
    for (const key of ["creditedMinor", "refundedMinor", "pendingRefundMinor", "reservedMinor", "paidMinor", "excludedMinor", "uncommittedMinor"] as const) {
      result[key] += row[key]; assertMinor(result[key]);
    }
    if (!row.refundRouteQualified && row.uncommittedMinor > 0) result.unqualifiedRouteCount++;
    result.hasCommittedUses ||= row.reservedMinor > 0 || row.paidMinor > 0;
  }
  return result;
}
