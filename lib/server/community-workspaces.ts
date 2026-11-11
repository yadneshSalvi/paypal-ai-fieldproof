import { randomBytes, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { SqlConnection } from "@fracture/paypal-core";
import { canonicalJson, sha256 } from "@fracture/paypal-core";
import { createWorkspaceSchema, type WorkspaceEntry, type WorkspaceLibrary } from "../community/contracts";
import { communityTemplate, type TemplateId } from "../community/templates";
import { DomainError } from "../domain/money";
import type { PackageView, WorkspaceRole } from "../contracts";
import { type Session, sessionCookieName, sessionCookieSecure, tokenHash } from "./auth";
import { database, initializeDatabase, query } from "./db";
import { openPrivate, sealPrivate } from "./private-values";
import { requireCurrentRole } from "./membership";

interface LibraryRow { id: string; expires_at: Date; }
interface SessionRow { id: string; tenant_id: string; project_id: string; actor_id: string; role: WorkspaceRole; expires_at: Date; mode: Session["mode"]; token_hash: string; }
const sessionView = (row: SessionRow): Session => ({ id: row.id, tenantId: row.tenant_id, projectId: row.project_id, actorId: row.actor_id, role: row.role, expiresAt: row.expires_at.toISOString(), mode: row.mode });
const entryContext = (libraryId: string, sessionId: string) => `workspace-library:${libraryId}:${sessionId}`;
export const workspaceLibraryCookieName = () => `${sessionCookieName()}_library`;

async function authorizedToken(token: string | null, tx: SqlConnection, lock = false): Promise<SessionRow | null> {
  if (!token) return null;
  const [row] = await query<SessionRow>(`SELECT s.*,t.mode FROM fp_sessions s JOIN fp_tenants t ON t.id=s.tenant_id
    JOIN fp_projects p ON p.id=s.project_id AND p.tenant_id=s.tenant_id
    JOIN fp_memberships m ON m.project_id=s.project_id AND m.tenant_id=s.tenant_id AND m.actor_id=s.actor_id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND m.state='active' AND m.roles ? s.role ${lock ? "FOR UPDATE OF s,m" : ""}`, [tokenHash(token)], tx);
  if (!row || !lock) return row ?? null;
  // A row lock may have waited while the original session was expiring.
  // Use the database clock again after acquiring it, including unchanged rows.
  const [current] = await query<{ active: boolean }>("SELECT revoked_at IS NULL AND expires_at>clock_timestamp() AS active FROM fp_sessions WHERE id=$1", [row.id], tx);
  return current?.active ? row : null;
}
async function libraryFor(token: string | null, tx: SqlConnection, lock = true): Promise<LibraryRow | null> {
  if (!token) return null;
  const [row] = await query<LibraryRow>(`SELECT id,expires_at FROM fp_workspace_libraries WHERE token_hash=$1 ${lock ? "FOR UPDATE" : ""}`, [tokenHash(token)], tx);
  if (!row) return null;
  const [current] = await query<{ active: boolean }>("SELECT revoked_at IS NULL AND expires_at>clock_timestamp() AS active FROM fp_workspace_libraries WHERE id=$1", [row.id], tx);
  if (current?.active) return row;
  if (lock) await tx.query("UPDATE fp_workspace_library_entries SET ended_at=COALESCE(ended_at,now()),encrypted_token='' WHERE library_id=$1 AND encrypted_token<>''", [row.id]);
  return null;
}
async function clearEnded(library: LibraryRow, tx: SqlConnection) {
  // Ended entries retain a harmless label/history, never a recoverable capability.
  await tx.query(`UPDATE fp_workspace_library_entries e SET ended_at=COALESCE(e.ended_at,now()),encrypted_token='' WHERE e.library_id=$1 AND e.ended_at IS NULL AND NOT EXISTS(
    SELECT 1 FROM fp_sessions s JOIN fp_memberships m ON m.tenant_id=s.tenant_id AND m.project_id=s.project_id AND m.actor_id=s.actor_id
    WHERE s.id=e.session_id AND s.tenant_id=e.tenant_id AND s.project_id=e.project_id AND s.actor_id=e.actor_id AND s.token_hash=e.token_hash
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND m.state='active' AND m.roles ? s.role)`, [library.id]);
}
async function saveToken(library: LibraryRow, token: string, tx: SqlConnection): Promise<void> {
  const row = await authorizedToken(token, tx, true);
  if (!row) throw new DomainError("WORKSPACE_AUTHORITY_ENDED", "This workspace session has ended. Its existing records remain saved.", 403);
  await tx.query(`INSERT INTO fp_workspace_library_entries(library_id,session_id,tenant_id,project_id,actor_id,encrypted_token,token_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(library_id,session_id) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,token_hash=EXCLUDED.token_hash,ended_at=NULL`,
  [library.id, row.id, row.tenant_id, row.project_id, row.actor_id, sealPrivate(token, entryContext(library.id, row.id)), row.token_hash]);
}
export async function rememberWorkspace(libraryToken: string | null, activeToken: string | null): Promise<{ token: string; expiresAt: string }> {
  await initializeDatabase();
  return database().transaction(async tx => {
    let library = await libraryFor(libraryToken, tx), token = libraryToken;
    if (!library) {
      token = randomBytes(32).toString("base64url"); library = { id: randomUUID(), expires_at: new Date(Date.now() + 24 * 60 * 60_000) };
      await tx.query("INSERT INTO fp_workspace_libraries(id,token_hash,expires_at) VALUES($1,$2,$3)", [library.id, tokenHash(token), library.expires_at]);
    }
    await clearEnded(library, tx);
    if (activeToken && await authorizedToken(activeToken, tx)) await saveToken(library, activeToken, tx);
    return { token: token!, expiresAt: library.expires_at.toISOString() };
  });
}
export async function rememberWorkspaceCookie(activeToken?: string): Promise<void> {
  const jar = await cookies();
  const result = await rememberWorkspace(jar.get(workspaceLibraryCookieName())?.value ?? null, activeToken ?? jar.get(sessionCookieName())?.value ?? null);
  jar.set(workspaceLibraryCookieName(), result.token, { httpOnly: true, secure: sessionCookieSecure(), sameSite: "lax", path: "/", expires: new Date(result.expiresAt) });
}
export async function readWorkspaceLibrary(libraryToken: string | null, activeToken: string | null, cleanup = true): Promise<WorkspaceLibrary> {
  await initializeDatabase();
  return database().transaction(async tx => {
    if (!cleanup) await tx.query("SET TRANSACTION READ ONLY");
    const library = await libraryFor(libraryToken, tx, cleanup), current = await authorizedToken(activeToken, tx);
    if (!library) return { ready: false, currentProjectId: current?.project_id ?? null, entries: [] };
    if (cleanup) await clearEnded(library, tx);
    const rows = await query<SessionRow & { metadata: { title: string; subtitle: string; templateId?: TemplateId }; available: boolean }>(`SELECT s.*,t.mode,p.metadata,
      (e.ended_at IS NULL AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND EXISTS(
        SELECT 1 FROM fp_memberships m WHERE m.tenant_id=s.tenant_id AND m.project_id=s.project_id AND m.actor_id=s.actor_id AND m.state='active' AND m.roles ? s.role)) AS available
      FROM fp_workspace_library_entries e JOIN fp_sessions s ON s.id=e.session_id JOIN fp_projects p ON p.id=e.project_id JOIN fp_tenants t ON t.id=e.tenant_id
      WHERE e.library_id=$1 ORDER BY e.saved_at DESC,s.id`, [library.id], tx);
    const entries: WorkspaceEntry[] = rows.map(row => ({ sessionId: row.id, projectId: row.project_id, title: row.metadata.title, subtitle: row.metadata.subtitle,
      templateId: row.metadata.templateId ?? "makerspace", mode: row.mode, role: row.role, expiresAt: row.expires_at.toISOString(), current: current?.id === row.id, available: row.available }));
    return { ready: true, currentProjectId: current?.project_id ?? null, entries };
  });
}
export async function createCommunityWorkspace(libraryToken: string, activeToken: string | null, raw: unknown): Promise<{ session: Session; token: string }> {
  const input = createWorkspaceSchema.parse(raw), hash = sha256(canonicalJson(input));
  return database().transaction(async tx => {
    const library = await libraryFor(libraryToken, tx);
    if (!library) throw new DomainError("WORKSPACE_LIBRARY_REQUIRED", "Open saved workspaces before creating a new project.", 409);
    await clearEnded(library, tx);
    const current = await authorizedToken(activeToken, tx, true);
    if ((current?.project_id ?? null) !== input.expectedProjectId) throw new DomainError("WORKSPACE_CONTEXT_CHANGED", "Another tab changed the active workspace. Refresh saved workspaces before creating a project.", 409);
    if (activeToken && await authorizedToken(activeToken, tx)) await saveToken(library, activeToken, tx);
    const [prior] = await query<{ input_hash: string; session_id: string }>("SELECT input_hash,session_id FROM fp_workspace_creation_intents WHERE library_id=$1 AND intent_id=$2", [library.id, input.intentId], tx);
    if (prior) {
      if (prior.input_hash !== hash) throw new DomainError("WORKSPACE_INTENT_CHANGED", "This workspace request already describes a different plan.", 409);
      return savedSession(library, prior.session_id, tx);
    }
    const [{ count }] = await query<{ count: string }>("SELECT count(*) FROM fp_workspace_library_entries WHERE library_id=$1", [library.id], tx);
    if (Number(count) >= 24) throw new DomainError("WORKSPACE_LIBRARY_FULL", "This browser already has twenty-four saved workspaces. Return to an existing project.", 429);
    const bucket = `community:${new Date().toISOString().slice(0, 13)}`;
    const claimed = await query("INSERT INTO fp_request_buckets(bucket_key,request_count) VALUES($1,1) ON CONFLICT(bucket_key) DO UPDATE SET request_count=fp_request_buckets.request_count+1 WHERE fp_request_buckets.request_count<200 RETURNING request_count", [bucket], tx);
    if (!claimed.length) throw new DomainError("WORKSPACE_LIMIT", "New sample workspaces are temporarily busy. Your saved workspaces remain available.", 429);
    const template = communityTemplate(input.templateId), tenantId = randomUUID(), projectId = randomUUID(), actorId = randomUUID(), id = randomUUID(), token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 12 * 60 * 60_000).toISOString();
    await tx.query("INSERT INTO fp_tenants(id,mode) VALUES($1,'sample')", [tenantId]);
    await tx.query("INSERT INTO fp_projects(id,tenant_id,slug,metadata) VALUES($1,$2,$3,$4::jsonb)", [projectId, tenantId, `${template.id}-${id.slice(0, 8)}`, JSON.stringify({ title: input.title, subtitle: template.subtitle, organizer: template.organizer, location: template.location, currency: "USD", targetMinor: template.totalMinor, deadline: "2026-12-31T23:59:59Z", templateId: template.id, templateVersion: template.version, templateWorkspace: true })]);
    for (const [order, pkg] of template.packages.entries()) {
      const [x,y,w,h] = pkg.box;
      const data: Omit<PackageView, "version" | "pledgedMinor" | "collectedMinor" | "fundingEligibleMinor" | "shortfallMinor" | "pendingRefundMinor" | "excessLiabilityMinor"> & { order: number } = {
        id: pkg.id, title: pkg.title, shortTitle: pkg.shortTitle, description: pkg.description, budgetMinor: pkg.budgetMinor, fundingState: "open", workState: "planned", evidenceAccepted: 0, evidenceRequired: pkg.requirements.length,
        dependencies: template.dependencies.filter(dep => dep.packageId === pkg.id).map(dep => dep.prerequisiteId), category: pkg.category, icon: pkg.icon, order,
        zone: { packageId: pkg.id, points: [{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}], label: {x:x+w/2,y:y+h/2} },
      };
      await tx.query("INSERT INTO fp_packages(id,project_id,budget_minor,data) VALUES($1,$2,$3,$4::jsonb)", [pkg.id, projectId, pkg.budgetMinor, JSON.stringify(data)]);
    }
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'organizer',$6)", [id, tokenHash(token), tenantId, projectId, actorId, expiresAt]);
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,$4::jsonb)", [tenantId, projectId, actorId, JSON.stringify(["donor", "volunteer", "organizer", "auditor"])]);
    await saveToken(library, token, tx);
    await tx.query("INSERT INTO fp_workspace_creation_intents(library_id,intent_id,input_hash,session_id) VALUES($1,$2,$3,$4)", [library.id, input.intentId, hash, id]);
    await tx.query("INSERT INTO fp_events(id,tenant_id,project_id,type,data) VALUES($1,$2,$3,'community.template_created',$4::jsonb)", [randomUUID(), tenantId, projectId, JSON.stringify({ title: "A new plan, ready for your review", detail: `${template.name} template v1. Fictional source assets and proposed budgets; no payments or completed work.`, provenance: "sample" })]);
    return { session: { id, tenantId, projectId, actorId, role: "organizer", expiresAt, mode: "sample" }, token };
  });
}
async function savedSession(library: LibraryRow, id: string, tx: SqlConnection): Promise<{ session: Session; token: string }> {
  const [entry] = await query<{ encrypted_token: string; token_hash: string }>("SELECT encrypted_token,token_hash FROM fp_workspace_library_entries WHERE library_id=$1 AND session_id=$2 AND ended_at IS NULL FOR UPDATE", [library.id, id], tx);
  if (!entry?.encrypted_token) throw new DomainError("WORKSPACE_AUTHORITY_ENDED", "This saved session has ended. Its project records remain saved; switching cannot renew access.", 403);
  const token = openPrivate<string>(entry.encrypted_token, entryContext(library.id, id));
  const row = tokenHash(token) === entry.token_hash ? await authorizedToken(token, tx, true) : null;
  if (!row || row.id !== id) throw new DomainError("WORKSPACE_AUTHORITY_ENDED", "This saved session no longer has current project access.", 403);
  return { session: sessionView(row), token };
}
export async function switchCommunityWorkspace(libraryToken: string, activeToken: string | null, sessionId: string, expectedProjectId: string | null): Promise<{ session: Session; token: string }> {
  // Ended capabilities are cleared in a committed transaction before any denial.
  await readWorkspaceLibrary(libraryToken, activeToken);
  try { return await database().transaction(async tx => {
    const library = await libraryFor(libraryToken, tx);
    if (!library) throw new DomainError("WORKSPACE_LIBRARY_REQUIRED", "This saved-workspace list has expired. Your project records remain saved.", 403);
    const current = await authorizedToken(activeToken, tx, true);
    if ((current?.project_id ?? null) !== expectedProjectId) throw new DomainError("WORKSPACE_CONTEXT_CHANGED", "Another tab changed the active workspace. Refresh the list before switching.", 409);
    const target = await savedSession(library, sessionId, tx);
    await requireCurrentRole(target.session, target.session.role, tx);
    // Both memberships remain locked; expiry still advances while other locks wait.
    if (current) await requireCurrentRole(sessionView(current), current.role, tx);
    if (!await libraryFor(libraryToken, tx)) throw new DomainError("WORKSPACE_LIBRARY_REQUIRED", "This saved-workspace list expired while switching. Your project records remain saved.", 403);
    await tx.query("INSERT INTO fp_workspace_switch_events(id,library_id,from_session_id,to_session_id) VALUES($1,$2,$3,$4)", [randomUUID(), library.id, current?.id ?? null, target.session.id]);
    return target;
  }); } catch (error) {
    // A revoke can commit after the first cleanup and win the target row lock.
    // Commit capability removal independently of the rejected switch transaction.
    await readWorkspaceLibrary(libraryToken, activeToken);
    throw error;
  }
}
export async function requireMakerspaceScenario(session: Session, tx: SqlConnection = database()): Promise<void> {
  await requireCurrentRole(session, session.role, tx);
  const [row] = await query<{ metadata: { templateId?: string; templateWorkspace?: boolean } }>("SELECT metadata FROM fp_projects WHERE id=$1 AND tenant_id=$2", [session.projectId, session.tenantId], tx);
  if (!row || (row.metadata.templateId && row.metadata.templateId !== "makerspace") || row.metadata.templateWorkspace)
    throw new DomainError("MAKERSPACE_SCENARIO_ONLY", "This action belongs to the separate Eastside demonstration. Use this project's planning, source review and supporter update journeys.", 409);
}
