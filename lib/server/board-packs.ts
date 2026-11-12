import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import type { BoardPackDesk, BoardPackSummary, BoardPackView, BoardPackSourceDetail } from "../reports/board-pack-contracts";
import { BOARD_PACK_HISTORY_PAGE_SIZE, BOARD_PACK_VERSION, boardPackCaptureInput } from "../reports/board-pack-contracts";
import { boardPackCsv } from "../reports/board-pack-projection";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { database, initializeDatabase, query } from "./db";
import { requireCurrentRole } from "./membership";
import { lockPlanningAuthority } from "./planning-store";
import { openPrivate, sealPrivate } from "./private-values";
import { boardPackAudience, boardPackSourceHash, buildBoardPack, type BoardPackEnvelope } from "./board-pack-sources";
import { assertStudioProjection } from "./studio-datasets";
import { sharedAlignmentImage } from "./planning-evidence";
import { publicProofImage, readPublicProofWithin } from "./proof";
import type { DocumentStorage } from "./document-storage";
import { planningDocumentStorage } from "./planning-sources";

const roles = ["donor", "volunteer", "organizer", "auditor"] as const;
interface CaptureRow {
  id: string; tenant_id: string; project_id: string; actor_id: string; role: Session["role"]; membership_version: number; scope_hash: string;
  intent_id: string; input_hash: string; content_hash: string; source_hash: string; semantic_version: string;
  projection_version: number; event_cursor: string; as_of: Date; encrypted_data: string;
}
interface FrozenCapture { row: CaptureRow; value: BoardPackEnvelope; }
const scopeParams = (session: Session) => [session.tenantId, session.projectId, session.actorId, session.role];
const storedScope = (session: Session, version: number) => sha256(canonicalJson({ contract: BOARD_PACK_VERSION, tenant: session.tenantId, project: session.projectId, actor: session.actorId, role: session.role, membershipVersion: version }));
const sessionScope = (session: Session, version: number) => sha256(canonicalJson({ scope: storedScope(session, version), session: session.id, expiresAt: session.expiresAt }));
const encryptedContext = (row: Pick<CaptureRow, "id" | "tenant_id" | "project_id" | "scope_hash">) => `board-pack:${row.tenant_id}:${row.project_id}:${row.scope_hash}:${row.id}`;
const captureId = (value: string) => z.uuid().parse(value);
const sourceId = (value: string) => z.string().min(1).max(500).parse(value);
const unavailable = () => new DomainError("BOARD_PACK_UNAVAILABLE", "This saved report is unavailable in your current profile and view. Open your current Board Pack desk.", 404);

