import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {it} from "node:test";
import {SUPPORTER_ACCESS_VERSION} from "../lib/supporters/contracts";
import {query,database} from "../lib/server/db";
import {lifecycleContext,type LifecycleRequest} from "../lib/server/lifecycle-core";
import {lifecycleSetPreferences,lifecycleInbox} from "../lib/server/lifecycle-personal";
import {runLifecyclePersonalPage} from "../lib/server/lifecycle-observer";
import {createSupporterInvite,acceptSupporterInvite,reviewSupporterEntry,supporterDesk} from "../lib/server/supporter-access";
import {createFundingPolicy} from "../lib/server/funding-lifecycle";
import {createPurposePledge} from "../lib/server/purpose-pledges";
import {communityFixture} from "./helpers/community";
import {originalRows,pause} from "./helpers/lifecycle-scheduled";

it("persists a bounded observer cursor across independent entries and prevents duplicate capture after repeating a completed sweep",async()=>{
  const project=await communityFixture("makerspace"),owner=project.session,browser=randomBytes(32).toString("base64url"),requests:LifecycleRequest[]=[];
  const policy=await createFundingPolicy(owner,{intentId:randomUUID(),packageId:"materials",expectedVersion:1,kind:"mixed",acknowledged:true});
  const [{digest}]=await query<{digest:string}>("SELECT digest FROM fp_funding_policies WHERE id=$1",[policy.id]);
  for(let index=0;index<6;index++){
    const desk=await supporterDesk(owner),invite=await createSupporterInvite(owner,browser,{intentId:randomUUID(),expectedScope:desk.scope,purpose:"donor",label:`Controlled independent observer donor ${index+1}`,expiresHours:2,acknowledged:true});
    const entry={session:null,credentialHash:null,browserKey:randomBytes(32).toString("base64url")},review=await reviewSupporterEntry({kind:"invite",token:invite.token},entry);
    const joined=await acceptSupporterInvite({intentId:randomUUID(),expectedScope:review.scope,token:invite.token,displayName:`Controlled observer donor ${index+1}`,contractVersion:SUPPORTER_ACCESS_VERSION,acknowledged:true},entry);
    const request:LifecycleRequest={organizationToken:null,libraryToken:null,projectToken:joined.sessionToken,browserKey:randomBytes(48).toString("base64url")};request.personalScope=(await lifecycleContext(request)).context.project.scope;requests.push(request);
    await lifecycleSetPreferences(request,{intentId:randomUUID(),expectedScope:request.personalScope,expectedVersion:0,enabled:true,categories:["pledges"],emailPreviews:true,history:"future_only",acknowledged:true});
    await pause(2);await createPurposePledge(joined.session,{intentId:randomUUID(),policyId:policy.id,policyDigest:digest,amountMinor:100+index,acknowledged:true});
  }
  const old=await originalRows();
  let unlock!:()=>void,locked!:()=>void;const release=new Promise<void>(resolve=>{unlock=resolve;}),ready=new Promise<void>(resolve=>{locked=resolve;});
  const blocker=database().transaction(async tx=>{await tx.query("LOCK TABLE fp_plan_source_controls IN ACCESS EXCLUSIVE MODE");locked();await release;});await ready;
  const first=runLifecyclePersonalPage(2);
  let lease=false;for(let check=0;check<30;check++){lease=!!(await query<{lease_token:string|null}>("SELECT lease_token FROM fp_lifecycle_observer_heads WHERE name='personal-v1'"))[0]?.lease_token;if(lease)break;await pause(10);}assert(lease);
  const concurrent=await runLifecyclePersonalPage(2);assert.equal(concurrent.state,"busy");assert.equal(concurrent.created,0);unlock();await blocker;
  const page1=await first;assert.equal(page1.state,"completed");assert.equal(page1.checked,2);assert.equal(page1.created,2);assert.equal(page1.morePossible,true);
  const page2=await runLifecyclePersonalPage(2),page3=await runLifecyclePersonalPage(2);
  assert.equal(page2.created,2);assert.equal(page3.created,2);assert.equal(page3.morePossible,false);
  const checkpoint=(await query<{encrypted_cursor:string|null;lease_token:string|null}>("SELECT encrypted_cursor,lease_token FROM fp_lifecycle_observer_heads WHERE name='personal-v1'"))[0];assert.equal(checkpoint.encrypted_cursor,null);assert.equal(checkpoint.lease_token,null);
  const replay=await runLifecyclePersonalPage(2);assert.equal(replay.created,0);assert.equal(replay.checked,2);
  assert.equal((await query<{count:string}>("SELECT count(*) count FROM fp_lifecycle_inbox WHERE project_id=$1",[owner.projectId]))[0].count,"6");
  for(const request of requests){const inbox=(await lifecycleInbox(request)).inbox;assert.equal(inbox.items.length,1);assert.equal(inbox.items[0].kind,"pledge_saved");}
  assert.deepEqual(await originalRows(),old);
  // A head version cannot point at a different immutable preference version.
  await assert.rejects(query("UPDATE fp_lifecycle_preference_heads SET version=version+1 WHERE id=(SELECT id FROM fp_lifecycle_preference_heads WHERE project_id=$1 LIMIT 1)",[owner.projectId]),error=>!!error&&typeof error==="object"&&"code" in error&&error.code==="23503");
});
