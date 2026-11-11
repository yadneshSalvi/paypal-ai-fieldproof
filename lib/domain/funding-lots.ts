import { canonicalJson, sha256 } from "@fracture/paypal-core";
import type { FundingAssignment, FundingDeductions, FundingScope, FundingSource, FundingUse } from "./funding-positions";
import { projectFundingPositions } from "./funding-positions";
import { DomainError } from "./money";

/** The original version is evidence from the owned collection AND consent.
 * It is never inferred from the current package or from an assignment. */
export interface FundingOrigin {
  receiptId: string; packageId: string; packageVersion: number; roundId: string;
  consentId: string; consentVersion: number; consentDigest: string; donorActorId: string;
  receiptCreatedAt: string;
  title?: string; purpose?: string;
}
export interface FundingLot {
  id: string; receiptId: string; packageId: string; packageVersion: number;
  assignedMinor: number; assignmentIds: string[]; origin: FundingOrigin;
}
export interface FundingJournal {
  sources: FundingSource[]; assignments: FundingAssignment[]; deductions: FundingDeductions[]; uses: FundingUse[];
}

/** Replays every paired entry, splitting original and subsequent credit lots.
 * A later valid entry cannot launder an older, stale-purpose credit. Deductions
 * and expenses remain at their actual package; the position projector verifies
 * their conservation separately. Lots deliberately contain no expense counters:
 * reserving an approved payment must not change its own source identity. */
export function projectFundingLots(journal: FundingJournal, scope: FundingScope, origins: FundingOrigin[]): FundingLot[] {
  projectFundingPositions(journal, scope);
  const byReceipt = new Map<string, FundingLot[]>(), sourceIds = new Set(journal.sources.map(s => s.receipt.id));
  const originMap = new Map<string, FundingOrigin>();
  for (const origin of origins) {
    if (originMap.has(origin.receiptId) || !sourceIds.has(origin.receiptId) || !Number.isSafeInteger(origin.packageVersion) || origin.packageVersion < 1 ||
      !Number.isSafeInteger(origin.consentVersion) || origin.consentVersion < 1 || !origin.consentId || !origin.consentDigest || !origin.donorActorId ||
      !origin.roundId || !Number.isFinite(Date.parse(origin.receiptCreatedAt)))
      throw new DomainError("FUNDING_ORIGIN_UNPROVEN", "The original contribution needs its owned collection and consent version.");
    originMap.set(origin.receiptId, origin);
  }
  for (const { receipt } of journal.sources) {
    const origin = originMap.get(receipt.id);
    if (!origin || origin.packageId !== receipt.packageId)
      throw new DomainError("FUNDING_ORIGIN_UNPROVEN", "A contribution's original restricted purpose is not established by its collection and consent.");
    byReceipt.set(receipt.id, [{ id: `original:${receipt.id}`, receiptId: receipt.id, packageId: origin.packageId,
      packageVersion: origin.packageVersion, assignedMinor: receipt.creditedMinor, assignmentIds: [], origin }]);
  }
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const seen = new Map<string, FundingAssignment>();
  for (const entry of [...journal.assignments].sort((a, b) => compare(a.receiptId, b.receiptId) || a.sequence - b.sequence)) {
    const lots = byReceipt.get(entry.receiptId)!;
    if (entry.donorActorId !== originMap.get(entry.receiptId)!.donorActorId)
      throw new DomainError("FUNDING_DONOR_CHANGED", "An assignment must retain the original contribution owner.");
    if (entry.kind === "reversal") {
      const reversed = seen.get(entry.reversesId!);
      if (!reversed || reversed.credit.packageVersion !== entry.debit.packageVersion || reversed.debit.packageVersion !== entry.credit.packageVersion)
        throw new DomainError("FUNDING_REVERSAL_VERSION", "A reversal must identify the original versions on both sides.");
    }
    let remaining = entry.amountMinor;
    const debits = lots.filter(lot => lot.packageId === entry.debit.packageId && lot.packageVersion === entry.debit.packageVersion && lot.assignedMinor > 0 &&
      (entry.kind !== "reversal" || lot.assignmentIds.includes(entry.reversesId!)));
    for (const debit of debits) {
      const take = Math.min(remaining, debit.assignedMinor);
      if (!take) continue;
      debit.assignedMinor -= take; remaining -= take;
      lots.push({ id: `lot:${sha256(canonicalJson({ entry: entry.id, source: debit.id }))}`, receiptId: entry.receiptId,
        packageId: entry.credit.packageId, packageVersion: entry.credit.packageVersion, assignedMinor: take,
        assignmentIds: [...debit.assignmentIds, entry.id], origin: debit.origin });
      if (!remaining) break;
    }
    if (remaining) throw new DomainError("FUNDING_LOT_VERSION", "The transfer exceeds the credit owned by its exact source purpose version.");
    seen.set(entry.id, entry);
  }
  return [...byReceipt.values()].flat().filter(lot => lot.assignedMinor > 0).sort((a, b) => compare(a.receiptId, b.receiptId) || compare(a.id, b.id));
}

export function assertCurrentFundingLots(lots: FundingLot[], packageId: string, version: number): FundingLot[] {
  const selected = lots.filter(lot => lot.packageId === packageId && lot.assignedMinor > 0);
  if (!selected.length || selected.some(lot => lot.packageVersion !== version))
    throw new DomainError("FUNDING_PURPOSE_VERSION", "Every contribution must consent to this exact current package version before it can fund an expense.");
  return selected;
}
