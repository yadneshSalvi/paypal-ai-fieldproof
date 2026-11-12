import { randomBytes, randomUUID } from "node:crypto";
import type { SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import * as A from "../procurement/access-contracts";
import * as C from "../procurement/contracts";
import { DomainError } from "../domain/money";
import { tokenHash, type Session } from "./auth";
import { database, query } from "./db";
import { appendEvent } from "./repository";
import { dbClock, expectProcurementScope, openProcurement, procurementAuthority, procurementCursor, procurementHash, procurementProject, procurementProjectLock, readProcurementCursor, scopeValues, sealProcurement, type ProcurementAuthority } from "./procurement-store";

export interface VolunteerEntryContext { session: Session | null; credentialHash: string | null; browserKey: string; }
interface InviteRow { id: string; tenant_id: string; project_id: string; issuer_actor_id: string; issuer_session_id: string; issuer_membership_version: number; issuer_session_expires_at: Date; issuer_browser_hash: string; token_hash: string; encrypted_token: string | null; encrypted_data: string; version: number; state: "invited" | "joined" | "revoked"; expires_at: Date; joined_at: Date | null; revoked_at: Date | null; created_at: Date; }
interface AccessRow { id: string; invitation_id: string; tenant_id: string; project_id: string; actor_id: string; session_id: string; membership_version: number; acceptance_intent_id: string; acceptance_hash: string; browser_hash: string; encrypted_identity: string; encrypted_acceptance: string; encrypted_session_token: string; return_token_hash: string; encrypted_return_token: string; expires_at: Date; created_at: Date; }
interface Identity { displayName: string; identityProvenance: "self_declared"; contractVersion: typeof A.VOLUNTEER_ENTRY_VERSION; }
interface EntryCommandRow { actor_session_id: string; kind: string; input_hash: string; browser_hash: string; result: unknown; encrypted_recovery: string | null; }
export interface VolunteerSessionResult { result: z.infer<typeof A.volunteerJoinResultSchema>; session: Session; sessionToken: string; }
const scopeOf = (row: Pick<InviteRow, "tenant_id" | "project_id">) => ({ tenantId: row.tenant_id, projectId: row.project_id });
function browserHash(value: string) { if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new DomainError("VOLUNTEER_ENTRY_CONTEXT_CHANGED", "Refresh this private invitation before continuing.", 409); return tokenHash(value); }
const invalid = () => new DomainError("VOLUNTEER_ENTRY_INVALID", "This private volunteer invitation or original return link is unavailable.", 410);
const changed = () => new DomainError("VOLUNTEER_ENTRY_CONTEXT_CHANGED", "This browser's original project context changed. Review it again before continuing.", 409);
const switchRequired = () => new DomainError("VOLUNTEER_ENTRY_SWITCH_REQUIRED", "Explicitly leave the other or ended workspace credential before accepting or restoring this private profile.", 409);
function entryBusy(error: unknown): never { if (error && typeof error === "object" && "code" in error && ["55P03", "57014", "40P01", "40001"].includes(String(error.code))) throw new DomainError("VOLUNTEER_ENTRY_BUSY", "The original request is finishing another decision. Retain the same intent and unchanged fields before retrying.", 409); throw error; }
async function contextScope(context: VolunteerEntryContext, tx: SqlConnection, lock = false) {
  const browser = browserHash(context.browserKey); let currentScope: string | null = null;
  if (context.session) {
    currentScope = (await procurementAuthority(context.session, tx, ["organizer", "volunteer", "auditor", "donor"], lock)).scope;
    const [row] = await query<{ token_hash: string }>("SELECT token_hash FROM fp_sessions WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND actor_id=$4", [context.session.id, context.session.tenantId, context.session.projectId, context.session.actorId], tx);
    if (!row || row.token_hash !== context.credentialHash) throw changed();
  }
  return procurementHash({ contractVersion: A.VOLUNTEER_ENTRY_VERSION, browser, credentialHash: context.credentialHash, currentScope });
}
async function issuerCurrent(tx: SqlConnection, row: InviteRow, lock = false) {
  const [session] = await query<{ expires_at: Date; revoked_at: Date | null }>(`SELECT expires_at,revoked_at FROM fp_sessions WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND actor_id=$4${lock ? " FOR SHARE" : ""}`, [row.issuer_session_id, row.tenant_id, row.project_id, row.issuer_actor_id], tx);
  const [member] = await query<{ state: string; version: number; roles: string[] }>(`SELECT state,version,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3${lock ? " FOR SHARE" : ""}`, [row.tenant_id, row.project_id, row.issuer_actor_id], tx);
  return !!session && !session.revoked_at && session.expires_at.getTime() === row.issuer_session_expires_at.getTime() && session.expires_at.getTime() > Date.parse(await dbClock(tx)) && !!member && member.state === "active" && member.version === row.issuer_membership_version && member.roles.includes("organizer");
}
async function projectSummary(tx: SqlConnection, row: InviteRow) { const { createdAt: _createdAt, ...project } = await procurementProject(scopeOf(row), tx); return project; }
async function invitationById(tx: SqlConnection, session: Pick<Session, "tenantId" | "projectId">, id: string, lock = false) { const [row] = await query<InviteRow>(`SELECT * FROM fp_procurement_invites WHERE tenant_id=$1 AND project_id=$2 AND id=$3${lock ? " FOR UPDATE" : ""}`, [...scopeValues(session), id], tx); if (!row) throw invalid(); return row; }
async function resolve(tx: SqlConnection, kind: "invite" | "access", token: string) {
  if (kind === "access") { const [access] = await query<AccessRow>("SELECT * FROM fp_procurement_access WHERE return_token_hash=$1", [tokenHash(token)], tx); if (!access) return null; const [invite] = await query<InviteRow>("SELECT * FROM fp_procurement_invites WHERE id=$1 AND tenant_id=$2 AND project_id=$3", [access.invitation_id, access.tenant_id, access.project_id], tx); return invite ? { invite, access } : null; }
  const [invite] = await query<InviteRow>("SELECT * FROM fp_procurement_invites WHERE token_hash=$1", [tokenHash(token)], tx); if (!invite) return null; const [access] = await query<AccessRow>("SELECT * FROM fp_procurement_access WHERE invitation_id=$1", [invite.id], tx); return { invite, access: access ?? null };
}
async function assertInvitationDeadline(tx: SqlConnection, row: InviteRow) { if (row.state === "revoked") throw new DomainError("VOLUNTEER_ENTRY_REVOKED", "This invitation and its private return capability were withdrawn. Original project records remain retained.", 410); if (row.expires_at.getTime() <= Date.parse(await dbClock(tx))) throw new DomainError("VOLUNTEER_ENTRY_EXPIRED", "The original fixed volunteer deadline ended. Return and retry never renew it.", 410); }
async function currentAccess(tx: SqlConnection, row: InviteRow, access: AccessRow) {
  await assertInvitationDeadline(tx, row);
  if (row.state !== "joined" || access.invitation_id !== row.id || access.tenant_id !== row.tenant_id || access.project_id !== row.project_id || access.expires_at.getTime() !== row.expires_at.getTime()) throw invalid();
  const [session] = await query<{ token_hash: string; expires_at: Date; revoked_at: Date | null; role: string }>("SELECT token_hash,expires_at,revoked_at,role FROM fp_sessions WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND actor_id=$4 FOR SHARE", [access.session_id, row.tenant_id, row.project_id, access.actor_id], tx);
  const [member] = await query<{ state: string; version: number; roles: string[] }>("SELECT state,version,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 FOR SHARE", [row.tenant_id, row.project_id, access.actor_id], tx);
  if (!session || session.revoked_at || session.role !== "volunteer" || session.expires_at.getTime() !== access.expires_at.getTime() || session.expires_at.getTime() <= Date.parse(await dbClock(tx)) || !member || member.state !== "active" || member.version !== access.membership_version || procurementHash(member.roles) !== procurementHash(["volunteer"])) throw invalid();
  const scope = scopeOf(row), sessionToken = openProcurement<string>(scope, "volunteer-session", access.id, 1, access.encrypted_session_token), returnToken = openProcurement<string>(scope, "volunteer-return", access.id, 1, access.encrypted_return_token), identity = openProcurement<Identity>(scope, "volunteer-identity", access.id, 1, access.encrypted_identity);
  if (tokenHash(sessionToken) !== session.token_hash || tokenHash(returnToken) !== access.return_token_hash || identity.contractVersion !== A.VOLUNTEER_ENTRY_VERSION || identity.identityProvenance !== "self_declared") throw invalid();
  const project = await projectSummary(tx, row), currentSession: Session = { ...scope, id: access.session_id, actorId: access.actor_id, role: "volunteer", expiresAt: access.expires_at.toISOString(), mode: project.mode };
  return { session: currentSession, sessionToken, returnToken, welcome: A.volunteerWelcomeSchema.parse({ project, displayName: identity.displayName, role: "volunteer", expiresAt: access.expires_at.toISOString(), identityProvenance: "self_declared", authentication: "invitation_possession", currentContract: C.PROCUREMENT_VERSION }) };
}
async function audit(tx: SqlConnection, row: InviteRow, session: Session, membershipVersion: number, kind: "invited" | "accepted" | "revoked" | "restored", data: unknown) {
  const id = randomUUID(); await tx.query("INSERT INTO fp_procurement_access_audit(id,tenant_id,project_id,invitation_id,kind,actor_id,actor_session_id,actor_role,membership_version,encrypted_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [id, row.tenant_id, row.project_id, row.id, kind, session.actorId, session.id, session.role, membershipVersion, sealProcurement(session, "volunteer-audit", id, 1, data)]);
}
async function saveEntryCommand(tx: SqlConnection, authority: ProcurementAuthority, intentId: string, kind: "invite" | "revoke" | "restore", browser: string, input: unknown, receipt: z.infer<typeof A.volunteerEntryReceiptSchema>, recovery: unknown) {
  const session = authority.session; await tx.query("INSERT INTO fp_procurement_entry_commands(tenant_id,project_id,actor_id,actor_session_id,actor_role,membership_version,intent_id,kind,browser_hash,input_hash,encrypted_input,result,encrypted_recovery) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)", [session.tenantId, session.projectId, session.actorId, session.id, session.role, authority.membershipVersion, intentId, kind, browser, procurementHash(input), sealProcurement(session, "volunteer-command", `${session.actorId}:${intentId}`, 1, input), JSON.stringify(receipt), recovery === null ? null : sealProcurement(session, "volunteer-command-result", `${session.actorId}:${intentId}`, 1, recovery)]);
}
async function priorEntryCommand(tx: SqlConnection, session: Session, intentId: string, kind: string, browser: string, input: unknown) {
  const [row] = await query<EntryCommandRow>("SELECT * FROM fp_procurement_entry_commands WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND intent_id=$4", [...scopeValues(session), session.actorId, intentId], tx);
  if (row && (row.actor_session_id !== session.id || row.kind !== kind || row.browser_hash !== browser || row.input_hash !== procurementHash(input))) throw new DomainError("VOLUNTEER_ENTRY_INTENT_CHANGED", "This original request has different retained fields, browser or profile. Inspect the original result before starting another decision.", 409);
  return row;
}
async function entryLocks(tx: SqlConnection, browser: string, intentId: string, scope: { tenantId: string; projectId: string }) {
  await tx.query("SET LOCAL lock_timeout='2000ms'; SET LOCAL statement_timeout='20000ms'");
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`procurement-entry-command:${browser}:${intentId}`]);
  await procurementProjectLock(tx, scope);
}

