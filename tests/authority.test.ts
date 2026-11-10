import {after,before,describe,it} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {PaymentCore,SqlPaymentStore,type ProviderAdapter} from "@fracture/paypal-core";
import type {Session} from "../lib/server/auth";
import {database,initializeDatabase,query} from "../lib/server/db";
import {createProject} from "../lib/server/seed";
import {authorizePayment,commandFor} from "../lib/server/payments";

const fixture:Session={id:randomUUID(),tenantId:randomUUID(),projectId:randomUUID(),actorId:randomUUID(),role:"donor",expiresAt:new Date(Date.now()+600000).toISOString(),mode:"live_sandbox"};
before(async()=>{
  await initializeDatabase();
  await database().transaction(async tx=>{
    await createProject(tx,fixture.tenantId,fixture.projectId,`test-${randomUUID()}`,"live_sandbox");
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'donor',$6)",[fixture.id,randomUUID(),fixture.tenantId,fixture.projectId,fixture.actorId,fixture.expiresAt]);
  });
});
after(async()=>{
  for(const table of ["fp_outbox","fp_events","fp_payment_commands","fp_approval_records","fp_obligations","fp_sessions"])await query(`DELETE FROM ${table} WHERE tenant_id=$1`,[fixture.tenantId]);
  await query("DELETE FROM fp_packages WHERE project_id=$1",[fixture.projectId]);
  await query("DELETE FROM fp_projects WHERE id=$1",[fixture.projectId]);
  await query("DELETE FROM fp_tenants WHERE id=$1",[fixture.tenantId]);
  await database().close();
});
describe("durable current payment authority",()=>{
  it("concurrent duplicate requests claim one immutable command",async()=>{
    const intent=randomUUID();
    const commands=await Promise.all(Array.from({length:6},()=>commandFor(fixture,intent,"create")));
    assert.equal(new Set(commands.map(c=>c.operationId)).size,1);
    assert.equal(new Set(commands.map(c=>c.providerRequestId)).size,1);
    assert.equal((await query("SELECT operation_id FROM fp_payment_commands WHERE tenant_id=$1 AND business_key=$2",[fixture.tenantId,`checkout:${intent}:create`])).length,1);
    assert.equal((await authorizePayment(commands[0])).allowed,true);
  });
  it("denies a forged tenant, amount, and request identity",async()=>{
    const command=await commandFor(fixture,randomUUID(),"create");
    assert.equal((await authorizePayment({...command,scope:{...command.scope,tenantId:randomUUID()}})).allowed,false);
    assert.equal((await authorizePayment({...command,action:{...command.action,money:{currency:"USD",minor:200}}})).allowed,false);
    assert.equal((await authorizePayment({...command,providerRequestId:randomUUID()})).allowed,false);
  });
  it("rechecks the current role before dispatch and never calls the provider for Auditor",async()=>{
    const command=await commandFor(fixture,randomUUID(),"create");
    await query("UPDATE fp_sessions SET role='auditor' WHERE id=$1",[fixture.id]);
    let calls=0;
    const provider:ProviderAdapter={source:"live_sandbox",execute:async()=>{calls++;throw new Error("must not dispatch");},read:async()=>[],reconcile:async()=>null};
    const core=new PaymentCore({store:new SqlPaymentStore(database()),provider,policy:{authorize:authorizePayment}});
    await assert.rejects(()=>core.execute(command));
    assert.equal(calls,0);
    await query("UPDATE fp_sessions SET role='donor' WHERE id=$1",[fixture.id]);
  });
  it("invalidates a payment when the approved resource version changes",async()=>{
    const command=await commandFor(fixture,randomUUID(),"create");
    await query("UPDATE fp_obligations SET version=version+1 WHERE id=$1",[command.intentId]);
    assert.equal((await authorizePayment(command)).allowed,false);
  });
  it("rejects an unowned order before recording a capture command",async()=>{
    const intent=randomUUID();await commandFor(fixture,intent,"create");
    await assert.rejects(()=>commandFor(fixture,intent,"capture","FORGEDORDER123"),/does not belong/);
    assert.equal((await query("SELECT operation_id FROM fp_payment_commands WHERE tenant_id=$1 AND business_key=$2",[fixture.tenantId,`checkout:${intent}:capture`])).length,0);
  });
  it("enforces the session ceiling atomically across different operations",async()=>{
    const attempts=await Promise.allSettled([commandFor(fixture,randomUUID(),"create"),commandFor(fixture,randomUUID(),"create")]);
    assert.equal(attempts.filter(x=>x.status==="fulfilled").length,0);
    const [row]=await query<{total:string}>("SELECT sum(amount_minor) total FROM fp_obligations WHERE actor_id=$1",[fixture.actorId]);
    assert.equal(Number(row.total),500);
  });
});
