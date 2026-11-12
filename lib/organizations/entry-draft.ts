import { z } from "zod";
import { orgEntryAcceptSchema, orgEntryRestoreSchema } from "./contracts";
import * as C from "./contracts";

export const ORG_ENTRY_STORAGE = "fieldproof-organization-entry-v1";
export const ORG_ATTEMPT_STORAGE = "fieldproof-organization-attempt-v1";
const entry = z.object({ kind: z.enum(["invite", "access"]), token: z.string().regex(/^[A-Za-z0-9_-]{64}$/) }).strict();
const draftSchema = entry.extend({
  version: z.literal(1), intentId: z.uuid(), acceptance: orgEntryAcceptSchema.optional(), restoration: orgEntryRestoreSchema.optional(),
}).strict().superRefine((draft, ctx) => {
  if (draft.acceptance && (draft.kind !== "invite" || draft.acceptance.token !== draft.token || draft.acceptance.intentId !== draft.intentId)) ctx.addIssue({ code: "custom", message: "The saved acceptance does not match this invitation and original intent." });
  if (draft.restoration && (draft.kind !== "access" || draft.restoration.token !== draft.token || draft.restoration.intentId !== draft.intentId)) ctx.addIssue({ code: "custom", message: "The saved return request does not match this capability and original intent." });
});
export type OrgEntryDraft = z.infer<typeof draftSchema>;
export function readOrgEntryDraft(value: string | null): OrgEntryDraft | null {
  try { const result = draftSchema.safeParse(value ? JSON.parse(value) : null); return result.success ? result.data : null; }
  catch { return null; }
}
/** A changed or malformed link cannot borrow an earlier identity declaration.
 * The exact entered request survives a response that already wrote its cookie. */
