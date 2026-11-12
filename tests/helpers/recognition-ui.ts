import { RECOGNITION_VERSION, recognitionDeskSchema, recognitionPublicPageSchema, type RecognitionCommand, type RecognitionDesk, type RecognitionPublicPage, type RecognitionReceipt, type RecognitionReview } from "../../lib/recognition/contracts";

/** Controlled component-response data only: no DB, human, payment or capability. */
export const REC_UI_SLUG = "controlledWall0000000001", REC_UI_ACCESS = "a".repeat(64), REC_UI_REVIEW = "b".repeat(64);
export const recUiTime = (offset = 0) => `${new Date(Date.now() + offset).toISOString().slice(0, -1)}000Z`;
export function recUiDesk(overrides: Partial<RecognitionDesk> = {}): RecognitionDesk {
  return recognitionDeskSchema.parse({ schema: RECOGNITION_VERSION, kind: "participant", access: { accessId: REC_UI_ACCESS, role: "donor", sessionExpiresAt: recUiTime(3_600_000), validUntil: recUiTime(3_600_000) },
    selectedSlug: REC_UI_SLUG, targets: [{ slug: REC_UI_SLUG, title: "Controlled Sample community project", revision: 1, contentHash: "c".repeat(64), reviewKey: REC_UI_REVIEW,
      wallHref: `/recognition/${REC_UI_SLUG}`, proofHref: `/proof/${REC_UI_SLUG}` }], own: { state: "private", version: 0, label: null, expiresAt: null }, observedAt: recUiTime(), ...overrides });
}
export function recUiPage(overrides: Partial<RecognitionPublicPage> = {}): RecognitionPublicPage {
  return recognitionPublicPageSchema.parse({ schema: RECOGNITION_VERSION, slug: REC_UI_SLUG, state: "available", entries: [{ label: "Controlled public initials", provenance: "sample_self_declared" }],
    proofHref: `/proof/${REC_UI_SLUG}`, nextCursor: null, observedAt: recUiTime(), validUntil: recUiTime(5_000), ...overrides });
}
export function recUiReview(input: RecognitionCommand): RecognitionReview {
  const slug = "slug" in input ? input.slug : REC_UI_SLUG;
  return { schema: RECOGNITION_VERSION, intentId: input.intentId, action: input.action, label: input.action === "consent" ? input.label : input.action === "suppress" ? "Controlled public initials" : null,
    slug, proofHref: `/proof/${slug}`, wallHref: `/recognition/${slug}`, expectedVersion: input.expectedVersion, reviewedAt: recUiTime(), validUntil: recUiTime(30_000) };
}
export function recUiReceipt(input: RecognitionCommand): RecognitionReceipt { return { schema: RECOGNITION_VERSION, intentId: input.intentId, commandId: "00000000-0000-4000-8000-000000000001", action: input.action, outcome: "committed", version: input.expectedVersion + 1, committedAt: recUiTime() }; }
