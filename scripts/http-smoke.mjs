import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
const origin=process.env.FIELDPROOF_BASE_URL??"http://localhost:4102";
assert.ok(["http://localhost:4102","https://paypal-ai-fieldproof.vercel.app"].includes(origin));
let cookie="";
async function call(path,body,extra={}){
  const response=await fetch(origin+path,{method:body?"POST":"GET",headers:{...(body?{"Content-Type":"application/json",Origin:origin}:{}),...(cookie?{Cookie:cookie}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});
  const next=response.headers.get("set-cookie");if(next)cookie=next.split(";")[0];
  return {status:response.status,data:await response.json()};
}
assert.equal((await call("/api/health")).status,200);
assert.equal((await call("/api/session",{mode:"sample"},{Origin:"https://untrusted.example"})).status,403);
const opened=await call("/api/session",{mode:"sample"});assert.equal(opened.status,201);assert.equal(opened.data.mode,"sample");
assert.equal((await call("/api/checkout/create",{intentId:randomUUID()})).status,403);
for(const step of [1,2,3])assert.equal((await call("/api/tour",{step})).status,200);
const snapshot=(await call("/api/snapshot")).data;
assert.equal(snapshot.packages.find(p=>p.id==="electronics").collectedMinor,96000);
assert.equal(snapshot.receipts.filter(r=>r.packageId==="electronics"&&r.sourceKind==="invoice_payment").length,1);
const intentId=randomUUID(),pledge={intentId,packageId:"electronics",expectedVersion:1,amountMinor:5000};
const first=await call("/api/pledges",pledge),duplicate=await call("/api/pledges",pledge);assert.equal(first.status,201);assert.equal(duplicate.status,201);assert.equal(first.data.obligations.length,duplicate.data.obligations.length);
assert.equal((await call("/api/pledges",{...pledge,amountMinor:10000})).status,409);
assert.equal((await call("/api/session/role",{role:"auditor"})).status,200);
assert.equal((await call("/api/pledges",{...pledge,intentId:randomUUID()})).status,403);
console.log(JSON.stringify({checks:"HTTP session, origin, Sample/live separation, three tour stages, all-rail $960, pledge duplicate/conflict, Auditor denial",passed:true}));
if(process.argv.includes("--qualify-create")){
  const live=await call("/api/session",{mode:"live_sandbox"});assert.equal(live.status,201);assert.equal(live.data.receipts.length,0);
  const testIntent=randomUUID();
  const created=await call("/api/checkout/create",{intentId:testIntent});assert.equal(created.status,200);assert.equal(created.data.status,"succeeded");assert.ok(created.data.orderId);assert.equal(created.data.captureId,null);
  const duplicate=await call("/api/checkout/create",{intentId:testIntent});assert.equal(duplicate.data.operationId,created.data.operationId);assert.equal(duplicate.data.orderId,created.data.orderId);
  assert.equal((await call("/api/snapshot")).data.receipts.length,0);
  await call("/api/session/role",{role:"auditor"});
  assert.equal((await call("/api/checkout/capture",{intentId:testIntent,orderId:created.data.orderId})).status,403);
  console.log(JSON.stringify({checks:"Real isolated PayPal SDK order creation + duplicate identity + no settlement credit + Auditor capture denied",passed:true,orderSuffix:created.data.orderId.slice(-6),amountMinor:100,createdOnly:true}));
}
