import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { RECOGNITION_VERSION, publicLabelSchema, recognitionCommandSchema, recognitionPublicPageSchema, recognitionReceiptSchema } from "../lib/recognition/contracts";

describe("explicit recognition privacy contracts", () => {
  for (const label of ["Asha R.", "Álvaro", "李 明", "M. O’Reilly", "Jo & Sam"]) it(`accepts an explicit plain-text label: ${label}`, () => assert.equal(publicLabelSchema.parse(label), label));
  for (const label of ["", " Private ", "first\nsecond", "<script>alert(1)</script>", "a@example.invalid", "https://private.invalid", "555-123-4567", "A\u202eB", "A".repeat(41)])
    it(`rejects unsafe/contact/noncanonical label ${JSON.stringify(label)}`, () => assert.equal(publicLabelSchema.safeParse(label).success, false));
  it("requires explicit public and self-declared acknowledgments and rejects invented actor authority", () => {
    const command = { schema: RECOGNITION_VERSION, action: "consent", intentId: randomUUID(), accessId: "a".repeat(64), sessionExpiresAt: "2026-11-12T22:00:00.123456Z", expectedVersion: 0,
      slug: "a".repeat(24), reviewKey: "b".repeat(64), label: "Asha", publicVisibilityAcknowledged: true, selfDeclaredAcknowledged: true };
    assert.equal(recognitionCommandSchema.safeParse(command).success, true);
    for (const extra of [{ actorId: randomUUID() }, { publicVisibilityAcknowledged: false }, { selfDeclaredAcknowledged: false }, { sessionExpiresAt: "2026-11-12T22:00:00.123Z" }])
      assert.equal(recognitionCommandSchema.safeParse({ ...command, ...extra }).success, false);
  });
  it("keeps immutable receipt and public DTOs closed to private history and receipt claims", () => {
    const receipt = { schema: RECOGNITION_VERSION, intentId: randomUUID(), commandId: randomUUID(), action: "consent", outcome: "committed", version: 1, committedAt: "2026-11-12T22:00:00.123456Z" };
    assert.equal(recognitionReceiptSchema.safeParse(receipt).success, true);
    assert.equal(recognitionReceiptSchema.safeParse({ ...receipt, label: "Old name" }).success, false);
    const page = { schema: RECOGNITION_VERSION, slug: "a".repeat(24), state: "available", entries: [{ label: "Asha", provenance: "sample_self_declared" }], proofHref: `/proof/${"a".repeat(24)}`,
      nextCursor: null, observedAt: "2026-11-12T22:00:00.123456Z", validUntil: "2026-11-12T22:00:05.123000Z" };
    assert.equal(recognitionPublicPageSchema.safeParse(page).success, true);
    for (const extra of [{ hiddenCount: 1 }, { actorId: randomUUID() }, { receipts: [] }]) assert.equal(recognitionPublicPageSchema.safeParse({ ...page, ...extra }).success, false);
  });
});
