import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canonicalJson, PaymentCore, PostgresDatabase, ProviderError, sha256, type PaymentCommand, type ProviderAdapter, type ProviderReceipt, type ProviderResource } from "@fracture/paypal-core";
import type { Session } from "../lib/server/auth";
import { database, initializeDatabase, query } from "../lib/server/db";
import { createProject } from "../lib/server/seed";
import { cancellationCaseReview, createFundingPolicy, executeFundingChoice, fundingDesk, openCancellationCase, recordFundingChoice } from "../lib/server/funding-lifecycle";
import { createPurposePledge, reviewPurposeWindow, settleSamplePurposePledge, withdrawPurposePledge } from "../lib/server/purpose-pledges";
import { acceptSponsorOffer, createSponsorOffer, refreshSponsorAgreements, withdrawSponsorOffer } from "../lib/server/sponsors";
import { purposeCheckout, type PurposeCheckoutDependencies } from "../lib/server/purpose-checkout";
import { authorizePayment, paymentStore } from "../lib/server/payments";
import { readFundingJournal, readFundingOrigins, readFundingProjection } from "../lib/server/funding-positions";
import { projectFundingLots } from "../lib/domain/funding-lots";
import { fundingReceiptTrail } from "../lib/server/funding-trail";
import { projectSnapshot } from "../lib/server/repository";
import { studioDataDefinition } from "../lib/studio/native-data";
import { studioTransactions } from "../lib/studio/transactions";
import { readStudioSnapshot } from "../lib/server/studio-datasets";

