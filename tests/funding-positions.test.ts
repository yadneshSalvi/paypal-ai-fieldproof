import {describe,it} from "node:test";
import assert from "node:assert/strict";
import {projectFundingPositions,packagePositionTotals,type FundingSource,type FundingAssignment} from "../lib/domain/funding-positions";
import {fundingTotals} from "../lib/domain/money";

const scope={tenantId:"tenant",projectId:"project",provenance:"sample" as const};
function source(id="receipt",amount=10000):FundingSource {
  return {version:1,receipt:{id,...scope,packageId:"original",donorObligationId:"obligation-"+id,
    sourceKind:"orders_capture",actualProviderPaymentRef:"capture-"+id,economicAliases:["capture:"+id],sourceOrderId:"order-"+id,sourceInvoiceId:null,
    authoritativeObservedState:"COMPLETED",observedAt:"2026-11-11T10:00:00Z",currency:"USD",grossSettledMinor:amount,creditedMinor:amount,
    completedAttributedRefundMinor:0,pendingAttributedRefundReserveMinor:0,excludedMinor:0,excessLiabilityMinor:0,provenRefundableRef:"capture-"+id,refundAdapter:"capture_refund"}};
}
function assignment(overrides:Partial<FundingAssignment>={}):FundingAssignment {
  return {id:"move-1",receiptId:"receipt",sequence:1,kind:"reallocation",reversesId:null,...scope,currency:"USD",amountMinor:4000,
    debit:{packageId:"original",packageVersion:2},credit:{packageId:"destination",packageVersion:3},
    consentId:"consent",consentDigest:"a".repeat(64),donorActorId:"donor",consentedAt:"2026-11-11T10:00:00Z",consentExpiresAt:"2026-11-12T10:00:00Z",committedAt:"2026-11-11T11:00:00Z",...overrides};
}
const project=(sources=[source()],assignments:FundingAssignment[]=[],extra:Partial<Parameters<typeof projectFundingPositions>[0]>={})=>projectFundingPositions({sources,assignments,deductions:[],uses:[],...extra},scope);

