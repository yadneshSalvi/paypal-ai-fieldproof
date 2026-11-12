import { randomUUID } from "node:crypto";
import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import type { SettlementReceipt } from "../contracts";
import { packagePositionTotals } from "../domain/funding-positions";
import { DomainError } from "../domain/money";
import type { FundingPolicyContract } from "../funding/contracts";
import { PURPOSE_PLEDGE_VERSION, currentPledgeCommitment, type PurposePledgeContract, type PurposePledgeView } from "../funding/pledges";
import type { Session } from "./auth";
import { projectClaimLock } from "./claims";
import { database, initializeDatabase, query } from "./db";
import { actionResult, currentDestination, savedFundingPolicy, saveAction } from "./funding-lifecycle";
import { lockFundingScope, readFundingProjection } from "./funding-positions";
import { requireCurrentRole, requireMembership } from "./membership";
import { sealPrivate } from "./private-values";
import { ownedPledge, outstandingPurposePledges, pledgeContext, pledgeContract, type PledgeRow, type PurposeScope } from "./purpose-store";
import { appendEvent } from "./repository";
import { sampleReceipt } from "./seed";
import { bindProjectPolicyArtifacts, enforceProjectFundDecision, pinnedProjectPolicyRules } from "./project-policy";

const identity=z.string().min(1).max(160),digest=z.string().regex(/^[a-f0-9]{64}$/);
export const purposePledgeSchema=z.object({intentId:z.string().uuid(),policyId:identity,policyDigest:digest,amountMinor:z.number().int().min(1).max(100_000_000),acknowledged:z.literal(true)}).strict();
export const purposePledgeActionSchema=z.object({intentId:z.string().uuid(),pledgeId:identity,digest,expectedVersion:z.number().int().positive()}).strict();
export const purposeWindowSchema=z.object({intentId:z.string().uuid(),policyId:identity,digest,expectedVersion:z.number().int().positive(),action:z.enum(["review_expiry","close_empty"]),acknowledged:z.literal(true)}).strict();
export const purposeScope=(session:Pick<Session,"tenantId"|"projectId"|"mode">)=>({tenantId:session.tenantId,projectId:session.projectId,provenance:session.mode});

