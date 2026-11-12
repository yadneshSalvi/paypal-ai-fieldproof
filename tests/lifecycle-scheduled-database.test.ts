import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {describe,it} from "node:test";
import {lifecycleDefinitionHash} from "../lib/lifecycle/schedule";
import {query,database} from "../lib/server/db";
import {changeLifecycleProgram} from "../lib/server/lifecycle-program";
import {lifecycleSchedules,lifecycleScheduleDetail,prepareLifecycleSchedule,enableLifecycleSchedule,changeLifecycleSchedule} from "../lib/server/lifecycle-schedules";
import {lifecycleOccurrences,lifecycleOccurrenceDetail,lifecycleOccurrenceSource,reviewLifecycleOccurrence,changeLifecycleOccurrence,retryLifecycleOccurrence} from "../lib/server/lifecycle-occurrences";
import {captureLifecycleOccurrence,claimLifecycleOccurrence,draftLifecycleOccurrence,failLifecycleOccurrence} from "../lib/server/lifecycle-worker";
import {lifecycleTargets} from "../lib/server/lifecycle-sources";
import {organizationJoin,organizationScopes} from "./helpers/organization-workflow";
import {withdrawOrganizationProjectLink} from "../lib/server/organization-projects";
import {afterTime,enabledFixture,hasCode,originalOccurrence,originalRows,pause,readyOccurrence,scheduledFixture} from "./helpers/lifecycle-scheduled";

