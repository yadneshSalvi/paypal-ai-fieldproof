import { randomUUID } from "node:crypto";
import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import { packagePositionTotals, projectFundingPositions } from "../domain/funding-positions";
import { DomainError } from "../domain/money";
import { SPONSOR_VERSION, currentPledgeCommitment, type SponsorAcceptanceContract, type SponsorEventContract, type SponsorOfferContract, type SponsorView } from "../funding/pledges";
import type { Session } from "./auth";
import { projectClaimLock } from "./claims";
import { database, initializeDatabase, query } from "./db";
import { actionResult, currentDestination, saveAction } from "./funding-lifecycle";
import { lockFundingScope, readFundingJournal } from "./funding-positions";
import { fundingSourceDigest } from "./funding-writes";
import { requireCurrentRole, requireMembership } from "./membership";
import { sealPrivate } from "./private-values";
import { insertPurposePledge, purposeScope } from "./purpose-pledges";
import { outstandingPurposePledges, pledgeContract, sponsorAcceptanceContract, sponsorContext, sponsorEventContract, sponsorOfferContract, type PledgeRow, type SponsorAcceptanceRow, type SponsorEventRow, type SponsorOfferRow } from "./purpose-store";
import { appendEvent } from "./repository";
import { bindProjectPolicyArtifacts, enforceProjectFundDecision } from "./project-policy";

const id=z.string().min(1).max(160),digest=z.string().regex(/^[a-f0-9]{64}$/),minor=z.number().int().positive().max(100_000_000);
export const sponsorOfferSchema=z.object({intentId:z.string().uuid(),kind:z.enum(["grant","match"]),name:z.string().trim().min(3).max(100),note:z.string().trim().min(12).max(600),
  totalCapMinor:minor,matchBasisPoints:z.number().int().min(1).max(40_000),expiresAt:z.string().datetime(),packages:z.array(z.object({policyId:id,policyDigest:digest,capMinor:minor}).strict()).min(1).max(20),acknowledged:z.literal(true)}).strict();
