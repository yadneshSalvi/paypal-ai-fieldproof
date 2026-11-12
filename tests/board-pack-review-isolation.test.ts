import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSameOrigin, sessionCookieName, sessionCookieSecure } from "../lib/server/auth";
import { workspaceLibraryCookieName } from "../lib/server/community-workspaces";
import { assertProviderAccess } from "../lib/server/provider-access";
import { boardPackReviewEnabled } from "../lib/server/board-pack-review";

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (/^(FIELDPROOF_|PAYPAL_|NEXT_PUBLIC_PAYPAL_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { NODE_ENV: "production", VERCEL: "0", FIELDPROOF_BOARD_PACK_REVIEW: "true", FIELDPROOF_PROVIDER_ACCESS: "disabled", FIELDPROOF_PURPOSE_CHECKOUT_ENABLED: "false", APP_URL: "http://localhost:4595", DATABASE_URL: "postgresql://fp_boardpack_app:synthetic@127.0.0.1:55571/fp_boardpack_stage12", OPENAI_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", BLOB_READ_WRITE_TOKEN: "" });
});
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
const request = (origin: string, host = new URL(origin).host, site = "same-origin") => new Request(`http://${host}/api/board-packs`, { method: "POST", headers: { origin, host, "sec-fetch-site": site } });

describe("corrected Board Pack runtime confinement", () => {
  it("keeps the original cookie identity and accepts only the assigned successor origin", () => {
    assert.equal(boardPackReviewEnabled(), true);
    assert.equal(sessionCookieName(), "fieldproof_boardpack_stage12_session");
    assert.equal(workspaceLibraryCookieName(), "fieldproof_boardpack_stage12_session_library");
    assert.equal(sessionCookieSecure(), false);
    assert.doesNotThrow(() => assertSameOrigin(request("http://localhost:4595")));
    for (const origin of ["http://localhost:4578", "http://localhost:4591", "http://localhost:4581", "http://127.0.0.1:4595", "https://paypal-ai-fieldproof.vercel.app"])
      assert.throws(() => assertSameOrigin(request(origin)), { code: "ORIGIN_DENIED" });
    assert.throws(() => assertSameOrigin(request("http://localhost:4595", "localhost:4578")), { code: "ORIGIN_DENIED" });
    assert.throws(() => assertSameOrigin(request("http://localhost:4595", undefined, "cross-site")), { code: "ORIGIN_DENIED" });
    assert.throws(assertProviderAccess, { code: "PROVIDERS_DISABLED" });
  });
  it("cannot adopt a different database, origin or hosted process", () => {
    const original = process.env.DATABASE_URL;
    for (const value of ["postgresql://fp_boardpack_app:synthetic@hosted.example.invalid:55571/fp_boardpack_stage12", "postgresql://fp_boardpack_app:synthetic@127.0.0.1:55563/fp_boardpack_stage12", "postgresql://other:synthetic@127.0.0.1:55571/fp_boardpack_stage12", "postgresql://fp_boardpack_app:synthetic@127.0.0.1:55571/original"]) {
      process.env.DATABASE_URL = value; assert.throws(boardPackReviewEnabled, { code: "BOARD_PACK_REVIEW_ISOLATION" });
    }
    process.env.DATABASE_URL = original; process.env.APP_URL = "http://localhost:4578"; assert.throws(boardPackReviewEnabled, { code: "BOARD_PACK_REVIEW_ISOLATION" });
    process.env.APP_URL = "http://localhost:4595"; process.env.VERCEL = "1"; assert.throws(boardPackReviewEnabled, { code: "BOARD_PACK_REVIEW_ISOLATION" });
  });
  it("refuses credentials or a provider-capable checkout", () => {
    for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "NEXT_PUBLIC_PAYPAL_CLIENT_ID", "PAYPAL_TEST_BUYER_EMAIL", "BLOB_READ_WRITE_TOKEN"]) {
      process.env[key] = "synthetic-only"; assert.throws(boardPackReviewEnabled, { code: "BOARD_PACK_REVIEW_PROVIDERS" }); delete process.env[key];
    }
    process.env.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED = "true"; assert.throws(boardPackReviewEnabled, { code: "BOARD_PACK_REVIEW_PROVIDERS" });
    process.env.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED = "false"; delete process.env.FIELDPROOF_PROVIDER_ACCESS; assert.throws(boardPackReviewEnabled, { code: "BOARD_PACK_REVIEW_PROVIDERS" });
  });
  it("leaves normal production authority unchanged when the review profile is absent", () => {
    delete process.env.FIELDPROOF_BOARD_PACK_REVIEW;
    assert.equal(boardPackReviewEnabled(), false); assert.equal(sessionCookieName(), "fieldproof_session"); assert.equal(sessionCookieSecure(), true);
    assert.doesNotThrow(() => assertSameOrigin(request("https://paypal-ai-fieldproof.vercel.app")));
    assert.throws(() => assertSameOrigin(request("http://localhost:4595")), { code: "ORIGIN_DENIED" });
  });
});
