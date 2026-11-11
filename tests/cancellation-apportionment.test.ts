import {describe,it} from "node:test";
import assert from "node:assert/strict";
import {apportionMinorUnits,planProRataCancellation} from "../lib/domain/cancellation-apportionment";
import type {CancellationSource} from "../lib/domain/cancellation-position";
const scope={tenantId:"t",projectId:"p",packageId:"room",provenance:"sample" as const};
function source(id:string,amount=12000):CancellationSource {return {version:1,paidMinor:0,reservedMinor:0,receipt:{...scope,id,donorObligationId:`obligation:${id}`,sourceKind:"orders_capture",actualProviderPaymentRef:`capture:${id}`,economicAliases:[`capture:${id}`],sourceOrderId:`order:${id}`,sourceInvoiceId:null,authoritativeObservedState:"COMPLETED",observedAt:"2026-11-11T10:00:00Z",currency:"USD",grossSettledMinor:amount,creditedMinor:amount,completedAttributedRefundMinor:0,pendingAttributedRefundReserveMinor:0,excludedMinor:0,excessLiabilityMinor:0,provenRefundableRef:`capture:${id}`,refundAdapter:"capture_refund"}};}
describe("exact cancellation apportionment",()=>{
 it("conserves indivisible cents with deterministic code-point ties",()=>{
  const rows=[{id:"c",weightMinor:100},{id:"a",weightMinor:100},{id:"b",weightMinor:100}];
  assert.deepEqual(apportionMinorUnits(200,rows).rows.map(row=>[row.id,row.amountMinor]),[["a",67],["b",67],["c",66]]);
  assert.deepEqual(apportionMinorUnits(200,rows),apportionMinorUnits(200,[...rows].reverse()));
 });
 it("keeps products exact near the supported integer ceiling",()=>{
  const n=Number.MAX_SAFE_INTEGER;
  const result=apportionMinorUnits(n-1,[{id:"a",weightMinor:n-1},{id:"b",weightMinor:1}]);
  assert.deepEqual(result.rows.map(row=>row.amountMinor),[n-2,1]);
 });
 it("uses Unicode code points, rather than host locale or UTF-16 surrogate order",()=>{
  const result=apportionMinorUnits(1,[{id:"\u{10000}",weightMinor:1},{id:"\uE000",weightMinor:1}]);
  assert.deepEqual(result.rows.map(row=>[row.id,row.amountMinor]),[["\uE000",1],["\u{10000}",0]]);
 });
 it("never awards a remainder cent to a zero-weight source",()=>{
  assert.deepEqual(apportionMinorUnits(1,[{id:"a",weightMinor:0},{id:"b",weightMinor:2},{id:"c",weightMinor:2}]).rows.map(row=>row.amountMinor),[0,1,0]);
  assert.equal(apportionMinorUnits(0,[]).denominatorMinor,0);
  assert.deepEqual(apportionMinorUnits(0,[{id:"zero",weightMinor:0}]).rows.map(row=>row.amountMinor),[0]);
 });
 it("rejects duplicate identities, invalid amounts, oversized denominators and over-distribution",()=>{
  assert.throws(()=>apportionMinorUnits(1,[{id:"a",weightMinor:1},{id:"a",weightMinor:1}]),/unique/);
  for(const invalid of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>apportionMinorUnits(invalid,[{id:"a",weightMinor:100}]));
  assert.throws(()=>apportionMinorUnits(1,[{id:"a",weightMinor:1.5}]));
  assert.throws(()=>apportionMinorUnits(2,[{id:"a",weightMinor:1}]),/more/);
  assert.throws(()=>apportionMinorUnits(0,[{id:"a",weightMinor:Number.MAX_SAFE_INTEGER},{id:"b",weightMinor:1}]),/total/);
 });
 it("conserves every cent across varied deterministic cohort sizes and totals",()=>{
  for(let count=1;count<=37;count++){
   const weights=Array.from({length:count},(_,i)=>({id:`receipt-${String(i).padStart(3,"0")}`,weightMinor:(i*37+count*11)%997}));
   const denominator=weights.reduce((n,row)=>n+row.weightMinor,0);
   for(const total of [0,1,Math.floor(denominator/3),denominator-1,denominator]){
    const result=apportionMinorUnits(total,weights);
    assert.equal(result.rows.reduce((n,row)=>n+row.amountMinor,0),total);
    for(const row of result.rows){assert(row.amountMinor<=row.weightMinor);const floor=Number(BigInt(total)*BigInt(row.weightMinor)/BigInt(denominator));assert(row.amountMinor===floor||row.amountMinor===floor+1);}
   }
  }
 });
 it("binds exact versions and both rails while leaving every source unchanged",()=>{
  const a=source("a"),b=source("b");b.version=4;b.receipt.sourceKind="invoice_payment";b.receipt.sourceInvoiceId="invoice";
  const before=structuredClone([a,b]),result=planProRataCancellation([b,a],scope);
  assert.equal(result.state,"ready_for_case_review");assert.equal(result.totalMinor,24000);assert.deepEqual(result.rows.map(r=>r.receiptVersion),[1,4]);assert.deepEqual([a,b],before);assert.equal(result.authorizesRefund,false);assert.equal(result.providerAllowanceObserved,false);
 });
 it("reports the partial-spend fairness conflict instead of reusing another donor's capture",()=>{
  const sources=Array.from({length:8},(_,i)=>source(`r${i}`));sources[0].paidMinor=6625;
  const result=planProRataCancellation(sources,scope);
  assert.equal(result.totalMinor,89375);assert.equal(result.denominatorMinor,96000);
  assert.deepEqual(result.rows.map(row=>row.amountMinor),[11172,11172,11172,11172,11172,11172,11172,11171]);
  assert.equal(result.rows[0].originalRouteCapacityMinor,5375);assert.equal(result.state,"review_required");
  assert.deepEqual(result.conflicts,[{receiptId:"r0",code:"source_capacity",amountMinor:5797}]);
 });
 it("holds pending returns and spending reservations without redistributing their obligations",()=>{
  const a=source("a"),b=source("b");a.receipt.pendingAttributedRefundReserveMinor=200;b.reservedMinor=300;
  const result=planProRataCancellation([a,b],scope);
  assert.equal(result.state,"review_required");assert.equal(result.totalMinor,23500);assert.equal(result.denominatorMinor,24000);
  assert(result.conflicts.some(c=>c.code==="pending_refund"&&c.amountMinor===200));assert(result.conflicts.some(c=>c.code==="reserved_spending"&&c.amountMinor===300));
 });
 it("subtracts completed returns from weights and preserves spending exclusions separately",()=>{
  const a=source("a",1000),b=source("b",1000);a.receipt.completedAttributedRefundMinor=1000;b.receipt.excludedMinor=1000;
  const result=planProRataCancellation([a,b],scope);
  assert.equal(result.denominatorMinor,1000);assert.deepEqual(result.rows.map(r=>r.amountMinor),[0,1000]);assert.equal(result.rows[1].excludedFromSpendingMinor,1000);assert.equal(result.state,"ready_for_case_review");
 });
 it("keeps an unqualified invoice route and alias/scope conflicts explicit",()=>{
  const a=source("a");a.receipt.sourceKind="invoice_payment";a.receipt.sourceInvoiceId="invoice";a.receipt.refundAdapter="unqualified";a.receipt.provenRefundableRef=null;
  const result=planProRataCancellation([a],scope);assert.equal(result.state,"review_required");assert.equal(result.conflicts[0].code,"route_unqualified");
  const b=source("b");b.receipt.economicAliases.push("capture:a");assert.throws(()=>planProRataCancellation([a,b],scope),/same payment/);
  b.receipt.economicAliases=["capture:b"];b.receipt.projectId="foreign";assert.throws(()=>planProRataCancellation([b],scope),/workspace/);
 });
 it("retains a fully returned or fully spent source without creating a new entitlement",()=>{
  const a=source("a");a.receipt.completedAttributedRefundMinor=12000;assert.equal(planProRataCancellation([a],scope).state,"no_uncommitted_funds");
  a.receipt.completedAttributedRefundMinor=0;a.paidMinor=12000;assert.equal(planProRataCancellation([a],scope).state,"no_uncommitted_funds");
 });
});
