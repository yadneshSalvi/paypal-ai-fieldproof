import type { Provenance } from "../contracts";

export const PURPOSE_PLEDGE_VERSION = "purpose-pledge-v1" as const;
export function currentPledgeCommitment(input:{state:string;amountMinor:number;collectedMinor:number;expiresAt:string;operationId:string|null},now=Date.now()):number{
  if(["withdrawn","expired","cancelled","returned","partially_collected"].includes(input.state)||!input.operationId&&Date.parse(input.expiresAt)<=now)return input.collectedMinor;
  return Math.max(input.amountMinor,input.collectedMinor);
}
export interface PurposePledgeContract {
  schemaVersion: typeof PURPOSE_PLEDGE_VERSION; id: string; tenantId: string; projectId: string; provenance: Provenance;
  version: number; donorActorId: string; membershipVersion: number; acceptedAt: string; expiresAt: string;
  obligationId: string; policyId: string; policyDigest: string; roundId: string;
  packageId: string; packageVersion: number; title: string; purpose: string; amountMinor: number; currency: "USD";
  kind: "donor" | "grant" | "match"; sponsorAcceptanceId: string | null; sponsorEventId: string | null;
  paymentMode: "buyer_present"; cancellationTreatment: "return_to_original_route";
}
export interface PurposePledgeView {
  id: string; version: number; digest: string; packageId: string; packageVersion: number; title: string; purpose: string;
  kind: PurposePledgeContract["kind"]; amountMinor: number; collectedMinor: number; pendingMinor: number;
  state: string; own: boolean; acceptedAt: string; expiresAt: string; operationId: string | null;orderId:string|null;
  lastCode: string | null; canWithdraw: boolean; canCheckout: boolean; canCheck: boolean; canRetry:boolean;receiptIds:string[];
}
export const SPONSOR_VERSION = "purpose-sponsor-v1" as const;
export interface SponsorOfferContract {
  schemaVersion: typeof SPONSOR_VERSION; id: string; tenantId: string; projectId: string; provenance: Provenance;
  version: number; kind: "grant" | "match"; name: string; note: string; totalCapMinor: number; matchBasisPoints: number;
  packages: { policyId: string; policyDigest: string; packageId: string; packageVersion: number; title: string; purpose: string; capMinor: number }[];
  currency: "USD"; expiresAt: string; createdBy: string; membershipVersion: number; createdAt: string;
  eligibility: "new_settled_donor_credit_after_acceptance" | "fixed_grant";
  cancellationTreatment: "return_to_original_route";
}
export interface SponsorAcceptanceContract {
  schemaVersion: typeof SPONSOR_VERSION; id: string; tenantId: string; projectId: string; provenance: Provenance;
  offerId: string; offerDigest: string; version: number; sponsorActorId: string; membershipVersion: number;
  acceptedAt: string; expiresAt: string;
}
export interface SponsorEventContract {
  schemaVersion: typeof SPONSOR_VERSION; id: string; tenantId: string; projectId: string; provenance: Provenance;
  offerId: string; acceptanceId: string; policyId: string; packageId: string; packageVersion: number;
  receiptId: string; receiptVersion: number; sourceDigest: string; eligibleMinor: number; matchMinor: number;
  pledgeId: string | null; observedAt: string;
}
export interface SponsorView {
  id: string; version: number; digest: string; kind: "grant" | "match"; name: string; note: string; state: string;
  totalCapMinor: number; matchBasisPoints: number; expiresAt: string; acceptedAt: string | null; own: boolean;
  pledgedMinor: number; collectedMinor: number; remainingCapMinor: number; canAccept: boolean; canWithdraw: boolean; canReview: boolean;
  packages: SponsorOfferContract["packages"];
  events: { id: string; packageId: string; eligibleMinor: number; matchMinor: number; state: string; observedAt: string; receiptId: string | null }[];
}