describe("canonical restricted funding positions",()=>{
  it("preserves legacy all-rail totals and original payment lineage",()=>{
    const a=source(),b=source("invoice",3500);b.receipt.sourceKind="invoice_payment";b.receipt.sourceInvoiceId="invoice";
    a.receipt.completedAttributedRefundMinor=1000;a.receipt.pendingAttributedRefundReserveMinor=500;a.receipt.excludedMinor=250;
    a.receipt.grossSettledMinor+=100;a.receipt.excessLiabilityMinor=100;
    const before=JSON.stringify([a,b]),result=project([b,a]);
    assert.deepEqual(result.totals,fundingTotals([a.receipt,b.receipt],0,"sample"));
    assert.deepEqual(packagePositionTotals(result.positions,"original",15000),fundingTotals([a.receipt,b.receipt],15000,"sample"));
    assert.equal(result.positions[0].donorObligationId,"obligation-invoice");assert.equal(JSON.stringify([a,b]),before);
  });
  it("moves a single source through paired entries without creating a new payment",()=>{
    const input=source(),entry=assignment(),before=JSON.stringify([input,entry]);const result=project([input],[entry]);
    assert.equal(result.positions.find(p=>p.packageId==="original")?.assignedMinor,6000);
    assert.equal(result.positions.find(p=>p.packageId==="destination")?.assignedMinor,4000);
    assert.equal(result.totals.collectedMinor,10000);assert.equal(result.availableMinor,10000);
    assert(result.positions.every(p=>p.receiptId==="receipt"&&p.originalPackageId==="original"));
    assert.equal(JSON.stringify([input,entry]),before);
  });
  it("conserves every cent across varied two-hop assignments and input ordering",()=>{
    for(let amount=1;amount<10000;amount+=83){const first=assignment({amountMinor:amount});const second=assignment({id:"move-2",sequence:2,amountMinor:Math.max(1,Math.floor(amount/2)),debit:first.credit,credit:{packageId:"third",packageVersion:1}});
      const result=project([source()],[second,first]);assert.equal(result.availableMinor,10000);assert.equal(result.positions.reduce((n,p)=>n+p.assignedMinor,0),10000);
      assert.deepEqual(result,project([source()],[first,second]));}
  });
  it("keeps original paid fees and reservations attached to their spending purpose",()=>{
    const result=project([source()],[assignment()],{uses:[{id:"expense",receiptId:"receipt",packageId:"original",state:"paid",amountMinor:2500},{id:"fee",receiptId:"receipt",packageId:"original",state:"reserved",amountMinor:500}]});
    assert.equal(result.paidMinor,2500);assert.equal(result.reservedMinor,500);assert.equal(result.availableMinor,7000);
    assert.equal(result.positions.find(p=>p.packageId==="original")?.availableMinor,3000);
    assert.throws(()=>project([source()],[assignment({amountMinor:9000})],{uses:[{id:"paid",receiptId:"receipt",packageId:"original",state:"paid",amountMinor:2500}]}),/reconciliation/);
  });
  it("requires explicit current attribution after any transfer and never hides an external refund",()=>{
    const a=source();a.receipt.completedAttributedRefundMinor=1000;
    assert.throws(()=>project([a],[assignment()]),/explicit attribution/);
    const deductions=[{receiptId:"receipt",receiptVersion:1,positions:[{packageId:"destination",refundedMinor:1000,pendingRefundMinor:0,excludedMinor:0}]}];
    const result=project([a],[assignment()],{deductions});assert.equal(result.totals.collectedMinor,9000);
    assert.equal(result.positions.find(p=>p.packageId==="destination")?.collectedMinor,3000);
    a.version=2;a.receipt.completedAttributedRefundMinor=2000;assert.throws(()=>project([a],[assignment()],{deductions}),/current receipt version/);
  });
  it("rejects missing, duplicate, inflated and overdrawn attribution",()=>{
    const a=source();a.receipt.completedAttributedRefundMinor=1000;
    const part={packageId:"destination",refundedMinor:1000,pendingRefundMinor:0,excludedMinor:0};
    for(const positions of [[],[part,part],[{...part,refundedMinor:2000}],[{...part,packageId:"unassigned"}]])
      assert.throws(()=>project([a],[assignment()],{deductions:[{receiptId:"receipt",receiptVersion:1,positions}]}));
  });
  it("records bounded opposite-side reversals without deleting history",()=>{
    const first=assignment(),reverse=assignment({id:"reverse",sequence:2,kind:"reversal",reversesId:first.id,debit:first.credit,credit:first.debit,amountMinor:1500});
    const result=project([source()],[reverse,first]);assert.equal(result.positions.find(p=>p.packageId==="original")?.assignedMinor,7500);
    assert.deepEqual(result.positions[0].assignmentIds,["move-1","reverse"]);
    assert.throws(()=>project([source()],[first,reverse,assignment({...reverse,id:"over-reverse",sequence:3,amountMinor:2501})]),/exceed their original/);
    assert.throws(()=>project([source()],[first,assignment({...reverse,reversesId:"missing"})]),/exact prior assignment/);
  });
  it("rejects incomplete journals and cannot spend a later credit early",()=>{
    assert.throws(()=>project([source()],[assignment({sequence:2})]),/journal/);
    assert.throws(()=>project([source()],[assignment(),assignment()]),/journal/);
    assert.throws(()=>project([source()],[assignment({debit:{packageId:"empty",packageVersion:1}})]),/exceeds/);
    assert.throws(()=>project([source()],[assignment({amountMinor:10001})]),/exceeds/);
  });
  it("rejects cross-workspace, mode, currency, aliases and unowned receipt references",()=>{
    for(const key of ["tenantId","projectId","provenance"] as const){const a=source();(a.receipt as unknown as Record<string,string>)[key]="other";assert.throws(()=>project([a]),/workspace/);}
    assert.throws(()=>project([source()],[assignment({currency:"EUR" as "USD"})]),/currency/);
    assert.throws(()=>project([source()],[assignment({receiptId:"other"})]),/outside/);
    const a=source(),b=source("another");b.receipt.economicAliases=a.receipt.economicAliases;assert.throws(()=>project([a,b]),/same economic/);
    a.receipt.economicAliases.push(a.receipt.economicAliases[0]);assert.throws(()=>project([a]),/same economic/);
  });
  it("validates recorded consent at commit time without expiring historical facts",()=>{
    assert.equal(project([source()],[assignment()]).totals.collectedMinor,10000);
    for(const entry of [assignment({committedAt:"2026-11-12T10:00:00Z"}),assignment({committedAt:"2026-11-11T09:59:59Z"}),assignment({consentedAt:"invalid"}),assignment({consentDigest:"broken"})])assert.throws(()=>project([source()],[entry]),/consent/);
  });
  it("rejects double-counted uses, bad versions and unsafe aggregate amounts",()=>{
    const use={id:"use",receiptId:"receipt",packageId:"original",state:"paid" as const,amountMinor:100};
    assert.throws(()=>project([source()],[],{uses:[use,use]}),/one saved state/);
    const a=source();a.version=0;assert.throws(()=>project([a]),/version/);
    assert.throws(()=>project([source("a",Number.MAX_SAFE_INTEGER),source("b",1)]),/whole number/);
  });
});
