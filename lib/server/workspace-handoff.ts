import { randomBytes, randomUUID } from "node:crypto";
import type { SqlDatabase } from "@fracture/paypal-core";
import { DomainError } from "../domain/money";
import { tokenHash, type Session } from "./auth";
import { database, query } from "./db";
import { requireCurrentRole, requireMembership } from "./membership";
import { applicationOrigin } from "./payments";
import { appendEvent } from "./repository";

export const HOSTED_ORIGIN = "https://paypal-ai-fieldproof.vercel.app";
export const LOCAL_ORIGIN = "http://localhost:4102";
interface HandoffRow {
  id: string; tenant_id: string; project_id: string; session_id: string; actor_id: string;
  role: Session["role"]; membership_version: number; source_origin: string; target_origin: string;
  expires_at: Date; consumed_at: Date | null; revoked_at: Date | null;
}
export async function prepareWorkspaceHandoff(session: Session) {
  if (applicationOrigin() !== LOCAL_ORIGIN || session.mode !== "live_sandbox") throw new DomainError("HANDOFF_SOURCE_UNAVAILABLE", "This continuation begins in the original local sandbox workspace.", 409);
  const token = randomBytes(32).toString("base64url"), id = randomUUID();
  const expiresAt = new Date(Math.min(Date.parse(session.expiresAt), Date.now() + 60 * 60_000));
  if (expiresAt.getTime() - Date.now() < 5 * 60_000) throw new DomainError("HANDOFF_SESSION_EXPIRING", "The original session is too close to expiry for a secure continuation.", 409);
  await database().transaction(async tx => {
    const membership = await requireCurrentRole(session, "organizer", tx);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`handoff:${session.projectId}`]);
    await tx.query("UPDATE fp_workspace_handoffs SET revoked_at=now() WHERE session_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL", [session.id]);
    await tx.query("INSERT INTO fp_workspace_handoffs(id,tenant_id,project_id,session_id,actor_id,role,membership_version,token_hash,source_origin,target_origin,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [id, session.tenantId, session.projectId, session.id, session.actorId, session.role, membership.membershipVersion, tokenHash(token), LOCAL_ORIGIN, HOSTED_ORIGIN, expiresAt]);
    await appendEvent(tx, session, "workspace.handoff_prepared", "A hosted continuation is ready", "The one-use link preserves this workspace after its private migration. Preparing it does not move funds or change a collection deadline.");
  });
  return { url: `${HOSTED_ORIGIN}/continue#handoff=${token}`, expiresAt: expiresAt.toISOString() };
}
export async function redeemWorkspaceHandoff(token: string, origin = applicationOrigin(), target: SqlDatabase = database()): Promise<{ token: string; session: Session }> {
  if (origin !== HOSTED_ORIGIN || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new DomainError("HANDOFF_INVALID", "This continuation link is not valid here.", 400);
  const nextToken = randomBytes(32).toString("base64url");
  const session = await target.transaction(async tx => {
    const [grant] = await query<HandoffRow>("SELECT * FROM fp_workspace_handoffs WHERE token_hash=$1 FOR UPDATE", [tokenHash(token)], tx);
    if (!grant || grant.source_origin !== LOCAL_ORIGIN || grant.target_origin !== origin || grant.consumed_at || grant.revoked_at || grant.expires_at.getTime() <= Date.now()) throw new DomainError("HANDOFF_UNAVAILABLE", "This continuation is not ready, expired, or has already been used. The original records have not been replaced.", 409);
    const imported = await query("SELECT id FROM fp_workspace_imports WHERE tenant_id=$1 AND project_id=$2 AND handoff_ids ? $3", [grant.tenant_id, grant.project_id, grant.id], tx);
    if (!imported.length) throw new DomainError("HANDOFF_NOT_IMPORTED", "The original workspace has not finished its private transfer. Keep this page open and try again after the transfer is verified.", 409);
    const [row] = await query<{ expires_at: Date; mode: Session["mode"] }>("SELECT s.expires_at,t.mode FROM fp_sessions s JOIN fp_tenants t ON t.id=s.tenant_id WHERE s.id=$1 AND s.tenant_id=$2 AND s.project_id=$3 AND s.actor_id=$4 AND s.role=$5 AND s.revoked_at IS NULL AND s.expires_at>now() FOR UPDATE OF s", [grant.session_id, grant.tenant_id, grant.project_id, grant.actor_id, grant.role], tx);
    if (!row || row.mode !== "live_sandbox") throw new DomainError("HANDOFF_AUTHORITY_CHANGED", "The original participant session no longer allows this continuation.", 403);
    const membership = await requireMembership(grant.tenant_id, grant.project_id, grant.actor_id, grant.role, tx);
    if (membership.version !== grant.membership_version) throw new DomainError("HANDOFF_MEMBERSHIP_CHANGED", "Project access changed after this continuation was prepared.", 403);
    const current: Session = { id: grant.session_id, tenantId: grant.tenant_id, projectId: grant.project_id, actorId: grant.actor_id, role: grant.role, expiresAt: row.expires_at.toISOString(), mode: row.mode };
    await tx.query("UPDATE fp_sessions SET token_hash=$2 WHERE id=$1", [grant.session_id, tokenHash(nextToken)]);
    await tx.query("UPDATE fp_workspace_handoffs SET consumed_at=now() WHERE id=$1", [grant.id]);
    await tx.query("UPDATE fp_workspace_handoffs SET revoked_at=now() WHERE session_id=$1 AND id<>$2 AND consumed_at IS NULL AND revoked_at IS NULL", [grant.session_id, grant.id]);
    await appendEvent(tx, current, "workspace.handoff_completed", "Your original workspace is here", "The same participant, reviewed sources and provider identities were retained. No payment was dispatched and no deadline was extended.");
    return current;
  });
  return { token: nextToken, session };
}
