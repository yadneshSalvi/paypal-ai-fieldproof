import { SandboxCommerceRestGateway, canonicalJson, fromProviderMoney, sha256, type MinorMoney } from "@fracture/paypal-core";
import { PaypalError } from "paypal";
import { paypalProvider, providerConfiguration } from "./payments";
import { guardedProviderTransport } from "./maintenance";

export type CommerceGateway = Pick<SandboxCommerceRestGateway, "createInvoice" | "getInvoice" | "findInvoices" | "sendInvoice" | "cancelInvoice" | "createPayout" | "getPayoutBatch" | "getPayoutItem" | "cancelUnclaimedPayout">;
const runtime = globalThis as typeof globalThis & { fieldproofCommerce?: CommerceGateway };
export function commerceGateway(): CommerceGateway { return runtime.fieldproofCommerce ??= new SandboxCommerceRestGateway(providerConfiguration(), guardedProviderTransport()); }

export interface InvoiceCaptureEvidence {
  id: string; status: string; money: MinorMoney; invoiceId: string | null; orderId: string | null;
  merchantEmail: string | null; observedAt: string; bodyHash: string; source: "live_sandbox";
}
export type InvoiceCaptureResult = { outcome: "succeeded"; value: InvoiceCaptureEvidence } | { outcome: "unknown"; code: string; httpStatus?: number };
export interface InvoicePaymentReader { readCapture(id: string): Promise<InvoiceCaptureResult> }
export const invoicePaymentReader: InvoicePaymentReader = {
  async readCapture(id) {
    if (!/^[A-Za-z0-9_-]{5,128}$/.test(id)) return { outcome: "unknown", code: "PAYMENT_IDENTITY_UNPROVEN" };
    const signal = AbortSignal.timeout(20000);
    try {
      const result = await paypalProvider().client.payments.getCapturedPayment({ captureId: id }, { signal }).asApiResult();
      if (!result.ok) return { outcome: "unknown", code: "PAYMENT_RAIL_UNCONFIRMED", httpStatus: result.status };
      const capture = result.value;
      if (capture.id !== id || !capture.amount || !capture.status) return { outcome: "unknown", code: "PAYMENT_IDENTITY_UNPROVEN", httpStatus: result.status };
      const money = fromProviderMoney(capture.amount);
      if (money.currency !== "USD") return { outcome: "unknown", code: "PAYMENT_CURRENCY_UNPROVEN", httpStatus: result.status };
      return { outcome: "succeeded", value: { id, status: capture.status, money, invoiceId: capture.invoiceId ?? null,
        orderId: capture.supplementaryData?.relatedIds?.orderId ?? null, merchantEmail: capture.payee?.emailAddress ?? null,
        observedAt: new Date().toISOString(), bodyHash: sha256(canonicalJson(capture)), source: "live_sandbox" } };
    } catch (error) {
      if (error instanceof PaypalError || signal.aborted) return { outcome: "unknown", code: "PAYMENT_READ_UNAVAILABLE" };
      throw error;
    }
  },
};
