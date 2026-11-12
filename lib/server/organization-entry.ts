import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ORG_GOVERNANCE_VERSION, orgCreateSchema, orgEntryAcceptSchema, orgEntryRestoreSchema, orgEntryReviewSchema,
  orgEntryViewSchema, orgLibraryActionSchema, orgLibraryOpenSchema, orgLibrarySchema, orgWelcomeResponseSchema,
  type OrgBootstrap, type OrgEntryView, type OrgLibrary, type OrgProfile,
} from "../organizations/contracts";
import { DomainError } from "../domain/money";
import { query } from "./db";
import { openPrivate, sealPrivate } from "./private-values";
import {
  assertOrganizationCurrent, assertOrganizationScope, assertOriginalOrgDeadline, browserHash, findOrgCommand,
  orgHash, orgNow, orgPrivateContext, orgRateLimit, orgToken, orgTokenHash,
  organizationAudit, organizationTransaction, readOrganizationContext, saveOrgCommand,
  type OrgIdentity, type OrgMemberRow, type OrgSessionRow, type OrgTx, type OrganizationCookie,
  type OrganizationRequest, type OrganizationResult,
} from "./organization-core";

export interface OrgInvitationRow {
  id: string; organization_id: string; issuer_membership_id: string; issuer_membership_version: number;
  issuer_session_id: string; issuer_session_expires_at: Date; issuer_browser_hash: string;
  role: OrgProfile["role"]; token_hash: string; encrypted_token: string | null; encrypted_label: string;
  state: "invited" | "joined" | "revoked"; version: number; expires_at: Date; joined_at: Date | null;
  revoked_at: Date | null; revoked_by: string | null; created_at: Date;
}
export interface OrgAccessRow {
  id: string; organization_id: string; membership_id: string; session_id: string; invitation_id: string | null;
  authentication_origin: "creation_capability" | "invitation_possession"; original_browser_hash: string;
  acceptance_intent_id: string; input_hash: string; return_token_hash: string; encrypted_data: string;
  expires_at: Date; created_at: Date;
}
interface AccessData { sessionToken: string; returnToken: string; }
interface LibraryRow { id: string; token_hash: string; expires_at: Date; created_at: Date; }
interface LibraryEntryRow { id: string; library_id: string; organization_id: string; session_id: string; membership_id: string; encrypted_data: string; created_at: Date; }
interface LibraryEntryData { sessionToken: string; organizationName: string; displayName: string; role: OrgProfile["role"]; authenticationOrigin: OrgProfile["authenticationOrigin"]; expiresAt: string; }
interface EntryRecovery { accessId: string; originalCredentialHash: string | null; libraryToken: string; libraryExpiresAt: string; }
interface SwitchRecovery { sessionToken: string | null; sessionExpiresAt: string | null; originalCredentialHash: string | null; libraryToken?: string; libraryExpiresAt?: string; }
const originalCredentialHash = (request: OrganizationRequest) => request.organizationToken === null ? null : orgTokenHash(request.organizationToken);

