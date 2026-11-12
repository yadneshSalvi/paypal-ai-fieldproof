import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import * as C from "../procurement/contracts";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { database, query } from "./db";
import { openPrivate, sealPrivate } from "./private-values";
import { appendEvent } from "./repository";
import { projectClaimLock } from "./claims";
import { lockFundingScope } from "./funding-positions";
import { projectPolicyLock } from "./project-policy";

export type ProcurementScope = Pick<Session, "tenantId" | "projectId">;
export interface ProcurementAuthority { session: Session; membershipVersion: number; scope: string; }
export const scopeValues = (scope: ProcurementScope) => [scope.tenantId, scope.projectId];
export const procurementHash = (value: unknown) => sha256(canonicalJson(value));
export const procurementPrivateContext = (scope: ProcurementScope, kind: string, id: string, version = 1) => `procurement:${scope.tenantId}:${scope.projectId}:${kind}:${id}:${version}`;
export function sealProcurement(scope: ProcurementScope, kind: string, id: string, version: number, value: unknown) { return sealPrivate(value, procurementPrivateContext(scope, kind, id, version)); }
export function openProcurement<T>(scope: ProcurementScope, kind: string, id: string, version: number, encrypted: string): T { return openPrivate<T>(encrypted, procurementPrivateContext(scope, kind, id, version)); }
export function integrity(value: unknown, expectedHash: string) { if (procurementHash(value) !== expectedHash) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "This retained procurement record could not be verified. Its original history remains saved.", 409); }
export async function dbClock(tx: SqlConnection): Promise<string> { return (await query<{ at: Date }>("SELECT clock_timestamp() AS at", [], tx))[0].at.toISOString(); }
export async function procurementProject(scope: ProcurementScope, tx: SqlConnection): Promise<C.ProcurementProject & { createdAt: string }> {
  const [row] = await query<{ id: string; metadata: Record<string, unknown>; mode: "sample" | "live_sandbox"; created_at: Date }>("SELECT p.id,p.metadata,p.created_at,t.mode FROM fp_projects p JOIN fp_tenants t ON t.id=p.tenant_id WHERE p.id=$2 AND p.tenant_id=$1", scopeValues(scope), tx);
  if (!row) throw new DomainError("PROCUREMENT_NOT_FOUND", "This project is unavailable in the current profile.", 404);
  return { ...C.procurementProjectSchema.parse({ id: row.id, title: row.metadata.title, templateId: row.metadata.templateId ?? "makerspace", mode: row.mode, currency: row.metadata.currency ?? "USD" }), createdAt: row.created_at.toISOString() };
}
/** Authority is a real stored session+membership, not a caller-selected role.
 * The lock order is session then membership. Recheck its clock after waits. */
export async function procurementAuthority(session: Session, tx: SqlConnection = database(), roles: C.ProcurementRole[] = ["organizer", "volunteer", "auditor"], lock = false): Promise<ProcurementAuthority> {
  if (!roles.includes(session.role)) throw new DomainError("PROCUREMENT_ROLE_DENIED", "This current project role cannot perform that procurement action.", 403);
  const [row] = await query<{ id: string; tenant_id: string; project_id: string; actor_id: string; role: Session["role"]; expires_at: Date; revoked_at: Date | null }>(`SELECT * FROM fp_sessions WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND actor_id=$4${lock ? " FOR SHARE" : ""}`, [session.id, session.tenantId, session.projectId, session.actorId], tx);
  const [member] = await query<{ roles: Session["role"][]; version: number; state: string }>(`SELECT roles,version,state FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3${lock ? " FOR SHARE" : ""}`, [session.tenantId, session.projectId, session.actorId], tx);
  const now = await dbClock(tx), project = await procurementProject(session, tx);
  if (!row || row.revoked_at || row.role !== session.role || row.expires_at.toISOString() !== session.expiresAt || row.expires_at.getTime() <= Date.parse(now) || project.mode !== session.mode || !member || member.state !== "active" || !member.roles.includes(session.role)) throw new DomainError("PROCUREMENT_AUTHORITY_ENDED", "The original project profile, role or fixed deadline ended. Open the intended current profile before continuing.", 403);
  return { session, membershipVersion: member.version, scope: procurementHash({ contractVersion: C.PROCUREMENT_VERSION, tenantId: session.tenantId, projectId: session.projectId, actorId: session.actorId, sessionId: session.id, role: session.role, membershipVersion: member.version, expiresAt: row.expires_at.toISOString() }) };
}
export function expectProcurementScope(authority: ProcurementAuthority, expected: string) { if (authority.scope !== expected) throw new DomainError("PROCUREMENT_CONTEXT_CHANGED", "The project profile or its current role changed. Review the current workspace before repeating this decision.", 409); }
export async function procurementProjectLock(tx: SqlConnection, scope: ProcurementScope) { await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`procurement-project:${scope.tenantId}:${scope.projectId}`]); }
/** Head before package funding locks: a normal planner already holds its head
 * while acquiring package SHARE, so it can finish before this writer proceeds. */
