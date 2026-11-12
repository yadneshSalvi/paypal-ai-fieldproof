import { z } from "zod";
import { PROCUREMENT_VERSION, procurementProjectSchema } from "./contracts";

export const VOLUNTEER_ENTRY_VERSION = "procurement-volunteer-entry-v1" as const;
const id = z.uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), token = z.string().regex(/^[A-Za-z0-9_-]{64}$/), date = z.iso.datetime(), version = z.number().int().positive();
const name = z.string().trim().min(2).max(80).refine(value => !/[\u0000-\u001f\u007f]/.test(value), "Use a self-declared name without control characters.");
const reason = z.string().trim().min(8).max(1000), message = z.string().min(1).max(1400), ack = { acknowledged: z.literal(true) };
export const volunteerInviteInputSchema = z.object({ intentId: id, expectedScope: hash, label: name, expiresHours: z.number().int().min(1).max(168), role: z.literal("volunteer"), contractVersion: z.literal(VOLUNTEER_ENTRY_VERSION), ...ack }).strict();
export type VolunteerInviteInput = z.infer<typeof volunteerInviteInputSchema>;
export const volunteerInviteActionSchema = z.object({ intentId: id, expectedScope: hash, expectedVersion: version, reason, ...ack }).strict();
export const volunteerInviteLinkSchema = z.object({ expectedScope: hash, expectedVersion: version }).strict();
export const volunteerEntryInputSchema = z.object({ kind: z.enum(["invite", "access"]), token, intentId: id.optional() }).strict();
export type VolunteerEntryInput = z.infer<typeof volunteerEntryInputSchema>;
export const volunteerAcceptSchema = z.object({ intentId: id, expectedScope: hash, token, displayName: name, contractVersion: z.literal(VOLUNTEER_ENTRY_VERSION), role: z.literal("volunteer"), ...ack }).strict();
export type VolunteerAccept = z.infer<typeof volunteerAcceptSchema>;
export const volunteerRestoreSchema = z.object({ intentId: id, expectedScope: hash, token, ...ack }).strict();
export const volunteerLeaveSchema = z.object({ expectedScope: hash, ...ack }).strict();
export const volunteerInviteSchema = z.object({ id, version, label: name, state: z.enum(["invited", "joined", "expired", "revoked", "authority_changed"]), role: z.literal("volunteer"), createdAt: date, expiresAt: date, joinedAt: date.nullable(), recipient: z.object({ displayName: name, identityProvenance: z.literal("self_declared") }).strict().nullable(), canCopy: z.boolean(), canRevoke: z.boolean() }).strict();
export type VolunteerInvite = z.infer<typeof volunteerInviteSchema>;
export const volunteerInviteDeskSchema = z.object({ scope: hash, project: procurementProjectSchema, sessionExpiresAt: date, invitations: z.array(volunteerInviteSchema).max(20), nextCursor: z.string().max(500).nullable(), canInvite: z.boolean(), notices: z.array(message).max(100) }).strict();
export type VolunteerInviteDesk = z.infer<typeof volunteerInviteDeskSchema>;
export const volunteerEntryViewSchema = z.object({ contractVersion: z.literal(VOLUNTEER_ENTRY_VERSION), kind: z.enum(["invite", "access"]), state: z.enum(["ready", "issuer", "switch_required", "joined_here", "used", "expired", "revoked", "authority_changed", "unavailable"]), scope: hash, project: procurementProjectSchema.nullable(), role: z.literal("volunteer"), expiresAt: date.nullable(), current: z.object({ title: z.string().min(1).max(160), role: z.enum(["organizer", "volunteer", "donor", "auditor"]), expiresAt: date }).strict().nullable(), recipient: z.object({ displayName: name, identityProvenance: z.literal("self_declared") }).strict().nullable(), canLeave: z.boolean(), canAccept: z.boolean(), canRestore: z.boolean(), notices: z.array(message).max(100) }).strict().superRefine((value, ctx) => {
  if (value.state === "switch_required" && (value.project || value.recipient || value.canAccept || value.canRestore) || ["used", "expired", "revoked", "authority_changed", "unavailable"].includes(value.state) && (value.project || value.recipient || value.canAccept || value.canRestore)) ctx.addIssue({ code: "custom", path: ["project"], message: "An unrelated or ended browser context cannot see recipient or private project details or restore a different actor." });
});
export type VolunteerEntryView = z.infer<typeof volunteerEntryViewSchema>;
export const volunteerWelcomeSchema = z.object({ project: procurementProjectSchema, displayName: name, role: z.literal("volunteer"), expiresAt: date, identityProvenance: z.literal("self_declared"), authentication: z.literal("invitation_possession"), currentContract: z.literal(PROCUREMENT_VERSION) }).strict();
export type VolunteerWelcome = z.infer<typeof volunteerWelcomeSchema>;
export const volunteerEntryReceiptSchema = z.object({ intentId: id, kind: z.enum(["invite", "revoke", "accept", "restore"]), resourceId: id, version, recordedAt: date, message }).strict();
export const volunteerInvitationResultSchema = z.object({ receipt: volunteerEntryReceiptSchema, invitation: z.object({ id, version, expiresAt: date, path: z.string().regex(/^\/procurement\/join#invite=[A-Za-z0-9_-]{64}$/) }).strict() }).strict();
export const volunteerJoinResultSchema = z.object({ receipt: volunteerEntryReceiptSchema, welcome: volunteerWelcomeSchema, returnPath: z.string().regex(/^\/procurement\/join#access=[A-Za-z0-9_-]{64}$/) }).strict();
export const VOLUNTEER_ENTRY_ERRORS = ["VOLUNTEER_ENTRY_INVALID", "VOLUNTEER_ENTRY_EXPIRED", "VOLUNTEER_ENTRY_USED", "VOLUNTEER_ENTRY_REVOKED", "VOLUNTEER_ENTRY_ISSUER_CHANGED", "VOLUNTEER_ENTRY_SWITCH_REQUIRED", "VOLUNTEER_ENTRY_CONTEXT_CHANGED", "VOLUNTEER_ENTRY_INTENT_CHANGED", "VOLUNTEER_ENTRY_BUSY", "VOLUNTEER_ENTRY_ISSUER", "PROCUREMENT_CONTEXT_CHANGED", "PROCUREMENT_AUTHORITY_ENDED", "PROCUREMENT_ROLE_DENIED", "INVALID_INPUT", "REQUEST_UNAVAILABLE"] as const;
export const volunteerEntryProblemSchema = z.object({ error: message, code: z.enum(VOLUNTEER_ENTRY_ERRORS) }).strict();

/** Ordinary one-use entry, never a demo actor chooser. Current organizer
 * issues exact volunteer authority until min(requested original deadline,
 * original issuer session deadline). Acceptance rechecks original issuer
 * membership/version and session expiry after waits. No donor/organizer role
 * union, new grant on return, verified-person/email/PayPal or human claim.
 *
 * GET  /api/procurement/invitations?before= -> {desk:VolunteerInviteDesk}
 * POST /api/procurement/invitations -> VolunteerInviteInput -> InvitationResult
 * POST /api/procurement/invitations/:id/link -> VolunteerInviteLink -> {invitation}
 * POST /api/procurement/invitations/:id/revoke -> VolunteerInviteAction -> {receipt}
 * POST /api/procurement/entry/review -> EntryInput -> {entry:VolunteerEntryView}
 * POST /api/procurement/entry/accept -> VolunteerAccept -> JoinResult
 * POST /api/procurement/entry/restore -> VolunteerRestore -> JoinResult
 * POST /api/procurement/entry/leave -> VolunteerLeave -> {left:true}
 *
 * Entry receives possession only in request bodies from a URL fragment; no
 * token enters query strings, HTML or source logs. A separate HttpOnly browser
 * secret+intent+unchanged input binds lost-response recovery. Any other active
 * actor, or any nonempty unrelated ended cookie, must explicitly clear/switch
 * under its exact reviewed context before acceptance or return. Only the exact
 * original recipient session can replay acceptance after its cookie was set.
 * A recipient return key can deliberately restore that same original session
 * in a fresh browser, with the exact original actor, membership and deadline.
 */
