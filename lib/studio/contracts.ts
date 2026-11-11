import type { BlueprintZone, Provenance, WorkspaceRole } from "../contracts";

export const STUDIO_SEMANTIC_VERSION = "fieldproof-report-v1" as const;
export const STUDIO_TABLES = ["packages", "settlements", "allocations", "evidence", "exceptions"] as const;
export type StudioTable = typeof STUDIO_TABLES[number];
export type StudioPrimitive = string | number | boolean | null;
export interface StudioRow { id: string; packageId: string; [field: string]: StudioPrimitive; }

export interface PackageRow extends StudioRow {
  title: string; shortTitle: string; budgetMinor: number; pledgedMinor: number;
  collectedMinor: number; fundingEligibleMinor: number; shortfallMinor: number;
  pendingRefundMinor: number; completedRefundMinor: number; excessLiabilityMinor: number;
  allocationReservedMinor: number; availableAllocationMinor: number;
  approvedExpenseMinor: number; paidExpenseMinor: number;
  reviewedItemCount: number; requiredItemCount: number; reviewedExpenseLineCount: number;
  fundingState: string; workState: string; geometryRef: string; provenance: Provenance;
}
export interface SettlementRow extends StudioRow {
  settlementReceiptId: string; sourceKind: string; purpose: string; observedState: string;
  grossMinor: number; creditedMinor: number; completedRefundMinor: number;
  pendingRefundMinor: number; fundingEligibleMinor: number; excludedMinor: number;
  excessLiabilityMinor: number; currency: "USD"; observedAt: string; provenance: Provenance;
}
export interface AllocationRow extends StudioRow {
  allocationId: string; settlementReceiptId: string; sourceKind: string;
  allocationMinor: number; activeAllocationMinor: number; isCurrent: boolean;
  revision: number; state: string; purpose: string; expenseLabel: string; reversalOf: string | null;
  claimId: string | null; evidenceId: string | null; provenance: Provenance;
}
export interface EvidenceRow extends StudioRow {
  evidenceId: string; title: string; sourceClass: string; reviewState: string;
  itemCount: number; reviewedAt: string | null; sourceAvailable: boolean;
  documentId: string | null; claimId: string | null; provenance: string;
  reviewScope: string; amountMinor: number | null;
}
export interface ExceptionRow extends StudioRow {
  exceptionId: string; operationId: string | null; category: string; severity: "attention" | "blocked";
  status: string; title: string; detail: string; affectedMinor: number;
  observedAt: string | null; ageMinutes: number | null; provenance: string;
}
export interface StudioData {
  packages: PackageRow[]; settlements: SettlementRow[]; allocations: AllocationRow[];
  evidence: EvidenceRow[]; exceptions: ExceptionRow[];
}
export interface StudioSnapshot {
  semanticVersion: typeof STUDIO_SEMANTIC_VERSION;
  /** Scope identity only; never an authorization capability. */
  scope: string;
  datasetHandle: string;
  role: WorkspaceRole;
  mode: "sample" | "live_sandbox";
  projectTitle: string;
  projectionVersion: number;
  eventCursor: number;
  asOf: string;
  contentHash?: string;
  data: StudioData;
  geometry: Record<string, BlueprintZone>;
  geometrySource?: {
    revision: number; planHash: string; geometryHash: string; state: "current" | "stale" | "revoked";
    provenance: "sample" | "reviewed_plan"; pageAspectRatio: number; outline: { x: number; y: number }[]; scaleLabel: string;
  };
  notices: string[];
}

