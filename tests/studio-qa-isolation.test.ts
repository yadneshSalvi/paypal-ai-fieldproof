import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSameOrigin, sessionCookieName } from "../lib/server/auth";
const saved = { node: process.env.NODE_ENV, flag: process.env.FIELDPROOF_STUDIO_QA, url: process.env.DATABASE_URL };
after(() => { for (const [key, value] of Object.entries({ NODE_ENV: saved.node, FIELDPROOF_STUDIO_QA: saved.flag, DATABASE_URL: saved.url })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
describe("isolated Studio review process", () => {
  it("keeps the original localhost cookie intact and requires a distinct local QA database", () => {
    Object.assign(process.env, { NODE_ENV: "development", FIELDPROOF_STUDIO_QA: "true" });
    process.env.DATABASE_URL = "postgresql://fixture:fixture@localhost:5432/fp_studio_qa_controlled";
    assert.equal(sessionCookieName(), "fieldproof_studio_qa_session");
    process.env.DATABASE_URL = "postgresql://fixture:fixture@localhost:5432/original_database";
    assert.throws(sessionCookieName, /own local database/);
    process.env.DATABASE_URL = "postgresql://fixture:fixture@hosted.example.invalid:5432/fp_studio_qa_controlled";
    assert.throws(sessionCookieName, /own local database/);
  });
  it("never enables the QA cookie or its local origin in production", () => {
    Object.assign(process.env, { NODE_ENV: "production" });
    assert.equal(sessionCookieName(), "fieldproof_session");
    assert.throws(() => assertSameOrigin(new Request("http://localhost:4202/api/studio/report", { headers: { origin: "http://localhost:4202", host: "localhost:4202" } })), /Refresh this page/);
    Object.assign(process.env, { NODE_ENV: "development" });
    assert.doesNotThrow(() => assertSameOrigin(new Request("http://localhost:4202/api/studio/report", { headers: { origin: "http://localhost:4202", host: "localhost:4202" } })));
    assert.throws(() => assertSameOrigin(new Request("http://localhost:4202/api/studio/report", { headers: { origin: "http://localhost:4202", host: "localhost:4102" } })), /Refresh this page/);
  });
});
