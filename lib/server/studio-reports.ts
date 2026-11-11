import { randomUUID } from "node:crypto";
import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import { DomainError } from "../domain/money";
import { reportHistorySummary, validateStudioHistory, type StudioReportRecord } from "../studio/history";
import type { Session } from "./auth";
import { database, query } from "./db";
import { requireCurrentRole } from "./membership";
import { openPrivate, sealPrivate } from "./private-values";
import { studioScope } from "./studio-datasets";

const historyContext = (scope: string, revision: number) => `studio-report:${scope}:v${revision}`;
const eventContext = (scope: string, revision: number) => `studio-layout-event:${scope}:v${revision}`;
export async function readStudioReport(session: Session): Promise<StudioReportRecord> {
  return database().transaction(async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return readStudioReportWithin(session, tx);
  });
}
async function readStudioReportWithin(session: Session, tx: SqlConnection): Promise<StudioReportRecord> {
  const { membershipVersion } = await requireCurrentRole(session, session.role, tx), scope = studioScope(session, membershipVersion);
  const [row] = await query<{ id: string; revision: number; encrypted_history: string; history_hash: string; updated_at: Date }>(
    "SELECT id,revision,encrypted_history,history_hash,updated_at FROM fp_studio_reports WHERE scope_hash=$1 AND tenant_id=$2 AND project_id=$3 AND actor_id=$4 AND role=$5",
    [scope, session.tenantId, session.projectId, session.actorId, session.role], tx);
  if (!row) return { revision: 0, history: null, savedAt: null, audit: [] };
  const history = validateStudioHistory(openPrivate(row.encrypted_history, historyContext(scope, row.revision)));
  if (sha256(canonicalJson(history)) !== row.history_hash) throw new DomainError("STUDIO_HISTORY_CHANGED", "This report history could not be verified.", 409);
  const audit = await query<{ revision: number; encrypted_summary: string; created_at: Date }>(
    "SELECT revision,encrypted_summary,created_at FROM fp_studio_layout_events WHERE report_id=$1 ORDER BY revision DESC LIMIT 60", [row.id], tx);
  return { revision: row.revision, history, savedAt: row.updated_at.toISOString(), audit: audit.map(event => {
    const summary = openPrivate<ReturnType<typeof reportHistorySummary>>(event.encrypted_summary, eventContext(scope, event.revision));
    return { revision: event.revision, savedAt: event.created_at.toISOString(), label: summary.latest?.label ?? "Report saved", undo: summary.undo, redo: summary.redo, provenance: "client_observed_layout" as const };
  }) };
}

export async function saveStudioReport(session: Session, expectedRevision: number, value: unknown): Promise<StudioReportRecord> {
  let history;
  try { history = validateStudioHistory(value); } catch { throw new DomainError("STUDIO_HISTORY_INVALID", "The full report history could not be saved. Keep this page open and review the report configuration.", 422); }
  const hash = sha256(canonicalJson(history));
  return database().transaction(async tx => {
    const { membershipVersion } = await requireCurrentRole(session, session.role, tx), scope = studioScope(session, membershipVersion);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,410210))", [scope]);
    const [current] = await query<{ id: string; revision: number; history_hash: string }>("SELECT id,revision,history_hash FROM fp_studio_reports WHERE scope_hash=$1 FOR UPDATE", [scope], tx);
    // Identical retry is safe; a different concurrent edit must remain reviewable.
    if (current?.history_hash === hash) return readStudioReportWithin(session, tx);
    if ((current?.revision ?? 0) !== expectedRevision) throw new DomainError("STUDIO_REPORT_CONFLICT", "This report changed in another tab. Reload its saved version before saving your next edit.", 409);
    const id = current?.id ?? randomUUID(), revision = expectedRevision + 1;
    const encrypted = sealPrivate(history, historyContext(scope, revision));
    if (current) await tx.query("UPDATE fp_studio_reports SET revision=$2,history_hash=$3,encrypted_history=$4,updated_at=now() WHERE id=$1", [id, revision, hash, encrypted]);
    else await tx.query(`INSERT INTO fp_studio_reports(id,tenant_id,project_id,actor_id,role,scope_hash,membership_version,revision,history_hash,encrypted_history)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, session.tenantId, session.projectId, session.actorId, session.role, scope, membershipVersion, revision, hash, encrypted]);
    await tx.query("INSERT INTO fp_studio_layout_events(id,report_id,revision,actor_id,history_hash,encrypted_summary) VALUES($1,$2,$3,$4,$5,$6)",
      [randomUUID(), id, revision, session.actorId, hash, sealPrivate(reportHistorySummary(history), eventContext(scope, revision))]);
    // Acknowledge exactly the history written under this lock. Reading again
    // after commit could return a later tab's revision and let this tab advance
    // its CAS token without ever loading that other edit.
    return readStudioReportWithin(session, tx);
  });
}
