import { randomUUID } from "node:crypto";
import * as C from "../lifecycle/contracts";
import { dueLifecycleSlots, lifecycleDefinitionHash, lifecycleFixedDeadline, type LifecyclePause } from "../lifecycle/schedule";
import { DomainError } from "../domain/money";
import { projectClaimLock } from "./claims";
import { query } from "./db";
import { sealPrivate } from "./private-values";
import { assertOrganizationCurrent, orgCursor, orgHash, orgNow, orgPage, type OrgIdentity, type OrgTx } from "./organization-core";
import { assertOrganizationProjectBasis, assertOrganizationProjectCurrent, organizationLinkById, requireOrganizationProject, type OrganizationProjectAuthority } from "./organization-projects";
import { checkLifecycleCaller, checkLifecycleDelegation, lifecycleDelegation, lifecycleOwnedSchedule, lifecycleReviewHash } from "./lifecycle-authority";
import { findLifecycleCommand, lifecycleActor, lifecycleAudit, lifecycleCredential, lifecyclePrivateContext, lifecycleTx, lifecycleVersion, lifecycleWritable, readLifecycleProgram, requireLifecycleOrganization, saveLifecycleCommand,
  type LifecycleDefinition, type LifecycleDelegation, type LifecycleRequest, type LifecycleScheduleHead } from "./lifecycle-core";
import { checkLifecycleSource, collectLifecycleSource, lifecycleLinks, lifecycleSourceTx, type LifecycleCapturedSource } from "./lifecycle-sources";

/** Exact consented project locks serialize positive captures with ordinary
 * writers. They confer no invented project role or credential. */
