import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, sha256 } from "@fracture/paypal-core";
import { type Session, tokenHash } from "../lib/server/auth";
import { fundingQaEnabled } from "../lib/server/provider-access";
import { database, initializeDatabase, query } from "../lib/server/db";
import { createProject, sampleReceipt } from "../lib/server/seed";
import { recordSampleOrigin } from "../lib/server/sample-funding-origins";
import { cancellationCaseReview, createFundingPolicy, fundingDesk, openCancellationCase } from "../lib/server/funding-lifecycle";
import { createPurposePledge, refreshPurposeFunding } from "../lib/server/purpose-pledges";
import { createSponsorOffer } from "../lib/server/sponsors";
import { recordSampleFundingUse } from "../lib/server/funding-adjustments";
import { observeOriginalReturns } from "../lib/server/funding-return-reconciliation";

if(!fundingQaEnabled())throw new Error("Run only in the isolated funding review with blank credentials.");
const name=process.argv[2];if(!["native","http"].includes(name))throw new Error("Choose a new native or http fixture; an existing fixture is never reset.");
const output=resolve(".local/funding-qa",`${name}.json`);
if(await stat(output).then(()=>true,()=>false))throw new Error("This fixture manifest already exists. Its original records and deadlines must remain unchanged.");
await initializeDatabase();
const scope={tenantId:randomUUID(),projectId:randomUUID()},createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+24*3_600_000).toISOString();
const actors:{key:string;label:string;detail:string;token:string;session:Session}[]=[];
const profiles=[
  {key:"organizer",label:"Morgan · organizer",detail:"Open purposes, follow unresolved decisions, and prepare separate sponsor agreements.",role:"organizer" as const,roles:["organizer","auditor"]},
  {key:"donor-sam",label:"Sam · donor",detail:"A $150 share to reallocate, a $50 source with a fictional $5 outside return to reconcile, and revised laser-station shares to review.",role:"donor" as const,roles:["donor"]},
  {key:"donor-lee",label:"Lee · donor",detail:"A $90 Sample invoice share to return, a $30 share to renew for next semester, and an expense-backed adjustment to review.",role:"donor" as const,roles:["donor"]},
  {key:"sponsor",label:"Jordan · sponsor",detail:"Review the $90 grant and the separate capped 50% match. Acceptance and payment are distinct steps.",role:"donor" as const,roles:["donor"]},
  {key:"auditor",label:"Rae · Auditor",detail:"Read the complete funding trail and exact history. Financial actions remain unavailable.",role:"auditor" as const,roles:["auditor"]},
  {key:"volunteer",label:"Alex · volunteer",detail:"See public purpose context without donor records or financial controls.",role:"volunteer" as const,roles:["volunteer"]},
];
await database().transaction(async tx=>{
  // Empty seed, relabelled within the same transaction before any source record exists.
  await createProject(tx,scope.tenantId,scope.projectId,`funding-${name}-${randomUUID().slice(0,8)}`,"live_sandbox");
  await tx.query("UPDATE fp_tenants SET mode='sample' WHERE id=$1",[scope.tenantId]);
  await tx.query("UPDATE fp_projects SET metadata=metadata||$2::jsonb WHERE id=$1",[scope.projectId,JSON.stringify({title:"A makerspace, made together.",subtitle:"Eastside · isolated funding review",fundingQaSeed:name,fundingQaCreatedAt:createdAt})]);
  for(const [id,budget] of [["electronics",24000],["printing",24000],["woodworking",8000],["safety",6000],["materials",3000],["laser",12000]] as const)
    await tx.query("UPDATE fp_packages SET budget_minor=$3,data=jsonb_set(data,'{budgetMinor}',to_jsonb($3::bigint)) WHERE project_id=$1 AND id=$2",[scope.projectId,id,budget]);
  await tx.query("UPDATE fp_packages SET data=data||$2::jsonb WHERE project_id=$1 AND id='materials'",[scope.projectId,JSON.stringify({title:"Next semester materials",shortTitle:"Next semester",description:"Fresh everyday supplies for next semester’s makerspace. Support moves here only through an explicit renewed choice."})]);
  for(const profile of profiles){
    const token=randomBytes(32).toString("base64url"),session:Session={...scope,id:randomUUID(),actorId:randomUUID(),role:profile.role,mode:"sample",expiresAt};
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",[session.id,tokenHash(token),scope.tenantId,scope.projectId,session.actorId,session.role,expiresAt]);
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,$4::jsonb)",[scope.tenantId,scope.projectId,session.actorId,JSON.stringify(profile.roles)]);
    actors.push({key:profile.key,label:profile.label,detail:profile.detail,token,session});
  }
});
const organizer=actors[0].session,sam=actors[1].session,lee=actors[2].session;
const policies:Record<string,{id:string;digest:string}>= {};
for(const [packageId,kind] of [["electronics","mixed"],["printing","mixed"],["woodworking","mixed"],["safety","mixed"],["materials","rollover"],["laser","mixed"]] as const){
  const saved=await createFundingPolicy(organizer,{intentId:randomUUID(),packageId,expectedVersion:1,kind,acknowledged:true});
  const policy=(await fundingDesk(organizer)).policies.find(row=>row.id===saved.id)!;policies[packageId]={id:policy.id,digest:policy.digest};
}
const originals:{id:string;digest:string;packageId:string;amountMinor:number;actor:string;sourceKind:"orders_capture"|"invoice_payment"}[]=[];
for(const [donor,packageId,amount,invoice] of [[sam,"electronics",15000,false],[lee,"electronics",9000,true],[sam,"woodworking",5000,false],[lee,"woodworking",3000,false],[sam,"laser",6000,false],[lee,"laser",6000,false]] as const){
  await database().transaction(async tx=>{
    const [pkg]=await query<{version:number;data:{title:string;description:string}}>("SELECT version,data FROM fp_packages WHERE project_id=$1 AND id=$2",[scope.projectId,packageId],tx),obligationId=randomUUID();
    await tx.query("INSERT INTO fp_obligations(id,tenant_id,project_id,package_id,actor_id,amount_minor,channel,purpose,data) VALUES($1,$2,$3,$4,$5,$6,'collected','conditional_pledge',$7::jsonb)",[obligationId,scope.tenantId,scope.projectId,packageId,donor.actorId,amount,JSON.stringify({provenance:"sample",donorLabel:donor.actorId===sam.actorId?"Sam · Sample":"Lee · Sample"})]);
    await recordSampleOrigin(tx,{...scope,obligationId,packageId,packageVersion:pkg.version,donorActorId:donor.actorId,amountMinor:amount,title:pkg.data.title,purpose:pkg.data.description});
    const receipt={...sampleReceipt(scope.tenantId,scope.projectId,obligationId,packageId,amount,randomUUID(),invoice),observedAt:createdAt};
    await tx.query("INSERT INTO fp_settlement_receipts(id,tenant_id,project_id,obligation_id,package_id,provider_ref,provenance,data) VALUES($1,$2,$3,$4,$5,$6,'sample',$7::jsonb)",[receipt.id,scope.tenantId,scope.projectId,obligationId,packageId,receipt.actualProviderPaymentRef,JSON.stringify(receipt)]);
    await tx.query("INSERT INTO fp_economic_aliases(merchant_scope,alias,receipt_id) VALUES($1,$2,$3)",[scope.tenantId,receipt.economicAliases[0],receipt.id]);
    for(const [account,side] of [["sample_clearing","debit"],["package_funds","credit"]])await tx.query("INSERT INTO fp_journal(id,tenant_id,project_id,receipt_id,account,side,amount_minor,currency) VALUES($1,$2,$3,$4,$5,$6,$7,'USD')",[randomUUID(),scope.tenantId,scope.projectId,receipt.id,account,side,amount]);
    originals.push({id:receipt.id,digest:sha256(canonicalJson(receipt)),packageId,amountMinor:amount,actor:donor.actorId===sam.actorId?"donor-sam":"donor-lee",sourceKind:receipt.sourceKind});
    await refreshPurposeFunding(tx,{...scope,provenance:"sample"},policies[packageId].id);
  });
}
const samplePaidAllocationId=randomUUID(),laserSource=originals.find(row=>row.packageId==="laser"&&row.actor==="donor-sam")!;
await database().transaction(async tx=>{
  await tx.query("INSERT INTO fp_receipt_allocations(id,tenant_id,project_id,receipt_id,claim_id,claim_line_id,package_id,amount_minor,state) VALUES($1,$2,$3,$4,$5,$6,'laser',2000,'paid')",[samplePaidAllocationId,scope.tenantId,scope.projectId,laserSource.id,randomUUID(),randomUUID()]);
  await recordSampleFundingUse(tx,scope,samplePaidAllocationId);
  for(const [account,side] of [["sample_reviewed_expense","debit"],["sample_clearing","credit"]])await tx.query("INSERT INTO fp_journal(id,tenant_id,project_id,receipt_id,account,side,amount_minor,currency,entry_kind) VALUES($1,$2,$3,$4,$5,$6,2000,'USD','sample_expense')",[randomUUID(),scope.tenantId,scope.projectId,laserSource.id,account,side]);
});
const cases=[];
for(const [packageId,reason] of [["electronics","The community chose to share the available printer bay instead of opening a separate electronics area."],["woodworking","The woodworking corner is postponed. Each supporter can return their share or explicitly renew support for next semester."],["laser","The laser station is postponed. A fictional $20 expense already used one supporter’s source, so the source-specific remaining shares need everyone’s explicit agreement."]]){
  const review=await cancellationCaseReview(organizer,packageId),saved=await openCancellationCase(organizer,{intentId:randomUUID(),packageId,expectedVersion:1,reviewDigest:review.digest,reason,deadline:new Date(Date.now()+20*3_600_000).toISOString(),acknowledged:true});cases.push({id:saved.id,packageId});
}
const outsideReturnSource=originals.find(row=>row.packageId==="woodworking"&&row.actor==="donor-sam")!;
const outsideReturnObservation=await observeOriginalReturns(organizer,{intentId:randomUUID(),receiptId:outsideReturnSource.id,expectedVersion:1,references:[],sampleReturnMinor:500,acknowledged:true});
const savedPledge=await createPurposePledge(sam,{intentId:randomUUID(),policyId:policies.safety.id,policyDigest:policies.safety.digest,amountMinor:4000,acknowledged:true});
const offers=[];
for(const [kind,packageId,nameText,cap,ratio] of [["grant","printing","The neighbourhood printer grant",9000,10000],["match","safety","Make a safer start · 50% match",2000,5000]] as const){
  const saved=await createSponsorOffer(organizer,{intentId:randomUUID(),kind,name:nameText,note:kind==="grant"?"A separately accepted $90 grant for the exact printer-bay purpose.":"An additional 50 cents for every new dollar collected from another donor, up to $20. Existing and moved contributions cannot earn another match.",totalCapMinor:cap,matchBasisPoints:ratio,expiresAt:new Date(Date.now()+20*3_600_000).toISOString(),packages:[{policyId:policies[packageId].id,policyDigest:policies[packageId].digest,capMinor:cap}],acknowledged:true});offers.push({id:saved.id,kind,packageId});
}
const secondScope={tenantId:randomUUID(),projectId:randomUUID()},secondToken=randomBytes(32).toString("base64url"),second:Session={...secondScope,id:randomUUID(),actorId:randomUUID(),role:"organizer",mode:"sample",expiresAt};
await database().transaction(async tx=>{
  await createProject(tx,secondScope.tenantId,secondScope.projectId,`other-funding-${name}-${randomUUID().slice(0,8)}`,"live_sandbox");await tx.query("UPDATE fp_tenants SET mode='sample' WHERE id=$1",[secondScope.tenantId]);
  await tx.query("UPDATE fp_projects SET metadata=metadata||$2::jsonb WHERE id=$1",[secondScope.projectId,JSON.stringify({title:"Another makerspace, a separate idea.",subtitle:"Independent Sample workspace",fundingQaSeed:`${name}-other`})]);
  await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'organizer',$6)",[second.id,tokenHash(secondToken),second.tenantId,second.projectId,second.actorId,expiresAt]);await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,'[\"organizer\"]'::jsonb)",[second.tenantId,second.projectId,second.actorId]);
});
actors.push({key:"other-workspace",label:"Another workspace",detail:"A separate Sample project for stale-tab and cross-workspace access checks.",token:secondToken,session:second});
const desk=await fundingDesk(organizer),manifest={schemaVersion:"funding-native-fixtures-v1",createdAt,expiresAt,name,scope,actors,policies,cases,offers,savedPledge,originals,samplePaidAllocationId,outsideReturnSourceId:outsideReturnSource.id,outsideReturnObservation,baselineDesk:desk};
await mkdir(resolve(".local/funding-qa"),{recursive:true,mode:0o700});await writeFile(output,JSON.stringify(manifest,null,2),{mode:0o600,flag:"wx"});
console.log(JSON.stringify({created:name,actors:actors.length,sampleReceipts:originals.length,caseCount:cases.length,providerCalls:0,manifest:"private fixture file saved"}));
await database().close();
