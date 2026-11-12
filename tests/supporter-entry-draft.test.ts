import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SUPPORTER_ACCESS_VERSION } from "../lib/supporters/contracts";
import { entryDraftForLocation, readEntryDraft, type SupporterEntryDraft } from "../lib/supporters/entry-draft";

const inviteToken = "a".repeat(64), returnToken = "b".repeat(64), nextToken = "c".repeat(64);
const originalIntent = "00000000-0000-4000-8000-000000000001", nextIntent = "00000000-0000-4000-8000-000000000002";
const originalScope = "d".repeat(64);

function acceptedDraft(): SupporterEntryDraft {
  return {
    version: 1, kind: "invite", token: inviteToken, intentId: originalIntent,
    acceptance: { token: inviteToken, intentId: originalIntent, expectedScope: originalScope, displayName: "Synthetic original supporter",
      contractVersion: SUPPORTER_ACCESS_VERSION, acknowledged: true },
  };
}
function restoringDraft(): SupporterEntryDraft {
  return {
    version: 1, kind: "access", token: returnToken, intentId: originalIntent,
    restoration: { token: returnToken, intentId: originalIntent, expectedScope: originalScope, acknowledged: true },
  };
}
const reload = (draft: SupporterEntryDraft) => readEntryDraft(JSON.stringify(draft));
function forbiddenIntent(): never { assert.fail("A retry must not mint a new identity or command intent."); }

describe("private supporter entry draft recovery", () => {
  it("retains the exact original name, acknowledgement, scope and intent after a lost acceptance response", () => {
    const original = acceptedDraft(), stored = JSON.stringify(original), saved = readEntryDraft(stored);
    assert.ok(saved);
    const normalized = JSON.stringify(saved);
    for (const fragment of ["", "#", `#invite=${inviteToken}`]) {
      const retry = entryDraftForLocation(fragment, saved, forbiddenIntent);
      assert.deepEqual(retry, original);
      assert.equal(JSON.stringify(retry), normalized);
      assert.equal(retry?.acceptance?.expectedScope, originalScope);
    }
    assert.equal(JSON.stringify(saved), normalized);
  });

  it("retains one restoration command after the server may already have written the original session cookie", () => {
    const original = restoringDraft(), saved = reload(original);
    assert.ok(saved);
    // The next review can describe the now-entered recipient session. Its new
    // context must not replace the original command's empty-cookie scope.
    const retry = entryDraftForLocation(`#access=${returnToken}`, saved, forbiddenIntent);
    assert.deepEqual(retry?.restoration, original.restoration);
    assert.equal(retry?.intentId, originalIntent);
    assert.equal(retry?.restoration?.expectedScope, originalScope);
    assert.deepEqual(readEntryDraft(JSON.stringify(retry)), original);
  });

  it("keeps a valid same-link retry separate from a different private invitation or return capability", () => {
    for (const original of [acceptedDraft(), restoringDraft()]) {
      for (const kind of ["invite", "access"] as const) {
        let created = 0;
        const before = JSON.stringify(original);
        const next = entryDraftForLocation(`#${kind}=${nextToken}`, original, () => { created++; return nextIntent; });
        assert.deepEqual(next, { version: 1, kind, token: nextToken, intentId: nextIntent });
        assert.equal(created, 1);
        assert.equal(next?.acceptance, undefined);
        assert.equal(next?.restoration, undefined);
        assert.equal(JSON.stringify(original), before);
      }
    }
  });

  it("resets the request when the capability kind changes even if the token text happens to match", () => {
    const invite = acceptedDraft(), next = entryDraftForLocation(`#access=${inviteToken}`, invite, () => nextIntent);
    assert.deepEqual(next, { version: 1, kind: "access", token: inviteToken, intentId: nextIntent });
    const access = restoringDraft(), other = entryDraftForLocation(`#invite=${returnToken}`, access, () => nextIntent);
    assert.deepEqual(other, { version: 1, kind: "invite", token: returnToken, intentId: nextIntent });
  });

  it("refuses malformed, duplicate and mixed fragments without falling back to an earlier identity", () => {
    const saved = acceptedDraft(), before = JSON.stringify(saved);
    const invalid = [
      "#invite=", "#access=short", `#unknown=${inviteToken}`, `#invite=${inviteToken.slice(1)}`,
      `#invite=${inviteToken}&invite=${inviteToken}`, `#invite=${inviteToken}&invite=${nextToken}`,
      `#invite=${inviteToken}&access=${returnToken}`, `#access=${returnToken}&invite=${inviteToken}`,
      `#invite=${inviteToken}&role=organizer`, `#access=${returnToken}&intentId=${originalIntent}`,
      `#invite=${inviteToken}%00`, `#invite=${inviteToken}%ZZ`, `#access=${returnToken}%0A`,
      `#invite=${inviteToken.slice(1)}+`, `#/join?invite=${inviteToken}`,
    ];
    for (const fragment of invalid) {
      assert.equal(entryDraftForLocation(fragment, saved, forbiddenIntent), null, fragment);
      assert.equal(JSON.stringify(saved), before);
    }
  });

  it("rejects a stored request whose token, kind or command intent differs from its outer draft", () => {
    const accepted = acceptedDraft(), restoring = restoringDraft();
    const invalid = [
      { ...accepted, token: nextToken },
      { ...accepted, intentId: nextIntent },
      { ...accepted, kind: "access" },
      { ...accepted, acceptance: { ...accepted.acceptance!, token: nextToken } },
      { ...accepted, acceptance: { ...accepted.acceptance!, intentId: nextIntent } },
      { ...restoring, token: nextToken },
      { ...restoring, intentId: nextIntent },
      { ...restoring, kind: "invite" },
      { ...restoring, restoration: { ...restoring.restoration!, token: nextToken } },
      { ...restoring, restoration: { ...restoring.restoration!, intentId: nextIntent } },
      { ...accepted, restoration: restoring.restoration },
      { ...restoring, acceptance: accepted.acceptance },
    ];
    for (const value of invalid) assert.equal(readEntryDraft(JSON.stringify(value)), null);
  });

  it("does not recover malformed storage, widened roles or unsupported acceptance contracts", () => {
    const accepted = acceptedDraft();
    const invalid = [
      { ...accepted, role: "organizer" },
      { ...accepted, version: 2 },
      { ...accepted, acceptance: { ...accepted.acceptance!, role: "organizer" } },
      { ...accepted, acceptance: { ...accepted.acceptance!, acknowledged: false } },
      { ...accepted, acceptance: { ...accepted.acceptance!, contractVersion: "unreviewed-contract" } },
      { ...accepted, acceptance: { ...accepted.acceptance!, expectedScope: "invalid-scope" } },
      { ...accepted, acceptance: { ...accepted.acceptance!, displayName: "Name\u0000with a control" } },
      { ...restoringDraft(), restoration: { ...restoringDraft().restoration!, acknowledged: false } },
    ];
    for (const value of invalid) assert.equal(readEntryDraft(JSON.stringify(value)), null);
    for (const value of [null, "", "{broken", "null", "[]", "42", '"a string"', JSON.stringify({ kind: "invite", token: inviteToken })])
      assert.equal(readEntryDraft(value), null);
  });

  it("creates no draft or intent when a clean browser has no private fragment", () => {
    assert.equal(entryDraftForLocation("", null, forbiddenIntent), null);
    assert.equal(entryDraftForLocation("#", null, forbiddenIntent), null);
    assert.equal(entryDraftForLocation("#invite=missing", null, forbiddenIntent), null);
  });
});