export async function lockLifecycleSources(tx: OrgTx, identity: OrgIdentity, pins: readonly C.LifecycleConsentPin[]) {
  const rows = [];
  for (const pin of pins) rows.push(await organizationLinkById(tx, pin.linkId, identity.organization.id));
  for (const row of rows.sort((a,b) => a.project_id.localeCompare(b.project_id))) {
    await projectClaimLock(tx, row.project_id);
    await tx.query("SELECT id FROM fp_projects WHERE id=$1 AND tenant_id=$2 FOR SHARE", [row.project_id,row.tenant_id]);
    await tx.query("SELECT project_id FROM fp_planning_heads WHERE project_id=$1 AND tenant_id=$2 FOR SHARE", [row.project_id,row.tenant_id]);
  }
  return lifecycleLinks(tx, identity, pins, true);
}
interface Prepared { identity: OrgIdentity; project: OrganizationProjectAuthority | null; source: LifecycleCapturedSource; review: C.LifecycleScheduleReview; previous: {head: LifecycleScheduleHead; definition: LifecycleDefinition} | null; }
async function prepareWithin(tx: OrgTx, request: LifecycleRequest, input: C.LifecycleSchedulePrepare, write: boolean): Promise<Prepared> {
  const identity = await requireLifecycleOrganization(tx,request,input.expectedScope,write), program = await readLifecycleProgram(tx,identity,write);
  lifecycleVersion(program.view.version,input.expectedProgramVersion,"organization opt-in");
  if (program.view.state !== "enabled" || !program.view.expiresAt) throw new DomainError("LIFECYCLE_PROGRAM_DISABLED","A current explicit organization opt-in is required before reviewing a private schedule.",409);
  const previous = input.scheduleId ? await lifecycleOwnedSchedule(tx,identity,input.scheduleId,undefined,write) : null;
  if (previous) {
    lifecycleVersion(previous.head.version,input.expectedVersion,"schedule"); lifecycleVersion(previous.definition.definition_version,input.expectedDefinitionVersion,"definition");
    const permission = await checkLifecycleCaller(tx,request,identity,previous.head,previous.definition,true);
    if (!permission.allowed) throw new DomainError(permission.code!,permission.reason!,410);
  }
  const proposal=input.proposal,target=proposal.target,pins=target.kind==="project_treasurer"?[target.link]:target.links;
  let project: OrganizationProjectAuthority|null=null;
  if (target.kind==="project_treasurer") {
    if(request.projectScope!==target.expectedProjectScope)throw new DomainError("LIFECYCLE_PROJECT_CHANGED","Keep the independently current project header and exact reviewed scope together.",409);
    project=await requireOrganizationProject(tx,request,target.expectedProjectScope);
    if(project.session.projectId!==target.projectId)throw new DomainError("LIFECYCLE_PROJECT_CHANGED","This schedule belongs to the independently held original project.",409);
  }
  await lockLifecycleSources(tx,identity,pins);
  if(project&&target.kind==="project_treasurer")await assertOrganizationProjectBasis(tx,project.session,target.expectedProjectBasis);
  const source=await collectLifecycleSource(tx,identity,request,proposal);
  if(target.kind==="organization_aggregate"&&source.snapshot.basisHash!==target.expectedBasisHash)throw new DomainError("LIFECYCLE_SOURCE_CHANGED","The aggregate source changed. Refresh its exact target before preparing a new schedule.",409);
  const unavailable=await checkLifecycleSource(tx,identity,source);
  if(unavailable.length)throw new DomainError("LIFECYCLE_SOURCE_WITHDRAWN",unavailable.join(" ").slice(0,1000),410);
  const at=await orgNow(tx), organizationExpiresAt=new Date(Math.min(identity.session.expires_at.getTime(),identity.member.expires_at.getTime())).toISOString();
  const expiresAt=lifecycleFixedDeadline({requestedExpiresAt:proposal.expiresAt,organizationExpiresAt,programExpiresAt:program.view.expiresAt,projectExpiresAt:project?.session.expiresAt??null,links:pins});
  const blockers:string[]=[];
  if(Date.parse(proposal.cadence.firstDueAt)<=at.getTime())blockers.push("Choose a future original first due time; a past schedule cannot be reconstructed.");
  if(Date.parse(expiresAt)<=Date.parse(proposal.cadence.firstDueAt))blockers.push("The first due time must precede every original profile, program and disclosure deadline.");
  const body:Omit<C.LifecycleScheduleReview,"reviewHash">={input,sourceBasisHash:source.snapshot.basisHash,checkedAt:at.toISOString(),
    authorization:{organizationRole:identity.member.role as "owner"|"coordinator",organizationMembershipVersion:identity.member.version,organizationExpiresAt,programVersion:program.view.version,programExpiresAt:program.view.expiresAt,
      project:project?{role:"organizer",membershipVersion:project.membershipVersion,expiresAt:project.session.expiresAt}:null,links:pins,expiresAt},
    targetLabel:source.snapshot.targetLabel,sourceSummary:[`${source.snapshot.sources.length} permitted scalar sources support ${source.snapshot.statements.length} cited factual sentences.`,`${pins.length} exact project disclosures are pinned; later affiliations cannot widen this audience.`],
    warnings:[...source.snapshot.notices,...(expiresAt!==proposal.expiresAt?[`The original authorization ends at ${expiresAt}, before the requested schedule deadline.`]:[])],blockers,canEnable:blockers.length===0};
  const review=C.lifecycleScheduleReviewSchema.parse({...body,reviewHash:lifecycleReviewHash(body)});
  await assertOrganizationCurrent(tx,request,identity);if(project)await assertOrganizationProjectCurrent(tx,request,project);
  return {identity,project,source,review,previous};
}
export async function prepareLifecycleSchedule(request:LifecycleRequest,raw:unknown) {
  const input=C.lifecycleSchedulePrepareSchema.parse(raw),prepared=await lifecycleSourceTx(tx=>prepareWithin(tx,request,input,false));
  return lifecycleSourceTx(async tx=>{
    const identity=await requireLifecycleOrganization(tx,request,input.expectedScope);
    if(identity.scope!==prepared.identity.scope)throw new DomainError("LIFECYCLE_ORGANIZATION_CHANGED","The original organization profile changed during preparation.",409);
    await lifecycleLinks(tx,identity,prepared.review.authorization.links,true);
    const issues=await checkLifecycleSource(tx,identity,prepared.source);
    if(issues.length)throw new DomainError("LIFECYCLE_SOURCE_WITHDRAWN",issues.join(" ").slice(0,1000),410);
    const program=await readLifecycleProgram(tx,identity);
    if(program.view.state!=="enabled"||program.view.version!==input.expectedProgramVersion)throw new DomainError("LIFECYCLE_PROGRAM_DISABLED","The original organization opt-in changed during preparation.",409);
    await assertOrganizationCurrent(tx,request,identity);if(prepared.project)await assertOrganizationProjectCurrent(tx,request,prepared.project);
    if(Date.parse(prepared.review.authorization.expiresAt)<=(await orgNow(tx)).getTime())throw new DomainError("LIFECYCLE_EXPIRED","The original authorization ended during preparation.",410);
    return {review:prepared.review};
  },false);
}
async function scheduleEvent(tx:OrgTx,head:LifecycleScheduleHead,definitionVersion:number,actor:string,action:string,data:unknown,at:Date) {
  const id=randomUUID();
  await tx.query("INSERT INTO fp_lifecycle_schedule_events(id,schedule_id,definition_version,schedule_version,actor_key,action,encrypted_data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [id,head.id,definitionVersion,head.version,actor,action,sealPrivate(data,lifecyclePrivateContext("schedule-event",id)),at]);
}

export async function enableLifecycleSchedule(request:LifecycleRequest,raw:unknown) {
  const input=C.lifecycleScheduleEnableSchema.parse(raw);
  return lifecycleSourceTx(async tx=>{
    await lifecycleWritable(tx);
    const identity=await requireLifecycleOrganization(tx,request,input.expectedScope,true),actor=lifecycleActor(identity);
    const prior=await findLifecycleCommand(tx,actor,input,"schedule_enable");
    if(prior){await assertOrganizationCurrent(tx,request,identity);return {receipt:prior};}
    const prepared=await prepareWithin(tx,request,input.review,true),review=prepared.review,proposal=review.input.proposal;
    if(!review.canEnable)throw new DomainError("LIFECYCLE_REVIEW_REQUIRED",review.blockers.join(" ").slice(0,1000),409);
    if(review.reviewHash!==input.reviewHash)throw new DomainError("LIFECYCLE_SOURCE_CHANGED","The exact reviewed source or authority changed. Prepare the current definition before enabling it.",409);
    const at=await orgNow(tx),previous=prepared.previous,head:LifecycleScheduleHead=previous?{...previous.head,version:previous.head.version+1,current_definition_version:previous.head.current_definition_version+1,state:"enabled",updated_at:at}
      :{id:randomUUID(),organization_id:identity.organization.id,owner_membership_id:identity.member.id,version:1,current_definition_version:1,state:"enabled",created_at:at,updated_at:at};
    if(previous)await tx.query("UPDATE fp_lifecycle_schedules SET version=$2,current_definition_version=$3,state='enabled',updated_at=$4 WHERE id=$1",[head.id,head.version,head.current_definition_version,at]);
    else await tx.query("INSERT INTO fp_lifecycle_schedules(id,organization_id,owner_membership_id,version,current_definition_version,state,created_at,updated_at) VALUES($1,$2,$3,1,1,'enabled',$4,$4)",[head.id,head.organization_id,head.owner_membership_id,at]);
    const definitionId=randomUUID(),grant:LifecycleDelegation={request:lifecycleCredential(request,proposal.target.kind==="project_treasurer"),review,
      organizationSessionId:identity.session.id,organizationMembershipId:identity.member.id,projectSessionId:prepared.project?.session.id??null,bindingHash:""};
    grant.bindingHash=orgHash(grant);
    await tx.query(`INSERT INTO fp_lifecycle_schedule_versions(id,schedule_id,organization_id,definition_version,definition_hash,review_hash,audience,
      issuer_session_id,issuer_membership_id,issuer_membership_version,issuer_role,project_session_id,program_version,first_due_at,interval_minutes,expires_at,encrypted_data,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [definitionId,head.id,head.organization_id,head.current_definition_version,lifecycleDefinitionHash(proposal),review.reviewHash,proposal.target.kind,
        identity.session.id,identity.member.id,identity.member.version,identity.member.role,grant.projectSessionId,review.authorization.programVersion,
        proposal.cadence.firstDueAt,proposal.cadence.intervalMinutes,review.authorization.expiresAt,sealPrivate(grant,lifecyclePrivateContext("definition",definitionId)),at]);
    await scheduleEvent(tx,head,head.current_definition_version,actor,previous?"replaced":"enabled",{definitionId,reviewHash:review.reviewHash,previousDefinitionVersion:previous?.definition.definition_version??null,originalExpiresAt:review.authorization.expiresAt},at);
    await lifecycleAudit(tx,{organizationId:identity.organization.id},actor,"schedule_enable",head.id,{definitionId,definitionVersion:head.current_definition_version,reviewHash:review.reviewHash,originalExpiresAt:review.authorization.expiresAt,delivery:"private_draft_only"});
    const receipt=await saveLifecycleCommand(tx,actor,input,"schedule_enable",{resourceId:head.id,resourceVersion:head.version,message:"This exact private schedule is enabled until its original fixed deadline. Due slots retain their own identity; no email or automatic model request is authorized."});
    await assertOrganizationCurrent(tx,request,identity);if(prepared.project)await assertOrganizationProjectCurrent(tx,request,prepared.project);
    const finalAt=await orgNow(tx);
    if(finalAt.getTime()>=Date.parse(review.authorization.expiresAt)||finalAt.getTime()>=Date.parse(proposal.cadence.firstDueAt))throw new DomainError("LIFECYCLE_EXPIRED","The reviewed first due time or original authorization passed while enabling. Prepare a new future decision without changing this request.",409);
    return {receipt};
  },true);
}

/** State events retain exact original windows even if the worker was offline.
 * A later resume never fills a paused slot with a new source capture. */
export async function lifecycleTimeline(tx:OrgTx,head:LifecycleScheduleHead,definition:LifecycleDefinition) {
  const rows=await query<{definition_version:number;action:string;created_at:Date}>("SELECT definition_version,action,created_at FROM fp_lifecycle_schedule_events WHERE schedule_id=$1 ORDER BY schedule_version",[head.id],tx);
  const pauses:LifecyclePause[]=[],disabledAt=rows.find(row=>row.definition_version>definition.definition_version||row.definition_version===definition.definition_version&&row.action==="disabled")?.created_at.toISOString()??null;
  let pausedAt:string|null=null;
  for(const row of rows.filter(value=>value.definition_version===definition.definition_version)) {
    if(row.action==="paused")pausedAt=row.created_at.toISOString();
    if(row.action==="resumed"&&pausedAt){pauses.push({pausedAt,resumedAt:row.created_at.toISOString()});pausedAt=null;}
  }
  if(pausedAt)pauses.push({pausedAt,resumedAt:null});
  return {pauses,disabledAt};
}
export async function lifecycleDue(tx:OrgTx,head:LifecycleScheduleHead,definition:LifecycleDefinition,observedAt:Date,limit=C.LIFECYCLE_PAGE_SIZE) {
  const [last]=await query<{due:Date|null}>("SELECT MAX(due_at) AS due FROM fp_lifecycle_occurrences WHERE schedule_id=$1 AND definition_version=$2",[head.id,definition.definition_version],tx),timeline=await lifecycleTimeline(tx,head,definition);
  return dueLifecycleSlots({scheduleId:head.id,definitionVersion:definition.definition_version,cadence:lifecycleDelegation(definition).review.input.proposal.cadence,
    expiresAt:definition.expires_at.toISOString(),afterDueAt:last?.due?.toISOString()??null,observedAt:observedAt.toISOString(),...timeline,limit});
}

async function scheduleView(tx:OrgTx,request:LifecycleRequest,identity:OrgIdentity,head:LifecycleScheduleHead,definition:LifecycleDefinition,privateDetail:boolean):Promise<C.LifecycleSchedule> {
  const caller=await checkLifecycleCaller(tx,request,identity,head,definition,privateDetail),program=await readLifecycleProgram(tx,identity);
  const production=caller.allowed?(await checkLifecycleDelegation(tx,head,definition,"produce")).permission:null,at=await orgNow(tx);
  let state:C.LifecycleSchedule["state"]=head.state,access:C.LifecycleSchedule["access"]=caller.allowed?"ready":definition.audience==="project_treasurer"&&caller.code==="LIFECYCLE_PROJECT_CHANGED"?"project_profile_required":"authority_ended";
  if(definition.expires_at<=at)state="expired";
  else if(caller.code==="LIFECYCLE_SOURCE_WITHDRAWN")state="disclosure_suspended";
  else if(caller.code==="LIFECYCLE_ORGANIZATION_CHANGED"||caller.code==="LIFECYCLE_AUTHORITY_ENDED")state="authority_changed";
  const ended=["expired","authority_changed","disclosure_suspended"].includes(state);
  if(ended)access="authority_ended";
  const ready=access==="ready",grant=ready?lifecycleDelegation(definition):null;
  const reasons=[...(caller.reason?[caller.reason]:[]),...(state==="expired"?["The original fixed deadline ended. Saved history remains retained; no retry renews it."]:[]),...(ready&&!production?.allowed&&production?.reason?[production.reason]:[])];
  const step=definition.interval_minutes*60_000,next=Math.max(0,Math.floor((at.getTime()-definition.first_due_at.getTime())/step)+1)*step+definition.first_due_at.getTime();
  return C.lifecycleScheduleSchema.parse({id:head.id,version:head.version,definitionVersion:definition.definition_version,definitionHash:definition.definition_hash,audience:definition.audience,state,access,
    definition:grant?.review.input.proposal??null,authorization:grant?.review.authorization??null,targetLabel:grant?.review.targetLabel??null,
    nextDueAt:ready&&head.state==="enabled"&&production?.allowed&&next<definition.expires_at.getTime()?new Date(next).toISOString():null,createdAt:head.created_at.toISOString(),
    canPause:head.state==="enabled"&&!ended,canResume:ready&&head.state==="paused"&&program.view.state==="enabled"&&program.view.version===definition.program_version,
    canDisable:head.state!=="disabled",canReplace:ready&&program.view.state==="enabled",reasons:[...new Set(reasons)]});
}
function atScheduleResponse(value:C.LifecycleSchedule,at:Date,expiresAt=value.authorization?.expiresAt):C.LifecycleSchedule {
  if(!expiresAt||Date.parse(expiresAt)>at.getTime())return value;
  return {...value,state:"expired",access:"authority_ended",definition:null,authorization:null,targetLabel:null,nextDueAt:null,canPause:false,canResume:false,canReplace:false,
    reasons:[...new Set([...value.reasons,"The original fixed deadline ended. Saved history cannot renew it."])]};
}
export async function lifecycleSchedules(request:LifecycleRequest,before?:string) {
  return lifecycleTx(async tx=>{
    const identity=await requireLifecycleOrganization(tx,request),owner=`lifecycle-schedules:${identity.scope}`,cursor=orgCursor(before,owner);
    const rows=await query<LifecycleScheduleHead>(`SELECT * FROM fp_lifecycle_schedules WHERE organization_id=$1 AND owner_membership_id=$2
      AND ($3::timestamptz IS NULL OR (date_trunc('milliseconds',created_at),id)<($3::timestamptz,$4::text)) ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT 21`,
      [identity.organization.id,identity.member.id,cursor?.at??null,cursor?.id??null],tx),page=orgPage(rows,owner),schedules:C.LifecycleSchedule[]=[];
    for(const row of page.rows){const current=await lifecycleOwnedSchedule(tx,identity,row.id);schedules.push(await scheduleView(tx,request,identity,current.head,current.definition,false));}
    const program=(await readLifecycleProgram(tx,identity)).view;
    await assertOrganizationCurrent(tx,request,identity);
    const at=await orgNow(tx);
    return {desk:C.lifecycleScheduleDeskSchema.parse({scope:identity.scope,checkedAt:at.toISOString(),program,schedules:schedules.map(value=>atScheduleResponse(value,at)),nextCursor:page.nextCursor,canPrepare:program.state==="enabled"})};
  });
}
export async function lifecycleScheduleDetail(request:LifecycleRequest,id:string) {
  return lifecycleTx(async tx=>{
    const identity=await requireLifecycleOrganization(tx,request),current=await lifecycleOwnedSchedule(tx,identity,id),schedule=await scheduleView(tx,request,identity,current.head,current.definition,true);
    await assertOrganizationCurrent(tx,request,identity);
    return {schedule:atScheduleResponse(schedule,await orgNow(tx),current.definition.expires_at.toISOString())};
  });
}

export async function changeLifecycleSchedule(request:LifecycleRequest,id:string,raw:unknown) {
  const input=C.lifecycleScheduleActionSchema.parse(raw),binding={id,input};
  return lifecycleTx(async tx=>{
    await lifecycleWritable(tx);
    const identity=await requireLifecycleOrganization(tx,request,input.expectedScope,true),actor=lifecycleActor(identity),prior=await findLifecycleCommand(tx,actor,input,"schedule_action",binding);
    if(prior){await assertOrganizationCurrent(tx,request,identity);return {receipt:prior};}
    const {head,definition}=await lifecycleOwnedSchedule(tx,identity,id,undefined,true);
    lifecycleVersion(head.version,input.expectedVersion,"schedule");lifecycleVersion(definition.definition_version,input.expectedDefinitionVersion,"definition");
    if(definition.definition_hash!==input.definitionHash)throw new DomainError("LIFECYCLE_SOURCE_CHANGED","This is no longer the exact reviewed schedule definition.",409);
    if(head.state==="disabled"||input.action==="pause"&&head.state!=="enabled"||input.action==="resume"&&head.state!=="paused")throw new DomainError("LIFECYCLE_SCHEDULE_DISABLED","Review the current schedule state. A disabled definition cannot be revived.",409);
    if(input.action==="resume") {
      if(definition.audience==="project_treasurer"&&request.projectScope!==input.expectedProjectScope)throw new DomainError("LIFECYCLE_PROJECT_CHANGED","Resume requires the independently held original project scope.",409);
      const caller=await checkLifecycleCaller(tx,request,identity,head,definition,true);
      if(!caller.allowed)throw new DomainError(caller.code!,caller.reason!,410);
      const production=(await checkLifecycleDelegation(tx,{...head,state:"enabled"},definition,"produce")).permission;
      if(!production.allowed)throw new DomainError(production.code!,production.reason!,409);
    }
    const at=await orgNow(tx),state=input.action==="pause"?"paused":input.action==="resume"?"enabled":"disabled",updated={...head,version:head.version+1,state,updated_at:at} as LifecycleScheduleHead;
    await tx.query("UPDATE fp_lifecycle_schedules SET version=$2,state=$3,updated_at=$4 WHERE id=$1",[id,updated.version,state,at]);
    await scheduleEvent(tx,updated,definition.definition_version,actor,input.action==="pause"?"paused":input.action==="resume"?"resumed":"disabled",{reason:input.reason,originalExpiresAt:definition.expires_at.toISOString()},at);
    await lifecycleAudit(tx,{organizationId:identity.organization.id},actor,"schedule_action",id,{action:input.action,reason:input.reason,definitionVersion:definition.definition_version,originalExpiresAt:definition.expires_at.toISOString()});
    const receipt=await saveLifecycleCommand(tx,actor,input,"schedule_action",{resourceId:id,resourceVersion:updated.version,message:input.action==="resume"?"The original schedule resumes at its next original slot. Paused slots stay skipped and the fixed deadline is unchanged.":input.action==="pause"?"This schedule is paused. Due slots remain recorded as skipped; no replacement historical source is captured.":"This definition is disabled. Its original occurrences and fixed deadlines remain retained."},binding);
    await assertOrganizationCurrent(tx,request,identity);
    if(input.action==="resume"){
      const permission=(await checkLifecycleDelegation(tx,updated,definition,"produce")).permission;
      if(!permission.allowed)throw new DomainError(permission.code!,permission.reason!,410);
    }
    return {receipt};
  });
}
