import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { recognitionFixture, recognitionDonor, recognitionConsentInput } from "./helpers/recognition-fixtures";
import { executeRecognitionCommand } from "../lib/server/recognition-commands";
import { RECOGNITION_VERSION } from "../lib/recognition/contracts";
import { recognitionNamespaceDigest } from "./helpers/recognition-inventory";

const execute = promisify(execFile);
describe("recognition durable fresh-process recovery", () => {
  it("recovers the same receipt in two fresh processes and never resurrects a withdrawn name", async () => {
    const schema = process.env.FIELDPROOF_RECOGNITION_TEST_SCHEMA!; assert(/^recognition_test_[a-f0-9]{32}$/.test(schema));
    const f = await recognitionFixture(), person = await recognitionDonor(f), input = await recognitionConsentInput(person.request, f.slug), receipt = await executeRecognitionCommand(person.request, input);
    const id = randomUUID(), filename = `${process.cwd()}/.local/recognition-unit/reopen-${id}.json`;
    await writeFile(filename, JSON.stringify({ parentPid: process.pid, schema, token: person.sessionToken, slug: f.slug, intentId: input.intentId, accessId: input.accessId }), { flag: "wx", mode: 0o600 });
    async function reopen() {
      const result = await execute("/Users/yadneshsalvi/.local/bin/node", ["--import", "tsx", "tests/helpers/recognition-reopen.ts", id], {
        cwd: "/Users/yadneshsalvi/code/hackathons/paypal-ai-hackathon/fieldproof/.local/recognition-stage14", timeout: 10_000, maxBuffer: 8_192, encoding: "utf8", env: { NODE_ENV: "test", PATH: "/Users/yadneshsalvi/.local/bin:/usr/bin:/bin" } });
      return JSON.parse(result.stdout) as { intentId: string; commandId: string; ownState: string; ownHasLabel: boolean; publicLabels: number; originalSessionExpiresAt: string };
    }
    try {
      const beforeFirst = await recognitionNamespaceDigest();
      const first = await reopen(); assert.equal(first.commandId, receipt.commandId); assert.equal(first.ownState, "listed"); assert.equal(first.publicLabels, 1);
      assert.deepEqual(await recognitionNamespaceDigest(), beforeFirst, "First fresh-process GETs preserve every logical row/catalog entry.");
      await executeRecognitionCommand(person.request, { schema: RECOGNITION_VERSION, action: "withdraw", intentId: randomUUID(), accessId: input.accessId,
        sessionExpiresAt: input.sessionExpiresAt, expectedVersion: 1, slug: f.slug, confirmed: true });
      const beforeSecond = await recognitionNamespaceDigest();
      const second = await reopen(); assert.equal(second.commandId, receipt.commandId); assert.equal(second.intentId, input.intentId); assert.equal(second.ownState, "withdrawn");
      assert.deepEqual(await recognitionNamespaceDigest(), beforeSecond, "Second fresh-process GETs preserve every logical row/catalog entry.");
      assert.equal(second.ownHasLabel, false); assert.equal(second.publicLabels, 0); assert.equal(second.originalSessionExpiresAt, first.originalSessionExpiresAt);
    } finally { await unlink(filename); }
  });
});