export const sponsorActionSchema=z.object({intentId:z.string().uuid(),offerId:id,digest,expectedVersion:z.number().int().positive(),acknowledged:z.literal(true)}).strict();
async function ownedOffer(session:Pick<Session,"tenantId"|"projectId">,offerId:string,tx:SqlConnection){const [row]=await query<SponsorOfferRow>("SELECT * FROM fp_sponsor_offers WHERE id=$1 AND tenant_id=$2 AND project_id=$3",[offerId,session.tenantId,session.projectId],tx);if(!row)throw new DomainError("SPONSOR_OFFER_NOT_FOUND","That agreement is outside this workspace.",404);return row;}
export async function createSponsorOffer(session:Session,raw:z.infer<typeof sponsorOfferSchema>):Promise<{id:string}>{
  const input=sponsorOfferSchema.parse(raw);await initializeDatabase();return database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);const member=await requireCurrentRole(session,"organizer",tx);
    const prior=await actionResult(tx,session,input.intentId,"sponsor_offer",input);if(prior)return prior;
    if(new Set(input.packages.map(pkg=>pkg.policyId)).size!==input.packages.length)throw new DomainError("SPONSOR_PACKAGE_DUPLICATE","Choose each purpose once.");
    if(Date.parse(input.expiresAt)<=Date.now()+60_000)throw new DomainError("SPONSOR_EXPIRY","Choose a future acceptance deadline within the purposes' current windows.");
    const packages:SponsorOfferContract["packages"]=[];
    for(const pkg of input.packages){const target=await currentDestination(session,pkg.policyId,pkg.policyDigest,null,tx);if(pkg.capMinor>target.value.budgetMinor||Date.parse(input.expiresAt)>Date.parse(target.value.expiresAt))throw new DomainError("SPONSOR_POLICY_LIMIT","Every package cap and agreement deadline must fit its exact current purpose policy.");packages.push({policyId:target.value.id,policyDigest:target.row.digest,packageId:target.value.packageId,packageVersion:target.value.packageVersion,title:target.value.title,purpose:target.value.purpose,capMinor:pkg.capMinor});}
    const packageCap=packages.reduce((sum,pkg)=>sum+pkg.capMinor,0);
    if(input.totalCapMinor>packageCap||input.kind==="grant"&&input.totalCapMinor!==packageCap)throw new DomainError("SPONSOR_TOTAL_CAP","A grant must allocate its exact total across purposes; a matching cap cannot exceed the sum of its package caps.");
    const policyRules=await enforceProjectFundDecision(tx,session,{consumer:"sponsor_offer",packages:packages.map(pkg=>({packageId:pkg.packageId,sponsorCapMinor:pkg.capMinor})),sponsorKind:input.kind,matchBasisPoints:input.matchBasisPoints,totalCapMinor:input.totalCapMinor});
    const id=randomUUID(),value:SponsorOfferContract={schemaVersion:SPONSOR_VERSION,id,...purposeScope(session),version:1,kind:input.kind,name:input.name,note:input.note,totalCapMinor:input.totalCapMinor,matchBasisPoints:input.kind==="grant"?0:input.matchBasisPoints,packages,currency:"USD",expiresAt:input.expiresAt,createdBy:session.actorId,membershipVersion:member.membershipVersion,createdAt:new Date().toISOString(),eligibility:input.kind==="grant"?"fixed_grant":"new_settled_donor_credit_after_acceptance",cancellationTreatment:"return_to_original_route"};
    const hash=sha256(canonicalJson(value));await tx.query("INSERT INTO fp_sponsor_offers(id,tenant_id,project_id,kind,created_by,membership_version,total_cap_minor,expires_at,digest,encrypted_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[id,session.tenantId,session.projectId,value.kind,session.actorId,member.membershipVersion,value.totalCapMinor,value.expiresAt,hash,sealPrivate(value,sponsorContext(session,"offer",id))]);
    await bindProjectPolicyArtifacts(tx,policyRules,"sponsor_offer",id,hash,session);
    await saveAction(tx,session,input.intentId,"sponsor_offer",input,{id});await appendEvent(tx,session,"funding.sponsor_offer","A bounded support agreement is ready","The named purposes, total and package limits, deadline and cancellation treatment are explicit. No sponsor has accepted or paid merely because this offer exists.");return{id};
  });
}
export async function acceptSponsorOffer(session:Session,raw:z.infer<typeof sponsorActionSchema>):Promise<{id:string}>{
  const input=sponsorActionSchema.parse(raw);return database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);const member=await requireCurrentRole(session,"donor",tx);
    const prior=await actionResult(tx,session,input.intentId,"sponsor_accept",input);if(prior)return prior;
    const row=await ownedOffer(session,input.offerId,tx),offer=sponsorOfferContract(row);
    if(row.state!=="offered"||row.version!==input.expectedVersion||row.digest!==input.digest||row.expires_at.getTime()<=Date.now())throw new DomainError("SPONSOR_OFFER_CHANGED","This agreement changed, was already accepted or passed its deadline. Review the current record.");
    const organizer=await requireMembership(session.tenantId,session.projectId,offer.createdBy,"organizer",tx);if(organizer.version!==offer.membershipVersion)throw new DomainError("SPONSOR_ORGANIZER_CHANGED","The organizer's authority changed after this offer was prepared.");
    const targets=[];for(const pkg of offer.packages){const target=await currentDestination(session,pkg.policyId,pkg.policyDigest,null,tx);targets.push({pkg,target});}
    const policyRules=await enforceProjectFundDecision(tx,session,{consumer:"sponsor_offer",packages:offer.packages.map(pkg=>({packageId:pkg.packageId,sponsorCapMinor:pkg.capMinor})),sponsorKind:offer.kind,matchBasisPoints:offer.matchBasisPoints,totalCapMinor:offer.totalCapMinor});
    const journal=await readFundingJournal(purposeScope(session),tx),projection=projectFundingPositions(journal,purposeScope(session));
    if(offer.kind==="grant")for(const {pkg,target} of targets){const eligible=packagePositionTotals(projection.positions,pkg.packageId,target.value.budgetMinor).fundingEligibleMinor;if(eligible+await outstandingPurposePledges(session,pkg.packageId,tx)+pkg.capMinor>target.value.budgetMinor)throw new DomainError("GRANT_CAPACITY","The full grant no longer fits these purposes after existing support. A new exact offer needs review.");}
    const id=randomUUID(),acceptedAt=new Date().toISOString(),value:SponsorAcceptanceContract={schemaVersion:SPONSOR_VERSION,id,...purposeScope(session),offerId:offer.id,offerDigest:row.digest,version:1,sponsorActorId:session.actorId,membershipVersion:member.membershipVersion,acceptedAt,expiresAt:offer.expiresAt};
    await tx.query("INSERT INTO fp_sponsor_acceptances(id,tenant_id,project_id,offer_id,sponsor_actor_id,membership_version,expires_at,digest,encrypted_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[id,session.tenantId,session.projectId,offer.id,session.actorId,member.membershipVersion,value.expiresAt,sha256(canonicalJson(value)),sealPrivate(value,sponsorContext(session,"acceptance",id))]);
    await bindProjectPolicyArtifacts(tx,policyRules,"sponsor_offer",`accept:${id}`,sha256(canonicalJson(value)),session);
    await tx.query("UPDATE fp_sponsor_offers SET state='accepted' WHERE id=$1",[offer.id]);
    if(offer.kind==="grant")for(const {pkg,target} of targets)await insertPurposePledge(tx,session,target.value,target.row.digest,{amountMinor:pkg.capMinor,donorActorId:session.actorId,membershipVersion:member.membershipVersion,kind:"grant",sponsorAcceptanceId:id,acceptedAt,expiresAt:value.expiresAt});
    await saveAction(tx,session,input.intentId,"sponsor_accept",input,{id:offer.id});await appendEvent(tx,session,"funding.sponsor_accepted",offer.kind==="grant"?"A grant was accepted; collection is next":"A matching agreement has a current sponsor",offer.kind==="grant"?"The sponsor explicitly accepted each named purpose and amount. These promises become funding only after their own confirmed settlement.":"Only new, settled support from other donors after acceptance can earn a matching pledge. Each economic receipt counts once, within the total and package caps. The sponsor still approves each checkout.");return{id:offer.id};
  });
}