describe("actual durable scheduled drafts and original private authority",()=>{
  it("captures one immutable due slot, drafts cited facts and preserves every old table",async()=>{
    const f=await enabledFixture(),before=await originalRows(),row=await readyOccurrence(f),detail=(await lifecycleOccurrenceDetail(f.request,row.id)).detail;
    assert.equal(detail.occurrence.state,"ready");assert.equal(detail.occurrence.status,"current");assert(detail.content);assert(detail.sources.length>0);
    assert.equal(detail.content.sourceHash,row.snapshot_hash);assert.equal(detail.content.contentHash,row.content_hash);assert.equal(detail.content.asOf,row.captured_at!.toISOString());assert(row.captured_at!>=row.due_at);
    assert.equal(detail.content.externalSendingAuthorized,false);assert.equal(detail.content.origin,"deterministic");assert.equal(detail.occurrence.totalAttempts,2);
    assert.deepEqual(await originalRows(),before);
    const source=(await lifecycleOccurrenceSource(f.request,row.id,detail.sources[0].id)).detail;
    assert.equal(source.snapshotHash,row.snapshot_hash);assert.equal(source.asOf,detail.content.asOf);
    const after=await originalRows();await lifecycleOccurrenceDetail(f.request,row.id);await lifecycleOccurrences(f.request);assert.deepEqual(await originalRows(),after);
  });
  it("keeps private project definitions and facts absent from organization-only lists and wrong profiles",async()=>{
    const f=await enabledFixture(),row=await readyOccurrence(f),orgOnly={...f.request,projectToken:null,projectScope:undefined};
    const desk=(await lifecycleSchedules(f.request)).desk,listed=desk.schedules.find(value=>value.id===f.id)!;
    assert.equal(listed.access,"project_profile_required");assert.equal(listed.definition,null);assert.equal(listed.targetLabel,null);
    const list=(await lifecycleOccurrences(f.request)).page.occurrences.find(value=>value.id===row.id)!;
    assert.equal(list.status,"unavailable");assert.equal(list.contentHash,null);assert.equal(list.title,null);
    const detail=(await lifecycleOccurrenceDetail(orgOnly,row.id)).detail;assert.equal(detail.content,null);assert.deepEqual(detail.sources,[]);
    const other=await organizationJoin(f.request,"coordinator");await assert.rejects(lifecycleOccurrenceDetail(other.request,row.id),hasCode("LIFECYCLE_RESOURCE_UNAVAILABLE"));
    const auditor=await organizationJoin(f.request,"auditor");await assert.rejects(lifecycleSchedules(auditor.request),hasCode("ORG_ROLE_DENIED"));
    await assert.rejects(lifecycleTargets({...f.request,organizationScope:undefined},"project_treasurer"),hasCode("LIFECYCLE_ORGANIZATION_CHANGED"));
    await assert.rejects(lifecycleTargets({...f.request,projectScope:undefined},"project_treasurer"),hasCode("LIFECYCLE_PROJECT_CHANGED"));
  });
  it("produces and reviews an aggregate using only exact consented sections without a project cookie",async()=>{
    const f=await enabledFixture({audience:"organization_aggregate"}),request={...f.request,projectToken:null,projectScope:undefined},row=await readyOccurrence(f);
    const detail=(await lifecycleOccurrenceDetail(request,row.id)).detail;assert(detail.content);assert.equal(detail.occurrence.status,"current");assert(detail.sources.every(source=>!["consents","exceptions"].includes(source.topic)));
    const command={intentId:randomUUID(),expectedScope:request.organizationScope!,expectedProjectScope:null,expectedVersion:row.version,occurrenceKey:row.occurrence_key,snapshotHash:row.snapshot_hash!,contentHash:row.content_hash!,decision:"reviewed_private" as const,note:"Controlled review of every permitted scalar citation.",sourcesChecked:true as const,privateDraftOnly:true as const,acknowledged:true as const};
    const saved=await reviewLifecycleOccurrence(request,row.id,command),again=await reviewLifecycleOccurrence(request,row.id,command);assert.deepEqual(again,saved);
    assert.equal((await lifecycleOccurrenceDetail(request,row.id)).detail.occurrence.review,"reviewed_private");
    await assert.rejects(reviewLifecycleOccurrence(request,row.id,{...command,note:"Changed original review note"}),hasCode("LIFECYCLE_INTENT_CHANGED"));
  });
  it("recovers the same enabled definition after response loss and refuses changed intent or stale review",async()=>{
    const f=await enabledFixture({dueMs:2500}),again=await enableLifecycleSchedule(f.request,f.command);assert.deepEqual(again,f.saved);
    await assert.rejects(enableLifecycleSchedule(f.request,{...f.command,review:{...f.command.review,proposal:{...f.command.review.proposal,title:"A different private title"}}}),hasCode("LIFECYCLE_INTENT_CHANGED"));
    assert.equal((await query<{count:string}>("SELECT count(*) count FROM fp_lifecycle_schedule_versions WHERE schedule_id=$1",[f.id]))[0].count,"1");
    const g=await scheduledFixture({dueMs:2500}),review=(await prepareLifecycleSchedule(g.request,g.input)).review;
    await query("UPDATE fp_packages SET budget_minor=budget_minor+100,version=version+1 WHERE project_id=$1 AND id='materials'",[g.project.projectId]);
    await assert.rejects(enableLifecycleSchedule(g.request,{intentId:randomUUID(),expectedScope:g.request.organizationScope!,reviewHash:review.reviewHash,review:g.input,acknowledged:true}),error=>hasCode("ORG_PROJECT_SOURCE_CHANGED")(error)||hasCode("LIFECYCLE_SOURCE_CHANGED")(error));
  });
  it("records a paused due slot permanently and resumes only the next original cadence",async()=>{
    const f=await enabledFixture(),schedule=(await lifecycleScheduleDetail(f.request,f.id)).schedule;
    await changeLifecycleSchedule({...f.request,projectScope:undefined,projectToken:null},f.id,{intentId:randomUUID(),expectedScope:f.request.organizationScope!,expectedProjectScope:null,expectedVersion:schedule.version,expectedDefinitionVersion:schedule.definitionVersion,definitionHash:schedule.definitionHash,action:"pause",reason:"Controlled pause before the original first due slot.",acknowledged:true});
    const skipped=await originalOccurrence(f);assert.equal(skipped.state,"skipped_paused");assert.equal(skipped.snapshot_hash,null);assert.equal(await claimLifecycleOccurrence(skipped.id),null);
    const current=(await lifecycleScheduleDetail(f.request,f.id)).schedule;
    const resume={intentId:randomUUID(),expectedScope:f.request.organizationScope!,expectedProjectScope:f.request.projectScope!,expectedVersion:current.version,expectedDefinitionVersion:current.definitionVersion,definitionHash:current.definitionHash,action:"resume" as const,reason:"Controlled explicit resume without catching up the paused slot.",acknowledged:true as const};
    await assert.rejects(changeLifecycleSchedule({...f.request,projectScope:undefined,projectToken:null},f.id,resume),hasCode("LIFECYCLE_PROJECT_CHANGED"));
    await changeLifecycleSchedule(f.request,f.id,resume);
    assert.equal((await lifecycleScheduleDetail(f.request,f.id)).schedule.nextDueAt,new Date(Date.parse(f.input.proposal.cadence.firstDueAt)+15*60_000).toISOString());
    const after=(await query("SELECT state,snapshot_hash,captured_at FROM fp_lifecycle_occurrences WHERE id=$1",[skipped.id]))[0];assert.deepEqual(after,{state:"skipped_paused",snapshot_hash:null,captured_at:null});
  });
  it("recovers a committed capture with exactly its old source after later project activity",async()=>{
    const f=await enabledFixture(),row=await originalOccurrence(f),first=await claimLifecycleOccurrence(row.id);assert(first);await captureLifecycleOccurrence(first);
    const [captured]=await query<{snapshot_hash:string;captured_at:Date}>("SELECT snapshot_hash,captured_at FROM fp_lifecycle_occurrences WHERE id=$1",[row.id]);
    await query("UPDATE fp_packages SET budget_minor=budget_minor+100,version=version+1 WHERE project_id=$1 AND id='materials'",[f.project.projectId]);
    const resumed=await claimLifecycleOccurrence(row.id);assert(resumed&&resumed.stage==="draft");await draftLifecycleOccurrence(resumed);
    const detail=(await lifecycleOccurrenceDetail(f.request,row.id)).detail;assert.equal(detail.occurrence.snapshotHash,captured.snapshot_hash);assert.equal(detail.occurrence.capturedAt,captured.captured_at.toISOString());assert.equal(detail.occurrence.status,"historical");assert.equal(detail.occurrence.canReview,false);
    assert.equal((await query<{count:string}>("SELECT count(*) count FROM fp_lifecycle_snapshots WHERE occurrence_id=$1",[row.id]))[0].count,"1");assert.equal(await claimLifecycleOccurrence(row.id),null);
  });
  it("withholds a ready original edition after disclosure withdrawal without changing its stored bytes",async()=>{
    const f=await enabledFixture(),row=await readyOccurrence(f),before=(await query("SELECT * FROM fp_lifecycle_snapshots WHERE occurrence_id=$1",[row.id]))[0];
    await withdrawOrganizationProjectLink(f.request,f.linkId,{intentId:randomUUID(),expectedScope:f.request.organizationScope!,authority:"organization",expectedVersion:1,reason:"Controlled original disclosure withdrawal.",acknowledged:true});
    const detail=(await lifecycleOccurrenceDetail(f.request,row.id)).detail;assert.equal(detail.content,null);assert.equal(detail.occurrence.status,"withdrawn");assert.equal(detail.occurrence.snapshotHash,null);assert.equal(detail.occurrence.canRetry,false);
    assert.deepEqual((await query("SELECT * FROM fp_lifecycle_snapshots WHERE occurrence_id=$1",[row.id]))[0],before);
  });
  it("retains reading history separately and rejects another occurrence's content or original key",async()=>{
    const f=await enabledFixture(),row=await readyOccurrence(f),command={intentId:randomUUID(),expectedScope:f.request.organizationScope!,expectedProjectScope:f.request.projectScope!,expectedVersion:row.version,occurrenceKey:row.occurrence_key,contentHash:row.content_hash!,action:"read" as const,acknowledged:true as const};
    await assert.rejects(changeLifecycleOccurrence(f.request,row.id,{...command,occurrenceKey:"f".repeat(64)}),hasCode("LIFECYCLE_OCCURRENCE_CHANGED"));
    const before=(await query("SELECT snapshot_hash,content_hash,captured_at,expires_at FROM fp_lifecycle_occurrences WHERE id=$1",[row.id]))[0],saved=await changeLifecycleOccurrence(f.request,row.id,command);assert.deepEqual(await changeLifecycleOccurrence(f.request,row.id,command),saved);
    const current=(await lifecycleOccurrenceDetail(f.request,row.id)).detail.occurrence;
    await changeLifecycleOccurrence(f.request,row.id,{...command,intentId:randomUUID(),expectedVersion:current.version,action:"archive"});
    assert.equal((await lifecycleOccurrenceDetail(f.request,row.id)).detail.occurrence.readState,"archived");assert.deepEqual((await query("SELECT snapshot_hash,content_hash,captured_at,expires_at FROM fp_lifecycle_occurrences WHERE id=$1",[row.id]))[0],before);
  });
});
