import { PayPalWebhookVerifier, sha256, type WebhookVerifier } from "@fracture/paypal-core";
import { DomainError } from "../domain/money";
import { initializeDatabase } from "./db";
import { paymentCore, providerConfiguration } from "./payments";

export const WEBHOOK_MAX_BYTES = 256 * 1024;

export function webhookInboxScope() {
  // A delivery belongs to this app's merchant inbox first. Never accept tenant
  // authority from a provider custom_id or a browser-supplied query parameter.
  return { tenantId: `fieldproof-provider:${sha256(providerConfiguration().clientId)}`, projectId: "fieldproof-provider-inbox" };
}

export async function limitedWebhookBody(request: Request): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > WEBHOOK_MAX_BYTES) throw new DomainError("WEBHOOK_TOO_LARGE", "Webhook exceeds the intake limit.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new DomainError("WEBHOOK_BODY_REQUIRED", "A webhook body is required.", 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > WEBHOOK_MAX_BYTES) {
        await reader.cancel();
        throw new DomainError("WEBHOOK_TOO_LARGE", "Webhook exceeds the intake limit.", 413);
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new DomainError("WEBHOOK_ENCODING_INVALID", "Webhook body must be UTF-8.", 400); }
}

export async function receivePayPalWebhook(rawBody: string, headers: Headers, verifier?: WebhookVerifier) {
  if (Buffer.byteLength(rawBody) > WEBHOOK_MAX_BYTES) throw new DomainError("WEBHOOK_TOO_LARGE", "Webhook exceeds the intake limit.", 413);
  if (!verifier) {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    if (!webhookId) throw new DomainError("WEBHOOK_NOT_CONFIGURED", "Webhook registration is not ready.", 503);
    verifier = new PayPalWebhookVerifier(providerConfiguration(), webhookId);
  }
  await initializeDatabase();
  // Exact signed bytes are verified by PayPal postback. Core persists every
  // accepted/rejected delivery and canonical event hash. This intake never
  // dispatches a payment or treats a notification as settled money.
  const receipt = await paymentCore().ingestWebhook(webhookInboxScope(), rawBody, headers, verifier);
  return { accepted: true, duplicate: receipt.duplicate, eventId: receipt.eventId, state: "queued" as const };
}
