import { randomUUID } from "node:crypto";
import type { SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import { claimLineAttentionReason, draftClaimSchema, reviewClaimSchema, validateClaimReview, type ClaimPrivateData, type ClaimState, type ClaimView } from "../domain/claims";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { database, query } from "./db";
import { documentView, requireDocument, type DocumentRow } from "./documents";
import { requireCurrentRole } from "./membership";
import { openPrivate, sealPrivate } from "./private-values";
import { receiptComparisons } from "./receipt-comparison";
import { receiptRuns } from "./receipt-extraction";
import { appendEvent } from "./repository";

export interface ClaimRow {
  id: string; tenant_id: string; project_id: string; actor_id: string; document_id: string; group_id: string; intent_id: string;
  state: ClaimState; version: number; source_run_id: string | null; currency: string | null;
  requested_minor: string; approved_minor: string; encrypted_data: string; reviewed_by: string | null;
  reviewed_at: Date | null; created_at: Date;
}
export const claimContext = (row: Pick<ClaimRow, "id" | "tenant_id" | "project_id" | "version">) => `claim:${row.tenant_id}:${row.project_id}:${row.id}:v${row.version}`;
export const claimPrivate = (row: ClaimRow): ClaimPrivateData => openPrivate(row.encrypted_data, claimContext(row));
export async function requireClaim(session: Session, id: string, tx: SqlConnection = database(), lock = false): Promise<ClaimRow> {
  await requireCurrentRole(session, session.role, tx);
  const [row] = await query<ClaimRow>(`SELECT * FROM fp_claims WHERE id=$1 AND tenant_id=$2 AND project_id=$3${lock ? " FOR UPDATE" : ""}`, [id, session.tenantId, session.projectId], tx);
  if (!row || !(session.role === "organizer" || (session.role === "volunteer" && row.actor_id === session.actorId))) throw new DomainError("CLAIM_NOT_FOUND", "This expense is not available in your current view.", 404);
  return row;
}
async function projectClaimLock(tx: SqlConnection, projectId: string) {
  // One order for duplicate grouping, reviews and payable approvals prevents a split receipt race.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`claims:${projectId}`]);
}
export { projectClaimLock };
async function ensureReceiptGroup(tx: SqlConnection, session: Session, document: DocumentRow): Promise<string> {
  const [existing] = await query<{ group_id: string }>("SELECT group_id FROM fp_receipt_group_documents WHERE document_id=$1", [document.id], tx);
  if (existing) return existing.group_id;
  const exact = await query<{ group_id: string }>("SELECT DISTINCT g.group_id FROM fp_receipt_group_documents g JOIN fp_documents d ON d.id=g.document_id WHERE d.tenant_id=$1 AND d.project_id=$2 AND d.sha256=$3 AND d.state='ready'", [session.tenantId, session.projectId, document.sha256], tx);
  if (exact.length > 1) throw new DomainError("DUPLICATE_GROUP_UNRESOLVED", "Identical sources belong to different receipt groups. Resolve the earlier claims before continuing.", 409);
  const groupId = exact[0]?.group_id ?? randomUUID();
  if (!exact.length) await tx.query("INSERT INTO fp_receipt_groups(id,tenant_id,project_id) VALUES($1,$2,$3)", [groupId, session.tenantId, session.projectId]);
  await tx.query("INSERT INTO fp_receipt_group_documents(document_id,group_id,association_reason,linked_by) VALUES($1,$2,$3,$4)", [document.id, groupId, exact.length ? "exact_bytes" : "original_source", session.actorId]);
  return groupId;
}
async function recordRevision(tx: SqlConnection, row: ClaimRow, actor: Pick<Session, "actorId" | "role">) {
  await tx.query("INSERT INTO fp_claim_revisions(claim_id,version,actor_id,role,state,encrypted_data) VALUES($1,$2,$3,$4,$5,$6)", [row.id, row.version, actor.actorId, actor.role, row.state, row.encrypted_data]);
}
export async function claimView(session: Session, id: string): Promise<ClaimView> {
  const row = await requireClaim(session, id), data = claimPrivate(row);
  const document = await requireDocument(session, row.document_id);
  const [group] = await query<{ reviewed_total_minor: string | null; other_approved: string }>("SELECT reviewed_total_minor,(SELECT COALESCE(sum(approved_minor),0) FROM fp_claims WHERE group_id=g.id AND id<>$2 AND state IN ('reviewed','approved','paying','payout_review','partially_paid','paid')) AS other_approved FROM fp_receipt_groups g WHERE id=$1", [row.group_id, row.id]);
  return { id: row.id, version: row.version, state: row.state, title: data.title, note: data.note,
    own: row.actor_id === session.actorId, document: documentView(document), sourceRunId: row.source_run_id,
    currency: row.currency, requestedMinor: Number(row.requested_minor), approvedMinor: Number(row.approved_minor),
    lines: data.lines.map(line => ({ ...line, attentionReason: claimLineAttentionReason(line, data.extraction) })), extraction: data.extraction, extractionValidation: data.extractionValidation, sourceOutputHash: data.sourceOutputHash,
    review: data.review, createdAt: row.created_at.toISOString(), reviewedAt: row.reviewed_at?.toISOString() ?? null,
    groupReviewedTotalMinor: group.reviewed_total_minor === null ? null : Number(group.reviewed_total_minor), groupOtherApprovedMinor: Number(group.other_approved) };
}
export async function claimsView(session: Session): Promise<ClaimView[]> {
  await requireCurrentRole(session, session.role);
  if (!["volunteer", "organizer"].includes(session.role)) return [];
  const rows = await query<{ id: string }>("SELECT id FROM fp_claims WHERE tenant_id=$1 AND project_id=$2 AND ($3::boolean OR actor_id=$4) ORDER BY created_at DESC LIMIT 100", [session.tenantId, session.projectId, session.role === "organizer", session.actorId]);
  return Promise.all(rows.map(row => claimView(session, row.id)));
}
export async function createClaim(session: Session, input: { documentId: string; runId: string | null; intentId: string }): Promise<ClaimView> {
  await requireCurrentRole(session, "volunteer");
  const document = await requireDocument(session, input.documentId);
  if (document.actor_id !== session.actorId || document.state !== "ready" || document.purpose !== "receipt" || !document.sha256) throw new DomainError("CLAIM_SOURCE_REQUIRED", "Choose one of your validated receipt documents.", 409);
  const run = input.runId ? (await receiptRuns(session, document.id)).find(run => run.id === input.runId) : null;
  if (input.runId && (!run || run.state !== "succeeded" || !run.extraction)) throw new DomainError("EXTRACTION_NOT_READY", "This receipt proposal is not ready. You can still create a manual draft.", 409);
  const source = run?.extraction ?? null;
  const data: ClaimPrivateData = { title: source?.vendor ? `Expense at ${source.vendor}` : "New expense", note: "",
    sourceHash: document.sha256, sourceDocumentVersion: document.version, sourceOutputHash: run?.outputHash ?? null,
    extraction: source, extractionValidation: run?.validation ?? null, requesterTotalMinor: source?.totalMinor ?? 0, review: null,
    lines: source?.lines.map((line, index) => ({ id: `line-${index + 1}`, description: line.description, sourceIndex: index,
      sourceRegion: line.sourceRegion, extractedMinor: line.totalMinor, requestedMinor: Math.max(0, line.totalMinor ?? 0),
      packageId: line.suggestedPackageId, needsAttention: line.needsReview || line.totalMinor === null || !line.suggestedPackageId,
      attentionReason: line.reviewReason, decision: "unreviewed", reviewedSourceMinor: null, approvedMinor: 0,
      receiptLineKey: String(index + 1), reviewNote: null })) ?? [{ id: "line-1", description: "Describe the purchase", sourceIndex: null,
      sourceRegion: null, extractedMinor: null, requestedMinor: 0, packageId: null, needsAttention: true, attentionReason: "Entered manually; compare with the source.",
      decision: "unreviewed", reviewedSourceMinor: null, approvedMinor: 0, receiptLineKey: "1", reviewNote: null }] };
  const id = await database().transaction(async tx => {
    await requireCurrentRole(session, "volunteer", tx);
    await projectClaimLock(tx, session.projectId);
    const [existing] = await query<ClaimRow>("SELECT * FROM fp_claims WHERE tenant_id=$1 AND actor_id=$2 AND intent_id=$3", [session.tenantId, session.actorId, input.intentId], tx);
    if (existing) {
      if (existing.project_id !== session.projectId || existing.document_id !== input.documentId || existing.source_run_id !== input.runId) throw new DomainError("CLAIM_INTENT_CHANGED", "This draft already refers to a different source.", 409);
      return existing.id;
    }
    const groupId = await ensureReceiptGroup(tx, session, document), id = randomUUID();
    const encrypted = sealPrivate(data, claimContext({ id, tenant_id: session.tenantId, project_id: session.projectId, version: 1 }));
    const [created] = await query<ClaimRow>("INSERT INTO fp_claims(id,tenant_id,project_id,actor_id,document_id,group_id,intent_id,source_run_id,currency,requested_minor,encrypted_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *", [id, session.tenantId, session.projectId, session.actorId, document.id, groupId, input.intentId, input.runId, source?.currency ?? null, data.requesterTotalMinor, encrypted], tx);
    await recordRevision(tx, created, session);
    await appendEvent(tx, session, "claim.drafted", "An expense draft is ready", "The source and proposed lines are saved. The volunteer can correct them before requesting a review.");
    return id;
  });
  return claimView(session, id);
}
export async function saveClaimDraft(session: Session, id: string, raw: z.infer<typeof draftClaimSchema>, submit = false): Promise<ClaimView> {
  const input = draftClaimSchema.parse(raw);
  await database().transaction(async tx => {
    await requireCurrentRole(session, "volunteer", tx);
    await projectClaimLock(tx, session.projectId);
    const row = await requireClaim(session, id, tx, true), data = claimPrivate(row);
    if (row.actor_id !== session.actorId || !["draft", "submitted", "needs_review", "rejected", "reviewed"].includes(row.state)) throw new DomainError("CLAIM_LOCKED", "This claim has a payment approval or an unsettled payment. Resolve it before editing.", 409);
    if (row.version !== input.expectedVersion) throw new DomainError("CLAIM_VERSION_CHANGED", "A newer claim version is available. Reload it before editing.", 409);
    const ids = new Set(input.lines.map(line => line.id));
    if (ids.size !== input.lines.length || (data.extraction && (data.lines.length !== input.lines.length || data.lines.some(line => !ids.has(line.id))))) throw new DomainError("CLAIM_LINES_CHANGED", "Keep each extracted source line in the draft. Mark an unwanted line as zero instead of removing its history.", 422);
    const packages = await query<{ id: string }>("SELECT id FROM fp_packages WHERE project_id=$1", [session.projectId], tx);
    if (input.lines.some(line => line.packageId && !packages.some(p => p.id === line.packageId))) throw new DomainError("PACKAGE_UNKNOWN", "Choose a package from this project.", 422);
    if (submit && (!input.totalMinor || input.lines.reduce((sum, line) => sum + line.requestedMinor, 0) > input.totalMinor)) throw new DomainError("CLAIM_TOTAL_REVIEW", "Requested line amounts must fit within the stated receipt total. Explain discounts or tax in your note.", 422);
    const next: ClaimPrivateData = { ...data, title: input.title, note: input.note, requesterTotalMinor: input.totalMinor, review: null,
      lines: input.lines.map(line => { const previous = data.lines.find(value => value.id === line.id); return { ...previous,
        id: line.id, description: line.description, requestedMinor: line.requestedMinor, packageId: line.packageId,
        sourceIndex: previous?.sourceIndex ?? null, sourceRegion: previous?.sourceRegion ?? null, extractedMinor: previous?.extractedMinor ?? null,
        needsAttention: previous?.needsAttention ?? true, attentionReason: previous ? previous.attentionReason : "Entered manually; compare with the source.",
        decision: "unreviewed", reviewedSourceMinor: null, approvedMinor: 0, receiptLineKey: previous?.receiptLineKey ?? line.id, reviewNote: null }; }) };
    const version = row.version + 1, state = submit ? "submitted" : "draft";
    const [updated] = await query<ClaimRow>("UPDATE fp_claims SET version=$2,state=$3,currency=$4,requested_minor=$5,approved_minor=0,encrypted_data=$6,reviewed_at=NULL,reviewed_by=NULL,updated_at=now() WHERE id=$1 RETURNING *", [id, version, state, input.currency, input.totalMinor, sealPrivate(next, claimContext({ ...row, version }))], tx);
    await tx.query("DELETE FROM fp_claim_line_reviews WHERE claim_id=$1", [id]);
    await tx.query("UPDATE fp_approval_records SET revoked_at=now() WHERE tenant_id=$1 AND resource_id=$2 AND revoked_at IS NULL", [session.tenantId, id]);
    await recordRevision(tx, updated, session);
    await appendEvent(tx, session, submit ? "claim.submitted" : "claim.edited", submit ? "An expense is ready for review" : "An expense draft changed", "The current source and line amounts are saved. Earlier approval, if any, does not carry over to this version.");
  });
  return claimView(session, id);
}

async function joinReceiptGroups(tx: SqlConnection, session: Session, current: ClaimRow, otherDocument: DocumentRow): Promise<string> {
  const target = await ensureReceiptGroup(tx, session, otherDocument);
  if (target === current.group_id) return target;
  const oldClaims = await query<ClaimRow>("SELECT * FROM fp_claims WHERE group_id=$1 FOR UPDATE", [current.group_id], tx);
  if (oldClaims.some(claim => Number(claim.approved_minor) > 0 || ["approved", "paying", "payout_review", "partially_paid", "paid"].includes(claim.state)))
    throw new DomainError("DUPLICATE_GROUP_IN_USE", "This receipt group already has reviewed or paid claims. Resolve those claims before joining duplicate sources.", 409);
  await tx.query("UPDATE fp_receipt_group_documents SET group_id=$2,association_reason='reviewed_duplicate',linked_by=$3,linked_at=now() WHERE group_id=$1", [current.group_id, target, session.actorId]);
  for (const claim of oldClaims) {
    if (claim.id === current.id) { await tx.query("UPDATE fp_claims SET group_id=$2 WHERE id=$1", [claim.id, target]); continue; }
    const version = claim.version + 1;
    const [updated] = await query<ClaimRow>("UPDATE fp_claims SET group_id=$2,version=$3,encrypted_data=$4,updated_at=now() WHERE id=$1 RETURNING *", [claim.id, target, version, sealPrivate(claimPrivate(claim), claimContext({ ...claim, version }))], tx);
    await recordRevision(tx, updated, session);
  }
  return target;
}

export async function reviewClaim(session: Session, id: string, raw: z.infer<typeof reviewClaimSchema>): Promise<ClaimView> {
  const input = reviewClaimSchema.parse(raw);
  await requireCurrentRole(session, "organizer");
  const before = await requireClaim(session, id), document = await requireDocument(session, before.document_id);
  const candidates = await receiptComparisons(session, document.id);
  // The document and claim scope is rechecked below; candidate decisions are also persisted as review evidence.
  for (const candidate of candidates) {
    const decision = input.duplicateResolutions.find(value => value.documentId === candidate.documentId);
    if (!decision) throw new DomainError("DUPLICATE_REVIEW_REQUIRED", "Compare each possible duplicate and record whether it is the same purchase.", 409);
    if (candidate.exactByteMatch && decision.decision !== "same_receipt") throw new DomainError("EXACT_DUPLICATE", "Identical source bytes must share one receipt budget. A legitimate split can use that shared budget.", 422);
  }
  await database().transaction(async tx => {
    await requireCurrentRole(session, "organizer", tx);
    await projectClaimLock(tx, session.projectId);
    let row = await requireClaim(session, id, tx, true);
    if (row.version !== input.expectedVersion) throw new DomainError("CLAIM_VERSION_CHANGED", "A newer claim version is available. Reload it before reviewing.", 409);
    if (!["submitted", "needs_review", "reviewed", "rejected"].includes(row.state)) throw new DomainError("CLAIM_NOT_REVIEWABLE", "Submit the draft for review first. A claim with a payment in progress cannot be edited.", 409);
    const data = claimPrivate(row), source = await requireDocument(session, row.document_id, tx);
    if (source.state !== "ready" || source.version !== data.sourceDocumentVersion || source.sha256 !== data.sourceHash) throw new DomainError("SOURCE_CHANGED", "The claim source changed. Start a new review from the current document.", 409);
    if (source.provenance === "sample_document" && !input.sampleAcknowledged) throw new DomainError("SAMPLE_ACK_REQUIRED", "This is a fictional receipt. Acknowledge that any repayment is a sandbox test.", 422);
    if ((row.currency !== "USD" || data.extraction?.currency && data.extraction.currency !== "USD") && !input.currencyCorrectionNote)
      throw new DomainError("CLAIM_CURRENCY_REVIEW", "This source is not recorded as USD. Foreign-currency conversion is unavailable. Only correct a misread currency after checking that the printed source is actually USD, with an explicit reason.", 422);
    const approved = validateClaimReview(data, input);
    for (const decision of input.duplicateResolutions) {
      if (decision.documentId === source.id) throw new DomainError("DUPLICATE_SELF", "Compare the receipt with a different source.", 422);
      const other = await requireDocument(session, decision.documentId, tx);
      if (other.state !== "ready" || other.purpose !== "receipt") throw new DomainError("DUPLICATE_SOURCE_INVALID", "Compare only validated receipt sources.", 422);
      if (source.sha256 === other.sha256 && decision.decision !== "same_receipt") throw new DomainError("EXACT_DUPLICATE", "Identical source bytes must share one receipt budget.", 422);
      if (decision.decision === "same_receipt") {
        const groupId = await joinReceiptGroups(tx, session, row, other);
        row = { ...row, group_id: groupId };
      }
      const comparisonId = randomUUID(), [a, b] = [source.id, other.id].sort();
      const evidence = { reason: decision.reason, sourceHash: source.sha256, otherHash: other.sha256, candidate: candidates.find(candidate => candidate.documentId === other.id) ?? null };
      await tx.query("INSERT INTO fp_receipt_comparison_decisions(id,tenant_id,project_id,document_a,document_b,decision,encrypted_data,reviewed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [comparisonId, session.tenantId, session.projectId, a, b, decision.decision, sealPrivate(evidence, `receipt-comparison:${session.tenantId}:${comparisonId}`), session.actorId]);
    }
    const [group] = await query<{ reviewed_total_minor: string | null; currency: string | null }>("SELECT reviewed_total_minor,currency FROM fp_receipt_groups WHERE id=$1 FOR UPDATE", [row.group_id], tx);
    const [prior] = await query<{ count: string; approved: string }>("SELECT count(*) AS count,COALESCE(sum(approved_minor),0) AS approved FROM fp_claims WHERE group_id=$1 AND id<>$2 AND state IN ('reviewed','approved','paying','payout_review','partially_paid','paid') AND approved_minor>0", [row.group_id, row.id], tx);
    if (Number(prior.count) > 0 && !input.receiptSplit) throw new DomainError("RECEIPT_SPLIT_REQUIRED", "This receipt already supports another claim. Record an explicit legitimate split before approving another portion.", 409);
    if (Number(prior.approved) + approved > input.sourceTotalMinor) throw new DomainError("RECEIPT_ALREADY_CLAIMED", "The combined approved claims would exceed this receipt's reviewed total.", 409);
    if (group.reviewed_total_minor !== null && (Number(group.reviewed_total_minor) !== input.sourceTotalMinor || group.currency !== input.currency)) throw new DomainError("RECEIPT_TOTAL_CHANGED", "This receipt already has a reviewed total. Resolve the earlier review before changing that shared amount.", 409);
    const packages = await query<{ id: string; version: number }>("SELECT id,version FROM fp_packages WHERE project_id=$1", [session.projectId], tx);
    await tx.query("DELETE FROM fp_claim_line_reviews WHERE claim_id=$1", [id]);
    for (const line of input.lines) {
      const pkg = packages.find(pkg => pkg.id === line.packageId);
      if (line.packageId && !pkg) throw new DomainError("PACKAGE_UNKNOWN", "Each line must use a package from this project.", 422);
      const [sourceLine] = await query<{ source_minor: string }>("SELECT source_minor FROM fp_receipt_group_lines WHERE group_id=$1 AND line_key=$2", [row.group_id, line.receiptLineKey], tx);
      if (sourceLine && Number(sourceLine.source_minor) !== line.sourceMinor) throw new DomainError("RECEIPT_LINE_CHANGED", "A shared purchase line already has a different reviewed amount. Keep the canonical line reference and resolve its earlier review.", 409);
      const [lineUse] = await query<{ total: string }>("SELECT COALESCE(sum(l.approved_minor),0) AS total FROM fp_claim_line_reviews l JOIN fp_claims c ON c.id=l.claim_id WHERE l.group_id=$1 AND l.receipt_line_key=$2 AND c.id<>$3 AND c.state IN ('reviewed','approved','paying','payout_review','partially_paid','paid')", [row.group_id, line.receiptLineKey, id], tx);
      if (Number(lineUse.total) + line.approvedMinor > line.sourceMinor) throw new DomainError("RECEIPT_LINE_ALREADY_CLAIMED", "This purchase line has already been approved in another claim. Only its remaining portion can be reimbursed.", 409);
      await tx.query("INSERT INTO fp_receipt_group_lines(group_id,line_key,source_minor) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [row.group_id, line.receiptLineKey, line.sourceMinor]);
      await tx.query("INSERT INTO fp_claim_line_reviews(claim_id,claim_line_id,group_id,receipt_line_key,package_id,package_version,source_minor,approved_minor,decision,review_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [id, line.id, row.group_id, line.receiptLineKey, line.packageId, pkg?.version ?? null, line.sourceMinor, line.approvedMinor, line.decision, row.version + 1]);
    }
    const [sourceSum] = await query<{ total: string }>("SELECT COALESCE(sum(source_minor),0) AS total FROM fp_receipt_group_lines WHERE group_id=$1", [row.group_id], tx);
    if (Number(sourceSum.total) > input.sourceTotalMinor) throw new DomainError("RECEIPT_LINE_REFERENCES", "The combined source line references exceed the receipt total. Match a split to its existing purchase lines.", 409);
    const version = row.version + 1, reviewedAt = new Date().toISOString();
    const next: ClaimPrivateData = { ...data, lines: input.lines.map(line => ({ ...data.lines.find(value => value.id === line.id)!, description: line.description,
      packageId: line.packageId, decision: line.decision, reviewedSourceMinor: line.sourceMinor, approvedMinor: line.approvedMinor,
      receiptLineKey: line.receiptLineKey, reviewNote: line.reviewNote })), review: { sourceTotalMinor: input.sourceTotalMinor, note: input.note,
      reviewedAt, reviewerActorId: session.actorId, sampleAcknowledged: input.sampleAcknowledged, receiptSplit: input.receiptSplit, currencyCorrectionNote: input.currencyCorrectionNote ?? null, duplicateResolutions: input.duplicateResolutions } };
    const state = approved > 0 ? "reviewed" : input.lines.some(line => line.decision === "hold") ? "needs_review" : "rejected";
    await tx.query("UPDATE fp_receipt_groups SET reviewed_total_minor=$2,currency='USD',version=version+1 WHERE id=$1", [row.group_id, input.sourceTotalMinor]);
    const [updated] = await query<ClaimRow>("UPDATE fp_claims SET version=$2,state=$3,currency='USD',approved_minor=$4,encrypted_data=$5,reviewed_by=$6,reviewed_at=$7,updated_at=now() WHERE id=$1 RETURNING *", [id, version, state, approved, sealPrivate(next, claimContext({ ...row, version })), session.actorId, reviewedAt], tx);
    await tx.query("UPDATE fp_approval_records SET revoked_at=now() WHERE tenant_id=$1 AND resource_id=$2 AND revoked_at IS NULL", [session.tenantId, id]);
    await recordRevision(tx, updated, session);
    await appendEvent(tx, session, "claim.reviewed", approved > 0 ? "An expense review is recorded" : "An expense needs another look", `${input.lines.filter(line => line.decision === "approved").length} lines approved; ${input.lines.filter(line => line.decision === "hold").length} held. A separate exact payment approval is still required.`);
  });
  return claimView(session, id);
}
