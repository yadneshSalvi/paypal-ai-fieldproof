import { z } from "zod";
import type { WorkspaceRole } from "../contracts";
import type { StudioData, StudioSnapshot } from "../studio/contracts";

export const BOARD_PACK_VERSION = "fieldproof.board-pack.v1" as const;
export const BOARD_PACK_HISTORY_PAGE_SIZE = 20;
export const boardPackCaptureInput = z.object({
  intentId: z.uuid(), label: z.string().trim().min(1).max(100),
  expectedProjectionVersion: z.number().int().nonnegative(),
}).strict();
export type BoardPackCaptureInput = z.infer<typeof boardPackCaptureInput>;
export type BoardPackStatus = "current" | "historical" | "withdrawn";
export type BoardPackSourceKind = "package" | "receipt" | "position" | "assignment" | "allocation" | "expense" | "evidence" | "exception" | "plan" | "balance";
export interface BoardPackAudience {
  role: WorkspaceRole; label: string; detail: string;
  receiptScope: "project" | "own_contributions" | "none";
  expenseScope: "project_private" | "project_redacted" | "own_claims" | "none";
}
export interface BoardPackPackage {
  packageId: string; version: number; title: string; lifecycleState: string;
  /** Existing commitment measure includes historical original credit; it is not unpaid money. */
  originalCommitmentRecordMinor: number;
  /** Current unpaid promises calculated from original obligations, never from current purpose collections. */
  unpaidCommitmentMinor: number;
  acceptedSponsorUnpaidMinor: number;
  currentCase: null | { id: string; state: string; revision: number; deadline: string; packageVersion: number };
  requirements: { id: string; label: string; satisfied: boolean; detail: string; scope: string | null }[];
  blockers: string[];
  sourceId: string;
}
export interface BoardPackReceiptTotals {
  scope: BoardPackAudience["receiptScope"]; count: number;
  grossMinor: number; creditedMinor: number; returnedMinor: number; pendingReturnMinor: number;
  excludedMinor: number; excessLiabilityMinor: number;
  ordersGrossMinor: number; invoiceGrossMinor: number;
  /** Separate test checkout receipts are retained above but excluded from funding positions. */
  testGrossMinor: number;
}
export interface BoardPackPositionTotals {
  scope: BoardPackAudience["receiptScope"]; count: number;
  assignedMinor: number; collectedMinor: number; eligibleMinor: number;
  returnedMinor: number; pendingReturnMinor: number; excludedMinor: number;
  reservedMinor: number; paidMinor: number; availableMinor: number;
}
export interface BoardPackProjectTotals {
  budgetMinor: number; currentCollectedMinor: number; eligibleMinor: number;
  unpaidCommitmentMinor: number; acceptedSponsorUnpaidMinor: number;
  returnedMinor: number; pendingReturnMinor: number; reservedMinor: number; paidMinor: number; availableMinor: number;
  approvedExpenseMinor: number; deliveredPrincipalMinor: number;
  paidFeeMinor: number; reservedFeeMinor: number;
  acceptedWorkItems: number; requiredWorkItems: number; acceptedPackages: number; packageCount: number;
}
export interface BoardPackExpense {
  id: string; packageIds: string[]; claimId: string | null; title: string; state: string;
  claimVersion: number; approvedMinor: number; requestedMinor: number;
  reviewedAt: string | null; reviewerLabel: string | null;
  repayments: { id: string; state: string; principalMinor: number; deliveredMinor: number; returnedMinor: number;
    feeAllowanceMinor: number; actualFeeMinor: number | null; feeState: string;
    observedAt: string | null; sourceId: string }[];
  sourceId: string;
}
export interface BoardPackAssignment {
  id: string; receiptId: string; kind: "reallocation" | "rollover" | "reversal"; amountMinor: number;
  fromPackageId: string; toPackageId: string; committedAt: string; sequence: number; sourceId: string;
}
export const boardPackSourceId = (kind: BoardPackSourceKind, recordId: string): string => `${kind}:${recordId}`;
export interface BoardPackSource {
  id: string; kind: BoardPackSourceKind; label: string; packageIds: string[];
  provenance: string; observedAt: string | null; reviewerLabel: string | null; reviewedAt: string | null;
  scope: string; available: boolean;
}
export interface BoardPackBalance {
  state: "not_recorded" | "observed" | "unavailable";
  observedAt: string | null; asOf: string | null; refreshedAt: string | null;
  availableMinor: number | null; code: string | null; sourceId: string | null;
  limitation: string;
}
export interface BoardPackReport {
  schemaVersion: typeof BOARD_PACK_VERSION; id: string; label: string; contentHash: string;
  project: { id: string; title: string; templateId: string; currency: "USD"; mode: "sample" | "live_sandbox" };
  audience: BoardPackAudience; asOf: string; projectionVersion: number; eventCursor: number;
  semanticVersion: StudioSnapshot["semanticVersion"];
  datasetVersions: StudioSnapshot["datasetVersions"];
  data: StudioData; packages: BoardPackPackage[];
  geometry: StudioSnapshot["geometry"]; geometrySource: StudioSnapshot["geometrySource"] | null;
  totals: { project: BoardPackProjectTotals; receipts: BoardPackReceiptTotals; positions: BoardPackPositionTotals };
  assignments: BoardPackAssignment[]; expenses: BoardPackExpense[];
  reviewedImages: { sourceId: string; width: number; height: number; alt: string; contentHash: string }[];
  balance: BoardPackBalance; sources: BoardPackSource[]; notices: string[];
}
export interface BoardPackSummary {
  id: string; label: string; asOf: string; contentHash: string; role: WorkspaceRole;
  projectionVersion: number; eventCursor: number; packageCount: number;
}
export interface BoardPackView {
  summary: BoardPackSummary; status: BoardPackStatus; checkedAt: string;
  currentProjectionVersion: number; currentEventCursor: number;
  reasons: string[];
  /** Private content is absent after a bound source or authority is withdrawn. */
  report: BoardPackReport | null;
  canPrint: boolean; canExport: boolean;
}
export interface BoardPackDesk {
  /** Opaque stale-tab identity only, never an authorization capability. */
  scope: string;
  projectId: string; projectTitle: string; audience: BoardPackAudience;
  sessionExpiresAt: string; projectionVersion: number; eventCursor: number;
  history: BoardPackSummary[]; nextCursor: string | null;
  selected: BoardPackView | null; canCapture: boolean;
}
export interface BoardPackSourceDetail {
  reportId: string; contentHash: string; asOf: string; source: BoardPackSource;
  fields: { label: string; value: string }[];
  /** URLs target the Board Pack's reauthorized proxy, never the original private storage. */
  image: null | { url: string; width: number; height: number; alt: string; contentHash: string };
  relatedSourceIds: string[];
  limitations: string[];
}
