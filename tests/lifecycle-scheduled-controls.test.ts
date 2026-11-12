import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {describe,it} from "node:test";
import {DomainError} from "../lib/domain/money";
import {database,query} from "../lib/server/db";
import {setRole} from "../lib/server/auth";
import {changeLifecycleProgram} from "../lib/server/lifecycle-program";
import {enableLifecycleSchedule,prepareLifecycleSchedule,lifecycleScheduleDetail} from "../lib/server/lifecycle-schedules";
import {lifecycleOccurrenceDetail,lifecycleOccurrenceSource,retryLifecycleOccurrence} from "../lib/server/lifecycle-occurrences";
import {claimLifecycleOccurrence,captureLifecycleOccurrence,draftLifecycleOccurrence,failLifecycleOccurrence,materializeLifecycleSchedules} from "../lib/server/lifecycle-worker";
import type {LifecycleOccurrenceRow} from "../lib/server/lifecycle-core";
import {organizationExpenseFixture} from "./helpers/organization-aggregate";
import {afterTime,enabledFixture,hasCode,originalOccurrence,pause,readyOccurrence,scheduledFixture} from "./helpers/lifecycle-scheduled";

const occurrence=async(id:string)=>(await query<LifecycleOccurrenceRow>("SELECT * FROM fp_lifecycle_occurrences WHERE id=$1",[id]))[0];
async function enableAnother(f:Awaited<ReturnType<typeof enabledFixture>>,replace=false) {
  const current=(await lifecycleScheduleDetail(f.request,f.id)).schedule;
  const input={...f.input,scheduleId:replace?f.id:null,expectedVersion:replace?current.version:0,expectedDefinitionVersion:replace?current.definitionVersion:0,
    proposal:{...f.input.proposal,title:replace?"Controlled explicitly replaced draft":"Controlled independent second schedule",cadence:{...f.input.proposal.cadence,firstDueAt:new Date(Date.now()+750).toISOString()}}};
  const review=(await prepareLifecycleSchedule(f.request,input)).review;
  const saved=await enableLifecycleSchedule(f.request,{intentId:randomUUID(),expectedScope:f.request.organizationScope!,reviewHash:review.reviewHash,review:input,acknowledged:true});
  return {...f,input,id:saved.receipt.resourceId!};
}
async function heldTable(table:"fp_lifecycle_attempts"|"fp_plan_source_controls") {
  let unlock!:()=>void,locked!:()=>void;
  const release=new Promise<void>(resolve=>{unlock=resolve;}),ready=new Promise<void>(resolve=>{locked=resolve;});
  const complete=database().transaction(async tx=>{await tx.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);locked();await release;});
  await ready;return {release:unlock,complete};
}