export async function createVolunteerInvitation(session: Session, browserKey: string, raw: A.VolunteerInviteInput) {
  const input = A.volunteerInviteInputSchema.parse(raw), browser = browserHash(browserKey); expectProcurementScope(await procurementAuthority(session, database(), ["organizer"]), input.expectedScope);
  try { return await database().transaction(async tx => {
    await entryLocks(tx, browser, input.intentId, session); const authority = await procurementAuthority(session, tx, ["organizer"], true); expectProcurementScope(authority, input.expectedScope);
    const previous = await priorEntryCommand(tx, session, input.intentId, "invite", browser, input);
    if (previous) { if (!previous.encrypted_recovery) throw invalid(); const saved = A.volunteerInvitationResultSchema.parse(openProcurement(session, "volunteer-command-result", `${session.actorId}:${input.intentId}`, 1, previous.encrypted_recovery)); const row = await invitationById(tx, session, saved.invitation.id); await assertInvitationDeadline(tx, row); if (row.state !== "invited" || !await issuerCurrent(tx, row, true)) throw invalid(); return saved; }
    const [{ count }] = await query<{ count: string }>("SELECT count(*) FROM fp_procurement_invites WHERE tenant_id=$1 AND project_id=$2 AND created_at>clock_timestamp()-interval '24 hours'", scopeValues(session), tx); if (Number(count) >= 60) throw new DomainError("VOLUNTEER_ENTRY_BUSY", "This project issued several invitations today. Keep existing fixed grants and review them before issuing more.", 429);
    const id = randomUUID(), token = randomBytes(48).toString("base64url"), at = await dbClock(tx), expiresAt = new Date(Math.min(Date.parse(session.expiresAt), Date.parse(at) + input.expiresHours * 3600_000)).toISOString();
    await tx.query("INSERT INTO fp_procurement_invites(id,tenant_id,project_id,issuer_actor_id,issuer_session_id,issuer_membership_version,issuer_session_expires_at,issuer_browser_hash,role,token_hash,encrypted_token,encrypted_data,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'volunteer',$9,$10,$11,$12)", [id, session.tenantId, session.projectId, session.actorId, session.id, authority.membershipVersion, session.expiresAt, browser, tokenHash(token), sealProcurement(session, "volunteer-invite-token", id, 1, token), sealProcurement(session, "volunteer-invite", id, 1, { label: input.label, contractVersion: A.VOLUNTEER_ENTRY_VERSION, role: "volunteer", identityVerified: false }), expiresAt]);
    const row = await invitationById(tx, session, id), receipt = A.volunteerEntryReceiptSchema.parse({ intentId: input.intentId, kind: "invite", resourceId: id, version: 1, recordedAt: at, message: "The one-use private invitation grants only volunteer membership until its original fixed deadline. No verified identity, supplier participation or work is established." }), result = A.volunteerInvitationResultSchema.parse({ receipt, invitation: { id, version: 1, expiresAt, path: `/procurement/join#invite=${token}` } });
    await audit(tx, row, session, authority.membershipVersion, "invited", { label: input.label, expiresAt, authentication: "invitation_possession", originalIssuerMembershipVersion: authority.membershipVersion }); await saveEntryCommand(tx, authority, input.intentId, "invite", browser, input, receipt, result);
    expectProcurementScope(await procurementAuthority(session, tx, ["organizer"]), input.expectedScope); await assertInvitationDeadline(tx, row); return result;
  }); } catch (error) { return entryBusy(error); }
}
export async function volunteerInvitationLink(session: Session, id: string, raw: z.infer<typeof A.volunteerInviteLinkSchema>) {
  const input = A.volunteerInviteLinkSchema.parse(raw);
  return database().transaction(async tx => { await procurementProjectLock(tx, session); const authority = await procurementAuthority(session, tx, ["organizer"], true); expectProcurementScope(authority, input.expectedScope); const row = await invitationById(tx, session, id, true); await assertInvitationDeadline(tx, row); if (row.version !== input.expectedVersion || row.state !== "invited" || !row.encrypted_token || !await issuerCurrent(tx, row, true)) throw invalid(); const token = openProcurement<string>(session, "volunteer-invite-token", id, 1, row.encrypted_token); if (tokenHash(token) !== row.token_hash) throw invalid(); const result = { invitation: { id, version: row.version, expiresAt: row.expires_at.toISOString(), path: `/procurement/join#invite=${token}` } }; expectProcurementScope(await procurementAuthority(session, tx, ["organizer"]), input.expectedScope); await assertInvitationDeadline(tx, row); return result; });
}
export async function revokeVolunteerInvitation(session: Session, browserKey: string, id: string, raw: z.infer<typeof A.volunteerInviteActionSchema>) {
  const input = A.volunteerInviteActionSchema.parse(raw), browser = browserHash(browserKey), bound = { ...input, resourceId: id }; expectProcurementScope(await procurementAuthority(session, database(), ["organizer"]), input.expectedScope);
  try { return await database().transaction(async tx => {
    await entryLocks(tx, browser, input.intentId, session); const authority = await procurementAuthority(session, tx, ["organizer"], true); expectProcurementScope(authority, input.expectedScope);
    const previous = await priorEntryCommand(tx, session, input.intentId, "revoke", browser, bound); if (previous) return A.volunteerEntryReceiptSchema.parse(previous.result);
    const row = await invitationById(tx, session, id, true); if (row.version !== input.expectedVersion || row.state === "revoked") throw new DomainError("VOLUNTEER_ENTRY_CONTEXT_CHANGED", "This invitation or original grant has a newer decision. Review it before withdrawing access.", 409);
    const [access] = await query<AccessRow>("SELECT * FROM fp_procurement_access WHERE invitation_id=$1 AND tenant_id=$2 AND project_id=$3", [id, session.tenantId, session.projectId], tx);
    if (access) {
      // End only the original invitation grant. Never remove a separately
      // changed membership or a different project/session belonging to an actor.
      await tx.query("UPDATE fp_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND actor_id=$4", [access.session_id, row.tenant_id, row.project_id, access.actor_id]);
      await tx.query("UPDATE fp_memberships SET state='revoked',version=version+1,revoked_at=clock_timestamp() WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND version=$4 AND state='active' AND roles='[\"volunteer\"]'::jsonb", [row.tenant_id, row.project_id, access.actor_id, access.membership_version]);
    }
    await tx.query("UPDATE fp_procurement_invites SET state='revoked',version=version+1,encrypted_token=NULL,revoked_at=clock_timestamp(),revoked_by=$4 WHERE tenant_id=$1 AND project_id=$2 AND id=$3", [...scopeValues(session), id, session.actorId]);
    const receipt = A.volunteerEntryReceiptSchema.parse({ intentId: input.intentId, kind: "revoke", resourceId: id, version: row.version + 1, recordedAt: await dbClock(tx), message: "The invitation and its original volunteer return capability are withdrawn. Independent project grants, financial obligations and physical history remain retained." });
    await audit(tx, row, session, authority.membershipVersion, "revoked", { reason: input.reason, accessId: access?.id ?? null, originalDeadline: row.expires_at.toISOString() }); await saveEntryCommand(tx, authority, input.intentId, "revoke", browser, bound, receipt, null); await appendEvent(tx, session, "procurement.volunteer_access_withdrawn", "Volunteer coordination access changed", "The original invitation grant ended. No purchase, financial approval or physical evidence was changed."); expectProcurementScope(await procurementAuthority(session, tx, ["organizer"]), input.expectedScope); return receipt;
  }); } catch (error) { return entryBusy(error); }
}

