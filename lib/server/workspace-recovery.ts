import { randomBytes, randomUUID } from "node:crypto";
import type { SqlConnection, SqlDatabase } from "@fracture/paypal-core";
import { DomainError } from "../domain/money";
import { tokenHash, type Session } from "./auth";
import { query } from "./db";
import { requireMembership } from "./membership";
import { executionQuiescence, lockRuntimeControl } from "./runtime-control";
import { HOSTED_ORIGIN, LOCAL_ORIGIN } from "./workspace-handoff";
import { transferManifest, type WorkspaceTransfer } from "./workspace-transfer";

interface Grant {
  id: string; tenant_id: string; project_id: string; session_id: string; actor_id: string;
  role: Session["role"]; membership_version: number; token_hash: string;
  source_origin: string; target_origin: string; expires_at: Date; consumed_at: Date | null; revoked_at: Date | null;
}
export interface RecoveryBinding { grantId: string; expectedTokenHash: string; originalSessionTokenHash: string; }
export interface WorkspaceRecoveryContext { bundle: WorkspaceTransfer; bindings: RecoveryBinding[]; }
const unavailable = () => new DomainError("HANDOFF_RECOVERY_UNAVAILABLE", "This browser cannot recover the original continuation. The existing workspace and its expiry have not changed.", 409);
const sourceRows = (bundle: WorkspaceTransfer, table: string) => bundle.tables.find(value => value.name === table)?.rows ?? [];

