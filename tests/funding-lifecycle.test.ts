import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canonicalJson, PaymentCore, PostgresDatabase, ProviderError, sha256, type PaymentCommand, type ProviderAdapter, type ProviderReceipt, type ProviderResource, type CommerceRestResult, type PayoutBatchObservation, type PayoutItemObservation } from "@fracture/paypal-core";
import type { Session } from "../lib/server/auth";
import { database, initializeDatabase, query } from "../lib/server/db";
import { createProject, sampleReceipt } from "../lib/server/seed";
import { applyCancellationDefaults, cancellationCaseReview, createFundingPolicy, executeFundingChoice, fundingDesk, openCancellationCase, recordFundingChoice, revokeFundingChoice } from "../lib/server/funding-lifecycle";
import { fundingReceiptTrail } from "../lib/server/funding-trail";
import { readFundingProjection } from "../lib/server/funding-positions";
import { collectionView } from "../lib/server/collections";
import { readCancellationReview } from "../lib/server/cancellation-review";
import { cancelUnspentCollection } from "../lib/server/compensation";
import { approvePayout, claimPaymentView, preparePayoutReview, sendPayout, type PayoutDependencies } from "../lib/server/payouts";
import { createClaim, reviewClaim, saveClaimDraft } from "../lib/server/claims";
import { importSampleReceipt } from "../lib/server/documents";
import type { DocumentStorage } from "../lib/server/document-storage";
import { sealDestination } from "../lib/server/identity";
import { authorizePayment, paymentStore } from "../lib/server/payments";
import { checkRefund, requestRefund, type RefundDependencies } from "../lib/server/refunds";
import { applyAllocationAdjustment, caseRecoveryReview, proposeAllocationAdjustment, recordSampleFundingUse, respondAllocationAdjustment, revokeAdjustmentResponse, withdrawAllocationAdjustment, refreshResidualCase } from "../lib/server/funding-adjustments";
import { observeOriginalReturns, reconcileOriginalReturns, returnRecoveryReview } from "../lib/server/funding-return-reconciliation";
import type { SettlementReceipt } from "../lib/contracts";

