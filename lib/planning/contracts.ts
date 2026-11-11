import { z } from "zod";
import type { DocumentView } from "../domain/evidence";
import type { WorkspaceRole } from "../contracts";

export const PLAN_SCHEMA_VERSION = 1;
export const PLAN_PROMPT_VERSION = "source-plan-v1";
export const pointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict();
export type PlanPoint = z.infer<typeof pointSchema>;
const key = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const polygonSchema = z.array(pointSchema).min(4).max(65);
export const sourceRegionSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict();
export const citationSchema = z.object({
  id: key, documentId: z.uuid(), page: z.number().int().min(1).max(12),
  region: sourceRegionSchema, text: z.string().max(600), confidence: z.number().min(0).max(1),
  kind: z.enum(["sketch", "quote", "note"]),
}).strict();
export type PlanCitation = z.infer<typeof citationSchema>;
export const competencyScopeSchema = z.enum(["equipment_setup", "ventilation", "electrical_safety", "laser_safety"]);
export type CompetencyScope = z.infer<typeof competencyScopeSchema>;
export const evidenceRequirementSchema = z.object({
  id: key, label: z.string().trim().min(1).max(120), kind: z.enum(["photo_association", "installation_review", "ventilation_check", "electrical_check", "laser_safety_check"]),
  scope: competencyScopeSchema.nullable(),
}).strict();
export type EvidenceRequirement = z.infer<typeof evidenceRequirementSchema>;
export const planPackageSchema = z.object({
  packageId: key, title: z.string().trim().min(1).max(120), budgetMinor: z.number().int().min(1).max(100000000).nullable(),
  currency: z.literal("USD"), quoteCitationIds: z.array(key).max(20), reviewState: z.enum(["needs_review", "reviewed"]),
  capabilities: z.array(z.string().trim().min(1).max(160)).max(12), requirements: z.array(evidenceRequirementSchema).min(1).max(12),
}).strict();
export const dependencySchema = z.object({
  packageId: key, prerequisiteId: key, kind: z.enum(["included", "accepted_work", "safety_signoff"]),
  reason: z.string().trim().min(1).max(300), citationId: key.nullable(),
}).strict();
export type PlanDependency = z.infer<typeof dependencySchema>;
export const proposedPlanSchema = z.object({
  schemaVersion: z.literal(PLAN_SCHEMA_VERSION), title: z.string().trim().min(1).max(140),
  sourceDocumentId: z.uuid(), sourcePage: z.number().int().min(1).max(12),
  outline: polygonSchema,
  walls: z.array(z.object({ id: key, edgeIndex: z.number().int().min(0).max(63) }).strict()).min(3).max(64),
  openings: z.array(z.object({ id: key, kind: z.enum(["door", "window"]), wallId: key,
    start: z.number().min(0).max(1), end: z.number().min(0).max(1), citationId: key.nullable() }).strict()).max(64),
  scale: z.object({ state: z.enum(["unknown", "estimated", "reviewed"]), distance: z.number().positive().max(10000).nullable(),
    unit: z.enum(["m", "ft"]).nullable(), from: pointSchema.nullable(), to: pointSchema.nullable(),
    citationId: key.nullable(), note: z.string().max(400) }).strict(),
  zones: z.array(z.object({ id: key, packageId: key.nullable(), label: z.string().trim().min(1).max(120), polygon: polygonSchema,
    sourceCitationId: key.nullable(), quoteCitationIds: z.array(key).max(20), confidence: z.number().min(0).max(1),
    reviewState: z.enum(["needs_review", "reviewed"]) }).strict()).max(20),
  citations: z.array(citationSchema).max(120), packages: z.array(planPackageSchema).min(1).max(20),
  dependencies: z.array(dependencySchema).max(80), assumptions: z.array(z.string().max(400)).max(30),
}).strict();
export type ProposedPlan = z.infer<typeof proposedPlanSchema>;
export type PlanZone = ProposedPlan["zones"][number];
export interface PlanIssue { code: string; path: string; message: string; severity: "error" | "review" | "notice"; }
export interface PlanValidation { issues: PlanIssue[]; geometryValid: boolean; reviewReady: boolean; publishable: boolean; }
export interface PlanPackageBinding { packageId: string; version: number; budgetMinor: number; title: string; }
export interface PlanSourceBinding {
  documentId: string; documentVersion: number; contentHash: string; purpose: DocumentView["purpose"];
  provenance: DocumentView["provenance"]; controlVersion: number; pageHashes: string[];
  pages: { number: number; width: number; height: number }[];
}
export interface PlanSourceView extends DocumentView {
  controlVersion: number; permission: "allowed" | "withdrawn"; classification: "source" | "photograph" | "illustration" | "credential"; isOwn: boolean;
}
export interface PlanVersionView {
  id: string; revision: number; contentHash: string; geometryHash: string; sourceHash: string; packageHash: string;
  createdAt: string; origin: "manual" | "sample" | "model"; sourceRunId: string | null;
  plan: ProposedPlan; validation: PlanValidation; sourceBindings: PlanSourceBinding[]; packageBindings: PlanPackageBinding[];
  review: { id: string; decision: "approved" | "needs_changes"; note: string; reviewedAt: string; reviewerLabel: string } | null;
}
export interface PublishedPlanView {
  publicationId: string; planId: string; revision: number; contentHash: string; geometryHash: string;
  publishedAt: string; state: "current" | "stale" | "revoked"; staleReasons: string[];
  title: string; pageAspectRatio: number; outline: PlanPoint[]; walls: ProposedPlan["walls"]; openings: Omit<ProposedPlan["openings"][number], "citationId">[];
  zones: { id: string; packageId: string; label: string; polygon: PlanPoint[] }[];
  scaleLabel: string; provenance: "sample" | "reviewed_plan";
  packages: { packageId: string; title: string; budgetMinor: number | null; capabilities: string[]; requirements: EvidenceRequirement[] }[];
  dependencies: Omit<PlanDependency, "citationId">[];
}
export interface PlanRunView {
  id: string; state: "queued" | "running" | "succeeded" | "failed"; provider: "openai" | "gemini"; model: string;
  retryAvailable: boolean;
  executionMode: "foreground" | "background_poll"; providerStatus: "queued" | "in_progress" | null;
  promptVersion: string; inputHash: string; outputHash: string | null; code: string | null; attempt: number;
  createdAt: string; completedAt: string | null; proposal: ProposedPlan | null; validation: PlanValidation | null;
  stats: { durationMs: number; inputTokens: number | null; outputTokens: number | null } | null;
}
export const anchorSchema = z.object({ photo: pointSchema, plan: pointSchema }).strict();
export type AnchorPair = z.infer<typeof anchorSchema>;
export type AffineMatrix = [number, number, number, number, number, number];
export interface AlignmentView {
  id: string; revision: number; planId: string; packageId: string; documentId: string | null; documentVersion: number;
  sourcePage: number; imageSharing: "reviewers_only" | "project_members"; displayCrop: z.infer<typeof sourceRegionSchema>; redactions: z.infer<typeof sourceRegionSchema>[]; sharedPreviewHash: string | null;
  sourceHash: string; planHash: string; contentHash: string; anchors: AnchorPair[]; matrix: AffineMatrix;
  residualRms: number; conditioning: number; state: "draft" | "reviewed" | "stale" | "revoked";
  sourceClass: "sample_illustration" | "submitted_photo"; previewUrl: string | null;
  reviewedAt: string | null; reviewerLabel: string | null; createdAt: string; note: string;
}
export interface QualificationView {
  id: string; actorId: string; scope: CompetencyScope; state: "pending" | "verified" | "revoked" | "expired" | "stale"; stateReason: string | null;
  version: number; displayName: string; basis: string; documentId: string | null; validUntil: string;
  provenance: "sample" | "reviewer_attested"; isOwn: boolean; reviewedAt: string | null;
}
export interface SignoffView {
  id: string; planId: string; packageId: string; requirementId: string; qualificationId: string;
  decision: "accepted" | "needs_information" | "rejected"; current: boolean; stateReason: string | null;
  scope: CompetencyScope; statement: string; limitations: string; observedAt: string; recordedAt: string;
  provenance: "sample" | "reviewer_attested"; reviewerLabel: string;
}
export interface PackageReadiness {
  packageId: string; title: string; acceptedCount: number; requiredCount: number; accepted: boolean;
  prerequisitesMet: boolean; planningReady: boolean; fundingComplete: boolean; providerLiquidity: "not_checked";
  requirements: { id: string; label: string; satisfied: boolean; detail: string }[];
  blockers: string[]; provenance: "sample" | "reviewer_attested" | "unreviewed";
}
export interface PlanningWorkspace {
  role: WorkspaceRole; allowedRoles: WorkspaceRole[]; mode: "sample" | "live_sandbox"; projectId: string; projectTitle: string; scope: string;
  headVersion: number; projectionVersion: number; asOf: string;
  sources: PlanSourceView[]; current: PlanVersionView | null; published: PublishedPlanView | null;
  history: { id: string; revision: number; contentHash: string; createdAt: string; origin: PlanVersionView["origin"]; reviewed: boolean }[];
  packages: PlanPackageBinding[]; runs: PlanRunView[]; alignments: AlignmentView[]; qualifications: QualificationView[];
  signoffs: SignoffView[]; readiness: PackageReadiness[]; reviewerAccess: ReviewerAccessView[]; permittedReviewScopes: CompetencyScope[];
  modelConfigured: { openai: boolean; gemini: boolean }; storageConfigured: boolean; uploadMode: "private_blob" | "isolated_local";
}
export interface ReviewerAccessView { id: string; version: number; label: string; scopes: CompetencyScope[]; state: "invited" | "joined" | "revoked" | "expired"; expiresAt: string; joinedAt: string | null; createdAt: string; }
export const reviewerInviteSchema = z.object({ intentId: z.uuid(), label: z.string().trim().min(2).max(120), scopes: z.array(competencyScopeSchema).min(1).max(4), expiresHours: z.number().int().min(1).max(72), acknowledged: z.literal(true) }).strict();
export const reviewerInviteRevokeSchema = z.object({ intentId: z.uuid(), expectedVersion: z.number().int().min(1), reason: z.string().trim().min(8).max(1000) }).strict();
export const reviewerRedeemSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{64}$/), redemptionNonce: z.uuid(), acknowledged: z.literal(true) }).strict();
export const savePlanSchema = z.object({ intentId: z.uuid(), expectedVersion: z.number().int().min(0), plan: proposedPlanSchema,
  origin: z.enum(["manual", "sample", "model"]), sourceRunId: z.uuid().nullable() }).strict();
