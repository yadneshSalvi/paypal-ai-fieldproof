import { createHash, randomUUID } from "node:crypto";
import type { SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import { bindProjectPolicyArtifacts, enforceProjectEvidenceDecision } from "./project-policy";
import { alignmentInputSchema, alignmentReviewSchema, alignmentRevokeSchema, qualificationInputSchema, qualificationReviewSchema, signoffInputSchema,
  type AlignmentView, type CompetencyScope, type PackageReadiness, type PlanSourceBinding, type QualificationView, type SignoffView } from "../planning/contracts";
import { pointInPolygon, solveAffine } from "../planning/geometry";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { database, query } from "./db";
import { requireCurrentRole } from "./membership";
import { openPrivate, sealPrivate } from "./private-values";
import { appendEvent } from "./repository";
import { currentSourceCheck, lockPlanningAuthority, planPayload, planningAction, planningHash, planningHead, publishedPlan, sourceBindings, type PlanPayload, type PlanRow } from "./planning-store";
import { assertPlanningSourceOwner, planningDocumentStorage } from "./planning-sources";
import type { DocumentStorage } from "./document-storage";
import { prepareAlignmentImage, validImageRegion, type SharedAlignmentImage } from "./planning-images";
import { permittedReviewerScopes } from "./planning-reviewer-access";

interface AlignmentData { anchors: AlignmentView["anchors"]; matrix: AlignmentView["matrix"]; residualRms: number; conditioning: number; source: PlanSourceBinding; planHash: string; note: string;
  sourcePage: number; imageSharing: AlignmentView["imageSharing"]; displayCrop: AlignmentView["displayCrop"]; redactions: AlignmentView["redactions"]; sharedImage: SharedAlignmentImage; }
interface AlignmentRow { id: string; tenant_id: string; project_id: string; plan_id: string; package_id: string; document_id: string; author_id: string; revision: number; content_hash: string; encrypted_data: string; state: "draft" | "reviewed" | "revoked"; reviewed_by: string | null; reviewed_at: Date | null; created_at: Date; }
interface QualificationData { displayName: string; basis: string; reviewNote?: string; reviewAuthority?: { actorId: string; version: number }; source: PlanSourceBinding; }
interface QualificationRow { id: string; tenant_id: string; project_id: string; actor_id: string; scope: CompetencyScope; document_id: string; source_hash: string; control_version: number; state: "pending" | "verified" | "revoked"; version: number; membership_version: number; provenance: "sample" | "reviewer_attested"; encrypted_data: string; valid_until: Date; reviewed_by: string | null; reviewed_at: Date | null; created_at: Date; }
interface SignoffData { sourceBindings: PlanSourceBinding[]; planHash: string; scope: CompetencyScope; statement: string; limitations: string; observedAt: string; provenance: "sample" | "reviewer_attested"; }
interface SignoffRow { id: string; tenant_id: string; project_id: string; plan_id: string; package_id: string; requirement_id: string; qualification_id: string; qualification_version: number; actor_id: string; decision: SignoffView["decision"]; content_hash: string; encrypted_data: string; created_at: Date; }
const evidenceContext = (kind: string, row: { id: string; tenant_id: string; project_id: string }) => `${kind}:${row.tenant_id}:${row.project_id}:${row.id}`;
const scope = (session: Pick<Session, "tenantId" | "projectId">) => [session.tenantId, session.projectId];
async function currentPublished(session: Session, planId: string, hash: string, tx: SqlConnection): Promise<{ row: PlanRow; payload: PlanPayload }> {
  const published = await publishedPlan(session, tx);
  if (!published || published.row.id !== planId || published.row.content_hash !== hash || published.view.state !== "current") throw new DomainError("REVIEWED_PLAN_CHANGED", "Review the current published plan before associating evidence with it.", 409);
  // Hold every source permission row while accepting a decision about this version.
  if ((await currentSourceCheck(session, published.payload.sources, tx, true)).length) throw new DomainError("SOURCE_CHANGED", "A plan source changed. Review the plan again.", 409);
  return published;
}
export async function savePhotoAlignment(session: Session, raw: z.infer<typeof alignmentInputSchema>, storage: DocumentStorage = planningDocumentStorage()): Promise<{ id: string }> {
  const input = alignmentInputSchema.parse(raw);
  return database().transaction(async tx => {
    await lockPlanningAuthority(session, ["organizer"], tx);
    return planningAction(session, input.intentId, "photo-alignment", input, tx, async () => {
      await planningHead(session, tx, true);
      const plan = await currentPublished(session, input.planId, input.expectedPlanHash, tx);
      const zone = plan.payload.plan.zones.find(z => z.packageId === input.packageId);
      if (!zone || input.anchors.some(a => !pointInPolygon(a.plan, zone.polygon))) throw new DomainError("ANCHOR_OUTSIDE_PACKAGE", "Place the three plan anchors inside the selected package zone.", 422);
      const [source] = await sourceBindings(session, [input.documentId], tx, true);
      if (source.purpose !== "photo") throw new DomainError("PHOTO_SOURCE_REQUIRED", "Choose a validated photograph or labelled sample illustration.", 422);
      const policyRules = await enforceProjectEvidenceDecision(tx, session, input.packageId, [source], input.imageSharing);
      if (!source.pages.some(p => p.number === input.sourcePage) || !validImageRegion(input.displayCrop) || input.redactions.some(r => !validImageRegion(r))) throw new DomainError("IMAGE_REGION_INVALID", "Keep the crop and masks on one validated source page.", 422);
      if (input.anchors.some(a => a.photo.x < input.displayCrop.x || a.photo.x > input.displayCrop.x + input.displayCrop.width || a.photo.y < input.displayCrop.y || a.photo.y > input.displayCrop.y + input.displayCrop.height)) throw new DomainError("ANCHOR_OUTSIDE_CROP", "Keep all three chosen image landmarks inside the displayed crop.", 422);
      if (input.anchors.some(a => input.redactions.some(r => a.photo.x >= r.x && a.photo.x <= r.x + r.width && a.photo.y >= r.y && a.photo.y <= r.y + r.height))) throw new DomainError("ANCHOR_REDACTED", "Choose visible landmarks outside the redaction masks so the reviewed rendition retains all three anchors.", 422);
      let transform: ReturnType<typeof solveAffine>;
      try { transform = solveAffine(input.anchors); } catch (error) { throw new DomainError("ANCHORS_INVALID", error instanceof Error ? error.message : "These anchors cannot form a stable alignment.", 422); }
      const id = randomUUID(), sharedImage = await prepareAlignmentImage(session, id, source, input.sourcePage, input.displayCrop, input.redactions, storage);
      const data: AlignmentData = { ...transform, anchors: input.anchors, source, planHash: input.expectedPlanHash, note: input.note,
        sourcePage: input.sourcePage, imageSharing: input.imageSharing, displayCrop: input.displayCrop, redactions: input.redactions, sharedImage };
      const hash = planningHash(data);
      await tx.query(`INSERT INTO fp_photo_alignments(id,tenant_id,project_id,plan_id,package_id,document_id,author_id,revision,content_hash,encrypted_data)
        VALUES($1,$2,$3,$4,$5,$6,$7,(SELECT COALESCE(max(revision),0)+1 FROM fp_photo_alignments WHERE project_id=$3 AND package_id=$5),$8,$9)`,
        [id, ...scope(session), input.planId, input.packageId, input.documentId, session.actorId, hash, sealPrivate(data, evidenceContext("photo-alignment", { id, tenant_id: session.tenantId, project_id: session.projectId }))]);
      await bindProjectPolicyArtifacts(tx, policyRules, "image_review", `proposal:${id}`, hash, session, "materialized", ["This image association still requires its separate review."]);
      await appendEvent(tx, session, "planning.alignment_proposed", "Three landmarks connect an image to the plan", "The affine overlay is a draft association. A separate review is still needed; it does not certify installation or safety.");
      return { id };
    });
  });
}
export async function reviewPhotoAlignment(session: Session, id: string, raw: z.infer<typeof alignmentReviewSchema>): Promise<void> {
  const input = alignmentReviewSchema.parse(raw);
  await database().transaction(async tx => {
    await lockPlanningAuthority(session, ["organizer"], tx);
    await planningAction(session, input.intentId, "photo-alignment-review", { id, ...input }, tx, async () => {
      await planningHead(session, tx, true);
      const [row] = await query<AlignmentRow>("SELECT * FROM fp_photo_alignments WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR UPDATE", [id, ...scope(session)], tx);
      if (!row) throw new DomainError("ALIGNMENT_NOT_FOUND", "This image alignment is unavailable.", 404);
      if (row.state !== "draft" || row.revision !== input.expectedRevision || row.content_hash !== input.contentHash) throw new DomainError("ALIGNMENT_CHANGED", "The alignment changed or was already reviewed. Open its latest saved version.", 409);
      const data = openPrivate<AlignmentData>(row.encrypted_data, evidenceContext("photo-alignment", row));
      if (planningHash(data) !== row.content_hash) throw new DomainError("ALIGNMENT_INTEGRITY", "The saved anchors could not be verified.", 409);
      if (data.imageSharing === "project_members" && !input.sharedImageConfirmed) throw new DomainError("SHARED_IMAGE_REVIEW_REQUIRED", "Check the exact cropped and masked image before sharing it with project members.", 422);
      await currentPublished(session, row.plan_id, data.planHash, tx);
      if ((await currentSourceCheck(session, [data.source], tx, true)).length) throw new DomainError("SOURCE_CHANGED", "The photo or its permission changed. Create a new alignment.", 409);
      const policyRules = await enforceProjectEvidenceDecision(tx, session, row.package_id, [data.source], data.imageSharing);
      solveAffine(data.anchors);
      // A later reviewed association replaces the earlier one; draft experiments do not.
      await tx.query("UPDATE fp_photo_alignments SET state='revoked' WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 AND state='reviewed'", [...scope(session), row.package_id]);
      await tx.query("UPDATE fp_photo_alignments SET state='reviewed',reviewed_by=$2,reviewed_at=now() WHERE id=$1", [id, session.actorId]);
      await bindProjectPolicyArtifacts(tx, policyRules, "image_review", id, row.content_hash, session);
      await appendEvent(tx, session, "planning.alignment_reviewed", "An image association was reviewed", "A person confirmed the three chosen landmarks. The interpolation residual is not a measure of real-world accuracy, location, completion, or safety.");
      return { id };
    });
  });
}
export async function alignmentViews(session: Session, tx: SqlConnection = database(), internal = false): Promise<AlignmentView[]> {
  const published = await publishedPlan(session, tx);
  const rows = await query<AlignmentRow>("SELECT * FROM fp_photo_alignments WHERE tenant_id=$1 AND project_id=$2 ORDER BY created_at DESC,id", scope(session), tx);
  const output: AlignmentView[] = [];
  for (const row of rows) {
    const data = openPrivate<AlignmentData>(row.encrypted_data, evidenceContext("photo-alignment", row));
    if (planningHash(data) !== row.content_hash) throw new DomainError("ALIGNMENT_INTEGRITY", "An image association could not be verified.", 409);
    const valid = !!published && published.view.state === "current" && published.row.id === row.plan_id && published.row.content_hash === data.planHash && !(await currentSourceCheck(session, [data.source], tx)).length;
    const [document] = await query<{ actor_id: string }>("SELECT actor_id FROM fp_documents WHERE id=$1 AND tenant_id=$2 AND project_id=$3", [row.document_id, ...scope(session)], tx);
    const sourceAllowed = session.role === "organizer" || (session.role === "volunteer" && document?.actor_id === session.actorId);
    const sharedAllowed = valid && row.state === "reviewed" && data.imageSharing === "project_members";
    if (!internal && !sourceAllowed && !sharedAllowed) continue;
    output.push({ id: row.id, revision: row.revision, planId: row.plan_id, packageId: row.package_id, documentId: sourceAllowed ? row.document_id : null,
      documentVersion: data.source.documentVersion, sourceHash: data.source.contentHash, planHash: data.planHash, contentHash: row.content_hash,
      sourcePage: data.sourcePage, imageSharing: data.imageSharing, displayCrop: data.displayCrop, redactions: sourceAllowed ? data.redactions : [], sharedPreviewHash: sourceAllowed || sharedAllowed ? data.sharedImage.sha256 : null,
      anchors: data.anchors, matrix: data.matrix, residualRms: data.residualRms, conditioning: data.conditioning,
      state: row.state === "revoked" ? "revoked" : valid ? row.state : "stale", sourceClass: data.source.provenance === "sample_document" ? "sample_illustration" : "submitted_photo",
      previewUrl: valid && (sourceAllowed || sharedAllowed) && row.state !== "revoked" ? `/api/planning/alignments/${row.id}/image` : null,
      reviewedAt: row.reviewed_at?.toISOString() ?? null, reviewerLabel: row.reviewed_by ? "Project organizer" : null, createdAt: row.created_at.toISOString(), note: sourceAllowed ? data.note : "Reviewed image association" });
  }
  return output;
}
export async function sharedAlignmentImage(session: Session, id: string, storage: DocumentStorage = planningDocumentStorage()): Promise<Buffer> {
  await requireCurrentRole(session, session.role);
  const [row] = await query<AlignmentRow>("SELECT * FROM fp_photo_alignments WHERE id=$1 AND tenant_id=$2 AND project_id=$3", [id, ...scope(session)]);
  if (!row || row.state === "revoked") throw new DomainError("ALIGNMENT_IMAGE_UNAVAILABLE", "This reviewed image is no longer shared.", 404);
  const data = openPrivate<AlignmentData>(row.encrypted_data, evidenceContext("photo-alignment", row));
  const [document] = await query<{ actor_id: string }>("SELECT actor_id FROM fp_documents WHERE id=$1 AND tenant_id=$2 AND project_id=$3", [row.document_id, ...scope(session)]);
  const sourceAllowed = session.role === "organizer" || (session.role === "volunteer" && document?.actor_id === session.actorId);
  if (!sourceAllowed && (data.imageSharing !== "project_members" || row.state !== "reviewed")) throw new DomainError("ALIGNMENT_IMAGE_UNAVAILABLE", "This image is restricted to its reviewers.", 404);
  const published = await publishedPlan(session);
  if (planningHash(data) !== row.content_hash || !published || published.view.state !== "current" || published.row.id !== row.plan_id || published.row.content_hash !== data.planHash || (await currentSourceCheck(session, [data.source], database())).length) throw new DomainError("ALIGNMENT_IMAGE_UNAVAILABLE", "The plan or source changed after this image was reviewed.", 404);
  const image = await storage.read(data.sharedImage.pathname, 20 * 1024 * 1024);
  if (image.contentType !== "image/png" || createHash("sha256").update(image.bytes).digest("hex") !== data.sharedImage.sha256) throw new DomainError("ALIGNMENT_IMAGE_INTEGRITY", "The reviewed image no longer matches its saved bytes.", 409);
  // Storage can take time. Recheck sharing, permission and the plan at the final authorization cutoff.
  await database().transaction(async tx => {
    await lockPlanningAuthority(session, [session.role], tx);
    const [current] = await query<AlignmentRow>("SELECT * FROM fp_photo_alignments WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR SHARE", [id, ...scope(session)], tx);
    const latest = await publishedPlan(session, tx);
    if (!current || current.state === "revoked" || current.content_hash !== row.content_hash || (!sourceAllowed && current.state !== "reviewed")
      || !latest || latest.view.state !== "current" || latest.row.id !== row.plan_id || latest.row.content_hash !== data.planHash
      || (await currentSourceCheck(session, [data.source], tx, true)).length) throw new DomainError("ALIGNMENT_IMAGE_UNAVAILABLE", "This image's sharing or source permission changed while it was loading.", 404);
  });
  return image.bytes;
}
export async function revokePhotoAlignment(session: Session, id: string, raw: z.infer<typeof alignmentRevokeSchema>): Promise<void> {
  const input = alignmentRevokeSchema.parse(raw);
  await database().transaction(async tx => {
    await lockPlanningAuthority(session, ["organizer"], tx);
    await planningAction(session, input.intentId, "photo-alignment-revoke", { id, ...input }, tx, async () => {
      await planningHead(session, tx, true);
      const [row] = await query<AlignmentRow>("SELECT * FROM fp_photo_alignments WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR UPDATE", [id, ...scope(session)], tx);
      if (!row || row.revision !== input.expectedRevision || row.content_hash !== input.contentHash) throw new DomainError("ALIGNMENT_CHANGED", "Refresh this alignment before withdrawing it.", 409);
      await tx.query("UPDATE fp_photo_alignments SET state='revoked' WHERE id=$1", [id]);
      await appendEvent(tx, session, "planning.alignment_withdrawn", "An image association was withdrawn", "The original review remains in history. The shared image and its physical-evidence contribution are no longer current.");
      return { id };
    });
  });
}
async function qualificationState(session: Pick<Session, "tenantId" | "projectId">, row: QualificationRow, tx: SqlConnection, lock = false, at = Date.now()): Promise<{ valid: boolean; reason: string | null }> {
  if (row.state !== "verified") return { valid: false, reason: row.state === "revoked" ? "The reviewer scope was revoked." : "The reviewer scope has not been verified." };
  if (row.valid_until.getTime() <= at) return { valid: false, reason: "The reviewer scope expired." };
  const data = openPrivate<QualificationData>(row.encrypted_data, evidenceContext("reviewer-qualification", row));
  const [member] = await query<{ state: string; version: number; roles: string[] }>(`SELECT state,version,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3${lock ? " FOR SHARE" : ""}`, [...scope(session), row.actor_id], tx);
  if (!member || member.state !== "active" || member.version !== row.membership_version || !member.roles.some(r => ["volunteer", "organizer"].includes(r))) return { valid: false, reason: "The reviewer's project authority changed." };
  if (!data.reviewAuthority) return { valid: false, reason: "The organizer's verification is missing." };
  const [issuer] = await query<{ state: string; version: number; roles: string[] }>(`SELECT state,version,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3${lock ? " FOR SHARE" : ""}`, [...scope(session), data.reviewAuthority.actorId], tx);
  if (!issuer || issuer.state !== "active" || issuer.version !== data.reviewAuthority.version || !issuer.roles.includes("organizer")) return { valid: false, reason: "The authority that verified this scope changed." };
  const changed = await currentSourceCheck(session, [data.source], tx, lock);
  return { valid: !changed.length, reason: changed[0] ?? null };
}
export async function requestReviewerQualification(session: Session, raw: z.infer<typeof qualificationInputSchema>): Promise<{ id: string }> {
  const input = qualificationInputSchema.parse(raw);
  return database().transaction(async tx => {
    const version = await lockPlanningAuthority(session, ["organizer", "volunteer"], tx);
    return planningAction(session, input.intentId, "reviewer-qualification", input, tx, async () => {
      if (!(await permittedReviewerScopes(session, tx)).includes(input.scope)) throw new DomainError("REVIEWER_SCOPE_DENIED", "This temporary reviewer invitation does not include that competence. Ask the organizer for the appropriate scope.", 403);
      await assertPlanningSourceOwner(session, input.documentId, tx);
      const [source] = await sourceBindings(session, [input.documentId], tx, true);
      if (source.purpose !== "signoff") throw new DomainError("QUALIFICATION_SOURCE_REQUIRED", "Upload a private source describing your relevant reviewer credentials and scope.", 422);
      const sample = source.provenance === "sample_document";
      if (sample && (session.mode !== "sample" || !input.sampleAcknowledged)) throw new DomainError("SAMPLE_QUALIFICATION_ONLY", "A sample credential can only demonstrate this workflow in a sample workspace.", 422);
      const expiry = Date.parse(input.validUntil);
      if (expiry <= Date.now() || expiry > Date.now() + 366 * 86400_000) throw new DomainError("QUALIFICATION_EXPIRY", "Choose a future expiry within the next year, no later than the source credentials permit.", 422);
      const id = randomUUID(), data: QualificationData = { displayName: input.displayName, basis: input.basis, source };
      await tx.query(`INSERT INTO fp_reviewer_qualifications(id,tenant_id,project_id,actor_id,scope,document_id,source_hash,control_version,membership_version,provenance,encrypted_data,valid_until)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, ...scope(session), session.actorId, input.scope, input.documentId, source.contentHash, source.controlVersion, version, sample ? "sample" : "reviewer_attested",
        sealPrivate(data, evidenceContext("reviewer-qualification", { id, tenant_id: session.tenantId, project_id: session.projectId })), input.validUntil]);
      await appendEvent(tx, session, "planning.reviewer_scope_requested", "A reviewer asked for a specific scope", "An organizer must check the submitted credentials before that person can accept work in this scope.");
      return { id };
    });
  });
}
export async function reviewReviewerQualification(session: Session, id: string, raw: z.infer<typeof qualificationReviewSchema>): Promise<void> {
  const input = qualificationReviewSchema.parse(raw);
  await database().transaction(async tx => {
    const organizerVersion = await lockPlanningAuthority(session, ["organizer"], tx);
    await planningAction(session, input.intentId, "reviewer-qualification-review", { id, ...input }, tx, async () => {
      const [row] = await query<QualificationRow>("SELECT * FROM fp_reviewer_qualifications WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR UPDATE", [id, ...scope(session)], tx);
      if (!row) throw new DomainError("QUALIFICATION_NOT_FOUND", "This reviewer request is outside your project.", 404);
      if (row.version !== input.expectedVersion) throw new DomainError("QUALIFICATION_CHANGED", "This reviewer scope changed. Refresh it before recording another decision.", 409);
      const data = openPrivate<QualificationData>(row.encrypted_data, evidenceContext("reviewer-qualification", row));
      if (input.decision === "verified") {
        if (row.state !== "pending") throw new DomainError("QUALIFICATION_NEW_REQUEST", "A changed or revoked scope requires a new credential request.", 409);
        if (row.provenance === "sample" && (session.mode !== "sample" || !input.sampleAcknowledged)) throw new DomainError("SAMPLE_QUALIFICATION_ONLY", "Confirm that this is a sample workflow exercise.", 422);
        if (row.provenance !== "sample" && row.actor_id === session.actorId) throw new DomainError("INDEPENDENT_QUALIFICATION_REVIEW", "A different project organizer must check your reviewer credentials. Self-verification cannot authorize a physical sign-off.", 403);
        if (row.valid_until.getTime() <= Date.now() || (await currentSourceCheck(session, [data.source], tx, true)).length) throw new DomainError("QUALIFICATION_SOURCE_CHANGED", "The credentials expired or their source changed. Request a new review.", 409);
      }
      const [member] = await query<{ state: string; version: number; roles: string[] }>("SELECT state,version,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 FOR SHARE", [...scope(session), row.actor_id], tx);
      if (!member || member.state !== "active" || !member.roles.some(r => ["volunteer", "organizer"].includes(r))) throw new DomainError("REVIEWER_AUTHORITY_CHANGED", "This person is no longer an active project reviewer.", 403);
      data.reviewNote = input.note; data.reviewAuthority = { actorId: session.actorId, version: organizerVersion };
      await tx.query("UPDATE fp_reviewer_qualifications SET state=$2,version=version+1,membership_version=$3,reviewed_by=$4,reviewed_at=now(),encrypted_data=$5 WHERE id=$1", [id, input.decision, member.version, session.actorId, sealPrivate(data, evidenceContext("reviewer-qualification", row))]);
      await appendEvent(tx, session, "planning.reviewer_scope_reviewed", input.decision === "verified" ? "A bounded reviewer scope was verified" : "A reviewer scope was revoked", "The decision applies only to the named competence, source version and expiry. It does not accept any package by itself.");
      return { id, version: row.version + 1, decision: input.decision };
    });
  });
}
export async function qualificationViews(session: Session, tx: SqlConnection = database()): Promise<QualificationView[]> {
  if (!["organizer", "volunteer"].includes(session.role)) return [];
  const rows = await query<QualificationRow>("SELECT * FROM fp_reviewer_qualifications WHERE tenant_id=$1 AND project_id=$2 AND ($3::boolean OR actor_id=$4) ORDER BY created_at DESC,id", [...scope(session), session.role === "organizer", session.actorId], tx);
  const views: QualificationView[] = [];
  for (const row of rows) {
    const data = openPrivate<QualificationData>(row.encrypted_data, evidenceContext("reviewer-qualification", row));
    const current = await qualificationState(session, row, tx);
    views.push({ id: row.id, actorId: row.actor_id, scope: row.scope, state: row.state === "verified" && !current.valid ? row.valid_until.getTime() <= Date.now() ? "expired" : "stale" : row.state, stateReason: current.reason,
      version: row.version, displayName: data.displayName, basis: data.basis, documentId: row.document_id, validUntil: row.valid_until.toISOString(), provenance: row.provenance, isOwn: row.actor_id === session.actorId, reviewedAt: row.reviewed_at?.toISOString() ?? null });
  }
  return views;
}
export async function recordWorkSignoff(session: Session, raw: z.infer<typeof signoffInputSchema>): Promise<{ id: string }> {
  const input = signoffInputSchema.parse(raw);
  return database().transaction(async tx => {
    await lockPlanningAuthority(session, ["organizer", "volunteer"], tx);
    return planningAction(session, input.intentId, "work-signoff", input, tx, async () => {
      await planningHead(session, tx, true);
      const plan = await currentPublished(session, input.planId, input.expectedPlanHash, tx);
      const requirement = plan.payload.plan.packages.find(p => p.packageId === input.packageId)?.requirements.find(r => r.id === input.requirementId);
      if (!requirement?.scope) throw new DomainError("SIGNOFF_SCOPE_REQUIRED", "Choose a physical review requirement. Image association is a separate three-anchor review.", 422);
      const [qualification] = await query<QualificationRow>("SELECT * FROM fp_reviewer_qualifications WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR SHARE", [input.qualificationId, ...scope(session)], tx);
      if (!qualification || qualification.actor_id !== session.actorId || qualification.scope !== requirement.scope || qualification.version !== input.qualificationVersion) throw new DomainError("SIGNOFF_AUTHORITY", "This sign-off requires your own current verified competence for this exact scope.", 403);
      const status = await qualificationState(session, qualification, tx, true);
      if (!status.valid) throw new DomainError("SIGNOFF_AUTHORITY", status.reason!, 403);
      if (Date.parse(input.observedAt) > Date.now() + 5 * 60_000) throw new DomainError("SIGNOFF_FUTURE", "The inspection time cannot be in the future.", 422);
      for (const id of input.documentIds) await assertPlanningSourceOwner(session, id, tx);
      const sources = await sourceBindings(session, input.documentIds, tx, true);
      const policyRules = await enforceProjectEvidenceDecision(tx, session, input.packageId, sources);
      if (!sources.some(s => s.purpose === "signoff") || sources.some(s => !["signoff", "photo"].includes(s.purpose))) throw new DomainError("SIGNOFF_SOURCE_REQUIRED", "Include the inspection's source document. A photo alone cannot establish a qualified review.", 422);
      if (qualification.provenance !== "sample" && !sources.some(s => s.purpose === "signoff" && s.documentId !== qualification.document_id)) throw new DomainError("INSPECTION_DOCUMENT_REQUIRED", "Include a separate inspection record. Reviewer credentials alone cannot prove that this package's work was inspected.", 422);
      const sample = qualification.provenance === "sample" || plan.payload.sources.some(s => s.provenance === "sample_document") || sources.some(s => s.provenance === "sample_document");
      if (sample && (session.mode !== "sample" || !input.sampleAcknowledged)) throw new DomainError("SAMPLE_SIGNOFF_ONLY", "Sample evidence cannot accept physical work. Use a labelled sample workspace for this exercise.", 422);
      const data: SignoffData = { sourceBindings: sources, planHash: input.expectedPlanHash, scope: requirement.scope, statement: input.statement, limitations: input.limitations,
        observedAt: input.observedAt, provenance: sample ? "sample" : "reviewer_attested" };
      const id = randomUUID();
      await tx.query(`INSERT INTO fp_work_signoffs(id,tenant_id,project_id,plan_id,package_id,requirement_id,qualification_id,qualification_version,actor_id,decision,content_hash,encrypted_data)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, ...scope(session), input.planId, input.packageId, input.requirementId, input.qualificationId, input.qualificationVersion,
        session.actorId, input.decision, planningHash(data), sealPrivate(data, evidenceContext("work-signoff", { id, tenant_id: session.tenantId, project_id: session.projectId }))]);
      await bindProjectPolicyArtifacts(tx, policyRules, "physical_signoff", id, planningHash(data), session);
      await appendEvent(tx, session, "planning.work_review_recorded", sample ? "A sample physical-review exercise was recorded" : "A scoped physical review was recorded", "The exact plan, source versions, reviewer competence and limitations are retained. Other requirements and funding remain separate.");
      return { id };
    });
  });
}
export async function signoffViews(session: Session, tx: SqlConnection = database(), internal = false, at = Date.now()): Promise<SignoffView[]> {
  const published = await publishedPlan(session, tx);
  const rows = await query<SignoffRow>("SELECT * FROM fp_work_signoffs WHERE tenant_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC", scope(session), tx);
  const output: SignoffView[] = [], latest = new Set<string>();
  for (const row of rows) {
    const data = openPrivate<SignoffData>(row.encrypted_data, evidenceContext("work-signoff", row));
    if (planningHash(data) !== row.content_hash) throw new DomainError("SIGNOFF_INTEGRITY", "A saved work review could not be verified.", 409);
    const [qualification] = await query<QualificationRow>("SELECT * FROM fp_reviewer_qualifications WHERE id=$1 AND tenant_id=$2 AND project_id=$3", [row.qualification_id, ...scope(session)], tx);
    let reason: string | null = null;
    const group = `${row.package_id}:${row.requirement_id}`;
    if (latest.has(group)) reason = "A later review supersedes this decision.";
    else latest.add(group);
    if (!published || published.view.state !== "current" || published.row.id !== row.plan_id || published.row.content_hash !== data.planHash) reason = "This review refers to an earlier or stale plan.";
    else if (!qualification || qualification.version !== row.qualification_version) reason = "The reviewer scope changed.";
    else {
      const valid = await qualificationState(session, qualification, tx, false, at);
      if (!valid.valid) reason = valid.reason;
      const sourceChanges = await currentSourceCheck(session, data.sourceBindings, tx);
      if (sourceChanges.length) reason = sourceChanges[0];
    }
    const privateAllowed = session.role === "organizer" || (session.role === "volunteer" && row.actor_id === session.actorId);
    if (!internal && session.role === "donor") continue;
    output.push({ id: row.id, planId: row.plan_id, packageId: row.package_id, requirementId: row.requirement_id, qualificationId: privateAllowed ? row.qualification_id : "redacted",
      decision: row.decision, current: !reason, stateReason: reason, scope: data.scope,
      statement: privateAllowed ? data.statement : "A scoped reviewer decision is recorded for this requirement.", limitations: privateAllowed ? data.limitations : "Only the named scope is covered; private inspection details remain restricted.",
      observedAt: data.observedAt, recordedAt: row.created_at.toISOString(), provenance: data.provenance, reviewerLabel: privateAllowed && qualification ? openPrivate<QualificationData>(qualification.encrypted_data, evidenceContext("reviewer-qualification", qualification)).displayName : "Scoped project reviewer" });
  }
  return output;
}
export function packageReadiness(payload: PlanPayload | null, publicationCurrent: boolean, alignments: AlignmentView[], signoffs: SignoffView[], fundedIds: string[]): PackageReadiness[] {
  if (!payload) return [];
  const data: PackageReadiness[] = payload.plan.packages.map(pkg => {
    const requirements = pkg.requirements.map(r => {
      const alignment = alignments.find(a => a.packageId === pkg.packageId && a.state === "reviewed");
      const signoff = signoffs.find(s => s.packageId === pkg.packageId && s.requirementId === r.id && s.current && s.decision === "accepted");
      const satisfied = publicationCurrent && (r.kind === "photo_association" ? !!alignment : !!signoff);
      return { id: r.id, label: r.label, satisfied, detail: !publicationCurrent ? "Review the current plan and sources first." : r.kind === "photo_association" ? alignment ? "Three landmarks reviewed. This is an illustrative association." : "A three-anchor image review is needed." : signoff ? `Accepted within ${r.scope?.replaceAll("_", " ")} scope.` : `A current ${r.scope?.replaceAll("_", " ")} reviewer must check this requirement.` };
    });
    const accepted = requirements.length > 0 && requirements.every(r => r.satisfied);
    return { packageId: pkg.packageId, title: pkg.title, acceptedCount: requirements.filter(r => r.satisfied).length, requiredCount: requirements.length, accepted,
      prerequisitesMet: true, planningReady: false, fundingComplete: fundedIds.includes(pkg.packageId), providerLiquidity: "not_checked", requirements, blockers: [],
      provenance: payload.sources.some(s => s.provenance === "sample_document") || alignments.some(a => a.packageId === pkg.packageId && a.state === "reviewed" && a.sourceClass === "sample_illustration") || signoffs.some(s => s.packageId === pkg.packageId && s.current && s.provenance === "sample") ? "sample" : accepted ? "reviewer_attested" : "unreviewed" };
  });
  const checked = new Set<string>(), visiting = new Set<string>();
  const checkPrerequisites = (pkg: PackageReadiness): boolean => {
    if (checked.has(pkg.packageId)) return pkg.prerequisitesMet;
    if (visiting.has(pkg.packageId)) { pkg.prerequisitesMet = false; return false; }
    visiting.add(pkg.packageId);
    if (!publicationCurrent) pkg.blockers.push("The plan needs a current publication review.");
    if (!pkg.fundingComplete) pkg.blockers.push("The package's collection is incomplete or not eligible for use.");
    for (const dependency of payload.plan.dependencies.filter(d => d.packageId === pkg.packageId)) {
      const predecessor = data.find(p => p.packageId === dependency.prerequisiteId);
      const fulfilled = !!predecessor && checkPrerequisites(predecessor) && (dependency.kind === "included" || predecessor.accepted);
      if (!fulfilled) { pkg.prerequisitesMet = false; pkg.blockers.push(`${predecessor?.title ?? dependency.prerequisiteId} needs ${dependency.kind === "safety_signoff" ? "its qualified safety reviews" : "accepted work"}.`); }
    }
    pkg.planningReady = publicationCurrent && pkg.prerequisitesMet;
    pkg.blockers.push("Available provider funds and spending approval must be checked separately before purchasing.");
    visiting.delete(pkg.packageId); checked.add(pkg.packageId);
    return pkg.prerequisitesMet;
  };
  data.forEach(checkPrerequisites);
  return data;
}