export async function insertPurposePledge(tx:SqlConnection,session:Session,policy:FundingPolicyContract,policyDigest:string,input:{
  id?:string;amountMinor:number;donorActorId:string;membershipVersion:number;kind:PurposePledgeContract["kind"];
  sponsorAcceptanceId?:string;sponsorEventId?:string;acceptedAt?:string;expiresAt?:string;
}):Promise<string>{
  const id=input.id??randomUUID(),obligationId=randomUUID();
  const value:PurposePledgeContract={schemaVersion:PURPOSE_PLEDGE_VERSION,id,...purposeScope(session),version:1,donorActorId:input.donorActorId,membershipVersion:input.membershipVersion,
    acceptedAt:input.acceptedAt??new Date().toISOString(),expiresAt:input.expiresAt??policy.expiresAt,obligationId,policyId:policy.id,policyDigest,roundId:policy.roundId,
    packageId:policy.packageId,packageVersion:policy.packageVersion,title:policy.title,purpose:policy.purpose,amountMinor:input.amountMinor,currency:"USD",kind:input.kind,
    sponsorAcceptanceId:input.sponsorAcceptanceId??null,sponsorEventId:input.sponsorEventId??null,paymentMode:"buyer_present",cancellationTreatment:"return_to_original_route"};
  const hash=sha256(canonicalJson(value));
  await tx.query("INSERT INTO fp_obligations(id,tenant_id,project_id,package_id,actor_id,amount_minor,channel,purpose,data) VALUES($1,$2,$3,$4,$5,$6,'uncollected','conditional_pledge',$7::jsonb)",
    [obligationId,session.tenantId,session.projectId,policy.packageId,input.donorActorId,input.amountMinor,JSON.stringify({eligible:true,provenance:session.mode,donorLabel:input.kind==="donor"?"A supporter":input.kind==="grant"?"Accepted grant":"Earned matching pledge",purposePledgeId:id})]);
  await tx.query(`INSERT INTO fp_purpose_pledges(id,tenant_id,project_id,policy_id,round_id,obligation_id,package_id,package_version,donor_actor_id,membership_version,kind,sponsor_acceptance_id,sponsor_event_id,amount_minor,expires_at,digest,encrypted_data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,[id,session.tenantId,session.projectId,policy.id,policy.roundId,obligationId,policy.packageId,policy.packageVersion,input.donorActorId,input.membershipVersion,input.kind,value.sponsorAcceptanceId,value.sponsorEventId,input.amountMinor,value.expiresAt,hash,sealPrivate(value,pledgeContext(session,id))]);
  const policyRules=input.sponsorAcceptanceId
    ? (await pinnedProjectPolicyRules(tx,session,"sponsor_offer",`accept:${input.sponsorAcceptanceId}`)).filter(rule=>rule.document.compiled.packageIds.includes(policy.packageId))
    : await enforceProjectFundDecision(tx,session,{consumer:"purpose_pledge",packages:[{packageId:policy.packageId}]});
  await bindProjectPolicyArtifacts(tx,policyRules,"purpose_pledge",id,hash,session);
  return id;
}
export async function createPurposePledge(session:Session,raw:z.infer<typeof purposePledgeSchema>):Promise<{id:string}>{
  const input=purposePledgeSchema.parse(raw);await initializeDatabase();
  return database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);const member=await requireCurrentRole(session,"donor",tx);
    const prior=await actionResult(tx,session,input.intentId,"purpose_pledge",input);if(prior)return prior;
    const target=await currentDestination(session,input.policyId,input.policyDigest,null,tx);
    const funding=await readFundingProjection(purposeScope(session),tx),eligible=packagePositionTotals(funding.positions,target.value.packageId,target.value.budgetMinor).fundingEligibleMinor;
    const outstanding=await outstandingPurposePledges(session,target.value.packageId,tx);
    if(eligible+outstanding+input.amountMinor>target.value.budgetMinor)throw new DomainError("PLEDGE_CAPACITY","This amount exceeds the remaining target after settled support and existing pledges. Refresh the current purpose.");
    const id=await insertPurposePledge(tx,session,target.value,target.row.digest,{amountMinor:input.amountMinor,donorActorId:session.actorId,membershipVersion:member.membershipVersion,kind:"donor"});
    await saveAction(tx,session,input.intentId,"purpose_pledge",input,{id});
    await appendEvent(tx,session,"funding.pledged","A supporter chose this purpose","The exact amount, purpose and deadline are saved. This pledge is not collected money; checkout needs the supporter's own approval.");return{id};
  });
}
export async function validateCurrentPledge(session:Session,row:PledgeRow,tx:SqlConnection){
  const value=pledgeContract(row);
  await requireCurrentRole(session,"donor",tx);
  if(row.donor_actor_id!==session.actorId)throw new DomainError("PLEDGE_NOT_FOUND","This pledge belongs to another supporter.",404);
  const member=await requireMembership(session.tenantId,session.projectId,session.actorId,"donor",tx);
  if(member.version!==row.membership_version||row.expires_at.getTime()<=Date.now()||["withdrawn","expired","held","cancelled","returned","collected"].includes(row.state))throw new DomainError("PLEDGE_AUTHORITY_CHANGED","The saved purpose, supporter authority or acceptance window changed. Check the original pledge before proceeding.");
  const target=await currentDestination(session,value.policyId,value.policyDigest,null,tx);
  if(target.value.packageId!==value.packageId||target.value.packageVersion!==value.packageVersion||target.value.title!==value.title||target.value.purpose!==value.purpose)throw new DomainError("PLEDGE_PURPOSE_CHANGED","The exact purpose changed after this pledge was accepted.");
  if(value.kind!=="donor"){const {assertSponsorBacking}=await import("./sponsors");await assertSponsorBacking(tx,session,row);}
  const funding=await readFundingProjection(purposeScope(session),tx),total=packagePositionTotals(funding.positions,value.packageId,target.value.budgetMinor);
  if(total.fundingEligibleMinor+await outstandingPurposePledges(session,value.packageId,tx,row.id)+Number(row.amount_minor)-Number(row.collected_minor)>target.value.budgetMinor)throw new DomainError("PLEDGE_CAPACITY_CHANGED","The target no longer has room for this exact pledge. Resolve its funding review before checkout.");
  return {value,target};
}
export async function withdrawPurposePledge(session:Session,raw:z.infer<typeof purposePledgeActionSchema>):Promise<{id:string}>{
  const input=purposePledgeActionSchema.parse(raw);return database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);await requireCurrentRole(session,"donor",tx);
    const prior=await actionResult(tx,session,input.intentId,"withdraw_pledge",input);if(prior)return prior;
    const row=await ownedPledge(session,input.pledgeId,tx);
    if(row.donor_actor_id!==session.actorId)throw new DomainError("PLEDGE_NOT_FOUND","This pledge belongs to another supporter.",404);
    if(row.digest!==input.digest||row.version!==input.expectedVersion||Number(row.collected_minor)>0||["withdrawn","returned","collected","unknown"].includes(row.state))throw new DomainError("PLEDGE_STARTED","A payment may have completed or this pledge changed. Check its original operation before making another decision.");
    if(row.operation_id){
      const {paymentStore}=await import("./payments"),operation=await paymentStore().get(session,row.operation_id);
      const safelyUnpaid=operation&&(["refused","not_sent"].includes(operation.status)||operation.status==="succeeded"&&operation.command.action.kind==="create_order");
      if(!safelyUnpaid)throw new DomainError("PLEDGE_CHECKOUT_UNRESOLVED","Reconcile this original checkout before withdrawing. Its outcome is still uncertain.");
    }
    await tx.query("UPDATE fp_purpose_pledges SET state='withdrawn' WHERE id=$1",[row.id]);await tx.query("UPDATE fp_obligations SET channel='withdrawn',data=jsonb_set(data,'{eligible}','false'::jsonb) WHERE id=$1",[row.obligation_id]);
    await saveAction(tx,session,input.intentId,"withdraw_pledge",input,{id:row.id});await appendEvent(tx,session,"funding.pledge_withdrawn","An uncollected pledge was withdrawn","The original pledge and any checkout remain in the history. No captured support or unresolved payment was released; this promise no longer counts toward the target.");return{id:row.id};
  });
}

export async function reviewPurposeWindow(session:Session,raw:z.infer<typeof purposeWindowSchema>):Promise<{id:string}>{
  const input=purposeWindowSchema.parse(raw);return database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);await requireCurrentRole(session,"organizer",tx);
    const prior=await actionResult(tx,session,input.intentId,"purpose_window",input);if(prior)return prior;
    const {row,value}=await savedFundingPolicy(session,input.policyId,tx);
    if(row.digest!==input.digest||row.package_version!==input.expectedVersion||!["open","expired","review_required"].includes(row.state))throw new DomainError("PURPOSE_WINDOW_CHANGED","Reload this exact funding window before reviewing its closure.");
    const [pkg]=await query<{version:number}>("SELECT version FROM fp_packages WHERE project_id=$1 AND id=$2",[session.projectId,value.packageId],tx);
    if(pkg?.version!==value.packageVersion)throw new DomainError("PACKAGE_VERSION_CHANGED","The package changed; review its recorded purpose and contributions first.");
    const projection=await readFundingProjection(purposeScope(session),tx),total=packagePositionTotals(projection.positions,value.packageId,value.budgetMinor);
    const started=await query("SELECT id FROM fp_purpose_pledges WHERE policy_id=$1 AND operation_id IS NOT NULL AND state NOT IN ('withdrawn','collected','partially_collected','returned','cancelled')",[row.id],tx);
    if(input.action==="close_empty"&&(total.collectedMinor>0||started.length))throw new DomainError("PURPOSE_HAS_CONTRIBUTIONS","Collected support needs a reviewed cancellation case. Reconcile every started checkout before closing an empty purpose.");
    if(input.action==="review_expiry"&&row.expires_at.getTime()>Date.now())throw new DomainError("PURPOSE_WINDOW_OPEN","The original acceptance deadline has not passed.");
    const state=input.action==="close_empty"?"closed":started.length?"review_required":"expired";
    await tx.query("UPDATE fp_funding_policies SET state=$2 WHERE id=$1",[row.id,state]);
    await tx.query("UPDATE fp_collection_rounds SET state=$2 WHERE id=$1",[value.roundId,state]);
    await tx.query("UPDATE fp_purpose_pledges SET state=$2 WHERE policy_id=$1 AND operation_id IS NULL AND state IN ('pledged','held')",[row.id,input.action==="close_empty"?"cancelled":"expired"]);
    await tx.query("UPDATE fp_obligations SET channel='cancelled',data=jsonb_set(data,'{eligible}','false'::jsonb) WHERE id IN (SELECT obligation_id FROM fp_purpose_pledges WHERE policy_id=$1 AND state IN ('expired','cancelled'))",[row.id]);
    await tx.query("UPDATE fp_packages SET data=jsonb_set(data,'{fundingState}',$3::jsonb) WHERE project_id=$1 AND id=$2",[session.projectId,value.packageId,JSON.stringify(input.action==="close_empty"?"cancelled":"funding_review")]);
    await saveAction(tx,session,input.intentId,"purpose_window",input,{id:row.id});
    await appendEvent(tx,session,"funding.window_closed",input.action==="close_empty"?"An empty purpose was closed":"The original acceptance window ended","Uncollected promises are retained in history. Started payments remain under their original operations; collected support needs a reviewed donor-choice case. No deadline was extended.");return{id:row.id};
  });
}

/** Called only inside the same round/obligation/receipt lock transaction as
 * settlement ingestion. No saved flag can make an incomplete purpose funded. */
export async function refreshPurposeFunding(tx:SqlConnection,scope:PurposeScope&{provenance:Session["mode"]},policyId:string):Promise<void>{
  const [policy]=await query<{id:string;package_id:string;package_version:number;round_id:string;state:string;expires_at:Date;budget_minor:string;current_version:number;package_state:string}>(
    `SELECT f.*,p.budget_minor,p.version current_version,p.data->>'fundingState' package_state FROM fp_funding_policies f JOIN fp_packages p ON p.project_id=f.project_id AND p.id=f.package_id WHERE f.id=$1 AND f.tenant_id=$2 AND f.project_id=$3`,[policyId,scope.tenantId,scope.projectId],tx);
  if(!policy||!["open","funded"].includes(policy.state)||["cancelled","compensating"].includes(policy.package_state))return;
  const projection=await readFundingProjection(scope,tx),eligible=packagePositionTotals(projection.positions,policy.package_id,Number(policy.budget_minor)).fundingEligibleMinor;
  const state=policy.current_version!==policy.package_version?"review_required":policy.state==="funded"?eligible===Number(policy.budget_minor)?"funded":"review_required":policy.expires_at.getTime()<=Date.now()?"expired":eligible===Number(policy.budget_minor)?"funded":"open";
  await tx.query("UPDATE fp_funding_policies SET state=$2 WHERE id=$1",[policyId,state]);
  await tx.query("UPDATE fp_collection_rounds SET state=$2 WHERE id=$1",[policy.round_id,state==="open"?"allocation_open":state]);
  await tx.query("UPDATE fp_packages SET data=jsonb_set(data,'{fundingState}',$3::jsonb) WHERE project_id=$1 AND id=$2",[scope.projectId,policy.package_id,JSON.stringify(state==="funded"?"funded":state==="open"?"open":"funding_review")]);
}
export async function refreshPurposePledge(tx:SqlConnection,scope:PurposeScope&{provenance:Session["mode"]},obligationId:string):Promise<void>{
  const [row]=await query<PledgeRow>("SELECT * FROM fp_purpose_pledges WHERE obligation_id=$1 AND tenant_id=$2 AND project_id=$3",[obligationId,scope.tenantId,scope.projectId],tx);if(!row)return;pledgeContract(row);
  const receipts=await query<{data:SettlementReceipt}>("SELECT data FROM fp_settlement_receipts WHERE obligation_id=$1 AND tenant_id=$2 AND project_id=$3",[obligationId,scope.tenantId,scope.projectId],tx);
  const collected=receipts.reduce((sum,item)=>sum+item.data.creditedMinor-item.data.completedAttributedRefundMinor,0);
  const hasCapture=receipts.some(item=>item.data.creditedMinor>0);
  await tx.query("UPDATE fp_purpose_pledges SET collected_minor=$2,state=$3 WHERE id=$1",[row.id,collected,collected>=Number(row.amount_minor)?"collected":hasCapture?collected===0?"returned":"partially_collected":row.state]);
  await refreshPurposeFunding(tx,scope,row.policy_id);
}
export async function settleSamplePurposePledge(session:Session,raw:z.infer<typeof purposePledgeActionSchema>):Promise<{id:string}>{
  const input=purposePledgeActionSchema.parse(raw);if(session.mode!=="sample")throw new DomainError("SAMPLE_ONLY","A live contribution requires the supporter's actual sandbox checkout.");
  return database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);await requireCurrentRole(session,"donor",tx);
    const prior=await actionResult(tx,session,input.intentId,"sample_pledge_settled",input);if(prior)return prior;
    const row=await ownedPledge(session,input.pledgeId,tx);if(row.digest!==input.digest||row.version!==input.expectedVersion)throw new DomainError("PLEDGE_VERSION_CHANGED","Refresh this saved pledge.");
    const {value}=await validateCurrentPledge(session,row,tx);if(row.state!=="pledged")throw new DomainError("PLEDGE_STARTED","Check the existing outcome for this pledge.");
    const receipt=sampleReceipt(session.tenantId,session.projectId,value.obligationId,value.packageId,value.amountMinor,`purpose-${row.id}`);
    receipt.observedAt=new Date().toISOString();
    await tx.query("INSERT INTO fp_settlement_receipts(id,tenant_id,project_id,obligation_id,package_id,provider_ref,provenance,data) VALUES($1,$2,$3,$4,$5,$6,'sample',$7::jsonb)",[receipt.id,session.tenantId,session.projectId,value.obligationId,value.packageId,receipt.actualProviderPaymentRef,JSON.stringify(receipt)]);
    for(const [account,side] of [["sample_cash","debit"],["restricted_contributions","credit"]])await tx.query("INSERT INTO fp_journal(id,tenant_id,project_id,receipt_id,account,side,amount_minor,currency) VALUES($1,$2,$3,$4,$5,$6,$7,'USD')",[randomUUID(),session.tenantId,session.projectId,receipt.id,account,side,value.amountMinor]);
    await tx.query("UPDATE fp_obligations SET channel='collected' WHERE id=$1",[row.obligation_id]);await refreshPurposePledge(tx,purposeScope(session),row.obligation_id);
    const {refreshSponsorsForScope}=await import("./sponsors");await refreshSponsorsForScope(tx,session);
    await saveAction(tx,session,input.intentId,"sample_pledge_settled",input,{id:row.id});await appendEvent(tx,session,"funding.sample_settlement","A Sample contribution is recorded","This is a labelled fictional settlement for exploring the complete support journey. No provider was called.");return{id:row.id};
  });
}
export async function purposePledgeViews(session:Session,tx:SqlConnection):Promise<PurposePledgeView[]>{
  const broad=["organizer","auditor"].includes(session.role);
  const rows=await query<PledgeRow&{operation_exists:boolean;receipt_ids:string[];order_id:string|null}>(`SELECT p.*,EXISTS(SELECT 1 FROM paycore_operations operation WHERE operation.tenant_id=p.tenant_id AND operation.project_id=p.project_id AND operation.id=p.operation_id) operation_exists,
    (SELECT po.order_id FROM fp_provider_orders po WHERE po.obligation_id=p.obligation_id AND po.tenant_id=p.tenant_id AND po.project_id=p.project_id ORDER BY po.order_id LIMIT 1) order_id,
    ARRAY(SELECT r.id FROM fp_settlement_receipts r WHERE r.obligation_id=p.obligation_id AND r.tenant_id=p.tenant_id AND r.project_id=p.project_id ORDER BY r.created_at,r.id) receipt_ids
    FROM fp_purpose_pledges p WHERE p.tenant_id=$1 AND p.project_id=$2 AND ($3 OR ($4='donor' AND p.donor_actor_id=$5)) ORDER BY p.created_at DESC,p.id`,[session.tenantId,session.projectId,broad,session.role,session.actorId],tx);
  return rows.map(row=>{const value=pledgeContract(row),own=value.donorActorId===session.actorId,current=row.expires_at.getTime()>Date.now(),collected=Number(row.collected_minor);return{id:row.id,version:row.version,digest:row.digest,packageId:value.packageId,packageVersion:value.packageVersion,title:value.title,purpose:value.purpose,kind:value.kind,amountMinor:value.amountMinor,collectedMinor:collected,pendingMinor:Math.max(0,currentPledgeCommitment({state:row.state,amountMinor:value.amountMinor,collectedMinor:collected,expiresAt:value.expiresAt,operationId:row.operation_id})-collected),state:row.state,own,acceptedAt:value.acceptedAt,expiresAt:value.expiresAt,operationId:own||broad?row.operation_id:null,orderId:own||broad?row.order_id:null,lastCode:row.last_code,receiptIds:row.receipt_ids,canWithdraw:session.role==="donor"&&own&&collected===0&&["pledged","held","expired","buyer_action","ready_capture","refused","not_sent"].includes(row.state),canCheckout:session.role==="donor"&&own&&current&&row.state==="pledged",canCheck:session.role==="donor"&&own&&!!row.operation_id,canRetry:session.role==="donor"&&own&&current&&!!row.operation_id&&(["refused","not_sent"].includes(row.state)||!row.operation_exists)};});
}
