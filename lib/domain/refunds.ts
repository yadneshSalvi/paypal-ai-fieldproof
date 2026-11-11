import { canonicalJson, sha256, type ProviderResource } from "@fracture/paypal-core";
import type { SettlementReceipt } from "../contracts";

export type RefundReason = "requested" | "incomplete_round" | "package_cancelled" | "excess_return" | "case_return";
export const REFUND_POLICY = sha256("Fieldproof:original-rail-refund:v1:exact-receipt:unallocated-funds:separate-excess:durable-reservation");
export function refundReceiptDigest(receipt: SettlementReceipt): string {
  return sha256(canonicalJson({ id: receipt.id, tenantId: receipt.tenantId, projectId: receipt.projectId,
    obligationId: receipt.donorObligationId, currency: receipt.currency, grossMinor: receipt.grossSettledMinor,
    providerRef: receipt.actualProviderPaymentRef, refundableRef: receipt.provenRefundableRef, refundAdapter: receipt.refundAdapter }));
}
export function relatedProviderId(resource: ProviderResource, prefix: string): string | null {
  const candidates = new Set<string>();
  for (const link of resource.links) {
    if (link.rel !== "up" || link.method !== "GET") continue;
    try {
      const url = new URL(link.href);
      if (!["https://api-m.sandbox.paypal.com", "https://api.sandbox.paypal.com"].includes(url.origin) || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix)) continue;
      const value = url.pathname.slice(prefix.length);
      if (/^[A-Za-z0-9_-]{5,128}$/.test(value)) candidates.add(value);
    } catch { /* Invalid data never becomes a fetch URL. */ }
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}
export function refundParentMatches(resource: ProviderResource, captureId: string): boolean {
  const linked = relatedProviderId(resource, "/v2/payments/captures/");
  return resource.kind === "refund" && (linked === captureId || !linked && resource.parentId === captureId);
}
export interface RefundView {
  id: string; receiptId: string; obligationId: string; amountMinor: number; attributedMinor: number; excessMinor: number;
  reason: RefundReason; state: string; createdAt: string; completedAt: string | null; lastCode: string | null; canRetry: boolean;
}
