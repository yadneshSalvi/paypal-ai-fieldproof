import { PaypalClient, PaypalError, type PaymentTokenResponse, type SetupTokenRequest, type SetupTokenResponse } from "paypal";
import { canonicalJson, sha256 } from "@fracture/paypal-core";
import { DomainError } from "../domain/money";
import { providerConfiguration } from "./payments";

export type VaultResult<T> =
  | { outcome: "succeeded"; value: T; httpStatus: number; bodyHash: string; debugId: string | null }
  | { outcome: "refused" | "not_sent" | "unknown"; code: string; httpStatus?: number };
export interface VaultGateway {
  createSetup(body: SetupTokenRequest, requestId: string): Promise<VaultResult<SetupTokenResponse>>;
  readSetup(id: string): Promise<VaultResult<SetupTokenResponse>>;
  exchangeSetup(id: string, requestId: string): Promise<VaultResult<PaymentTokenResponse>>;
  readToken(id: string): Promise<VaultResult<PaymentTokenResponse>>;
  deleteToken(id: string): Promise<VaultResult<undefined>>;
}
type SdkResult<T> = { ok: true; status: number; headers: Headers; value: T } | { ok: false; status: number; headers: Headers; payload: unknown };
function safeProviderCode(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && "body" in payload) {
    const body = payload.body;
    if (body && typeof body === "object" && "name" in body && typeof body.name === "string" && /^[A-Z0-9_]{1,80}$/.test(body.name)) return body.name;
  }
  return `PAYPAL_HTTP_${status}`;
}
async function observe<T>(call: (signal: AbortSignal) => PromiseLike<SdkResult<T>>): Promise<VaultResult<T>> {
  const signal = AbortSignal.timeout(20000);
  try {
    const result = await call(signal);
    if (!result.ok) return { outcome: result.status >= 500 || result.status === 408 ? "unknown" : "refused", code: safeProviderCode(result.payload, result.status), httpStatus: result.status };
    return { outcome: "succeeded", value: result.value, httpStatus: result.status, bodyHash: sha256(canonicalJson(result.value ?? null)), debugId: result.headers.get("paypal-debug-id") };
  } catch (error) {
    if (error instanceof PaypalError) {
      if (error.kind === "auth" || error.kind === "encode" || error.uri.endsWith("/v1/oauth2/token")) return { outcome: "not_sent", code: `PAYPAL_${error.kind.toUpperCase()}` };
      if (error.kind === "api") return { outcome: error.status >= 500 || error.status === 408 ? "unknown" : "refused", code: safeProviderCode(error.payload, error.status), httpStatus: error.status };
      return { outcome: "unknown", code: `PAYPAL_${error.kind.toUpperCase()}` };
    }
    if (signal.aborted && error === signal.reason) return { outcome: "unknown", code: "PAYPAL_DEADLINE" };
    throw error;
  }
}
export class ApimaticVaultGateway implements VaultGateway {
  constructor(private readonly client: PaypalClient) {}
  createSetup(body: SetupTokenRequest, requestId: string) {
    return observe(signal => this.client.vault.createSetupToken({ body, payPalRequestId: requestId }, { signal }).asApiResult());
  }
  readSetup(id: string) {
    return observe(signal => this.client.vault.getSetupToken({ id }, { signal }).asApiResult());
  }
  exchangeSetup(id: string, requestId: string) {
    return observe(signal => this.client.vault.createPaymentToken({ body: { paymentSource: { token: { id, type: "SETUP_TOKEN" } } }, payPalRequestId: requestId }, { signal }).asApiResult());
  }
  readToken(id: string) {
    return observe(signal => this.client.vault.getPaymentToken({ id }, { signal }).asApiResult());
  }
  deleteToken(id: string) {
    return observe(signal => this.client.vault.deletePaymentToken({ id }, { signal }).asApiResult());
  }
}
const runtime = globalThis as typeof globalThis & { fieldproofVault?: VaultGateway };
export function vaultGateway(): VaultGateway {
  if (!runtime.fieldproofVault) {
    const config = providerConfiguration();
    if (config.baseUrl !== "https://api-m.sandbox.paypal.com") throw new DomainError("SANDBOX_HOST_REQUIRED", "Vault operations require the isolated PayPal sandbox.", 503);
    runtime.fieldproofVault = new ApimaticVaultGateway(new PaypalClient({
      serverOptions: { baseUrl: config.baseUrl }, oauth2: { clientId: config.clientId, clientSecret: config.clientSecret },
      retry: { maxRetries: 0, timeout: 15000 }, logging: { level: "off" },
    }));
  }
  return runtime.fieldproofVault;
}