export async function lockProcurementBasis(tx: SqlConnection, session: Session) {
  await projectClaimLock(tx, session.projectId);
  await tx.query("SELECT project_id FROM fp_planning_heads WHERE tenant_id=$1 AND project_id=$2 FOR SHARE", scopeValues(session));
  await lockFundingScope(session, tx);
  await projectPolicyLock(tx, session.projectId);
  await tx.query("SELECT document_id FROM fp_plan_source_controls WHERE tenant_id=$1 AND project_id=$2 ORDER BY document_id FOR SHARE", scopeValues(session));
  await tx.query("SELECT id FROM fp_reviewer_qualifications WHERE tenant_id=$1 AND project_id=$2 ORDER BY id FOR SHARE", scopeValues(session));
  await tx.query("SELECT id FROM fp_photo_alignments WHERE tenant_id=$1 AND project_id=$2 ORDER BY id FOR SHARE", scopeValues(session));
}
export function procurementBusy(error: unknown): never {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (["55P03", "57014", "40P01", "40001"].includes(code)) throw new DomainError("PROCUREMENT_BUSY", "The current workspace is finishing another decision. Check this same original request; do not replace its intent.", 409);
  throw error;
}
export async function procurementCommand<Input extends { intentId: string; expectedScope: string }>(session: Session, input: Input, kind: C.ProcurementReceipt["kind"], roles: C.ProcurementRole[], work: (tx: SqlConnection, authority: ProcurementAuthority) => Promise<{ id: string; version: number; message: string; validate?: (tx: SqlConnection) => Promise<void> }>): Promise<C.ProcurementReceipt> {
  // Fast read rejects foreign/ended callers before taking a project lock.
  expectProcurementScope(await procurementAuthority(session, database(), roles), input.expectedScope);
  try {
    return await database().transaction(async tx => {
      await tx.query("SET LOCAL lock_timeout='2000ms'; SET LOCAL statement_timeout='20000ms'");
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`procurement-command:${session.tenantId}:${session.actorId}:${input.intentId}`]);
      await procurementProjectLock(tx, session);
      const authority = await procurementAuthority(session, tx, roles, true); expectProcurementScope(authority, input.expectedScope);
      const digest = procurementHash(input), [prior] = await query<{ project_id: string; actor_session_id: string; kind: string; input_hash: string; result: unknown }>("SELECT project_id,actor_session_id,kind,input_hash,result FROM fp_procurement_commands WHERE tenant_id=$1 AND actor_id=$2 AND intent_id=$3", [session.tenantId, session.actorId, input.intentId], tx);
      if (prior) { if (prior.project_id !== session.projectId || prior.actor_session_id !== session.id || prior.kind !== kind || prior.input_hash !== digest) throw new DomainError("PROCUREMENT_INTENT_CHANGED", "This original request already has different saved fields. Inspect its recorded result before starting another decision.", 409); return C.procurementReceiptSchema.parse(prior.result); }
      const result = await work(tx, authority);
      expectProcurementScope(await procurementAuthority(session, tx, roles), input.expectedScope);
      const receipt = C.procurementReceiptSchema.parse({ intentId: input.intentId, kind, resourceId: result.id, resourceVersion: result.version, recordedAt: await dbClock(tx), message: result.message });
      await tx.query("INSERT INTO fp_procurement_commands(tenant_id,project_id,actor_id,actor_session_id,actor_role,membership_version,intent_id,kind,input_hash,encrypted_input,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)", [session.tenantId, session.projectId, session.actorId, session.id, session.role, authority.membershipVersion, input.intentId, kind, digest, sealProcurement(session, "command", `${session.actorId}:${input.intentId}`, 1, input), JSON.stringify(receipt)]);
      if (result.validate) await result.validate(tx);
      expectProcurementScope(await procurementAuthority(session, tx, roles), input.expectedScope);
      return receipt;
    });
  } catch (error) { return procurementBusy(error); }
}
export async function procurementAudit(tx: SqlConnection, authority: ProcurementAuthority, kind: string, resourceId: string, resourceVersion: number, data: unknown) {
  const id = randomUUID(), session = authority.session;
  await tx.query("INSERT INTO fp_procurement_audit(id,tenant_id,project_id,kind,resource_id,resource_version,actor_id,actor_session_id,actor_role,membership_version,encrypted_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [id, session.tenantId, session.projectId, kind, resourceId, resourceVersion, session.actorId, session.id, session.role, authority.membershipVersion, sealProcurement(session, "audit", id, 1, data)]);
}
export async function procurementEvent(tx: SqlConnection, session: Session, kind: string) { await appendEvent(tx, session, `procurement.${kind}`, "The project coordination record changed", "A versioned private procurement decision is retained. Financial approvals and physical evidence remain independently reviewed."); }

export interface SupplierRow { id: string; tenant_id: string; project_id: string; created_by: string; created_role: "organizer" | "volunteer"; created_session_id: string; created_membership_version: number; version: number; state: "active" | "archived"; created_at: Date; updated_at: Date; }
export interface SupplierVersionRow { supplier_id: string; tenant_id: string; project_id: string; version: number; state: SupplierRow["state"]; content_hash: string; encrypted_data: string; created_at: Date; }
export interface SupplierPayload { contractVersion: typeof C.PROCUREMENT_VERSION; supplierId: string; version: number; state: SupplierRow["state"]; draft: C.SupplierDraft; }
export function supplierPayload(row: SupplierVersionRow): SupplierPayload { const data = openProcurement<SupplierPayload>({ tenantId: row.tenant_id, projectId: row.project_id }, "supplier", row.supplier_id, row.version, row.encrypted_data); integrity(data, row.content_hash); C.supplierDraftSchema.parse(data.draft); if (data.contractVersion !== C.PROCUREMENT_VERSION || data.supplierId !== row.supplier_id || data.version !== row.version || data.state !== row.state) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "This supplier version does not match its original scoped record.", 409); return data; }
export interface QuoteRow { id: string; tenant_id: string; project_id: string; supplier_id: string; package_ids: string[]; created_by: string; created_role: "organizer" | "volunteer"; created_session_id: string; created_membership_version: number; version: number; state: "draft" | "reviewed" | "needs_information" | "retired"; created_at: Date; updated_at: Date; }
export interface QuoteVersionRow { quote_id: string; tenant_id: string; project_id: string; version: number; supplier_id: string; supplier_version: number; state: QuoteRow["state"]; content_hash: string; encrypted_data: string; source_document_id: string | null; source_document_version: number | null; source_hash: string | null; source_control_version: number | null; created_at: Date; }
export interface QuotePayload { contractVersion: typeof C.PROCUREMENT_VERSION; quoteId: string; version: number; state: QuoteRow["state"]; draft: C.QuoteDraft; supplier: { id: string; version: number; name: string }; sourceBinding: import("../planning/contracts").PlanSourceBinding | null; packageVersions: Record<string, number>; review: C.QuoteView["review"]; }
export function quotePayload(row: QuoteVersionRow): QuotePayload {
  const data = openProcurement<QuotePayload>({ tenantId: row.tenant_id, projectId: row.project_id }, "quote", row.quote_id, row.version, row.encrypted_data); integrity(data, row.content_hash); C.quoteDraftSchema.parse(data.draft);
  if (data.contractVersion !== C.PROCUREMENT_VERSION || data.quoteId !== row.quote_id || data.version !== row.version || data.state !== row.state || data.draft.supplierId !== row.supplier_id || data.draft.supplierVersion !== row.supplier_version || (data.sourceBinding?.documentId ?? null) !== row.source_document_id || (data.sourceBinding?.documentVersion ?? null) !== row.source_document_version || (data.sourceBinding?.contentHash ?? null) !== row.source_hash || (data.sourceBinding?.controlVersion ?? null) !== row.source_control_version) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "This retained quote no longer matches its exact original supplier and source binding.", 409);
  return data;
}
export interface OperationsPayload { contractVersion: typeof C.PROCUREMENT_VERSION; packageId: string; version: number; cycle: number; state: C.ProcurementState; blockedFrom: C.ProcurementState | null; cycleStartedAt: string; responsibilityId: string | null; selectionId: string | null; progressId: string | null; reviewedBasis: C.ProcurementBasis | null; }
export interface OperationsRow { tenant_id: string; project_id: string; package_id: string; version: number; cycle: number; state: C.ProcurementState; blocked_from: C.ProcurementState | null; cycle_started_at: Date; content_hash: string; encrypted_data: string; created_at: Date; updated_at: Date; }
export function operationsPayload(row: OperationsRow): OperationsPayload { const data = openProcurement<OperationsPayload>({ tenantId: row.tenant_id, projectId: row.project_id }, "operations", row.package_id, row.version, row.encrypted_data); integrity(data, row.content_hash); if (data.contractVersion !== C.PROCUREMENT_VERSION || data.packageId !== row.package_id || data.version !== row.version || data.cycle !== row.cycle || data.state !== row.state || data.blockedFrom !== row.blocked_from || data.cycleStartedAt !== row.cycle_started_at.toISOString()) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "The retained operational head does not match its immutable cycle and version history.", 409); return data; }
export async function operationsHead(tx: SqlConnection, scope: ProcurementScope, packageId: string, create = false): Promise<{ row: OperationsRow | null; data: OperationsPayload }> {
  const project = await procurementProject(scope, tx), data: OperationsPayload = { contractVersion: C.PROCUREMENT_VERSION, packageId, version: 0, cycle: 1, state: "draft", blockedFrom: null, cycleStartedAt: project.createdAt, responsibilityId: null, selectionId: null, progressId: null, reviewedBasis: null };
  if (create) await tx.query("INSERT INTO fp_package_operations(tenant_id,project_id,package_id,cycle_started_at,content_hash,encrypted_data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,project_id,package_id) DO NOTHING", [...scopeValues(scope), packageId, data.cycleStartedAt, procurementHash(data), sealProcurement(scope, "operations", packageId, 0, data)]);
  const [row] = await query<OperationsRow>(`SELECT * FROM fp_package_operations WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3${create ? " FOR UPDATE" : ""}`, [...scopeValues(scope), packageId], tx);
  return { row: row ?? null, data: row ? operationsPayload(row) : data };
}
export async function requireSupplier(tx: SqlConnection, scope: ProcurementScope, id: string, lock = false): Promise<SupplierRow> { const [row] = await query<SupplierRow>(`SELECT * FROM fp_procurement_suppliers WHERE id=$3 AND tenant_id=$1 AND project_id=$2${lock ? " FOR UPDATE" : ""}`, [...scopeValues(scope), id], tx); if (!row) throw new DomainError("PROCUREMENT_NOT_FOUND", "This supplier is outside the current project or permitted view.", 404); return row; }
export async function requireQuote(tx: SqlConnection, scope: ProcurementScope, id: string, lock = false): Promise<QuoteRow> { const [row] = await query<QuoteRow>(`SELECT * FROM fp_procurement_quotes WHERE id=$3 AND tenant_id=$1 AND project_id=$2${lock ? " FOR UPDATE" : ""}`, [...scopeValues(scope), id], tx); if (!row) throw new DomainError("PROCUREMENT_NOT_FOUND", "This quote is outside the current project or permitted view.", 404); return row; }

