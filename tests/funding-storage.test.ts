import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256, PostgresDatabase } from "@fracture/paypal-core";
import type { FundingAssignment, FundingDeductions } from "../lib/domain/funding-positions";
import type { Session } from "../lib/server/auth";
import { database, initializeDatabase, query } from "../lib/server/db";
import { assignmentContext, deductionContext, readWorkspaceFunding } from "../lib/server/funding-positions";
import { sealPrivate } from "../lib/server/private-values";
import { sampleReceipt } from "../lib/server/seed";

const originalUrl=process.env.DATABASE_URL!,schema=`fp_funding_${randomUUID().replaceAll("-","")}`,admin=new PostgresDatabase(originalUrl);
before(async()=>{
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url=new URL(originalUrl); url.searchParams.set("options",`-c search_path=${schema}`); process.env.DATABASE_URL=url.href;
  await initializeDatabase();
});
after(async()=>{await database().close();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();process.env.DATABASE_URL=originalUrl;});
async function fixture() {
  const session:Session={id:randomUUID(),tenantId:randomUUID(),projectId:randomUUID(),actorId:randomUUID(),role:"organizer",mode:"sample",expiresAt:new Date(Date.now()+600000).toISOString()};
  await database().transaction(async tx=>{
    await tx.query("INSERT INTO fp_tenants(id,mode) VALUES($1,'sample')",[session.tenantId]);
    await tx.query("INSERT INTO fp_projects(id,tenant_id,slug,metadata) VALUES($1,$2,$1,'{}')",[session.projectId,session.tenantId]);
    for(const id of ["source","destination"]) await tx.query("INSERT INTO fp_packages(id,project_id,budget_minor,data) VALUES($1,$2,10000,'{}')",[id,session.projectId]);
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'organizer',$6)",[session.id,randomUUID(),session.tenantId,session.projectId,session.actorId,session.expiresAt]);
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,$4::jsonb)",[session.tenantId,session.projectId,session.actorId,JSON.stringify(["organizer","auditor","donor"])]);
  });
  const receipts=[];
  for (const [key,amount,invoice,purpose] of [["orders",10000,false,"conditional_pledge"],["invoice",3000,true,"conditional_pledge"],["separate",700,false,"sandbox_test"]] as const) {
    const obligationId=randomUUID();
    const receipt=sampleReceipt(session.tenantId,session.projectId,obligationId,"source",amount,key,invoice);
    await query("INSERT INTO fp_obligations(id,tenant_id,project_id,package_id,actor_id,amount_minor,channel,purpose,data) VALUES($1,$2,$3,'source',$4,$5,'collected',$6,'{}')",[obligationId,session.tenantId,session.projectId,session.actorId,amount,purpose]);
    await query("INSERT INTO fp_settlement_receipts(id,tenant_id,project_id,obligation_id,package_id,provider_ref,provenance,data) VALUES($1,$2,$3,$4,'source',$5,'sample',$6::jsonb)",[receipt.id,session.tenantId,session.projectId,obligationId,receipt.actualProviderPaymentRef,JSON.stringify(receipt)]);
    receipts.push(receipt);
  }
  return {session,scope:{tenantId:session.tenantId,projectId:session.projectId,provenance:session.mode},receipts};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function assignment(f:Fixture,amount=4000) {
  const now=Date.now();
  const value:FundingAssignment={id:randomUUID(),receiptId:f.receipts[0].id,sequence:1,kind:"reallocation",reversesId:null,...f.scope,currency:"USD",amountMinor:amount,
    debit:{packageId:"source",packageVersion:1},credit:{packageId:"destination",packageVersion:1},consentId:randomUUID(),consentDigest:sha256("controlled test consent; no transfer authority"),donorActorId:f.session.actorId,
    consentedAt:new Date(now-1000).toISOString(),consentExpiresAt:new Date(now+600000).toISOString(),committedAt:new Date(now).toISOString()};
  await query(`INSERT INTO fp_funding_assignments(id,tenant_id,project_id,receipt_id,sequence,kind,amount_minor,debit_package_id,credit_package_id,consent_id,consent_digest,document_digest,encrypted_data,committed_at)
    VALUES($1,$2,$3,$4,1,'reallocation',$5,'source','destination',$6,$7,$8,$9,$10)`,[value.id,f.session.tenantId,f.session.projectId,value.receiptId,amount,value.consentId,value.consentDigest,sha256(canonicalJson(value)),sealPrivate(value,assignmentContext(f.scope,value.id)),value.committedAt]);
  return value;
}
async function deductions(f:Fixture,version:number,source:number,destination:number) {
  const value:FundingDeductions={receiptId:f.receipts[0].id,receiptVersion:version,positions:[{packageId:"source",refundedMinor:source,pendingRefundMinor:0,excludedMinor:0},{packageId:"destination",refundedMinor:destination,pendingRefundMinor:0,excludedMinor:0}]};
  await query("INSERT INTO fp_funding_deductions(receipt_id,receipt_version,tenant_id,project_id,document_digest,encrypted_data) VALUES($1,$2,$3,$4,$5,$6)",[value.receiptId,version,f.session.tenantId,f.session.projectId,sha256(canonicalJson(value)),sealPrivate(value,deductionContext(f.scope,value.receiptId,version))]);
}
describe("canonical funding storage on isolated PostgreSQL",()=>{
  it("projects both payment rails while preserving separate checkout and original receipt identities",async()=>{
    const f=await fixture(),before=await query("SELECT id,version,data FROM fp_settlement_receipts WHERE project_id=$1 ORDER BY id",[f.session.projectId]);
    const initial=await readWorkspaceFunding(f.session); assert.equal(initial.availableMinor,13000); assert.equal(initial.positions.length,2);
    const entry=await assignment(f); const result=await readWorkspaceFunding(f.session);
    assert.equal(result.availableMinor,13000); assert.equal(result.positions.find(p=>p.packageId==="destination")?.availableMinor,4000);
    assert.equal(result.positions.find(p=>p.packageId==="destination")?.donorObligationId,f.receipts[0].donorObligationId);
    assert.deepEqual(await query("SELECT id,version,data FROM fp_settlement_receipts WHERE project_id=$1 ORDER BY id",[f.session.projectId]),before);
    const stored=await query<{encrypted_data:string}>("SELECT encrypted_data FROM fp_funding_assignments WHERE id=$1",[entry.id]);
    assert.ok(!stored[0].encrypted_data.includes(f.session.actorId));
  });
  it("advances source versions exactly once for changed content, and blocks stale refund attribution",async()=>{
    const f=await fixture(); await assignment(f); await deductions(f,1,0,0);
    const receipt=f.receipts[0]; receipt.completedAttributedRefundMinor=1000;
    await query("UPDATE fp_settlement_receipts SET data=$2::jsonb,version=999 WHERE id=$1",[receipt.id,JSON.stringify(receipt)]);
    assert.equal((await query<{version:number}>("SELECT version FROM fp_settlement_receipts WHERE id=$1",[receipt.id]))[0].version,2);
    await assert.rejects(readWorkspaceFunding(f.session),{code:"FUNDING_ATTRIBUTION_REQUIRED"});
    await deductions(f,2,600,400);
    const result=await readWorkspaceFunding(f.session); assert.equal(result.availableMinor,12000);
    assert.equal(result.positions.find(p=>p.packageId==="destination")?.availableMinor,3600);
    await query("UPDATE fp_settlement_receipts SET data=data,version=999 WHERE id=$1",[receipt.id]);
    assert.equal((await query<{version:number}>("SELECT version FROM fp_settlement_receipts WHERE id=$1",[receipt.id]))[0].version,2);
  });
  it("keeps actual paid expense and fee reservations at the package that incurred them",async()=>{
    const f=await fixture(); await assignment(f);
    for(const [state,amount] of [["paid",1200],["reserved",200]] as const) await query("INSERT INTO fp_receipt_allocations(id,tenant_id,project_id,receipt_id,claim_id,claim_line_id,package_id,amount_minor,state) VALUES($1,$2,$3,$4,$5,$6,'destination',$7,$8)",[randomUUID(),f.session.tenantId,f.session.projectId,f.receipts[0].id,randomUUID(),randomUUID(),amount,state]);
    const result=await readWorkspaceFunding(f.session); assert.equal(result.availableMinor,11600); assert.equal(result.paidMinor,1200); assert.equal(result.reservedMinor,200);
    assert.equal(result.positions.find(p=>p.packageId==="destination")?.availableMinor,2600);
  });
  it("denies revoked, expired, donor and foreign-workspace sessions",async()=>{
    const f=await fixture(),other=await fixture();
    await assert.rejects(readWorkspaceFunding({...f.session,projectId:other.session.projectId}),{code:"ROLE_DENIED"});
    await assert.rejects(readWorkspaceFunding({...f.session,role:"donor"}),{code:"ROLE_DENIED"});
    await query("UPDATE fp_memberships SET state='revoked' WHERE actor_id=$1",[f.session.actorId]);
    await assert.rejects(readWorkspaceFunding(f.session),{code:"MEMBERSHIP_DENIED"});
    await query("UPDATE fp_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",[other.session.id]);
    await assert.rejects(readWorkspaceFunding(other.session),{code:"ROLE_DENIED"});
  });
  it("does not allow updates or deletion to replace a consent or refund attribution",async()=>{
    const f=await fixture(),entry=await assignment(f); await deductions(f,1,0,0);
    for(const sql of ["UPDATE fp_funding_assignments SET amount_minor=1 WHERE id=$1","DELETE FROM fp_funding_assignments WHERE id=$1"])
      await assert.rejects(query(sql,[entry.id]),{code:"23514"});
    for(const sql of ["UPDATE fp_funding_deductions SET receipt_version=2 WHERE receipt_id=$1","DELETE FROM fp_funding_deductions WHERE receipt_id=$1"])
      await assert.rejects(query(sql,[entry.receiptId]),{code:"23514"});
    assert.equal((await readWorkspaceFunding(f.session)).availableMinor,13000);
  });
  it("fails closed on a corrupt saved payment identity",async()=>{
    const f=await fixture(),receipt=f.receipts[0]; receipt.packageId="destination";
    await query("UPDATE fp_settlement_receipts SET data=$2::jsonb WHERE id=$1",[receipt.id,JSON.stringify(receipt)]);
    await assert.rejects(readWorkspaceFunding(f.session),{code:"FUNDING_SAVED_IDENTITY"});
  });
  it("rejects a journal entry claiming another tenant's receipt even before projection",async()=>{
    const f=await fixture(),other=await fixture();
    await assert.rejects(assignment({...f,session:{...f.session,tenantId:other.session.tenantId}}),{code:"23514"});
    assert.equal((await readWorkspaceFunding(f.session)).availableMinor,13000);
    assert.equal((await readWorkspaceFunding(other.session)).availableMinor,13000);
  });
  it("does not hide a malformed legacy expense allocation under another workspace",async()=>{
    const f=await fixture(),other=await fixture();
    await query("INSERT INTO fp_receipt_allocations(id,tenant_id,project_id,receipt_id,claim_id,claim_line_id,package_id,amount_minor,state) VALUES($1,$2,$3,$4,$5,$6,'source',100,'reserved')",[randomUUID(),other.session.tenantId,other.session.projectId,f.receipts[0].id,randomUUID(),randomUUID()]);
    await assert.rejects(readWorkspaceFunding(f.session),{code:"FUNDING_SAVED_IDENTITY"});
  });
});
