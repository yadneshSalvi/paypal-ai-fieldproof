import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { Session } from "../lib/server/auth";
import { database, initializeDatabase, query } from "../lib/server/db";
import { createProject, sampleReceipt } from "../lib/server/seed";
import { materializeStudioDataset } from "../lib/server/studio-datasets";
import { actualToolkitReader, ownedToolkitReadSchema, readOwnedToolkitResource, toolkitLoggingEnabled, type ToolkitReader } from "../lib/server/studio-toolkit";

const envKeys = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_ENVIRONMENT", "PAYPAL_PROJECT_ISOLATED", "PAYPAL_API_BASE_URL", "PAYPAL_MERCHANT_ID", "DEBUG"] as const;
const original = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
before(async () => {
  process.env.PAYPAL_CLIENT_ID = "controlled-toolkit-client"; process.env.PAYPAL_CLIENT_SECRET = "controlled-toolkit-secret";
  process.env.PAYPAL_ENVIRONMENT = "sandbox"; process.env.PAYPAL_PROJECT_ISOLATED = "true";
  process.env.PAYPAL_API_BASE_URL = "https://api-m.sandbox.paypal.com"; process.env.PAYPAL_MERCHANT_ID = "CONTROLLED-MERCHANT"; delete process.env.DEBUG;
  await initializeDatabase();
});
after(async () => { for (const key of envKeys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; } await database().close(); });
const code = (value: string) => (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === value;
async function fixture(role: Session["role"] = "organizer") {
  const session: Session = { id: randomUUID(), tenantId: randomUUID(), projectId: randomUUID(), actorId: randomUUID(), role, mode: "live_sandbox", expiresAt: new Date(Date.now() + 3600000).toISOString() };
  await database().transaction(async tx => {
    await createProject(tx, session.tenantId, session.projectId, `toolkit-fixture-${randomUUID()}`, session.mode);
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [session.id, randomUUID(), session.tenantId, session.projectId, session.actorId, role, session.expiresAt]);
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,'[\"organizer\",\"auditor\",\"donor\",\"volunteer\"]')", [session.tenantId, session.projectId, session.actorId]);
  });
  const obligation = randomUUID(), order = "5O190127TN364715T";
  const receipt = sampleReceipt(session.tenantId, session.projectId, obligation, "electronics", 3500, randomUUID());
  receipt.provenance = "live_sandbox"; receipt.sourceOrderId = order;
  await query("INSERT INTO fp_obligations(id,tenant_id,project_id,package_id,actor_id,amount_minor,channel,purpose,data) VALUES($1,$2,$3,'electronics',$4,3500,'collected','conditional_pledge','{}')", [obligation, session.tenantId, session.projectId, session.actorId]);
  await query("INSERT INTO fp_settlement_receipts(id,tenant_id,project_id,obligation_id,package_id,provider_ref,provenance,data) VALUES($1,$2,$3,$4,'electronics',$5,'live_sandbox',$6::jsonb)", [receipt.id, session.tenantId, session.projectId, obligation, receipt.actualProviderPaymentRef, JSON.stringify(receipt)]);
  // Unique per fixture, while provider identity is a deterministic SDK-shaped fixture.
  await query("INSERT INTO fp_provider_orders(order_id,tenant_id,project_id,obligation_id,operation_id,observed_state) VALUES($1,$2,$3,$4,$5,'COMPLETED') ON CONFLICT(order_id) DO UPDATE SET tenant_id=$2,project_id=$3,obligation_id=$4,operation_id=$5", [order, session.tenantId, session.projectId, obligation, randomUUID()]);
  return { session, receipt, order, obligation, snapshot: await materializeStudioDataset(session) };
}
describe("exact owned PayPal Toolkit reads", () => {
  it("executes the installed official Toolkit's exact OAuth and GET paths without any real provider request", async () => {
    const require = createRequire(import.meta.url), toolkitRequire = createRequire(require.resolve("@paypal/agent-toolkit/openai"));
    // Patch the exact axios object used by the installed CJS Toolkit. Every transport
    // method used by the two allowed reads is intercepted; credentials are synthetic.
    const axios = toolkitRequire("axios") as { post: (...args: unknown[]) => Promise<unknown>; get: (...args: unknown[]) => Promise<unknown> };
    const calls: { method: string; url: string }[] = [];
    const post = mock.method(axios, "post", async (url: unknown, body: unknown) => {
      assert.equal(url, "https://api.sandbox.paypal.com/v1/oauth2/token"); assert.equal(body, "grant_type=client_credentials");
      calls.push({ method: "POST", url: String(url) }); return { data: { access_token: "controlled-access-token" }, status: 200 };
    });
    const get = mock.method(axios, "get", async (url: unknown) => {
      assert.ok(typeof url === "string"); calls.push({ method: "GET", url });
      const id = url.split("/").at(-1); assert.ok(["5O190127TN364715T", "INV2-TEST-ONLY-1234"].includes(id!));
      return { data: { id, status: "COMPLETED" }, status: 200 };
    });
    try {
      await actualToolkitReader.read("get_order", "5O190127TN364715T"); await actualToolkitReader.read("get_invoice", "INV2-TEST-ONLY-1234");
      assert.deepEqual(calls.map(item => `${item.method} ${item.url}`), [
        "POST https://api.sandbox.paypal.com/v1/oauth2/token", "GET https://api.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T",
        "POST https://api.sandbox.paypal.com/v1/oauth2/token", "GET https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-TEST-ONLY-1234",
      ]);
      await assert.rejects(actualToolkitReader.read("create_order" as "get_order", "5O190127TN364715T"), code("TOOLKIT_ACTION_DENIED"));
      assert.equal(calls.length, 4, "the SDK's non-enforcing action inventory cannot open another operation");
    } finally { post.mock.restore(); get.mock.restore(); }
  });
  it("resolves the provider id only after exact receipt and ownership checks and returns a redacted allowlist", async () => {
    const f = await fixture(), calls: string[] = [];
    const reader: ToolkitReader = { async read(tool, id) { calls.push(`${tool}:${id}`); return { id, status: "COMPLETED", payer: { email_address: "private-payer@example.invalid", name: "Private name" }, purchase_units: [{ payee: { merchant_id: "CONTROLLED-MERCHANT" } }], links: [{ href: "https://private.example.invalid" }] }; } };
    const read = await readOwnedToolkitResource(f.session, f.snapshot, { tool: "get_order", receiptId: f.receipt.id }, reader);
    assert.deepEqual(calls, [`get_order:${f.order}`]); assert.equal(read.receiptId, f.receipt.id); assert.equal(read.resourceState, "COMPLETED"); assert.equal(read.responseHash.length, 64);
    assert.equal(JSON.stringify(read).includes("private-payer"), false); assert.equal(JSON.stringify(read).includes(f.order), false); assert.equal(read.storedReceiptState, "COMPLETED");
    await assert.rejects(readOwnedToolkitResource(f.session, f.snapshot, { tool: "get_invoice", receiptId: f.receipt.id }, reader), code("TOOLKIT_RAIL_MISMATCH"));
    await assert.rejects(readOwnedToolkitResource(f.session, f.snapshot, { tool: "get_order", receiptId: "somebody-else" }, reader), code("TOOLKIT_RESOURCE_DENIED"));
    assert.equal(calls.length, 1);
    assert.equal(ownedToolkitReadSchema.safeParse({ tool: "get_order", receiptId: f.receipt.id, providerId: "OTHER-ORDER" }).success, false);
  });
  it("denies a donor's changed ownership and refuses a mismatched merchant without changing settlement state", async () => {
    const f = await fixture("donor"); let called = 0;
    const reader: ToolkitReader = { async read(_tool, id) { called++; return { id, status: "COMPLETED", purchase_units: [{ payee: { merchant_id: "ANOTHER-MERCHANT" } }] }; } };
    await assert.rejects(readOwnedToolkitResource(f.session, f.snapshot, { tool: "get_order", receiptId: f.receipt.id }, reader), code("TOOLKIT_MERCHANT_MISMATCH"));
    await query("UPDATE fp_obligations SET actor_id=$2 WHERE id=$1", [f.obligation, randomUUID()]);
    await assert.rejects(readOwnedToolkitResource(f.session, f.snapshot, { tool: "get_order", receiptId: f.receipt.id }, reader), code("TOOLKIT_RESOURCE_DENIED"));
    assert.equal(called, 1); const [receipt] = await query<{ data: { creditedMinor: number } }>("SELECT data FROM fp_settlement_receipts WHERE id=$1", [f.receipt.id]); assert.equal(receipt.data.creditedMinor, 3500);
  });
  it("keeps cutoff inclusion exact when an included PostgreSQL timestamp has sub-millisecond precision", async () => {
    const f = await fixture();
    await query("UPDATE fp_settlement_receipts SET created_at=$2::timestamptz + interval '0.0005 seconds' WHERE id=$1", [f.receipt.id, f.snapshot.asOf]);
    const reader: ToolkitReader = { read: async (_tool, id) => ({ id, status: "COMPLETED", purchase_units: [{ payee: { merchant_id: "CONTROLLED-MERCHANT" } }] }) };
    assert.equal((await readOwnedToolkitResource(f.session, f.snapshot, { tool: "get_order", receiptId: f.receipt.id }, reader)).resourceState, "COMPLETED");
    await assert.rejects(readOwnedToolkitResource(f.session, f.snapshot, { tool: "get_order", receiptId: `${f.receipt.id}-new` }, reader), code("TOOLKIT_RESOURCE_DENIED"));
  });
  it("reauthorizes after the network read and refuses sample or volunteer provider reads", async () => {
    const f = await fixture();
    const reader: ToolkitReader = { async read(_tool, id) { await query("UPDATE fp_memberships SET state='revoked',version=version+1 WHERE project_id=$1", [f.session.projectId]); return { id, status: "COMPLETED" }; } };
    await assert.rejects(readOwnedToolkitResource(f.session, f.snapshot, { tool: "get_order", receiptId: f.receipt.id }, reader), code("MEMBERSHIP_DENIED"));
    const sample = await fixture();
    await query("UPDATE fp_tenants SET mode='sample' WHERE id=$1", [sample.session.tenantId]);
    sample.session.mode = "sample";
    const sampleCutoff = await materializeStudioDataset(sample.session);
    await assert.rejects(readOwnedToolkitResource(sample.session, sampleCutoff, { tool: "get_order", receiptId: sample.receipt.id }, reader), code("TOOLKIT_SAMPLE_SOURCE"));
    const volunteer = await fixture("volunteer");
    await assert.rejects(readOwnedToolkitResource(volunteer.session, volunteer.snapshot, { tool: "get_order", receiptId: volunteer.receipt.id }, reader), code("TOOLKIT_ROLE_DENIED"));
  });
  it("fails closed when global Toolkit debug output could expose provider identities", async () => {
    assert.equal(toolkitLoggingEnabled("next:*"), false); assert.equal(toolkitLoggingEnabled("*"), true); assert.equal(toolkitLoggingEnabled("agent-toolkit:*"), true);
    assert.equal(toolkitLoggingEnabled("*,-agent-toolkit:*"), false);
    process.env.DEBUG = "agent-toolkit:*";
    try { await assert.rejects(actualToolkitReader.read("get_order", "5O190127TN364715T"), code("TOOLKIT_DEBUG_UNSAFE")); } finally { delete process.env.DEBUG; }
  });
});
