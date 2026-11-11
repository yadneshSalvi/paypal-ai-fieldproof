import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import type { PurposePledgeContract, SponsorAcceptanceContract, SponsorEventContract, SponsorOfferContract } from "../funding/pledges";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { query } from "./db";
import { openPrivate } from "./private-values";

export type PurposeScope = Pick<Session,"tenantId"|"projectId">;
export const pledgeContext=(scope:PurposeScope,id:string)=>`purpose-pledge:${scope.tenantId}:${scope.projectId}:${id}`;
export const sponsorContext=(scope:PurposeScope,kind:"offer"|"acceptance"|"event",id:string)=>`sponsor-${kind}:${scope.tenantId}:${scope.projectId}:${id}`;
export interface PledgeRow {id:string;tenant_id:string;project_id:string;policy_id:string;round_id:string;obligation_id:string;package_id:string;package_version:number;donor_actor_id:string;membership_version:number;version:number;kind:PurposePledgeContract["kind"];sponsor_acceptance_id:string|null;sponsor_event_id:string|null;amount_minor:string;state:string;operation_id:string|null;last_code:string|null;collected_minor:string;expires_at:Date;digest:string;encrypted_data:string;created_at:Date}
export interface SponsorOfferRow {id:string;tenant_id:string;project_id:string;version:number;kind:SponsorOfferContract["kind"];state:string;created_by:string;membership_version:number;total_cap_minor:string;expires_at:Date;digest:string;encrypted_data:string;created_at:Date}
export interface SponsorAcceptanceRow {id:string;tenant_id:string;project_id:string;offer_id:string;version:number;sponsor_actor_id:string;membership_version:number;state:string;expires_at:Date;digest:string;encrypted_data:string;created_at:Date}
export interface SponsorEventRow {id:string;tenant_id:string;project_id:string;offer_id:string;acceptance_id:string;receipt_id:string;policy_id:string;pledge_id:string|null;package_id:string;eligible_minor:string;match_minor:string;digest:string;encrypted_data:string;created_at:Date}
function invalid():never {throw new DomainError("PURPOSE_CONTRACT_CHANGED","This saved support agreement needs review before it can be used.");}
function base<T extends {id:string;tenantId:string;projectId:string}>(row:{id:string;tenant_id:string;project_id:string;digest:string;encrypted_data:string},context:string):T{
  const value=openPrivate<T>(row.encrypted_data,context);if(value.id!==row.id||value.tenantId!==row.tenant_id||value.projectId!==row.project_id||sha256(canonicalJson(value))!==row.digest)invalid();return value;
}
export function pledgeContract(row:PledgeRow):PurposePledgeContract{
  const value=base<PurposePledgeContract>(row,pledgeContext({tenantId:row.tenant_id,projectId:row.project_id},row.id));
  if(value.policyId!==row.policy_id||value.roundId!==row.round_id||value.obligationId!==row.obligation_id||value.packageId!==row.package_id||value.packageVersion!==row.package_version||value.donorActorId!==row.donor_actor_id||value.membershipVersion!==row.membership_version||value.version!==row.version||value.kind!==row.kind||value.sponsorAcceptanceId!==row.sponsor_acceptance_id||value.sponsorEventId!==row.sponsor_event_id||value.amountMinor!==Number(row.amount_minor)||Date.parse(value.expiresAt)!==row.expires_at.getTime())invalid();return value;
}
export function sponsorOfferContract(row:SponsorOfferRow):SponsorOfferContract{
  const value=base<SponsorOfferContract>(row,sponsorContext({tenantId:row.tenant_id,projectId:row.project_id},"offer",row.id));
  if(value.version!==row.version||value.kind!==row.kind||value.createdBy!==row.created_by||value.membershipVersion!==row.membership_version||value.totalCapMinor!==Number(row.total_cap_minor)||Date.parse(value.expiresAt)!==row.expires_at.getTime())invalid();return value;
}
export function sponsorAcceptanceContract(row:SponsorAcceptanceRow):SponsorAcceptanceContract{
  const value=base<SponsorAcceptanceContract>(row,sponsorContext({tenantId:row.tenant_id,projectId:row.project_id},"acceptance",row.id));
  if(value.offerId!==row.offer_id||value.version!==row.version||value.sponsorActorId!==row.sponsor_actor_id||value.membershipVersion!==row.membership_version||Date.parse(value.expiresAt)!==row.expires_at.getTime())invalid();return value;
}
export function sponsorEventContract(row:SponsorEventRow):SponsorEventContract{
  const value=base<SponsorEventContract>(row,sponsorContext({tenantId:row.tenant_id,projectId:row.project_id},"event",row.id));
  if(value.offerId!==row.offer_id||value.acceptanceId!==row.acceptance_id||value.receiptId!==row.receipt_id||value.policyId!==row.policy_id||value.pledgeId!==row.pledge_id||value.packageId!==row.package_id||value.eligibleMinor!==Number(row.eligible_minor)||value.matchMinor!==Number(row.match_minor))invalid();return value;
}
export async function ownedPledge(scope:PurposeScope,id:string,tx:SqlConnection):Promise<PledgeRow>{const [row]=await query<PledgeRow>("SELECT * FROM fp_purpose_pledges WHERE id=$1 AND tenant_id=$2 AND project_id=$3",[id,scope.tenantId,scope.projectId],tx);if(!row)throw new DomainError("PLEDGE_NOT_FOUND","That support pledge is outside this workspace.",404);pledgeContract(row);return row;}
/** Promises reserve target capacity, never cash or expense availability. */
export async function outstandingPurposePledges(scope:PurposeScope,packageId:string,tx:SqlConnection,exceptId:string|null=null):Promise<number>{
  const [row]=await query<{amount:string}>(`SELECT COALESCE(sum(GREATEST(amount_minor-collected_minor,0)),0) amount FROM fp_purpose_pledges
    WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 AND state NOT IN ('withdrawn','expired','collected','partially_collected','returned','cancelled')
      AND NOT(operation_id IS NULL AND expires_at<=clock_timestamp()) AND ($4::text IS NULL OR id<>$4)`,[scope.tenantId,scope.projectId,packageId,exceptId],tx);
  return Number(row.amount);
}