async function libraryRow(tx: OrgTx, request: OrganizationRequest, lock = false) {
  const [row] = request.libraryToken ? await query<LibraryRow>(`SELECT * FROM fp_org_libraries WHERE token_hash=$1${lock ? " FOR UPDATE" : ""}`, [orgTokenHash(request.libraryToken)], tx) : [];
  return row ?? null;
}
export async function readOrganizationLibrary(tx: OrgTx, request: OrganizationRequest): Promise<OrgLibrary> {
  const library = await libraryRow(tx, request), at = await orgNow(tx), ready = !!library && library.expires_at > at;
  const scope = orgHash({ library: request.libraryToken === null ? null : orgTokenHash(request.libraryToken), id: library?.id ?? null,
    expiresAt: library?.expires_at.toISOString() ?? null, ready });
  const entries: OrgLibrary["entries"] = [];
  if (ready && library) {
    const rows = await query<LibraryEntryRow>("SELECT * FROM fp_org_library_entries WHERE library_id=$1 ORDER BY created_at DESC,id DESC LIMIT 12", [library.id], tx);
    for (const row of rows) {
      const data = openPrivate<LibraryEntryData>(row.encrypted_data, orgPrivateContext("library-entry", row.id));
      const state = await readOrganizationContext(tx, { ...request, organizationToken: data.sessionToken });
      const active = state.identity && state.identity.session.id === row.session_id && state.identity.member.id === row.membership_id;
      entries.push({ id: row.id, organizationId: row.organization_id, organizationName: active ? state.identity!.organization.name : data.organizationName,
        profileLabel: active ? state.identity!.profile.displayName : data.displayName, identityProvenance: "self_declared",
        authenticationOrigin: data.authenticationOrigin, role: active ? state.identity!.member.role : data.role, expiresAt: data.expiresAt,
        current: request.organizationToken !== null && orgTokenHash(data.sessionToken) === orgTokenHash(request.organizationToken),
        available: !!active, unavailableReason: active ? null : "This original profile has ended. Its identity, records and fixed deadline are retained." });
    }
  }
  return orgLibrarySchema.parse({ scope, ready, expiresAt: library?.expires_at.toISOString() ?? null, entries });
}
export async function organizationBootstrap(request: OrganizationRequest): Promise<OrgBootstrap> {
  return organizationTransaction(async tx => {
    const state = await readOrganizationContext(tx, request, "share"), library = await readOrganizationLibrary(tx, request);
    if (state.identity) await assertOrganizationCurrent(tx, request, state.identity);
    return { context: state.context, library };
  });
}
function checkLibraryScope(actual: OrgLibrary, expected: string) {
  if (actual.scope !== expected) throw new DomainError("ORG_LIBRARY_CONTEXT_CHANGED", "This browser's saved organization profiles changed. Refresh the library before continuing.", 409);
}
async function ensureLibrary(tx: OrgTx, request: OrganizationRequest): Promise<{ row: LibraryRow; token: string }> {
  let row = await libraryRow(tx, request, true);
  if (row && row.expires_at > await orgNow(tx)) return { row, token: request.libraryToken! };
  const id = randomUUID(), token = orgToken(), at = await orgNow(tx), expiresAt = new Date(at.getTime() + 168 * 3_600_000);
  [row] = await query<LibraryRow>("INSERT INTO fp_org_libraries(id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4) RETURNING *", [id, orgTokenHash(token), expiresAt, at], tx);
  return { row, token };
}
async function saveToLibrary(tx: OrgTx, library: LibraryRow, identity: OrgIdentity, sessionToken: string) {
  const [known] = await query("SELECT id FROM fp_org_library_entries WHERE library_id=$1 AND session_id=$2", [library.id, identity.session.id], tx);
  if (known) return;
  const [{ count }] = await query<{ count: string }>("SELECT count(*) FROM fp_org_library_entries WHERE library_id=$1", [library.id], tx);
  if (Number(count) >= 12) throw new DomainError("ORG_LIBRARY_FULL", "This browser has retained twelve organization profiles. Keep an original private return link and use a separate browser context for another organization.", 409);
  const id = randomUUID(), data: LibraryEntryData = { sessionToken, organizationName: identity.organization.name,
    displayName: identity.profile.displayName, role: identity.member.role, authenticationOrigin: identity.member.authentication_origin,
    expiresAt: identity.session.expires_at.toISOString() };
  await tx.query("INSERT INTO fp_org_library_entries(id,library_id,organization_id,session_id,membership_id,encrypted_data) VALUES($1,$2,$3,$4,$5,$6)",
    [id, library.id, identity.organization.id, identity.session.id, identity.member.id, sealPrivate(data, orgPrivateContext("library-entry", id))]);
}
async function accessIdentity(tx: OrgTx, request: OrganizationRequest, access: OrgAccessRow): Promise<{ identity: OrgIdentity; data: AccessData }> {
  if (access.expires_at <= await orgNow(tx)) throw new DomainError("ORG_ENTRY_EXPIRED", "This original organization access has passed its fixed deadline.", 410);
  if (access.invitation_id) {
    const [invitation] = await query<OrgInvitationRow>("SELECT * FROM fp_org_invitations WHERE organization_id=$1 AND id=$2", [access.organization_id, access.invitation_id], tx);
    if (!invitation || invitation.state === "revoked") throw new DomainError("ORG_INVITE_REVOKED", "This organization invitation and its original return access were withdrawn.", 410);
    if (invitation.state !== "joined") throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This original organization access is unavailable.", 404);
  }
  const data = openPrivate<AccessData>(access.encrypted_data, orgPrivateContext("access", access.id));
  const state = await readOrganizationContext(tx, { ...request, organizationToken: data.sessionToken }, "share");
  if (!state.identity || state.identity.session.id !== access.session_id || state.identity.member.id !== access.membership_id || state.identity.organization.id !== access.organization_id)
    throw new DomainError("ORG_AUTHORITY_ENDED", "This original organization profile has ended. Its saved history remains retained.", 410);
  return { identity: state.identity, data };
}
async function issueAccess(tx: OrgTx, request: OrganizationRequest, organizationId: string, displayName: string, role: OrgProfile["role"],
  expiresAt: Date, input: { intentId: string }, inputHash: string, invitationId: string | null) {
  const memberId = randomUUID(), sessionId = randomUUID(), accessId = randomUUID(), sessionToken = orgToken(), returnToken = orgToken(), at = await orgNow(tx);
  const origin = invitationId ? "invitation_possession" : "creation_capability";
  await tx.query(`INSERT INTO fp_org_memberships(id,organization_id,role,authentication_origin,encrypted_identity,expires_at,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [memberId, organizationId, role, origin,
    sealPrivate({ displayName, identityProvenance: "self_declared", contractVersion: ORG_GOVERNANCE_VERSION }, orgPrivateContext("member", memberId)), expiresAt, at]);
  await tx.query("INSERT INTO fp_org_sessions(id,organization_id,membership_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6)",
    [sessionId, organizationId, memberId, orgTokenHash(sessionToken), expiresAt, at]);
  const [access] = await query<OrgAccessRow>(`INSERT INTO fp_org_access(id,organization_id,membership_id,session_id,invitation_id,authentication_origin,original_browser_hash,acceptance_intent_id,input_hash,return_token_hash,encrypted_data,expires_at,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [accessId, organizationId, memberId, sessionId, invitationId, origin, browserHash(request), input.intentId, inputHash, orgTokenHash(returnToken),
      sealPrivate({ sessionToken, returnToken }, orgPrivateContext("access", accessId)), expiresAt, at], tx);
  return access;
}
function switchAllowed(request: OrganizationRequest, originalHash: string | null, targetToken: string | null) {
  const current = originalCredentialHash(request);
  if (current !== originalHash && current !== (targetToken === null ? null : orgTokenHash(targetToken)))
    throw new DomainError("ORG_ENTRY_SWITCH_REQUIRED", "A different organization profile is active. Leave it explicitly before recovering this original request.", 409);
}
async function welcomeResult(tx: OrgTx, request: OrganizationRequest, access: OrgAccessRow, receipt: z.infer<typeof orgWelcomeResponseSchema>["receipt"], library: { token: string; expiresAt: string }): Promise<OrganizationResult<z.infer<typeof orgWelcomeResponseSchema>>> {
  const { identity, data } = await accessIdentity(tx, request, access);
  await assertOriginalOrgDeadline(tx, identity);
  const body = orgWelcomeResponseSchema.parse({ receipt, welcome: { profile: identity.profile, identityProvenance: "self_declared" }, returnPath: `/organizations/join#access=${data.returnToken}` });
  return { body, cookies: [{ kind: "session", token: data.sessionToken, expiresAt: identity.profile.sessionExpiresAt }, { kind: "library", token: library.token, expiresAt: library.expiresAt }] };
}
async function recoveredWelcome(tx: OrgTx, request: OrganizationRequest, saved: NonNullable<Awaited<ReturnType<typeof findOrgCommand>>>) {
  if (!saved.encrypted_recovery || saved.browser_hash !== browserHash(request)) throw new DomainError("ORG_BROWSER_CONTEXT_CHANGED", "Recover this original request in its original browser context.", 409);
  const recovery = openPrivate<EntryRecovery>(saved.encrypted_recovery, orgPrivateContext("command", saved.id));
  const [access] = await query<OrgAccessRow>("SELECT * FROM fp_org_access WHERE id=$1", [recovery.accessId], tx);
  if (!access) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "The original private entry is unavailable.", 404);
  const { data } = await accessIdentity(tx, request, access);
  switchAllowed(request, recovery.originalCredentialHash, data.sessionToken);
  return welcomeResult(tx, request, access, saved.result, { token: recovery.libraryToken, expiresAt: recovery.libraryExpiresAt });
}

