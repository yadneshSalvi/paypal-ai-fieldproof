import assert from "node:assert/strict";
import { describe,it } from "node:test";
import { randomUUID } from "node:crypto";
import { canonicalJson,sha256 } from "@fracture/paypal-core";
import type { SettlementReceipt } from "../lib/contracts";
import type { FundingAssignment,FundingDeductions } from "../lib/domain/funding-positions";
import { database,query } from "../lib/server/db";
import { createProject } from "../lib/server/seed";
import { addActor,isolatedPlanningDatabase } from "./helpers/planning";
import { advanceTour,projectSnapshot } from "../lib/server/repository";
import { planningFunding } from "../lib/server/planning";
import { readStudioSnapshot } from "../lib/server/studio-datasets";
import { communitySource } from "../lib/server/community-source";
import { createProofDraft,readProofDesk } from "../lib/server/proof";
import { assignmentContext,deductionContext } from "../lib/server/funding-positions";
import { sealPrivate } from "../lib/server/private-values";

isolatedPlanningDatabase();
async function fixture(){
  const scope={tenantId:randomUUID(),projectId:randomUUID(),mode:"sample" as const};
  await database().transaction(tx=>createProject(tx,scope.tenantId,scope.projectId,`funding-consumer-${randomUUID()}`,scope.mode));
  const session=await addActor(scope,"organizer",["organizer","auditor"]);
  await advanceTour(session,1);await advanceTour(session,2);
  const receipts=await query<{id:string;version:number;data:SettlementReceipt}>("SELECT id,version,data FROM fp_settlement_receipts WHERE project_id=$1 ORDER BY id",[scope.projectId]);
  const orders=receipts.find(r=>r.data.packageId==="electronics"&&r.data.sourceKind==="orders_capture")!;
  const invoice=receipts.find(r=>r.data.sourceKind==="invoice_payment")!;
  for(const [source,amount] of [[orders,800],[invoice,200]] as const){
    const now=Date.now();
    const entry:FundingAssignment={id:randomUUID(),tenantId:scope.tenantId,projectId:scope.projectId,provenance:"sample",receiptId:source.id,sequence:1,kind:"reallocation",reversesId:null,currency:"USD",amountMinor:amount,
      debit:{packageId:"electronics",packageVersion:1},credit:{packageId:"printing",packageVersion:1},consentId:randomUUID(),consentDigest:sha256("Synthetic recorded consent for projection tests only"),donorActorId:session.actorId,
      consentedAt:new Date(now-1000).toISOString(),consentExpiresAt:new Date(now+600000).toISOString(),committedAt:new Date(now).toISOString()};
    await query(`INSERT INTO fp_funding_assignments(id,tenant_id,project_id,receipt_id,sequence,kind,amount_minor,debit_package_id,credit_package_id,consent_id,consent_digest,document_digest,encrypted_data,committed_at)
      VALUES($1,$2,$3,$4,1,'reallocation',$5,'electronics','printing',$6,$7,$8,$9,$10)`,[entry.id,scope.tenantId,scope.projectId,source.id,amount,entry.consentId,entry.consentDigest,sha256(canonicalJson(entry)),sealPrivate(entry,assignmentContext(entry,entry.id)),entry.committedAt]);
  }
  await query("INSERT INTO fp_receipt_allocations(id,tenant_id,project_id,receipt_id,claim_id,claim_line_id,package_id,amount_minor,state) VALUES($1,$2,$3,$4,$5,$6,'printing',500,'reserved')",[randomUUID(),scope.tenantId,scope.projectId,orders.id,randomUUID(),randomUUID()]);
  return {session,invoice,receipts};
}
async function views(f:Awaited<ReturnType<typeof fixture>>){
  const project=await projectSnapshot(f.session),studio=await readStudioSnapshot(f.session);
  const planning=await database().transaction(tx=>planningFunding(f.session,tx));
  const community=await database().transaction(tx=>communitySource(f.session,"treasurer",tx));
  const desk=await readProofDesk(f.session),pkg=desk.packages.find(p=>p.id==="printing")!;
  const proofId=await createProofDraft(f.session,{intentId:randomUUID(),packageId:"printing",expectedVersion:pkg.headVersion,derivativeIds:[]});
  const proof=(await readProofDesk(f.session)).snapshots.find(s=>s.id===proofId.id)!;
  return {project:project.packages.find(p=>p.id==="printing")!,studio:studio.data.packages.find(p=>p.id==="printing")!,
    planning:planning.find(p=>p.packageId==="printing")!,community:community.rows.find(r=>r.id==="package:printing")!,proof};
}
describe("restricted funding across application read models",()=>{
  it("uses the same destination amount in project, planning, Studio, community and proof while preserving original receipts",async()=>{
    const f=await fixture(),result=await views(f);
    assert.equal(result.project.collectedMinor,121000);
    assert.equal(result.studio.collectedMinor,121000);assert.equal(result.studio.allocationReservedMinor,500);assert.equal(result.studio.availableAllocationMinor,120500);
    assert.equal(result.planning.collectedMinor,121000);assert.equal(result.planning.eligibleMinor,120500);
    assert.equal(result.community.fields.collectedMinor,121000);
    assert.equal(result.proof.payload.funding.collectedMinor,121000);assert.equal(result.proof.payload.funding.ordersMinor,120800);assert.equal(result.proof.payload.funding.invoiceMinor,200);
    assert.equal(result.proof.payload.funding.paymentCount,3);
    assert.deepEqual(await query("SELECT id,version,data FROM fp_settlement_receipts WHERE project_id=$1 ORDER BY id",[f.session.projectId]),f.receipts);
  });
  it("holds every current view on a stale reassigned refund, then uses its exact refreshed attribution",async()=>{
    const f=await fixture();f.invoice.data.completedAttributedRefundMinor=100;
    await query("UPDATE fp_settlement_receipts SET data=$2::jsonb WHERE id=$1",[f.invoice.id,JSON.stringify(f.invoice.data)]);
    for(const read of [()=>projectSnapshot(f.session),()=>readStudioSnapshot(f.session),()=>database().transaction(tx=>planningFunding(f.session,tx)),()=>database().transaction(tx=>communitySource(f.session,"treasurer",tx))])
      await assert.rejects(read(),{code:"FUNDING_ATTRIBUTION_REQUIRED"});
    const d:FundingDeductions={receiptId:f.invoice.id,receiptVersion:2,positions:[{packageId:"electronics",refundedMinor:0,pendingRefundMinor:0,excludedMinor:0},{packageId:"printing",refundedMinor:100,pendingRefundMinor:0,excludedMinor:0}]};
    const scope={tenantId:f.session.tenantId,projectId:f.session.projectId,provenance:f.session.mode};
    await query("INSERT INTO fp_funding_deductions(receipt_id,receipt_version,tenant_id,project_id,document_digest,encrypted_data) VALUES($1,2,$2,$3,$4,$5)",[d.receiptId,scope.tenantId,scope.projectId,sha256(canonicalJson(d)),sealPrivate(d,deductionContext(scope,d.receiptId,2))]);
    const result=await views(f);
    assert.equal(result.project.collectedMinor,120900);assert.equal(result.studio.completedRefundMinor,100);
    assert.equal(result.planning.eligibleMinor,120400);assert.equal(result.community.fields.collectedMinor,120900);
    assert.equal(result.proof.payload.funding.invoiceMinor,100);assert.equal(result.proof.payload.funding.refundedMinor,100);
  });
  it("does not resurrect a cancelled package when retained historical credit exceeds its target",async()=>{
    const f=await fixture();
    await query("UPDATE fp_packages SET data=jsonb_set(data,'{fundingState}','\"cancelled\"'::jsonb) WHERE project_id=$1 AND id='printing'",[f.session.projectId]);
    const result=await views(f);
    assert.equal(result.project.fundingState,"cancelled");assert.equal(result.project.collectedMinor,121000);
    assert.equal(result.studio.fundingState,"cancelled");assert.equal(result.studio.availableAllocationMinor,0);
    assert.equal(result.planning.complete,false);assert.equal(result.planning.eligibleMinor,0);
    assert.equal(result.proof.payload.funding.collectedMinor,121000);
  });
});
