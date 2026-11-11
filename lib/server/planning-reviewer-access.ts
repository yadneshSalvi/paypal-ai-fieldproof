import { randomBytes, randomUUID } from "node:crypto";
import type { SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import { competencyScopeSchema, reviewerInviteSchema, reviewerInviteRevokeSchema, reviewerRedeemSchema, type CompetencyScope, type ReviewerAccessView } from "../planning/contracts";
import { DomainError } from "../domain/money";
import { tokenHash, type Session } from "./auth";
import { database, query } from "./db";
import { openPrivate, sealPrivate } from "./private-values";
import { lockPlanningAuthority, planningAction } from "./planning-store";
import { appendEvent } from "./repository";

interface InviteData { label: string; scopes: CompetencyScope[]; token: string; }
interface InviteRow { id: string; tenant_id: string; project_id: string; issuer_id: string; issuer_membership_version: number; version: number; token_hash: string; encrypted_data: string; state: "invited" | "joined" | "revoked"; expires_at: Date; actor_id: string | null; session_id: string | null; redemption_nonce_hash: string | null; encrypted_session_token: string | null; joined_at: Date | null; created_at: Date; }
const context = (row: Pick<InviteRow, "id" | "tenant_id" | "project_id">) => `reviewer-invite:${row.tenant_id}:${row.project_id}:${row.id}`;
export async function permittedReviewerScopes(session: Session, tx: SqlConnection = database()): Promise<CompetencyScope[]> {
  const rows = await query<InviteRow>("SELECT * FROM fp_reviewer_invites WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND state='joined'", [session.tenantId, session.projectId, session.actorId], tx);
  if (!rows.length) return competencyScopeSchema.options;
  return [...new Set(rows.flatMap(row => openPrivate<InviteData>(row.encrypted_data, context(row)).scopes))];
}
export async function reviewerAccessViews(session: Session, tx: SqlConnection = database()): Promise<ReviewerAccessView[]> {
  if (session.role !== "organizer") return [];
  return (await query<InviteRow>("SELECT * FROM fp_reviewer_invites WHERE tenant_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 100", [session.tenantId, session.projectId], tx)).map(row => {
    const data = openPrivate<InviteData>(row.encrypted_data, context(row));
    return { id: row.id, version: row.version, label: data.label, scopes: data.scopes, state: row.state === "invited" && row.expires_at.getTime() <= Date.now() ? "expired" : row.state, expiresAt: row.expires_at.toISOString(), joinedAt: row.joined_at?.toISOString() ?? null, createdAt: row.created_at.toISOString() };
  });
}
export async function createReviewerInvite(session: Session, raw: z.infer<typeof reviewerInviteSchema>): Promise<{ id: string; token: string; expiresAt: string }> {
  const input = reviewerInviteSchema.parse(raw);
  return database().transaction(async tx => {
    const version = await lockPlanningAuthority(session, ["organizer"], tx);
    const result = await planningAction(session, input.intentId, "reviewer-invite", input, tx, async () => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`planning-invites:${session.projectId}`]);
      const [count] = await query<{ count: string }>("SELECT count(*) AS count FROM fp_reviewer_invites WHERE project_id=$1 AND created_at>now()-interval '24 hours'", [session.projectId], tx);
      if (Number(count.count) >= 30) throw new DomainError("REVIEWER_INVITE_LIMIT", "This project has reached its daily reviewer-link limit. Existing invitations remain available.", 429);
      const id = randomUUID(), token = randomBytes(48).toString("base64url"), data: InviteData = { label: input.label, scopes: [...new Set(input.scopes)].sort(), token };
      await tx.query("INSERT INTO fp_reviewer_invites(id,tenant_id,project_id,issuer_id,issuer_membership_version,token_hash,encrypted_data,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8::integer*interval '1 hour')", [id, session.tenantId, session.projectId, session.actorId, version, tokenHash(token), sealPrivate(data, context({ id, tenant_id: session.tenantId, project_id: session.projectId })), input.expiresHours]);
      await appendEvent(tx, session, "planning.reviewer_invited", "A private reviewer link was created", "The link grants only a temporary volunteer session in this project. Each named competence still needs a separate credential review.");
      return { id };
    });
    const [row] = await query<InviteRow>("SELECT * FROM fp_reviewer_invites WHERE id=$1 AND tenant_id=$2 AND project_id=$3", [result.id, session.tenantId, session.projectId], tx);
    if (row.state !== "invited" || row.expires_at.getTime() <= Date.now()) throw new DomainError("REVIEWER_INVITE_UNAVAILABLE", "This link was already used, withdrawn or expired. Its history remains recorded.", 409);
    return { id: row.id, token: openPrivate<InviteData>(row.encrypted_data, context(row)).token, expiresAt: row.expires_at.toISOString() };
  });
}
export async function redeemReviewerInvite(raw: z.infer<typeof reviewerRedeemSchema>, current: Session | null): Promise<{ session: Session; sessionToken: string }> {
  const input = reviewerRedeemSchema.parse(raw), hash = tokenHash(input.token), nonceHash = tokenHash(input.redemptionNonce);
  return database().transaction(async tx => {
    const [row] = await query<InviteRow>("SELECT * FROM fp_reviewer_invites WHERE token_hash=$1 FOR UPDATE", [hash], tx);
    if (!row || row.state === "revoked" || row.expires_at.getTime() <= Date.now()) throw new DomainError("REVIEWER_INVITE_UNAVAILABLE", "This reviewer link has expired or is no longer available. Ask the organizer for a current link.", 404);
    if (current?.actorId === row.issuer_id) throw new DomainError("INDEPENDENT_REVIEWER_REQUIRED", "Open this link in the invited reviewer's separate browser session. The organizer cannot use their own invitation to verify themselves.", 403);
    const [issuer] = await query<{ version: number; state: string; roles: string[] }>("SELECT version,state,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 FOR SHARE", [row.tenant_id, row.project_id, row.issuer_id], tx);
    if (!issuer || issuer.state !== "active" || issuer.version !== row.issuer_membership_version || !issuer.roles.includes("organizer")) throw new DomainError("REVIEWER_INVITE_AUTHORITY", "The organizer's authority changed after this invitation. Request a new link.", 403);
    const [tenant] = await query<{ mode: Session["mode"] }>("SELECT mode FROM fp_tenants WHERE id=$1", [row.tenant_id], tx);
    if (row.state === "joined") {
      if (!row.joined_at || row.joined_at.getTime() < Date.now() - 2 * 60_000 || row.redemption_nonce_hash !== nonceHash || !row.encrypted_session_token || !row.session_id) throw new DomainError("REVIEWER_INVITE_USED", "This single-use link has already been claimed.", 409);
      const [saved] = await query<{ expires_at: Date }>("SELECT expires_at FROM fp_sessions WHERE id=$1 AND revoked_at IS NULL AND expires_at>now()", [row.session_id], tx);
      if (!saved) throw new DomainError("REVIEWER_INVITE_USED", "The temporary reviewer session is no longer available.", 409);
      return { session: { id: row.session_id, tenantId: row.tenant_id, projectId: row.project_id, actorId: row.actor_id!, role: "volunteer", expiresAt: saved.expires_at.toISOString(), mode: tenant.mode }, sessionToken: openPrivate<{ token: string }>(row.encrypted_session_token, `${context(row)}:session`).token };
    }
    const actorId = randomUUID(), id = randomUUID(), sessionToken = randomBytes(32).toString("base64url"), expiresAt = new Date(Date.now() + 12 * 60 * 60_000).toISOString();
    const session: Session = { id, tenantId: row.tenant_id, projectId: row.project_id, actorId, role: "volunteer", expiresAt, mode: tenant.mode };
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,$4::jsonb)", [row.tenant_id, row.project_id, actorId, JSON.stringify(["volunteer"])]);
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'volunteer',$6)", [id, tokenHash(sessionToken), row.tenant_id, row.project_id, actorId, expiresAt]);
    await tx.query("UPDATE fp_reviewer_invites SET state='joined',version=version+1,actor_id=$2,session_id=$3,redemption_nonce_hash=$4,encrypted_session_token=$5,joined_at=now() WHERE id=$1", [row.id, actorId, id, nonceHash, sealPrivate({ token: sessionToken }, `${context(row)}:session`)]);
    await appendEvent(tx, session, "planning.reviewer_joined", "An invited reviewer joined the project", "The temporary session can submit private sources and request the invited scopes. It does not grant organizer or financial approval authority.");
    return { session, sessionToken };
  });
}
export async function revokeReviewerInvite(session: Session, id: string, raw: z.infer<typeof reviewerInviteRevokeSchema>): Promise<void> {
  const input = reviewerInviteRevokeSchema.parse(raw);
  await database().transaction(async tx => {
    await lockPlanningAuthority(session, ["organizer"], tx);
    await planningAction(session, input.intentId, "reviewer-access-revoke", { id, ...input }, tx, async () => {
      const [row] = await query<InviteRow>("SELECT * FROM fp_reviewer_invites WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR UPDATE", [id, session.tenantId, session.projectId], tx);
      if (!row || row.version !== input.expectedVersion) throw new DomainError("REVIEWER_ACCESS_CHANGED", "Refresh this reviewer link before withdrawing its access.", 409);
      await tx.query("UPDATE fp_reviewer_invites SET state='revoked',version=version+1,encrypted_session_token=NULL WHERE id=$1", [id]);
      if (row.actor_id) {
        await tx.query("UPDATE fp_memberships SET state='revoked',version=version+1,revoked_at=now() WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [session.tenantId, session.projectId, row.actor_id]);
        await tx.query("UPDATE fp_sessions SET revoked_at=now() WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [session.tenantId, session.projectId, row.actor_id]);
      }
      await appendEvent(tx, session, "planning.reviewer_access_revoked", "A reviewer's project access was withdrawn", "The invitation and temporary sessions no longer grant access. Dependent credentials and physical sign-offs must be checked again.");
      return { id };
    });
  });
}