const schema=`fp_lifecycle_test_${randomUUID().replaceAll("-","")}`, original=process.env.DATABASE_URL!, admin=new PostgresDatabase(original);
before(async()=>{await admin.query(`CREATE SCHEMA "${schema}"`);const url=new URL(original);url.searchParams.set("options",`-c search_path=${schema}`);process.env.DATABASE_URL=url.href;await initializeDatabase();});
afterEach(async()=>{const tables=await query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname=$1",[schema]);if(tables.length)await database().query(`TRUNCATE ${tables.map(row=>`"${schema}"."${row.tablename}"`).join(",")} RESTART IDENTITY CASCADE`);});
after(async()=>{await database().close();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();process.env.DATABASE_URL=original;});

async function fixture(mode:Session["mode"]="live_sandbox") {
  const scope={tenantId:randomUUID(),projectId:randomUUID()},sessions:Session[]=[];
  await database().transaction(async tx=>{
    await createProject(tx,scope.tenantId,scope.projectId,`funding-fixture-${randomUUID()}`,"live_sandbox");
    if(mode==="sample")await tx.query("UPDATE fp_tenants SET mode='sample' WHERE id=$1",[scope.tenantId]);
    for(const role of ["organizer","donor","donor"] as const){const session:Session={...scope,id:randomUUID(),actorId:randomUUID(),role,mode,expiresAt:new Date(Date.now()+3_600_000).toISOString()};sessions.push(session);
      await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",[session.id,randomUUID(),scope.tenantId,scope.projectId,session.actorId,role,session.expiresAt]);
      await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,$4::jsonb)",[scope.tenantId,scope.projectId,session.actorId,JSON.stringify(role==="organizer"?["organizer","volunteer","auditor"]:["donor"])]);
    }
    await tx.query("UPDATE fp_packages SET budget_minor=10000,data=jsonb_set(data,'{fundingState}',to_jsonb(CASE WHEN id='electronics' THEN 'funded' ELSE 'open' END)) WHERE project_id=$1 AND id IN ('electronics','printing','materials')",[scope.projectId]);
  });
  const [organizer,...donors]=sessions,roundId=randomUUID(),start=new Date(),end=new Date(start.getTime()+48*3_600_000),receipts:SettlementReceipt[]=[];
  await database().transaction(async tx=>{
    await tx.query("INSERT INTO fp_collection_rounds(id,tenant_id,project_id,package_id,package_version,target_minor,collection_started_at,recovery_ends_at,policy_hash,state,data) VALUES($1,$2,$3,'electronics',1,10000,$4,$5,'fixture-original-policy','funded','{}')",[roundId,scope.tenantId,scope.projectId,start,end]);
    for(const [index,donor] of donors.entries()){
      const obligationId=randomUUID(),consentId=randomUUID(),digest=sha256(`fixture-original-consent:${consentId}`);
      const receipt={...sampleReceipt(scope.tenantId,scope.projectId,obligationId,"electronics",5000,randomUUID(),index===1),provenance:mode};
      if(index===1){receipt.provenRefundableRef=receipt.actualProviderPaymentRef;receipt.refundAdapter="capture_refund";}
      receipts.push(receipt);
      await tx.query("INSERT INTO fp_obligations(id,tenant_id,project_id,package_id,actor_id,amount_minor,channel,purpose,data) VALUES($1,$2,$3,'electronics',$4,5000,'collected','conditional_pledge','{}')",[obligationId,scope.tenantId,scope.projectId,donor.actorId]);
      await tx.query(`INSERT INTO fp_conditional_consents(id,tenant_id,project_id,actor_id,session_id,obligation_id,intent_id,slot_index,package_id,package_version,amount_minor,status,policy_digest,policy,expires_at,round_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'electronics',1,5000,'collected',$9,'{}',$10,$11)`,[consentId,scope.tenantId,scope.projectId,donor.actorId,donor.id,obligationId,randomUUID(),index,digest,end,roundId]);
      await tx.query("INSERT INTO fp_collection_items(round_id,consent_id,obligation_id,consent_version,consent_digest,amount_minor,state) VALUES($1,$2,$3,1,$4,5000,'collected')",[roundId,consentId,obligationId,digest]);
      await tx.query("INSERT INTO fp_settlement_receipts(id,tenant_id,project_id,obligation_id,package_id,provider_ref,provenance,data) VALUES($1,$2,$3,$4,'electronics',$5,$6,$7::jsonb)",[receipt.id,scope.tenantId,scope.projectId,obligationId,receipt.actualProviderPaymentRef,mode,JSON.stringify(receipt)]);
    }
  });
  return {organizer,donors,receipts,roundId,scope:{...scope,provenance:mode}};
}
async function openCase(f:Awaited<ReturnType<typeof fixture>>,packageId="electronics"){
  const review=await cancellationCaseReview(f.organizer,packageId);
  const input={intentId:randomUUID(),packageId,expectedVersion:review.packageVersion,reviewDigest:review.digest,reason:"The room plan changed after the community review.",deadline:new Date(Date.now()+3_600_000).toISOString(),acknowledged:true as const};
  const opened=await openCancellationCase(f.organizer,input);
  assert.equal((await openCancellationCase(f.organizer,input)).id,opened.id);
  return (await fundingDesk(f.organizer)).cases.find(row=>row.id===opened.id)!;
}
async function policy(f:Awaited<ReturnType<typeof fixture>>,packageId="printing",kind:"mixed"|"rollover"|"reallocation"="mixed"){
  const saved=await createFundingPolicy(f.organizer,{intentId:randomUUID(),packageId,expectedVersion:1,kind,acknowledged:true});
  return (await fundingDesk(f.organizer)).policies.find(row=>row.id===saved.id)!;
}
async function choice(f:Awaited<ReturnType<typeof fixture>>,index:number,saved:Awaited<ReturnType<typeof openCase>>,target:Awaited<ReturnType<typeof policy>>|null,kind:"return"|"reallocation"|"rollover"=target?"reallocation":"return"){
  const source=saved.sources.find(source=>source.receiptId===f.receipts[index].id)!;
  const input={intentId:randomUUID(),caseId:saved.id,caseDigest:saved.digest,receiptId:source.receiptId,expectedVersion:source.receiptVersion,kind,policyId:target?.id??null,policyDigest:target?.digest??null,acknowledged:true as const};
  const recorded=await recordFundingChoice(f.donors[index],input);assert.equal((await recordFundingChoice(f.donors[index],input)).id,recorded.id);
  const view=(await fundingDesk(f.donors[index])).cases.find(row=>row.id===saved.id)!.sources[0].choice!;
  return {intentId:randomUUID(),choiceId:recorded.id,digest:view.digest,expectedVersion:view.version};
}
async function moveAll(f:Awaited<ReturnType<typeof fixture>>){const target=await policy(f),saved=await openCase(f);for(let index=0;index<f.donors.length;index++)await executeFundingChoice(f.donors[index],await choice(f,index,saved,target));return{target,saved};}
async function expense(f:Awaited<ReturnType<typeof fixture>>,packageId="printing"){
  const session=f.organizer,files=new Map<string,{bytes:Buffer;contentType:string}>();
  const storage:DocumentStorage={async write(pathname,bytes,contentType){files.set(pathname,{bytes,contentType});},async read(pathname){const file=files.get(pathname);assert.ok(file);return{...file,pathname};}};
  await query("UPDATE fp_sessions SET role='volunteer' WHERE id=$1",[session.id]);session.role="volunteer";
  await query("INSERT INTO fp_recipient_accounts(id,tenant_id,actor_id,encrypted_destination,masked_label,verification_method,account_verified,verified_at) VALUES($1,$2,$3,$4,'Fixture account','paypal_identity',true,now())",[randomUUID(),session.tenantId,session.actorId,sealDestination("FIXTURELIFECYCLE01",session.tenantId,session.actorId)]);
  const document=await importSampleReceipt(session,randomUUID(),"original",storage);let claim=await createClaim(session,{documentId:document.id,runId:null,intentId:randomUUID()});
  claim=await saveClaimDraft(session,claim.id,{expectedVersion:claim.version,title:"Supplies for the new purpose",note:"A synthetic source reviewed for this isolated test",currency:"USD",totalMinor:8640,lines:[{id:"line-1",description:"Solder wire",requestedMinor:1800,packageId}]},true);
  await query("UPDATE fp_sessions SET role='organizer' WHERE id=$1",[session.id]);session.role="organizer";
  claim=await reviewClaim(session,claim.id,{expectedVersion:claim.version,sourceTotalMinor:8640,currency:"USD",note:"Exact source line, amount and purpose checked",sourceChecked:true,sampleAcknowledged:true,receiptSplit:false,duplicateResolutions:[],lines:[{id:"line-1",description:"Solder wire",packageId,sourceMinor:1800,approvedMinor:1800,receiptLineKey:"1",decision:"approved",reviewNote:"Fixture exact source reviewed",uncertaintyResolved:true}]});
  const review=()=>preparePayoutReview(session,claim.id,{expectedVersion:claim.version,lineIds:["line-1"]});
  return {claim,review,approve:async()=>{const value=await review();return approvePayout(session,claim.id,{reviewId:value.id,reviewDigest:value.digest,intentId:randomUUID(),amountMinor:value.amountMinor,currency:"USD",recipientAndAmountChecked:true,feeAllowanceAcknowledged:true,sampleAcknowledged:true});}};
}
function returns(receipt:SettlementReceipt,mode:"completed"|"pending"|"unknown"|"refused"="completed"){
  const calls:PaymentCommand[]=[],effects=new Map<string,ProviderResource>();let completed=mode==="completed",external=0,externalStatus="COMPLETED";const reads:string[]=[];
  const resource=(kind:ProviderResource["kind"],id:string,status:string):ProviderResource=>({kind,id,status,money:kind==="order"?null:{currency:"USD",minor:receipt.grossSettledMinor},parentId:null,customId:null,source:"live_sandbox",observedAt:new Date().toISOString(),links:[]});
  const observation=(command:PaymentCommand,effect:ProviderResource):ProviderReceipt=>({id:randomUUID(),operationId:command.operationId,providerRequestId:command.providerRequestId,source:"live_sandbox",transport:"local_fixture",status:201,observedAt:new Date().toISOString(),resources:[effect],debugId:null,bodyHash:sha256(canonicalJson(effect)),reconciled:false});
  const provider:ProviderAdapter={source:"live_sandbox",async execute(command){calls.push(command);assert.equal(command.action.kind,"refund_capture");if(mode==="refused")throw new ProviderError("api","Fixture refused","rejected",422);
    const effect={...resource("refund",`FIXREF${randomUUID().replaceAll("-","")}`,completed?"COMPLETED":"PENDING"),money:command.action.money,links:[{rel:"up",method:"GET",href:`https://api-m.sandbox.paypal.com/v2/payments/captures/${receipt.provenRefundableRef}`}]};effects.set(command.operationId,effect);if(mode==="unknown")throw new ProviderError("timeout","Fixture response lost","unknown",502);return observation(command,effect);},
    async read(kind,id){reads.push(`${kind}:${id}`);if(kind==="refund"){if(id==="FIXEXTERNAL")return[{...resource("refund",id,externalStatus),money:{currency:"USD",minor:external},links:[{rel:"up",method:"GET",href:`https://api-m.sandbox.paypal.com/v2/payments/captures/${receipt.provenRefundableRef}`}]}];const effect=[...effects.values()].find(effect=>effect.id===id);assert.ok(effect);return[{...effect,status:completed?"COMPLETED":effect.status}];}
      const capture={...resource("capture",receipt.provenRefundableRef!,external&&["COMPLETED","PENDING"].includes(externalStatus)?external===receipt.grossSettledMinor?"REFUNDED":"PARTIALLY_REFUNDED":"COMPLETED"),links:receipt.sourceOrderId?[{rel:"up",method:"GET",href:`https://api-m.sandbox.paypal.com/v2/checkout/orders/${receipt.sourceOrderId}`}]:[]};
      if(kind==="capture")return[capture];assert.equal(kind,"order");return[resource("order",id,"COMPLETED"),capture,...effects.values(),...(external?[{...resource("refund","FIXEXTERNAL",externalStatus),money:{currency:"USD" as const,minor:external},links:[{rel:"up",method:"GET",href:`https://api-m.sandbox.paypal.com/v2/payments/captures/${receipt.provenRefundableRef}`}]}]:[])];},
    async reconcile(operation){const effect=effects.get(operation.command.operationId);return effect&&completed?{...observation(operation.command,{...effect,status:"COMPLETED"}),reconciled:true}:null;}};
  const deps:RefundDependencies={provider,core:new PaymentCore({store:paymentStore(),provider,policy:{authorize:authorizePayment}})};
  return {calls,reads,deps,externalStatus:(status:string)=>{externalStatus=status;},complete:()=>{completed=true;},allow:()=>{mode="completed";completed=true;},external:(minor:number)=>{external=minor;}};
}

async function paidExpense(f:Awaited<ReturnType<typeof fixture>>){
  const expenseReview=await expense(f,"electronics"),payable=await expenseReview.approve();let batch:PayoutBatchObservation|undefined,item:PayoutItemObservation|undefined;
  const result=<T>(value:T):CommerceRestResult<T>=>({outcome:"succeeded",value,source:"live_sandbox",observedAt:new Date().toISOString(),httpStatus:200,debugId:null,recovered:false});
  const deps:PayoutDependencies={gateway:{async createPayout(request){const id=`FIXBATCH${randomUUID().replaceAll("-","")}`;item={...request.items[0],id:`FIXITEM${randomUUID().replaceAll("-","")}`,batchId:id,status:"SUCCESS",transactionId:"FIXTRANSACTION001",fee:{currency:"USD",minor:25},processedAt:new Date().toISOString()};batch={id,senderBatchId:request.senderBatchId,status:"SUCCESS",money:request.items[0].money,estimatedFees:null,items:[item],complete:true};return result({...batch,items:[],complete:false});},async getPayoutBatch(){assert.ok(batch);return result(batch);},async getPayoutItem(){assert.ok(item);return result(item);},async cancelUnclaimedPayout(){throw new Error("Unexpected fixture cancellation");}},balance:{async read(){const time=new Date(Date.now()-30_000).toISOString();return{outcome:"observed",evidence:{accountId:"FIXTUREMERCHANT001",currency:"USD",availableMinor:1_000_000,totalMinor:1_000_000,withheldMinor:0,asOfTime:time,lastRefreshTime:time,observedAt:new Date().toISOString(),bodyHash:"fixture-balance-hash",source:"live_sandbox"}};}}};
  await sendPayout(f.organizer,payable.id,false,deps);return payable;
}
async function samplePaidUse(f:Awaited<ReturnType<typeof fixture>>,amount=1000){
  const id=randomUUID();await database().transaction(async tx=>{await tx.query("INSERT INTO fp_receipt_allocations(id,tenant_id,project_id,receipt_id,claim_id,claim_line_id,package_id,amount_minor,state) VALUES($1,$2,$3,$4,$5,$6,'electronics',$7,'paid')",[id,f.organizer.tenantId,f.organizer.projectId,f.receipts[0].id,randomUUID(),randomUUID(),amount]);await recordSampleFundingUse(tx,f.organizer,id);});return id;
}
async function adjustment(f:Awaited<ReturnType<typeof fixture>>,saved:Awaited<ReturnType<typeof openCase>>){
  const review=await caseRecoveryReview(f.organizer,saved.id);assert.equal(review.canPropose,true,JSON.stringify(review.blockers));const input={intentId:randomUUID(),caseId:saved.id,caseDigest:saved.digest,reviewDigest:review.digest,reason:"The exact expense evidence preserves paid uses while each supporter reviews their source-specific remaining share.",acknowledged:true as const};
  const proposal=await proposeAllocationAdjustment(f.organizer,input);assert.deepEqual(await proposeAllocationAdjustment(f.organizer,input),proposal);const view=(await caseRecoveryReview(f.organizer,saved.id)).adjustments[0];return{intentId:randomUUID(),adjustmentId:view.id,digest:view.digest,expectedVersion:view.version,acknowledged:true as const};
}
async function observedReturn(f:Awaited<ReturnType<typeof fixture>>,index:number,transport:ReturnType<typeof returns>){
  const before=await returnRecoveryReview(f.organizer,f.receipts[index].id);await observeOriginalReturns(f.organizer,{intentId:randomUUID(),receiptId:before.receiptId,expectedVersion:before.receiptVersion,references:[],acknowledged:true},transport.deps.provider);return returnRecoveryReview(f.organizer,f.receipts[index].id);
}
function reconcileInput(review:Awaited<ReturnType<typeof returnRecoveryReview>>){assert.ok(review.observation);return{intentId:randomUUID(),receiptId:review.receiptId,expectedVersion:review.receiptVersion,reviewDigest:review.digest,observationId:review.observation.id,observationDigest:review.observation.digest,reason:"The complete independent original capture and return evidence establish this exact original-purpose attribution.",acknowledged:true as const};}

describe("complete funding purpose and donor decision lifecycle — isolated, injected providers",()=>{
  it("moves Orders and invoice credit under exact donor choices; every reader agrees without rewriting receipts",async()=>{
    const f=await fixture(),before=await query("SELECT id,version,data FROM fp_settlement_receipts ORDER BY id"),authority=await query("SELECT * FROM fp_conditional_consents ORDER BY id");
    const {target}=await moveAll(f),projection=await database().transaction(tx=>readFundingProjection(f.scope,tx));
    assert.equal(projection.availableMinor,10000);assert.equal(projection.positions.filter(row=>row.packageId==="printing").reduce((n,row)=>n+row.availableMinor,0),10000);
    assert.deepEqual(await query("SELECT id,version,data FROM fp_settlement_receipts ORDER BY id"),before);assert.deepEqual(await query("SELECT * FROM fp_conditional_consents ORDER BY id"),authority);
    const original=await collectionView(f.organizer,f.roundId);assert.equal(original!.eligibleMinor,0);assert.equal(original!.originalCollectedMinor,10000);
    const destination=await collectionView(f.organizer,(await query<{round_id:string}>("SELECT round_id FROM fp_funding_policies WHERE id=$1",[target.id]))[0].round_id);assert.equal(destination!.eligibleMinor,10000);
    const cancellation=await readCancellationReview(f.organizer,f.roundId);assert.equal(cancellation.uncommittedMinor,0);assert.equal(cancellation.canCancelUnspent,false);
    await assert.rejects(cancelUnspentCollection(f.organizer,{roundId:f.roundId,expectedVersion:1,acknowledged:true}),{code:"CANCELLATION_CHOICE_REQUIRED"});
    const e=await expense(f);assert.equal((await claimPaymentView(f.organizer,e.claim.id)).lines[0].fundingReady,true);const payable=await e.approve();assert.equal(payable.amountMinor,1800);
    const allocations=await query<{package_id:string;amount_minor:string}>("SELECT package_id,amount_minor FROM fp_receipt_allocations WHERE state='reserved'");assert.ok(allocations.every(row=>row.package_id==="printing"));assert.equal(allocations.reduce((sum,row)=>sum+Number(row.amount_minor),0),3800);
    assert.deepEqual(await query("SELECT id,version,data FROM fp_settlement_receipts ORDER BY id"),before);
  });
  it("rejects another donor, stale destination and revoked consent; replay remains one immutable assignment",async()=>{
    const f=await fixture(),target=await policy(f),saved=await openCase(f),a=await choice(f,0,saved,target);
    const donorView=await fundingDesk(f.donors[0]);assert.equal(donorView.cases[0].sources.length,1);assert.equal(donorView.cases[0].denominatorMinor,10000);assert.ok(!JSON.stringify(donorView).includes(f.donors[1].actorId));
    await assert.rejects(executeFundingChoice(f.donors[1],a),{code:"CHOICE_NOT_FOUND"});
    await query("UPDATE fp_packages SET version=version+1 WHERE project_id=$1 AND id='printing'",[f.organizer.projectId]);await assert.rejects(executeFundingChoice(f.donors[0],a),{code:"DESTINATION_VERSION_CHANGED"});
    await revokeFundingChoice(f.donors[0],{...a,intentId:randomUUID()});await assert.rejects(executeFundingChoice(f.donors[0],a),{code:"CHOICE_AUTHORITY_CHANGED"});
    assert.equal((await query("SELECT id FROM fp_funding_assignments")).length,0);
    const next=await policy(f,"materials","rollover"),b=await choice(f,0,saved,next,"rollover");await Promise.all([executeFundingChoice(f.donors[0],b),executeFundingChoice(f.donors[0],b)]);assert.equal((await query("SELECT id FROM fp_funding_assignments")).length,1);
  });
  it("holds unequal paid expense allocations for review instead of moving historical uses to manufacture pro-rata capacity",async()=>{
    const f=await fixture();await query("INSERT INTO fp_receipt_allocations(id,tenant_id,project_id,receipt_id,claim_id,claim_line_id,package_id,amount_minor,state) VALUES($1,$2,$3,$4,$5,$6,'electronics',1000,'paid')",[randomUUID(),f.organizer.tenantId,f.organizer.projectId,f.receipts[0].id,randomUUID(),randomUUID()]);
    const before=await query("SELECT * FROM fp_receipt_allocations"),review=await cancellationCaseReview(f.organizer,"electronics");assert.equal(review.totalMinor,9000);assert.deepEqual(review.sources.map(row=>row.entitlementMinor),[4500,4500]);assert.equal(review.conflicts.find(row=>row.code==="source_capacity")?.amountMinor,500);
    const saved=await openCase(f);assert.equal(saved.state,"review_required");assert.deepEqual(await query("SELECT * FROM fp_receipt_allocations"),before);
  });
  it("returns assigned funds through one original capture and saves exact current-version deductions",async()=>{
    const f=await fixture();await moveAll(f);const saved=await openCase(f,"printing"),selected=await choice(f,0,saved,null),p=returns(f.receipts[0],"pending");
    await executeFundingChoice(f.donors[0],selected,p.deps);let projection=await database().transaction(tx=>readFundingProjection(f.scope,tx));const position=projection.positions.find(row=>row.receiptId===f.receipts[0].id&&row.packageId==="printing")!;
    assert.equal(position.pendingRefundMinor,5000);assert.equal(position.availableMinor,0);assert.equal(position.receiptVersion,2);assert.equal((await fundingDesk(f.donors[0])).cases.find(row=>row.id===saved.id)!.unresolvedMinor,5000);
    const [refund]=await query<{id:string}>("SELECT id FROM fp_refunds");p.complete();await checkRefund(f.donors[0],refund.id,false,p.deps);projection=await database().transaction(tx=>readFundingProjection(f.scope,tx));assert.equal(projection.totals.collectedMinor,5000);assert.equal(projection.positions.find(row=>row.receiptId===f.receipts[0].id&&row.packageId==="printing")!.refundedMinor,5000);assert.equal(p.calls.length,1);
    await executeFundingChoice(f.donors[0],{...selected,intentId:randomUUID()},p.deps);assert.equal(p.calls.length,1);assert.equal((await query("SELECT receipt_version FROM fp_funding_deductions ORDER BY receipt_version")).length,2);
    await assert.rejects(requestRefund(f.donors[1],{receiptId:f.receipts[1].id,amountMinor:100,intentId:randomUUID(),acknowledged:true},returns(f.receipts[1]).deps),{code:"CANCELLATION_CHOICE_REQUIRED"});
  });
  it("blocks a donor decision after membership revocation, and a latest closed round cannot inherit an old funded flag",async()=>{
    const f=await fixture(),target=await policy(f),saved=await openCase(f),selected=await choice(f,0,saved,target);
    await query("UPDATE fp_memberships SET version=version+1 WHERE actor_id=$1",[f.donors[0].actorId]);await assert.rejects(executeFundingChoice(f.organizer,selected),{code:"CHOICE_MEMBERSHIP_CHANGED"});
    await executeFundingChoice(f.donors[1],await choice(f,1,saved,target));assert.equal((await fundingDesk(f.organizer)).policies[0].state,"open");
    await query("UPDATE fp_packages SET data=jsonb_set(data,'{fundingState}','\"funded\"') WHERE project_id=$1 AND id='printing'",[f.organizer.projectId]);const e=await expense(f);await assert.rejects(e.review(),{code:"PACKAGE_NOT_FUNDED"});
  });
  it("returns exact pro-rata shares when historical paid uses are already balanced, without moving expenses",async()=>{
    const f=await fixture("sample");
    for(const receipt of f.receipts)await query("INSERT INTO fp_receipt_allocations(id,tenant_id,project_id,receipt_id,claim_id,claim_line_id,package_id,amount_minor,state) VALUES($1,$2,$3,$4,$5,$6,'electronics',1000,'paid')",[randomUUID(),f.organizer.tenantId,f.organizer.projectId,receipt.id,randomUUID(),randomUUID()]);
    const uses=await query("SELECT * FROM fp_receipt_allocations ORDER BY id"),saved=await openCase(f);assert.equal(saved.totalMinor,8000);assert.equal(saved.paidMinor,2000);assert.equal(saved.conflicts.length,0);
    for(let index=0;index<2;index++)await executeFundingChoice(f.donors[index],await choice(f,index,saved,null));
    const projection=await readFundingProjection(f.scope,database());assert.equal(projection.positions.reduce((n,p)=>n+p.refundedMinor,0),8000);assert.equal(projection.positions.reduce((n,p)=>n+p.paidMinor,0),2000);assert.equal(projection.availableMinor,0);assert.deepEqual(await query("SELECT * FROM fp_receipt_allocations ORDER BY id"),uses);
    const trail=await fundingReceiptTrail(f.donors[0],f.receipts[0].id);assert.equal(trail.originalPackageVersion,1);assert.equal(trail.returns[0].amountMinor,4000);assert.equal(trail.returns[0].sample,true);
  });
  it("serializes revocation against transfer and never leaves both a revoked consent and spendable moved credit",async()=>{
    const f=await fixture(),target=await policy(f),saved=await openCase(f),selected=await choice(f,0,saved,target);
    const outcome=await Promise.allSettled([revokeFundingChoice(f.donors[0],{...selected,intentId:randomUUID()}),executeFundingChoice(f.donors[0],selected)]);
    assert.equal(outcome.filter(result=>result.status==="fulfilled").length,1);
    const [row]=await query<{state:string}>("SELECT state FROM fp_funding_choices WHERE id=$1",[selected.choiceId]),entries=await query("SELECT id FROM fp_funding_assignments WHERE consent_id=$1",[selected.choiceId]);assert.equal(entries.length,row.state==="executed"?1:0);assert.ok(["executed","revoked"].includes(row.state));
    const projection=await readFundingProjection(f.scope,database());assert.equal(projection.availableMinor,10000);assert.equal(projection.positions.filter(p=>p.packageId==='printing').reduce((n,p)=>n+p.availableMinor,0),row.state==="executed"?5000:0);
  });
  it("serializes a new cancellation review against expense reservation without deadlock or recreated capacity",{timeout:15_000},async()=>{
    const f=await fixture();await moveAll(f);const e=await expense(f),before=await query("SELECT id,version,data FROM fp_settlement_receipts ORDER BY id");
    const result=await Promise.allSettled([e.approve(),openCase(f,"printing")]);assert.ok(result.some(row=>row.status==="fulfilled"));
    const projection=await readFundingProjection(f.scope,database()),reserved=projection.positions.reduce((n,p)=>n+p.reservedMinor,0);assert.ok([0,3800].includes(reserved));assert.equal(projection.availableMinor+reserved,10000);
    const desk=await fundingDesk(f.organizer),saved=desk.cases.find(row=>row.packageId==='printing');if(saved&&reserved)assert.equal(saved.state,"review_required");if(saved)assert.equal(desk.packages.find(row=>row.id==='printing')?.state,"cancelled");
    assert.deepEqual(await query("SELECT id,version,data FROM fp_settlement_receipts ORDER BY id"),before);
  });
  it("rejects changed source identity, source purpose version, target closure and target policy expiry",async()=>{
    for(const change of ["source_identity","source_version","target_cancelled","target_compensating","target_expired"]){
      const f=await fixture(),target=await policy(f),saved=await openCase(f),selected=await choice(f,0,saved,target),now=Date.now;
      try{
        if(change==="source_identity")await query("UPDATE fp_settlement_receipts SET data=jsonb_set(data,'{observedAt}',to_jsonb($2::text)) WHERE id=$1",[f.receipts[0].id,new Date(now()+1000).toISOString()]);
        if(change==="source_version")await query("UPDATE fp_packages SET version=version+1 WHERE project_id=$1 AND id='electronics'",[f.organizer.projectId]);
        if(change.startsWith("target_c"))await query("UPDATE fp_packages SET data=jsonb_set(data,'{fundingState}',to_jsonb($2::text)) WHERE project_id=$1 AND id='printing'",[f.organizer.projectId,change==="target_cancelled"?"cancelled":"compensating"]);
        if(change==="target_expired")Date.now=()=>now()+49*3_600_000;
        await assert.rejects(executeFundingChoice(f.donors[0],selected));assert.equal((await query("SELECT id FROM fp_funding_assignments WHERE project_id=$1",[f.organizer.projectId])).length,0);
      }finally{Date.now=now;}
    }
  });
  it("keeps fixed case deadlines and prepares only original-route defaults for silence or an expired unexecuted decision",async()=>{
    const f=await fixture("sample"),target=await policy(f,"printing","rollover"),saved=await openCase(f),selected=await choice(f,0,saved,target,"rollover");
    const immutable=await query("SELECT id,digest,deadline,encrypted_data FROM fp_funding_cases WHERE id=$1",[saved.id]);
    const review=await cancellationCaseReview(f.organizer,"electronics");await assert.rejects(openCancellationCase(f.organizer,{intentId:randomUUID(),packageId:"electronics",expectedVersion:1,reviewDigest:review.digest,reason:"A repeated unchanged snapshot cannot renew this fixed deadline.",deadline:new Date(Date.now()+2*3_600_000).toISOString(),replaceCaseId:saved.id,acknowledged:true}),{code:"CASE_SNAPSHOT_UNCHANGED"});
    const now=Date.now;try{Date.now=()=>now()+2*3_600_000;
      await assert.rejects(executeFundingChoice(f.donors[0],selected),{code:"CHOICE_AUTHORITY_CHANGED"});const defaults=await applyCancellationDefaults(f.organizer,saved.id);assert.equal(defaults.ids.length,2);
      const rows=await query<{id:string;kind:string;authority:string;digest:string;version:number;expires_at:Date}>("SELECT * FROM fp_funding_choices WHERE authority='case_default' AND project_id=$1 ORDER BY id",[f.organizer.projectId]);assert.ok(rows.every(row=>row.kind==='return'));assert.equal((await query("SELECT id FROM fp_funding_assignments WHERE project_id=$1",[f.organizer.projectId])).length,0);
      assert.deepEqual((await applyCancellationDefaults(f.organizer,saved.id)).ids.sort(),defaults.ids.sort());assert.deepEqual(await query("SELECT id,digest,deadline,encrypted_data FROM fp_funding_cases WHERE id=$1",[saved.id]),immutable);
      for(const row of rows)await executeFundingChoice(f.organizer,{intentId:randomUUID(),choiceId:row.id,digest:row.digest,expectedVersion:row.version});
    }finally{Date.now=now;}
    assert.equal((await fundingDesk(f.organizer)).cases.find(row=>row.id===saved.id)?.state,"resolved");assert.equal((await readFundingProjection(f.scope,database())).totals.collectedMinor,0);
  });
  it("retains ambiguous or refused original-route returns as unresolved and never grants an Auditor a dispatch path",async()=>{
    for(const mode of ["unknown","refused"] as const){
      const f=await fixture();await moveAll(f);const saved=await openCase(f,"printing"),selected=await choice(f,0,saved,null),transport=returns(f.receipts[0],mode);await executeFundingChoice(f.donors[0],selected,transport.deps);
      const [refund]=await query<{id:string;operation_id:string}>("SELECT id,operation_id FROM fp_refunds WHERE project_id=$1",[f.organizer.projectId]);const originalCommand=await query("SELECT command FROM fp_payment_commands WHERE operation_id=$1",[refund.operation_id]);const projection=await readFundingProjection(f.scope,database());assert.equal(projection.positions.find(row=>row.receiptId===f.receipts[0].id&&row.packageId==='printing')?.pendingRefundMinor,5000);
      await query("UPDATE fp_sessions SET role='auditor' WHERE id=$1",[f.organizer.id]);const auditor={...f.organizer,role:"auditor" as const};await assert.rejects(checkRefund(auditor,refund.id,false,transport.deps),{code:"ROLE_DENIED"});assert.equal((await fundingDesk(auditor)).cases.find(row=>row.id===saved.id)?.sources.every(source=>!source.choice?.canExecute),true);
      if(mode==='unknown'){await assert.rejects(checkRefund(f.donors[0],refund.id,true,transport.deps));transport.complete();await checkRefund(f.donors[0],refund.id,false,transport.deps);assert.equal(transport.calls.length,1);}else{transport.allow();await checkRefund(f.donors[0],refund.id,true,transport.deps);assert.equal(transport.calls.length,2);assert.equal(transport.calls[0].operationId,transport.calls[1].operationId);assert.equal(transport.calls[0].providerRequestId,transport.calls[1].providerRequestId);}
      assert.deepEqual(await query("SELECT command FROM fp_payment_commands WHERE operation_id=$1",[refund.operation_id]),originalCommand);assert.equal((await readFundingProjection(f.scope,database())).positions.find(row=>row.receiptId===f.receipts[0].id&&row.packageId==='printing')?.refundedMinor,5000);
    }
  });
  it("holds an externally returned source at its current purpose without pretending that another capture can return its share",async()=>{
    const f=await fixture();await moveAll(f);const saved=await openCase(f,"printing"),selected=await choice(f,0,saved,null),transport=returns(f.receipts[0]);transport.external(1000);
    const prior=await query<{id:string;data:SettlementReceipt}>("SELECT id,data FROM fp_settlement_receipts WHERE project_id=$1 ORDER BY id",[f.organizer.projectId]);await assert.rejects(executeFundingChoice(f.donors[0],selected,transport.deps),{code:"EXTERNAL_RETURN_REVIEW"});assert.equal(transport.calls.length,0);assert.equal((await query("SELECT id FROM fp_refunds WHERE project_id=$1",[f.organizer.projectId])).length,0);
    const projection=await readFundingProjection(f.scope,database()),position=projection.positions.find(row=>row.receiptId===f.receipts[0].id&&row.packageId==='printing')!;assert.equal(position.availableMinor,0);assert.equal(position.excludedMinor,5000);assert.equal(position.refundedMinor,0);assert.equal(position.receiptVersion,2);assert.equal(projection.availableMinor,5000);
    const afterRows=await query<{id:string;data:SettlementReceipt}>("SELECT id,data FROM fp_settlement_receipts WHERE project_id=$1 ORDER BY id",[f.organizer.projectId]);assert.deepEqual(afterRows.find(row=>row.id===f.receipts[1].id),prior.find(row=>row.id===f.receipts[1].id));assert.equal(afterRows.find(row=>row.id===f.receipts[0].id)?.data.packageId,"electronics");
    const desk=await fundingDesk(f.organizer);assert.equal(desk.cases.find(row=>row.id===saved.id)?.state,"review_required");assert.ok(desk.cases.find(row=>row.id===saved.id)?.history.some(event=>event.kind==='external_return_review'));assert.equal((await query("SELECT receipt_id FROM fp_funding_deductions WHERE receipt_id=$1",[f.receipts[0].id])).length,1);
  });

});

describe("evidence-backed allocation and original-return recovery",()=>{
  it("requires every affected donor's explicit agreement, preserves the original case and applies exact source shares",async()=>{
    const f=await fixture("sample");await samplePaidUse(f);const saved=await openCase(f),beforeReceipts=await query("SELECT id,version,data FROM fp_settlement_receipts ORDER BY id"),beforeUses=await query("SELECT * FROM fp_receipt_allocations ORDER BY id"),[old]=await query("SELECT digest,encrypted_data,deadline FROM fp_funding_cases WHERE id=$1",[saved.id]);
    const proposed=await adjustment(f,saved);await assert.rejects(applyAllocationAdjustment(f.organizer,proposed),{code:"ADJUSTMENT_CONSENT_REQUIRED"});
    const ownReview=await caseRecoveryReview(f.donors[0],saved.id);assert.equal(ownReview.sources.length,1);assert.equal(ownReview.adjustments[0].shares.length,1);assert.ok(!JSON.stringify(ownReview).includes(f.donors[1].actorId));
    await respondAllocationAdjustment(f.donors[0],{...proposed,intentId:randomUUID(),decision:"accept"});await respondAllocationAdjustment(f.donors[1],{...proposed,intentId:randomUUID(),decision:"decline"});await assert.rejects(applyAllocationAdjustment(f.organizer,proposed),{code:"ADJUSTMENT_CONSENT_REQUIRED"});
    await revokeAdjustmentResponse(f.donors[1],{...proposed,intentId:randomUUID()});await respondAllocationAdjustment(f.donors[1],{...proposed,intentId:randomUUID(),decision:"accept"});
    const result=await applyAllocationAdjustment(f.organizer,proposed);assert.deepEqual(await applyAllocationAdjustment(f.organizer,proposed),result);const revised=(await fundingDesk(f.organizer)).cases.find(row=>row.id===result.id)!;
    assert.equal(revised.method,"source-capacity-consented-v1");assert.equal((await caseRecoveryReview(f.organizer,revised.id)).canRefreshCase,false);assert.equal(revised.deadline,saved.deadline);assert.equal(revised.totalMinor,9000);assert.equal(revised.revision,2);assert.equal(revised.sources.find(source=>source.receiptId===f.receipts[0].id)!.entitlementMinor,4000);assert.equal(revised.sources.find(source=>source.receiptId===f.receipts[1].id)!.entitlementMinor,5000);
    assert.deepEqual((await query("SELECT digest,encrypted_data,deadline FROM fp_funding_cases WHERE id=$1",[saved.id]))[0],old);assert.deepEqual(await query("SELECT id,version,data FROM fp_settlement_receipts ORDER BY id"),beforeReceipts);assert.deepEqual(await query("SELECT * FROM fp_receipt_allocations ORDER BY id"),beforeUses);
    await assert.rejects(revokeAdjustmentResponse(f.donors[0],{...proposed,intentId:randomUUID()}),{code:"ADJUSTMENT_ALREADY_APPLIED"});
    for(let index=0;index<2;index++)await executeFundingChoice(f.donors[index],await choice(f,index,revised,null));
    const projection=await database().transaction(tx=>readFundingProjection(f.scope,tx));assert.equal(projection.availableMinor,0);assert.equal(projection.totals.collectedMinor,1000);assert.equal(projection.paidMinor,1000);assert.equal((await fundingDesk(f.organizer)).cases.find(row=>row.id===revised.id)!.state,"resolved");assert.deepEqual(await query("SELECT * FROM fp_receipt_allocations ORDER BY id"),beforeUses);
  });
  it("uses an independently confirmed Payout and fee revision for an unequal paid-source adjustment and bounded original-rail returns",async()=>{
    const f=await fixture(),paid=await paidExpense(f),paidRows=await query("SELECT * FROM fp_receipt_allocations ORDER BY id"),revisions=await query("SELECT * FROM fp_allocation_revisions ORDER BY id"),commands=await query<{id:string;data:unknown}>("SELECT id,data FROM fp_approval_records ORDER BY id");
    const saved=await openCase(f);assert.equal(saved.totalMinor,8175);const review=await caseRecoveryReview(f.organizer,saved.id);assert.equal(review.canPropose,true,JSON.stringify(review.blockers));assert.equal(review.evidence.filter(row=>row.state==="paid").length,2);assert.ok(review.evidence.every(row=>row.verified));
    const proposed=await adjustment(f,saved);for(const donor of f.donors)await respondAllocationAdjustment(donor,{...proposed,intentId:randomUUID(),decision:"accept"});const result=await applyAllocationAdjustment(f.organizer,proposed),revised=(await fundingDesk(f.organizer)).cases.find(row=>row.id===result.id)!;
    assert.equal(revised.deadline,saved.deadline);for(let index=0;index<2;index++){const transport=returns(f.receipts[index]);await executeFundingChoice(f.donors[index],await choice(f,index,revised,null),transport.deps);assert.equal(transport.calls.length,1);}
    const projection=await database().transaction(tx=>readFundingProjection(f.scope,tx));assert.equal(projection.availableMinor,0);assert.equal(projection.paidMinor,1825);assert.equal(projection.totals.collectedMinor,1825);
    assert.deepEqual(await query("SELECT * FROM fp_receipt_allocations ORDER BY id"),paidRows);assert.deepEqual(await query("SELECT * FROM fp_allocation_revisions ORDER BY id"),revisions);assert.deepEqual(await query("SELECT id,data FROM fp_approval_records WHERE id=ANY($1::text[]) ORDER BY id",[commands.map(row=>row.id)]),commands);
    const [originalPayable]=await query<{state:string;actual_fee_minor:string}>("SELECT state,actual_fee_minor FROM fp_payables WHERE id=$1",[paid.id]);assert.equal(originalPayable.state,"succeeded");assert.equal(Number(originalPayable.actual_fee_minor),25);
  });
  it("holds missing expense evidence and rejects stale or revoked adjustment authority",async()=>{
    const f=await fixture("sample"),use=await samplePaidUse(f),saved=await openCase(f),proposed=await adjustment(f,saved);
    const outside=await fixture("sample");await assert.rejects(respondAllocationAdjustment(outside.donors[0],{...proposed,intentId:randomUUID(),decision:"accept"}),{code:"ADJUSTMENT_NOT_FOUND"});
    for(const donor of f.donors)await respondAllocationAdjustment(donor,{...proposed,intentId:randomUUID(),decision:"accept"});await query("UPDATE fp_memberships SET version=version+1 WHERE tenant_id=$1 AND actor_id=$2",[f.organizer.tenantId,f.donors[1].actorId]);await assert.rejects(applyAllocationAdjustment(f.organizer,proposed),{code:"ADJUSTMENT_CONSENT_CHANGED"});
    await query("UPDATE fp_receipt_allocations SET amount_minor=amount_minor+1 WHERE id=$1",[use]);const review=await caseRecoveryReview(f.organizer,saved.id);assert.ok(review.blockers.some(item=>item.code==="EXPENSE_EVIDENCE_REQUIRED"));assert.ok(review.blockers.some(item=>item.code==="FROZEN_BASIS_CHANGED"));await assert.rejects(applyAllocationAdjustment(f.organizer,{...proposed,intentId:randomUUID()}),{code:"ADJUSTMENT_REVIEW_CHANGED"});
    assert.equal((await query("SELECT id FROM fp_funding_cases WHERE project_id=$1",[f.organizer.projectId])).length,1);
  });
  it("serializes withdrawal against application without partly revised shares or manufactured consent",async()=>{
    const f=await fixture("sample");await samplePaidUse(f);const saved=await openCase(f),proposed=await adjustment(f,saved);for(const donor of f.donors)await respondAllocationAdjustment(donor,{...proposed,intentId:randomUUID(),decision:"accept"});
    const outcomes=await Promise.allSettled([revokeAdjustmentResponse(f.donors[0],{...proposed,intentId:randomUUID()}),applyAllocationAdjustment(f.organizer,proposed)]);assert.equal(outcomes.filter(result=>result.status==="fulfilled").length,1);
    const [row]=await query<{state:string;result_case_id:string|null}>("SELECT state,result_case_id FROM fp_funding_reconciliations WHERE id=$1",[proposed.adjustmentId]);if(row.state==="applied"){assert.ok(row.result_case_id);assert.equal((await query<{state:string}>("SELECT state FROM fp_funding_reconciliation_consents WHERE reconciliation_id=$1 AND actor_id=$2 ORDER BY version DESC",[proposed.adjustmentId,f.donors[0].actorId]))[0].state,"recorded");}else{assert.equal(row.state,"awaiting_donors");assert.equal(row.result_case_id,null);assert.equal((await query("SELECT id FROM fp_funding_cases")).length,1);}
  });
  it("records a proven outside return, releases only that hold, preserves the fixed deadline and bounds the remaining original refund",async()=>{
    const f=await fixture(),saved=await openCase(f),selected=await choice(f,0,saved,null),transport=returns(f.receipts[0]);transport.external(1000);const [otherBefore]=await query("SELECT * FROM fp_settlement_receipts WHERE id=$1",[f.receipts[1].id]),[caseBefore]=await query("SELECT digest,encrypted_data,deadline FROM fp_funding_cases WHERE id=$1",[saved.id]);
    await assert.rejects(executeFundingChoice(f.donors[0],selected,transport.deps),{code:"EXTERNAL_RETURN_REVIEW"});const review=await observedReturn(f,0,transport);assert.equal(review.canReconcile,true,JSON.stringify(review.blockers));assert.equal(review.attributableMinor,1000);assert.equal(review.releasableMinor,4000);assert.equal(review.heldMinor,5000);
    const input=reconcileInput(review),result=await reconcileOriginalReturns(f.organizer,input);assert.deepEqual(await reconcileOriginalReturns(f.organizer,input),result);assert.equal(transport.calls.length,0);
    const source=(await query<{version:number;data:SettlementReceipt}>("SELECT version,data FROM fp_settlement_receipts WHERE id=$1",[f.receipts[0].id]))[0];assert.equal(source.version,3);assert.equal(source.data.completedAttributedRefundMinor,1000);assert.equal(source.data.excludedMinor,0);assert.equal(source.data.packageId,"electronics");assert.equal(source.data.actualProviderPaymentRef,f.receipts[0].actualProviderPaymentRef);
    assert.deepEqual((await query("SELECT * FROM fp_settlement_receipts WHERE id=$1",[f.receipts[1].id]))[0],otherBefore);assert.deepEqual((await query("SELECT digest,encrypted_data,deadline FROM fp_funding_cases WHERE id=$1",[saved.id]))[0],caseBefore);assert.equal((await query("SELECT id FROM fp_refunds")).length,0);assert.equal((await query("SELECT id FROM fp_approval_records")).length,0);assert.equal((await query("SELECT operation_id FROM fp_payment_commands")).length,0);
    const [journal]=await query<{debits:string;credits:string}>("SELECT sum(amount_minor) FILTER(WHERE side='debit') debits,sum(amount_minor) FILTER(WHERE side='credit') credits FROM fp_journal WHERE entry_kind='external_refund_reconciliation'");assert.equal(Number(journal.debits),1000);assert.equal(journal.debits,journal.credits);
    const revised=(await fundingDesk(f.organizer)).cases.find(row=>row.state!=="superseded")!;assert.equal(revised.deadline,saved.deadline);assert.equal(revised.totalMinor,9000);assert.equal(revised.sources.find(source=>source.receiptId===f.receipts[0].id)!.entitlementMinor,4000);const trail=await fundingReceiptTrail(f.donors[0],f.receipts[0].id);assert.equal(trail.returns[0].reconciledOutside,true);
    await executeFundingChoice(f.donors[0],await choice(f,0,revised,null),transport.deps);assert.equal(transport.calls.length,1);assert.equal(transport.calls[0].action.kind,"refund_capture");assert.equal(transport.calls[0].action.money.minor,4000);assert.equal((await query<{data:SettlementReceipt}>("SELECT data FROM fp_settlement_receipts WHERE id=$1",[f.receipts[0].id]))[0].data.completedAttributedRefundMinor,5000);
  });
  it("never releases a pre-existing exclusion when attributing an outside return",async()=>{
    const f=await fixture();await query("UPDATE fp_settlement_receipts SET data=jsonb_set(data,'{excludedMinor}','100'::jsonb) WHERE id=$1",[f.receipts[0].id]);const saved=await openCase(f),transport=returns(f.receipts[0]);transport.external(1000);const review=await observedReturn(f,0,transport);assert.equal(review.heldMinor,4900);assert.equal(review.canReconcile,true,JSON.stringify(review.blockers));await reconcileOriginalReturns(f.organizer,reconcileInput(review));
    const position=(await database().transaction(tx=>readFundingProjection(f.scope,tx))).positions.find(row=>row.receiptId===f.receipts[0].id)!;assert.equal(position.refundedMinor,1000);assert.equal(position.excludedMinor,100);assert.equal(position.availableMinor,3900);const current=(await fundingDesk(f.organizer)).cases.find(row=>row.state!=="superseded")!;assert.equal(current.state,"review_required");assert.equal(current.deadline,saved.deadline);
  });
  it("keeps transferred-purpose attribution unproven and provides the evidence-specific inspect flow",async()=>{
    const f=await fixture();await moveAll(f);const saved=await openCase(f,"printing"),selected=await choice(f,0,saved,null),transport=returns(f.receipts[0]);transport.external(500);await assert.rejects(executeFundingChoice(f.donors[0],selected,transport.deps),{code:"EXTERNAL_RETURN_REVIEW"});
    const review=await observedReturn(f,0,transport);assert.equal(review.canReconcile,false);assert.ok(review.blockers.some(item=>item.code==="TRANSFERRED_RETURN_PURPOSE_UNPROVEN"));assert.equal(review.observation?.historyComplete,true);const before=await query("SELECT id,version,data FROM fp_settlement_receipts ORDER BY id");await assert.rejects(reconcileOriginalReturns(f.organizer,reconcileInput(review)),{code:"RETURN_ATTRIBUTION_UNPROVEN"});assert.deepEqual(await query("SELECT id,version,data FROM fp_settlement_receipts ORDER BY id"),before);assert.equal((await query("SELECT id FROM fp_funding_external_returns")).length,0);assert.equal(transport.calls.length,0);
    const own=await caseRecoveryReview(f.donors[0],saved.id);assert.equal(own.sources.length,1);assert.ok(own.blockers.some(item=>item.code==="existing_exclusion"));assert.equal(own.canRefreshCase,false);
  });
  it("keeps pending outside returns held and releases a failed return only after complete exact-reference evidence",async()=>{
    const f=await fixture(),saved=await openCase(f),transport=returns(f.receipts[0]);transport.external(500);transport.externalStatus("PENDING");let review=await observedReturn(f,0,transport);assert.equal(review.canReconcile,false);assert.ok(review.blockers.some(item=>item.code==="OUTSIDE_RETURN_UNRESOLVED"));
    transport.externalStatus("FAILED");review=await observedReturn(f,0,transport);assert.equal(review.canReconcile,true,JSON.stringify(review.blockers));assert.equal(review.attributableMinor,0);assert.equal(review.releasableMinor,5000);await reconcileOriginalReturns(f.organizer,reconcileInput(review));assert.equal((await query("SELECT id FROM fp_funding_external_returns")).length,0);const [source]=await query<{data:SettlementReceipt}>("SELECT data FROM fp_settlement_receipts WHERE id=$1",[f.receipts[0].id]);assert.equal(source.data.excludedMinor,0);assert.equal(source.data.completedAttributedRefundMinor,0);assert.equal((await fundingDesk(f.organizer)).cases.find(row=>row.state!=="superseded")!.deadline,saved.deadline);assert.equal(transport.calls.length,0);
  });
  it("proves a full invoice original-route return through its exact independent reference without inventing partial history",async()=>{
    const f=await fixture(),saved=await openCase(f),receipt=f.receipts[1],transport=returns(receipt);transport.external(5000);assert.equal(receipt.sourceOrderId,null);let review=await observedReturn(f,1,transport);assert.equal(review.canReconcile,false);assert.ok(review.blockers.some(item=>item.code==="RETURN_HISTORY_INCOMPLETE"));
    await observeOriginalReturns(f.organizer,{intentId:randomUUID(),receiptId:receipt.id,expectedVersion:review.receiptVersion,references:["FIXEXTERNAL"],acknowledged:true},transport.deps.provider);review=await returnRecoveryReview(f.organizer,receipt.id);assert.equal(review.canReconcile,true,JSON.stringify(review.blockers));assert.equal(review.attributableMinor,5000);await reconcileOriginalReturns(f.organizer,reconcileInput(review));assert.equal((await fundingDesk(f.organizer)).cases.find(row=>row.state!=="superseded")!.deadline,saved.deadline);assert.equal((await fundingReceiptTrail(f.donors[1],receipt.id)).returnedMinor,5000);assert.equal(transport.calls.length,0);
  });
  it("denies cross-workspace and Auditor recovery writes, rejects stale observations, and protects immutable evidence",async()=>{
    const f=await fixture(),saved=await openCase(f),transport=returns(f.receipts[0]);transport.external(500);const review=await observedReturn(f,0,transport),outside=await fixture();await assert.rejects(returnRecoveryReview(outside.organizer,review.receiptId),{code:"FUNDING_RECEIPT_NOT_FOUND"});await assert.rejects(returnRecoveryReview(f.donors[1],review.receiptId),{code:"FUNDING_RECEIPT_NOT_FOUND"});
    await query("UPDATE fp_sessions SET role='auditor' WHERE id=$1",[f.organizer.id]);const auditor={...f.organizer,role:"auditor" as const},readCount=transport.reads.length;assert.equal((await returnRecoveryReview(auditor,review.receiptId)).canObserve,false);await assert.rejects(observeOriginalReturns(auditor,{intentId:randomUUID(),receiptId:review.receiptId,expectedVersion:review.receiptVersion,references:[],acknowledged:true},transport.deps.provider),{code:"ROLE_DENIED"});await assert.rejects(reconcileOriginalReturns(auditor,reconcileInput(review)),{code:"ROLE_DENIED"});assert.equal(transport.reads.length,readCount);await query("UPDATE fp_sessions SET role='organizer' WHERE id=$1",[f.organizer.id]);
    const now=Date.now;Date.now=()=>now()+6*60_000;try{const stale=await returnRecoveryReview(f.organizer,review.receiptId);assert.ok(stale.blockers.some(item=>item.code==="RETURN_OBSERVATION_STALE"));await assert.rejects(reconcileOriginalReturns(f.organizer,reconcileInput(stale)),{code:"RETURN_ATTRIBUTION_UNPROVEN"});}finally{Date.now=now;}
    await assert.rejects(query("UPDATE fp_funding_return_observations SET encrypted_data='changed' WHERE id=$1",[review.observation!.id]),/immutable|retained|append-only/i);await assert.rejects(query("DELETE FROM fp_funding_return_holds WHERE receipt_id=$1",[review.receiptId]),/immutable|retained|append-only/i);assert.equal((await query("SELECT id FROM fp_funding_cases WHERE project_id=$1",[f.organizer.projectId])).length,1);assert.equal((await fundingDesk(f.organizer)).cases.find(row=>row.id===saved.id)!.state,"review_required");
  });
});
