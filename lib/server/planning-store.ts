import { randomUUID } from "node:crypto";
import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import type { PlanPackageBinding, PlanSourceBinding, PlanSourceView, PlanValidation, PlanVersionView, ProposedPlan, PublishedPlanView } from "../planning/contracts";
import { proposedPlanSchema } from "../planning/contracts";
import { scaleLabel, validatePlan } from "../planning/geometry";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { database, query } from "./db";
import { requireCurrentRole } from "./membership";
import { documentPrivate, documentView, type DocumentRow } from "./documents";
import { openPrivate, sealPrivate } from "./private-values";

export interface PlanHead { tenant_id: string; project_id: string; version: number; current_plan_id: string | null; publication_id: string | null; }
export interface PlanPayload { plan: ProposedPlan; sources: PlanSourceBinding[]; packages: PlanPackageBinding[]; validation: PlanValidation; }
export interface PlanRow {
  id: string; tenant_id: string; project_id: string; revision: number; author_id: string; origin: PlanVersionView["origin"]; source_run_id: string | null;
  content_hash: string; geometry_hash: string; source_hash: string; package_hash: string; encrypted_data: string; created_at: Date;
}
export interface PlanReviewRow {
  id: string; plan_id: string; tenant_id: string; project_id: string; actor_id: string; membership_version: number;
  decision: "approved" | "needs_changes"; content_hash: string; encrypted_data: string; created_at: Date;
}
export interface PublicationRow { id: string; plan_id: string; review_id: string; state: "active" | "superseded" | "revoked"; content_hash: string; created_at: Date; }
export interface SourceControl { document_id: string; version: number; permission: "allowed" | "withdrawn"; classification: PlanSourceView["classification"]; }
export const planContext = (row: Pick<PlanRow, "id" | "tenant_id" | "project_id">) => `plan:${row.tenant_id}:${row.project_id}:${row.id}`;
export const planReviewContext = (row: Pick<PlanReviewRow, "id" | "tenant_id" | "project_id">) => `plan-review:${row.tenant_id}:${row.project_id}:${row.id}`;
export const planningHash = (value: unknown) => sha256(canonicalJson(value));
export function geometryHash(plan: ProposedPlan): string {
  return planningHash({ outline: plan.outline, walls: plan.walls, openings: plan.openings, scale: plan.scale, zones: plan.zones });
}
export function planPayload(row: PlanRow): PlanPayload {
  const data = openPrivate<PlanPayload>(row.encrypted_data, planContext(row));
  proposedPlanSchema.parse(data.plan);
  if (planningHash({ plan: data.plan, sources: data.sources, packages: data.packages }) !== row.content_hash || geometryHash(data.plan) !== row.geometry_hash || planningHash(data.sources) !== row.source_hash || planningHash(data.packages) !== row.package_hash)
    throw new DomainError("PLAN_INTEGRITY", "This saved plan could not be verified. Its source history has been preserved.", 409);
  return data;
}
export async function lockPlanningAuthority(session: Session, roles: Session["role"][], tx: SqlConnection): Promise<number> {
  if (!roles.includes(session.role)) throw new DomainError("ROLE_DENIED", "Your current view cannot make this planning change.", 403);
  // Serialize against role/membership revocation until this local mutation commits.
  await tx.query("SELECT id FROM fp_sessions WHERE id=$1 FOR SHARE", [session.id]);
  await tx.query("SELECT actor_id FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 FOR SHARE", [session.tenantId, session.projectId, session.actorId]);
  const [tenant] = await query<{ mode: string }>("SELECT t.mode FROM fp_projects p JOIN fp_tenants t ON t.id=p.tenant_id WHERE p.id=$1 AND t.id=$2", [session.projectId, session.tenantId], tx);
  if (!tenant || tenant.mode !== session.mode) throw new DomainError("PROJECT_NOT_FOUND", "This planning authority does not match the current project.", 403);
  return (await requireCurrentRole(session, session.role, tx)).membershipVersion;
}
export async function planningHead(session: Session, tx: SqlConnection = database(), lock = false): Promise<PlanHead> {
  if (lock) await tx.query("INSERT INTO fp_planning_heads(project_id,tenant_id) VALUES($1,$2) ON CONFLICT(project_id) DO NOTHING", [session.projectId, session.tenantId]);
  const [row] = await query<PlanHead>(`SELECT * FROM fp_planning_heads WHERE project_id=$1 AND tenant_id=$2${lock ? " FOR UPDATE" : ""}`, [session.projectId, session.tenantId], tx);
  return row ?? { project_id: session.projectId, tenant_id: session.tenantId, version: 0, current_plan_id: null, publication_id: null };
}
export function expectedHead(head: PlanHead, version: number): void {
  if (head.version !== version) throw new DomainError("PLAN_VERSION_CHANGED", "Someone saved a newer planning change. Your edits remain on screen; compare the latest version before saving.", 409);
}
export async function planningAction<T>(session: Session, intentId: string, kind: string, input: unknown, tx: SqlConnection, work: () => Promise<T>): Promise<T> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`planning:${session.tenantId}:${session.actorId}:${intentId}`]);
  const hash = planningHash(input);
  const [saved] = await query<{ kind: string; input_hash: string; result: T; project_id: string }>("SELECT kind,input_hash,result,project_id FROM fp_planning_actions WHERE tenant_id=$1 AND actor_id=$2 AND intent_id=$3", [session.tenantId, session.actorId, intentId], tx);
  if (saved) {
    if (saved.kind !== kind || saved.project_id !== session.projectId || saved.input_hash !== hash) throw new DomainError("PLANNING_INTENT_CHANGED", "This action was already recorded with different fields. Review the saved result before starting a new action.", 409);
    return saved.result;
  }
  const result = await work();
  await tx.query("INSERT INTO fp_planning_actions(tenant_id,project_id,actor_id,intent_id,kind,input_hash,encrypted_input,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)", [session.tenantId, session.projectId, session.actorId, intentId, kind, hash, sealPrivate(input, `planning-action:${session.tenantId}:${session.projectId}:${session.actorId}:${intentId}`), JSON.stringify(result)]);
  return result;
}
export async function packageBindings(projectId: string, tx: SqlConnection = database(), lock = false): Promise<PlanPackageBinding[]> {
  return (await query<{ id: string; version: number; budget_minor: string; title: string }>(`SELECT id,version,budget_minor,data->>'title' AS title FROM fp_packages WHERE project_id=$1 ORDER BY id${lock ? " FOR SHARE" : ""}`, [projectId], tx))
    .map(p => ({ packageId: p.id, version: p.version, budgetMinor: Number(p.budget_minor), title: p.title }));
}
export async function sourceControl(document: DocumentRow, tx: SqlConnection = database(), create = false, lock = false): Promise<SourceControl> {
  const classification: SourceControl["classification"] = document.purpose === "photo" ? document.provenance === "sample_document" ? "illustration" : "photograph" : document.purpose === "signoff" ? "credential" : "source";
  if (create) await tx.query("INSERT INTO fp_plan_source_controls(document_id,tenant_id,project_id,classification) VALUES($1,$2,$3,$4) ON CONFLICT(document_id) DO NOTHING", [document.id, document.tenant_id, document.project_id, classification]);
  const [control] = await query<SourceControl>(`SELECT document_id,version,permission,classification FROM fp_plan_source_controls WHERE document_id=$1 AND tenant_id=$2 AND project_id=$3${lock ? " FOR SHARE" : ""}`, [document.id, document.tenant_id, document.project_id], tx);
  return control ?? { document_id: document.id, version: 1, permission: "allowed", classification };
}
export async function sourceBindings(session: Pick<Session, "tenantId" | "projectId">, ids: string[], tx: SqlConnection = database(), lock = false): Promise<PlanSourceBinding[]> {
  const result: PlanSourceBinding[] = [];
  for (const id of [...new Set(ids)].sort()) {
    const [document] = await query<DocumentRow>(`SELECT * FROM fp_documents WHERE id=$1 AND tenant_id=$2 AND project_id=$3${lock ? " FOR SHARE" : ""}`, [id, session.tenantId, session.projectId], tx);
    if (!document || document.state !== "ready" || !document.sha256 || !["sketch", "quote", "photo", "signoff"].includes(document.purpose)) throw new DomainError("PLAN_SOURCE_UNAVAILABLE", "A source is missing, not validated, or outside this project.", 409);
    const control = await sourceControl(document, tx, lock, lock);
    if (control.permission !== "allowed") throw new DomainError("SOURCE_PERMISSION_WITHDRAWN", "Permission for this source was withdrawn. Choose a different source and review a new version.", 409);
    const data = documentPrivate(document);
    result.push({ documentId: id, documentVersion: document.version, contentHash: document.sha256, purpose: document.purpose, provenance: document.provenance, controlVersion: control.version,
      pageHashes: data.pages.map(p => p.sha256), pages: data.pages.map(p => ({ number: p.number, width: p.width, height: p.height })) });
  }
  return result;
}
export async function currentSourceCheck(scope: Pick<Session, "tenantId" | "projectId">, bindings: PlanSourceBinding[], tx: SqlConnection, lock = false): Promise<string[]> {
  try {
    const current = await sourceBindings(scope, bindings.map(s => s.documentId), tx, lock);
    return planningHash(current) === planningHash(bindings) ? [] : ["A source or its permission version changed."];
  } catch (error) {
    if (error instanceof DomainError && ["PLAN_SOURCE_UNAVAILABLE", "SOURCE_PERMISSION_WITHDRAWN"].includes(error.code)) return [error.message];
    throw error;
  }
}
export async function requirePlan(session: Pick<Session, "tenantId" | "projectId">, id: string, tx: SqlConnection = database()): Promise<PlanRow> {
  const [row] = await query<PlanRow>("SELECT * FROM fp_plan_versions WHERE id=$1 AND tenant_id=$2 AND project_id=$3", [id, session.tenantId, session.projectId], tx);
  if (!row) throw new DomainError("PLAN_NOT_FOUND", "This plan version is not part of your workspace.", 404);
  return row;
}
export async function planVersionView(row: PlanRow, tx: SqlConnection = database()): Promise<PlanVersionView> {
  const data = planPayload(row);
  const [review] = await query<PlanReviewRow>("SELECT * FROM fp_plan_reviews WHERE plan_id=$1 AND tenant_id=$2", [row.id, row.tenant_id], tx);
  const note = review ? openPrivate<{ note: string }>(review.encrypted_data, planReviewContext(review)).note : null;
  return { id: row.id, revision: row.revision, contentHash: row.content_hash, geometryHash: row.geometry_hash, sourceHash: row.source_hash, packageHash: row.package_hash,
    createdAt: row.created_at.toISOString(), origin: row.origin, sourceRunId: row.source_run_id, plan: data.plan, validation: data.validation, sourceBindings: data.sources, packageBindings: data.packages,
    review: review ? { id: review.id, decision: review.decision, note: note!, reviewedAt: review.created_at.toISOString(), reviewerLabel: "Project organizer" } : null };
}
export async function publishedPlan(scope: Pick<Session, "tenantId" | "projectId">, tx: SqlConnection = database()): Promise<{ view: PublishedPlanView; row: PlanRow; payload: PlanPayload } | null> {
  const [publication] = await query<PublicationRow>(`SELECT p.* FROM fp_planning_heads h JOIN fp_plan_publications p ON p.id=h.publication_id WHERE h.project_id=$1 AND h.tenant_id=$2`, [scope.projectId, scope.tenantId], tx);
  if (!publication) return null;
  const row = await requirePlan(scope, publication.plan_id, tx), payload = planPayload(row);
  const staleReasons = await currentSourceCheck(scope, payload.sources, tx);
  const packages = await packageBindings(scope.projectId, tx);
  if (planningHash(packages) !== row.package_hash) staleReasons.push("The package plan changed after this layout was reviewed.");
  const [review] = await query<{ decision: string; content_hash: string; state: string; version: number; membership_version: number }>(`SELECT r.decision,r.content_hash,m.state,m.version,r.membership_version FROM fp_plan_reviews r
    LEFT JOIN fp_memberships m ON m.tenant_id=r.tenant_id AND m.project_id=r.project_id AND m.actor_id=r.actor_id WHERE r.id=$1`, [publication.review_id], tx);
  if (!review || review.decision !== "approved" || review.content_hash !== row.content_hash) staleReasons.push("The approval no longer matches this plan.");
  // Historical reviews remain facts. Revocation does not erase them, but a revoked
  // reviewer cannot supply current authority for a fresh publication/review.
  const state = publication.state === "revoked" ? "revoked" : staleReasons.length ? "stale" : "current";
  const plan = payload.plan;
  const sourcePage = payload.sources.find(s => s.documentId === plan.sourceDocumentId)?.pages.find(p => p.number === plan.sourcePage);
  return { row, payload, view: { publicationId: publication.id, planId: row.id, revision: row.revision, contentHash: row.content_hash, geometryHash: row.geometry_hash,
    publishedAt: publication.created_at.toISOString(), state, staleReasons, title: plan.title, pageAspectRatio: sourcePage ? sourcePage.width / sourcePage.height : 1, outline: plan.outline, walls: plan.walls,
    openings: plan.openings.map(({ citationId: _citation, ...opening }) => opening),
    zones: plan.zones.filter(z => !!z.packageId).map(z => ({ id: z.id, packageId: z.packageId!, label: z.label, polygon: z.polygon })),
    scaleLabel: scaleLabel(plan), provenance: payload.sources.some(s => s.provenance === "sample_document") ? "sample" : "reviewed_plan",
    packages: plan.packages.map(p => ({ packageId: p.packageId, title: p.title, budgetMinor: p.budgetMinor, capabilities: p.capabilities, requirements: p.requirements })),
    dependencies: plan.dependencies.map(({ citationId: _citation, ...dependency }) => dependency) } };
}
export async function sourcesView(session: Session, tx: SqlConnection = database()): Promise<PlanSourceView[]> {
  if (!["organizer", "volunteer"].includes(session.role)) return [];
  const rows = await query<DocumentRow>(`SELECT * FROM fp_documents WHERE tenant_id=$1 AND project_id=$2 AND purpose IN ('sketch','quote','photo','signoff') AND ($3::boolean OR actor_id=$4) ORDER BY created_at DESC LIMIT 150`, [session.tenantId, session.projectId, session.role === "organizer", session.actorId], tx);
  const sources: PlanSourceView[] = [];
  for (const row of rows) {
    const control = await sourceControl(row, tx);
    sources.push({ ...documentView(row), pages: control.permission === "allowed" ? documentView(row).pages.map(p => ({ ...p, previewUrl: `/api/planning/sources/${row.id}/preview?page=${p.number}` })) : [],
      controlVersion: control.version, permission: control.permission, classification: control.classification, isOwn: row.actor_id === session.actorId });
  }
  return sources;
}
export async function insertPlan(session: Session, head: PlanHead, plan: ProposedPlan, origin: PlanRow["origin"], sourceRunId: string | null, tx: SqlConnection): Promise<PlanRow> {
  const sources = await sourceBindings(session, [plan.sourceDocumentId, ...plan.citations.map(c => c.documentId)], tx, true);
  if (sources.some(s => !["sketch", "quote"].includes(s.purpose))) throw new DomainError("PLAN_SOURCE_KIND", "Plan geometry can use only sketch and quote sources.", 422);
  const packages = await packageBindings(session.projectId, tx, true), validation = validatePlan(plan, sources, packages.map(p => p.packageId));
  const payload: PlanPayload = { plan, sources, packages, validation }, id = randomUUID();
  const context = planContext({ id, tenant_id: session.tenantId, project_id: session.projectId });
  const [row] = await query<PlanRow>(`INSERT INTO fp_plan_versions(id,tenant_id,project_id,revision,author_id,origin,source_run_id,content_hash,geometry_hash,source_hash,package_hash,encrypted_data)
    VALUES($1,$2,$3,(SELECT COALESCE(max(revision),0)+1 FROM fp_plan_versions WHERE project_id=$3),$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [id, session.tenantId, session.projectId, session.actorId, origin, sourceRunId, planningHash({ plan, sources, packages }), geometryHash(plan), planningHash(sources), planningHash(packages), sealPrivate(payload, context)], tx);
  await tx.query("UPDATE fp_planning_heads SET current_plan_id=$3,version=version+1,updated_at=now() WHERE project_id=$1 AND tenant_id=$2 AND version=$4", [session.projectId, session.tenantId, id, head.version]);
  return row;
}