describe("bounded scheduler recovery and exact authority",()=>{
  it("commits one exact reviewed schedule for simultaneous delivery of the same intent",async()=>{
    const f=await scheduledFixture({dueMs:10_000}),review=(await prepareLifecycleSchedule(f.request,f.input)).review;
    const command={intentId:randomUUID(),expectedScope:f.request.organizationScope!,reviewHash:review.reviewHash,review:f.input,acknowledged:true};
    const results=await Promise.all([enableLifecycleSchedule(f.request,command),enableLifecycleSchedule(f.request,command)]);
    assert.deepEqual(results[0],results[1]);
    const id=results[0].receipt.resourceId!;
    assert.equal((await query<{count:string}>("SELECT count(*) count FROM fp_lifecycle_schedule_versions WHERE schedule_id=$1",[id]))[0].count,"1");
    assert.equal((await query<{count:string}>("SELECT count(*) count FROM fp_lifecycle_commands WHERE intent_id=$1",[command.intentId]))[0].count,"1");
  });
  it("grants one concurrent worker lease and commits a repeated capture once",async()=>{
    const f=await enabledFixture(),row=await originalOccurrence(f),claims=await Promise.all([claimLifecycleOccurrence(row.id),claimLifecycleOccurrence(row.id)]),claim=claims.find(Boolean)!;
    assert.equal(claims.filter(Boolean).length,1);
    const captures=await Promise.allSettled([captureLifecycleOccurrence(claim),captureLifecycleOccurrence(claim)]);
    assert.equal(captures.filter(value=>value.status==="fulfilled").length,1);
    assert(captures.some(value=>value.status==="rejected"&&hasCode("LIFECYCLE_BUSY")(value.reason)));
    assert.equal((await query<{count:string}>("SELECT count(*) count FROM fp_lifecycle_snapshots WHERE occurrence_id=$1",[row.id]))[0].count,"1");
    const draft=await claimLifecycleOccurrence(row.id);assert(draft);await draftLifecycleOccurrence(draft);
    assert.equal((await occurrence(row.id)).attempt_count,2);assert.equal(await claimLifecycleOccurrence(row.id),null);
  });
  it("records automatic retry time and cannot queue early or substitute another saved source",async()=>{
    const f=await enabledFixture(),row=await originalOccurrence(f),first=await claimLifecycleOccurrence(row.id);assert(first);await captureLifecycleOccurrence(first);
    const draft=await claimLifecycleOccurrence(row.id);assert(draft);await failLifecycleOccurrence(draft,new DomainError("LIFECYCLE_BUSY","Controlled rolled-back local worker contention.",409));
    const failed=await occurrence(row.id);assert.equal(failed.state,"retry_wait");assert(failed.next_retry_at&&failed.next_retry_at.getTime()>Date.now()+45_000);
    assert.equal(await claimLifecycleOccurrence(row.id),null);
    const input={intentId:randomUUID(),expectedScope:f.request.organizationScope!,expectedProjectScope:f.request.projectScope!,expectedVersion:failed.version,occurrenceKey:failed.occurrence_key,expectedSnapshotHash:failed.snapshot_hash,acknowledged:true};
    await assert.rejects(retryLifecycleOccurrence(f.request,row.id,{...input,expectedSnapshotHash:"a".repeat(64)}),hasCode("LIFECYCLE_OCCURRENCE_CHANGED"));
    await assert.rejects(retryLifecycleOccurrence(f.request,row.id,input),hasCode("LIFECYCLE_BUSY"));
    assert.deepEqual(await occurrence(row.id),failed);
  });
  it("recovers a manually retryable draft from its exact committed capture after response loss",async()=>{
    const f=await enabledFixture(),row=await originalOccurrence(f),first=await claimLifecycleOccurrence(row.id);assert(first);await captureLifecycleOccurrence(first);
    const draft=await claimLifecycleOccurrence(row.id);assert(draft);await failLifecycleOccurrence(draft,new DomainError("LIFECYCLE_REVIEW_REQUIRED","Controlled local draft failure before any external dispatch.",409));
    const failed=await occurrence(row.id);assert.equal(failed.state,"failed");
    const input={intentId:randomUUID(),expectedScope:f.request.organizationScope!,expectedProjectScope:f.request.projectScope!,expectedVersion:failed.version,occurrenceKey:failed.occurrence_key,expectedSnapshotHash:failed.snapshot_hash,acknowledged:true};
    const receipt=await retryLifecycleOccurrence(f.request,row.id,input);assert.deepEqual(await retryLifecycleOccurrence(f.request,row.id,input),receipt);
    const retry=await claimLifecycleOccurrence(row.id);assert(retry&&retry.stage==="draft");await draftLifecycleOccurrence(retry);
    const ready=await occurrence(row.id);assert.equal(ready.state,"ready");assert.equal(ready.snapshot_hash,failed.snapshot_hash);assert.deepEqual(ready.captured_at,failed.captured_at);assert.deepEqual(ready.expires_at,failed.expires_at);
    assert.equal((await query<{count:string}>("SELECT count(*) count FROM fp_lifecycle_snapshots WHERE occurrence_id=$1",[row.id]))[0].count,"1");
  });
  it("disabling and newly opting in to the program cannot revive an older production grant",async()=>{
    const f=await enabledFixture(),ready=await readyOccurrence(f),pending=await originalOccurrence(await enableAnother(f));
    await changeLifecycleProgram(f.request,"disable",{intentId:randomUUID(),expectedScope:f.request.organizationScope!,expectedVersion:1,reason:"Controlled stop of future private drafting.",acknowledged:true});
    assert.equal(await claimLifecycleOccurrence(pending.id),null);assert.equal((await occurrence(pending.id)).state,"blocked_authority");
    assert((await lifecycleOccurrenceDetail(f.request,ready.id)).detail.content);
    await changeLifecycleProgram(f.request,"enable",{intentId:randomUUID(),expectedScope:f.request.organizationScope!,expectedVersion:2,expiresAt:new Date(Date.now()+60*60_000).toISOString(),acknowledged:true});
    assert.equal(await claimLifecycleOccurrence(pending.id),null);assert.equal((await occurrence(pending.id)).snapshot_hash,null);
    assert((await lifecycleOccurrenceDetail(f.request,ready.id)).detail.content);
  });
  it("replacement retains its old definition and cancels an old unprocessed original slot",async()=>{
    const f=await enabledFixture(),old=await originalOccurrence(f),before=(await query<{id:string}>("SELECT * FROM fp_lifecycle_schedule_versions WHERE schedule_id=$1",[f.id]))[0];
    await enableAnother(f,true);
    assert.equal((await lifecycleScheduleDetail(f.request,f.id)).schedule.definitionVersion,2);
    assert.equal(await claimLifecycleOccurrence(old.id),null);assert.equal((await occurrence(old.id)).state,"cancelled");
    assert.deepEqual((await query("SELECT * FROM fp_lifecycle_schedule_versions WHERE id=$1",[before.id]))[0],before);
    assert.equal((await occurrence(old.id)).snapshot_hash,null);
  });
  it("ends private disclosure and production when the independently held project role changes",async()=>{
    const f=await enabledFixture(),ready=await readyOccurrence(f),pending=await originalOccurrence(await enableAnother(f));
    await setRole(f.project.organizer,"donor");
    const detail=(await lifecycleOccurrenceDetail(f.request,ready.id)).detail;assert.equal(detail.content,null);assert.deepEqual(detail.sources,[]);assert.equal(detail.occurrence.title,null);
    assert.equal(await claimLifecycleOccurrence(pending.id),null);assert.equal((await occurrence(pending.id)).state,"blocked_authority");
    assert.equal((await lifecycleScheduleDetail(f.request,f.id)).schedule.definition,null);
  });
  it("withholds content when its unchanged original deadline passes during a blocked read",async()=>{
    const f=await enabledFixture({dueMs:350,expiresMs:2500}),row=await readyOccurrence(f),original=(await query("SELECT expires_at,snapshot_hash,content_hash,captured_at FROM fp_lifecycle_occurrences WHERE id=$1",[row.id]))[0];
    const hold=await heldTable("fp_lifecycle_attempts");
    let settled=false;const reading=lifecycleOccurrenceDetail(f.request,row.id).finally(()=>{settled=true;});
    await pause(150);assert.equal(settled,false);await afterTime(row.expires_at);hold.release();await hold.complete;
    const detail=(await reading).detail;assert.equal(detail.content,null);assert.deepEqual(detail.sources,[]);assert.equal(detail.occurrence.title,null);assert.equal(detail.occurrence.status,"unavailable");
    await assert.rejects(lifecycleOccurrenceSource(f.request,row.id,"budget"),hasCode("LIFECYCLE_SOURCE_WITHDRAWN"));
    assert.deepEqual((await query("SELECT expires_at,snapshot_hash,content_hash,captured_at FROM fp_lifecycle_occurrences WHERE id=$1",[row.id]))[0],original);
  });
  it("observes a first source withdrawal committed before its repeatable snapshot without inventing permission rows",async()=>{
    const f=await scheduledFixture({dueMs:10_000}),expense=await organizationExpenseFixture(f.project);
    // The new source changes the project basis, so perform an ordinary fresh
    // target review before enabling this controlled expense schedule.
    const {lifecycleTargets}=await import("../lib/server/lifecycle-sources");
    const targets=(await lifecycleTargets(f.request,"project_treasurer")).targets;
    f.input.proposal.target={kind:"project_treasurer",projectId:f.project.projectId,expectedProjectScope:targets.projectScope!,expectedProjectBasis:targets.project!.projectBasis,link:targets.project!.link};
    f.input.proposal.cadence.firstDueAt=new Date(Date.now()+750).toISOString();
    const review=(await prepareLifecycleSchedule(f.request,f.input)).review;
    const saved=await enableLifecycleSchedule(f.request,{intentId:randomUUID(),expectedScope:f.request.organizationScope!,reviewHash:review.reviewHash,review:f.input,acknowledged:true}),enabled={...f,review,command:null as never,saved,id:saved.receipt.resourceId!};
    const row=await readyOccurrence(enabled);assert.equal((await query<{count:string}>("SELECT count(*) count FROM fp_plan_source_controls WHERE document_id=$1",[expense.document.id]))[0].count,"0");
    let release!:()=>void,locked!:()=>void;const proceed=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{locked=resolve;});
    const withdrawal=database().transaction(async tx=>{
      await tx.query("INSERT INTO fp_plan_source_controls(document_id,tenant_id,project_id,classification,permission) VALUES($1,$2,$3,'source','withdrawn')",[expense.document.id,f.project.tenantId,f.project.projectId]);locked();await proceed;
    });
    await entered;let settled=false;const reading=lifecycleOccurrenceDetail(f.request,row.id).finally(()=>{settled=true;});
    await pause(100);assert.equal(settled,false);release();await withdrawal;
    const result=(await reading).detail;assert.equal(result.content,null);assert.deepEqual(result.sources,[]);assert.equal(result.occurrence.status,"withdrawn");
    assert.equal((await query<{count:string}>("SELECT count(*) count FROM fp_plan_source_controls WHERE document_id=$1",[expense.document.id]))[0].count,"1");
  });
  it("keeps original due identities, terminal attempts and frozen captures enforced by database guards",async()=>{
    const f=await enabledFixture(),row=await readyOccurrence(f);
    await assert.rejects(query("UPDATE fp_lifecycle_occurrences SET version=version+1,expires_at=expires_at+interval '1 hour' WHERE id=$1",[row.id]),hasCode("23514"));
    await assert.rejects(query("UPDATE fp_lifecycle_occurrences SET version=version+1,state='due' WHERE id=$1",[row.id]),hasCode("23514"));
    await assert.rejects(query("UPDATE fp_lifecycle_snapshots SET encrypted_data='replaced' WHERE occurrence_id=$1",[row.id]),hasCode("23514"));
    await assert.rejects(query("UPDATE fp_lifecycle_attempts SET outcome='failed' WHERE occurrence_id=$1",[row.id]),hasCode("23514"));
    await assert.rejects(query("UPDATE fp_lifecycle_schedules SET version=version+1,current_definition_version=current_definition_version+1 WHERE id=$1",[f.id]),hasCode("23503"));
    await assert.rejects(query("UPDATE fp_lifecycle_program_heads SET version=version+1 WHERE organization_id=(SELECT organization_id FROM fp_lifecycle_schedules WHERE id=$1)",[f.id]),hasCode("23503"));
    assert.equal((await occurrence(row.id)).state,"ready");
  });
  it("recovers an abandoned original worker only after its actual lease naturally expires",async()=>{
    const f=await enabledFixture(),row=await originalOccurrence(f),abandoned=await claimLifecycleOccurrence(row.id);assert(abandoned);
    const leased=await occurrence(row.id);assert(leased.lease_until);assert.equal(await claimLifecycleOccurrence(row.id),null);
    await afterTime(leased.lease_until);
    const recovery=await claimLifecycleOccurrence(row.id);assert(recovery);assert.notEqual(recovery.leaseToken,abandoned.leaseToken);assert.equal(recovery.occurrenceId,abandoned.occurrenceId);
    await assert.rejects(captureLifecycleOccurrence(abandoned),hasCode("LIFECYCLE_BUSY"));
    await captureLifecycleOccurrence(recovery);const draft=await claimLifecycleOccurrence(row.id);assert(draft);await draftLifecycleOccurrence(draft);
    const ready=await occurrence(row.id);assert.equal(ready.state,"ready");assert.equal(ready.attempt_count,3);assert.equal(ready.occurrence_key,row.occurrence_key);assert.deepEqual(ready.expires_at,row.expires_at);
    const attempts=await query<{ordinal:number;outcome:string;code:string|null}>("SELECT ordinal,outcome,code FROM fp_lifecycle_attempts WHERE occurrence_id=$1 ORDER BY ordinal",[row.id]);
    assert.deepEqual(attempts.map(value=>value.outcome),["retryable","succeeded","succeeded"]);assert.equal(attempts[0].code,"LIFECYCLE_LEASE_EXPIRED");
  });
});
