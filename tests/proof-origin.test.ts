import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publicProofUrl } from "../lib/server/proof-origin";

describe("stable public proof destinations", () => {
  it("uses the stable hosted origin even when APP_URL is absent or contains an old local origin", () => {
    for (const APP_URL of [undefined, "http://localhost:4102", "https://preview.example"]) {
      assert.equal(publicProofUrl("sample-record", { VERCEL: "1", APP_URL }), "https://paypal-ai-fieldproof.vercel.app/proof/sample-record");
    }
  });
  it("keeps the isolated planning preview on its own port without changing payment callback origins", () => {
    assert.equal(publicProofUrl("sample-record", { NODE_ENV: "development", FIELDPROOF_PLANNING_QA: "true", APP_URL: "http://localhost:4502" }), "http://localhost:4502/proof/sample-record");
    assert.throws(() => publicProofUrl("sample-record", { NODE_ENV: "production", FIELDPROOF_PLANNING_QA: "true", APP_URL: "http://localhost:4502" }));
  });
  it("rejects unregistered local origins and cannot turn a slug into an external link", () => {
    assert.throws(() => publicProofUrl("sample-record", { APP_URL: "https://foreign.example" }));
    assert.equal(new URL(publicProofUrl("//foreign.example", { VERCEL: "1" })).origin, "https://paypal-ai-fieldproof.vercel.app");
  });
});
