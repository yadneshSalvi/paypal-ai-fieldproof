import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PayPalWebhookVerifier } from "@fracture/paypal-core";
import { database, query } from "../lib/server/db";
import { providerConfiguration } from "../lib/server/payments";
import { limitedWebhookBody, receivePayPalWebhook, WEBHOOK_MAX_BYTES, webhookInboxScope } from "../lib/server/webhooks";

const eventIds: string[] = [];
function event() { const id = `TEST-${randomUUID()}`; eventIds.push(id); return { id, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "TESTCAPTURE123", amount: { value: "9999.00", currency_code: "USD" } } }; }
after(async () => {
  const scope = webhookInboxScope();
  for (const id of eventIds) {
    await query("DELETE FROM paycore_webhook_deliveries WHERE tenant_id=$1 AND event_id=$2", [scope.tenantId, id]);
    await query("DELETE FROM paycore_webhook_events WHERE tenant_id=$1 AND event_id=$2", [scope.tenantId, id]);
  }
  await database().close();
});

describe("durable provider webhook intake", () => {
  it("records missing-signature rejection without crediting an alleged payment", async () => {
    const payload = event();
    let providerCalls = 0;
    const verifier = new PayPalWebhookVerifier(providerConfiguration(), "TEST_REGISTERED_WEBHOOK", async () => { providerCalls++; throw new Error("No signature must not trigger verification traffic"); });
    await assert.rejects(() => receivePayPalWebhook(JSON.stringify(payload), new Headers(), verifier), { code: "INVALID_SIGNATURE" });
    assert.equal(providerCalls, 0);
    const deliveries = await query<{verified:number}>("SELECT verified FROM paycore_webhook_deliveries WHERE tenant_id=$1 AND event_id=$2", [webhookInboxScope().tenantId, payload.id]);
    assert.equal(deliveries.length, 1); assert.equal(deliveries[0].verified, 0);
    assert.equal((await query("SELECT id FROM fp_settlement_receipts WHERE provider_ref='TESTCAPTURE123'")).length, 0);
  });
  it("deduplicates concurrent verified events while retaining every delivery and no money projection", async () => {
    const payload = event(), raw = JSON.stringify(payload);
    const verifier = { verify: async () => ({ verified: true, transmissionId: `test-${randomUUID()}` }) };
    const results = await Promise.all(Array.from({length:5}, () => receivePayPalWebhook(raw, new Headers(), verifier)));
    assert.equal(results.filter(result => !result.duplicate).length, 1);
    const scope = webhookInboxScope();
    assert.equal((await query("SELECT event_id FROM paycore_webhook_events WHERE tenant_id=$1 AND event_id=$2", [scope.tenantId, payload.id])).length, 1);
    assert.equal((await query("SELECT id FROM paycore_webhook_deliveries WHERE tenant_id=$1 AND event_id=$2", [scope.tenantId, payload.id])).length, 5);
    await assert.rejects(() => receivePayPalWebhook(JSON.stringify({...payload, resource:{...payload.resource,id:"CHANGEDCAPTURE"}}), new Headers(), verifier), { code: "WEBHOOK_PAYLOAD_CONFLICT" });
    assert.equal((await query("SELECT id FROM fp_settlement_receipts WHERE provider_ref='TESTCAPTURE123'")).length, 0);
  });
  it("bounds chunked request bodies even without a Content-Length header", async () => {
    const request = new Request("https://example.test/api/paypal/webhook", {method:"POST",body:"x".repeat(WEBHOOK_MAX_BYTES+1)});
    await assert.rejects(() => limitedWebhookBody(request), { code:"WEBHOOK_TOO_LARGE" });
    const raw=' { "id": "preserve-whitespace" }\n';
    assert.equal(await limitedWebhookBody(new Request("https://example.test",{method:"POST",body:raw})), raw);
  });
});
