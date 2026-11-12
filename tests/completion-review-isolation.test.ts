import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completionReviewEnabled } from "../lib/server/completion-review";
import { publicProofUrl } from "../lib/server/proof-origin";

const valid = (): Partial<NodeJS.ProcessEnv> => ({ FIELDPROOF_COMPLETION_REVIEW: "true", DATABASE_URL: "postgresql://fp_completion_app:synthetic-private-test@127.0.0.1:55571/fp_completion_stage14", APP_URL: "http://localhost:4624", FIELDPROOF_PROVIDER_ACCESS: "disabled", FIELDPROOF_PURPOSE_CHECKOUT_ENABLED: "false", PAYPAL_ENVIRONMENT: "sandbox", PAYPAL_PROJECT_ISOLATED: "false" });
const isolation = (value: unknown) => value instanceof Error && "code" in value && value.code === "COMPLETION_REVIEW_ISOLATION";
const providers = (value: unknown) => value instanceof Error && "code" in value && value.code === "COMPLETION_REVIEW_PROVIDERS";
describe("combined review remains isolated from production and original actors", () => {
  it("does nothing unless explicitly enabled, even with an unrelated production configuration", () => {
    assert.equal(completionReviewEnabled({ VERCEL: "1", DATABASE_URL: "not-a-url", APP_URL: "https://example.invalid" }), false);
    assert.equal(completionReviewEnabled({ ...valid(), FIELDPROOF_COMPLETION_REVIEW: "false" }), false);
    assert.equal(completionReviewEnabled(valid()), true);
    assert.equal(completionReviewEnabled({ ...valid(), APP_URL: "http://localhost:4625" }), true);
  });
  it("requires the exact allocated origin, fresh database and restricted role, with no alternate search path", () => {
    for (const url of ["not-a-url", "https://fp_completion_app:test@127.0.0.1:55571/fp_completion_stage14", "postgresql://fp_completion_app:test@localhost:55571/fp_completion_stage14", "postgresql://fp_completion_app:test@127.0.0.1:55572/fp_completion_stage14", "postgresql://fp_governance_app:test@127.0.0.1:55571/fp_completion_stage14", "postgresql://fp_completion_app:test@127.0.0.1:55571/fp_lifecycle_stage14", "postgresql://fp_completion_app@127.0.0.1:55571/fp_completion_stage14", valid().DATABASE_URL + "?options=-c%20search_path=public", valid().DATABASE_URL + "#unexpected"]) assert.throws(() => completionReviewEnabled({ ...valid(), DATABASE_URL: url }), isolation);
    for (const APP_URL of ["http://localhost:4620", "http://localhost:4626", "http://127.0.0.1:4624", "http://127.0.0.1:4625", "http://localhost:4625/", "https://paypal-ai-fieldproof.vercel.app", "http://localhost:4624/"]) assert.throws(() => completionReviewEnabled({ ...valid(), APP_URL }), isolation);
  });
  it("uses only the exact selected local origin for public links", () => {
    for (const APP_URL of ["http://localhost:4624", "http://localhost:4625"]) assert.equal(publicProofUrl("original-slug", { ...valid(), APP_URL }), APP_URL + "/proof/original-slug");
    assert.throws(() => publicProofUrl("original-slug", { ...valid(), APP_URL: "http://localhost:4626" }), isolation);
  });
  it("rejects hosted execution and every competing local actor or fixture mode", () => {
    for (const key of ["VERCEL", "FIELDPROOF_LIFECYCLE_REVIEW", "FIELDPROOF_GOVERNANCE_REVIEW", "FIELDPROOF_BOARD_PACK_REVIEW", "FIELDPROOF_ONBOARDING_REVIEW", "FIELDPROOF_FUNDING_QA", "FIELDPROOF_SUPPORTER_QA", "FIELDPROOF_COMMUNITY_QA", "FIELDPROOF_STUDIO_QA", "FIELDPROOF_PLANNING_QA"]) assert.throws(() => completionReviewEnabled({ ...valid(), [key]: key === "VERCEL" ? "1" : "true" }), isolation);
  });
  it("rejects provider enablement, all external credentials and newly named PayPal credentials", () => {
    for (const key of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "PAYPAL_MERCHANT_SCOPE", "PAYPAL_FUTURE_TOKEN", "NEXT_PUBLIC_PAYPAL_CLIENT_ID", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "BLOB_READ_WRITE_TOKEN"]) assert.throws(() => completionReviewEnabled({ ...valid(), [key]: "controlled-canary" }), providers);
    for (const [key, value] of Object.entries({ FIELDPROOF_PROVIDER_ACCESS: "enabled", FIELDPROOF_PURPOSE_CHECKOUT_ENABLED: "true", PAYPAL_ENVIRONMENT: "live", PAYPAL_PROJECT_ISOLATED: "true" })) assert.throws(() => completionReviewEnabled({ ...valid(), [key]: value }), providers);
  });
});
