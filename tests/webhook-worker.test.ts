import {after,before,describe,it} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import type {ProviderResource} from "@fracture/paypal-core";
import type {Session} from "../lib/server/auth";
import {database,initializeDatabase,query} from "../lib/server/db";
import {createProject} from "../lib/server/seed";
import {commandFor} from "../lib/server/payments";
import {receivePayPalWebhook,webhookInboxScope} from "../lib/server/webhooks";
import {enqueueVerifiedWebhooks,orderIdFromCapture,processVerifiedWebhooks} from "../lib/server/webhook-worker";

// Isolated inbox, local fixtures only; no provider API calls in this suite.
process.env.PAYPAL_CLIENT_ID=`worker-fixture-${randomUUID()}`;
const sessions:Session[]=[];
const verifier={verify:async()=>({verified:true,transmissionId:`fixture-${randomUUID()}`})};
const providerId=()=>randomUUID().replaceAll("-","").toUpperCase();
before(initializeDatabase);
after(async()=>{
 const scope=webhookInboxScope();
 for(const table of ["fp_webhook_jobs","paycore_webhook_deliveries","paycore_webhook_events"])await query(`DELETE FROM ${table} WHERE ${table==="fp_webhook_jobs"?"inbox_id":"tenant_id"}=$1`,[scope.tenantId]);
 for(const s of sessions){
  await query("DELETE FROM fp_economic_aliases WHERE receipt_id IN (SELECT id FROM fp_settlement_receipts WHERE tenant_id=$1)",[s.tenantId]);
  for(const table of ["fp_journal","fp_settlement_receipts","fp_provider_orders","fp_outbox","fp_events","fp_payment_commands","fp_approval_records","fp_obligations","fp_sessions"])await query(`DELETE FROM ${table} WHERE tenant_id=$1`,[s.tenantId]);
  await query("DELETE FROM fp_packages WHERE project_id=$1",[s.projectId]);await query("DELETE FROM fp_projects WHERE id=$1",[s.projectId]);await query("DELETE FROM fp_tenants WHERE id=$1",[s.tenantId]);
 }
 await database().close();
});
async function fixture(){
 const s:Session={id:randomUUID(),tenantId:randomUUID(),projectId:randomUUID(),actorId:randomUUID(),role:"donor",expiresAt:new Date(Date.now()+600000).toISOString(),mode:"live_sandbox"};sessions.push(s);
 await database().transaction(async tx=>{await createProject(tx,s.tenantId,s.projectId,`worker-${randomUUID()}`,"live_sandbox");await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'donor',$6)",[s.id,randomUUID(),s.tenantId,s.projectId,s.actorId,s.expiresAt]);});
 const command=await commandFor(s,randomUUID(),"create"),orderId=providerId(),captureId=providerId();
 await query("INSERT INTO fp_provider_orders(order_id,tenant_id,project_id,obligation_id,operation_id,observed_state) VALUES($1,$2,$3,$4,$5,'CREATED')",[orderId,s.tenantId,s.projectId,command.intentId,command.operationId]);
 const resource=(kind:"order"|"capture",id:string):ProviderResource=>({kind,id,status:"COMPLETED",money:kind==="capture"?{currency:"USD",minor:100}:null,parentId:null,customId:null,observedAt:new Date().toISOString(),source:"live_sandbox",links:kind==="capture"?[{rel:"up",method:"GET",href:`https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}`}]:[]});
 const order=resource("order",orderId),capture=resource("capture",captureId),reads:string[]=[];
 const provider={read:async(kind:ProviderResource["kind"],id:string)=>{reads.push(`${kind}:${id}`);if(kind==="order"&&id===orderId)return [order,capture];if(kind==="capture"&&id===captureId)return [capture];throw Error("Unowned fixture read");}};
 const event=async(type="PAYMENT.CAPTURE.COMPLETED")=>{const id=`FIXTURE-${randomUUID()}`;await receivePayPalWebhook(JSON.stringify({id,event_type:type,resource:{id:captureId,amount:{value:"9999.00",currency_code:"USD"},custom_id:"forged-other-tenant"}}),new Headers(),verifier);return id;};
 return {s,orderId,captureId,order,capture,provider,reads,event};
}
async function totals(tenantId:string){return query<{count:string;credited:string}>("SELECT count(*) count,COALESCE(sum((data->>'creditedMinor')::bigint),0) credited FROM fp_settlement_receipts WHERE tenant_id=$1",[tenantId]);}

describe("leased webhook processing with fixture provider reads",()=>{
 it("credits fresh owned amounts once under concurrent duplicate workers",async()=>{
  const f=await fixture();await f.event();await Promise.all(Array.from({length:5},()=>processVerifiedWebhooks({provider:f.provider})));
  assert.deepEqual(await totals(f.s.tenantId),[{count:"1",credited:"100"}]);assert.deepEqual(f.reads,[`capture:${f.captureId}`,`order:${f.orderId}`]);
  const [j]=await query<{count:string;balance:string}>("SELECT count(*) count,sum(CASE WHEN side='debit' THEN amount_minor ELSE -amount_minor END) balance FROM fp_journal WHERE tenant_id=$1",[f.s.tenantId]);assert.equal(j.count,"2");assert.equal(j.balance,"0");
 });
 it("reordered pending events use current completed state without regressing money",async()=>{
  const f=await fixture();await f.event();await processVerifiedWebhooks({provider:f.provider});await f.event("PAYMENT.CAPTURE.PENDING");await processVerifiedWebhooks({provider:f.provider});
  assert.deepEqual(await totals(f.s.tenantId),[{count:"1",credited:"100"}]);const [r]=await query<{channel:string}>("SELECT channel FROM fp_obligations WHERE tenant_id=$1",[f.s.tenantId]);assert.equal(r.channel,"collected");
 });
 it("reclaims an expired lease after projection without another credit",async()=>{
  const f=await fixture(),eventId=await f.event();await processVerifiedWebhooks({provider:f.provider});
  await query("UPDATE fp_webhook_jobs SET status='processing',lease_id='interrupted-worker',lease_until=now()-interval '1 minute' WHERE inbox_id=$1 AND event_id=$2",[webhookInboxScope().tenantId,eventId]);
  assert.equal((await processVerifiedWebhooks({provider:f.provider})).processed,1);assert.deepEqual(await totals(f.s.tenantId),[{count:"1",credited:"100"}]);
 });
 it("hostile up links cannot pick an owning tenant or add money",async()=>{
  const f=await fixture();f.capture.links=[{rel:"up",method:"GET",href:`https://attacker.invalid/v2/checkout/orders/${f.orderId}`}];await f.event();
  assert.equal((await processVerifiedWebhooks({provider:f.provider})).retry,1);assert.deepEqual(await totals(f.s.tenantId),[{count:"0",credited:"0"}]);assert.equal(f.reads.length,1);
  assert.equal(orderIdFromCapture({...f.capture,links:[{rel:"up",method:"GET",href:`https://api-m.sandbox.paypal.com/v2/checkout/orders/${f.orderId}?token=private`}]}),null);
 });
 it("unavailable reads retry without trusting alleged success",async()=>{
  const f=await fixture();await f.event();assert.equal((await processVerifiedWebhooks({provider:{read:async()=>{throw Error("fixture unavailable");}}})).retry,1);assert.deepEqual(await totals(f.s.tenantId),[{count:"0",credited:"0"}]);
 });
 it("mismatched independent capture and owning-order reads create no receipt",async()=>{
  const f=await fixture();await f.event();assert.equal((await processVerifiedWebhooks({provider:{read:async kind=>kind==="capture"?[f.capture]:[f.order,{...f.capture,id:providerId()}]}})).retry,1);assert.deepEqual(await totals(f.s.tenantId),[{count:"0",credited:"0"}]);
 });
 it("unsupported states need review and rejected signatures never become jobs",async()=>{
  const f=await fixture();await f.event("PAYMENT.AUTHORIZATION.CREATED");assert.equal((await processVerifiedWebhooks({provider:f.provider})).review,1);assert.equal(f.reads.length,0);
  const id=`FIXTURE-${randomUUID()}`;await assert.rejects(()=>receivePayPalWebhook(JSON.stringify({id,event_type:"PAYMENT.CAPTURE.COMPLETED",resource:{id:f.captureId}}),new Headers(),{verify:async()=>({verified:false,transmissionId:"invalid"})}));
  await enqueueVerifiedWebhooks();assert.equal((await query("SELECT event_id FROM fp_webhook_jobs WHERE event_id=$1",[id])).length,0);
 });
});
