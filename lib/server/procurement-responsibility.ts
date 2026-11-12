import { createHmac, randomUUID } from "node:crypto";
import type { SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import * as C from "../procurement/contracts";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { query } from "./db";
import { assertOpenOperations, expectOperationsHead, writeOperationsHead } from "./procurement-operations-store";
import { dbClock, currentResponsibility, operationsHead, procurementCommand, procurementCursor, readProcurementCursor, responsibilityAuthorityHash, responsibilityCurrent, responsibilityPayload, scopeValues, sealProcurement, openProcurement, lockProcurementBasis, type ProcurementAuthority, type ResponsibilityRow } from "./procurement-store";
import { finishProcurementMutation } from "./procurement-projection";

interface CandidateRow { id: string; actor_id: string; role: "organizer" | "volunteer"; expires_at: Date; created_at: Date; membership_version: number; }
export function responsibleCandidateId(sessionId: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new DomainError("PROCUREMENT_AUTH_REQUIRED", "Current responsible-person profiles require server authentication.", 503);
  const hex = createHmac("sha256", secret).update(`procurement-responsible-candidate:${sessionId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
async function candidateLabel(tx: SqlConnection, session: Session, row: CandidateRow): Promise<{ label: string; provenance: "self_declared" | "workspace_session" }> {
  const [access] = await query<{ id: string; encrypted_identity: string }>("SELECT id,encrypted_identity FROM fp_procurement_access WHERE tenant_id=$1 AND project_id=$2 AND session_id=$3", [...scopeValues(session), row.id], tx);
  let label = row.role === "organizer" ? "Project organizer" : "Project volunteer", provenance: "self_declared" | "workspace_session" = "workspace_session";
  if (access) { const value = openProcurement<{ displayName: string }>(session, "volunteer-identity", access.id, 1, access.encrypted_identity); label = value.displayName; provenance = "self_declared"; }
  return { label: `${label} · ${responsibleCandidateId(row.id).slice(0, 6)}`, provenance };
}
export async function candidatePage(tx: SqlConnection, authority: ProcurementAuthority, before: string | null | undefined) {
  const session = authority.session;
  if (session.role !== "organizer") throw new DomainError("PROCUREMENT_ROLE_DENIED", "Only the current organizer can review the current responsibility candidates.", 403);
  const cursor = readProcurementCursor(before, "candidates", authority.scope, null);
  const rows = await query<CandidateRow>(`SELECT s.id,s.actor_id,s.role,s.expires_at,s.created_at,m.version membership_version FROM fp_sessions s JOIN fp_memberships m ON m.tenant_id=s.tenant_id AND m.project_id=s.project_id AND m.actor_id=s.actor_id
    WHERE s.tenant_id=$1 AND s.project_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.role IN ('organizer','volunteer') AND m.state='active' AND m.roles ? s.role AND ($3::timestamptz IS NULL OR (date_trunc('milliseconds',s.created_at),s.id)<($3,$4)) ORDER BY date_trunc('milliseconds',s.created_at) DESC,s.id DESC LIMIT $5`, [...scopeValues(session), cursor?.at ?? null, cursor?.id ?? null, C.PROCUREMENT_PAGE_SIZE + 1], tx);
  const page = rows.slice(0, C.PROCUREMENT_PAGE_SIZE), items: C.ResponsibleCandidate[] = [];
  for (const row of page) { const label = await candidateLabel(tx, session, row); items.push({ id: responsibleCandidateId(row.id), label: label.label, role: row.role, membershipVersion: row.membership_version, authorityHash: responsibilityAuthorityHash(session, { sessionId: row.id, actorId: row.actor_id, role: row.role, membershipVersion: row.membership_version, expiresAt: row.expires_at.toISOString() }), expiresAt: row.expires_at.toISOString(), identityProvenance: label.provenance, own: row.id === session.id && row.actor_id === session.actorId }); }
  return C.procurementCandidatePageSchema.parse({ scope: authority.scope, items, nextCursor: rows.length > page.length ? procurementCursor("candidates", authority.scope, null, page[page.length - 1]) : null });
}
async function exactCandidate(tx: SqlConnection, authority: ProcurementAuthority, input: z.infer<typeof C.responsibilityProposeSchema>): Promise<CandidateRow> {
  const rows = await query<CandidateRow>(`SELECT s.id,s.actor_id,s.role,s.expires_at,s.created_at,m.version membership_version FROM fp_sessions s JOIN fp_memberships m ON m.tenant_id=s.tenant_id AND m.project_id=s.project_id AND m.actor_id=s.actor_id WHERE s.tenant_id=$1 AND s.project_id=$2 AND s.role IN ('organizer','volunteer') AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND m.state='active' AND m.roles ? s.role ORDER BY s.id FOR SHARE OF s,m`, scopeValues(authority.session), tx);
  const row = rows.find(row => responsibleCandidateId(row.id) === input.candidateId);
  if (!row || row.membership_version !== input.candidateMembershipVersion || responsibilityAuthorityHash(authority.session, { sessionId: row.id, actorId: row.actor_id, role: row.role, membershipVersion: row.membership_version, expiresAt: row.expires_at.toISOString() }) !== input.candidateAuthorityHash) throw new DomainError("PROCUREMENT_ASSIGNMENT_ENDED", "The candidate's exact project profile, role, membership version or original expiry changed. Review current candidates first.", 409);
  return row;
}
export async function responsibilityView(tx: SqlConnection, authority: ProcurementAuthority, row: ResponsibilityRow): Promise<C.Responsibility> {
  const session = authority.session, own = row.responsible_session_id === session.id && row.responsible_actor_id === session.actorId && row.role === session.role;
  if (session.role !== "organizer" && !own) throw new DomainError("PROCUREMENT_NOT_FOUND", "This responsibility is outside the current profile's own view.", 404);
  const current = await responsibilityCurrent(tx, row), head = await operationsHead(tx, session, row.package_id), activeCycle = head.data.responsibilityId === row.id && head.data.cycle === row.cycle && !["accepted", "canceled"].includes(head.data.state), state = current || ["declined", "withdrawn"].includes(row.state) ? row.state : "authority_ended";
  return C.responsibilitySchema.parse({ id: row.id, version: row.version, cycle: row.cycle, state, label: responsibilityPayload(row).label, role: row.role, own, expiresAt: row.expires_at.toISOString(), proposedAt: row.created_at.toISOString(), respondedAt: row.responded_at?.toISOString() ?? null, canAccept: own && current && activeCycle && row.state === "proposed", canDecline: own && current && activeCycle && row.state === "proposed", canWithdraw: current && activeCycle && ["proposed", "accepted"].includes(row.state) && (own || session.role === "organizer"), reasons: current ? [] : ["The original responsible profile, role, membership version or fixed expiry ended. This grants no replacement role or renewed deadline."] });
}
export async function proposeProcurementResponsibility(session: Session, raw: z.infer<typeof C.responsibilityProposeSchema>) {
  const input = C.responsibilityProposeSchema.parse(raw);
  return procurementCommand(session, input, "responsibility_propose", ["organizer"], async (tx, authority) => {
    await lockProcurementBasis(tx, session);
    const previous = (await operationsHead(tx, session, input.packageId, true)).data; expectOperationsHead(previous, input.expectedOperationsVersion, input.expectedCycle); await assertOpenOperations(previous);
    const candidate = await exactCandidate(tx, authority, input), own = candidate.id === session.id && candidate.actor_id === session.actorId;
    if (input.acceptOwnResponsibility && !own) throw new DomainError("PROCUREMENT_ROLE_DENIED", "Only the exact proposed current profile can accept its own responsibility.", 403);
    const current = await currentResponsibility(tx, session, input.packageId);
    if (current && ["proposed", "accepted"].includes(current.state)) await tx.query("UPDATE fp_procurement_responsibilities SET version=version+1,state='withdrawn',responded_at=clock_timestamp(),encrypted_response=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND project_id=$2 AND id=$3", [...scopeValues(session), current.id, sealProcurement(session, "responsibility-response", current.id, current.version + 1, { reason: input.note, kind: "reassigned" })]);
    const id = randomUUID(), label = await candidateLabel(tx, session, candidate), expiresAt = new Date(Math.min(candidate.expires_at.getTime(), Date.parse(session.expiresAt))).toISOString();
    if (Date.parse(expiresAt) <= Date.parse(await dbClock(tx))) throw new DomainError("PROCUREMENT_ASSIGNMENT_ENDED", "The original responsibility deadline ended while the candidate was being reviewed.", 409);
    const data = { label: label.label, identityProvenance: label.provenance, note: input.note, candidateAuthorityHash: input.candidateAuthorityHash };
    await tx.query("INSERT INTO fp_procurement_responsibilities(id,tenant_id,project_id,package_id,cycle,responsible_actor_id,responsible_session_id,responsible_membership_version,role,authority_hash,expires_at,proposed_by,proposed_session_id,state,encrypted_data,responded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)", [id, session.tenantId, session.projectId, input.packageId, previous.cycle, candidate.actor_id, candidate.id, candidate.membership_version, candidate.role, input.candidateAuthorityHash, expiresAt, session.actorId, session.id, input.acceptOwnResponsibility ? "accepted" : "proposed", sealProcurement(session, "responsibility", id, 1, data), input.acceptOwnResponsibility ? await dbClock(tx) : null]);
    const next = await writeOperationsHead(tx, authority, previous, { responsibilityId: id, reviewedBasis: null });
    await finishProcurementMutation(tx, authority, "responsibility", previous, next, input.note, id);
    if (Date.parse(expiresAt) <= Date.parse(await dbClock(tx))) throw new DomainError("PROCUREMENT_ASSIGNMENT_ENDED", "The original responsibility deadline ended while its exact proposal was being recorded.", 409);
    return { id, version: 1, message: input.acceptOwnResponsibility ? "Your exact current project profile accepted this operational responsibility. No project role, spending approval or verified identity was granted." : "The current project member has a pending responsibility proposal. They must explicitly accept it under their original fixed authority.", validate: async () => { if (Date.parse(expiresAt) <= Date.parse(await dbClock(tx))) throw new DomainError("PROCUREMENT_ASSIGNMENT_ENDED", "The original proposal deadline ended while its receipt was being saved.", 409); } };
  });
}
export async function actOnProcurementResponsibility(session: Session, id: string, raw: z.infer<typeof C.responsibilityActionSchema>) {
  const input = C.responsibilityActionSchema.parse(raw);
  return procurementCommand(session, { ...input, resourceId: id }, "responsibility_action", ["organizer", "volunteer"], async (tx, authority) => {
    await lockProcurementBasis(tx, session);
    const [row] = await query<ResponsibilityRow>("SELECT * FROM fp_procurement_responsibilities WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE", [...scopeValues(session), id], tx);
    if (!row) throw new DomainError("PROCUREMENT_NOT_FOUND", "This responsibility is outside the current project.", 404);
    const previous = (await operationsHead(tx, session, row.package_id, true)).data; await assertOpenOperations(previous);
    const own = row.responsible_session_id === session.id && row.responsible_actor_id === session.actorId && row.role === session.role;
    if ((!own && !(session.role === "organizer" && input.action === "withdraw")) || previous.responsibilityId !== id || previous.cycle !== row.cycle) throw new DomainError("PROCUREMENT_NOT_FOUND", "Only this cycle's exact responsible profile can respond. A current organizer may withdraw its coordination assignment.", 404);
    if (row.version !== input.expectedVersion || !["proposed", "accepted"].includes(row.state) || input.action !== "withdraw" && row.state !== "proposed") throw new DomainError("PROCUREMENT_VERSION_CHANGED", "This responsibility already has a different response. Review its exact saved version.", 409);
    if (input.action !== "withdraw" && !await responsibilityCurrent(tx, row, true)) throw new DomainError("PROCUREMENT_ASSIGNMENT_ENDED", "The original responsibility authority or fixed deadline ended.", 409);
    const state = input.action === "accept" ? "accepted" : input.action === "decline" ? "declined" : "withdrawn";
    await tx.query("UPDATE fp_procurement_responsibilities SET version=version+1,state=$4,responded_at=clock_timestamp(),encrypted_response=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND project_id=$2 AND id=$3", [...scopeValues(session), id, state, sealProcurement(session, "responsibility-response", id, row.version + 1, { reason: input.reason, actorId: session.actorId })]);
    const next = await writeOperationsHead(tx, authority, previous, { reviewedBasis: null });
    await finishProcurementMutation(tx, authority, "responsibility", previous, next, input.reason, own ? id : null);
    if (input.action === "accept" && !await responsibilityCurrent(tx, row)) throw new DomainError("PROCUREMENT_ASSIGNMENT_ENDED", "The original responsibility deadline ended while its response was being recorded.", 409);
    return { id, version: row.version + 1, message: state === "accepted" ? "Your exact original project profile accepted this cycle. Purchasing, money and physical reviews remain separately authorized." : state === "declined" ? "Your responsibility proposal is declined. Your independent project membership and earlier records are unchanged." : "This responsibility is withdrawn. Earlier work, financial and physical-evidence history remains retained.", validate: async () => { if (input.action === "accept" && !await responsibilityCurrent(tx, row)) throw new DomainError("PROCUREMENT_ASSIGNMENT_ENDED", "The original responsibility authority ended while its receipt was being saved.", 409); } };
  });
}
