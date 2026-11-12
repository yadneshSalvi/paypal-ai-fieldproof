import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ORG_PAGE_SIZE, orgEventSchema, orgInvitationSchema, orgInviteLinkSchema, orgInviteResponseSchema, orgInviteRevokeSchema,
  orgInviteSchema, orgMemberEndSchema, orgMemberRoleSchema, orgMemberSchema, orgPrivateInvitationSchema, orgUpdateSchema,
  type OrgEvent, type OrgInvitation, type OrgMember,
} from "../organizations/contracts";
import { DomainError } from "../domain/money";
import { query } from "./db";
import { openPrivate, sealPrivate } from "./private-values";
import {
  assertOrganizationCurrent, browserHash, orgCursor, orgMemberIdentity, orgNow, orgPage, orgPrivateContext, orgRateLimit,
  orgToken, orgTokenHash, organizationAudit, organizationCommand, organizationTransaction, requireOrganization,
  type OrgIdentity, type OrgMemberRow, type OrgTx, type OrganizationRequest,
} from "./organization-core";
import { organizationIssuerCurrent, type OrgAccessRow, type OrgInvitationRow } from "./organization-entry";

export async function lastCurrentOwner(tx: OrgTx, member: OrgMemberRow): Promise<boolean> {
  if (member.role !== "owner" || member.state !== "active" || member.expires_at <= await orgNow(tx)) return false;
  const [other] = await query("SELECT id FROM fp_org_memberships WHERE organization_id=$1 AND id<>$2 AND role='owner' AND state='active' AND expires_at>clock_timestamp() LIMIT 1", [member.organization_id, member.id], tx);
  return !other;
}
export async function organizationMemberView(tx: OrgTx, identity: OrgIdentity, row: OrgMemberRow): Promise<OrgMember> {
  const at = await orgNow(tx), state = row.state === "revoked" ? "revoked" : row.expires_at <= at ? "expired" : "active";
  const last = await lastCurrentOwner(tx, row), allowed = identity.member.role === "owner" && state === "active" && !last;
  return orgMemberSchema.parse({ id: row.id, version: row.version, displayName: orgMemberIdentity(row).displayName,
    identityProvenance: "self_declared", authenticationOrigin: row.authentication_origin, role: row.role, state,
    joinedAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), endedAt: row.revoked_at?.toISOString() ?? null,
    isOwn: row.id === identity.member.id, canChangeRole: allowed, canEnd: allowed,
    actionReason: last ? "Keep at least one current owner. Invite and confirm another independent owner before changing this membership." : state !== "active" ? "This original membership has ended; its deadline and history remain unchanged." : identity.member.role !== "owner" ? "A current organization owner manages memberships." : null });
}
export async function organizationMembersPage(tx: OrgTx, identity: OrgIdentity, before?: string) {
  if (identity.member.role !== "owner") throw new DomainError("ORG_ROLE_DENIED", "Only a current organization owner can read the full member roster.", 403);
  const owner = `${identity.organization.id}:members`, cursor = orgCursor(before, owner);
  const rows = await query<OrgMemberRow>(`SELECT * FROM fp_org_memberships WHERE organization_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::text)) ORDER BY created_at DESC,id DESC LIMIT $4`,
    [identity.organization.id, cursor?.at ?? null, cursor?.id ?? null, ORG_PAGE_SIZE + 1], tx);
  const page = orgPage(rows, owner), members: OrgMember[] = [];
  for (const row of page.rows) members.push(await organizationMemberView(tx, identity, row));
  return { members, nextCursor: page.nextCursor };
}
async function invitationView(tx: OrgTx, row: OrgInvitationRow): Promise<OrgInvitation> {
  const at = await orgNow(tx);
  let state: OrgInvitation["state"] = row.state;
  if (state !== "revoked" && row.expires_at <= at) state = "expired";
  if (state === "invited" && !await organizationIssuerCurrent(tx, row)) state = "authority_changed";
  const [member] = row.joined_at ? await query<OrgMemberRow>("SELECT m.* FROM fp_org_memberships m JOIN fp_org_access a ON a.membership_id=m.id AND a.organization_id=m.organization_id WHERE a.invitation_id=$1 AND a.organization_id=$2", [row.id, row.organization_id], tx) : [];
  const canRevoke = row.state !== "revoked" && !(member && await lastCurrentOwner(tx, member));
  return orgInvitationSchema.parse({ id: row.id, version: row.version,
    label: openPrivate<{ label: string }>(row.encrypted_label, orgPrivateContext("invitation-label", row.id)).label,
    role: row.role, state, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(),
    joinedAt: row.joined_at?.toISOString() ?? null, revokedAt: row.revoked_at?.toISOString() ?? null,
    recipient: member ? { displayName: orgMemberIdentity(member).displayName, identityProvenance: "self_declared" } : null,
    canCopy: state === "invited", canRevoke,
    actionReason: !canRevoke && row.state !== "revoked" ? "This invitation belongs to the only current owner. Confirm another independent owner first." : state === "authority_changed" ? "The inviter's original role or membership changed. Create a new invitation with current authority." : state === "expired" ? "The original fixed deadline passed." : null });
}
export async function organizationInvitationsPage(tx: OrgTx, identity: OrgIdentity, before?: string) {
  if (identity.member.role !== "owner") throw new DomainError("ORG_ROLE_DENIED", "Only a current organization owner can read private invitations.", 403);
  const owner = `${identity.organization.id}:invitations`, cursor = orgCursor(before, owner);
  const rows = await query<OrgInvitationRow>(`SELECT * FROM fp_org_invitations WHERE organization_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::text)) ORDER BY created_at DESC,id DESC LIMIT $4`,
    [identity.organization.id, cursor?.at ?? null, cursor?.id ?? null, ORG_PAGE_SIZE + 1], tx);
  const page = orgPage(rows, owner), invitations: OrgInvitation[] = [];
  for (const row of page.rows) invitations.push(await invitationView(tx, row));
  return { invitations, nextCursor: page.nextCursor };
}
async function privateInvitation(tx: OrgTx, identity: OrgIdentity, id: string, expectedVersion?: number) {
  const [row] = await query<OrgInvitationRow>("SELECT * FROM fp_org_invitations WHERE organization_id=$1 AND id=$2 FOR SHARE", [identity.organization.id, id], tx);
  if (!row) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This invitation is unavailable in your current organization.", 404);
  if (expectedVersion !== undefined && row.version !== expectedVersion) throw new DomainError("ORG_VERSION_CHANGED", "This invitation changed. Refresh its state before copying the original link.", 409);
  if (row.state === "revoked") throw new DomainError("ORG_INVITE_REVOKED", "This invitation was withdrawn.", 410);
  if (row.state !== "invited" || !row.encrypted_token) throw new DomainError("ORG_ENTRY_USED", "This original invitation was already accepted. Its owner can inspect the joined state in the member desk.", 409);
  if (row.expires_at <= await orgNow(tx)) throw new DomainError("ORG_ENTRY_EXPIRED", "This invitation passed its original fixed deadline.", 410);
  if (!await organizationIssuerCurrent(tx, row, true)) throw new DomainError("ORG_ISSUER_CHANGED", "The original inviter's authority changed. A current owner can create a new invitation.", 410);
  const token = openPrivate<string>(row.encrypted_token, orgPrivateContext("invitation-token", row.id));
  return orgPrivateInvitationSchema.parse({ id, path: `/organizations/join#invite=${token}`, expiresAt: row.expires_at.toISOString() });
}
export async function createOrganizationInvitation(request: OrganizationRequest, raw: unknown) {
  const input = orgInviteSchema.parse(raw);
  const receipt = await organizationCommand(request, input, "invite", ["owner"], async (tx, identity) => {
    const at = await orgNow(tx);
    await orgRateLimit(tx, `invite:${identity.organization.id}:${at.toISOString().slice(0, 10)}`, 60);
    const expiresAt = new Date(Math.min(at.getTime() + input.expiresHours * 3_600_000, identity.session.expires_at.getTime(), identity.member.expires_at.getTime()));
    if (expiresAt.getTime() - at.getTime() < 60_000) throw new DomainError("ORG_SESSION_EXPIRED", "The original owner access ends too soon to issue another invitation.", 410);
    const id = randomUUID(), token = orgToken();
    await tx.query(`INSERT INTO fp_org_invitations(id,organization_id,issuer_membership_id,issuer_membership_version,issuer_session_id,issuer_session_expires_at,issuer_browser_hash,role,token_hash,encrypted_token,encrypted_label,expires_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id, identity.organization.id, identity.member.id, identity.member.version, identity.session.id,
      identity.session.expires_at, browserHash(request), input.role, orgTokenHash(token), sealPrivate(token, orgPrivateContext("invitation-token", id)),
      sealPrivate({ label: input.label }, orgPrivateContext("invitation-label", id)), expiresAt, at]);
    await organizationAudit(tx, identity.organization.id, "organization.invited", identity, { title: "A private organization invitation is ready",
      detail: "The original role and deadline are fixed. The link can be shared explicitly; no email or message was sent.", invitationId: id, role: input.role, expiresAt: expiresAt.toISOString() });
    return { resourceId: id, resourceVersion: 1, message: "The one-use invitation is ready to copy and share privately." };
  });
  return organizationTransaction(async tx => {
    const identity = await requireOrganization(tx, request, input.expectedScope, ["owner"]), invitation = await privateInvitation(tx, identity, receipt.resourceId!);
    await assertOrganizationCurrent(tx, request, identity);
    return orgInviteResponseSchema.parse({ receipt, invitation });
  });
}
export async function organizationInvitationLink(request: OrganizationRequest, id: string, raw: unknown) {
  const input = orgInviteLinkSchema.parse(raw);
  return organizationTransaction(async tx => {
    const identity = await requireOrganization(tx, request, input.expectedScope, ["owner"]);
    const invitation = await privateInvitation(tx, identity, id, input.expectedVersion);
    await assertOrganizationCurrent(tx, request, identity);
    return { invitation };
  });
}
async function currentMemberForChange(tx: OrgTx, identity: OrgIdentity, id: string, expectedVersion: number) {
  const [member] = await query<OrgMemberRow>("SELECT * FROM fp_org_memberships WHERE organization_id=$1 AND id=$2 FOR UPDATE", [identity.organization.id, id], tx);
  if (!member) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This membership is unavailable in your current organization.", 404);
  if (member.version !== expectedVersion) throw new DomainError("ORG_VERSION_CHANGED", "This membership changed. Review its current role before deciding again.", 409);
  if (member.state !== "active" || member.expires_at <= await orgNow(tx)) throw new DomainError("ORG_AUTHORITY_ENDED", "This original membership ended. Its fixed deadline cannot be extended or revived.", 410);
  return member;
}
async function endMember(tx: OrgTx, member: OrgMemberRow) {
  if (await lastCurrentOwner(tx, member)) throw new DomainError("ORG_LAST_OWNER", "Confirm another independent current owner before ending this membership.", 409);
  await tx.query("UPDATE fp_org_memberships SET state='revoked',version=version+1,revoked_at=clock_timestamp() WHERE id=$1", [member.id]);
  await tx.query("UPDATE fp_org_sessions SET revoked_at=clock_timestamp() WHERE organization_id=$1 AND membership_id=$2 AND revoked_at IS NULL", [member.organization_id, member.id]);
}
export async function changeOrganizationMember(request: OrganizationRequest, id: string, kind: "role" | "end", raw: unknown) {
  const input = kind === "role" ? orgMemberRoleSchema.parse(raw) : orgMemberEndSchema.parse(raw);
  const receipt = await organizationCommand(request, input, kind === "role" ? "change_member_role" : "end_member", ["owner"], async (tx, identity) => {
    const member = await currentMemberForChange(tx, identity, id, input.expectedVersion);
    if (kind === "end") await endMember(tx, member);
    else {
      const role = (input as z.infer<typeof orgMemberRoleSchema>).role;
      if (role === member.role) throw new DomainError("ORG_VERSION_CHANGED", "That role is already current. Refresh this membership before another decision.", 409);
      if (role !== "owner" && await lastCurrentOwner(tx, member)) throw new DomainError("ORG_LAST_OWNER", "Confirm another independent current owner before changing the last owner's role.", 409);
      await tx.query("UPDATE fp_org_memberships SET role=$2,version=version+1 WHERE id=$1", [id, role]);
    }
    await organizationAudit(tx, identity.organization.id, `organization.member_${kind === "end" ? "ended" : "role_changed"}`, identity,
      { title: kind === "end" ? "An organization membership ended" : "An organization role changed", detail: input.reason, memberId: id,
        previousVersion: member.version, previousRole: member.role, originalExpiresAt: member.expires_at.toISOString() });
    return { resourceId: id, resourceVersion: member.version + 1, message: kind === "end" ? "The original membership ended. Its records and deadline were retained." : "The role changed. The original session and deadline were retained.", ownAuthorityChanged: member.id === identity.member.id };
  }, { memberId: id });
  return { receipt };
}
export async function revokeOrganizationInvitation(request: OrganizationRequest, id: string, raw: unknown) {
  const input = orgInviteRevokeSchema.parse(raw);
  const receipt = await organizationCommand(request, input, "revoke_invite", ["owner"], async (tx, identity) => {
    const [row] = await query<OrgInvitationRow>("SELECT * FROM fp_org_invitations WHERE organization_id=$1 AND id=$2 FOR UPDATE", [identity.organization.id, id], tx);
    if (!row) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This invitation is unavailable in your current organization.", 404);
    if (row.version !== input.expectedVersion || row.state === "revoked") throw new DomainError("ORG_VERSION_CHANGED", "This invitation changed. Refresh its original state before another decision.", 409);
    const [access] = await query<OrgAccessRow>("SELECT * FROM fp_org_access WHERE organization_id=$1 AND invitation_id=$2", [identity.organization.id, id], tx);
    if (access) {
      const [member] = await query<OrgMemberRow>("SELECT * FROM fp_org_memberships WHERE organization_id=$1 AND id=$2 FOR UPDATE", [identity.organization.id, access.membership_id], tx);
      if (member?.state === "active") await endMember(tx, member);
    }
    await tx.query("UPDATE fp_org_invitations SET state='revoked',version=version+1,encrypted_token=NULL,revoked_at=clock_timestamp(),revoked_by=$2 WHERE id=$1", [id, identity.member.id]);
    await organizationAudit(tx, identity.organization.id, "organization.invitation_withdrawn", identity,
      { title: "An invitation and its accepted access were withdrawn", detail: input.reason, invitationId: id, originalExpiresAt: row.expires_at.toISOString() });
    return { resourceId: id, resourceVersion: row.version + 1, message: "The invitation and any accepted access were withdrawn. Original records and deadlines remain retained.", ownAuthorityChanged: access?.membership_id === identity.member.id };
  }, { invitationId: id });
  return { receipt };
}
export async function updateOrganization(request: OrganizationRequest, raw: unknown) {
  const input = orgUpdateSchema.parse(raw);
  return { receipt: await organizationCommand(request, input, "update", ["owner"], async (tx, identity) => {
    if (identity.organization.version !== input.expectedVersion) throw new DomainError("ORG_VERSION_CHANGED", "The organization details changed. Refresh them before saving again.", 409);
    await tx.query("UPDATE fp_organizations SET name=$2,description=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1", [identity.organization.id, input.organizationName, input.description]);
    await organizationAudit(tx, identity.organization.id, "organization.details_changed", identity, { title: "Organization details changed", detail: "The self-declared name and description changed. Memberships, project consent and deadlines remain separate." });
    return { resourceId: identity.organization.id, resourceVersion: identity.organization.version + 1, message: "The organization details were saved." };
  }) };
}
export async function organizationEventsPage(tx: OrgTx, identity: OrgIdentity, before?: string) {
  const owner = `${identity.organization.id}:events`, cursor = orgCursor(before, owner);
  const rows = await query<{ id: string; created_at: Date; kind: string; authority_origin: string; role: string | null; encrypted_data: string }>(
    "SELECT * FROM fp_org_audit WHERE organization_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::text)) ORDER BY created_at DESC,id DESC LIMIT $4",
    [identity.organization.id, cursor?.at ?? null, cursor?.id ?? null, ORG_PAGE_SIZE + 1], tx);
  const page = orgPage(rows, owner), events: OrgEvent[] = page.rows.map(row => {
    const value = openPrivate<{ title: string; detail: string }>(row.encrypted_data, orgPrivateContext("audit", row.id));
    return orgEventSchema.parse({ id: row.id, occurredAt: row.created_at.toISOString(), kind: row.kind, title: value.title, detail: value.detail,
      authorityLabel: row.authority_origin === "project_session" ? "Independent project organizer" : row.role === "owner" ? "Organization owner" : row.role === "coordinator" ? "Coordinator" : row.role === "auditor" ? "Organization auditor" : "Original private entry" });
  });
  return { events, nextCursor: page.nextCursor };
}