export async function readVolunteerInvitations(session: Session, expectedScope?: string, before?: string | null): Promise<A.VolunteerInviteDesk> {
  return database().transaction(async tx => {
    const authority = await procurementAuthority(session, tx, ["organizer"]); if (expectedScope) expectProcurementScope(authority, expectedScope); const cursor = readProcurementCursor(before, "volunteer-invites", authority.scope, null);
    const rows = await query<InviteRow>("SELECT * FROM fp_procurement_invites WHERE tenant_id=$1 AND project_id=$2 AND ($3::timestamptz IS NULL OR (date_trunc('milliseconds',created_at),id)<($3,$4)) ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT $5", [...scopeValues(session), cursor?.at ?? null, cursor?.id ?? null, C.PROCUREMENT_PAGE_SIZE + 1], tx), page = rows.slice(0, C.PROCUREMENT_PAGE_SIZE), invitations: A.VolunteerInvite[] = [];
    for (const row of page) { const data = openProcurement<{ label: string }>(session, "volunteer-invite", row.id, 1, row.encrypted_data), [access] = await query<AccessRow>("SELECT * FROM fp_procurement_access WHERE invitation_id=$1", [row.id], tx); let state: A.VolunteerInvite["state"] = row.state; if (row.state !== "revoked") { if (row.expires_at.getTime() <= Date.parse(await dbClock(tx))) state = "expired"; else if (row.state === "invited" && !await issuerCurrent(tx, row)) state = "authority_changed"; } const identity = access ? openProcurement<Identity>(session, "volunteer-identity", access.id, 1, access.encrypted_identity) : null; invitations.push({ id: row.id, version: row.version, label: data.label, state, role: "volunteer", createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), joinedAt: row.joined_at?.toISOString() ?? null, recipient: identity ? { displayName: identity.displayName, identityProvenance: "self_declared" } : null, canCopy: state === "invited", canRevoke: row.state !== "revoked" }); }
    const project = await procurementProject(session, tx), { createdAt: _createdAt, ...summary } = project;
    const result = A.volunteerInviteDeskSchema.parse({ scope: authority.scope, project: summary, sessionExpiresAt: session.expiresAt, invitations, nextCursor: rows.length > page.length ? procurementCursor("volunteer-invites", authority.scope, null, page[page.length - 1]) : null, canInvite: true, notices: ["Possession of a private one-use URL grants only a separate volunteer profile. Self-declared names do not verify a person, organization, email, supplier or PayPal account.", "The deadline is fixed at issuance and no later than the original organizer session. Assignment acceptance and financial or physical authority remain separate."] }); JSON.stringify(result); expectProcurementScope(await procurementAuthority(session, tx, ["organizer"]), authority.scope); return result;
  });
}
export async function reviewVolunteerEntry(raw: A.VolunteerEntryInput, context: VolunteerEntryContext): Promise<A.VolunteerEntryView> {
  const input = A.volunteerEntryInputSchema.parse(raw);
  return database().transaction(async tx => {
    const scope = await contextScope(context, tx), currentProject = context.session ? await procurementProject(context.session, tx) : null;
    const base: A.VolunteerEntryView = { contractVersion: A.VOLUNTEER_ENTRY_VERSION, kind: input.kind, state: "unavailable", scope, project: null, role: "volunteer", expiresAt: null, current: context.session && currentProject ? { title: currentProject.title, role: context.session.role, expiresAt: context.session.expiresAt } : null, recipient: null, canLeave: false, canAccept: false, canRestore: false, notices: [] };
    const found = await resolve(tx, input.kind, input.token); if (!found) return base; const { invite: row, access } = found;
    if (row.state === "revoked") return { ...base, state: "revoked" }; if (row.expires_at.getTime() <= Date.parse(await dbClock(tx))) return { ...base, state: "expired", expiresAt: row.expires_at.toISOString() };
    if (input.kind === "invite" && (row.issuer_actor_id === context.session?.actorId || row.issuer_browser_hash === browserHash(context.browserKey))) return { ...base, state: "issuer", notices: ["The issuing actor or browser cannot accept its own invitation. A private URL establishes possession, not an independent human participant."] };
    if (context.session ? context.session.id !== access?.session_id : context.credentialHash !== null) return { ...base, state: "switch_required", canLeave: true, notices: ["Leave this exact current or ended workspace credential deliberately. No project identities or roles are merged."] };
    if (access) {
      if (input.kind === "invite" && (access.browser_hash !== browserHash(context.browserKey) || access.acceptance_intent_id !== input.intentId)) return { ...base, state: "used" };
      try { const original = await currentAccess(tx, row, access); const result: A.VolunteerEntryView = { ...base, state: context.session?.id === access.session_id ? "joined_here" : "ready", project: original.welcome.project, expiresAt: access.expires_at.toISOString(), recipient: { displayName: original.welcome.displayName, identityProvenance: "self_declared" }, canAccept: input.kind === "invite", canRestore: input.kind === "access", notices: ["This returns to the same original volunteer actor and session until its fixed deadline. It creates no new membership or renewed expiry."] }; await currentAccess(tx, row, access); return A.volunteerEntryViewSchema.parse(result); } catch (error) { if (!(error instanceof DomainError)) throw error; return { ...base, state: "unavailable" }; }
    }
    if (!await issuerCurrent(tx, row)) return { ...base, state: "authority_changed" };
    const result = A.volunteerEntryViewSchema.parse({ ...base, state: "ready", project: await projectSummary(tx, row), expiresAt: row.expires_at.toISOString(), canAccept: true, notices: ["Your name is self-declared and unverified. Accepting gives only the volunteer role; a separate current member proposal and your acceptance are needed for package responsibility."] }); if (!await issuerCurrent(tx, row) || row.expires_at.getTime() <= Date.parse(await dbClock(tx))) return { ...base, state: "authority_changed" }; return result;
  });
}

