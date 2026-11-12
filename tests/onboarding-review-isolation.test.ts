import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSameOrigin, sessionCookieName, sessionCookieSecure } from "../lib/server/auth";
import { workspaceLibraryCookieName } from "../lib/server/community-workspaces";
import { assertProviderAccess, supporterQaEnabled, fundingQaEnabled } from "../lib/server/provider-access";
import { onboardingReviewEnabled } from "../lib/server/onboarding-review";

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  delete process.env.FIELDPROOF_ONBOARDING_REVIEW_PROFILE;
  for (const key of Object.keys(process.env)) if (/^(PAYPAL_|NEXT_PUBLIC_PAYPAL_)/.test(key) || /FIELDPROOF_.*QA/.test(key)) delete process.env[key];
  Object.assign(process.env, { NODE_ENV: "production", VERCEL: "0", FIELDPROOF_ONBOARDING_REVIEW: "true", FIELDPROOF_PROVIDER_ACCESS: "disabled", FIELDPROOF_PURPOSE_CHECKOUT_ENABLED: "false", APP_URL: "http://localhost:4563", DATABASE_URL: "postgresql://fp_onboarding_app:synthetic@127.0.0.1:55563/fp_onboarding_stage11", OPENAI_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", BLOB_READ_WRITE_TOKEN: "" });
});
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
const request = (origin: string, host = new URL(origin).host, site = "same-origin") => new Request(`http://${host}/api/supporters/entry/review`, { method: "POST", headers: { origin, host, "sec-fetch-site": site } });

describe("local native onboarding runtime confinement", () => {
  it("uses distinct cookies with an exact local origin and no actor fixture chooser", () => {
    assert.equal(onboardingReviewEnabled(), true); assert.equal(supporterQaEnabled(), false); assert.equal(fundingQaEnabled(), false);
    assert.equal(sessionCookieName(), "fieldproof_supporter_onboarding_session"); assert.equal(workspaceLibraryCookieName(), "fieldproof_supporter_onboarding_session_library"); assert.equal(sessionCookieSecure(), false);
    assert.doesNotThrow(() => assertSameOrigin(request("http://localhost:4563")));
    for (const origin of ["http://localhost:4102", "http://localhost:4560", "http://127.0.0.1:4563", "https://paypal-ai-fieldproof.vercel.app"]) assert.throws(() => assertSameOrigin(request(origin)), { code: "ORIGIN_DENIED" });
    assert.throws(() => assertSameOrigin(request("http://localhost:4563", "localhost:4560")), { code: "ORIGIN_DENIED" });
    assert.throws(() => assertSameOrigin(request("http://localhost:4563", undefined, "cross-site")), { code: "ORIGIN_DENIED" });
    for (const origin of [null, "null"]) { const headers = new Headers({ host: "localhost:4563" }); if (origin) headers.set("origin", origin); assert.throws(() => assertSameOrigin(new Request("http://localhost:4563/api/supporters", { method: "POST", headers })), { code: "ORIGIN_DENIED" }); }
    assert.throws(assertProviderAccess, { code: "PROVIDERS_DISABLED" });
  });
  it("fails closed for a shared or hosted database, other origin, or hosted process", () => {
    const original = process.env.DATABASE_URL;
    for (const value of ["postgresql://fp_onboarding_app:synthetic@hosted.example.invalid:55563/fp_onboarding_stage11", "postgresql://fp_onboarding_app:synthetic@127.0.0.1:55559/fp_onboarding_stage11", "postgresql://other:synthetic@127.0.0.1:55563/fp_onboarding_stage11", "postgresql://fp_onboarding_app:synthetic@127.0.0.1:55563/original"]) { process.env.DATABASE_URL = value; assert.throws(onboardingReviewEnabled, { code: "ONBOARDING_REVIEW_ISOLATION" }); }
    process.env.DATABASE_URL = original; process.env.APP_URL = "http://localhost:4560"; assert.throws(onboardingReviewEnabled, { code: "ONBOARDING_REVIEW_ISOLATION" });
    process.env.APP_URL = "http://localhost:4563"; process.env.VERCEL = "1"; assert.throws(onboardingReviewEnabled, { code: "ONBOARDING_REVIEW_ISOLATION" });
  });
  it("refuses any provider credential or enabled checkout", () => {
    for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "NEXT_PUBLIC_PAYPAL_CLIENT_ID", "PAYPAL_TEST_BUYER_EMAIL", "BLOB_READ_WRITE_TOKEN"]) { process.env[key] = "synthetic-only"; assert.throws(onboardingReviewEnabled, { code: "ONBOARDING_REVIEW_PROVIDERS" }); delete process.env[key]; }
    process.env.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED = "true"; assert.throws(onboardingReviewEnabled, { code: "ONBOARDING_REVIEW_PROVIDERS" }); process.env.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED = "false";
    delete process.env.FIELDPROOF_PROVIDER_ACCESS; assert.throws(onboardingReviewEnabled, { code: "ONBOARDING_REVIEW_PROVIDERS" });
  });
  it("retains normal production cookies and origin rules when the local profile is absent", () => {
    delete process.env.FIELDPROOF_ONBOARDING_REVIEW;
    assert.equal(onboardingReviewEnabled(), false); assert.equal(sessionCookieName(), "fieldproof_session"); assert.equal(sessionCookieSecure(), true);
    assert.doesNotThrow(() => assertSameOrigin(request("https://paypal-ai-fieldproof.vercel.app")));
    assert.throws(() => assertSameOrigin(request("http://localhost:4563")), { code: "ORIGIN_DENIED" });
  });
  it("isolates the corrected origin and cookies while preserving the original database and deadlines", () => {
    const originalDatabase = process.env.DATABASE_URL;
    process.env.FIELDPROOF_ONBOARDING_REVIEW_PROFILE = "contrast-stage11b";
    assert.throws(onboardingReviewEnabled, { code: "ONBOARDING_REVIEW_ISOLATION" });
    process.env.APP_URL = "http://localhost:4573";
    assert.equal(onboardingReviewEnabled(), true); assert.equal(process.env.DATABASE_URL, originalDatabase);
    assert.equal(sessionCookieName(), "fieldproof_supporter_onboarding_contrast_session");
    assert.equal(workspaceLibraryCookieName(), "fieldproof_supporter_onboarding_contrast_session_library");
    assert.equal(sessionCookieSecure(), false); assert.throws(assertProviderAccess, { code: "PROVIDERS_DISABLED" });
    assert.doesNotThrow(() => assertSameOrigin(request("http://localhost:4573")));
    assert.throws(() => assertSameOrigin(request("http://localhost:4563")), { code: "ORIGIN_DENIED" });
    assert.throws(() => assertSameOrigin(request("http://localhost:4573", "localhost:4563")), { code: "ORIGIN_DENIED" });
    process.env.FIELDPROOF_ONBOARDING_REVIEW_PROFILE = "arbitrary"; assert.throws(onboardingReviewEnabled, { code: "ONBOARDING_REVIEW_ISOLATION" });
  });
});
