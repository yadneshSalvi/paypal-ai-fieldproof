import type { Provenance, WorkspaceRole } from "../contracts";
import type { FundingAssignment } from "../domain/funding-positions";
import type { PurposePledgeView, SponsorView } from "./pledges";

export const FUNDING_LIFECYCLE_VERSION = "purpose-funding-v1" as const;
export type FundingChoiceKind = "return" | "reallocation" | "rollover";
export interface FundingPolicyContract {
  schemaVersion: typeof FUNDING_LIFECYCLE_VERSION; id: string; tenantId: string; projectId: string; provenance: Provenance;
  packageId: string; packageVersion: number; title: string; purpose: string; budgetMinor: number; currency: "USD";
  roundId: string; kind: "reallocation" | "rollover" | "mixed"; expiresAt: string;
  createdBy: string; membershipVersion: number; createdAt: string;
}
export interface CancellationCaseSource {
  receiptId: string; receiptVersion: number; donorObligationId: string; donorActorId: string;
  originalPackageId: string; sourceKind: "orders_capture" | "invoice_payment"; providerReferenceSuffix: string;
  sourceDigest: string; assignmentIds: string[]; assignedMinor: number; refundedMinor: number;
  pendingRefundMinor: number; excludedMinor: number; paidMinor: number; reservedMinor: number;
  weightMinor: number; availableMinor: number; entitlementMinor: number; remainderNumerator: string; refundRouteQualified: boolean;
}
export interface CancellationCaseContract {
  schemaVersion: typeof FUNDING_LIFECYCLE_VERSION; id: string; tenantId: string; projectId: string; provenance: Provenance;
  packageId: string; packageVersion: number; title: string; purpose: string; currency: "USD"; reason: string;
  revision: number; supersedesId: string | null;
  deadline: string; defaultTreatment: "return_to_original_route"; method: "largest-remainder-v1"|"source-capacity-consented-v1";
  reconciliation?:{id:string;digest:string;kind:"allocation_adjustment"|"return_attribution"|"residual_review"};
  denominatorMinor: number; totalMinor: number; sources: CancellationCaseSource[];
  conflicts: { receiptId: string; code: string; amountMinor: number }[];
  roundIds: string[]; approvedBy: string; membershipVersion: number; approvedAt: string; reviewDigest: string;
}
export interface CancellationCaseReview {
  schemaVersion: typeof FUNDING_LIFECYCLE_VERSION; packageId:string; packageVersion:number; title:string; purpose:string; currency:"USD";
  state:string; budgetMinor:number; denominatorMinor:number; totalMinor:number; sources:CancellationCaseSource[];
  conflicts:CancellationCaseContract["conflicts"]; rounds:{id:string;state:string;package_version:number}[];
  method:"largest-remainder-v1";digest:string;observedAt:string;
}
export interface FundingChoiceContract {
  schemaVersion: typeof FUNDING_LIFECYCLE_VERSION; id: string; tenantId: string; projectId: string; provenance: Provenance;
  caseId: string; caseDigest: string; receiptId: string; receiptVersion: number; sourceDigest: string;
  sourcePackageId: string; sourcePackageVersion: number; amountMinor: number; currency: "USD";
  donorActorId: string; acceptedBy: string; membershipVersion: number; version: number;
  authority: "donor" | "case_default"; kind: FundingChoiceKind;
  destination: { policyId: string; policyDigest: string; packageId: string; packageVersion: number; title: string; purpose: string; roundId: string } | null;
  consentedAt: string; expiresAt: string;
}
export interface FundingChoiceView {
  id: string; version: number; kind: FundingChoiceKind; authority: FundingChoiceContract["authority"]; amountMinor: number;
  state: string; destination: FundingChoiceContract["destination"]; consentedAt: string; expiresAt: string; revokedAt: string | null;
  executedId: string | null; code: string | null; digest: string; canRevoke: boolean; canExecute: boolean;
  returnStatus:{id:string;state:string;canCheck:boolean;canRetry:boolean}|null;
}
export interface FundingCaseView {
  id: string; version: number; revision: number; digest: string; packageId: string; packageVersion: number; title: string; purpose: string;
  reason: string; deadline: string; defaultTreatment: "return_to_original_route"; state: string; createdAt: string;
  totalMinor: number; denominatorMinor: number; paidMinor: number; reservedMinor: number; returnedMinor: number;
  movedMinor: number; unresolvedMinor: number; conflicts: CancellationCaseContract["conflicts"];
  method:CancellationCaseContract["method"]; reconciliationId:string|null;
  sources: (Omit<CancellationCaseSource,"donorActorId"|"sourceDigest"> & { own: boolean; choice: FundingChoiceView | null })[];
  history: { id: string; kind: string; detail: string; createdAt: string }[];
}
export interface FundingDesk {
  schemaVersion: typeof FUNDING_LIFECYCLE_VERSION; projectId: string; projectTitle: string; role: WorkspaceRole; allowedRoles?: WorkspaceRole[]; mode: "sample" | "live_sandbox";
  observedAt: string; checkoutEnabled: boolean;
  packages: { id: string; version: number; title: string; purpose: string; budgetMinor: number; eligibleMinor: number; availableMinor: number; state: string; hasRound: boolean }[];
  policies: { id: string; digest: string; packageId: string; packageVersion: number; title: string; purpose: string; budgetMinor: number; remainingMinor: number; pledgedMinor: number; kind: FundingPolicyContract["kind"]; state: string; expiresAt: string }[];
  cases: FundingCaseView[];
  pledges: PurposePledgeView[]; sponsors: SponsorView[];
}
export type CommittedFundingAssignment = FundingAssignment & { kind: "reallocation" | "rollover" };
export interface FundingReceiptTrail {
  id:string;version:number;originalPackageId:string;originalPackageVersion:number|null;originalTitle:string;originalPurpose:string|null;sourceKind:"orders_capture"|"invoice_payment";referenceSuffix:string;
  provenance:Provenance;observedAt:string;grossMinor:number;creditedMinor:number;returnedMinor:number;pendingReturnMinor:number;
  positions:{packageId:string;title:string;assignedMinor:number;returnedMinor:number;pendingReturnMinor:number;paidMinor:number;reservedMinor:number;excludedMinor:number;availableMinor:number}[];
  decisions:{id:string;kind:string;amountMinor:number;fromPackageId:string;fromVersion:number;toPackageId:string;toVersion:number;title:string;purpose:string;consentedAt:string;committedAt:string}[];
  returns:{id:string;amountMinor:number;state:string;requestedAt:string;completedAt:string|null;sample:boolean;reconciledOutside?:boolean}[];
}
