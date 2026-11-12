import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import * as C from "../../lib/lifecycle/contracts";
import {query} from "../../lib/server/db";
import {changeLifecycleProgram} from "../../lib/server/lifecycle-program";
import {lifecycleSchedules,prepareLifecycleSchedule,enableLifecycleSchedule} from "../../lib/server/lifecycle-schedules";
import {lifecycleTargets} from "../../lib/server/lifecycle-sources";
import {claimLifecycleOccurrence,captureLifecycleOccurrence,draftLifecycleOccurrence,materializeLifecycleSchedules} from "../../lib/server/lifecycle-worker";
import type {LifecycleOccurrenceRow,LifecycleRequest} from "../../lib/server/lifecycle-core";
import {organizationWorkflow} from "./organization-workflow";

assert(/^lifecycle_scheduled_test_[a-f0-9]{32}$/.test(process.env.FIELDPROOF_LIFECYCLE_SCHEDULE_TEST_SCHEMA??""),"Use the guarded fresh scheduled-lifecycle schema.");
export const hasCode=(code:string)=>(error:unknown)=>!!error&&typeof error==="object"&&"code" in error&&error.code===code;
export const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export async function afterTime(at:string|Date){await pause(Math.max(1,new Date(at).getTime()-Date.now()+15));}
export async function scheduledFixture(options:{audience?:C.LifecycleSchedule["audience"];dueMs?:number;expiresMs?:number;topics?:C.LifecycleTopic[];prepare?:boolean}={}) {
  const f=await organizationWorkflow(),request=f.request as LifecycleRequest,at=Date.now();
  await changeLifecycleProgram(request,"enable",{intentId:randomUUID(),expectedScope:request.organizationScope,expectedVersion:0,expiresAt:new Date(at+60*60_000).toISOString(),acknowledged:true});
  const audience=options.audience??"project_treasurer",targets=(await lifecycleTargets(request,audience)).targets;
  const target:C.LifecycleTarget=audience==="project_treasurer"?{kind:audience,expectedProjectScope:targets.projectScope!,projectId:f.project.projectId,expectedProjectBasis:targets.project!.projectBasis,link:targets.project!.link}:
    {kind:audience,expectedProjectScope:null,filters:targets.aggregate!.filters,expectedBasisHash:targets.aggregate!.basisHash,links:targets.aggregate!.links};
  const proposal:C.LifecycleScheduleProposal={title:"Controlled private scheduled account",target,cadence:{intervalMinutes:15,timeZone:"UTC",firstDueAt:new Date(Date.now()+(options.dueMs??1500)).toISOString()},expiresAt:new Date(Date.now()+(options.expiresMs??30*60_000)).toISOString(),topics:options.topics??["budget","funding","expenses","evidence"],drafting:"deterministic"};
  const input:C.LifecycleSchedulePrepare={expectedScope:request.organizationScope!,expectedProgramVersion:1,scheduleId:null,expectedVersion:0,expectedDefinitionVersion:0,proposal};
  return {...f,request,input};
}
export type ScheduledFixture=Awaited<ReturnType<typeof scheduledFixture>>;
export async function enabledFixture(options:Parameters<typeof scheduledFixture>[0]={}) {
  const f=await scheduledFixture(options),review=(await prepareLifecycleSchedule(f.request,f.input)).review;
  assert.equal(review.canEnable,true,review.blockers.join(" "));
  const command:C.LifecycleScheduleEnable={intentId:randomUUID(),expectedScope:f.request.organizationScope!,reviewHash:review.reviewHash,review:f.input,acknowledged:true};
  const saved=await enableLifecycleSchedule(f.request,command),id=saved.receipt.resourceId!;
  return {...f,review,command,saved,id};
}
export async function originalOccurrence(f:Awaited<ReturnType<typeof enabledFixture>>) {
  await afterTime(f.input.proposal.cadence.firstDueAt);await materializeLifecycleSchedules({limit:20,slotsPerDefinition:20});
  const [row]=await query<LifecycleOccurrenceRow>("SELECT * FROM fp_lifecycle_occurrences WHERE schedule_id=$1 ORDER BY due_at LIMIT 1",[f.id]);assert(row);return row;
}
export async function readyOccurrence(f:Awaited<ReturnType<typeof enabledFixture>>) {
  const row=await originalOccurrence(f),capture=await claimLifecycleOccurrence(row.id);assert(capture&&capture.stage==="capture");await captureLifecycleOccurrence(capture);
  const draft=await claimLifecycleOccurrence(row.id);assert(draft&&draft.stage==="draft");await draftLifecycleOccurrence(draft);
  return (await query<LifecycleOccurrenceRow>("SELECT * FROM fp_lifecycle_occurrences WHERE id=$1",[row.id]))[0];
}
export async function originalRows() {
  const names=await query<{name:string}>("SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() AND tablename NOT LIKE 'fp_lifecycle_%' ORDER BY tablename");
  assert(names.every(row=>/^[a-z_][a-z0-9_]*$/.test(row.name)));
  const sql=names.map(row=>`SELECT '${row.name}' AS name,count(*)::text AS count,md5(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) AS digest FROM "${row.name}" t`).join(" UNION ALL ");
  return query<{name:string;count:string;digest:string}>(sql);
}