export async function createOrganization(request: OrganizationRequest, raw: unknown) {
  const input = orgCreateSchema.parse(raw);
  return organizationTransaction(async tx => {
    const actorKey = `browser:${browserHash(request)}`, saved = await findOrgCommand(tx, actorKey, input.intentId, "create", input);
    if (saved) return recoveredWelcome(tx, request, saved);
    const state = await readOrganizationContext(tx, request);
    assertOrganizationScope(state.context.scope, input.expectedScope);
    if (state.context.state !== "none") throw new DomainError(state.context.state === "ended" ? "ORG_CLEAR_ENDED_REQUIRED" : "ORG_ENTRY_SWITCH_REQUIRED", "Leave or clear the current organization profile before creating another one.", 409);
    checkLibraryScope(await readOrganizationLibrary(tx, request), input.expectedLibraryScope);
    const at = await orgNow(tx), hour = at.toISOString().slice(0, 13);
    await orgRateLimit(tx, `create:global:${hour}`, 100);
    await orgRateLimit(tx, `create:${browserHash(request)}:${hour}`, 12);
    const library = await ensureLibrary(tx, request), organizationId = randomUUID(), expiresAt = new Date(at.getTime() + input.expiresHours * 3_600_000);
    await tx.query("INSERT INTO fp_organizations(id,name,description,identity_provenance,created_at,updated_at) VALUES($1,$2,$3,'self_declared',$4,$4)", [organizationId, input.organizationName, input.description, at]);
    const access = await issueAccess(tx, request, organizationId, input.displayName, "owner", expiresAt, input, orgHash(input), null);
    const { identity, data } = await accessIdentity(tx, request, access);
    await saveToLibrary(tx, library.row, identity, data.sessionToken);
    await organizationAudit(tx, organizationId, "organization.created", identity,
      { title: "An organization workspace was created", detail: "The owner name is self-declared. This organization grants no project, payment account or legal ownership authority.", expiresAt: expiresAt.toISOString() },
      { origin: "creation_capability" });
    const recovery: EntryRecovery = { accessId: access.id, originalCredentialHash: null, libraryToken: library.token, libraryExpiresAt: library.row.expires_at.toISOString() };
    const receipt = await saveOrgCommand(tx, actorKey, input, "create", input, { resourceId: organizationId, resourceVersion: 1, message: "Your original organization profile is ready. Keep its private return link." }, { identity, browserHash: browserHash(request), recovery });
    return welcomeResult(tx, request, access, receipt, { token: library.token, expiresAt: library.row.expires_at.toISOString() });
  });
}