export function orgEntryForLocation(fragment: string, saved: OrgEntryDraft | null, intent: () => string): OrgEntryDraft | null {
  if (!fragment || fragment === "#") return saved;
  const fields = Array.from(new URLSearchParams(fragment.replace(/^#/, "")).entries());
  if (fields.length !== 1) return null;
  const parsed = entry.safeParse({ kind: fields[0][0], token: fields[0][1] });
  if (!parsed.success) return null;
  if (saved?.kind === parsed.data.kind && saved.token === parsed.data.token) return saved;
  return draftSchema.parse({ version: 1, ...parsed.data, intentId: intent() });
}
type AttemptContext = { organization: string | null; project: string | null };
export type OrgSavedAttempt<T> = { version: 1; path: string; context: AttemptContext; body: T };
const context = z.object({ organization: z.string().regex(/^[a-f0-9]{64}$/).nullable(), project: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict();
/** Persist only a single validated pending command, never a private desk, report
 * or source body. Its exact context/path cannot migrate to another operation. */
export function readOrgAttempt<T>(value: string | null, path: string, expected: AttemptContext, schema: z.ZodType<T>): OrgSavedAttempt<T> | null {
  try {
    const result = z.object({ version: z.literal(1), path: z.literal(path), context, body: schema }).strict().safeParse(value ? JSON.parse(value) : null);
    if (!result.success || result.data.context.organization !== expected.organization || result.data.context.project !== expected.project || !attemptMatchesContext(result.data.body, expected)) return null;
    return result.data;
  } catch { return null; }
}
export function saveOrgAttempt<T>(path: string, expected: AttemptContext, body: T, schema: z.ZodType<T>): OrgSavedAttempt<T> {
  const parsed = schema.parse(body), safeContext = context.parse(expected);
  if (!attemptMatchesContext(parsed, safeContext)) throw new Error("A command cannot move to another organization or project context.");
  return { version: 1, path, context: safeContext, body: parsed };
}
function attemptMatchesContext(body: unknown, expected: AttemptContext): boolean {
  if (!body || typeof body !== "object") return false;
  if ("expectedScope" in body && body.expectedScope !== expected.organization) return false;
  if ("expectedProjectScope" in body && body.expectedProjectScope !== expected.project) return false;
  return true;
}
const receipt = C.orgReceiptResponseSchema;
const application = z.object({ receipt: C.orgCommandReceiptSchema, application: C.orgPolicyApplicationSchema }).strict();
/** Only real reviewed command schemas may be restored; a stored path cannot
 * turn a read, arbitrary URL or widened body into a command. */
export function orgCommandContract(path: string): { request: z.ZodType; response: z.ZodType; label: string } | null {
  if (path === "create") return { request: C.orgCreateSchema, response: C.orgWelcomeResponseSchema, label: "organization creation" };
  if (path === "update") return { request: C.orgUpdateSchema, response: receipt, label: "organization details" };
  if (path === "invitations") return { request: C.orgInviteSchema, response: C.orgInviteResponseSchema, label: "member invitation" };
  if (path === "library/open") return { request: C.orgLibraryOpenSchema, response: receipt, label: "organization profile opening" };
  if (["library/remember", "library/clear-ended", "session/leave", "entry/leave"].includes(path)) return { request: C.orgLibraryActionSchema, response: receipt, label: "organization profile change" };
  if (/^invitations\/[0-9a-f-]{36}\/revoke$/.test(path)) return { request: C.orgInviteRevokeSchema, response: receipt, label: "invitation withdrawal" };
  if (/^members\/[0-9a-f-]{36}\/role$/.test(path)) return { request: C.orgMemberRoleSchema, response: receipt, label: "member role change" };
  if (/^members\/[0-9a-f-]{36}\/end$/.test(path)) return { request: C.orgMemberEndSchema, response: receipt, label: "membership ending" };
  if (path === "projects") return { request: C.orgLinkCommitSchema, response: receipt, label: "project disclosure" };
  if (/^projects\/[0-9a-f-]{36}\/withdraw$/.test(path)) return { request: C.orgLinkWithdrawSchema, response: receipt, label: "project disclosure withdrawal" };
  if (path === "policies/save") return { request: C.orgPolicySaveSchema, response: receipt, label: "policy draft save" };
  if (/^policies\/[0-9a-f-]{36}\/publish$/.test(path)) return { request: C.orgPolicyPublishSchema, response: receipt, label: "policy publication" };
  if (/^policies\/[0-9a-f-]{36}\/retire$/.test(path)) return { request: C.orgPolicyRetireSchema, response: receipt, label: "policy retirement" };
  if (/^projects\/[0-9a-f-]{36}\/adoptions$/.test(path)) return { request: C.orgAdoptSchema, response: application, label: "project policy adoption" };
  if (/^projects\/[0-9a-f-]{36}\/adoptions\/[0-9a-f-]{36}\/deactivate$/.test(path)) return { request: C.orgProjectRuleDeactivateSchema, response: receipt, label: "project rule deactivation" };
  if (/^projects\/[0-9a-f-]{36}\/adoptions\/[0-9a-f-]{36}\/replace$/.test(path)) return { request: C.orgProjectRuleReplaceSchema, response: application, label: "project rule replacement" };
  if (path === "portfolio/capture") return { request: C.orgPortfolioCaptureSchema, response: z.object({ receipt: C.orgCommandReceiptSchema, view: C.orgPortfolioViewSchema }).strict(), label: "portfolio edition capture" };
  return null;
}
export type OrgPendingAttempt = OrgSavedAttempt<unknown>;
export function readOrgPendingAttempt(value: string | null): OrgPendingAttempt | null {
  try {
    const envelope = z.object({ version: z.literal(1), path: z.string().max(300), context, body: z.unknown() }).strict().safeParse(value ? JSON.parse(value) : null);
    if (!envelope.success) return null;
    const contract = orgCommandContract(envelope.data.path), body = contract?.request.safeParse(envelope.data.body);
    if (!body?.success || !attemptMatchesContext(body.data, envelope.data.context)) return null;
    return { ...envelope.data, body: body.data };
  } catch { return null; }
}