export async function assertBoardPackContext(session: Session, expected: string | null): Promise<void> {
  const { membershipVersion } = await requireCurrentRole(session, session.role);
  if (!expected || expected !== sessionScope(session, membershipVersion)) throw new DomainError("BOARD_PACK_CONTEXT_CHANGED", "Your active profile or view changed. Reload the Board Pack before continuing.", 409);
}
async function authorized<T>(session: Session, work: (tx: SqlConnection, version: number) => Promise<T>, current = false): Promise<T> {
  await initializeDatabase();
  if (!roles.includes(session.role)) throw new DomainError("ROLE_DENIED", "Open an authorized project view before creating a Board Pack.", 403);
  const result = await database().transaction(async tx => {
    await tx.query(current ? "SET TRANSACTION ISOLATION LEVEL READ COMMITTED" : "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const version = await lockPlanningAuthority(session, [session.role], tx);
    const result = await work(tx, version);
    // Row locks serialize membership/revocation; the original deadline still
    // advances while sources, report writes or other locks take time.
    await requireCurrentRole(session, session.role, tx);
    return result;
  });
  await requireCurrentRole(session, session.role);
  return result;
}
function decode(row: CaptureRow): BoardPackEnvelope {
  const value = openPrivate<BoardPackEnvelope>(row.encrypted_data, encryptedContext(row));
  const report = value.report;
  if (!report || report.schemaVersion !== BOARD_PACK_VERSION || report.id !== row.id || report.project.id !== row.project_id || report.audience.role !== row.role || report.contentHash !== row.content_hash || value.sourceHash !== row.source_hash || report.projectionVersion !== row.projection_version || report.eventCursor !== Number(row.event_cursor) || Date.parse(report.asOf) !== row.as_of.getTime()
    || sha256(canonicalJson({ report: { ...report, contentHash: undefined }, sources: value.sources })) !== row.content_hash)
    throw new DomainError("BOARD_PACK_INTEGRITY", "This report could not be verified against its frozen source record. Its audit has been retained.", 409);
  assertStudioProjection(report.data);
  const ids = new Set(report.sources.map(s => s.id));
  if (ids.size !== report.sources.length || Object.keys(value.sources).some(id => !ids.has(id)) || ids.size !== Object.keys(value.sources).length)
    throw new DomainError("BOARD_PACK_INTEGRITY", "This saved source index could not be verified.", 409);
  return value;
}
const summary = (value: BoardPackEnvelope): BoardPackSummary => ({ id: value.report.id, label: value.report.label, asOf: value.report.asOf, contentHash: value.report.contentHash, role: value.report.audience.role, projectionVersion: value.report.projectionVersion, eventCursor: value.report.eventCursor, packageCount: value.report.packages.length });
async function head(session: Session, tx: SqlConnection) {
  const [row] = await query<{ title: string; projection_version: number; cursor: string; checked_at: Date }>(`SELECT p.metadata->>'title' title,p.projection_version,clock_timestamp() checked_at,
    (SELECT COALESCE(max(sequence),0) FROM fp_events WHERE tenant_id=$1 AND project_id=$2) cursor FROM fp_projects p WHERE p.tenant_id=$1 AND p.id=$2`, [session.tenantId, session.projectId], tx);
  if (!row) throw unavailable(); return row;
}
async function getCapture(session: Session, id: string, membershipVersion: number, tx: SqlConnection): Promise<FrozenCapture> {
  const [row] = await query<CaptureRow>("SELECT * FROM fp_board_packs WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND actor_id=$4 AND role=$5 AND membership_version=$6 AND scope_hash=$7", [captureId(id), ...scopeParams(session), membershipVersion, storedScope(session, membershipVersion)], tx);
  if (!row) throw unavailable(); return { row, value: decode(row) };
}
/** Financial facts stay in the immutable capture. Disclosure uses a separate
 * current transaction so waiting on authority cannot freeze an earlier source
 * permission, including an implicit permission with no row to lock yet. */
async function currentCapture<T>(session: Session, captured: FrozenCapture, work: (tx: SqlConnection) => Promise<T>): Promise<T> {
  return authorized(session, async (tx, version) => {
    if (captured.row.membership_version !== version || captured.row.scope_hash !== storedScope(session, version)) throw unavailable();
    return work(tx);
  }, true);
}
async function checkBoundSources(session: Session, value: BoardPackEnvelope, tx: SqlConnection): Promise<string[]> {
  const reasons: string[] = [], scope = [session.tenantId, session.projectId];
  // These are current access checks, not a recomputation of historical amounts.
  for (const bound of value.bindings.documents) {
    const [doc] = await query<{ version: number; sha256: string | null; state: string }>("SELECT version,sha256,state FROM fp_documents WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR SHARE", [bound.id, ...scope], tx);
    // Inspect the values returned after acquiring this lock, not values from
    // an earlier outer join that may predate the permission writer's commit.
    const [control] = await query<{ permission: string; version: number }>("SELECT permission,version FROM fp_plan_source_controls WHERE document_id=$1 AND tenant_id=$2 AND project_id=$3 FOR SHARE", [bound.id, ...scope], tx);
    if (!doc || doc.state !== "ready" || control?.permission === "withdrawn" || doc.version !== bound.version || doc.sha256 !== bound.hash || (control?.version ?? 0) !== bound.controlVersion) reasons.push("A source document or its sharing permission changed after this capture.");
  }
  for (const bound of value.bindings.publications) {
    const [row] = await query<{ state: string; content_hash: string }>("SELECT state,content_hash FROM fp_plan_publications WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR SHARE", [bound.id, ...scope], tx);
    if (!row || row.state === "revoked" || row.content_hash !== bound.hash) reasons.push("The captured plan publication was withdrawn or no longer matches its reviewed source.");
  }
  for (const bound of value.bindings.alignments) {
    const [row] = await query<{ state: string; content_hash: string }>("SELECT state,content_hash FROM fp_photo_alignments WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR SHARE", [bound.id, ...scope], tx);
    if (!row || row.state !== "reviewed" || row.content_hash !== bound.hash) reasons.push("A captured reviewed image is no longer shared.");
  }
  for (const bound of value.bindings.proofSnapshots) {
    let current;
    try { current = await readPublicProofWithin(bound.slug, bound.revision, tx); }
    catch (error) {
      if (!(error instanceof DomainError) || !["PROOF_IMAGE_NOT_FOUND", "PLAN_NOT_FOUND", "PROOF_IMAGE_INTEGRITY", "PLAN_INTEGRITY"].includes(error.code)) throw error;
    }
    if (!current || current.state !== "published" || current.snapshot?.id !== bound.id || current.snapshot.contentHash !== bound.hash) reasons.push("A public-copy edition or its current source permission was withdrawn.");
  }
  return [...new Set(reasons)];
}
async function viewWithin(session: Session, value: BoardPackEnvelope, tx: SqlConnection, currentHash?: string): Promise<BoardPackView> {
  const withdrawn = await checkBoundSources(session, value, tx), currentSourceHash = currentHash ?? await boardPackSourceHash(session, tx), current = await head(session, tx);
  const changed = value.sourceHash !== currentSourceHash || value.report.projectionVersion !== current.projection_version || value.report.eventCursor !== Number(current.cursor), expiredSource = value.bindings.validThrough !== null && Date.parse(value.bindings.validThrough) <= current.checked_at.getTime();
  const reasons = withdrawn.length ? withdrawn : [changed ? "Project records changed after this saved cutoff. The original figures remain frozen; capture a new report for current facts." : null, expiredSource ? "A time-limited promise or reviewer scope passed its original deadline after this cutoff." : null].filter((s): s is string => !!s);
  return { summary: summary(value), status: withdrawn.length ? "withdrawn" : changed || expiredSource ? "historical" : "current", checkedAt: current.checked_at.toISOString(), currentProjectionVersion: current.projection_version, currentEventCursor: Number(current.cursor), reasons, report: withdrawn.length ? null : value.report, canPrint: withdrawn.length === 0, canExport: withdrawn.length === 0 };
}
export async function readBoardPackDesk(session: Session, before?: string): Promise<BoardPackDesk> {
  const frozen = await authorized(session, async (tx, membershipVersion) => {
    const current = await head(session, tx), scopeHash = storedScope(session, membershipVersion);
    let boundary: CaptureRow | undefined;
    if (before) boundary = (await getCapture(session, before, membershipVersion, tx)).row;
    const rows = await query<CaptureRow>(`SELECT * FROM fp_board_packs WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND role=$4 AND membership_version=$5 AND scope_hash=$6
      AND ($7::timestamptz IS NULL OR (as_of,id)<($7::timestamptz,$8::text)) ORDER BY as_of DESC,id DESC LIMIT $9`, [...scopeParams(session), membershipVersion, scopeHash, boundary?.as_of ?? null, boundary?.id ?? "", BOARD_PACK_HISTORY_PAGE_SIZE + 1], tx);
    const entries = rows.slice(0, BOARD_PACK_HISTORY_PAGE_SIZE).map(decode);
    const desk: BoardPackDesk = { scope: sessionScope(session, membershipVersion), projectId: session.projectId, projectTitle: current.title, audience: boardPackAudience(session.role), sessionExpiresAt: session.expiresAt, projectionVersion: current.projection_version, eventCursor: Number(current.cursor), history: entries.map(summary), nextCursor: rows.length > BOARD_PACK_HISTORY_PAGE_SIZE ? entries.at(-1)!.report.id : null, selected: null, canCapture: true };
    return { desk, selected: !before && entries[0] ? entries[0] : null };
  });
  return authorized(session, async (tx, version) => {
    if (frozen.desk.scope !== sessionScope(session, version)) throw new DomainError("BOARD_PACK_CONTEXT_CHANGED", "Your active profile or view changed. Reload the Board Pack before continuing.", 409);
    const selected = frozen.selected ? await viewWithin(session, frozen.selected, tx) : null, current = await head(session, tx);
    return { ...frozen.desk, projectTitle: current.title, projectionVersion: current.projection_version, eventCursor: Number(current.cursor), selected };
  }, true);
}
export async function readBoardPack(session: Session, id: string): Promise<BoardPackView> {
  const captured = await authorized(session, (tx, version) => getCapture(session, id, version, tx));
  return currentCapture(session, captured, tx => viewWithin(session, captured.value, tx));
}
export async function captureBoardPack(session: Session, raw: unknown): Promise<BoardPackView> {
  const input = boardPackCaptureInput.parse(raw), inputHash = sha256(canonicalJson(input));
  let id: string;
  try {
    id = await authorized(session, async (tx, version) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,410212))", [`board-pack:${session.tenantId}:${session.projectId}:${session.actorId}:${session.role}`]);
      const [prior] = await query<CaptureRow>("SELECT * FROM fp_board_packs WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND role=$4 AND intent_id=$5", [...scopeParams(session), input.intentId], tx);
      if (prior) {
        if (prior.input_hash !== inputHash) throw new DomainError("BOARD_PACK_INTENT_CHANGED", "This capture request was already used for different report terms. Reopen the saved report before starting a new capture.", 409);
        if (prior.scope_hash !== storedScope(session, version)) throw unavailable();
        decode(prior); return prior.id;
      }
      const current = await head(session, tx);
      if (current.projection_version !== input.expectedProjectionVersion) throw new DomainError("BOARD_PACK_PROJECT_CHANGED", "The project changed before this capture. Refresh the desk and review its current version before trying again.", 409);
      const [rate] = await query(`INSERT INTO fp_request_buckets(bucket_key,request_count) VALUES($1,1) ON CONFLICT(bucket_key) DO UPDATE SET request_count=fp_request_buckets.request_count+1 WHERE fp_request_buckets.request_count<60 RETURNING request_count`, [`board-pack:${session.tenantId}:${session.projectId}:${session.actorId}:${current.checked_at.toISOString().slice(0, 13)}`], tx);
      if (!rate) throw new DomainError("BOARD_PACK_CAPTURE_LIMIT", "This profile has created 60 reports in the current hour. Your saved reports remain available; return next hour to capture another.", 429);
      const reportId = randomUUID(), value = await buildBoardPack(session, reportId, input.label, tx), scopeHash = storedScope(session, version);
      if ((await checkBoundSources(session, value, tx)).length) throw new DomainError("BOARD_PACK_SOURCE_CHANGED", "A bound source changed before the report could be saved. Refresh its source review before trying again.", 409);
      if (Buffer.byteLength(canonicalJson(value)) > 16 * 1024 * 1024) throw new DomainError("BOARD_PACK_SIZE_LIMIT", "This report exceeds the private capture limit. Existing captures remain available.", 422);
      await requireCurrentRole(session, session.role, tx);
      const encrypted = sealPrivate(value, encryptedContext({ id: reportId, tenant_id: session.tenantId, project_id: session.projectId, scope_hash: scopeHash }));
      await tx.query(`INSERT INTO fp_board_packs(id,tenant_id,project_id,actor_id,role,membership_version,scope_hash,intent_id,input_hash,content_hash,source_hash,semantic_version,projection_version,event_cursor,as_of,encrypted_data)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [reportId, ...scopeParams(session), version, scopeHash, input.intentId, inputHash, value.report.contentHash, value.sourceHash, BOARD_PACK_VERSION, value.report.projectionVersion, value.report.eventCursor, value.report.asOf, encrypted]);
      await tx.query("INSERT INTO fp_board_pack_audit(id,report_id,tenant_id,project_id,actor_id,role,membership_version,event,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,'captured',$8)", [randomUUID(), reportId, ...scopeParams(session), version, value.report.contentHash]);
      return reportId;
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (["40001", "40P01", "23505"].includes(code)) throw new DomainError("BOARD_PACK_CAPTURE_BUSY", "Another request finished while this capture was waiting. Retry the same saved request to recover its original report.", 409);
    throw error;
  }
  // The disclosure uses a new current authorization snapshot after persistence.
  // A late source withdrawal keeps the immutable capture but withholds its content.
  return readBoardPack(session, id);
}
export async function readBoardPackSource(session: Session, reportId: string, referenceId: string): Promise<BoardPackSourceDetail> {
  const captured = await authorized(session, (tx, version) => getCapture(session, reportId, version, tx));
  const { value } = captured, key = sourceId(referenceId), reference = Object.hasOwn(value.sources, key) ? value.sources[key] : undefined;
  if (!reference) throw new DomainError("BOARD_PACK_SOURCE_UNAVAILABLE", "This source is outside the selected report and audience.", 404);
  const detail: BoardPackSourceDetail = { ...reference.detail, reportId, contentHash: value.report.contentHash, asOf: value.report.asOf,
      image: reference.image ? { url: `/api/board-packs/${encodeURIComponent(reportId)}/sources/${encodeURIComponent(referenceId)}/image`, width: reference.image.width, height: reference.image.height, alt: reference.detail.source.label, contentHash: reference.image.hash } : null };
  return currentCapture(session, captured, async tx => {
    if ((await checkBoundSources(session, value, tx)).length) throw new DomainError("BOARD_PACK_SOURCE_WITHDRAWN", "This report includes a source whose access changed. Refresh the report; its original audit remains saved.", 410);
    return detail;
  });
}
export async function readBoardPackImage(session: Session, reportId: string, referenceId: string, storage: DocumentStorage = planningDocumentStorage()): Promise<Buffer> {
  const captured = await authorized(session, async (tx, version) => {
    const { value } = await getCapture(session, reportId, version, tx), view = await viewWithin(session, value, tx);
    if (!view.report) throw new DomainError("BOARD_PACK_SOURCE_WITHDRAWN", "This report's source is no longer shared.", 410);
    const key = sourceId(referenceId), bound = Object.hasOwn(value.sources, key) ? value.sources[key] : undefined;
    if (!bound?.image) throw new DomainError("BOARD_PACK_IMAGE_UNAVAILABLE", "This source has no permitted reviewed image in the saved report.", 404);
    return bound.image;
  });
  const bytes = captured.kind === "alignment" ? await sharedAlignmentImage(session, captured.id, storage) : await publicProofImage(captured.slug!, captured.id, captured.revision, storage);
  if (createHash("sha256").update(bytes).digest("hex") !== captured.hash) throw new DomainError("BOARD_PACK_IMAGE_INTEGRITY", "The shared image no longer matches the bytes recorded in this report.", 409);
  const final = await readBoardPackSource(session, reportId, referenceId);
  if (final.image?.contentHash !== captured.hash) throw new DomainError("BOARD_PACK_SOURCE_WITHDRAWN", "The image's source permission changed while it loaded.", 410);
  return bytes;
}
export async function exportBoardPack(session: Session, id: string): Promise<{ csv: string; filename: string }> {
  const captured = await authorized(session, (tx, version) => getCapture(session, id, version, tx)), report = captured.value.report;
  const csv = boardPackCsv(report), filename = `fieldproof-board-pack-${report.asOf.slice(0, 10)}-${report.id.slice(0, 8)}.csv`;
  return currentCapture(session, captured, async tx => {
    if ((await checkBoundSources(session, captured.value, tx)).length) throw new DomainError("BOARD_PACK_SOURCE_WITHDRAWN", "This report's source access changed. Capture a new report before exporting.", 410);
    return { csv, filename };
  });
}