export interface StudioField {
  id: string; name: string; kind: "text" | "number" | "boolean" | "datetime";
  unit?: "usd_minor" | "count" | "minutes"; description: string;
}
const text = (id: string, name: string, description = name): StudioField => ({ id, name, kind: "text", description });
const money = (id: string, name: string, description: string): StudioField => ({ id, name, kind: "number", unit: "usd_minor", description });
const count = (id: string, name: string, description: string): StudioField => ({ id, name, kind: "number", unit: "count", description });
const common = [text("id", "Row identity", "Stable primary key; never aggregate this identity."), text("packageId", "Package", "Shared project package identity for cross-filtering all report tables.")];
export const STUDIO_FIELDS: Record<StudioTable, StudioField[]> = {
  packages: [...common, text("title", "Package title"), text("shortTitle", "Short title"),
    money("budgetMinor", "Package budget · USD", "Approved budget once per package, in integer cents."),
    money("pledgedMinor", "Eligible commitments · USD", "Eligible conditional commitments; no funds are reserved by a wallet."),
    money("collectedMinor", "Net collected · USD", "Credited conditional receipts across Orders and invoice rails, less completed attributed refunds; excludes separate checkout tests."),
    money("fundingEligibleMinor", "Funding eligible · USD", "Net collected less pending refund reserves and exclusions; an incomplete round cannot be spent."),
    money("shortfallMinor", "Still to collect · USD", "Maximum of zero and budget less funding-eligible conditional receipts."),
    money("pendingRefundMinor", "Refunds pending · USD", "Reserved attributed refunds; not completed money movement."),
    money("completedRefundMinor", "Attributed refunds · USD", "Completed attributed refunds against conditional receipts."),
    money("excessLiabilityMinor", "Excess payment liability · USD", "Duplicate or excess provider money that cannot fund the package."),
    money("allocationReservedMinor", "Expense allocations · USD", "Active reserved or consumed receipt allocations; each source revision counted once."),
    money("availableAllocationMinor", "Available for allocation · USD", "Zero while collection is incomplete; otherwise funding eligible less active allocations."),
    money("approvedExpenseMinor", "Reviewed expense amount · USD", "Approved current claim lines; a review is neither a payable approval nor a payment."),
    money("paidExpenseMinor", "Delivered repayments · USD", "Claim-line principal on confirmed Payout items, less principal returned."),
    count("reviewedItemCount", "Accepted work evidence", "Count of accepted work-evidence requirements. Expense review does not certify physical work."),
    count("requiredItemCount", "Required work evidence", "Required evidence item count, the denominator for the evidence ring."),
    count("reviewedExpenseLineCount", "Reviewed expense lines", "Count of current approved expense lines, separate from work evidence and dollars."),
    text("fundingState", "Funding state"), text("workState", "Work state"), text("geometryRef", "Geometry reference", "Reference to scoped illustrative geometry; not a surveyed or certified plan."), text("provenance", "Provenance")],
  settlements: [...common, text("settlementReceiptId", "Settlement receipt"), text("sourceKind", "Payment rail"), text("purpose", "Contribution purpose"), text("observedState", "Observed payment state"),
    money("grossMinor", "Provider gross · USD", "Observed gross payment; includes excess liability."),
    money("creditedMinor", "Attributed credit · USD", "Credit assigned to the original obligation before refunds and exclusions."),
    money("completedRefundMinor", "Completed refunds · USD", "Completed attributed refunds only."),
    money("pendingRefundMinor", "Pending refunds · USD", "Reserved attributed refunds only."),
    money("fundingEligibleMinor", "Funding eligible · USD", "Eligible conditional credit only; test checkout receipts contribute zero."),
    money("excludedMinor", "Excluded credit · USD", "Credit excluded from package funding."),
    money("excessLiabilityMinor", "Excess liability · USD", "Provider money above the obligation; excluded from package funding."),
    text("currency", "Currency"), { id: "observedAt", name: "Provider read at", kind: "datetime", description: "Time of the authoritative provider observation; not a claim of current balance." }, text("provenance", "Provenance")],
  allocations: [...common, text("allocationId", "Allocation"), text("settlementReceiptId", "Settlement receipt"), text("sourceKind", "Payment rail"),
    money("allocationMinor", "Revision amount · USD", "Amount in this exact historical revision. Do not sum across revisions; use Active allocation for totals."),
    money("activeAllocationMinor", "Active allocation · USD", "Only the latest reserved or paid revision has value. Historical/reversed revisions contribute zero to current totals."),
    { id: "isCurrent", name: "Current revision", kind: "boolean", description: "Whether this is the allocation's current revision." },
    count("revision", "Revision", "Immutable allocation revision number; not a quantity to sum."), text("state", "Allocation state"), text("purpose", "Allocation purpose"), text("expenseLabel", "Expense line"), text("reversalOf", "Reverses revision"), text("claimId", "Expense review"), text("evidenceId", "Evidence"), text("provenance", "Provenance")],
  evidence: [...common, text("evidenceId", "Evidence"), text("title", "Source title"), text("sourceClass", "Source class"), text("reviewState", "Review state"),
    count("itemCount", "Items", "One item per evidence/package relationship. Use distinct evidenceId for a project-wide source count."),
    { id: "reviewedAt", name: "Reviewed at", kind: "datetime", description: "Recorded review time, if a review exists." },
    { id: "sourceAvailable", name: "Private source access", kind: "boolean", description: "Whether this role may open the private original; always reauthorized at the source route." },
    text("documentId", "Private source"), text("claimId", "Expense review"), text("provenance", "Source provenance"), text("reviewScope", "What the review establishes"),
    money("amountMinor", "Reviewed association · USD", "Reviewed claim-line amount assigned to this package; null for nonfinancial evidence. Never sum repeated source totals.")],
  exceptions: [...common, text("exceptionId", "Exception"), text("operationId", "Scoped operation"), text("category", "Category"), text("severity", "Severity"), text("status", "Status"), text("title", "What needs attention"), text("detail", "Explanation"),
    money("affectedMinor", "Affected · USD", "Amount affected by this exception, not an additive ledger balance; exceptions may overlap."),
    { id: "observedAt", name: "Observed at", kind: "datetime", description: "Stored observation or creation time; never invented provider freshness." },
    { id: "ageMinutes", name: "Age · minutes", kind: "number", unit: "minutes", description: "Elapsed minutes from the stored observation to this report cutoff." }, text("provenance", "Provenance")],
};