function joinResult(original: Awaited<ReturnType<typeof currentAccess>>, access: AccessRow, intentId: string, kind: "accept" | "restore", at: string): VolunteerSessionResult {
  return { session: original.session, sessionToken: original.sessionToken, result: A.volunteerJoinResultSchema.parse({ receipt: { intentId, kind, resourceId: access.id, version: 1, recordedAt: at, message: kind === "accept" ? "The original one-use invitation grants only volunteer membership. Identity remains self-declared; no financial or physical authority is implied." : "The exact original volunteer session is restored with its unchanged actor, membership and fixed deadline." }, welcome: original.welcome, returnPath: `/procurement/join#access=${original.returnToken}` }) };
}
export async function acceptVolunteerInvitation(raw: A.VolunteerAccept, context: VolunteerEntryContext): Promise<VolunteerSessionResult> {
  const input = A.volunteerAcceptSchema.parse(raw), browser = browserHash(context.browserKey), lookup = await resolve(database(), "invite", input.token); if (!lookup) throw invalid();
  try { return await database().transaction(async tx => {
    await entryLocks(tx, browser, input.intentId, scopeOf(lookup.invite)); const scope = await contextScope(context, tx, true), row = await invitationById(tx, scopeOf(lookup.invite), lookup.invite.id, true); await assertInvitationDeadline(tx, row);
    const [priorAttempt] = await query<AccessRow>("SELECT * FROM fp_procurement_access WHERE browser_hash=$1 AND acceptance_intent_id=$2", [browser, input.intentId], tx);
    if (priorAttempt && (priorAttempt.invitation_id !== row.id || priorAttempt.acceptance_hash !== procurementHash(input))) throw new DomainError("VOLUNTEER_ENTRY_INTENT_CHANGED", "This original browser request already accepted different invitation or identity fields. Its original result is retained.", 409);
    const [access] = await query<AccessRow>("SELECT * FROM fp_procurement_access WHERE invitation_id=$1", [row.id], tx);
    if (access) {
      if (access.browser_hash !== browser || access.acceptance_intent_id !== input.intentId || access.acceptance_hash !== procurementHash(input)) throw new DomainError("VOLUNTEER_ENTRY_USED", "This one-use invitation already has an original recipient. Use that recipient's private return capability.", 410);
      const exactEntered = context.session?.id === access.session_id;
      if (context.session ? !exactEntered : context.credentialHash !== null) throw switchRequired();
      const originalInput = openProcurement<{ input: A.VolunteerAccept; credentialHash: string | null }>(scopeOf(row), "volunteer-acceptance", access.id, 1, access.encrypted_acceptance);
      if (procurementHash(originalInput.input) !== procurementHash(input) || !exactEntered && (originalInput.credentialHash !== context.credentialHash || input.expectedScope !== scope)) throw changed();
      const original = await currentAccess(tx, row, access); return joinResult(original, access, input.intentId, "accept", access.created_at.toISOString());
    }
    if (row.state !== "invited") throw invalid();
    if (row.issuer_browser_hash === browser || row.issuer_actor_id === context.session?.actorId) throw new DomainError("VOLUNTEER_ENTRY_ISSUER", "The original issuing actor or browser cannot accept its own one-use invitation.", 403);
    if (context.session || context.credentialHash !== null) throw switchRequired(); if (input.expectedScope !== scope) throw changed();
    if (!await issuerCurrent(tx, row, true)) throw new DomainError("VOLUNTEER_ENTRY_ISSUER_CHANGED", "The original inviting organizer authority or membership version ended. A new current invitation needs review.", 410);
    const id = randomUUID(), actorId = randomUUID(), sessionId = randomUUID(), sessionToken = randomBytes(32).toString("base64url"), returnToken = randomBytes(48).toString("base64url"), target = scopeOf(row), at = await dbClock(tx);
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,'[\"volunteer\"]'::jsonb)", [target.tenantId, target.projectId, actorId]);
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'volunteer',$6)", [sessionId, tokenHash(sessionToken), target.tenantId, target.projectId, actorId, row.expires_at]);
    const identity: Identity = { displayName: input.displayName, identityProvenance: "self_declared", contractVersion: A.VOLUNTEER_ENTRY_VERSION };
    await tx.query("INSERT INTO fp_procurement_access(id,invitation_id,tenant_id,project_id,actor_id,session_id,membership_version,acceptance_intent_id,acceptance_hash,browser_hash,encrypted_identity,encrypted_acceptance,encrypted_session_token,return_token_hash,encrypted_return_token,expires_at) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15)", [id, row.id, target.tenantId, target.projectId, actorId, sessionId, input.intentId, procurementHash(input), browser, sealProcurement(target, "volunteer-identity", id, 1, identity), sealProcurement(target, "volunteer-acceptance", id, 1, { input, credentialHash: context.credentialHash }), sealProcurement(target, "volunteer-session", id, 1, sessionToken), tokenHash(returnToken), sealProcurement(target, "volunteer-return", id, 1, returnToken), row.expires_at]);
    await tx.query("UPDATE fp_procurement_invites SET state='joined',version=version+1,joined_at=clock_timestamp(),encrypted_token=NULL WHERE tenant_id=$1 AND project_id=$2 AND id=$3", [...scopeValues(target), row.id]);
    const joined = await invitationById(tx, target, row.id), [saved] = await query<AccessRow>("SELECT * FROM fp_procurement_access WHERE id=$1", [id], tx), original = await currentAccess(tx, joined, saved);
    await audit(tx, joined, original.session, 1, "accepted", { authentication: "invitation_possession", identityProvenance: "self_declared", originalIssuerMembershipVersion: row.issuer_membership_version, originalDeadline: row.expires_at.toISOString() }); await appendEvent(tx, original.session, "procurement.volunteer_joined", "A volunteer project profile joined", "The self-declared possession-based profile holds only volunteer membership. No independent human identity, supplier response, payment or physical work is verified.");
    if (!await issuerCurrent(tx, row) || row.expires_at.getTime() <= Date.parse(await dbClock(tx))) throw new DomainError("VOLUNTEER_ENTRY_EXPIRED", "The original invitation authority or fixed deadline ended while acceptance was being recorded.", 410);
    return joinResult(await currentAccess(tx, joined, saved), saved, input.intentId, "accept", saved.created_at.toISOString());
  }); } catch (error) { return entryBusy(error); }
}
export async function restoreVolunteerProfile(raw: z.infer<typeof A.volunteerRestoreSchema>, context: VolunteerEntryContext): Promise<VolunteerSessionResult> {
  const input = A.volunteerRestoreSchema.parse(raw), browser = browserHash(context.browserKey), lookup = await resolve(database(), "access", input.token); if (!lookup?.access) throw invalid();
  try { return await database().transaction(async tx => {
    await entryLocks(tx, browser, input.intentId, scopeOf(lookup.invite)); const scope = await contextScope(context, tx, true), row = await invitationById(tx, scopeOf(lookup.invite), lookup.invite.id, true), access = lookup.access!;
    const original = await currentAccess(tx, row, access), exactEntered = context.session?.id === access.session_id;
    if (context.session ? !exactEntered : context.credentialHash !== null) throw switchRequired();
    const authority = await procurementAuthority(original.session, tx, ["volunteer"], true), prior = await priorEntryCommand(tx, original.session, input.intentId, "restore", browser, input);
    if (prior) { if (!exactEntered && input.expectedScope !== scope) throw changed(); if (!prior.encrypted_recovery) throw invalid(); const result = A.volunteerJoinResultSchema.parse(openProcurement(original.session, "volunteer-command-result", `${original.session.actorId}:${input.intentId}`, 1, prior.encrypted_recovery)); await currentAccess(tx, row, access); return { session: original.session, sessionToken: original.sessionToken, result }; }
    if (input.expectedScope !== scope) throw changed();
    const restored = joinResult(original, access, input.intentId, "restore", await dbClock(tx)); await audit(tx, row, original.session, access.membership_version, "restored", { originalDeadline: access.expires_at.toISOString(), sameOriginalSession: true }); await saveEntryCommand(tx, authority, input.intentId, "restore", browser, input, restored.result.receipt, restored.result); await currentAccess(tx, row, access); return restored;
  }); } catch (error) { return entryBusy(error); }
}
export async function validateVolunteerLeave(expectedScope: string, context: VolunteerEntryContext): Promise<void> { await database().transaction(async tx => { const scope = await contextScope(context, tx, true); if (scope !== expectedScope) throw changed(); }); }