async function backing(tx:SqlConnection,session:Pick<Session,"tenantId"|"projectId">,acceptanceId:string){
  const [row]=await query<SponsorAcceptanceRow>("SELECT * FROM fp_sponsor_acceptances WHERE id=$1 AND tenant_id=$2 AND project_id=$3",[acceptanceId,session.tenantId,session.projectId],tx);
  if(!row)throw new DomainError("SPONSOR_ACCEPTANCE_MISSING","This pledge has no exact accepted sponsor agreement.");const acceptance=sponsorAcceptanceContract(row),offerRow=await ownedOffer(session,row.offer_id,tx),offer=sponsorOfferContract(offerRow);
  if(row.state!=="accepted"||offerRow.state!=="accepted"||row.expires_at.getTime()<=Date.now()||offerRow.digest!==acceptance.offerDigest)throw new DomainError("SPONSOR_AUTHORITY_CHANGED","The sponsor agreement has ended, was withdrawn or needs review.");
  const member=await requireMembership(session.tenantId,session.projectId,row.sponsor_actor_id,"donor",tx),organizer=await requireMembership(session.tenantId,session.projectId,offer.createdBy,"organizer",tx);
  if(member.version!==row.membership_version||organizer.version!==offer.membershipVersion)throw new DomainError("SPONSOR_MEMBERSHIP_CHANGED","A sponsor or organizer no longer has the authority recorded in this agreement.");
  return {row,acceptance,offerRow,offer};
}
export async function assertSponsorBacking(tx:SqlConnection,session:Session,pledge:PledgeRow):Promise<void>{
  const value=pledgeContract(pledge);if(!value.sponsorAcceptanceId)throw new DomainError("SPONSOR_ACCEPTANCE_MISSING","The exact sponsor acceptance is required.");
  const {acceptance,offer}=await backing(tx,session,value.sponsorAcceptanceId);
  if(acceptance.sponsorActorId!==value.donorActorId||offer.kind!==value.kind||!offer.packages.some(pkg=>pkg.policyId===value.policyId&&pkg.policyDigest===value.policyDigest&&pkg.packageVersion===value.packageVersion))throw new DomainError("SPONSOR_SCOPE_CHANGED","The pledge no longer matches its exact sponsor, kind and package scope.");
  if(value.kind==="match"){
    const [event]=await query<SponsorEventRow>("SELECT * FROM fp_sponsor_events WHERE id=$1 AND pledge_id=$2 AND acceptance_id=$3",[value.sponsorEventId,value.id,value.sponsorAcceptanceId],tx);if(!event)throw new DomainError("MATCH_BASIS_MISSING","The exact settled donor event must establish this matching pledge.");
    const evidence=sponsorEventContract(event),journal=await readFundingJournal(purposeScope(session),tx);
    if(evidence.sourceDigest!==fundingSourceDigest(journal,evidence.receiptId))throw new DomainError("MATCH_BASIS_CHANGED","The underlying contribution changed after this match was earned. Review the original settlement and any return first.");
  }
}