async function withFrozenSource<T>(source: SqlDatabase, bundle: WorkspaceTransfer, work: () => Promise<T>): Promise<T> {
  return source.transaction(async tx => {
    await tx.query("SET TRANSACTION READ ONLY");
    await tx.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='15s'");
    await lockRuntimeControl(tx);
    const state = await executionQuiescence(tx);
    if (!state.quiescent || !bundle.sourceExecution.quiescent || state.version !== bundle.sourceExecution.version)
      throw new DomainError("HANDOFF_SOURCE_HOLD_CHANGED", "The original writer's execution hold changed after export. Recovery is paused; do not resume the old workspace.", 409);
    const originalProject = sourceRows(bundle, "fp_projects")[0];
    const [current] = await query<{ projection_version: number }>("SELECT projection_version FROM fp_projects WHERE id=$1 AND tenant_id=$2", [bundle.scope.projectId, bundle.scope.tenantId], tx);
    if (!current || current.projection_version !== originalProject?.projection_version) throw new DomainError("HANDOFF_SOURCE_CHANGED", "The original workspace changed after its frozen export. Recovery requires an operator review.", 409);
    return work();
  });
}
async function requireImportedBundle(tx: SqlConnection, bundle: WorkspaceTransfer): Promise<void> {
  const [imported] = await query<{ bundle_hash: string; handoff_ids: string[]; manifest: { sourceExecution?: { quiescent?: boolean } } }>("SELECT bundle_hash,handoff_ids,manifest FROM fp_workspace_imports WHERE id=$1 AND tenant_id=$2 AND project_id=$3", [bundle.id, bundle.scope.tenantId, bundle.scope.projectId], tx);
  if (!imported || imported.bundle_hash !== transferManifest(bundle).bundleHash || !imported.manifest.sourceExecution?.quiescent)
    throw new DomainError("HANDOFF_IMPORT_UNPROVEN", "The exact frozen workspace has not been confirmed in this destination.", 409);
  const originalGrants = sourceRows(bundle, "fp_workspace_handoffs").filter(row => !row.consumed_at && !row.revoked_at);
  if (!originalGrants.length || originalGrants.some(row => !imported.handoff_ids.includes(String(row.id)))) throw unavailable();
}
function sameOriginalGrant(grant: Grant, bundle: WorkspaceTransfer): boolean {
  const original = sourceRows(bundle, "fp_workspace_handoffs").find(row => row.id === grant.id);
  if (!original || original.consumed_at || original.revoked_at) return false;
  for (const key of ["tenant_id", "project_id", "session_id", "actor_id", "role", "membership_version", "source_origin", "target_origin"] as const)
    if (original[key] !== grant[key]) return false;
  return grant.expires_at.toISOString() === new Date(String(original.expires_at)).toISOString()
    && grant.source_origin === LOCAL_ORIGIN && grant.target_origin === HOSTED_ORIGIN;
}
/** Operator-only bootstrap. It reads both databases; it never initializes or writes the source. */
export async function prepareWorkspaceRecovery(source: SqlDatabase, target: SqlDatabase, bundle: WorkspaceTransfer): Promise<WorkspaceRecoveryContext> {
  return withFrozenSource(source, bundle, async () => target.transaction(async tx => {
    await tx.query("SET TRANSACTION READ ONLY");
    await tx.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='15s'");
    await requireImportedBundle(tx, bundle);
    if (!(await executionQuiescence(tx)).quiescent) throw new DomainError("HANDOFF_TARGET_NOT_HELD", "The imported destination must remain held and drained during recovery.", 409);
    const grants = await query<Grant>("SELECT h.* FROM fp_workspace_handoffs h JOIN fp_workspace_imports i ON i.handoff_ids ? h.id WHERE i.id=$1 AND h.tenant_id=$2 AND h.project_id=$3", [bundle.id, bundle.scope.tenantId, bundle.scope.projectId], tx);
    const bindings = grants.filter(grant => sameOriginalGrant(grant, bundle) && !grant.consumed_at && !grant.revoked_at && grant.expires_at.getTime() > Date.now()).map(grant => {
      const session = sourceRows(bundle, "fp_sessions").find(row => row.id === grant.session_id && row.actor_id === grant.actor_id && row.role === grant.role);
      if (!session || !/^[a-f0-9]{64}$/.test(String(session.token_hash))) throw unavailable();
      return { grantId: grant.id, expectedTokenHash: grant.token_hash, originalSessionTokenHash: String(session.token_hash) };
    });
    if (!bindings.length) throw unavailable();
    return { bundle, bindings };
  }));
}
/** Possession of the original browser cookie is mandatory; there is no actor/session override. */
export async function reissueImportedWorkspaceHandoff(source: SqlDatabase, target: SqlDatabase, context: WorkspaceRecoveryContext, originalCookie: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(originalCookie)) throw unavailable();
  const cookieHash = tokenHash(originalCookie), matches = context.bindings.filter(row => row.originalSessionTokenHash === cookieHash);
  if (matches.length !== 1) throw unavailable();
  const binding = matches[0], bundle = context.bundle;
  return withFrozenSource(source, bundle, async () => target.transaction(async tx => {
    await tx.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='15s'");
    await tx.query("SELECT key FROM fp_runtime_control WHERE key='execution' FOR UPDATE");
    if (!(await executionQuiescence(tx)).quiescent) throw new DomainError("HANDOFF_TARGET_NOT_HELD", "The imported destination must remain held and drained during recovery.", 409);
    await requireImportedBundle(tx, bundle);
    const [grant] = await query<Grant>("SELECT * FROM fp_workspace_handoffs WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR UPDATE", [binding.grantId, bundle.scope.tenantId, bundle.scope.projectId], tx);
    if (!grant || !sameOriginalGrant(grant, bundle) || grant.consumed_at || grant.revoked_at || grant.expires_at.getTime() <= Date.now() || grant.token_hash !== binding.expectedTokenHash) throw unavailable();
    const [session] = await query<{ expires_at: Date; mode: Session["mode"] }>("SELECT s.expires_at,t.mode FROM fp_sessions s JOIN fp_tenants t ON t.id=s.tenant_id WHERE s.id=$1 AND s.tenant_id=$2 AND s.project_id=$3 AND s.actor_id=$4 AND s.role=$5 AND s.token_hash=$6 AND s.revoked_at IS NULL AND s.expires_at>now() FOR UPDATE OF s", [grant.session_id, grant.tenant_id, grant.project_id, grant.actor_id, grant.role, cookieHash], tx);
    const originalSession = sourceRows(bundle, "fp_sessions").find(row => row.id === grant.session_id);
    if (!session || session.mode !== "live_sandbox" || session.expires_at.toISOString() !== new Date(String(originalSession?.expires_at)).toISOString() || grant.expires_at.getTime() > session.expires_at.getTime()) throw unavailable();
    const membership = await requireMembership(grant.tenant_id, grant.project_id, grant.actor_id, grant.role, tx);
    if (membership.version !== grant.membership_version) throw new DomainError("HANDOFF_MEMBERSHIP_CHANGED", "Project access changed after the original continuation was prepared.", 403);
    const token = randomBytes(32).toString("base64url"), eventId = randomUUID();
    await tx.query("UPDATE fp_workspace_handoffs SET token_hash=$2 WHERE id=$1", [grant.id, tokenHash(token)]);
    await tx.query("INSERT INTO fp_events(id,tenant_id,project_id,type,data) VALUES($1,$2,$3,'workspace.handoff_link_reissued',$4::jsonb)", [eventId, grant.tenant_id, grant.project_id, JSON.stringify({ title: "Your original continuation link was recovered", detail: "The browser proved its original session. The same imported grant, participant, access and expiry were retained. No payment was dispatched.", provenance: "live_sandbox", handoffId: grant.id, importBundleId: bundle.id, expiresAt: grant.expires_at.toISOString() })]);
    await tx.query("UPDATE fp_projects SET projection_version=projection_version+1 WHERE id=$1 AND tenant_id=$2", [grant.project_id, grant.tenant_id]);
    await tx.query("INSERT INTO fp_outbox(id,tenant_id,project_id,kind,data,status) VALUES($1,$2,$3,'projection.changed',$4::jsonb,'delivered')", [randomUUID(), grant.tenant_id, grant.project_id, JSON.stringify({ eventId })]);
    return { url: `${HOSTED_ORIGIN}/continue#handoff=${token}`, expiresAt: grant.expires_at.toISOString(), grantId: grant.id };
  }));
}
export function originalWorkspaceCookie(header: string | null): string {
  const values = (header ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith("fieldproof_session="));
  if (values.length !== 1) throw unavailable();
  const token = values[0].slice("fieldproof_session=".length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw unavailable();
  return token;
}
export async function validateRecoveryRequest(request: Request, nonce: string): Promise<string> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.origin !== LOCAL_ORIGIN || url.pathname !== "/continue/recover" || url.search || request.headers.get("host") !== "localhost:4102"
    || request.headers.get("origin") !== LOCAL_ORIGIN || request.headers.get("sec-fetch-site") !== "same-origin" || request.headers.get("sec-fetch-mode") !== "navigate" || request.headers.get("sec-fetch-user") !== "?1"
    || request.headers.get("sec-fetch-dest") !== "document" || request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded")
    throw new DomainError("HANDOFF_RECOVERY_ORIGIN_DENIED", "Continue using the button in the original browser tab.", 403);
  const body = await request.text();
  if (body.length > 256) throw unavailable();
  const fields = new URLSearchParams(body);
  if ([...fields.keys()].length !== 1 || fields.get("nonce") !== nonce || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw unavailable();
  return originalWorkspaceCookie(request.headers.get("cookie"));
}
