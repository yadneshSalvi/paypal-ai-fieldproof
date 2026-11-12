import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { recognitionFixture, recognitionDonor, recognitionConsentInput, recognitionFingerprint } from "./helpers/recognition-fixtures";
import { recognitionGet, recognitionPost, publicRecognitionGet } from "../lib/server/recognition-http";
import { sessionCookieName } from "../lib/server/auth";
import { executeRecognitionCommand } from "../lib/server/recognition-commands";
import { RECOGNITION_VERSION } from "../lib/recognition/contracts";

const origin = "http://localhost:4612";
function privateRequest(token: string, path = "/api/recognition", input?: unknown, access?: string) {
  return new Request(`${origin}${path}`, { method: input === undefined ? "GET" : "POST", headers: { Cookie: `${sessionCookieName()}=${token}`, Origin: origin, Host: "localhost:4612",
    ...(input === undefined ? {} : { "Content-Type": "application/json" }), ...(access ? { "X-Recognition-Access": access } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
}
describe("recognition actual handler + PostgreSQL boundary", () => {
  it("current preview is a separate no-row-change read and command recovery never returns old names", async () => {
    const f = await recognitionFixture(), person = await recognitionDonor(f), input = await recognitionConsentInput(person.request, f.slug), before = await recognitionFingerprint(f.session.projectId);
    const preview = await recognitionPost(privateRequest(person.sessionToken, "/api/recognition/review", input), ["review"]);
    assert.equal(preview.status, 200); assert.equal((await preview.json()).data.label, input.label); assert.deepEqual(await recognitionFingerprint(f.session.projectId), before);
    const accepted = await recognitionPost(privateRequest(person.sessionToken, "/api/recognition/commands", input), ["commands"]); assert.equal(accepted.status, 200);
    const receipt = (await accepted.json()).data;
    const missing = await recognitionGet(privateRequest(person.sessionToken, "/api/recognition/commands/missing", undefined, input.accessId), ["commands", randomUUID()]);
    assert.equal(missing.status, 404); assert.equal((await missing.json()).error.code, "RECOGNITION_COMMAND_NOT_FOUND");
    const original = await recognitionGet(privateRequest(person.sessionToken, `/api/recognition/commands/${input.intentId}`, undefined, input.accessId), ["commands", input.intentId]);
    assert.deepEqual((await original.json()).data, receipt);
    const withdrawn = await recognitionPost(privateRequest(person.sessionToken, "/api/recognition/commands", { schema: RECOGNITION_VERSION, action: "withdraw", intentId: randomUUID(),
      accessId: input.accessId, sessionExpiresAt: input.sessionExpiresAt, expectedVersion: 1, slug: f.slug, confirmed: true }), ["commands"]); assert.equal(withdrawn.status, 200);
    const bytes = await (await recognitionGet(privateRequest(person.sessionToken, "/api/recognition/commands/old", undefined, input.accessId), ["commands", input.intentId])).text();
    assert.equal(bytes.includes(input.label), false);
  });
  it("public reads need no cookie and set no-store/no-referrer/nosniff, without any private identities", async () => {
    const f = await recognitionFixture(), person = await recognitionDonor(f), input = await recognitionConsentInput(person.request, f.slug);
    await executeRecognitionCommand(person.request, input);
    const before = await recognitionFingerprint(f.session.projectId), response = await publicRecognitionGet(new Request(`${origin}/api/public-recognition/${f.slug}`), f.slug);
    assert.equal(response.status, 200);
    for (const [key, value] of [["cache-control", "private, no-store, max-age=0"], ["referrer-policy", "no-referrer"], ["x-content-type-options", "nosniff"]]) assert.equal(response.headers.get(key), value);
    assert.equal(response.headers.has("set-cookie"), false);
    const body = await response.text(); assert(body.includes(input.label));
    for (const canary of [person.sessionToken, person.session.id, person.session.actorId, f.session.projectId, "PRIVATE PROFILE CANARY", "paymentCount"]) assert.equal(body.includes(canary), false);
    assert.deepEqual(await recognitionFingerprint(f.session.projectId), before);
  });
  it("denies cross-origin, Origin:null, non-JSON, oversized and invented authority fields before effects", async () => {
    const f = await recognitionFixture(), person = await recognitionDonor(f), input = await recognitionConsentInput(person.request, f.slug), before = await recognitionFingerprint(f.session.projectId);
    for (const value of ["https://foreign.invalid", "null"]) {
      const request = privateRequest(person.sessionToken, "/api/recognition/commands", input); request.headers.set("Origin", value);
      assert.equal((await recognitionPost(request, ["commands"])).status, 403);
    }
    const nonJson = privateRequest(person.sessionToken, "/api/recognition/commands", input); nonJson.headers.set("Content-Type", "text/plain");
    assert.equal((await recognitionPost(nonJson, ["commands"])).status, 415);
    assert.equal((await recognitionPost(privateRequest(person.sessionToken, "/api/recognition/commands", { ...input, actorId: f.session.actorId }), ["commands"])).status, 400);
    const oversized = privateRequest(person.sessionToken, "/api/recognition/commands", { label: "a".repeat(6001) });
    assert.equal((await recognitionPost(oversized, ["commands"])).status, 413);
    const malformed = new Request(`${origin}/api/recognition/commands`, { method: "POST", headers: { Origin: origin, Host: "localhost:4612", "Content-Type": "application/json" }, body: "{" });
    assert.equal((await recognitionPost(malformed, ["commands"])).status, 400);
    assert.deepEqual(await recognitionFingerprint(f.session.projectId), before);
  });
  it("does not expose a project-id discovery endpoint, unknown query fields, foreign cursors or ambiguous cookies", async () => {
    const f = await recognitionFixture(), person = await recognitionDonor(f);
    for (const query of [`?projectId=${f.session.projectId}`, "?cursor=a&cursor=b", "?accessId=aaa"]) {
      const response = await publicRecognitionGet(new Request(`${origin}/api/public-recognition/${f.slug}${query}`), f.slug); assert.equal(response.status, 400);
    }
    assert.equal((await publicRecognitionGet(new Request(`${origin}/api/public-recognition/${f.session.projectId}`), f.session.projectId)).status, 400);
    const response = await publicRecognitionGet(new Request(`${origin}/api/public-recognition/${f.slug}?cursor=foreign`), f.slug); assert.equal(response.status, 409);
    const ambiguous = privateRequest(person.sessionToken); ambiguous.headers.set("Cookie", `${sessionCookieName()}=${person.sessionToken}; ${sessionCookieName()}=other`);
    assert.equal((await recognitionGet(ambiguous)).status, 400);
  });
});