/** No financial dispatch: an accepted capped agreement may earn a promise only.
 * All events, including sub-cent matches, are immutable so a retry cannot count
 * the same payment again or discard a rational remainder. */
export async function refreshSponsorsForScope(tx:SqlConnection,session:Session):Promise<void>{
  const scope=purposeScope(session),journal=await readFundingJournal(scope,tx),projection=projectFundingPositions(journal,scope);
  const acceptances=await query<SponsorAcceptanceRow>("SELECT * FROM fp_sponsor_acceptances WHERE tenant_id=$1 AND project_id=$2 AND state='accepted' ORDER BY created_at,id",[session.tenantId,session.projectId],tx);
  for(const accepted of acceptances){
    let saved:Awaited<ReturnType<typeof backing>>;try{saved=await backing(tx,session,accepted.id);}catch(error){if(error instanceof DomainError)continue;throw error;}
    const {offer,offerRow,acceptance}=saved;if(offer.kind!=="match")continue;
    const events=await query<SponsorEventRow>("SELECT * FROM fp_sponsor_events WHERE offer_id=$1 ORDER BY created_at,id",[offer.id],tx);
    for(const event of events){const evidence=sponsorEventContract(event);if(evidence.sourceDigest!==fundingSourceDigest(journal,evidence.receiptId)){
      if(event.pledge_id)await tx.query("UPDATE fp_purpose_pledges SET state=CASE WHEN state='pledged' THEN 'held' ELSE state END,last_code='MATCH_BASIS_CHANGED' WHERE id=$1",[event.pledge_id]);
      await tx.query("UPDATE fp_sponsor_offers SET state='review_required' WHERE id=$1",[offer.id]);
    }}
    if(events.some(event=>sponsorEventContract(event).sourceDigest!==fundingSourceDigest(journal,event.receipt_id)))continue;
    let earned=events.reduce((sum,event)=>sum+Number(event.match_minor),0);
    const sources=await query<{receipt_id:string;receipt_version:number;pledge_id:string;donor_actor_id:string;policy_id:string;package_id:string;created_at:Date}>(
      `SELECT r.id receipt_id,r.version receipt_version,p.id pledge_id,p.donor_actor_id,p.policy_id,p.package_id,r.created_at FROM fp_settlement_receipts r
       JOIN fp_purpose_pledges p ON p.obligation_id=r.obligation_id AND p.tenant_id=r.tenant_id AND p.project_id=r.project_id
       WHERE r.tenant_id=$1 AND r.project_id=$2 AND p.kind='donor' AND p.donor_actor_id<>$3 AND r.created_at>=$4 ORDER BY r.created_at,r.id`,[session.tenantId,session.projectId,acceptance.sponsorActorId,acceptance.acceptedAt],tx);
    for(const source of sources){
      if(events.some(event=>event.receipt_id===source.receipt_id))continue;
      const pkg=offer.packages.find(pkg=>pkg.policyId===source.policy_id&&pkg.packageId===source.package_id);if(!pkg)continue;
      const position=projection.positions.find(position=>position.receiptId===source.receipt_id&&position.packageId===pkg.packageId);if(!position||!position.fundingEligibleMinor||position.assignmentIds.length)continue;
      let target:Awaited<ReturnType<typeof currentDestination>>;try{target=await currentDestination(session,pkg.policyId,pkg.policyDigest,null,tx);}catch(error){if(error instanceof DomainError)continue;throw error;}
      const packageEvents=events.filter(event=>event.package_id===pkg.packageId),eligibleBefore=packageEvents.reduce((sum,event)=>sum+Number(event.eligible_minor),0),packageEarned=packageEvents.reduce((sum,event)=>sum+Number(event.match_minor),0);
      const ratio=BigInt(offer.matchBasisPoints),potential=Number((BigInt(eligibleBefore+position.fundingEligibleMinor)*ratio)/10000n-(BigInt(eligibleBefore)*ratio)/10000n);
      const currentEligible=packagePositionTotals(projection.positions,pkg.packageId,target.value.budgetMinor).fundingEligibleMinor;
      const capacity=Math.max(0,target.value.budgetMinor-currentEligible-await outstandingPurposePledges(session,pkg.packageId,tx));
      const matched=Math.min(potential,Math.max(0,offer.totalCapMinor-earned),Math.max(0,pkg.capMinor-packageEarned),capacity),eventId=randomUUID();
      const pledgeId=matched>0?await insertPurposePledge(tx,session,target.value,target.row.digest,{amountMinor:matched,donorActorId:acceptance.sponsorActorId,membershipVersion:acceptance.membershipVersion,kind:"match",sponsorAcceptanceId:acceptance.id,sponsorEventId:eventId,acceptedAt:acceptance.acceptedAt,expiresAt:acceptance.expiresAt}):null;
      const event:SponsorEventContract={schemaVersion:SPONSOR_VERSION,id:eventId,...scope,offerId:offer.id,acceptanceId:acceptance.id,policyId:pkg.policyId,packageId:pkg.packageId,packageVersion:pkg.packageVersion,receiptId:source.receipt_id,receiptVersion:source.receipt_version,sourceDigest:fundingSourceDigest(journal,source.receipt_id),eligibleMinor:position.fundingEligibleMinor,matchMinor:matched,pledgeId,observedAt:new Date().toISOString()};
      const hash=sha256(canonicalJson(event));await tx.query("INSERT INTO fp_sponsor_events(id,tenant_id,project_id,offer_id,acceptance_id,receipt_id,policy_id,pledge_id,package_id,eligible_minor,match_minor,digest,encrypted_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",[eventId,session.tenantId,session.projectId,offer.id,acceptance.id,source.receipt_id,pkg.policyId,pledgeId,pkg.packageId,event.eligibleMinor,matched,hash,sealPrivate(event,sponsorContext(session,"event",eventId))]);
      events.push({id:eventId,tenant_id:session.tenantId,project_id:session.projectId,offer_id:offer.id,acceptance_id:acceptance.id,receipt_id:source.receipt_id,policy_id:pkg.policyId,pledge_id:pledgeId,package_id:pkg.packageId,eligible_minor:String(event.eligibleMinor),match_minor:String(matched),digest:hash,encrypted_data:sealPrivate(event,sponsorContext(session,"event",eventId)),created_at:new Date()});earned+=matched;
      if(matched)await appendEvent(tx,session,"funding.match_earned","A settled contribution earned a matching pledge","The original donor payment was counted once under the accepted formula and limits. The matching amount remains a promise until the sponsor's separate settlement.");
    }
    void offerRow;
  }
}
export async function refreshSponsorAgreements(session:Session):Promise<void>{if(!["organizer","donor"].includes(session.role))throw new DomainError("ROLE_DENIED","This view can inspect sponsor agreements without changing them.",403);await database().transaction(async tx=>{await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);await requireCurrentRole(session,session.role,tx);await refreshSponsorsForScope(tx,session);});}
export async function withdrawSponsorOffer(session:Session,raw:z.infer<typeof sponsorActionSchema>):Promise<{id:string}>{
  const input=sponsorActionSchema.parse(raw);return database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);await requireCurrentRole(session,session.role,tx);
    const prior=await actionResult(tx,session,input.intentId,"sponsor_withdraw",input);if(prior)return prior;
    const row=await ownedOffer(session,input.offerId,tx),offer=sponsorOfferContract(row);if(row.digest!==input.digest||row.version!==input.expectedVersion)throw new DomainError("SPONSOR_OFFER_CHANGED","Refresh this exact agreement.");
    const [acceptance]=await query<SponsorAcceptanceRow>("SELECT * FROM fp_sponsor_acceptances WHERE offer_id=$1",[row.id],tx);
    if(acceptance){sponsorAcceptanceContract(acceptance);if(session.role!=="donor"||acceptance.sponsor_actor_id!==session.actorId)throw new DomainError("ROLE_DENIED","Only the sponsor can withdraw the uncollected part of an accepted agreement.",403);
      if((await query("SELECT id FROM fp_purpose_pledges WHERE sponsor_acceptance_id=$1 AND operation_id IS NOT NULL AND state NOT IN ('collected','partially_collected','returned','cancelled','withdrawn')",[acceptance.id],tx)).length)throw new DomainError("SPONSOR_CHECKOUT_UNRESOLVED","Check every started checkout before withdrawing this agreement. Unknown payment outcomes retain their original claims.");
      await tx.query("UPDATE fp_purpose_pledges SET state='withdrawn' WHERE sponsor_acceptance_id=$1 AND state IN ('pledged','held') AND operation_id IS NULL",[acceptance.id]);await tx.query("UPDATE fp_sponsor_acceptances SET state='withdrawn' WHERE id=$1",[acceptance.id]);
      await tx.query("UPDATE fp_obligations SET channel='withdrawn',data=jsonb_set(data,'{eligible}','false'::jsonb) WHERE id IN (SELECT obligation_id FROM fp_purpose_pledges WHERE sponsor_acceptance_id=$1 AND state='withdrawn')",[acceptance.id]);
    }else if(session.role!=="organizer"||offer.createdBy!==session.actorId)throw new DomainError("ROLE_DENIED","Only the organizer who prepared this unaccepted offer can withdraw it.",403);
    await tx.query("UPDATE fp_sponsor_offers SET state='withdrawn' WHERE id=$1",[row.id]);await saveAction(tx,session,input.intentId,"sponsor_withdraw",input,{id:row.id});await appendEvent(tx,session,"funding.sponsor_withdrawn","Future sponsor support was withdrawn","Collected payments keep their original records and purpose. Any return of settled support requires the separate cancellation and original-route process.");return{id:row.id};
  });
}
export async function sponsorViews(session:Session,tx:SqlConnection):Promise<SponsorView[]>{
  if(session.role==="volunteer")return[];const broad=["organizer","auditor"].includes(session.role);
  const offers=await query<SponsorOfferRow>("SELECT * FROM fp_sponsor_offers WHERE tenant_id=$1 AND project_id=$2 ORDER BY created_at DESC,id",[session.tenantId,session.projectId],tx),views:SponsorView[]=[];
  for(const row of offers){const offer=sponsorOfferContract(row),[accepted]=await query<SponsorAcceptanceRow>("SELECT * FROM fp_sponsor_acceptances WHERE offer_id=$1",[row.id],tx),acceptance=accepted?sponsorAcceptanceContract(accepted):null,own=acceptance?.sponsorActorId===session.actorId;
    const pledges=accepted?await query<PledgeRow>("SELECT * FROM fp_purpose_pledges WHERE sponsor_acceptance_id=$1",[accepted.id],tx):[],events=await query<SponsorEventRow>("SELECT * FROM fp_sponsor_events WHERE offer_id=$1 ORDER BY created_at,id",[row.id],tx);
    const pledged=pledges.reduce((sum,pledge)=>sum+currentPledgeCommitment({state:pledge.state,amountMinor:Number(pledge.amount_minor),collectedMinor:Number(pledge.collected_minor),expiresAt:pledge.expires_at.toISOString(),operationId:pledge.operation_id}),0),collected=pledges.reduce((sum,pledge)=>sum+Number(pledge.collected_minor),0);
    views.push({id:row.id,version:row.version,digest:row.digest,kind:offer.kind,name:offer.name,note:offer.note,state:row.expires_at.getTime()<=Date.now()&&["offered","accepted"].includes(row.state)?"expired":row.state,totalCapMinor:offer.totalCapMinor,matchBasisPoints:offer.matchBasisPoints,expiresAt:offer.expiresAt,acceptedAt:acceptance?.acceptedAt??null,own,pledgedMinor:pledged,collectedMinor:collected,remainingCapMinor:Math.max(0,offer.totalCapMinor-(offer.kind==="match"?events.reduce((sum,event)=>sum+Number(event.match_minor),0):accepted?offer.totalCapMinor:0)),canAccept:session.role==="donor"&&row.state==="offered"&&row.expires_at.getTime()>Date.now(),canWithdraw:row.state!=="withdrawn"&&(session.role==="donor"&&own||session.role==="organizer"&&!accepted&&offer.createdBy===session.actorId),canReview:["organizer","donor"].includes(session.role)&&row.state==="accepted",packages:offer.packages,
      events:events.map(event=>{const value=sponsorEventContract(event),pledge=pledges.find(pledge=>pledge.id===event.pledge_id);return{id:event.id,packageId:value.packageId,eligibleMinor:value.eligibleMinor,matchMinor:value.matchMinor,state:pledge?.state??"recorded_without_match",observedAt:value.observedAt,receiptId:broad?value.receiptId:null};})});
  }return views;
}
