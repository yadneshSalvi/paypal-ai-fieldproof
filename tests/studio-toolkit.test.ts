import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { controlledToolkitFixture, resetControlledToolkitAuthority } from "./helpers/toolkit-controlled-authority";
import { toolkitNetworkAttempts, toolkitDeniedNetworkReceipt } from "./helpers/toolkit-deny-network.mjs";
import type { ToolkitReader } from "../lib/server/studio-toolkit";

// Load after the explicit test-only DB/report seam and network guard. The same
// six behavior groups run without a DB or real materialized-report claim.
const { actualToolkitReader, ownedToolkitReadSchema, readOwnedToolkitResource, toolkitLoggingEnabled } = await import("../lib/server/studio-toolkit");
const envKeys = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_ENVIRONMENT", "PAYPAL_PROJECT_ISOLATED", "PAYPAL_API_BASE_URL", "PAYPAL_MERCHANT_ID", "DEBUG"] as const;
const original = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
before(() => {
  process.env.PAYPAL_CLIENT_ID = "controlled-toolkit-client"; process.env.PAYPAL_CLIENT_SECRET = "controlled-toolkit-secret";
  process.env.PAYPAL_ENVIRONMENT = "sandbox"; process.env.PAYPAL_PROJECT_ISOLATED = "true";
  process.env.PAYPAL_API_BASE_URL = "https://api-m.sandbox.paypal.com"; process.env.PAYPAL_MERCHANT_ID = "CONTROLLED-MERCHANT"; delete process.env.DEBUG;
});
after(() => {
  for (const key of envKeys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  resetControlledToolkitAuthority(); assert.equal(toolkitNetworkAttempts(), 0, JSON.stringify(toolkitDeniedNetworkReceipt()));
});
const code = (value: string) => (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === value;
const fixture = controlledToolkitFixture;

describe("exact owned PayPal Toolkit reads - synthetic authority doubles, no DB", () => {
  it("executes the installed official Toolkit's exact OAuth and GET paths without any real provider request", async () => {
    const calls: { method: string; url: string }[] = [];
    const wire = mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input); calls.push({ method: init.method!, url });
      assert.equal(init.redirect, "error"); assert.ok(init.signal);
      if (init.method === "POST") { assert.equal(url, "https://api.sandbox.paypal.com/v1/oauth2/token"); assert.equal(init.body, "grant_type=client_credentials"); return Response.json({ access_token: "controlled-access-token" }); }
      assert.equal(init.method, "GET"); const id = url.split("/").at(-1);
      assert.ok(["5O190127TN364715T", "INV2-TEST-ONLY-1234"].includes(id!));
      return Response.json({ id, status: "COMPLETED" });
    });
    try {
      await actualToolkitReader.read("get_order", "5O190127TN364715T"); await actualToolkitReader.read("get_invoice", "INV2-TEST-ONLY-1234");
      assert.deepEqual(calls.map(item => `${item.method} ${item.url}`), [
        "POST https://api.sandbox.paypal.com/v1/oauth2/token", "GET https://api.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T",
        "POST https://api.sandbox.paypal.com/v1/oauth2/token", "GET https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-TEST-ONLY-1234",
      ]);
      await assert.rejects(actualToolkitReader.read("create_order" as "get_order", "5O190127TN364715T"), code("TOOLKIT_ACTION_DENIED"));
      assert.equal(calls.length, 4, "the SDK's non-enforcing action inventory cannot open another operation");
    } finally { wire.mock.restore(); }
  });
  it("resolves the provider id only after exact receipt and ownership checks and returns a redacted allowlist", async () => {
    const f = fixture(), calls: string[] = [], originalReceipt = JSON.stringify(f.receipt);
    const reader: ToolkitReader = { async read(tool, id) { calls.push(`${tool}:${id}`); return { id, status: "COMPLETED", payer: { email_address: "private-payer@example.invalid", name: "Private name" }, purchase_units: [{ payee: { merchant_id: "CONTROLLED-MERCHANT" } }], links: [{ href: "https://private.example.invalid" }], untrusted_metadata: JSON.parse('{"__proto__":{"toolkitInjected":true},"lc":1,"type":"secret","id":["SYNTHETIC_ONLY"]}') }; } };
    const read = await readOwnedToolkitResource(f.session, f.snapshot, { tool: "get_order", receiptId: f.receipt.id }, reader);
    assert.deepEqual(calls, [`get_order:${f.order}`]); assert.equal(read.receiptId, f.receipt.id); assert.equal(read.resourceState, "COMPLETED"); assert.equal(read.responseHash.length, 64);
    for (const privateValue of ["private-payer", "Private name", f.order, "private.example.invalid", "toolkitInjected", "SYNTHETIC_ONLY"]) assert.equal(JSON.stringify(read).includes(privateValue), false);
    assert.equal(Object.hasOwn(Object.prototype, "toolkitInjected"), false); assert.equal(read.storedReceiptState, "COMPLETED");
    await assert.rejects(readOwnedToolkitResource(f.session, f.snapshot, { tool: "get_invoice", receiptId: f.receipt.id }, reader), code("TOOLKIT_RAIL_MISMATCH"));
    await assert.rejects(readOwnedToolkitResource(f.session, f.snapshot, { tool: "get_order", receiptId: "somebody-else" }, reader), code("TOOLKIT_RESOURCE_DENIED"));
    assert.equal(calls.length, 1); assert.equal(JSON.stringify(f.receipt), originalReceipt);
    assert.equal(ownedToolkitReadSchema.safeParse({ tool: "get_order", receiptId: f.receipt.id, providerId: "OTHER-ORDER" }).success, false);
    const denied = mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit = {}) => Response.json(init.method === "POST" ? { access_token: "controlled-token" } : { id: f.order, status: "COMPLETED" }, { status: init.method === "POST" ? 200 : 503 }));
    try { await assert.rejects(readOwnedToolkitResource(f.session, f.snapshot, { tool: "get_order", receiptId: f.receipt.id }), code("TOOLKIT_READ_UNAVAILABLE")); assert.equal(JSON.stringify(f.receipt), originalReceipt); }
    finally { denied.mock.restore(); }
  });
  it("denies a donor's changed ownership and refuses a mismatched merchant without changing settlement state", async () => {
    const f = fixture("donor"); let called = 0;
    const reader: ToolkitReader = { async read(_tool, id) { called++; return { id, status: "COMPLETED", purchase_units: [{ payee: { merchant_id: "ANOTHER-MERCHANT" } }] }; } };
    await assert.rejects(readOwnedToolkitResource(f.session, f.snapshot, { tool: "get_order", receiptId: f.receipt.id }, reader), code("TOOLKIT_MERCHANT_MISMATCH"));
    f.owner = randomUUID();
    await assert.rejects(readOwnedToolkitResource(f.session, f.snapshot, { tool: "get_order", receiptId: f.receipt.id }, reader), code("TOOLKIT_RESOURCE_DENIED"));
    assert.equal(called, 1); assert.equal(f.receipt.creditedMinor, 3500);
  });
  it("keeps cutoff inclusion exact when an included PostgreSQL timestamp has sub-millisecond precision", async () => {
    const f = fixture(); f.createdAt = Date.parse(f.snapshot.asOf) + 0.5;
    const reader: ToolkitReader = { read: async (_tool, id) => ({ id, status: "COMPLETED", purchase_units: [{ payee: { merchant_id: "CONTROLLED-MERCHANT" } }] }) };
    assert.equal((await readOwnedToolkitResource(f.session, f.snapshot, { tool: "get_order", receiptId: f.receipt.id }, reader)).resourceState, "COMPLETED");
    await assert.rejects(readOwnedToolkitResource(f.session, f.snapshot, { tool: "get_order", receiptId: `${f.receipt.id}-new` }, reader), code("TOOLKIT_RESOURCE_DENIED"));
  });
  it("reauthorizes after the network read and refuses sample or volunteer provider reads", async () => {
    const f = fixture();
    const reader: ToolkitReader = { async read(_tool, id) { f.membership.state = "revoked"; f.membership.version++; return { id, status: "COMPLETED" }; } };
    await assert.rejects(readOwnedToolkitResource(f.session, f.snapshot, { tool: "get_order", receiptId: f.receipt.id }, reader), code("MEMBERSHIP_DENIED"));
    const sample = fixture("organizer", "sample");
    await assert.rejects(readOwnedToolkitResource(sample.session, sample.snapshot, { tool: "get_order", receiptId: sample.receipt.id }, reader), code("TOOLKIT_SAMPLE_SOURCE"));
    const volunteer = fixture("volunteer");
    await assert.rejects(readOwnedToolkitResource(volunteer.session, volunteer.snapshot, { tool: "get_order", receiptId: volunteer.receipt.id }, reader), code("TOOLKIT_ROLE_DENIED"));
  });
  it("fails closed when global Toolkit debug output could expose provider identities", async () => {
    assert.equal(toolkitLoggingEnabled("next:*"), false); assert.equal(toolkitLoggingEnabled("*"), true); assert.equal(toolkitLoggingEnabled("agent-toolkit:*"), true);
    assert.equal(toolkitLoggingEnabled("*,-agent-toolkit:*"), false);
    process.env.DEBUG = "agent-toolkit:*";
    try { await assert.rejects(actualToolkitReader.read("get_order", "5O190127TN364715T"), code("TOOLKIT_DEBUG_UNSAFE")); } finally { delete process.env.DEBUG; }
  });
});