export interface ResponsibilityRow { id: string; tenant_id: string; project_id: string; package_id: string; cycle: number; version: number; responsible_actor_id: string; responsible_session_id: string; responsible_membership_version: number; role: "organizer" | "volunteer"; authority_hash: string; expires_at: Date; proposed_by: string; proposed_session_id: string; state: "proposed" | "accepted" | "declined" | "withdrawn"; encrypted_data: string; encrypted_response: string | null; responded_at: Date | null; created_at: Date; updated_at: Date; }
export interface ResponsibilityPayload { label: string; identityProvenance: "self_declared" | "workspace_session"; note: string; candidateAuthorityHash: string; }
export function responsibilityAuthorityHash(scope: ProcurementScope, input: { sessionId: string; actorId: string; role: "organizer" | "volunteer"; membershipVersion: number; expiresAt: string }) { return procurementHash({ contractVersion: C.PROCUREMENT_VERSION, kind: "responsible-authority", tenantId: scope.tenantId, projectId: scope.projectId, ...input }); }
export function responsibilityPayload(row: ResponsibilityRow): ResponsibilityPayload { const value = openProcurement<ResponsibilityPayload>({ tenantId: row.tenant_id, projectId: row.project_id }, "responsibility", row.id, 1, row.encrypted_data); if (value.candidateAuthorityHash !== row.authority_hash) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "This responsibility does not match its original authority binding.", 409); return value; }
export async function responsibilityCurrent(tx: SqlConnection, row: ResponsibilityRow, lock = false): Promise<boolean> {
  const [session] = await query<{ expires_at: Date; revoked_at: Date | null; role: Session["role"] }>(`SELECT expires_at,revoked_at,role FROM fp_sessions WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND actor_id=$4${lock ? " FOR SHARE" : ""}`, [row.responsible_session_id, row.tenant_id, row.project_id, row.responsible_actor_id], tx);
  const [member] = await query<{ version: number; state: string; roles: Session["role"][] }>(`SELECT version,state,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3${lock ? " FOR SHARE" : ""}`, [row.tenant_id, row.project_id, row.responsible_actor_id], tx);
  const now = Date.parse(await dbClock(tx));
  return !!session && !session.revoked_at && session.role === row.role && session.expires_at.getTime() >= row.expires_at.getTime() && now < row.expires_at.getTime() && !!member && member.state === "active" && member.version === row.responsible_membership_version && member.roles.includes(row.role) && row.authority_hash === responsibilityAuthorityHash({ tenantId: row.tenant_id, projectId: row.project_id }, { sessionId: row.responsible_session_id, actorId: row.responsible_actor_id, role: row.role, membershipVersion: member.version, expiresAt: session.expires_at.toISOString() });
}
export async function currentResponsibility(tx: SqlConnection, scope: ProcurementScope, packageId: string): Promise<ResponsibilityRow | null> {
  const head = await operationsHead(tx, scope, packageId); if (!head.data.responsibilityId) return null;
  const [row] = await query<ResponsibilityRow>("SELECT * FROM fp_procurement_responsibilities WHERE id=$3 AND tenant_id=$1 AND project_id=$2 AND package_id=$4 AND cycle=$5", [...scopeValues(scope), head.data.responsibilityId, packageId, head.data.cycle], tx);
  if (!row) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "The current responsible-person reference does not match its exact saved package cycle.", 409);
  return row;
}
export async function assertOwnResponsibility(tx: SqlConnection, session: Session, packageId?: string, accepted = true): Promise<ResponsibilityRow> {
  const rows = packageId ? [await currentResponsibility(tx, session, packageId)].filter((row): row is ResponsibilityRow => row !== null) : await query<ResponsibilityRow>("SELECT r.* FROM fp_procurement_responsibilities r JOIN fp_package_operations h ON h.tenant_id=r.tenant_id AND h.project_id=r.project_id AND h.package_id=r.package_id AND h.cycle=r.cycle WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.responsible_actor_id=$3 AND r.responsible_session_id=$4 AND r.role=$5 AND r.state=ANY($6::text[]) ORDER BY r.created_at DESC,r.id DESC", [session.tenantId, session.projectId, session.actorId, session.id, session.role, accepted ? ["accepted"] : ["proposed", "accepted"]], tx);
  for (const row of rows) {
    if (row.responsible_actor_id !== session.actorId || row.responsible_session_id !== session.id || row.role !== session.role || (accepted ? row.state !== "accepted" : !["accepted", "proposed"].includes(row.state))) continue;
    if ((await currentResponsibility(tx, session, row.package_id))?.id !== row.id || !await responsibilityCurrent(tx, row)) continue;
    return row;
  }
  throw new DomainError("PROCUREMENT_ASSIGNMENT_REQUIRED", "This action needs your own current accepted responsibility for the exact package cycle.", 403);
}