export const reviewPlanSchema = z.object({ intentId: z.uuid(), expectedVersion: z.number().int().min(1), planId: z.uuid(), contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  decision: z.enum(["approved", "needs_changes"]), note: z.string().trim().min(8).max(1200), sourceReviewConfirmed: z.literal(true) }).strict();
export const publishPlanSchema = z.object({ intentId: z.uuid(), expectedVersion: z.number().int().min(1), planId: z.uuid(), reviewId: z.uuid(), contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  acknowledged: z.literal(true) }).strict();
export const sourcePermissionSchema = z.object({ intentId: z.uuid(), expectedVersion: z.number().int().min(1), permission: z.enum(["allowed", "withdrawn"]),
  reason: z.string().trim().min(8).max(600) }).strict();
export const alignmentInputSchema = z.object({ intentId: z.uuid(), planId: z.uuid(), packageId: key, documentId: z.uuid(),
  sourcePage: z.number().int().min(1).max(12), imageSharing: z.enum(["reviewers_only", "project_members"]), displayCrop: sourceRegionSchema, redactions: z.array(sourceRegionSchema).max(24),
  anchors: z.array(anchorSchema).length(3), expectedPlanHash: z.string().regex(/^[0-9a-f]{64}$/), note: z.string().trim().min(8).max(600) }).strict();
