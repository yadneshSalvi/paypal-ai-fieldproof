import {describe,it} from "node:test";
import assert from "node:assert/strict";
import {HERO_OBLIGATION_AMOUNTS,RECOVERY_WINDOW_MS,type SettlementReceipt} from "../lib/contracts";
import {assertAllocationWithinReceipt,assertBalanced,assertMinor,assertRecoveryAllowed,freezeRound,fundingTotals,providerDecimal,splitSettlement,validateReceipt} from "../lib/domain/money";

function receipt(index:number,amount:number,invoice=false):SettlementReceipt{return {id:`r${index}`,tenantId:"tenant",projectId:"project",packageId:"electronics",donorObligationId:`o${index}`,sourceKind:invoice?"invoice_payment":"orders_capture",provenance:"live_sandbox",actualProviderPaymentRef:`payment-${index}`,economicAliases:[`payment:${index}`],sourceOrderId:invoice?null:`order-${index}`,sourceInvoiceId:invoice?`invoice-${index}`:null,authoritativeObservedState:"COMPLETED",observedAt:"2026-11-11T10:00:00Z",currency:"USD",grossSettledMinor:amount,creditedMinor:amount,completedAttributedRefundMinor:0,pendingAttributedRefundReserveMinor:0,excludedMinor:0,excessLiabilityMinor:0,provenRefundableRef:invoice?null:`capture-${index}`,refundAdapter:invoice?"unqualified":"capture_refund"};}
describe("canonical all-rail settlement",()=>{
  it("keeps the exact eight-obligation $960 hero",()=>assert.equal(HERO_OBLIGATION_AMOUNTS.reduce((s,v)=>s+v,0),96000));
  it("seven captures credit $925 and leave $35 short",()=>{const totals=fundingTotals(HERO_OBLIGATION_AMOUNTS.slice(0,7).map((v,i)=>receipt(i,v)),96000,"live_sandbox");assert.equal(totals.collectedMinor,92500);assert.equal(totals.shortfallMinor,3500);});
  it("joins the actual invoice payment to make $960",()=>{const receipts=HERO_OBLIGATION_AMOUNTS.map((v,i)=>receipt(i,v,i===7));const totals=fundingTotals(receipts,96000,"live_sandbox");assert.equal(totals.collectedMinor,96000);assert.equal(totals.fundingEligibleMinor,96000);assert.equal(totals.shortfallMinor,0);});
  it("excludes Sample receipts from live totals",()=>{const sample={...receipt(1,96000),provenance:"sample" as const};assert.equal(fundingTotals([sample],96000,"live_sandbox").collectedMinor,0);});
  it("rejects a duplicate economic payment even across rails",()=>{const first=receipt(1,3500),second={...receipt(2,3500,true),economicAliases:first.economicAliases};assert.throws(()=>fundingTotals([first,second],96000,"live_sandbox"),/same economic payment/);});
  it("does not turn invoice status without identity into money",()=>assert.throws(()=>validateReceipt({...receipt(1,3500,true),actualProviderPaymentRef:""}),/payment identity/));
  it("does not credit an unreadable or pending payment",()=>assert.throws(()=>validateReceipt({...receipt(1,3500),authoritativeObservedState:"UNKNOWN"}),/unconfirmed payment/));
  it("keeps pending refund reservations out of spendable funds",()=>{const r={...receipt(1,96000),completedAttributedRefundMinor:5000,pendingAttributedRefundReserveMinor:10000,excludedMinor:2000};const totals=fundingTotals([r],96000,"live_sandbox");assert.equal(totals.collectedMinor,91000);assert.equal(totals.fundingEligibleMinor,79000);assert.equal(totals.pendingRefundMinor,10000);});
  it("reserves excess settlement separately from the legitimate credit",()=>{const split=splitSettlement(3500,3500,3500);assert.deepEqual(split,{creditedMinor:0,excessLiabilityMinor:3500});const r={...receipt(2,3500),...split};assert.equal(fundingTotals([receipt(1,3500),r],3500,"live_sandbox").collectedMinor,3500);});
  it("bounds a partial credit and records the excess liability",()=>assert.deepEqual(splitSettlement(4000,3500,1000),{creditedMinor:2500,excessLiabilityMinor:1500}));
  it("rejects overlapping refunds and exclusions",()=>assert.throws(()=>validateReceipt({...receipt(1,3500),completedAttributedRefundMinor:2000,pendingAttributedRefundReserveMinor:1600}),/exceed credited/));
  it("requires invoice lineage for invoice receipts",()=>assert.throws(()=>validateReceipt({...receipt(1,3500,true),sourceInvoiceId:null}),/invoice lineage/));
});
describe("fixed recovery window and money invariants",()=>{
  const start=new Date("2026-11-11T10:00:00Z"),round=freezeRound({id:"round",packageId:"electronics",packageVersion:1,targetMinor:96000,policyHash:"policy"},start);
  it("freezes exactly 48 hours before dispatch",()=>assert.equal(Date.parse(round.recoveryEndsAt)-Date.parse(round.collectionStartedAt),RECOVERY_WINDOW_MS));
  it("blocks a recovery invoice while the original outcome is unknown",()=>assert.throws(()=>assertRecoveryAllowed("unknown_reconciling",round,start),/original payment outcome/));
  it("blocks simultaneous original and recovery channels",()=>assert.throws(()=>assertRecoveryAllowed("original_in_flight",round,start),/original payment outcome/));
  it("allows recovery only after a definitive decline within the existing clock",()=>assert.doesNotThrow(()=>assertRecoveryAllowed("definitively_declined",round,new Date(start.getTime()+47*60*60*1000))));
  it("does not grant a new 48-hour clock at expiry",()=>assert.throws(()=>assertRecoveryAllowed("definitively_declined",round,new Date(round.recoveryEndsAt)),/window has ended/));
  it("does not reopen an obligation after settlement",()=>assert.throws(()=>assertRecoveryAllowed("collected",round,start),/original payment outcome/));
  it("keeps decimal serialization exact",()=>{assert.equal(providerDecimal(1),"0.01");assert.equal(providerDecimal(8640),"86.40");assert.equal(providerDecimal(96000),"960.00");});
  it("rejects fractional, negative and unsafe cents",()=>{for(const value of [1.1,-1,Number.MAX_SAFE_INTEGER+1,NaN])assert.throws(()=>assertMinor(value));});
  it("requires balanced double-entry postings",()=>{assert.doesNotThrow(()=>assertBalanced([{side:"debit",amountMinor:4000},{side:"credit",amountMinor:2500},{side:"credit",amountMinor:1500}]));assert.throws(()=>assertBalanced([{side:"debit",amountMinor:100},{side:"credit",amountMinor:99}]),/balance/);});
  it("prevents allocation beyond a receipt's credit",()=>{assert.doesNotThrow(()=>assertAllocationWithinReceipt(8640,[5550,3090]));assert.throws(()=>assertAllocationWithinReceipt(8640,[5550,3091]),/exceed/);});
});