const schema=`fp_purpose_test_${randomUUID().replaceAll("-","")}`,original=process.env.DATABASE_URL!,admin=new PostgresDatabase(original);
before(async()=>{await admin.query(`CREATE SCHEMA "${schema}"`);const url=new URL(original);url.searchParams.set("options",`-c search_path=${schema}`);process.env.DATABASE_URL=url.href;await initializeDatabase();});
afterEach(async()=>{const tables=await query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname=$1",[schema]);if(tables.length)await database().query(`TRUNCATE ${tables.map(row=>`"${schema}"."${row.tablename}"`).join(",")} RESTART IDENTITY CASCADE`);});
after(async()=>{await database().close();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();process.env.DATABASE_URL=original;});
async function workspace(mode:Session["mode"]="sample",withSampleSeeds=false){
  const scope={tenantId:randomUUID(),projectId:randomUUID()},sessions:Session[]=[];
  await database().transaction(async tx=>{await createProject(tx,scope.tenantId,scope.projectId,`purpose-${randomUUID()}`,withSampleSeeds?"sample":"live_sandbox");
    await tx.query("UPDATE fp_tenants SET mode=$2 WHERE id=$1",[scope.tenantId,mode]);
    for(const role of ["organizer","donor","donor","donor"] as const){const session:Session={...scope,id:randomUUID(),actorId:randomUUID(),role,mode,expiresAt:new Date(Date.now()+3_600_000).toISOString()};sessions.push(session);
      await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",[session.id,randomUUID(),scope.tenantId,scope.projectId,session.actorId,role,session.expiresAt]);
      await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,$4::jsonb)",[scope.tenantId,scope.projectId,session.actorId,JSON.stringify(role==="organizer"?["organizer","auditor"]:["donor"])]);
    }
    if(!withSampleSeeds)await tx.query("UPDATE fp_packages SET budget_minor=10000 WHERE project_id=$1",[scope.projectId]);
  });return{organizer:sessions[0],donors:sessions.slice(1),scope:{...scope,provenance:mode}};
}
async function policy(f:Awaited<ReturnType<typeof workspace>>,packageId="materials"){
  const result=await createFundingPolicy(f.organizer,{intentId:randomUUID(),packageId,expectedVersion:1,kind:"mixed",acknowledged:true});return(await fundingDesk(f.organizer)).policies.find(row=>row.id===result.id)!;
}
async function pledge(session:Session,target:Awaited<ReturnType<typeof policy>>,amountMinor:number){
  const input={intentId:randomUUID(),policyId:target.id,policyDigest:target.digest,amountMinor,acknowledged:true as const};const result=await createPurposePledge(session,input);assert.equal((await createPurposePledge(session,input)).id,result.id);return(await fundingDesk(session)).pledges.find(row=>row.id===result.id)!;
}
const pledgeAction=(value:{id:string;digest:string;version:number})=>({intentId:randomUUID(),pledgeId:value.id,digest:value.digest,expectedVersion:value.version});
const sponsorAction=(value:{id:string;digest:string;version:number})=>({intentId:randomUUID(),offerId:value.id,digest:value.digest,expectedVersion:value.version,acknowledged:true as const});
async function sponsor(f:Awaited<ReturnType<typeof workspace>>,targets:Awaited<ReturnType<typeof policy>>[],kind:"grant"|"match",caps:number[],total=caps.reduce((n,x)=>n+x,0),ratio=10_000){
  const input={intentId:randomUUID(),kind,name:kind==="match"?"Neighbourhood matching circle":"Community equipment grant",note:"A separate sponsor agreement for these exact named purposes.",totalCapMinor:total,matchBasisPoints:ratio,expiresAt:new Date(Date.now()+3_500_000).toISOString(),packages:targets.map((target,i)=>({policyId:target.id,policyDigest:target.digest,capMinor:caps[i]})),acknowledged:true as const};
  const result=await createSponsorOffer(f.organizer,input);assert.equal((await createSponsorOffer(f.organizer,input)).id,result.id);return(await fundingDesk(f.organizer)).sponsors.find(row=>row.id===result.id)!;
}
async function cancel(f:Awaited<ReturnType<typeof workspace>>,packageId:string){
  const review=await cancellationCaseReview(f.organizer,packageId);assert.equal(review.conflicts.length,0);
  const result=await openCancellationCase(f.organizer,{intentId:randomUUID(),packageId,expectedVersion:review.packageVersion,reviewDigest:review.digest,reason:"The school community chose a different plan for this space.",deadline:new Date(Date.now()+3_000_000).toISOString(),acknowledged:true});return(await fundingDesk(f.organizer)).cases.find(row=>row.id===result.id)!;
}
async function decide(session:Session,saved:Awaited<ReturnType<typeof cancel>>,receiptId:string,target:Awaited<ReturnType<typeof policy>>|null){
  const source=saved.sources.find(source=>source.receiptId===receiptId)!;
  const result=await recordFundingChoice(session,{intentId:randomUUID(),caseId:saved.id,caseDigest:saved.digest,receiptId,expectedVersion:source.receiptVersion,kind:target?"reallocation":"return",policyId:target?.id??null,policyDigest:target?.digest??null,acknowledged:true});
  const choice=(await fundingDesk(session)).cases.find(row=>row.id===saved.id)!.sources.find(row=>row.receiptId===receiptId)!.choice!;
  return executeFundingChoice(session,{intentId:randomUUID(),choiceId:result.id,digest:choice.digest,expectedVersion:choice.version});
}
function checkoutTransport(){
  const calls:PaymentCommand[]=[],orders=new Map<string,ProviderResource[]>(),effects=new Map<string,ProviderReceipt>();
  const control={approved:false,mode:"success" as "success"|"unknown"|"refused",reveal:false};
  const observation=(command:PaymentCommand,resources:ProviderResource[]):ProviderReceipt=>({id:randomUUID(),operationId:command.operationId,providerRequestId:command.providerRequestId,source:"live_sandbox",transport:"local_fixture",status:201,observedAt:new Date().toISOString(),resources,debugId:null,bodyHash:sha256(canonicalJson(resources)),reconciled:false});
  const resource=(kind:ProviderResource["kind"],id:string,status:string,command:PaymentCommand,parentId:string|null):ProviderResource=>({kind,id,status,money:kind==="order"?null:command.action.money,parentId,customId:command.action.kind==="create_order"?command.action.customId??null:null,source:"live_sandbox",observedAt:new Date().toISOString(),links:kind==="order"?[{rel:"approve",method:"GET",href:`https://www.sandbox.paypal.com/checkoutnow?token=${id}`}]:[]});
  const provider:ProviderAdapter={source:"live_sandbox",async execute(command){calls.push(command);
    if(control.mode==="refused")throw new ProviderError("api","A labelled fixture refusal","rejected",422);
    if(command.action.kind==="create_order"){const order=resource("order",`ORDER-${randomUUID()}`,"CREATED",command,null),result=observation(command,[order]);orders.set(order.id,[order]);effects.set(command.operationId,result);return result;}
    assert.equal(command.action.kind,"capture_order");assert.ok(control.approved);const action=command.action as Extract<PaymentCommand["action"],{kind:"capture_order"}>;
    const order=resource("order",action.orderId,"COMPLETED",command,null),capture=resource("capture",`CAPTURE-${randomUUID()}`,"COMPLETED",command,action.orderId),result=observation(command,[order,capture]);orders.set(order.id,[order,capture]);effects.set(command.operationId,result);
    if(control.mode==="unknown")throw new ProviderError("connection","Fixture response was lost","unknown",0);return result;
  },async reconcile(operation){return control.reveal?effects.get(operation.command.operationId)??null:null;},async read(kind,id){assert.equal(kind,"order");const saved=orders.get(id);assert.ok(saved);if(saved.some(row=>row.kind==="capture")&&control.reveal)return saved;return[{...saved[0],status:control.approved?"APPROVED":"CREATED"}];}};
  const core=new PaymentCore({store:paymentStore(),provider,policy:{authorize:authorizePayment}});return{deps:{provider,core},control,calls};
}
const checkoutInput=(value:{id:string;digest:string;version:number},action:"create"|"capture"|"check"|"retry",orderId?:string)=>({pledgeId:value.id,digest:value.digest,expectedVersion:value.version,action,acknowledged:true as const,...(orderId?{orderId}:{})});

describe("general purpose pledges, sponsor agreements and original checkout recovery",()=>{
  it("settles separate donor, matching and grant promises, then returns and reallocates without changing original receipts",async()=>{
    const f=await workspace();await query("UPDATE fp_packages SET budget_minor=6000 WHERE project_id=$1 AND id='materials'",[f.organizer.projectId]);const target=await policy(f),next=await policy(f,"printing");
    const match=await sponsor(f,[target],"match",[2000],2000,5000),grant=await sponsor(f,[next],"grant",[2000]);
    await acceptSponsorOffer(f.donors[1],sponsorAction(match));await acceptSponsorOffer(f.donors[2],sponsorAction(grant));
    let desk=await fundingDesk(f.organizer);assert.equal(desk.sponsors.find(row=>row.id===grant.id)?.pledgedMinor,2000);assert.equal(desk.sponsors.find(row=>row.id===grant.id)?.collectedMinor,0);assert.equal(desk.packages.find(row=>row.id==='printing')?.eligibleMinor,0);
    const ordinary=await pledge(f.donors[0],target,4000);await settleSamplePurposePledge(f.donors[0],pledgeAction(ordinary));
    const matching=(await fundingDesk(f.donors[1])).pledges.find(row=>row.kind==="match")!;assert.equal(matching.amountMinor,2000);await refreshSponsorAgreements(f.organizer);assert.equal((await fundingDesk(f.donors[1])).pledges.length,1);
    await settleSamplePurposePledge(f.donors[1],pledgeAction(matching));const grantPledge=(await fundingDesk(f.donors[2])).pledges[0];await settleSamplePurposePledge(f.donors[2],pledgeAction(grantPledge));
    desk=await fundingDesk(f.organizer);assert.equal(desk.policies.find(row=>row.id===target.id)?.state,"funded");assert.equal(desk.packages.find(row=>row.id==='materials')?.eligibleMinor,6000);
    const before=await query<{id:string;data:unknown}>("SELECT id,data FROM fp_settlement_receipts WHERE project_id=$1 ORDER BY id",[f.organizer.projectId]);const saved=await cancel(f,"materials");
    const donorReceipt=(await fundingDesk(f.donors[0])).pledges[0].receiptIds[0],sponsorReceipt=(await fundingDesk(f.donors[1])).pledges[0].receiptIds[0];
    await decide(f.donors[0],saved,donorReceipt,next);await decide(f.donors[1],saved,sponsorReceipt,null);
    desk=await fundingDesk(f.organizer);assert.equal(desk.cases[0].state,"resolved");assert.equal(desk.packages.find(row=>row.id==='materials')?.eligibleMinor,0);assert.equal(desk.packages.find(row=>row.id==='printing')?.eligibleMinor,6000);assert.equal(desk.sponsors.find(row=>row.id===match.id)?.collectedMinor,0);
    const afterRows=await query<{id:string;data:Record<string,unknown>}>("SELECT id,data FROM fp_settlement_receipts WHERE project_id=$1 ORDER BY id",[f.organizer.projectId]);assert.equal(afterRows.length,before.length);assert.deepEqual(afterRows.find(row=>row.id===donorReceipt)?.data,before.find(row=>row.id===donorReceipt)?.data);assert.equal(afterRows.find(row=>row.id===sponsorReceipt)?.data.packageId,"materials");
    const projection=await readFundingProjection(f.scope,database());assert.equal(projection.positions.reduce((n,row)=>n+row.availableMinor+row.paidMinor+row.reservedMinor+row.refundedMinor+row.pendingRefundMinor+row.excludedMinor,0),8000);
    const report=await readStudioSnapshot(f.organizer);assert.equal(report.data.settlements.length,3);assert.equal(report.data.funding_positions!.reduce((n,row)=>n+row.assignedMinor,0),8000);assert.equal((await readStudioSnapshot(f.donors[0])).data.settlements.length,1);
  });
  it("keeps fractional match remainders exact and caps concurrent packages against one accepted agreement",async()=>{
    const f=await workspace(),a=await policy(f),b=await policy(f,"printing"),match=await sponsor(f,[a,b],"match",[3,3],3,5000);await acceptSponsorOffer(f.donors[1],sponsorAction(match));
    const first=await pledge(f.donors[0],a,1);await settleSamplePurposePledge(f.donors[0],pledgeAction(first));assert.equal((await fundingDesk(f.donors[1])).pledges.length,0);
    const second=await pledge(f.donors[0],a,1);await settleSamplePurposePledge(f.donors[0],pledgeAction(second));assert.equal((await fundingDesk(f.donors[1])).pledges[0].amountMinor,1);
    const [pa,pb]=await Promise.all([pledge(f.donors[0],a,8),pledge(f.donors[2],b,8)]);await Promise.all([settleSamplePurposePledge(f.donors[0],pledgeAction(pa)),settleSamplePurposePledge(f.donors[2],pledgeAction(pb))]);
    await Promise.all([refreshSponsorAgreements(f.organizer),refreshSponsorAgreements(f.donors[1])]);const desk=await fundingDesk(f.organizer),view=desk.sponsors[0];assert.equal(view.pledgedMinor,3);assert.equal(view.collectedMinor,0);assert.equal(view.events.reduce((n,row)=>n+row.matchMinor,0),3);assert.equal(new Set(view.events.map(row=>row.receiptId)).size,view.events.length);
    const ownSupport=await pledge(f.donors[1],a,100);await settleSamplePurposePledge(f.donors[1],pledgeAction(ownSupport));assert.equal((await fundingDesk(f.organizer)).sponsors[0].events.length,view.events.length);
  });
  it("separates membership, purpose version, cross-project ownership and uncollected withdrawal from settled support",async()=>{
    const f=await workspace(),other=await workspace(),target=await policy(f),saved=await pledge(f.donors[0],target,3000);
    await assert.rejects(settleSamplePurposePledge(other.donors[0],pledgeAction(saved)),{code:"PLEDGE_NOT_FOUND"});await assert.rejects(settleSamplePurposePledge(f.donors[1],pledgeAction(saved)),{code:"PLEDGE_NOT_FOUND"});
    await withdrawPurposePledge(f.donors[0],pledgeAction(saved));assert.equal((await fundingDesk(f.organizer)).policies[0].remainingMinor,10000);await assert.rejects(settleSamplePurposePledge(f.donors[0],pledgeAction(saved)),{code:"PLEDGE_AUTHORITY_CHANGED"});
    const second=await pledge(f.donors[0],target,2000);await query("UPDATE fp_memberships SET version=version+1 WHERE actor_id=$1",[f.donors[0].actorId]);await assert.rejects(settleSamplePurposePledge(f.donors[0],pledgeAction(second)),{code:"PLEDGE_AUTHORITY_CHANGED"});
    const third=await pledge(f.donors[2],target,1000);await query("UPDATE fp_packages SET version=version+1 WHERE project_id=$1 AND id='materials'",[f.organizer.projectId]);await assert.rejects(settleSamplePurposePledge(f.donors[2],pledgeAction(third)),{code:"DESTINATION_VERSION_CHANGED"});assert.equal((await query("SELECT id FROM fp_settlement_receipts WHERE project_id=$1",[f.organizer.projectId])).length,0);
  });
  it("retains bounded expired agreements and closes empty purposes without renewing any deadline",async()=>{
    const f=await workspace(),target=await policy(f),saved=await pledge(f.donors[0],target,1000),offer=await sponsor(f,[target],"grant",[1000]);await acceptSponsorOffer(f.donors[1],sponsorAction(offer));
    const before=await query("SELECT digest,expires_at,encrypted_data FROM fp_funding_policies WHERE id=$1",[target.id]);const now=Date.now;try{Date.now=()=>now()+49*3_600_000;
      await assert.rejects(settleSamplePurposePledge(f.donors[0],pledgeAction(saved)),{code:"PLEDGE_AUTHORITY_CHANGED"});await reviewPurposeWindow(f.organizer,{intentId:randomUUID(),policyId:target.id,digest:target.digest,expectedVersion:1,action:"review_expiry",acknowledged:true});
    }finally{Date.now=now;}
    assert.deepEqual(await query("SELECT digest,expires_at,encrypted_data FROM fp_funding_policies WHERE id=$1",[target.id]),before);assert.equal((await fundingDesk(f.organizer)).pledges.every(row=>row.state==="expired"),true);
    const empty=await policy(f,"printing");await reviewPurposeWindow(f.organizer,{intentId:randomUUID(),policyId:empty.id,digest:empty.digest,expectedVersion:1,action:"close_empty",acknowledged:true});assert.equal((await fundingDesk(f.organizer)).packages.find(row=>row.id==='printing')?.state,"cancelled");
    await assert.rejects(createFundingPolicy(f.organizer,{intentId:randomUUID(),packageId:"printing",expectedVersion:1,kind:"rollover",acknowledged:true}),{code:"DESTINATION_CLOSED"});
  });
  it("withdraws future sponsor promises while preserving the accepted agreement and its cap history",async()=>{
    const f=await workspace(),target=await policy(f),offer=await sponsor(f,[target],"grant",[2500]);await acceptSponsorOffer(f.donors[0],sponsorAction(offer));
    await assert.rejects(withdrawSponsorOffer(f.organizer,sponsorAction(offer)),{code:"ROLE_DENIED"});await withdrawSponsorOffer(f.donors[0],sponsorAction(offer));const desk=await fundingDesk(f.donors[0]);assert.equal(desk.sponsors[0].state,"withdrawn");assert.equal(desk.pledges[0].state,"withdrawn");assert.equal(desk.policies[0].remainingMinor,10000);assert.equal((await query("SELECT id FROM fp_sponsor_acceptances WHERE offer_id=$1",[offer.id])).length,1);
  });
  it("uses one buyer-approved original capture through response loss, duplicate callbacks and a late create replay",async()=>{
    const f=await workspace("live_sandbox"),target=await policy(f,"woodworking"),saved=await pledge(f.donors[0],target,10000),transport=checkoutTransport();
    const created=await purposeCheckout(f.donors[0],checkoutInput(saved,"create"),transport.deps);assert.equal(created.status,"succeeded");assert.ok(created.approvalUrl);assert.equal((await fundingDesk(f.organizer)).packages.find(row=>row.id==='woodworking')?.eligibleMinor,0);
    await assert.rejects(purposeCheckout(f.donors[0],checkoutInput(saved,"capture",created.orderId!),transport.deps),{code:"BUYER_APPROVAL_REQUIRED"});transport.control.approved=true;transport.control.mode="unknown";
    const captured=await purposeCheckout(f.donors[0],checkoutInput(saved,"capture",created.orderId!),transport.deps);assert.equal(captured.status,"pending_reconciliation");assert.equal(transport.calls.length,2);
    await assert.rejects(purposeCheckout(f.donors[0],checkoutInput(saved,"retry"),transport.deps),{code:"RECONCILIATION_REQUIRED"});
    await purposeCheckout(f.donors[0],checkoutInput(saved,"create"),transport.deps);assert.equal((await fundingDesk(f.donors[0])).pledges[0].operationId,captured.operationId);
    transport.control.reveal=true;await Promise.all([purposeCheckout(f.donors[0],checkoutInput(saved,"check"),transport.deps),purposeCheckout(f.donors[0],checkoutInput(saved,"capture",created.orderId!),transport.deps)]);
    const desk=await fundingDesk(f.organizer);assert.equal(desk.pledges[0].collectedMinor,10000);assert.equal(desk.policies[0].state,"funded");assert.equal(transport.calls.length,2);assert.equal((await query("SELECT id FROM fp_settlement_receipts WHERE project_id=$1",[f.organizer.projectId])).length,1);assert.equal((await query("SELECT operation_id FROM fp_payment_commands WHERE project_id=$1",[f.organizer.projectId])).length,2);
  });
  it("recovers a command saved before the durable core claim with byte-identical approval and request IDs",async()=>{
    const f=await workspace("live_sandbox"),target=await policy(f),saved=await pledge(f.donors[0],target,1000),transport=checkoutTransport();
    const interrupted:PurposeCheckoutDependencies={provider:transport.deps.provider,core:{execute:async()=>{throw new Error("Labelled process exit before core claim");}} as unknown as PaymentCore};
    await assert.rejects(purposeCheckout(f.donors[0],checkoutInput(saved,"create"),interrupted),/process exit/);const commands=await query("SELECT operation_id,command FROM fp_payment_commands WHERE project_id=$1",[f.organizer.projectId]);assert.equal((await fundingDesk(f.donors[0])).pledges[0].canRetry,true);
    await purposeCheckout(f.donors[0],checkoutInput(saved,"retry"),transport.deps);assert.deepEqual(await query("SELECT operation_id,command FROM fp_payment_commands WHERE project_id=$1",[f.organizer.projectId]),commands);assert.equal(transport.calls.length,1);
  });
  it("blocks every new-purpose provider dispatch when deployment qualification or current organizer authority is missing",async()=>{
    const f=await workspace("live_sandbox"),target=await policy(f),saved=await pledge(f.donors[0],target,1000),transport=checkoutTransport(),gate=process.env.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED;
    try{process.env.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED="false";await assert.rejects(purposeCheckout(f.donors[0],checkoutInput(saved,"create"),transport.deps),{code:"AUTHORITY_DENIED"});}finally{process.env.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED=gate;}
    assert.equal(transport.calls.length,0);await query("UPDATE fp_memberships SET version=version+1 WHERE actor_id=$1",[f.organizer.actorId]);await assert.rejects(purposeCheckout(f.donors[0],checkoutInput(saved,"retry"),transport.deps),{code:"AUTHORITY_DENIED"});assert.equal(transport.calls.length,0);
  });
  it("records exact fictional original purposes when creating a new Sample workspace",async()=>{
    const f=await workspace("sample",true),journal=await readFundingJournal(f.scope,database()),origins=await readFundingOrigins(f.scope,database());assert.equal(origins.length,8);assert.equal(projectFundingLots(journal,f.scope,origins).length,8);
    await query("UPDATE fp_packages SET version=version+1 WHERE project_id=$1 AND id='electronics'",[f.organizer.projectId]);const current=await readFundingOrigins(f.scope,database());assert.ok(current.filter(row=>row.packageId==='electronics').every(row=>row.packageVersion===1));
    await assert.rejects(query("UPDATE fp_sample_funding_origins SET package_version=2 WHERE project_id=$1",[f.organizer.projectId]),/append-only/);
  });
  it("keeps a withdrawn started pledge withdrawn when the original create operation is replayed",async()=>{
    const f=await workspace("live_sandbox"),target=await policy(f),saved=await pledge(f.donors[0],target,1000),transport=checkoutTransport();
    await purposeCheckout(f.donors[0],checkoutInput(saved,"create"),transport.deps);const original=await query("SELECT operation_id,command FROM fp_payment_commands WHERE project_id=$1",[f.organizer.projectId]);
    await withdrawPurposePledge(f.donors[0],pledgeAction(saved));await purposeCheckout(f.donors[0],checkoutInput(saved,"create"),transport.deps);
    const desk=await fundingDesk(f.donors[0]);assert.equal(desk.pledges[0].state,"withdrawn");assert.equal(desk.pledges[0].pendingMinor,0);assert.equal(desk.policies[0].remainingMinor,10000);assert.equal(transport.calls.length,1);
    transport.control.approved=true;await assert.rejects(purposeCheckout(f.donors[0],checkoutInput(saved,"capture",desk.pledges[0].orderId!),transport.deps),{code:"PLEDGE_AUTHORITY_CHANGED"});assert.deepEqual(await query("SELECT operation_id,command FROM fp_payment_commands WHERE project_id=$1",[f.organizer.projectId]),original);
  });
  it("withdraws a positively refused checkout while preserving its old command, and holds an ambiguous capture",async()=>{
    const f=await workspace("live_sandbox"),target=await policy(f),saved=await pledge(f.donors[0],target,1200),transport=checkoutTransport();transport.control.mode="refused";
    await purposeCheckout(f.donors[0],checkoutInput(saved,"create"),transport.deps);await withdrawPurposePledge(f.donors[0],pledgeAction(saved));transport.control.mode="success";
    await assert.rejects(purposeCheckout(f.donors[0],checkoutInput(saved,"retry"),transport.deps),{code:"AUTHORITY_DENIED"});assert.equal(transport.calls.length,1);
    const next=await pledge(f.donors[0],target,1400),other=checkoutTransport(),created=await purposeCheckout(f.donors[0],checkoutInput(next,"create"),other.deps);other.control.approved=true;other.control.mode="unknown";
    await purposeCheckout(f.donors[0],checkoutInput(next,"capture",created.orderId!),other.deps);await assert.rejects(withdrawPurposePledge(f.donors[0],pledgeAction(next)),{code:"PLEDGE_STARTED"});assert.equal((await fundingDesk(f.organizer)).policies[0].remainingMinor,8600);
  });
  it("holds an unpaid matching promise when its settled source changes and does not manufacture a new matching event",async()=>{
    const f=await workspace(),target=await policy(f),match=await sponsor(f,[target],"match",[2000],2000,5000);await acceptSponsorOffer(f.donors[1],sponsorAction(match));
    const original=await pledge(f.donors[0],target,2000);await settleSamplePurposePledge(f.donors[0],pledgeAction(original));const pending=(await fundingDesk(f.donors[1])).pledges[0],events=await query("SELECT * FROM fp_sponsor_events WHERE offer_id=$1",[match.id]);assert.equal(pending.amountMinor,1000);
    const receiptId=(await fundingDesk(f.donors[0])).pledges[0].receiptIds[0];await query("UPDATE fp_settlement_receipts SET data=jsonb_set(data,'{observedAt}',to_jsonb($2::text)) WHERE id=$1",[receiptId,new Date(Date.now()+1000).toISOString()]);
    await refreshSponsorAgreements(f.organizer);await assert.rejects(settleSamplePurposePledge(f.donors[1],pledgeAction(pending)),{code:"PLEDGE_AUTHORITY_CHANGED"});const desk=await fundingDesk(f.donors[1]);assert.equal(desk.pledges[0].state,"held");assert.equal(desk.sponsors[0].state,"review_required");assert.deepEqual(await query("SELECT * FROM fp_sponsor_events WHERE offer_id=$1",[match.id]),events);
  });
  it("excludes earlier contributions and preserves exact original purpose text after a later plan revision",async()=>{
    const f=await workspace(),target=await policy(f),saved=await pledge(f.donors[0],target,1500);await settleSamplePurposePledge(f.donors[0],pledgeAction(saved));
    const match=await sponsor(f,[target],"match",[2000]);await acceptSponsorOffer(f.donors[1],sponsorAction(match));await refreshSponsorAgreements(f.organizer);assert.equal((await fundingDesk(f.donors[1])).pledges.length,0);
    const receiptId=(await fundingDesk(f.donors[0])).pledges[0].receiptIds[0],original=await fundingReceiptTrail(f.donors[0],receiptId);await query("UPDATE fp_packages SET version=version+1,data=jsonb_set(data,'{title}','\"A later, different purpose\"'::jsonb) WHERE project_id=$1 AND id='materials'",[f.organizer.projectId]);
    const history=await fundingReceiptTrail(f.donors[0],receiptId);assert.equal(history.originalTitle,target.title);assert.equal(history.originalPurpose,target.purpose);assert.equal(history.originalPackageVersion,1);assert.equal(history.originalTitle,original.originalTitle);await assert.rejects(fundingReceiptTrail(f.donors[1],receiptId),{code:"FUNDING_RECEIPT_NOT_FOUND"});
  });
  it("keeps unpaid promises equal across the project and Studio, and never backfills old report positions from today's ledger",async()=>{
    const f=await workspace(),target=await policy(f),first=await pledge(f.donors[0],target,2100),second=await pledge(f.donors[1],target,900);await settleSamplePurposePledge(f.donors[0],pledgeAction(first));await withdrawPurposePledge(f.donors[1],pledgeAction(second));
    const snapshot=await projectSnapshot(f.organizer),studio=await readStudioSnapshot(f.organizer);assert.equal(snapshot.packages.find(row=>row.id==='materials')?.pledgedMinor,2100);assert.equal(studio.data.packages.find(row=>row.packageId==='materials')?.pledgedMinor,2100);
    const old=structuredClone(studio);delete old.data.funding_positions;delete old.datasetVersions;const before=canonicalJson(old),definition=studioDataDefinition(old);const positions=definition.sources.find(source=>source.id==='funding_positions');assert.ok(positions&&'data' in positions);assert.deepEqual(positions.data,[]);assert.equal(canonicalJson(old),before);assert.equal(studioTransactions(old,studio).status,"scope_changed");assert.equal(studioTransactions(old,structuredClone(old)).status,"ready");
    const own=await readStudioSnapshot(f.donors[1]);assert.equal(own.data.funding_positions!.length,0);assert.equal(own.data.settlements.length,0);
  });

});
