import type { SqlConnection } from "@fracture/paypal-core";
import type { WorkspaceRole } from "../contracts";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { database, query } from "./db";

export async function requireMembership(tenantId: string, projectId: string, actorId: string, role: WorkspaceRole, tx: SqlConnection = database()): Promise<{ version: number }> {
  const [row] = await query<{ version: number; roles: string[]; state: string }>("SELECT version,roles,state FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [tenantId, projectId, actorId], tx);
  if (!row || row.state !== "active" || !row.roles.includes(role)) throw new DomainError("MEMBERSHIP_DENIED", "Your current project membership does not allow this action.", 403);
  return { version: row.version };
}
export async function requireCurrentRole(session: Session, role: WorkspaceRole, tx: SqlConnection = database()): Promise<{ membershipVersion: number }> {
  if (session.role !== role) throw new DomainError("ROLE_DENIED", `Choose your ${role} view to perform this action.`, 403);
  const rows = await query("SELECT id FROM fp_sessions WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND actor_id=$4 AND role=$5 AND revoked_at IS NULL AND expires_at>now()", [session.id, session.tenantId, session.projectId, session.actorId, role], tx);
  if (!rows.length) throw new DomainError("ROLE_DENIED", "Your current session no longer allows this action.", 403);
  return { membershipVersion: (await requireMembership(session.tenantId, session.projectId, session.actorId, role, tx)).version };
}
