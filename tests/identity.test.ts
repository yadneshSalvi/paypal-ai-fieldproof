import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifiedPayPalProfileSchema } from "../lib/domain/identity";

describe("PayPal recipient identity contract", () => {
  const payer_id = "TESTPAYER12345";
  it("accepts only documented or observed affirmative verification forms", () => {
    for (const verified_account of [true, "true"]) {
      const result = verifiedPayPalProfileSchema.parse({ payer_id, verified_account });
      assert.equal(result.verified_account, true);
      assert.equal(result.payer_id, payer_id);
    }
  });
  it("rejects false, missing, numeric, differently cased and padded verification", () => {
    for (const verified_account of [false, "false", undefined, null, 1, "1", "TRUE", " true", "true ", {}, []]) {
      assert.equal(verifiedPayPalProfileSchema.safeParse({ payer_id, verified_account }).success, false);
    }
  });
  it("requires a payer ID instead of substituting the subject or user ID", () => {
    for (const candidate of [undefined, null, "", "tiny", "has spaces", "https://example.com/user", "A".repeat(65)]) {
      assert.equal(verifiedPayPalProfileSchema.safeParse({ payer_id: candidate, sub: payer_id, user_id: payer_id, verified_account: true }).success, false);
    }
  });
});
