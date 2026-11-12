import type { Provenance, WorkspaceRole } from "../contracts";

export const SUPPORTER_STORY_VERSION = "supporter-purpose-story-v1" as const;
export interface StoryReview {
  status: "recorded" | "sample" | "missing" | "stale";
  scope: string; reviewerLabel: string | null; reviewedAt: string | null; sourceHash: string | null;
}
export interface StoryBudget {
  packageId: string; version: number | null; title: string; purpose: string | null;
  amountMinor: number | null; status: "bound" | "missing" | "conflict";
  basis: "saved_purpose" | "saved_plan" | "current_package" | "unavailable";
  sourceHashes: string[]; review: StoryReview;
}
/** The fraction is exact; the one-decimal label and visual are rounded displays. */
export interface StoryShare {
  numeratorMinor: number; denominatorMinor: number;
  percentNumerator: string; percentDenominator: string; percentTenths: string;
  basis: "current-purpose-net-credit-v1" | "original-credited-budget-v1";
}
export interface StoryPosition {
  id: string; packageId: string; versions: number[]; currentVersion: number | null;
  budget: StoryBudget; share: StoryShare | null; purposeState: string;
  assignedMinor: number; netMinor: number; returnedMinor: number; pendingReturnMinor: number;
  paidMinor: number; feeMinor: number; committedMinor: number; reviewMinor: number; availableMinor: number;
  state: "active" | "returned" | "moved" | "pending_return" | "review" | "cancelled" | "earlier_version";
  sourceIssue: string | null; assignmentIds: string[];
}
export interface StoryTimelineItem {
  id: string; kind: "payment" | "decision" | "assignment" | "expense" | "fee" | "return" | "hold";
  at: string | null; amountMinor: number; state: string; packageId: string;
  title: string; detail: string; review: StoryReview | null;
}
export interface StoryContribution {
  id: string; receiptVersion: number; own: boolean; label: string;
  sourceKind: "orders_capture" | "invoice_payment"; provenance: Provenance; observedAt: string;
  grossMinor: number; creditedMinor: number; excessMinor: number; original: StoryBudget; originalShare: StoryShare | null;
  positions: StoryPosition[]; timeline: StoryTimelineItem[]; sourceHash: string;
}
export interface StoryEvidence {
  id: string; packageId: string; packageVersion: number | null;
  kind: "image_association" | "public_receipt" | "public_image" | "work_review" | "publication";
  state: "current" | "stale" | "revoked" | "missing" | "unreviewed";
  label: string; scope: string; sourceClass: "sample" | "submitted" | "reviewer_attested";
  reviewerLabel: string | null; reviewedAt: string | null; sourceHash: string | null;
  previewUrl: string | null; proofUrl: string | null; detail: string;
}
export interface SupporterJourney {
  contract: typeof SUPPORTER_STORY_VERSION; projectId: string; role: WorkspaceRole;
  scope: "own_contributions" | "project_contributions" | "project_only";
  contextHash: string; sourceHash: string; observedAt: string;
  contributions: StoryContribution[]; evidence: StoryEvidence[];
  unpaid: { count: number; amountMinor: number };
  hiddenUpdateCount: number;
}
export interface StorySourceDocument {
  contract: typeof SUPPORTER_STORY_VERSION; sourceHash: string; communitySourceHash: string;
  personalSourceHash: string; observedAt: string; contribution: StoryContribution;
  receipt: {
    id: string; version: number; donorObligationId: string; sourceKind: StoryContribution["sourceKind"];
    originalPackageId: string; originalPackageVersion: number | null;
    actualProviderPaymentRef: string; sourceOrderId: string | null; sourceInvoiceId: string | null;
    provenRefundableRef: string | null; refundAdapter: string; observedState: string; observedAt: string;
    currency: "USD"; grossMinor: number; creditedMinor: number; receiptHash: string;
  };
  consent: null | { id: string; version: number; digest: string; provenance: "sample" | "recorded"; statement: string | null; expiresAt: string | null };
  decisions: { id: string; version: number; digest: string; kind: string; amountMinor: number; state: string;
    sourcePackageId: string; sourcePackageVersion: number; destination: null | { packageId: string; packageVersion: number; title: string; purpose: string };
    consentedAt: string; expiresAt: string; revokedAt: string | null; executedId: string | null }[];
  limitations: string[];
}
export interface StorySourceResponse { document: StorySourceDocument; downloadHash: string; downloadText: string; }