export const alignmentReviewSchema = z.object({ intentId: z.uuid(), contentHash: z.string().regex(/^[0-9a-f]{64}$/), expectedRevision: z.number().int().min(1),
  anchorsConfirmed: z.literal(true), illustrativeOnlyConfirmed: z.literal(true), sharedImageConfirmed: z.boolean() }).strict();
export const alignmentRevokeSchema = z.object({ intentId: z.uuid(), contentHash: z.string().regex(/^[0-9a-f]{64}$/), expectedRevision: z.number().int().min(1), reason: z.string().trim().min(8).max(1000) }).strict();
export const qualificationInputSchema = z.object({ intentId: z.uuid(), scope: competencyScopeSchema, displayName: z.string().trim().min(2).max(120),
  basis: z.string().trim().min(20).max(1500), documentId: z.uuid(), validUntil: z.iso.datetime(), sampleAcknowledged: z.boolean() }).strict();
export const qualificationReviewSchema = z.object({ intentId: z.uuid(), expectedVersion: z.number().int().min(1), decision: z.enum(["verified", "revoked"]),
  note: z.string().trim().min(20).max(1200), evidenceChecked: z.literal(true), sampleAcknowledged: z.boolean() }).strict();
export const signoffInputSchema = z.object({ intentId: z.uuid(), planId: z.uuid(), packageId: key, requirementId: key,
  qualificationId: z.uuid(), qualificationVersion: z.number().int().min(1), documentIds: z.array(z.uuid()).min(1).max(8),
  decision: z.enum(["accepted", "needs_information", "rejected"]), statement: z.string().trim().min(20).max(1600), limitations: z.string().trim().min(8).max(1200),
  observedAt: z.iso.datetime(), expectedPlanHash: z.string().regex(/^[0-9a-f]{64}$/), scopeConfirmed: z.literal(true), sampleAcknowledged: z.boolean() }).strict();

export const scopeLabels: Record<CompetencyScope, string> = {
  equipment_setup: "Equipment setup", ventilation: "Ventilation", electrical_safety: "Electrical safety", laser_safety: "Laser safety",
};
export function defaultRequirements(packageId: string): EvidenceRequirement[] {
  const photo: EvidenceRequirement = { id: "photo", label: "Reviewed image association", kind: "photo_association", scope: null };
  if (packageId === "safety") return [photo,
    { id: "ventilation", label: "Ventilation inspection", kind: "ventilation_check", scope: "ventilation" },
    { id: "electrical", label: "Electrical safety inspection", kind: "electrical_check", scope: "electrical_safety" }];
  if (packageId === "laser") return [photo,
    { id: "installation", label: "Equipment installation review", kind: "installation_review", scope: "equipment_setup" },
    { id: "laser-safety", label: "Laser safety sign-off", kind: "laser_safety_check", scope: "laser_safety" }];
  return [photo, { id: "installation", label: "Equipment installation review", kind: "installation_review", scope: "equipment_setup" }];
}
