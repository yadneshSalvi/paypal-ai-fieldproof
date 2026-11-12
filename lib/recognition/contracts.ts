import { z } from "zod";

export const RECOGNITION_VERSION = "fieldproof.recognition.v1" as const;
export const RECOGNITION_PAGE_SIZE = 24;
export const RECOGNITION_REFRESH_MS = 5_000;
export const recognitionHash = z.string().regex(/^[a-f0-9]{64}$/);
export const recognitionSlug = z.string().regex(/^[A-Za-z0-9_-]{24}$/);
/** PostgreSQL's original precision is retained; browser timers may expire early. */
export const recognitionDeadline = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/).refine(value => Number.isFinite(Date.parse(value)));

export function validPublicLabel(value: string): boolean {
  return value === value.trim().normalize("NFC") && Array.from(value).length >= 1 && Array.from(value).length <= 40
    && /[\p{L}\p{N}]/u.test(value) && !/[\p{Cc}\p{Cf}\p{Cs}<>@\r\n]/u.test(value)
    && !/(?:https?:|www\.|\b[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\b|\d[\d\s()+.-]{5,}\d)/iu.test(value);
}
export const publicLabelSchema = z.string().max(80).refine(validPublicLabel, "Use up to 40 plain-text characters, without a contact address, link or phone number.");
const envelope = { schema: z.literal(RECOGNITION_VERSION), intentId: z.uuid(), accessId: recognitionHash,
  sessionExpiresAt: recognitionDeadline, expectedVersion: z.number().int().nonnegative().max(1_000_000) };
export const recognitionCommandSchema = z.discriminatedUnion("action", [
  z.object({ ...envelope, action: z.literal("consent"), slug: recognitionSlug, reviewKey: recognitionHash,
    label: publicLabelSchema, publicVisibilityAcknowledged: z.literal(true), selfDeclaredAcknowledged: z.literal(true) }).strict(),
  z.object({ ...envelope, action: z.literal("withdraw"), slug: recognitionSlug, confirmed: z.literal(true) }).strict(),
  z.object({ ...envelope, action: z.literal("suppress"), handle: z.string().min(40).max(2_000),
    reason: z.enum(["privacy_request", "inappropriate_label", "project_moderation"]), confirmed: z.literal(true) }).strict(),
]);
export type RecognitionCommand = z.infer<typeof recognitionCommandSchema>;
export const recognitionReceiptSchema = z.object({ schema: z.literal(RECOGNITION_VERSION), intentId: z.uuid(), commandId: z.uuid(),
  action: z.enum(["consent", "withdraw", "suppress"]), outcome: z.literal("committed"), version: z.number().int().positive(), committedAt: recognitionDeadline }).strict();
export type RecognitionReceipt = z.infer<typeof recognitionReceiptSchema>;
export const recognitionAccessSchema = z.object({ accessId: recognitionHash, role: z.enum(["donor", "volunteer", "organizer"]),
  sessionExpiresAt: recognitionDeadline, validUntil: recognitionDeadline }).strict();
export type RecognitionAccess = z.infer<typeof recognitionAccessSchema>;
export const recognitionTargetSchema = z.object({ slug: recognitionSlug, title: z.string().max(240), revision: z.number().int().positive(),
  contentHash: recognitionHash, reviewKey: recognitionHash, proofHref: z.string().regex(/^\/proof\/[A-Za-z0-9_-]{24}$/),
  wallHref: z.string().regex(/^\/recognition\/[A-Za-z0-9_-]{24}$/) }).strict();
export type RecognitionTarget = z.infer<typeof recognitionTargetSchema>;
export const recognitionOwnSchema = z.object({ version: z.number().int().nonnegative(),
  state: z.enum(["private", "listed", "withdrawn", "suppressed", "withheld"]), label: publicLabelSchema.nullable(),
  expiresAt: recognitionDeadline.nullable() }).strict().refine(value => value.state === "listed" ? value.label !== null && value.expiresAt !== null : value.label === null,
    "Only a currently listed choice can contain a public label.");
export type RecognitionOwn = z.infer<typeof recognitionOwnSchema>;
export const recognitionDeskSchema = z.object({ schema: z.literal(RECOGNITION_VERSION), access: recognitionAccessSchema,
  kind: z.enum(["participant", "organizer"]), targets: z.array(recognitionTargetSchema).max(50),
  selectedSlug: recognitionSlug.nullable(), own: recognitionOwnSchema.nullable(), observedAt: recognitionDeadline }).strict()
  .refine(value => value.kind === "organizer" ? value.access.role === "organizer" && value.own === null : value.access.role !== "organizer")
  .refine(value => value.selectedSlug !== null || value.own === null);
export type RecognitionDesk = z.infer<typeof recognitionDeskSchema>;
export const recognitionPublicEntrySchema = z.object({ label: publicLabelSchema,
  provenance: z.enum(["sample_self_declared", "self_declared"]) }).strict();
export type RecognitionPublicEntry = z.infer<typeof recognitionPublicEntrySchema>;
export const recognitionPublicPageSchema = z.object({ schema: z.literal(RECOGNITION_VERSION), slug: recognitionSlug,
  state: z.enum(["available", "unavailable"]), entries: z.array(recognitionPublicEntrySchema).max(RECOGNITION_PAGE_SIZE),
  proofHref: z.string().regex(/^\/proof\/[A-Za-z0-9_-]{24}$/), nextCursor: z.string().max(3_000).nullable(),
  observedAt: recognitionDeadline, validUntil: recognitionDeadline }).strict()
  .refine(value => value.state === "available" || value.entries.length === 0 && value.nextCursor === null, "Unavailable public proof cannot carry labels.")
  .refine(value => value.validUntil > value.observedAt && Date.parse(value.validUntil) - Date.parse(value.observedAt) <= RECOGNITION_REFRESH_MS);
export type RecognitionPublicPage = z.infer<typeof recognitionPublicPageSchema>;
export const recognitionModerationPageSchema = z.object({ schema: z.literal(RECOGNITION_VERSION), access: recognitionAccessSchema,
  slug: recognitionSlug, entries: z.array(recognitionPublicEntrySchema.extend({ handle: z.string().min(40).max(2_000),
    version: z.number().int().positive() }).strict()).max(RECOGNITION_PAGE_SIZE), nextCursor: z.string().max(3_000).nullable(),
  observedAt: recognitionDeadline, validUntil: recognitionDeadline }).strict();
export type RecognitionModerationPage = z.infer<typeof recognitionModerationPageSchema>;
export const recognitionReviewSchema = z.object({ schema: z.literal(RECOGNITION_VERSION), intentId: z.uuid(), action: z.enum(["consent", "withdraw", "suppress"]),
  label: publicLabelSchema.nullable(), slug: recognitionSlug, wallHref: z.string().regex(/^\/recognition\/[A-Za-z0-9_-]{24}$/),
  proofHref: z.string().regex(/^\/proof\/[A-Za-z0-9_-]{24}$/), expectedVersion: z.number().int().nonnegative(),
  reviewedAt: recognitionDeadline, validUntil: recognitionDeadline }).strict().refine(value => value.action === "withdraw" ? value.label === null : value.label !== null);
export type RecognitionReview = z.infer<typeof recognitionReviewSchema>;
export interface RecognitionError { code: string; message: string; recoverable: boolean; }
export type RecognitionEnvelope<T> = { data: T } | { error: RecognitionError };

/** The journal is a request, never authority. Only current server access can use it. */
export const recognitionJournalSchema = z.object({ accessId: recognitionHash, input: recognitionCommandSchema,
  state: z.enum(["unresolved", "not_received"]) }).strict().refine(value => value.accessId === value.input.accessId);
export type RecognitionJournal = z.infer<typeof recognitionJournalSchema>;