/** Accepted memberships are separately managed. Issuer authority gates unused
 * invitations; it does not silently revoke an accepted independent co-owner. */
export async function organizationIssuerCurrent(tx: OrgTx, invitation: OrgInvitationRow, lock = false): Promise<boolean> {
  const suffix = lock ? " FOR SHARE" : "";
  const [member] = await query<OrgMemberRow>(`SELECT * FROM fp_org_memberships WHERE organization_id=$1 AND id=$2${suffix}`, [invitation.organization_id, invitation.issuer_membership_id], tx);
  const [session] = await query<OrgSessionRow>(`SELECT * FROM fp_org_sessions WHERE organization_id=$1 AND membership_id=$2 AND id=$3${suffix}`, [invitation.organization_id, invitation.issuer_membership_id, invitation.issuer_session_id], tx);
  const at = await orgNow(tx);
  return !!member && !!session && member.role === "owner" && member.state === "active" && !member.revoked_at && member.version === invitation.issuer_membership_version && member.expires_at > at && !session.revoked_at && session.expires_at > at && session.expires_at.getTime() === invitation.issuer_session_expires_at.getTime();
}
async function invitationForToken(tx: OrgTx, token: string, lock = false) {
  const [found] = await query<OrgInvitationRow>("SELECT * FROM fp_org_invitations WHERE token_hash=$1", [orgTokenHash(token)], tx);
  if (!found) return null;
  if (lock) await tx.query("SELECT id FROM fp_organizations WHERE id=$1 FOR UPDATE", [found.organization_id]);
  const [row] = await query<OrgInvitationRow>(`SELECT * FROM fp_org_invitations WHERE id=$1${lock ? " FOR UPDATE" : " FOR SHARE"}`, [found.id], tx);
  return row ?? null;
}
export async function reviewOrganizationEntry(request: OrganizationRequest, raw: unknown): Promise<{ entry: OrgEntryView }> {
  const input = orgEntryReviewSchema.parse(raw);
  return organizationTransaction(async tx => {
    const state = await readOrganizationContext(tx, request, "share"), library = await readOrganizationLibrary(tx, request);
    const at = await orgNow(tx);
    await orgRateLimit(tx, `entry:${browserHash(request)}:${at.toISOString().slice(0, 13)}`, 300);
    const result: OrgEntryView = { kind: input.kind, state: "unavailable", scope: state.context.scope, organization: null, role: null, expiresAt: null, recipient: null,
      current: state.identity ? { organizationName: state.identity.organization.name, role: state.identity.member.role, expiresAt: state.identity.profile.sessionExpiresAt } : null,
      canLeave: state.context.state !== "none", canAccept: false, canRestore: false, libraryScope: library.scope };
    if (input.kind === "invite") {
      const row = await invitationForToken(tx, input.token);
      if (row) {
        const issuer = row.issuer_browser_hash === browserHash(request) || state.identity?.member.id === row.issuer_membership_id;
        const [access] = row.joined_at ? await query<OrgAccessRow>("SELECT * FROM fp_org_access WHERE invitation_id=$1", [row.id], tx) : [];
        if (row.state === "revoked") result.state = "revoked";
        else if (row.expires_at <= await orgNow(tx)) result.state = "expired";
        else if (row.state === "joined") {
          if (access && input.intentId === access.acceptance_intent_id && access.original_browser_hash === browserHash(request) && (!request.organizationToken || state.identity?.session.id === access.session_id)) {
            try {
              const current = await accessIdentity(tx, request, access);
              Object.assign(result, { state: "joined_here", organization: { name: current.identity.organization.name, identityProvenance: "self_declared" }, role: current.identity.member.role,
                expiresAt: access.expires_at.toISOString(), recipient: { displayName: current.identity.profile.displayName, identityProvenance: "self_declared" } });
            } catch (error) { if (!(error instanceof DomainError)) throw error; result.state = "unavailable"; }
          } else result.state = "used";
        } else if (!await organizationIssuerCurrent(tx, row, true)) result.state = "authority_changed";
        else if (issuer) {
          result.state = "issuer";
          if (state.identity?.organization.id === row.organization_id) { result.organization = { name: state.identity.organization.name, identityProvenance: "self_declared" }; result.role = row.role; result.expiresAt = row.expires_at.toISOString(); }
        } else if (state.context.state !== "none") result.state = "switch_required";
        else {
          const [organization] = await query<{ name: string }>("SELECT name FROM fp_organizations WHERE id=$1", [row.organization_id], tx);
          Object.assign(result, { state: "ready", organization: { name: organization.name, identityProvenance: "self_declared" }, role: row.role, expiresAt: row.expires_at.toISOString(), canAccept: true });
        }
      }
    } else {
      const [access] = await query<OrgAccessRow>("SELECT * FROM fp_org_access WHERE return_token_hash=$1", [orgTokenHash(input.token)], tx);
      if (access) {
        if (state.context.state !== "none" && state.identity?.session.id !== access.session_id) result.state = "switch_required";
        else {
          try {
            const current = await accessIdentity(tx, request, access);
            Object.assign(result, { state: "ready", organization: { name: current.identity.organization.name, identityProvenance: "self_declared" }, role: current.identity.member.role,
              expiresAt: access.expires_at.toISOString(), recipient: { displayName: current.identity.profile.displayName, identityProvenance: "self_declared" }, canRestore: true });
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            result.state = error.code === "ORG_ENTRY_EXPIRED" ? "expired" : ["ORG_INVITE_REVOKED", "ORG_AUTHORITY_ENDED"].includes(error.code) ? "revoked" : "unavailable";
          }
        }
      }
    }
    if (result.expiresAt && Date.parse(result.expiresAt) <= (await orgNow(tx)).getTime()) Object.assign(result, { state: "expired", organization: null, role: null, expiresAt: null, recipient: null, canAccept: false, canRestore: false });
    if (state.identity) await assertOrganizationCurrent(tx, request, state.identity);
    return { entry: orgEntryViewSchema.parse(result) };
  });
}

