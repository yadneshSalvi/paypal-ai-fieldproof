import { z } from "zod";
import * as A from "./access-contracts";
import type { ProcurementStorage } from "./client-boundary";

export const VOLUNTEER_ENTRY_DRAFT_KEY = "fieldproof.procurement.entry.v1";
export const VOLUNTEER_ENTRY_RETAINED_KEY = "fieldproof.procurement.entry.retained.v1";
const fragmentSchema = z.object({ kind: z.enum(["invite", "access"]), token: z.string().regex(/^[A-Za-z0-9_-]{64}$/) }).strict();
export type VolunteerFragment = z.infer<typeof fragmentSchema>;
export function parseVolunteerFragment(fragment: string): { state: "empty" | "invalid"; value: null } | { state: "valid"; value: VolunteerFragment } {
  if (!fragment || fragment === "#") return { state: "empty", value: null };
  if (!fragment.startsWith("#")) return { state: "invalid", value: null };
  const values = [...new URLSearchParams(fragment.slice(1)).entries()];
  if (values.length !== 1 || !["invite", "access"].includes(values[0][0])) return { state: "invalid", value: null };
  const value = fragmentSchema.safeParse({ kind: values[0][0], token: values[0][1] }); return value.success ? { state: "valid", value: value.data } : { state: "invalid", value: null };
}
const draftSchema = z.object({ version: z.literal(1), fragment: fragmentSchema, intentId: z.uuid(), displayName: z.string().max(80), savedAt: z.iso.datetime(), acceptance: A.volunteerAcceptSchema.nullable(), restore: A.volunteerRestoreSchema.nullable() }).strict().superRefine((value, ctx) => {
  const request = value.acceptance ?? value.restore;
  if (value.acceptance && value.restore || request && (request.intentId !== value.intentId || request.token !== value.fragment.token) || value.acceptance && (value.fragment.kind !== "invite" || value.acceptance.displayName !== value.displayName) || value.restore && value.fragment.kind !== "access") ctx.addIssue({ code: "custom", message: "The saved request must match this exact original fragment, intent and identity." });
});
export type VolunteerEntryDraft = z.infer<typeof draftSchema>;
const retainedSchema = z.object({ version: z.literal(1), drafts: z.array(draftSchema).max(12) }).strict();
export function loadVolunteerEntryDraft(storage: ProcurementStorage, fragment: VolunteerFragment, newIntent: () => string, now = new Date().toISOString()): VolunteerEntryDraft {
  const current = fragmentSchema.parse(fragment); let previous: VolunteerEntryDraft | null = null;
  const raw = storage.getItem(VOLUNTEER_ENTRY_DRAFT_KEY);
  if (raw !== null) {
    try { previous = draftSchema.parse(JSON.parse(raw)); }
    catch { throw new Error("This tab's original entry request cannot be verified. Clear its local references explicitly before starting another intent."); }
  }
  if (previous?.fragment.kind === current.kind && previous.fragment.token === current.token) return previous;
  let retained: VolunteerEntryDraft[] = [];
  try { const raw = storage.getItem(VOLUNTEER_ENTRY_RETAINED_KEY); if (raw) retained = retainedSchema.parse(JSON.parse(raw)).drafts; } catch { throw new Error("The tab's earlier entry requests cannot be verified. Clear their local references explicitly before starting another attempt."); }
  const earlier = retained.find(value => value.fragment.kind === current.kind && value.fragment.token === current.token);
  if (previous && !retained.some(value => value.fragment.kind === previous!.fragment.kind && value.fragment.token === previous!.fragment.token)) { if (retained.length >= 12) throw new Error("This tab has several retained private entry attempts. Resume an original link or explicitly clear local references; no unknown request will be replaced automatically."); retained.push(previous); }
  storage.setItem(VOLUNTEER_ENTRY_RETAINED_KEY, JSON.stringify({ version: 1, drafts: retained }));
  const value = earlier ?? draftSchema.parse({ version: 1, fragment: current, intentId: newIntent(), displayName: "", savedAt: now, acceptance: null, restore: null }); storage.setItem(VOLUNTEER_ENTRY_DRAFT_KEY, JSON.stringify(value)); return value;
}
export function saveVolunteerIdentity(storage: ProcurementStorage, draft: VolunteerEntryDraft, displayName: string): VolunteerEntryDraft {
  if (draft.acceptance || draft.restore) throw new Error("Keep the original submitted identity and intent while its result is unknown.");
  const value = draftSchema.parse({ ...draft, displayName }); storage.setItem(VOLUNTEER_ENTRY_DRAFT_KEY, JSON.stringify(value)); return value;
}
export function prepareVolunteerAcceptance(storage: ProcurementStorage, draft: VolunteerEntryDraft, expectedScope: string): VolunteerEntryDraft {
  if (draft.acceptance) return draftSchema.parse(draft);
  if (draft.fragment.kind !== "invite" || draft.restore) throw new Error("This is not an invitation acceptance draft.");
  const acceptance = A.volunteerAcceptSchema.parse({ intentId: draft.intentId, expectedScope, token: draft.fragment.token, displayName: draft.displayName, role: "volunteer", contractVersion: A.VOLUNTEER_ENTRY_VERSION, acknowledged: true });
  const value = draftSchema.parse({ ...draft, displayName: acceptance.displayName, acceptance }); storage.setItem(VOLUNTEER_ENTRY_DRAFT_KEY, JSON.stringify(value)); return value;
}
export function prepareVolunteerRestore(storage: ProcurementStorage, draft: VolunteerEntryDraft, expectedScope: string): VolunteerEntryDraft {
  if (draft.restore) return draftSchema.parse(draft);
  if (draft.fragment.kind !== "access" || draft.acceptance) throw new Error("This is not an original-profile return draft.");
  const restore = A.volunteerRestoreSchema.parse({ intentId: draft.intentId, expectedScope, token: draft.fragment.token, acknowledged: true });
  const value = draftSchema.parse({ ...draft, restore }); storage.setItem(VOLUNTEER_ENTRY_DRAFT_KEY, JSON.stringify(value)); return value;
}
export function clearVolunteerEntryDrafts(storage: ProcurementStorage) { storage.removeItem(VOLUNTEER_ENTRY_DRAFT_KEY); storage.removeItem(VOLUNTEER_ENTRY_RETAINED_KEY); }
