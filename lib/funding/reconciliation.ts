import type { Provenance } from "../contracts";
import type { CancellationCaseSource } from "./contracts";

export const FUNDING_RECONCILIATION_VERSION = "funding-reconciliation-v1" as const;
export interface FundingRecoveryBlocker { code:string; detail:string; receiptId?:string }
export interface AllocationEvidence {
  id:string; receiptId:string; claimId:string; payableId:string|null; packageId:string; kind:string;
  amountMinor:number; state:string; revision:number; digest:string; verified:boolean; detail:string;
}
export interface AdjustmentShare {
  receiptId:string; donorActorId:string; originalMinor:number; proposedMinor:number; paidMinor:number;
  source:CancellationCaseSource;
}
export interface AllocationAdjustmentContract {
  schemaVersion:typeof FUNDING_RECONCILIATION_VERSION; id:string; tenantId:string; projectId:string; provenance:Provenance;
  kind:"allocation_adjustment"; caseId:string; caseDigest:string; packageId:string; packageVersion:number;
  title:string; purpose:string; reason:string; basisDigest:string; denominatorMinor:number; totalMinor:number;
  deadline:string; shares:AdjustmentShare[]; evidence:AllocationEvidence[];
  createdBy:string; membershipVersion:number; createdAt:string;
}
export interface AdjustmentConsentContract {
  schemaVersion:typeof FUNDING_RECONCILIATION_VERSION; id:string; reconciliationId:string; reconciliationDigest:string;
  tenantId:string; projectId:string; actorId:string; membershipVersion:number; version:number;
  decision:"accept"|"decline"; shares:{receiptId:string; originalMinor:number; proposedMinor:number}[];
  acceptedAt:string; deadline:string;
}
export interface AdjustmentView {
  id:string; digest:string; version:number; state:string; reason:string; deadline:string; createdAt:string;
  appliedAt:string|null; resultCaseId:string|null; totalMinor:number;
  supporters:number; accepted:number; declined:number;
  ownConsent:{id:string; version:number; state:string; decision:"accept"|"decline"}|null;
  shares:{receiptId:string; originalMinor:number; proposedMinor:number; paidMinor:number; own:boolean}[];
  evidence:AllocationEvidence[]; canRespond:boolean; canRevoke:boolean; canApply:boolean; canWithdraw:boolean;
}
export interface CaseRecoveryReview {
  caseId:string; caseDigest:string; packageId:string; title:string; purpose:string; revision:number; state:string;
  deadline:string; observedAt:string; digest:string; denominatorMinor:number; totalMinor:number;
  sources:{receiptId:string; originalMinor:number; proposedMinor:number; paidMinor:number; reservedMinor:number; excludedMinor:number; pendingReturnMinor:number; own:boolean}[];
  evidence:AllocationEvidence[]; blockers:FundingRecoveryBlocker[]; canPropose:boolean; canRefreshCase:boolean;
  adjustments:AdjustmentView[];
}
export interface OriginalReturnEvidence {
  schemaVersion:typeof FUNDING_RECONCILIATION_VERSION; provenance:"sample"|"live_sandbox";
  captureId:string; captureStatus:string; capturedMinor:number; currency:"USD"; observedAt:string;
  historyComplete:boolean; owningOrderId:string|null;
  refunds:{id:string; status:string; amountMinor:number; captureId:string}[];
}
export interface ReturnHoldContract {
  schemaVersion:typeof FUNDING_RECONCILIATION_VERSION; id:string; tenantId:string; projectId:string; receiptId:string;
  receiptVersion:number; sourceDigest:string; createdAt:string; createdBy:string;
  providerIds:string[]; consumedMinor:number; positions:{packageId:string; amountMinor:number}[];
  policies:{id:string;packageId:string;state:string}[];
}
export interface ReturnObservationContract {
  schemaVersion:typeof FUNDING_RECONCILIATION_VERSION; id:string; tenantId:string; projectId:string;
  receiptId:string; receiptVersion:number; sourceDigest:string; evidence:OriginalReturnEvidence;
  createdBy:string; membershipVersion:number; createdAt:string;
}
export interface ReturnAttributionContract {
  schemaVersion:typeof FUNDING_RECONCILIATION_VERSION; id:string; tenantId:string; projectId:string; provenance:Provenance;
  kind:"return_attribution"; receiptId:string; receiptVersion:number; sourceDigest:string;
  observationId:string; observationDigest:string; holdId:string; holdDigest:string; reviewDigest:string;
  packageId:string; originalPackageVersion:number; amountMinor:number; releasedMinor:number;
  returns:{id:string; amountMinor:number}[]; reason:string; createdBy:string; membershipVersion:number; createdAt:string;
}
export interface ReturnRecoveryReview {
  receiptId:string; receiptVersion:number; referenceSuffix:string; originalPackageId:string; originalTitle:string;
  provenance:"sample"|"live_sandbox"; digest:string; observedAt:string;
  heldMinor:number; availableMinor:number; paidMinor:number; pendingReturnMinor:number; alreadyReturnedMinor:number;
  observation:{id:string; digest:string; observedAt:string; historyComplete:boolean; captureStatus:string; returns:{referenceSuffix:string; amountMinor:number; state:string; recorded:boolean}[]}|null;
  attributableMinor:number; releasableMinor:number; blockers:FundingRecoveryBlocker[];
  canObserve:boolean; canReconcile:boolean; hasHold:boolean; caseIds:string[];
  history:{id:string; kind:string; detail:string; createdAt:string}[];
}