const pageSchema = z.object({ v: z.literal(1), k: z.string().max(40), s: z.string().regex(/^[a-f0-9]{64}$/), q: z.string().regex(/^[a-f0-9]{64}$/), at: z.iso.datetime(), id: z.string().min(1).max(160) }).strict();
function cursorMac(value: string) { const secret = process.env.AUTH_SECRET; if (!secret) throw new DomainError("PROCUREMENT_AUTH_REQUIRED", "Private pagination is unavailable without server authentication.", 503); return createHmac("sha256", secret).update(`procurement-cursor:${value}`).digest("hex"); }
export function procurementCursor(kind: string, scope: string, filter: unknown, row: { id: string; created_at: Date }): string { const body = Buffer.from(JSON.stringify({ v: 1, k: kind, s: scope, q: procurementHash(filter), at: row.created_at.toISOString(), id: row.id })).toString("base64url"); return `${body}.${cursorMac(body)}`; }
export function readProcurementCursor(value: string | null | undefined, kind: string, scope: string, filter: unknown): { at: string; id: string } | null {
  if (!value) return null;
  try { if (value.length > 500) throw new Error("oversized"); const [body, mac, extra] = value.split("."); if (extra || !body || !/^[a-f0-9]{64}$/.test(mac ?? "") || !timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(cursorMac(body), "hex"))) throw new Error("signature"); const parsed = pageSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8"))); if (parsed.k !== kind || parsed.s !== scope || parsed.q !== procurementHash(filter)) throw new Error("context"); return { at: parsed.at, id: parsed.id }; }
  catch { throw new DomainError("PROCUREMENT_CONTEXT_CHANGED", "This history page belongs to a different original profile or filter. Open the current first page.", 409); }
}
