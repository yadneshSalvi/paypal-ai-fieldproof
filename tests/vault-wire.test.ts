import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PaypalClient } from "paypal";
import { ApimaticVaultGateway } from "../lib/server/vault";

function fixtureGateway(handler: (request: Request) => Promise<Response>) {
  const client = new PaypalClient({ serverOptions: { baseUrl: "https://api-m.sandbox.paypal.com" }, oauth2: { clientId: "fixture-client", clientSecret: "fixture-secret" }, retry: { maxRetries: 0 }, logging: { level: "off" }, fetch: async request => {
    assert.ok(request instanceof Request);
    if (new URL(request.url).pathname === "/v1/oauth2/token") return Response.json({ access_token: "fixture-access-token", token_type: "Bearer", expires_in: 3600 });
    return handler(request);
  } });
  return new ApimaticVaultGateway(client);
}
describe("APIMatic Vault wire contract — fake fetch, no live requests", () => {
  it("sends the stable request header and generated snake_case body", async () => {
    let calls = 0;
    const gateway = fixtureGateway(async request => {
      calls++;
      assert.equal(request.method, "POST");
      assert.equal(new URL(request.url).pathname, "/v3/vault/setup-tokens");
      assert.equal(request.headers.get("PayPal-Request-Id"), "fixture-stable-request-id");
      assert.ok(request.signal);
      const body = await request.json();
      assert.equal(body.customer.merchant_customer_id, "fixture-customer");
      assert.equal(body.payment_source.paypal.usage_type, "MERCHANT");
      assert.equal(body.payment_source.paypal.usage_pattern, "UNSCHEDULED_PREPAID");
      assert.equal(body.payment_source.paypal.permit_multiple_payment_tokens, false);
      assert.equal(body.payment_source.paypal.experience_context.user_action, "CONTINUE");
      assert.equal(body.payment_source.paypal.experience_context.shipping_preference, "NO_SHIPPING");
      return Response.json({ id: "FIXTURESETUP0001", status: "PAYER_ACTION_REQUIRED" }, { status: 201 });
    });
    const result = await gateway.createSetup({ customer: { merchantCustomerId: "fixture-customer" }, paymentSource: { paypal: { usageType: "MERCHANT", usagePattern: "UNSCHEDULED_PREPAID", experienceContext: { returnUrl: "http://localhost:4102/commitment", cancelUrl: "http://localhost:4102/commitment", shippingPreference: "NO_SHIPPING" } } } }, "fixture-stable-request-id");
    assert.equal(result.outcome, "succeeded");
    assert.equal(calls, 1);
  });
  it("exchanges the exact owned setup and reads the actual token by its path", async () => {
    const paths: string[] = [];
    const gateway = fixtureGateway(async request => {
      paths.push(new URL(request.url).pathname);
      if (request.method === "POST") {
        assert.equal(request.headers.get("PayPal-Request-Id"), "fixture-token-request");
        assert.deepEqual(await request.json(), { payment_source: { token: { id: "FIXTURESETUP0001", type: "SETUP_TOKEN" } } });
      }
      return Response.json({ id: "FIXTURETOKEN0001", payment_source: { paypal: { payer_id: "FIXTUREPAYER0001", usage_type: "MERCHANT" } } });
    });
    const created = await gateway.exchangeSetup("FIXTURESETUP0001", "fixture-token-request");
    assert.equal(created.outcome, "succeeded");
    const read = await gateway.readToken("FIXTURETOKEN0001");
    assert.equal(read.outcome, "succeeded");
    assert.deepEqual(paths, ["/v3/vault/payment-tokens", "/v3/vault/payment-tokens/FIXTURETOKEN0001"]);
  });
  it("never retries mutations on 500, transport loss or malformed success", async () => {
    for (const failure of ["500", "transport", "decode"]) {
      let calls = 0;
      const gateway = fixtureGateway(async () => {
        calls++;
        if (failure === "transport") throw new TypeError("fixture transport interrupted");
        if (failure === "decode") return new Response("{invalid", { status: 200, headers: { "content-type": "application/json" } });
        return Response.json({ name: "INTERNAL_SERVER_ERROR", message: "fixture only", debug_id: "fixture" }, { status: 500 });
      });
      const result = await gateway.exchangeSetup("FIXTURESETUP0001", "fixture-uncertain-request");
      assert.equal(result.outcome, "unknown");
      assert.equal(calls, 1);
    }
  });
  it("separates provider refusal from unknown outcome without leaking response bodies", async () => {
    const gateway = fixtureGateway(async () => Response.json({ name: "NOT_AUTHORIZED", message: "private fixture detail", debug_id: "fixture" }, { status: 403 }));
    const result = await gateway.exchangeSetup("FIXTURESETUP0001", "fixture-denied-request");
    assert.deepEqual(result, { outcome: "refused", code: "NOT_AUTHORIZED", httpStatus: 403 });
    assert.ok(!JSON.stringify(result).includes("private fixture"));
  });
  it("retains bounded field diagnostics without rejected values or free text", async () => {
    const gateway=fixtureGateway(async()=>Response.json({name:"INVALID_REQUEST",message:"private description",debug_id:"fixture",details:[{issue:"INVALID_STRING_LENGTH",field:"/payment_source/paypal/description",value:"private rejected value",description:"private explanation"},{issue:"hostile prose with spaces",field:"private"}]},{status:400,headers:{"paypal-debug-id":"fixture-debug"}}));
    const result=await gateway.exchangeSetup("FIXTURESETUP0001","fixture-request");
    assert.deepEqual(result,{outcome:"refused",code:"INVALID_REQUEST",httpStatus:400,debugId:"fixture-debug",diagnostics:[{issue:"INVALID_STRING_LENGTH",field:"/payment_source/paypal/description"}]});
    assert.ok(!JSON.stringify(result).includes("private"));
  });
});