export async function acceptOrganizationInvitation(request: OrganizationRequest, raw: unknown) {
  const input = orgEntryAcceptSchema.parse(raw);
  return organizationTransaction(async tx => {
    const actorKey = `browser:${browserHash(request)}`, saved = await findOrgCommand(tx, actorKey, input.intentId, "accept_invitation", input);
    if (saved) return recoveredWelcome(tx, request, saved);
    const state = await readOrganizationContext(tx, request);
    assertOrganizationScope(state.context.scope, input.expectedScope);
    if (state.context.state !== "none") throw new DomainError(state.context.state === "ended" ? "ORG_CLEAR_ENDED_REQUIRED" : "ORG_ENTRY_SWITCH_REQUIRED", "Leave or clear the current organization profile before joining this invitation.", 409);
    const row = await invitationForToken(tx, input.token, true);
    if (!row) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This private invitation is unavailable.", 404);
    if (row.state === "revoked") throw new DomainError("ORG_INVITE_REVOKED", "This invitation was withdrawn.", 410);
    if (row.expires_at <= await orgNow(tx)) throw new DomainError("ORG_ENTRY_EXPIRED", "This invitation passed its original fixed deadline.", 410);
    if (row.state !== "invited") throw new DomainError("ORG_ENTRY_USED", "This invitation has already been accepted. Recover the original acceptance in its original browser.", 409);
    if (row.issuer_browser_hash === browserHash(request)) throw new DomainError("ORG_ROLE_DENIED", "The inviting browser cannot accept its own organization invitation. Share it with the intended independent recipient.", 403);
    if (!await organizationIssuerCurrent(tx, row, true)) throw new DomainError("ORG_ISSUER_CHANGED", "The inviter's original authority changed. Ask a current owner for a new invitation.", 410);
    const library = await ensureLibrary(tx, request);
    const access = await issueAccess(tx, request, row.organization_id, input.displayName, row.role, row.expires_at, input, orgHash(input), row.id);
    await tx.query("UPDATE fp_org_invitations SET state='joined',version=version+1,joined_at=clock_timestamp(),encrypted_token=NULL WHERE id=$1", [row.id]);
    const { identity, data } = await accessIdentity(tx, request, access);
    await saveToLibrary(tx, library.row, identity, data.sessionToken);
    if (!await organizationIssuerCurrent(tx, row, true)) throw new DomainError("ORG_ISSUER_CHANGED", "The inviter's fixed authority ended while this request waited.", 410);
    await organizationAudit(tx, row.organization_id, "organization.invitation_accepted", identity,
      { title: "An invited profile joined", detail: "The recipient chose a self-declared name and accepted the exact fixed role and deadline. No email, person or payment-account ownership was verified.", invitationId: row.id }, { origin: "invitation_possession" });
    const recovery: EntryRecovery = { accessId: access.id, originalCredentialHash: null, libraryToken: library.token, libraryExpiresAt: library.row.expires_at.toISOString() };
    const receipt = await saveOrgCommand(tx, actorKey, input, "accept_invitation", input, { resourceId: access.id, resourceVersion: 1, message: "You joined with the original invitation's role and fixed deadline." }, { identity, browserHash: browserHash(request), recovery });
    return welcomeResult(tx, request, access, receipt, { token: library.token, expiresAt: library.row.expires_at.toISOString() });
  });
}
export async function restoreOrganizationAccess(request: OrganizationRequest, raw: unknown) {
  const input = orgEntryRestoreSchema.parse(raw);
  return organizationTransaction(async tx => {
    const actorKey = `browser:${browserHash(request)}`, saved = await findOrgCommand(tx, actorKey, input.intentId, "restore_profile", input);
    if (saved) return recoveredWelcome(tx, request, saved);
    const state = await readOrganizationContext(tx, request);
    assertOrganizationScope(state.context.scope, input.expectedScope);
    const [access] = await query<OrgAccessRow>("SELECT * FROM fp_org_access WHERE return_token_hash=$1", [orgTokenHash(input.token)], tx);
    if (!access) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This private return access is unavailable.", 404);
    if (state.context.state !== "none" && state.identity?.session.id !== access.session_id) throw new DomainError(state.context.state === "ended" ? "ORG_CLEAR_ENDED_REQUIRED" : "ORG_ENTRY_SWITCH_REQUIRED", "Leave or clear the current organization profile before restoring this original one.", 409);
    const { identity, data } = await accessIdentity(tx, request, access), library = await ensureLibrary(tx, request);
    await saveToLibrary(tx, library.row, identity, data.sessionToken);
    await organizationAudit(tx, identity.organization.id, "organization.profile_restored", identity,
      { title: "An original profile was restored", detail: "The original credential and deadline were retained. No new membership or session was created." });
    const recovery: EntryRecovery = { accessId: access.id, originalCredentialHash: originalCredentialHash(request), libraryToken: library.token, libraryExpiresAt: library.row.expires_at.toISOString() };
    const receipt = await saveOrgCommand(tx, actorKey, input, "restore_profile", input, { resourceId: access.id, resourceVersion: identity.member.version, message: "The original profile is open with its original deadline." }, { identity, browserHash: browserHash(request), recovery });
    return welcomeResult(tx, request, access, receipt, { token: library.token, expiresAt: library.row.expires_at.toISOString() });
  });
}
export async function organizationLibraryAction(request: OrganizationRequest, kind: "remember" | "open_profile" | "leave" | "clear_ended", raw: unknown) {
  const input = kind === "open_profile" ? orgLibraryOpenSchema.parse(raw) : orgLibraryActionSchema.parse(raw);
  return organizationTransaction(async tx => {
    const actorKey = `browser:${browserHash(request)}`, saved = await findOrgCommand(tx, actorKey, input.intentId, kind, input);
    if (saved) {
      if (!saved.encrypted_recovery) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "The original switch receipt is unavailable.", 404);
      const recovery = openPrivate<SwitchRecovery>(saved.encrypted_recovery, orgPrivateContext("command", saved.id));
      switchAllowed(request, recovery.originalCredentialHash, recovery.sessionToken);
      if (recovery.sessionToken) {
        const current = await readOrganizationContext(tx, { ...request, organizationToken: recovery.sessionToken }, "share");
        if (!current.identity) throw new DomainError("ORG_AUTHORITY_ENDED", "This original profile ended; no session was renewed.", 410);
      }
      const cookies: OrganizationCookie[] = [{ kind: "session", token: recovery.sessionToken, expiresAt: recovery.sessionExpiresAt }];
      if (recovery.libraryToken && recovery.libraryExpiresAt) cookies.push({ kind: "library", token: recovery.libraryToken, expiresAt: recovery.libraryExpiresAt });
      return { body: { receipt: saved.result }, cookies };
    }
    const state = await readOrganizationContext(tx, request);
    assertOrganizationScope(state.context.scope, input.expectedScope);
    checkLibraryScope(await readOrganizationLibrary(tx, request), input.expectedLibraryScope);
    let identity = state.identity, sessionToken = request.organizationToken, libraryCookie: { token: string; expiresAt: string } | null = null;
    if (kind === "clear_ended" && state.context.state !== "ended") throw new DomainError("ORG_CONTEXT_CHANGED", "The current profile no longer needs clearing. Refresh its status.", 409);
    if ((kind === "remember" || kind === "open_profile") && state.context.state === "ended") throw new DomainError("ORG_CLEAR_ENDED_REQUIRED", "Clear the ended organization profile first, then open an available saved profile.", 409);
    if (kind === "open_profile") {
      const library = await libraryRow(tx, request, true);
      if (!library || library.expires_at <= await orgNow(tx)) throw new DomainError("ORG_LIBRARY_EXPIRED", "This browser library passed its original deadline. Use an original private return link.", 410);
      const [entry] = await query<LibraryEntryRow>("SELECT * FROM fp_org_library_entries WHERE library_id=$1 AND id=$2", [library.id, (input as z.infer<typeof orgLibraryOpenSchema>).entryId], tx);
      if (!entry) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This saved profile is unavailable in this browser library.", 404);
      const data = openPrivate<LibraryEntryData>(entry.encrypted_data, orgPrivateContext("library-entry", entry.id));
      const target = await readOrganizationContext(tx, { ...request, organizationToken: data.sessionToken }, "share");
      if (!target.identity || target.identity.session.id !== entry.session_id) throw new DomainError("ORG_AUTHORITY_ENDED", "This original saved profile has ended. Its deadline was not renewed.", 410);
      identity = target.identity; sessionToken = data.sessionToken;
      await organizationAudit(tx, identity.organization.id, "organization.saved_profile_opened", identity,
        { title: "An original saved profile was opened", detail: "The saved credential and fixed deadline were retained." });
    } else if (kind === "remember") {
      if (!identity || !sessionToken) throw new DomainError("ORG_AUTH_REQUIRED", "Open a current organization profile before remembering it.", 401);
      const library = await ensureLibrary(tx, request);
      await saveToLibrary(tx, library.row, identity, sessionToken);
      libraryCookie = { token: library.token, expiresAt: library.row.expires_at.toISOString() };
    } else { sessionToken = null; }
    const recovery: SwitchRecovery = { sessionToken, sessionExpiresAt: sessionToken ? identity!.profile.sessionExpiresAt : null,
      originalCredentialHash: originalCredentialHash(request), ...(libraryCookie ? { libraryToken: libraryCookie.token, libraryExpiresAt: libraryCookie.expiresAt } : {}) };
    if (sessionToken && identity) await assertOriginalOrgDeadline(tx, identity);
    const finalContext = await readOrganizationContext(tx, request);
    assertOrganizationScope(finalContext.context.scope, input.expectedScope);
    const receipt = await saveOrgCommand(tx, actorKey, input, kind, input, { resourceId: identity?.member.id ?? null, resourceVersion: identity?.member.version ?? null,
      message: kind === "open_profile" ? "The original saved profile is open with its fixed deadline." : kind === "remember" ? "This original profile is remembered in this browser." : "The browser's active organization access was cleared. Its original records and deadline remain unchanged." },
    { identity: identity ?? undefined, browserHash: browserHash(request), recovery });
    const cookies: OrganizationCookie[] = [{ kind: "session", token: sessionToken, expiresAt: recovery.sessionExpiresAt }];
    if (libraryCookie) cookies.push({ kind: "library", token: libraryCookie.token, expiresAt: libraryCookie.expiresAt });
    return { body: { receipt }, cookies };
  });
}
