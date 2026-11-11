import { z } from "zod";

const region = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict()
  .refine(r => r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001, "Keep the crop or mask inside the image.");
export type ProofRegion = z.infer<typeof region>;
const intent = z.uuid();
export const proofDerivativeInput = z.object({ intentId: intent, documentId: z.uuid(), page: z.number().int().min(1).max(25), crop: region, masks: z.array(region).max(40), packageId: z.string().min(1).max(80) }).strict();
export const proofDerivativeReview = z.object({ intentId: intent, contentHash: z.string().regex(/^[a-f0-9]{64}$/), expectedVersion: z.number().int().positive(), privacyChecked: z.literal(true), publicSharingConfirmed: z.literal(true) }).strict();
export const proofDraftInput = z.object({ intentId: intent, packageId: z.string().min(1).max(80), expectedVersion: z.number().int().nonnegative(), derivativeIds: z.array(z.uuid()).max(12) }).strict();
export const proofDecisionInput = z.object({ intentId: intent, snapshotId: z.uuid(), expectedVersion: z.number().int().nonnegative(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), acknowledged: z.literal(true) }).strict();
export const proofWithdrawInput = z.object({ intentId: intent, expectedVersion: z.number().int().nonnegative(), acknowledged: z.literal(true) }).strict();
export interface ProofEvidence { id: string; kind: "receipt" | "photo"; label: string; contentHash: string; reviewVersion: number; width: number; height: number; sample: boolean; }
export interface ProofPayload {
  schema: "fieldproof.public-proof.v1"; revision: number; cutoff: string; mode: "sample" | "live_sandbox";
  projectTitle: string; package: { id: string; title: string; version: number; targetMinor: number };
  funding: { collectedMinor: number; fundingEligibleMinor: number; shortfallMinor: number; pendingRefundMinor: number; excessLiabilityMinor: number; ordersMinor: number; invoiceMinor: number; refundedMinor: number; excludedMinor: number; paymentCount: number; referenceSuffixes: string[] };
  evidence: ProofEvidence[];
  signoffs: { scope: string; decision: string; observedAt: string; provenance: "sample" | "reviewer_attested"; label: string }[];
  plan: null | { revision: number; outline: { x: number; y: number }[]; zones: { polygon: { x: number; y: number }[]; selected: boolean }[]; requiredReviews: number; acceptedReviews: number; };
  limitations: string[];
}
export interface ProofSnapshotView { id: string; state: "draft" | "reviewed" | "published" | "superseded" | "revoked"; contentHash: string; payload: ProofPayload; reviewedAt: string | null; publishedAt: string | null; }
export interface ProofDesk {
  mode: "sample" | "live_sandbox"; packages: { id: string; title: string; budgetMinor: number; version: number; headVersion: number; slug: string | null; publicationState: "private" | "published" | "withdrawn" }[];
  derivatives: (ProofEvidence & { state: "draft" | "reviewed" | "revoked"; packageId: string; documentId: string; sourcePage: number; previewUrl: string; available: boolean })[];
  sources: { id: string; purpose: "receipt" | "photo"; sample: boolean; pages: { number: number; width: number; height: number; previewUrl: string }[] }[];
  snapshots: ProofSnapshotView[];
}
export interface PublicProof { slug: string; state: "published" | "withdrawn" | "unavailable"; currentRevision: number | null; snapshot: ProofSnapshotView | null; history: { revision: number; cutoff: string; contentHash: string }[]; }
