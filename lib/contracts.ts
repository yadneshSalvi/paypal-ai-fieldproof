export type Provenance = "sample" | "live_sandbox" | "replay" | "modelled";
export type WorkspaceRole = "donor" | "volunteer" | "organizer" | "auditor";
export type FundingState = "open" | "ready" | "collecting" | "recovering" | "funded" | "compensating" | "cancelled";
export type CollectionChannel = "uncollected" | "original_in_flight" | "collected" | "definitively_declined" | "unknown_reconciling" | "recovery_invoice_open" | "excess_reconciliation" | "compensating" | "refunding" | "refunded" | "cancelled";

export interface Point { x: number; y: number }
export interface BlueprintZone {
  packageId: string;
  points: Point[];
  label: Point;
  rotation?: number;
}
export interface SettlementReceipt {
  id: string;
  tenantId: string;
  projectId: string;
  packageId: string;
  donorObligationId: string;
  sourceKind: "orders_capture" | "invoice_payment";
  provenance: Provenance;
  actualProviderPaymentRef: string;
  economicAliases: string[];
  sourceOrderId: string | null;
  sourceInvoiceId: string | null;
  authoritativeObservedState: "COMPLETED" | "PENDING" | "UNKNOWN";
  observedAt: string;
  currency: "USD";
  grossSettledMinor: number;
  creditedMinor: number;
  completedAttributedRefundMinor: number;
  pendingAttributedRefundReserveMinor: number;
  excludedMinor: number;
  excessLiabilityMinor: number;
  provenRefundableRef: string | null;
  refundAdapter: "capture_refund" | "unqualified";
}
export interface FundingTotals {
  collectedMinor: number;
  fundingEligibleMinor: number;
  shortfallMinor: number;
  pendingRefundMinor: number;
  excessLiabilityMinor: number;
}
export interface PackageView extends FundingTotals {
  id: string;
  title: string;
  shortTitle: string;
  description: string;
  budgetMinor: number;
  pledgedMinor: number;
  version: number;
  fundingState: FundingState;
  workState: "planned" | "review_needed" | "accepted";
  evidenceAccepted: number;
  evidenceRequired: number;
  dependencies: string[];
  category: string;
  icon: "spark" | "printer" | "laser" | "saw" | "shield" | "box" | "leaf" | "drop" | "path" | "hand" | "truck";
  zone: BlueprintZone;
}
export interface DonorObligation {
  id: string;
  packageId: string;
  donorLabel: string;
  amountMinor: number;
  channel: CollectionChannel;
  consentVersion: number;
  provenance: Provenance;
  createdAt: string;
  purpose: "conditional_pledge" | "sandbox_test";
}
export interface EvidenceItem {
  id: string;
  title: string;
  kind: "receipt" | "photo" | "signoff" | "quote";
  packageIds: string[];
  provenance: Provenance;
  state: "pending_review" | "accepted" | "rejected";
  submittedBy: string;
  amountMinor?: number;
  description: string;
  reviewer: string | null;
  reviewedAt: string | null;
  assetPath: string | null;
}
export interface ProjectEvent {
  id: string;
  sequence: number;
  type: string;
  title: string;
  detail: string;
  provenance: Provenance;
  occurredAt: string;
}
export interface ApprovalRecord {
  id: string;
  tenantId: string;
  actorId: string;
  operation: string;
  resourceId: string;
  resourceVersion: number;
  amountMinor: number;
  currency: "USD";
  recipientVersion: number | null;
  policyHash: string;
  digest: string;
  expiresAt: string;
  revokedAt: string | null;
}
export interface ProjectSnapshot {
  templateId?: import("./community/templates").TemplateId;
  templateWorkspace?: boolean;
  id: string;
  tenantId: string;
  slug: string;
  title: string;
  subtitle: string;
  organizer: string;
  location: string;
  currency: "USD";
  mode: "sample" | "live_sandbox";
  version: number;
  projectionVersion: number;
  targetMinor: number;
  deadline: string;
  packages: PackageView[];
  obligations: DonorObligation[];
  receipts: SettlementReceipt[];
  evidence: EvidenceItem[];
  events: ProjectEvent[];
  tourStep: number;
  session: { role: WorkspaceRole; actorId: string; expiresAt: string } | null;
  capabilities: { checkoutConfigured: boolean; savedWalletQualified: boolean; payoutQualified: boolean; invoiceQualified: boolean; studioConfigured: boolean };
}

export interface CollectionRound {
  id: string;
  packageId: string;
  packageVersion: number;
  targetMinor: number;
  collectionStartedAt: string;
  recoveryEndsAt: string;
  policyHash: string;
}
export interface ApiProblem { error: string; code: string; requestId?: string }
export const ELECTRONICS_ID = "electronics";
export const HERO_OBLIGATION_AMOUNTS = [20000, 20000, 17500, 15000, 10000, 5000, 5000, 3500] as const;
export const RECOVERY_WINDOW_MS = 48 * 60 * 60 * 1000;
