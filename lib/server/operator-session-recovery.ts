import { z } from "zod";
import type { SqlDatabase } from "@fracture/paypal-core";
import { DomainError } from "../domain/money";
import { tokenHash, type Session } from "./auth";
import { query } from "./db";

// Administrative recovery is deliberately a local CLI operation. No public
// route accepts a session/actor override or treats an expired cookie as login.
export const operatorSessionIntentSchema = z.object({
  version: z.literal(1), sourceSessionId: z.uuid(), sessionId: z.uuid(),
  tenantId: z.uuid(), projectId: z.uuid(), actorId: z.uuid(),
  role: z.enum(["donor", "volunteer", "organizer", "auditor"]),
  membershipVersion: z.number().int().positive(), originalExpiresAt: z.iso.datetime(),
  preparedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), reason: z.string().min(20).max(500),
}).strict();
export type OperatorSessionIntent = z.infer<typeof operatorSessionIntentSchema>;
type Source = { id: string; tenant_id: string; project_id: string; actor_id: string; role: Session["role"]; mode: Session["mode"]; expires_at: Date; revoked_at: Date | null };
export async function inspectExpiredSession(target: SqlDatabase, sourceSessionId: string) {
  z.uuid().parse(sourceSessionId);
  const [source] = await query<Source>("SELECT s.*,t.mode FROM fp_sessions s JOIN fp_tenants t ON t.id=s.tenant_id WHERE s.id=$1", [sourceSessionId], target);
  if (!source || source.revoked_at || source.expires_at.getTime() > Date.now()) throw new DomainError("RECOVERY_SOURCE_UNAVAILABLE", "Choose an expired, non-revoked session. Active sessions and revoked access cannot be recovered here.", 409);
  const [membership] = await query<{ version: number; roles: string[]; state: string }>("SELECT version,roles,state FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [source.tenant_id, source.project_id, source.actor_id], target);
  if (!membership || membership.state !== "active" || !membership.roles.includes(source.role)) throw new DomainError("MEMBERSHIP_DENIED", "The original role is no longer granted by current membership.", 403);
  return { sourceSessionId: source.id, tenantId: source.tenant_id, projectId: source.project_id, actorId: source.actor_id, role: source.role, membershipVersion: membership.version, originalExpiresAt: source.expires_at.toISOString(), mode: source.mode };
}
/** Requires database-administrator access. Creates a new audited 12-hour
 * session with exactly the old participant/role and current membership. It
 * never updates the old session, a consent, a payable, or a financial deadline. */
export async function recoverExpiredSession(target: SqlDatabase, raw: OperatorSessionIntent): Promise<Session> {
  const intent = operatorSessionIntentSchema.parse(raw), now = Date.now();
  if (intent.sourceSessionId === intent.sessionId || Date.parse(intent.expiresAt) - Date.parse(intent.preparedAt) !== 12 * 60 * 60_000 || Date.parse(intent.preparedAt) > now + 5000)
    throw new DomainError("RECOVERY_INTENT_INVALID", "Recovery uses a separate session and a fixed twelve-hour lifetime.", 422);
  return target.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`session-recovery:${intent.tenantId}:${intent.actorId}`]);
    const [source] = await query<Source>("SELECT s.*,t.mode FROM fp_sessions s JOIN fp_tenants t ON t.id=s.tenant_id WHERE s.id=$1 FOR UPDATE OF s", [intent.sourceSessionId], tx);
    if (!source || source.revoked_at || source.expires_at.getTime() > Date.now() || source.expires_at.toISOString() !== intent.originalExpiresAt
      || source.tenant_id !== intent.tenantId || source.project_id !== intent.projectId || source.actor_id !== intent.actorId || source.role !== intent.role)
      throw new DomainError("RECOVERY_SOURCE_CHANGED", "The original session or its scope changed after the operator review.", 409);
    const [membership] = await query<{ version: number; roles: string[]; state: string }>("SELECT version,roles,state FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 FOR SHARE", [intent.tenantId, intent.projectId, intent.actorId], tx);
    if (!membership || membership.state !== "active" || membership.version !== intent.membershipVersion || !membership.roles.includes(intent.role)) throw new DomainError("MEMBERSHIP_DENIED", "Current membership no longer matches the reviewed recovery.", 403);
    const [prior] = await query<Source & { token_hash: string }>("SELECT * FROM fp_sessions WHERE id=$1", [intent.sessionId], tx);
    if (prior) {
      const audit = await query("SELECT id FROM fp_events WHERE tenant_id=$1 AND project_id=$2 AND type='workspace.operator_session_recovered' AND data->>'sourceSessionId'=$3 AND data->>'recoveredSessionId'=$4", [intent.tenantId, intent.projectId, intent.sourceSessionId, intent.sessionId], tx);
      if (!audit.length || prior.revoked_at || prior.expires_at.getTime() <= Date.now() || prior.token_hash !== tokenHash(intent.token) || prior.expires_at.toISOString() !== intent.expiresAt || prior.tenant_id !== intent.tenantId || prior.project_id !== intent.projectId || prior.actor_id !== intent.actorId || prior.role !== intent.role)
        throw new DomainError("RECOVERY_REPLAY_CHANGED", "This recovery identity cannot be replayed with changed or ended access.", 409);
    } else {
      if (now - Date.parse(intent.preparedAt) > 10 * 60_000 || Date.parse(intent.expiresAt) <= now) throw new DomainError("RECOVERY_INTENT_EXPIRED", "Prepare a fresh operator review before creating the recovery session.", 409);
      const active = await query("SELECT id FROM fp_sessions WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND revoked_at IS NULL AND expires_at>now()", [intent.tenantId, intent.projectId, intent.actorId], tx);
      if (active.length) throw new DomainError("RECOVERY_ACTIVE_SESSION", "This participant already has active access. Recovery must not create a duplicate session.", 409);
      await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [intent.sessionId, tokenHash(intent.token), intent.tenantId, intent.projectId, intent.actorId, intent.role, intent.expiresAt]);
      await tx.query("INSERT INTO fp_events(id,tenant_id,project_id,type,data) VALUES($1,$2,$3,'workspace.operator_session_recovered',$4::jsonb)", [intent.sessionId, intent.tenantId, intent.projectId, JSON.stringify({ title: "Workspace access recovered by the operator", detail: "A new twelve-hour session retains the same participant and role under current membership. Previous sessions, financial approvals, consent windows and payment records were not renewed or replaced.", provenance: source.mode, sourceSessionId: intent.sourceSessionId, recoveredSessionId: intent.sessionId, membershipVersion: intent.membershipVersion, operatorReason: intent.reason, expiresAt: intent.expiresAt })]);
      await tx.query("UPDATE fp_projects SET projection_version=projection_version+1 WHERE id=$1 AND tenant_id=$2", [intent.projectId, intent.tenantId]);
    }
    return { id: intent.sessionId, tenantId: intent.tenantId, projectId: intent.projectId, actorId: intent.actorId, role: intent.role, mode: source.mode, expiresAt: intent.expiresAt };
  });
}
