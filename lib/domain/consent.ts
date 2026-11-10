import { canonicalJson, sha256 } from "@fracture/paypal-core";
import { DomainError, formatMoney } from "./money";

export const CONDITIONAL_AMOUNTS = [20000, 20000, 17500, 15000, 10000, 5000, 5000, 3500] as const;
export const CONDITIONAL_TARGET_MINOR = 96000;
export const CONSENT_EXPIRES_AT = "2027-01-01T00:00:00.000Z";
export const CONDITIONAL_PACKAGE = "electronics";
export const CONDITIONAL_PACKAGE_TITLE = "Electronics Benches";
export type ConsentStatus = "awaiting_wallet" | "wallet_pending" | "ready" | "review_required" | "unavailable" | "withdrawn" | "collecting" | "collected";

export interface ConditionalPolicy {
  version: 1;
  packageId: "electronics";
  packageVersion: number;
  currency: "USD";
  amountMinor: number;
  targetMinor: 96000;
  expiresAt: string;
  recoveryHours: 48;
  collection: "merchant_initiated_saved_wallet";
  incompleteCollection: "refund_all_settled_obligations";
  statement: string;
  recoveryStatement: string;
}
export interface ConsentView {
  id: string;
  obligationId: string;
  slotIndex: number;
  amountMinor: number;
  packageVersion: number;
  version: number;
  status: ConsentStatus;
  channel: string;
  policy: ConditionalPolicy;
  policyDigest: string;
  expiresAt: string;
  acknowledgedAt: string;
  walletLabel: string | null;
  walletObservedAt: string | null;
  approvalUrl: string | null;
  canWithdraw: boolean;
  lastCode: string | null;
  source: "live_sandbox";
}
export function conditionalPolicy(slotIndex: number, packageVersion: number): ConditionalPolicy {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= CONDITIONAL_AMOUNTS.length) throw new DomainError("INVALID_CONTRIBUTION_SLOT", "Choose one of the eight approved contribution amounts.", 400);
  if (!Number.isSafeInteger(packageVersion) || packageVersion < 1) throw new DomainError("VERSION_CHANGED", "Review the current plan before committing.");
  return {
    version: 1, packageId: CONDITIONAL_PACKAGE, packageVersion, currency: "USD",
    amountMinor: CONDITIONAL_AMOUNTS[slotIndex], targetMinor: CONDITIONAL_TARGET_MINOR,
    expiresAt: CONSENT_EXPIRES_AT, recoveryHours: 48, collection: "merchant_initiated_saved_wallet",
    incompleteCollection: "refund_all_settled_obligations",
    statement: "You're charged only if Electronics Benches reaches $960 in pledges by 31 December.",
    recoveryStatement: "If one payment fails, we have 48 hours to collect it. If we can't, your payment is refunded.",
  };
}
export function consentDigest(input: { tenantId: string; projectId: string; actorId: string; obligationId: string; version: number; policy: ConditionalPolicy }): string {
  return sha256(canonicalJson(input));
}
export function providerConsentDescription(policy: ConditionalPolicy): string {
  return `${formatMoney(policy.amountMinor)} for Electronics Benches only if $960 is pledged by 31 Dec 2026. 48-hour collection; incomplete collection refunded. No charge to save wallet.`;
}
export function safeApprovalUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["www.sandbox.paypal.com", "sandbox.paypal.com"].includes(url.hostname) && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}
export function assertCollectibleConsent(input: { status: string; expiresAt: Date; withdrawnAt: Date | null; packageVersion: number; currentPackageVersion: number; encryptedWallet: string | null }, now = new Date()): void {
  if (input.withdrawnAt || input.status !== "ready") throw new DomainError("CONSENT_NOT_READY", "Every contribution needs a current approved wallet before collection.");
  if (input.expiresAt.getTime() <= now.getTime()) throw new DomainError("CONSENT_EXPIRED", "An expired contribution needs new consent.");
  if (input.packageVersion !== input.currentPackageVersion) throw new DomainError("VERSION_CHANGED", "The plan changed after consent. Ask the supporter to review it again.");
  if (!input.encryptedWallet) throw new DomainError("WALLET_NOT_READY", "The saved wallet has not been confirmed.");
}
