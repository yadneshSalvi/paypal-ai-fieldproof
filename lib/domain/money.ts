import type { CollectionChannel, CollectionRound, FundingTotals, Provenance, SettlementReceipt } from "../contracts";
import { RECOVERY_WINDOW_MS } from "../contracts";

export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
export function assertMinor(value: number, allowZero = true): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new DomainError("INVALID_AMOUNT", "Use a positive whole number of cents.", 400);
}
export function formatMoney(minor: number, compact = false): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: compact && minor % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(minor / 100);
}
export function providerDecimal(minor: number): string {
  assertMinor(minor);
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}
export function validateReceipt(receipt: SettlementReceipt): void {
  for (const value of [receipt.grossSettledMinor, receipt.creditedMinor, receipt.completedAttributedRefundMinor, receipt.pendingAttributedRefundReserveMinor, receipt.excludedMinor, receipt.excessLiabilityMinor]) assertMinor(value);
  if (receipt.currency !== "USD") throw new DomainError("CURRENCY_MISMATCH", "Receipt currency does not match this project.");
  if (!receipt.actualProviderPaymentRef || !receipt.economicAliases.length) throw new DomainError("MISSING_PAYMENT_IDENTITY", "A settled payment needs a proven payment identity.");
  if (receipt.creditedMinor + receipt.excessLiabilityMinor > receipt.grossSettledMinor) throw new DomainError("CREDIT_EXCEEDS_PAYMENT", "Receipt credit exceeds the payment.");
  if (receipt.completedAttributedRefundMinor + receipt.pendingAttributedRefundReserveMinor + receipt.excludedMinor > receipt.creditedMinor) throw new DomainError("REFUND_EXCEEDS_CREDIT", "Refunds and exclusions exceed credited funds.");
  if (receipt.authoritativeObservedState !== "COMPLETED" && receipt.creditedMinor !== 0) throw new DomainError("UNSETTLED_CREDIT", "An unconfirmed payment cannot fund a package.");
  if (receipt.sourceKind === "invoice_payment" && !receipt.sourceInvoiceId) throw new DomainError("MISSING_INVOICE", "An invoice payment needs its invoice lineage.");
}
export function fundingTotals(receipts: SettlementReceipt[], targetMinor: number, provenance: Provenance): FundingTotals {
  assertMinor(targetMinor);
  const aliases = new Set<string>();
  let collectedMinor = 0, fundingEligibleMinor = 0, pendingRefundMinor = 0, excessLiabilityMinor = 0;
  for (const receipt of receipts) {
    validateReceipt(receipt);
    if (receipt.provenance !== provenance) continue;
    for (const alias of receipt.economicAliases) {
      if (aliases.has(alias)) throw new DomainError("DUPLICATE_PAYMENT_ALIAS", "Two records refer to the same economic payment.");
      aliases.add(alias);
    }
    collectedMinor += receipt.creditedMinor - receipt.completedAttributedRefundMinor;
    fundingEligibleMinor += receipt.creditedMinor - receipt.completedAttributedRefundMinor - receipt.pendingAttributedRefundReserveMinor - receipt.excludedMinor;
    pendingRefundMinor += receipt.pendingAttributedRefundReserveMinor;
    excessLiabilityMinor += receipt.excessLiabilityMinor;
  }
  for (const value of [collectedMinor, fundingEligibleMinor, pendingRefundMinor, excessLiabilityMinor]) assertMinor(value);
  return { collectedMinor, fundingEligibleMinor, shortfallMinor: Math.max(0, targetMinor - fundingEligibleMinor), pendingRefundMinor, excessLiabilityMinor };
}
export function splitSettlement(grossMinor: number, obligationMinor: number, alreadyCreditedMinor: number): { creditedMinor: number; excessLiabilityMinor: number } {
  [grossMinor, obligationMinor, alreadyCreditedMinor].forEach(v => assertMinor(v));
  const creditedMinor = Math.min(grossMinor, Math.max(0, obligationMinor - alreadyCreditedMinor));
  return { creditedMinor, excessLiabilityMinor: grossMinor - creditedMinor };
}
export function freezeRound(input: Omit<CollectionRound, "collectionStartedAt" | "recoveryEndsAt">, now: Date): CollectionRound {
  return { ...input, collectionStartedAt: now.toISOString(), recoveryEndsAt: new Date(now.getTime() + RECOVERY_WINDOW_MS).toISOString() };
}
export function assertRecoveryAllowed(channel: CollectionChannel, round: CollectionRound, now: Date): void {
  if (channel !== "definitively_declined") throw new DomainError("RECOVERY_CHANNEL_BLOCKED", "Confirm the original payment outcome before opening a recovery invoice.");
  if (now.getTime() >= Date.parse(round.recoveryEndsAt)) throw new DomainError("RECOVERY_WINDOW_CLOSED", "The 48-hour collection window has ended.");
}
export function assertBalanced(entries: { side: "debit" | "credit"; amountMinor: number }[]): void {
  let balance = 0;
  for (const entry of entries) { assertMinor(entry.amountMinor); balance += entry.side === "debit" ? entry.amountMinor : -entry.amountMinor; }
  if (!entries.length || balance !== 0) throw new DomainError("UNBALANCED_JOURNAL", "Journal debits and credits must balance.");
}
export function assertAllocationWithinReceipt(availableMinor: number, allocations: number[]): void {
  assertMinor(availableMinor);
  allocations.forEach(v => assertMinor(v));
  if (allocations.reduce((sum, v) => sum + v, 0) > availableMinor) throw new DomainError("OVER_ALLOCATION", "Allocations exceed the receipt's available credit.");
}
