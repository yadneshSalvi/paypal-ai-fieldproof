import { z } from "zod";
import { supporterAcceptSchema, supporterEntrySchema, supporterRestoreSchema } from "./contracts";

export const SUPPORTER_ENTRY_STORAGE = "fieldproof-supporter-entry-v1";
const draftSchema = supporterEntrySchema.extend({
  version: z.literal(1), intentId: z.uuid(), acceptance: supporterAcceptSchema.optional(), restoration: supporterRestoreSchema.optional(),
}).strict().superRefine((draft, context) => {
  if (draft.acceptance && (draft.kind !== "invite" || draft.acceptance.token !== draft.token || draft.acceptance.intentId !== draft.intentId)) context.addIssue({ code: "custom", message: "The saved invitation request does not match this link." });
  if (draft.restoration && (draft.kind !== "access" || draft.restoration.token !== draft.token || draft.restoration.intentId !== draft.intentId)) context.addIssue({ code: "custom", message: "The saved access request does not match this link." });
});
export type SupporterEntryDraft = z.infer<typeof draftSchema>;
export function readEntryDraft(value: string | null): SupporterEntryDraft | null {
  try { const parsed = draftSchema.safeParse(value ? JSON.parse(value) : null); return parsed.success ? parsed.data : null; } catch { return null; }
}
/** Fragments never enter a request URL. A different or malformed link never reuses an earlier identity. */
export function entryDraftForLocation(fragment: string, saved: SupporterEntryDraft | null, intentId: () => string): SupporterEntryDraft | null {
  if (!fragment || fragment === "#") return saved;
  const entries = Array.from(new URLSearchParams(fragment.replace(/^#/, "")).entries());
  if (entries.length !== 1) return null;
  const [kind, token] = entries[0], parsed = supporterEntrySchema.safeParse({ kind: kind === "invite" ? "invite" : kind === "access" ? "access" : "invalid", token });
  if (!parsed.success) return null;
  if (saved?.kind === parsed.data.kind && saved.token === parsed.data.token) return saved;
  return { version: 1, ...parsed.data, intentId: intentId() };
}
