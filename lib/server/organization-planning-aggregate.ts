import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import type { AlignmentView, CompetencyScope, PlanSourceBinding, SignoffView } from "../planning/contracts";
import { DomainError, assertMinor } from "../domain/money";
import { query } from "./db";
import { openPrivate } from "./private-values";
import { currentSourceCheck, planningHash, publishedPlan } from "./planning-store";
import { packageReadiness } from "./planning-evidence";

export interface OrganizationPlanningScope { tenantId: string; projectId: string; }
export interface OrganizationPlanningDependencies {
  documents: PlanSourceBinding[];
  publication: null | { publicationId: string; planId: string; contentHash: string };
  alignments: { id: string; contentHash: string }[];
  signoffs: { id: string; contentHash: string; qualificationId: string; qualificationVersion: number }[];
  qualifications: { id: string; version: number; validUntil: string; actorId: string; membershipVersion: number; issuerId: string; issuerMembershipVersion: number }[];
  validThrough: string | null;
}
/** Internal only: dependencies never enter an organization aggregate DTO. */
export interface OrganizationPlanningAggregate {
  available: boolean; planRevision: number | null; planHash: string | null;
  acceptedReviewItems: number; requiredReviewItems: number; acceptedPackages: number; packageCount: number;
  currentScopedSignoffs: number; reviewedIllustrations: number; sourceVersionHash: string;
  limitations: string[]; dependencies: OrganizationPlanningDependencies;
}
interface AlignmentData {
  anchors: AlignmentView["anchors"]; matrix: AlignmentView["matrix"]; residualRms: number; conditioning: number;
  source: PlanSourceBinding; planHash: string; sourcePage: number; imageSharing: AlignmentView["imageSharing"];
  displayCrop: AlignmentView["displayCrop"]; redactions: AlignmentView["redactions"];
}
interface AlignmentRow { id: string; tenant_id: string; project_id: string; plan_id: string; package_id: string; document_id: string; revision: number; content_hash: string; encrypted_data: string; state: "draft" | "reviewed" | "revoked"; reviewed_at: Date | null; created_at: Date; }
interface QualificationData { source: PlanSourceBinding; reviewAuthority?: { actorId: string; version: number }; }
interface QualificationRow { id: string; tenant_id: string; project_id: string; actor_id: string; scope: CompetencyScope; state: "pending" | "verified" | "revoked"; version: number; membership_version: number; valid_until: Date; encrypted_data: string; }
interface SignoffData { sourceBindings: PlanSourceBinding[]; planHash: string; scope: CompetencyScope; observedAt: string; provenance: "sample" | "reviewer_attested"; }
interface SignoffRow { id: string; tenant_id: string; project_id: string; plan_id: string; package_id: string; requirement_id: string; qualification_id: string; qualification_version: number; actor_id: string; decision: SignoffView["decision"]; content_hash: string; encrypted_data: string; created_at: Date; }
const context = (kind: string, row: { id: string; tenant_id: string; project_id: string }) => `${kind}:${row.tenant_id}:${row.project_id}:${row.id}`;
const parameters = (scope: OrganizationPlanningScope) => [scope.tenantId, scope.projectId];
const digest = (value: unknown) => sha256(canonicalJson(value));
function within(scope: OrganizationPlanningScope, row: { tenant_id: string; project_id: string }) { if (row.tenant_id !== scope.tenantId || row.project_id !== scope.projectId) throw new DomainError("ORG_PROJECT_SOURCE_CHANGED", "Planning evidence no longer matches its exact project scope."); }
function safeSum(values: number[]): number { let total = 0; for (const value of values) { assertMinor(value); total += value; assertMinor(total); } return total; }
function documents(values: PlanSourceBinding[]): PlanSourceBinding[] {
  const result = new Map<string, PlanSourceBinding>();
  for (const value of values) {
    const prior = result.get(value.documentId);
    if (prior && planningHash(prior) !== planningHash(value)) throw new DomainError("ORG_PROJECT_SOURCE_CHANGED", "A planning source has conflicting current bindings.");
    result.set(value.documentId, value);
  }
  return [...result.values()].sort((a, b) => a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0);
}
async function currentQualification(tx: SqlConnection, scope: OrganizationPlanningScope, row: QualificationRow, at: number): Promise<{ current: boolean; reason: string | null; data: QualificationData | null }> {
  within(scope, row);
  if (row.state !== "verified") return { current: false, reason: "The recorded reviewer competence is not currently verified within the project.", data: null };
  if (row.valid_until.getTime() <= at) return { current: false, reason: "The recorded reviewer competence has expired.", data: null };
  const data = openPrivate<QualificationData>(row.encrypted_data, context("reviewer-qualification", row));
  const [member] = await query<{ state: string; version: number; roles: string[] }>("SELECT state,version,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [...parameters(scope), row.actor_id], tx);
  if (!member || member.state !== "active" || member.version !== row.membership_version || !member.roles.some(role => role === "volunteer" || role === "organizer")) return { current: false, reason: "The independently issued reviewer membership changed.", data };
  if (!data.reviewAuthority) return { current: false, reason: "The original project verification authority is missing.", data };
  const [issuer] = await query<{ state: string; version: number; roles: string[] }>("SELECT state,version,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [...parameters(scope), data.reviewAuthority.actorId], tx);
  if (!issuer || issuer.state !== "active" || issuer.version !== data.reviewAuthority.version || !issuer.roles.includes("organizer")) return { current: false, reason: "The independent project authority that reviewed the competence changed.", data };
  const changed = await currentSourceCheck(scope, [data.source], tx);
  return { current: changed.length === 0, reason: changed[0] ?? null, data };
}
/** Scope-only internal read. The caller already authorized the exact aggregate
 * consent and owns the coherent transaction/cutoff. It grants no project role,
 * creates no source-control row, and returns no image URL or person name. */
export async function loadOrganizationPlanningAggregate(tx: SqlConnection, requested: OrganizationPlanningScope, asOf: string, canonicalRequirements: readonly { packageId: string; requiredCount: number }[]): Promise<OrganizationPlanningAggregate> {
  const scope: OrganizationPlanningScope = { tenantId: requested.tenantId, projectId: requested.projectId };
  const at = Date.parse(asOf); if (!Number.isFinite(at)) throw new DomainError("ORG_PROJECT_SOURCE_CHANGED", "Planning evidence needs the original coherent portfolio cutoff.");
  const empty: OrganizationPlanningDependencies = { documents: [], publication: null, alignments: [], signoffs: [], qualifications: [], validThrough: null };
  const requiredCount = safeSum(canonicalRequirements.map(row => row.requiredCount));
  const publication = await publishedPlan(scope, tx);
  if (!publication) return { available: true, planRevision: null, planHash: null, acceptedReviewItems: 0, requiredReviewItems: requiredCount, acceptedPackages: 0, packageCount: canonicalRequirements.length, currentScopedSignoffs: 0, reviewedIllustrations: 0, sourceVersionHash: digest({ scope, publication: null, requirements: canonicalRequirements }), limitations: ["No current published plan exists. Canonical package requirements remain unsatisfied; legacy recorded evidence is retained as history and supplies no current qualified physical acceptance."], dependencies: empty };
  if (publication.view.state !== "current") return { available: false, planRevision: publication.row.revision, planHash: publication.row.content_hash, acceptedReviewItems: 0, requiredReviewItems: requiredCount, acceptedPackages: 0, packageCount: canonicalRequirements.length, currentScopedSignoffs: 0, reviewedIllustrations: 0, sourceVersionHash: digest({ scope, publication: publication.view.publicationId, hash: publication.row.content_hash, state: publication.view.state, reasons: publication.view.staleReasons }), limitations: ["The published plan or a bound source is stale or withdrawn. This evidence section is unavailable; no zero value should replace its missing current result."], dependencies: empty };
  const alignments = await query<AlignmentRow>("SELECT * FROM fp_photo_alignments WHERE tenant_id=$1 AND project_id=$2 ORDER BY created_at DESC,id", parameters(scope), tx), alignmentViews: AlignmentView[] = [], alignmentSources = new Map<string, PlanSourceBinding>();
  for (const row of alignments) {
    within(scope, row); const data = openPrivate<AlignmentData>(row.encrypted_data, context("photo-alignment", row));
    if (planningHash(data) !== row.content_hash) throw new DomainError("ALIGNMENT_INTEGRITY", "A saved image association could not be verified.");
    const valid = row.plan_id === publication.row.id && data.planHash === publication.row.content_hash && !(await currentSourceCheck(scope, [data.source], tx)).length;
    const state = row.state === "revoked" ? "revoked" : valid ? row.state : "stale";
    alignmentViews.push({ id: row.id, revision: row.revision, planId: row.plan_id, packageId: row.package_id, documentId: null,
      documentVersion: data.source.documentVersion, sourceHash: data.source.contentHash, planHash: data.planHash, contentHash: row.content_hash,
      sourcePage: data.sourcePage, imageSharing: data.imageSharing, displayCrop: data.displayCrop, redactions: [], sharedPreviewHash: null,
      anchors: data.anchors, matrix: data.matrix, residualRms: data.residualRms, conditioning: data.conditioning,
      state, sourceClass: data.source.provenance === "sample_document" ? "sample_illustration" : "submitted_photo", previewUrl: null,
      reviewedAt: row.reviewed_at?.toISOString() ?? null, reviewerLabel: null, createdAt: row.created_at.toISOString(), note: "Aggregate image association; no source rendition is disclosed." });
    if (state === "reviewed") alignmentSources.set(row.id, data.source);
  }
  const signoffs = await query<SignoffRow>("SELECT * FROM fp_work_signoffs WHERE tenant_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC", parameters(scope), tx), signoffViews: SignoffView[] = [], latest = new Set<string>(), countedQualifications = new Map<string, OrganizationPlanningDependencies["qualifications"][number]>(), countedSources: PlanSourceBinding[] = [];
  for (const row of signoffs) {
    within(scope, row); const data = openPrivate<SignoffData>(row.encrypted_data, context("work-signoff", row));
    if (planningHash(data) !== row.content_hash) throw new DomainError("SIGNOFF_INTEGRITY", "A saved physical review could not be verified.");
    const key = `${row.package_id}:${row.requirement_id}`; let reason: string | null = latest.has(key) ? "A later decision supersedes this review." : null; latest.add(key);
    const [qualification] = await query<QualificationRow>("SELECT * FROM fp_reviewer_qualifications WHERE id=$1 AND tenant_id=$2 AND project_id=$3", [row.qualification_id, ...parameters(scope)], tx);
    let qualificationData: QualificationData | null = null;
    if (row.plan_id !== publication.row.id || data.planHash !== publication.row.content_hash) reason = "This decision belongs to an earlier plan.";
    else if (!qualification || qualification.version !== row.qualification_version) reason = "The recorded competence version changed.";
    else { const current = await currentQualification(tx, scope, qualification, at); qualificationData = current.data; if (!current.current) reason = current.reason; const changed = await currentSourceCheck(scope, data.sourceBindings, tx); if (changed.length) reason = changed[0]; }
    signoffViews.push({ id: row.id, planId: row.plan_id, packageId: row.package_id, requirementId: row.requirement_id, qualificationId: "redacted", decision: row.decision, current: !reason, stateReason: reason, scope: data.scope, statement: "A scoped project decision is recorded.", limitations: "Only its exact current plan, source, competence and membership bindings count.", observedAt: data.observedAt, recordedAt: row.created_at.toISOString(), provenance: data.provenance, reviewerLabel: "Scoped project reviewer" });
    const requirement = publication.payload.plan.packages.find(pkg => pkg.packageId === row.package_id)?.requirements.find(item => item.id === row.requirement_id && item.kind !== "photo_association" && item.scope === data.scope);
    if (!reason && row.decision === "accepted" && requirement && qualification && qualificationData?.reviewAuthority) {
      countedSources.push(...data.sourceBindings, qualificationData.source);
      countedQualifications.set(qualification.id, { id: qualification.id, version: qualification.version, validUntil: qualification.valid_until.toISOString(), actorId: qualification.actor_id, membershipVersion: qualification.membership_version, issuerId: qualificationData.reviewAuthority.actorId, issuerMembershipVersion: qualificationData.reviewAuthority.version });
    }
  }
  const readiness = packageReadiness(publication.payload, true, alignmentViews, signoffViews, []);
  const physical = signoffViews.filter(row => row.current && row.decision === "accepted" && publication.payload.plan.packages.some(pkg => pkg.packageId === row.packageId && pkg.requirements.some(requirement => requirement.id === row.requirementId && requirement.kind !== "photo_association" && requirement.scope === row.scope)));
  const images = alignmentViews.filter(row => row.state === "reviewed" && publication.payload.plan.packages.some(pkg => pkg.packageId === row.packageId && pkg.requirements.some(requirement => requirement.kind === "photo_association")));
  const qualifications = [...countedQualifications.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), validThrough = qualifications.map(row => row.validUntil).sort()[0] ?? null;
  const dependencies: OrganizationPlanningDependencies = {
    publication: { publicationId: publication.view.publicationId, planId: publication.row.id, contentHash: publication.row.content_hash },
    alignments: images.map(row => ({ id: row.id, contentHash: row.contentHash })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    signoffs: signoffs.filter(row => physical.some(view => view.id === row.id)).map(row => ({ id: row.id, contentHash: row.content_hash, qualificationId: row.qualification_id, qualificationVersion: row.qualification_version })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    documents: documents([...publication.payload.sources, ...images.flatMap(image => alignmentSources.get(image.id) ? [alignmentSources.get(image.id)!] : []), ...countedSources]), qualifications, validThrough,
  };
  return { available: true, planRevision: publication.row.revision, planHash: publication.row.content_hash,
    acceptedReviewItems: safeSum(readiness.map(row => row.acceptedCount)), requiredReviewItems: safeSum(readiness.map(row => row.requiredCount)),
    acceptedPackages: readiness.filter(row => row.accepted && row.prerequisitesMet).length, packageCount: readiness.length,
    currentScopedSignoffs: physical.length, reviewedIllustrations: images.filter(row => row.sourceClass === "sample_illustration").length,
    sourceVersionHash: digest({ scope, publication: dependencies.publication, dependencies, alignments: alignmentViews.map(row => ({ id: row.id, revision: row.revision, hash: row.contentHash, state: row.state })), signoffs: signoffViews.map(row => ({ id: row.id, state: row.current, decision: row.decision, recordedAt: row.recordedAt })) }),
    limitations: ["Accepted review requirements use this exact current published plan and qualified scopes. A reviewed illustrative image is not physical acceptance.", "Historical decisions retain their original plan/source/qualification history; none is copied into a new requirement or silently revived after a later decision."], dependencies };
}
