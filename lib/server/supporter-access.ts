import { randomBytes, randomUUID } from "node:crypto";
import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import {
  SUPPORTER_ACCESS_VERSION, supporterAcceptSchema, supporterEntrySchema, supporterInviteSchema,
  supporterLinkSchema, supporterRestoreSchema, supporterRevokeSchema,
  type SupporterDesk, type SupporterEntryView, type SupporterInviteState, type SupporterPurpose, type SupporterWelcome,
} from "../supporters/contracts";
import { DomainError } from "../domain/money";
import { tokenHash, type Session } from "./auth";
import { database, initializeDatabase, query } from "./db";
import { requireCurrentRole } from "./membership";
import { openPrivate, sealPrivate } from "./private-values";
import { appendEvent } from "./repository";

interface InviteRow {
  id: string; tenant_id: string; project_id: string; issuer_actor_id: string; issuer_session_id: string;
  issuer_membership_version: number; issuer_browser_hash: string; purpose: SupporterPurpose; role: "donor";
  token_hash: string; encrypted_token: string | null; encrypted_data: string; state: "invited" | "joined" | "revoked";
  version: number; created_at: Date; expires_at: Date; joined_at: Date | null; revoked_at: Date | null;
}
interface AccessRow {
  id: string; invitation_id: string; tenant_id: string; project_id: string; actor_id: string; session_id: string;
  membership_version: number; acceptance_intent_id: string; acceptance_hash: string; browser_hash: string;
  encrypted_identity: string; encrypted_acceptance: string; encrypted_session_token: string;
  recovery_token_hash: string; encrypted_recovery_token: string; created_at: Date; expires_at: Date;
}
interface Identity { displayName: string; identityProvenance: "self_declared"; contractVersion: typeof SUPPORTER_ACCESS_VERSION; }
export interface SupporterEntryContext {
  session: Session | null;
  /** Hash of the actual request cookie, including an ended credential. Never client input. */
  credentialHash: string | null;
  /** Server-set HttpOnly browser secret. Never a fixture identity or a client-selected actor. */
  browserKey: string;
}
interface EntryResult { session: Session; sessionToken: string; recoveryToken: string; welcome: SupporterWelcome; }
const inviteContext = (row: Pick<InviteRow, "tenant_id" | "project_id" | "id">) => `supporter-invite:${row.tenant_id}:${row.project_id}:${row.id}`;
const accessContext = (row: Pick<AccessRow, "tenant_id" | "project_id" | "id">) => `supporter-access:${row.tenant_id}:${row.project_id}:${row.id}`;
const digest = (value: unknown) => sha256(canonicalJson(value));
const browserHash = (value: string) => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new DomainError("SUPPORTER_BROWSER_REQUIRED", "Refresh this invitation before continuing.", 409);
  return tokenHash(value);
};
const unavailable = () => new DomainError("SUPPORTER_ACCESS_UNAVAILABLE", "This private access has ended or is no longer available. Your original project records remain saved.", 410);
const changedContext = () => new DomainError("SUPPORTER_CONTEXT_CHANGED", "This browser’s active workspace changed. Review the invitation again before continuing.", 409);
export function supporterEntryScope(context: SupporterEntryContext): string {
  return digest({ credentialHash: context.credentialHash, sessionId: context.session?.id ?? null, actorId: context.session?.actorId ?? null, projectId: context.session?.projectId ?? null, role: context.session?.role ?? null });
}
async function now(tx: SqlConnection): Promise<Date> { return (await query<{ at: Date }>("SELECT clock_timestamp() AS at", [], tx))[0].at; }
async function lockSession(session: Session, tx: SqlConnection): Promise<number> {
  await tx.query("SELECT id FROM fp_sessions WHERE id=$1 FOR SHARE", [session.id]);
  await tx.query("SELECT actor_id FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 FOR SHARE", [session.tenantId, session.projectId, session.actorId]);
  const [project] = await query<{ mode: Session["mode"] }>("SELECT t.mode FROM fp_projects p JOIN fp_tenants t ON t.id=p.tenant_id WHERE p.id=$1 AND p.tenant_id=$2", [session.projectId, session.tenantId], tx);
  if (!project || project.mode !== session.mode) throw changedContext();
  return (await requireCurrentRole(session, session.role, tx)).membershipVersion;
}
async function organizer(session: Session, expectedScope: string | undefined, tx: SqlConnection): Promise<{ version: number; scope: string }> {
  if (session.role !== "organizer") throw new DomainError("ROLE_DENIED", "Only a current organizer can manage supporter invitations.", 403);
  const version = await lockSession(session, tx);
  const scope = digest({ sessionId: session.id, tenantId: session.tenantId, projectId: session.projectId, actorId: session.actorId, role: session.role, membershipVersion: version });
  if (expectedScope && scope !== expectedScope) throw changedContext();
  return { version, scope };
}
async function validateEntryContext(context: SupporterEntryContext, tx: SqlConnection) {
  browserHash(context.browserKey);
  if (context.session) {
    await lockSession(context.session, tx);
    const [saved] = await query<{token_hash:string}>("SELECT token_hash FROM fp_sessions WHERE id=$1", [context.session.id], tx);
    if (!saved || saved.token_hash !== context.credentialHash) throw changedContext();
  }
}
async function issuerCurrent(row: InviteRow, tx: SqlConnection, lock = false): Promise<boolean> {
  const [member] = await query<{ state: string; version: number; roles: string[] }>(`SELECT state,version,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3${lock ? " FOR SHARE" : ""}`, [row.tenant_id, row.project_id, row.issuer_actor_id], tx);
  return !!member && member.state === "active" && member.version === row.issuer_membership_version && member.roles.includes("organizer");
}
async function projectInfo(row: Pick<InviteRow, "tenant_id" | "project_id">, tx: SqlConnection) {
  const [project] = await query<{ metadata: { title?: string }; mode: Session["mode"] }>("SELECT p.metadata,t.mode FROM fp_projects p JOIN fp_tenants t ON t.id=p.tenant_id WHERE p.id=$1 AND p.tenant_id=$2", [row.project_id, row.tenant_id], tx);
  if (!project) throw unavailable();
  return { title: project.metadata.title ?? "Community project", mode: project.mode };
}
async function audit(tx: SqlConnection, row: InviteRow, kind: "invited" | "accepted" | "revoked" | "restored", session: Session, membershipVersion: number, data: unknown) {
  const id = randomUUID();
  await tx.query("INSERT INTO fp_supporter_access_audit(id,tenant_id,project_id,invitation_id,kind,actor_id,session_id,membership_version,encrypted_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [id, row.tenant_id, row.project_id, row.id, kind, session.actorId, session.id, membershipVersion, sealPrivate(data, `supporter-audit:${row.tenant_id}:${row.project_id}:${id}`)]);
}
async function command<T>(tx: SqlConnection, session: Session, intentId: string, kind: "invite" | "revoke" | "restore", input: unknown, work: () => Promise<T>): Promise<T> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`supporter-command:${session.tenantId}:${session.actorId}:${intentId}`]);
  const inputHash = digest(input);
  const [prior] = await query<{ kind: string; project_id: string; input_hash: string; result: T }>("SELECT kind,project_id,input_hash,result FROM fp_supporter_commands WHERE tenant_id=$1 AND actor_id=$2 AND intent_id=$3", [session.tenantId, session.actorId, intentId], tx);
  if (prior) {
    if (prior.kind !== kind || prior.project_id !== session.projectId || prior.input_hash !== inputHash) throw new DomainError("SUPPORTER_INTENT_CHANGED", "This request already has a different saved result. Review it before starting another action.", 409);
    return prior.result;
  }
  const result = await work();
  await tx.query("INSERT INTO fp_supporter_commands(tenant_id,project_id,actor_id,intent_id,kind,input_hash,encrypted_input,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)", [session.tenantId, session.projectId, session.actorId, intentId, kind, inputHash, sealPrivate(input, `supporter-command:${session.tenantId}:${session.projectId}:${session.actorId}:${intentId}`), JSON.stringify(result)]);
  return result;
}
async function inviteById(id: string, session: Session, tx: SqlConnection, lock = false): Promise<InviteRow> {
  const [row] = await query<InviteRow>(`SELECT * FROM fp_supporter_invites WHERE id=$1 AND tenant_id=$2 AND project_id=$3${lock ? " FOR UPDATE" : ""}`, [id, session.tenantId, session.projectId], tx);
  if (!row) throw new DomainError("SUPPORTER_INVITE_NOT_FOUND", "This invitation is not part of your current project.", 404);
  return row;
}
async function shareable(row: InviteRow, tx: SqlConnection): Promise<string> {
  if (row.state !== "invited" || row.expires_at <= await now(tx) || !row.encrypted_token) throw new DomainError("SUPPORTER_INVITE_UNAVAILABLE", "This invitation was used, withdrawn, or expired. Its original deadline stays unchanged.", 409);
  if (!await issuerCurrent(row, tx, true)) throw new DomainError("SUPPORTER_INVITER_CHANGED", "The inviting organizer’s authority changed. Withdraw this link and create a fresh invitation.", 403);
  if (row.expires_at <= await now(tx)) throw unavailable();
  const token = openPrivate<string>(row.encrypted_token, `${inviteContext(row)}:token`);
  if (tokenHash(token) !== row.token_hash) throw unavailable();
  return token;
}
export async function supporterDesk(session: Session): Promise<SupporterDesk> {
  await initializeDatabase();
  return database().transaction(async tx => {
    const authority = await organizer(session, undefined, tx), project = await projectInfo({ tenant_id: session.tenantId, project_id: session.projectId }, tx);
    // At most 420 invitations remain within a seven-day grant under the rolling
    // sixty-per-day cap. Include every current grant before recent history.
    const rows = await query<InviteRow>("SELECT * FROM fp_supporter_invites WHERE tenant_id=$1 AND project_id=$2 ORDER BY (state<>'revoked' AND expires_at>clock_timestamp()) DESC,created_at DESC,id LIMIT 500", [session.tenantId, session.projectId], tx);
    const observedAt = await now(tx);
    const invitations: SupporterDesk["invitations"] = [];
    for (const row of rows) {
      let state: SupporterInviteState = row.state;
      if (state !== "revoked" && row.expires_at <= observedAt) state = "expired";
      if (state === "invited" && !await issuerCurrent(row, tx)) state = "authority_changed";
      const [access] = row.joined_at ? await query<AccessRow>("SELECT * FROM fp_supporter_access WHERE invitation_id=$1", [row.id], tx) : [];
      const identity = access ? openPrivate<Identity>(access.encrypted_identity, `${accessContext(access)}:identity`) : null;
      invitations.push({ id: row.id, version: row.version, label: openPrivate<{ label: string }>(row.encrypted_data, inviteContext(row)).label, purpose: row.purpose, role: "donor", state,
        createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), joinedAt: row.joined_at?.toISOString() ?? null, revokedAt: row.revoked_at?.toISOString() ?? null,
        recipient: identity ? { displayName: identity.displayName, identityProvenance: "self_declared" } : null, canShare: state === "invited", canRevoke: row.state !== "revoked" });
    }
    await requireCurrentRole(session, "organizer", tx);
    return { projectId: session.projectId, projectTitle: project.title, mode: project.mode, scope: authority.scope, sessionExpiresAt: session.expiresAt, invitations };
  });
}
export async function createSupporterInvite(session: Session, browserKey: string, raw: z.infer<typeof supporterInviteSchema>): Promise<{ id: string; token: string; expiresAt: string }> {
  const input = supporterInviteSchema.parse(raw), issuerBrowserHash = browserHash(browserKey);
  return database().transaction(async tx => {
    const authority = await organizer(session, input.expectedScope, tx);
    const saved = await command(tx, session, input.intentId, "invite", input, async () => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`supporter-invites:${session.projectId}`]);
      const [{ count }] = await query<{ count: string }>("SELECT count(*) FROM fp_supporter_invites WHERE tenant_id=$1 AND project_id=$2 AND created_at>clock_timestamp()-interval '24 hours'", [session.tenantId, session.projectId], tx);
      if (Number(count) >= 60) throw new DomainError("SUPPORTER_INVITE_LIMIT", "This project has created sixty invitations today. You can still manage every existing link.", 429);
      const id = randomUUID(), token = randomBytes(48).toString("base64url"), createdAt = await now(tx);
      const expiresAt = new Date(createdAt.getTime() + input.expiresHours * 60 * 60_000), scope = { id, tenant_id: session.tenantId, project_id: session.projectId };
      const [row] = await query<InviteRow>(`INSERT INTO fp_supporter_invites(id,tenant_id,project_id,issuer_actor_id,issuer_session_id,issuer_membership_version,issuer_browser_hash,purpose,role,token_hash,encrypted_token,encrypted_data,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'donor',$9,$10,$11,$12,$13) RETURNING *`, [id, session.tenantId, session.projectId, session.actorId, session.id, authority.version, issuerBrowserHash, input.purpose, tokenHash(token), sealPrivate(token, `${inviteContext(scope)}:token`), sealPrivate({ label: input.label, contractVersion: SUPPORTER_ACCESS_VERSION }, inviteContext(scope)), createdAt, expiresAt], tx);
      await audit(tx, row, "invited", session, authority.version, { purpose: input.purpose, role: "donor", label: input.label, expiresAt: expiresAt.toISOString(), issuerBrowserHash, contractVersion: SUPPORTER_ACCESS_VERSION });
      await appendEvent(tx, session, "supporter.invited", "A private supporter invitation is ready", "It grants one person donor access to this project until its fixed deadline. Creating the link does not send a message or approve a payment.");
      return { id };
    });
    const row = await inviteById(saved.id, session, tx);
    const token = await shareable(row, tx);
    await requireCurrentRole(session, "organizer", tx);
    return { id: row.id, token, expiresAt: row.expires_at.toISOString() };
  });
}
export async function supporterInviteLink(session: Session, id: string, raw: z.infer<typeof supporterLinkSchema>) {
  const input = supporterLinkSchema.parse(raw);
  return database().transaction(async tx => {
    await organizer(session, input.expectedScope, tx);
    const row = await inviteById(id, session, tx, true);
    if (row.version !== input.expectedVersion) throw new DomainError("SUPPORTER_INVITE_CHANGED", "This invitation changed. Refresh its current status before copying it.", 409);
    const token = await shareable(row, tx);
    await requireCurrentRole(session, "organizer", tx);
    return { id: row.id, token, expiresAt: row.expires_at.toISOString() };
  });
}
export async function revokeSupporterInvite(session: Session, id: string, raw: z.infer<typeof supporterRevokeSchema>): Promise<void> {
  const input = supporterRevokeSchema.parse(raw);
  await database().transaction(async tx => {
    const authority = await organizer(session, input.expectedScope, tx);
    await command(tx, session, input.intentId, "revoke", { id, ...input }, async () => {
      const row = await inviteById(id, session, tx, true);
      if (row.version !== input.expectedVersion || row.state === "revoked") throw new DomainError("SUPPORTER_INVITE_CHANGED", "This invitation changed. Refresh it before withdrawing access.", 409);
      const [access] = await query<AccessRow>("SELECT * FROM fp_supporter_access WHERE invitation_id=$1", [row.id], tx);
      if (access) {
        await tx.query("UPDATE fp_memberships SET state='revoked',version=version+1,revoked_at=clock_timestamp() WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND state='active'", [row.tenant_id, row.project_id, access.actor_id]);
        await tx.query("UPDATE fp_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [row.tenant_id, row.project_id, access.actor_id]);
      }
      await tx.query("UPDATE fp_supporter_invites SET state='revoked',version=version+1,encrypted_token=NULL,revoked_at=clock_timestamp(),revoked_by=$2 WHERE id=$1", [row.id, session.actorId]);
      await audit(tx, row, "revoked", session, authority.version, { previousState: row.state, acceptedActorId: access?.actor_id ?? null, expiresAt: row.expires_at.toISOString() });
      await appendEvent(tx, session, "supporter.access_revoked", "Supporter access was withdrawn", "The invitation and its private return link no longer open this project. Existing contributions, approvals and decision history remain unchanged.");
      return { id };
    });
    await requireCurrentRole(session, "organizer", tx);
  });
}
async function resolveEntry(input: z.infer<typeof supporterEntrySchema>, tx: SqlConnection, lock = false): Promise<{ invitation: InviteRow; access: AccessRow | null } | null> {
  if (input.kind === "access") {
    const [access] = await query<AccessRow>("SELECT * FROM fp_supporter_access WHERE recovery_token_hash=$1", [tokenHash(input.token)], tx);
    if (!access) return null;
    const [invitation] = await query<InviteRow>(`SELECT * FROM fp_supporter_invites WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [access.invitation_id], tx);
    return invitation ? { invitation, access } : null;
  }
  const [invitation] = await query<InviteRow>(`SELECT * FROM fp_supporter_invites WHERE token_hash=$1${lock ? " FOR UPDATE" : ""}`, [tokenHash(input.token)], tx);
  if (!invitation) return null;
  const [access] = await query<AccessRow>("SELECT * FROM fp_supporter_access WHERE invitation_id=$1", [invitation.id], tx);
  return { invitation, access: access ?? null };
}
async function currentEntryLabel(context: SupporterEntryContext, tx: SqlConnection): Promise<SupporterEntryView["current"]> {
  if (!context.session) return null;
  const project = await projectInfo({ tenant_id: context.session.tenantId, project_id: context.session.projectId }, tx);
  return { title: project.title, role: context.session.role, expiresAt: context.session.expiresAt };
}
async function currentAccess(row: InviteRow, access: AccessRow, tx: SqlConnection): Promise<EntryResult> {
  if (row.state !== "joined" || row.expires_at <= await now(tx) || access.expires_at.getTime() !== row.expires_at.getTime() || access.tenant_id !== row.tenant_id || access.project_id !== row.project_id || access.invitation_id !== row.id) throw unavailable();
  const [member] = await query<{ state: string; version: number; roles: string[] }>("SELECT state,version,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 FOR SHARE", [row.tenant_id, row.project_id, access.actor_id], tx);
  const [saved] = await query<{ token_hash: string; role: string; expires_at: Date; revoked_at: Date | null }>("SELECT token_hash,role,expires_at,revoked_at FROM fp_sessions WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND actor_id=$4 FOR SHARE", [access.session_id, row.tenant_id, row.project_id, access.actor_id], tx);
  if (!member || member.state !== "active" || member.version !== access.membership_version || canonicalJson(member.roles) !== '["donor"]' || !saved || saved.revoked_at || saved.role !== "donor" || saved.expires_at.getTime() !== access.expires_at.getTime() || saved.expires_at <= await now(tx)) throw unavailable();
  const sessionToken = openPrivate<string>(access.encrypted_session_token, `${accessContext(access)}:session`), recoveryToken = openPrivate<string>(access.encrypted_recovery_token, `${accessContext(access)}:recovery`);
  if (tokenHash(sessionToken) !== saved.token_hash || tokenHash(recoveryToken) !== access.recovery_token_hash) throw unavailable();
  const identity = openPrivate<Identity>(access.encrypted_identity, `${accessContext(access)}:identity`), project = await projectInfo(row, tx);
  const session: Session = { id: access.session_id, tenantId: row.tenant_id, projectId: row.project_id, actorId: access.actor_id, role: "donor", expiresAt: access.expires_at.toISOString(), mode: project.mode };
  return { session, sessionToken, recoveryToken, welcome: { projectId: row.project_id, projectTitle: project.title, purpose: row.purpose, displayName: identity.displayName, role: "donor", expiresAt: session.expiresAt, identityProvenance: "self_declared" } };
}
export async function reviewSupporterEntry(raw: z.infer<typeof supporterEntrySchema>, context: SupporterEntryContext): Promise<SupporterEntryView> {
  const input = supporterEntrySchema.parse(raw);
  await initializeDatabase();
  return database().transaction(async tx => {
    await validateEntryContext(context, tx);
    const current = await currentEntryLabel(context, tx);
    const view: SupporterEntryView = { kind: input.kind, state: "unavailable", scope: supporterEntryScope(context), project: null, purpose: null, role: "donor", expiresAt: null, current, recipient: null, canLeave: false, canAccept: false, canRestore: false };
    const found = await resolveEntry(input, tx);
    if (!found) return view;
    const { invitation: row, access } = found;
    if (row.state === "revoked") return { ...view, state: "revoked", canLeave: false };
    if (row.expires_at <= await now(tx)) return { ...view, state: "expired", expiresAt: row.expires_at.toISOString(), canLeave: false };
    if (input.kind === "invite" && row.state === "invited" && !await issuerCurrent(row, tx)) return { ...view, state: "authority_changed", canLeave: false };
    if (row.issuer_actor_id === context.session?.actorId || row.issuer_browser_hash === browserHash(context.browserKey)) return { ...view, state: "issuer", canLeave: false };
    if (access && input.kind === "invite" && (access.browser_hash !== browserHash(context.browserKey) || access.acceptance_intent_id !== input.intentId)) return { ...view, state: "used", canLeave: false };
    if (context.session ? context.session.id !== access?.session_id : context.credentialHash !== null) return { ...view, state: "switch_required", canLeave: true };
    const project = await projectInfo(row, tx);
    const available = { ...view, project, purpose: row.purpose, expiresAt: row.expires_at.toISOString(), canLeave: false };
    if (access) {
      try {
        const result = await currentAccess(row, access, tx);
        return { ...available, state: "joined_here", recipient: { displayName: result.welcome.displayName, identityProvenance: "self_declared" }, canRestore: true };
      } catch (error) { if (error instanceof DomainError && error.code === "SUPPORTER_ACCESS_UNAVAILABLE") return { ...view, state: "unavailable", canLeave: false }; throw error; }
    }
    return { ...available, state: "ready", canAccept: input.kind === "invite" };
  });
}
export async function acceptSupporterInvite(raw: z.infer<typeof supporterAcceptSchema>, context: SupporterEntryContext): Promise<EntryResult> {
  const input = supporterAcceptSchema.parse(raw), holderHash = browserHash(context.browserKey);
  const acceptance = { ...input, token: undefined, invitationTokenHash: tokenHash(input.token), browserHash: holderHash };
  return database().transaction(async tx => {
    await validateEntryContext(context, tx);
    const found = await resolveEntry({ kind: "invite", token: input.token, intentId: input.intentId }, tx, true);
    if (!found) throw unavailable();
    const { invitation: row, access } = found;
    if (row.state === "revoked" || row.expires_at <= await now(tx)) throw unavailable();
    if (row.issuer_actor_id === context.session?.actorId || row.issuer_browser_hash === holderHash) throw new DomainError("SUPPORTER_INDEPENDENT_ENTRY", "Share this invitation with the intended supporter. The inviting organizer cannot claim it in their own browser.", 403);
    if (access) {
      if (access.browser_hash !== holderHash || access.acceptance_intent_id !== input.intentId || access.acceptance_hash !== digest(acceptance)) throw new DomainError("SUPPORTER_INVITE_USED", "This one-use invitation has already been accepted. It cannot create another supporter.", 409);
      if (context.session && context.session.id !== access.session_id) throw changedContext();
      if (!context.session && supporterEntryScope(context) !== input.expectedScope) throw changedContext();
      return currentAccess(row, access, tx);
    }
    if (context.session || context.credentialHash !== null) throw new DomainError("SUPPORTER_SWITCH_REQUIRED", "Set your current workspace aside before accepting a separate supporter identity.", 409);
    if (supporterEntryScope(context) !== input.expectedScope) throw changedContext();
    if (row.state !== "invited" || !await issuerCurrent(row, tx, true)) throw new DomainError("SUPPORTER_INVITER_CHANGED", "The inviting organizer’s authority changed. Ask them for a current invitation.", 403);
    // Waiting for a membership lock never extends the invitation's original deadline.
    if (row.expires_at <= await now(tx)) throw unavailable();
    const actorId = randomUUID(), sessionId = randomUUID(), id = randomUUID(), sessionToken = randomBytes(32).toString("base64url"), recoveryToken = randomBytes(48).toString("base64url");
    const scope = { id, tenant_id: row.tenant_id, project_id: row.project_id };
    const identity: Identity = { displayName: input.displayName, identityProvenance: "self_declared", contractVersion: SUPPORTER_ACCESS_VERSION };
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,'[\"donor\"]'::jsonb)", [row.tenant_id, row.project_id, actorId]);
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'donor',$6)", [sessionId, tokenHash(sessionToken), row.tenant_id, row.project_id, actorId, row.expires_at]);
    const [created] = await query<AccessRow>(`INSERT INTO fp_supporter_access(id,invitation_id,tenant_id,project_id,actor_id,session_id,acceptance_intent_id,acceptance_hash,browser_hash,encrypted_identity,encrypted_acceptance,encrypted_session_token,recovery_token_hash,encrypted_recovery_token,identity_provenance,authentication_method,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'self_declared','invitation_possession',$15) RETURNING *`, [id, row.id, row.tenant_id, row.project_id, actorId, sessionId, input.intentId, digest(acceptance), holderHash, sealPrivate(identity, `${accessContext(scope)}:identity`), sealPrivate(acceptance, `${accessContext(scope)}:acceptance`), sealPrivate(sessionToken, `${accessContext(scope)}:session`), tokenHash(recoveryToken), sealPrivate(recoveryToken, `${accessContext(scope)}:recovery`), row.expires_at], tx);
    const [joined] = await query<InviteRow>("UPDATE fp_supporter_invites SET state='joined',version=version+1,joined_at=clock_timestamp(),encrypted_token=NULL WHERE id=$1 RETURNING *", [row.id], tx);
    const result = await currentAccess(joined, created, tx);
    await audit(tx, row, "accepted", result.session, 1, { acceptance, issuerActorId: row.issuer_actor_id, issuerMembershipVersion: row.issuer_membership_version, identityProvenance: "self_declared", authenticationMethod: "invitation_possession", expiresAt: row.expires_at.toISOString() });
    await appendEvent(tx, result.session, "supporter.joined", row.purpose === "sponsor" ? "An invited sponsor joined the project" : "An invited supporter joined the project", "The private link established donor access for a self-declared application identity. Every pledge, sponsor agreement and payment still needs that supporter’s own approval.");
    return currentAccess(joined, created, tx);
  });
}
export async function restoreSupporterAccess(raw: z.infer<typeof supporterRestoreSchema>, context: SupporterEntryContext): Promise<EntryResult> {
  const input = supporterRestoreSchema.parse(raw);
  return database().transaction(async tx => {
    await validateEntryContext(context, tx);
    const found = await resolveEntry({ kind: "access", token: input.token }, tx, true);
    if (!found?.access) throw unavailable();
    const { invitation: row, access } = found;
    if (context.session ? context.session.id !== access.session_id : context.credentialHash !== null) throw changedContext();
    if (row.issuer_actor_id === context.session?.actorId || row.issuer_browser_hash === browserHash(context.browserKey)) throw new DomainError("SUPPORTER_INDEPENDENT_ENTRY", "Use the recipient’s own browser to restore this supporter access.", 403);
    const result = await currentAccess(row, access, tx);
    await command(tx, result.session, input.intentId, "restore", { ...input, token: undefined, recoveryTokenHash: tokenHash(input.token) }, async () => {
      if (supporterEntryScope(context) !== input.expectedScope) throw changedContext();
      await audit(tx, row, "restored", result.session, access.membership_version, { originalSessionId: result.session.id, expiresAt: result.session.expiresAt, browserHash: browserHash(context.browserKey), authenticationMethod: "recipient_return_capability" });
      return { accessId: access.id };
    });
    return currentAccess(row, access, tx);
  });
}
export async function validateSupporterLeave(expectedScope: string, context: SupporterEntryContext): Promise<void> {
  await database().transaction(async tx => {
    await validateEntryContext(context, tx);
    if ((!context.session && context.credentialHash === null) || supporterEntryScope(context) !== expectedScope) throw changedContext();
  });
}
