import { canonicalJson, sha256 } from "@fracture/paypal-core";
import { z } from "zod";

export const PAYOUT_POLICY_VERSION = "reviewed-expense-v1";
export const PAYOUT_FEE_ALLOWANCE_MINOR = 2000;
export const PAYOUT_APPROVAL_MS = 15 * 60_000;
export const RECIPIENT_VERIFICATION_MS = 7 * 24 * 60 * 60_000;
export const PAYOUT_DUPLICATE_WINDOW_MS = 30 * 24 * 60 * 60_000;
export const payoutSelectionSchema = z.object({
  expectedVersion: z.number().int().positive(), lineIds: z.array(z.string().regex(/^line-[0-9]{1,3}$/)).min(1).max(120),
  payableId: z.uuid().optional(),
}).strict();
export const payoutApprovalSchema = z.object({
  reviewId: z.uuid(), reviewDigest: z.string().regex(/^[0-9a-f]{64}$/), intentId: z.uuid(),
  amountMinor: z.number().int().positive(), currency: z.literal("USD"),
  recipientAndAmountChecked: z.literal(true), feeAllowanceAcknowledged: z.literal(true), sampleAcknowledged: z.boolean(),
}).strict();
export type PayableState = "reserved" | "submitting" | "cancelling" | "unknown" | "refused" | "not_sent" | "pending" | "unclaimed" | "held" | "blocked" | "succeeded" | "returned" | "failed" | "cancelled" | "review_required";
export interface PayoutReviewView {
  id: string; digest: string; expiresAt: string; claimId: string; claimVersion: number; title: string;
  amountMinor: number; currency: "USD"; feeAllowanceMinor: number;
  recipient: { label: string; verifiedAt: string; version: number };
  sourceClass: "user_upload" | "sample_document";
  lines: { id: string; description: string; amountMinor: number; packageId: string; packageTitle: string }[];
  funding: { packageId: string; packageTitle: string; amountMinor: number; feeAllowanceMinor: number; receiptCount: number }[];
  payableId: string | null;
}
export interface PayableView {
  id: string; claimId: string; claimVersion: number; state: PayableState; amountMinor: number; currency: "USD";
  feeAllowanceMinor: number; actualFeeMinor: number | null; feeState: "reserved" | "confirmed" | "review_required" | "released";
  lineIds: string[]; recipientLabel: string; recipientVersion: number; approvalDigest: string; approvalExpiresAt: string;
  createdAt: string; dispatchedAt: string | null; observedAt: string | null; completedAt: string | null;
  providerStatus: string | null; code: string | null; providerItemReference: string | null;
  balance: null | { observedAt: string; asOfTime: string | null; lastRefreshTime: string | null; code: string | null };
  canSend: boolean; canRetryOriginal: boolean; canCheck: boolean; canCancelUnclaimed: boolean; canRelease: boolean;
  requiresNewApproval: boolean;
}
export interface ClaimPaymentView {
  payables: PayableView[];
  recipient: { label: string; verifiedAt: string; version: number; usable: boolean } | null;
  lines: { id: string; approvedMinor: number; paidMinor: number; reservedMinor: number; availableMinor: number; fundingReady: boolean; code: string | null }[];
}
export function payoutReviewDigest(value: unknown): string { return sha256(canonicalJson(value)); }

/** Integer largest-remainder allocation keeps the disclosed fee allowance exact. */
export function splitFeeAllowance(amounts: { packageId: string; amountMinor: number }[], feeMinor = PAYOUT_FEE_ALLOWANCE_MINOR): Map<string, number> {
  const total = amounts.reduce((sum, item) => sum + item.amountMinor, 0);
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(feeMinor) || feeMinor < 0) throw new Error("A fee allowance needs positive reviewed principal.");
  const portions = amounts.map(item => {
    const product = BigInt(item.amountMinor) * BigInt(feeMinor);
    return { ...item, value: Number(product / BigInt(total)), remainder: product % BigInt(total) };
  });
  let remaining = feeMinor - portions.reduce((sum, item) => sum + item.value, 0);
  portions.sort((a, b) => a.remainder === b.remainder ? a.packageId.localeCompare(b.packageId) : a.remainder > b.remainder ? -1 : 1);
  for (const item of portions) if (remaining-- > 0) item.value++;
  return new Map(portions.map(item => [item.packageId, item.value]));
}
