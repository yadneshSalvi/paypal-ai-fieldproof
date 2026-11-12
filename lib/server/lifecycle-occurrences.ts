import {randomUUID} from "node:crypto";
import * as C from "../lifecycle/contracts";
import {lifecycleRetryAllowed} from "../lifecycle/schedule";
import {DomainError} from "../domain/money";
import {query} from "./db";
import {sealPrivate} from "./private-values";
import {assertOrganizationCurrent,orgCursor,orgNow,orgPage,type OrgIdentity,type OrgTx} from "./organization-core";
import {checkLifecycleCaller,checkLifecycleDelegation,lifecycleDelegation} from "./lifecycle-authority";
import {findLifecycleCommand,lifecycleActor,lifecycleAudit,lifecyclePrivateContext,lifecycleUnavailable,lifecycleVersion,lifecycleWritable,requireLifecycleOrganization,saveLifecycleCommand,type LifecycleAttemptRow,type LifecycleOccurrenceRow,type LifecycleRequest} from "./lifecycle-core";
import {lifecycleOwnedOccurrence,readLifecycleCapture,readLifecycleContent,type LifecycleOwnedOccurrence} from "./lifecycle-records";
import {checkLifecycleSource,collectLifecycleSource,lifecycleSourceTx} from "./lifecycle-sources";
import {lockLifecycleSources} from "./lifecycle-schedules";

const attemptView=(row:LifecycleAttemptRow):C.LifecycleAttempt=>C.lifecycleAttemptSchema.parse({attempt:row.ordinal,startedAt:row.started_at.toISOString(),completedAt:row.completed_at?.toISOString()??null,stage:row.stage,outcome:row.outcome,code:row.code,nextRetryAt:row.next_retry_at?.toISOString()??null});
async function attemptPage(tx:OrgTx,identity:OrgIdentity,occurrence:LifecycleOccurrenceRow,before?:string) {
  const owner=`lifecycle-attempts:${identity.scope}:${occurrence.id}`,cursor=orgCursor(before,owner);
  const rows=await query<LifecycleAttemptRow&{created_at:Date}>(`SELECT *,started_at AS created_at FROM fp_lifecycle_attempts WHERE occurrence_id=$1
    AND ($2::timestamptz IS NULL OR (date_trunc('milliseconds',started_at),id)<($2::timestamptz,$3::text))
    ORDER BY date_trunc('milliseconds',started_at) DESC,id DESC LIMIT 21`,[occurrence.id,cursor?.at??null,cursor?.id??null],tx),page=orgPage(rows,owner);
  return {attempts:page.rows.map(attemptView),nextCursor:page.nextCursor};
}
async function occurrenceView(tx:OrgTx,request:LifecycleRequest,identity:OrgIdentity,current:LifecycleOwnedOccurrence,privateDetail:boolean) {
  const {head,definition,occurrence}=current,permission=await checkLifecycleCaller(tx,request,identity,head,definition,privateDetail),at=await orgNow(tx);
  let status:C.LifecycleOccurrence["status"]=permission.allowed?"current":permission.code==="LIFECYCLE_SOURCE_WITHDRAWN"?"withdrawn":"unavailable";
  const reasons:string[]=permission.reason?[permission.reason]:[];
  if(occurrence.expires_at<=at){status="unavailable";reasons.push("The original authorization ended. Retry, history and restore cannot renew that deadline.");}
  let capture:Awaited<ReturnType<typeof readLifecycleCapture>>=null,content:Awaited<ReturnType<typeof readLifecycleContent>>=null;
  const grant=permission.allowed?lifecycleDelegation(definition):null;
  if(status==="current"&&grant) {
    await lockLifecycleSources(tx,identity,grant.review.authorization.links);
    capture=await readLifecycleCapture(tx,occurrence);
    if(capture) {
      const issues=await checkLifecycleSource(tx,identity,capture.source);
      if(issues.length){status="withdrawn";reasons.push(...issues);}
      else {
        const latest=await collectLifecycleSource(tx,identity,request,grant.review.input.proposal);
        if(latest.snapshot.basisHash!==capture.source.snapshot.basisHash){status="historical";reasons.push("Later permitted project records changed the current source. This original capture and its private wording remain fixed.");}
        content=await readLifecycleContent(tx,occurrence,capture);
      }
    }
  }
  if(occurrence.state==="blocked_source"){status="withdrawn";reasons.push("This original occurrence was blocked by its source permission. A later disclosure cannot silently revive it.");}
  if(['blocked_authority','expired','cancelled'].includes(occurrence.state)&&!occurrence.captured_at)reasons.push("No successful private capture is recorded for this original terminal slot.");
  const production=status==="current"||status==="historical"?(await checkLifecycleDelegation(tx,head,definition,"produce")).permission:null;
  const attempts=await attemptPage(tx,identity,occurrence);
  const final=await checkLifecycleCaller(tx,request,identity,head,definition,privateDetail),finalAt=await orgNow(tx);
  if(!final.allowed||occurrence.expires_at<=finalAt){status=final.code==="LIFECYCLE_SOURCE_WITHDRAWN"?"withdrawn":"unavailable";if(final.reason)reasons.push(final.reason);}
  const visible=status==="current"||status==="historical",canRetry=visible&&production?.allowed&&['retry_wait','failed'].includes(occurrence.state);
  const value:C.LifecycleOccurrence=C.lifecycleOccurrenceSchema.parse({id:occurrence.id,version:occurrence.version,scheduleId:head.id,definitionVersion:definition.definition_version,occurrenceKey:occurrence.occurrence_key,audience:occurrence.audience,
    dueAt:occurrence.due_at.toISOString(),recordedAt:occurrence.created_at.toISOString(),state:occurrence.state,status,
    title:visible?content?.content.title??grant?.review.input.proposal.title??null:null,targetLabel:visible?capture?.source.snapshot.targetLabel??grant?.review.targetLabel??null:null,
    provenance:visible&&capture?[...new Set(capture.source.snapshot.sources.map(row=>row.provenance))]:[],capturedAt:visible?occurrence.captured_at?.toISOString()??null:null,snapshotHash:visible?occurrence.snapshot_hash:null,contentHash:visible?occurrence.content_hash:null,
    readState:occurrence.read_state,review:status==="historical"?"historical":occurrence.review_state,authorizationExpiresAt:occurrence.expires_at.toISOString(),totalAttempts:occurrence.attempt_count,attempts:attempts.attempts,attemptsNextCursor:attempts.nextCursor,nextRetryAt:occurrence.next_retry_at?.toISOString()??null,
    canRetry:!!canRetry,canReview:visible&&status==="current"&&occurrence.state==="ready"&&!!content,canRead:visible&&occurrence.state==="ready"&&!!content,canArchive:occurrence.read_state!=="archived",canRestore:occurrence.read_state==="archived",reasons:[...new Set(reasons)]});
  return {value,capture:visible?capture:null,content:visible?content:null};
}
/** Locks retain permission rows during this response, but elapsed time still
 * matters. A slow later read must not disclose an earlier item's expired body. */
function atResponseDeadline(value:C.LifecycleOccurrence,at:Date):C.LifecycleOccurrence {
  if(Date.parse(value.authorizationExpiresAt)>at.getTime()||!["current","historical"].includes(value.status))return value;
  return {...value,status:"unavailable",title:null,targetLabel:null,provenance:[],capturedAt:null,snapshotHash:null,contentHash:null,canRetry:false,canReview:false,canRead:false,
    reasons:[...new Set([...value.reasons,"The original authorization ended while this view was prepared. Its private content is withheld."])]};
}
export async function lifecycleOccurrences(request:LifecycleRequest,before?:string) {
  return lifecycleSourceTx(async tx=>{
    const identity=await requireLifecycleOrganization(tx,request),owner=`lifecycle-occurrences:${identity.scope}`,cursor=orgCursor(before,owner);
    const rows=await query<LifecycleOccurrenceRow>(`SELECT o.* FROM fp_lifecycle_occurrences o JOIN fp_lifecycle_schedules s ON s.id=o.schedule_id AND s.organization_id=o.organization_id
      WHERE o.organization_id=$1 AND s.owner_membership_id=$2 AND ($3::timestamptz IS NULL OR(date_trunc('milliseconds',o.created_at),o.id)<($3::timestamptz,$4::text))
      ORDER BY date_trunc('milliseconds',o.created_at) DESC,o.id DESC LIMIT 21`,[identity.organization.id,identity.member.id,cursor?.at??null,cursor?.id??null],tx),page=orgPage(rows,owner),occurrences:C.LifecycleOccurrence[]=[];
    for(const row of page.rows){const current=await lifecycleOwnedOccurrence(tx,identity,row.id);occurrences.push((await occurrenceView(tx,request,identity,current,false)).value);}
    await assertOrganizationCurrent(tx,request,identity);
    const at=await orgNow(tx);
    return {page:C.lifecycleOccurrencePageSchema.parse({scope:identity.scope,checkedAt:at.toISOString(),occurrences:occurrences.map(value=>atResponseDeadline(value,at)),nextCursor:page.nextCursor})};
  });
}
export async function lifecycleOccurrenceDetail(request:LifecycleRequest,id:string) {
  return lifecycleSourceTx(async tx=>{
    const identity=await requireLifecycleOrganization(tx,request),current=await lifecycleOwnedOccurrence(tx,identity,id),view=await occurrenceView(tx,request,identity,current,true);
    await assertOrganizationCurrent(tx,request,identity);
    const at=await orgNow(tx),occurrence=atResponseDeadline(view.value,at),visible=["current","historical"].includes(occurrence.status);
    return {detail:C.lifecycleOccurrenceDetailSchema.parse({scope:identity.scope,checkedAt:at.toISOString(),occurrence,content:visible?view.content?.content??null:null,sources:visible&&view.content?view.capture?.source.snapshot.sources??[]:[]})};
  });
}
export async function lifecycleOccurrenceSource(request:LifecycleRequest,id:string,sourceId:string) {
  return lifecycleSourceTx(async tx=>{
    const identity=await requireLifecycleOrganization(tx,request),current=await lifecycleOwnedOccurrence(tx,identity,id),view=await occurrenceView(tx,request,identity,current,true);
    if(!['current','historical'].includes(view.value.status)||!view.capture||!view.content)throw new DomainError("LIFECYCLE_SOURCE_WITHDRAWN","This original private source is no longer available under its exact current authority and permission.",410);
    const source=view.capture.source.snapshot.sources.find(row=>row.id===sourceId);if(!source)throw lifecycleUnavailable();
    await assertOrganizationCurrent(tx,request,identity);
    if(current.occurrence.expires_at<=await orgNow(tx))throw new DomainError("LIFECYCLE_EXPIRED","The original source authorization ended while this view was prepared. Its private content is withheld.",410);
    return {detail:C.lifecycleSourceDetailSchema.parse({scope:identity.scope,source,asOf:view.capture.source.snapshot.asOf,snapshotHash:view.capture.row.snapshot_hash,status:view.value.status,notices:view.capture.source.snapshot.notices})};
  });
}
export async function lifecycleOccurrenceAttempts(request:LifecycleRequest,id:string,before?:string) {
  return lifecycleSourceTx(async tx=>{
    const identity=await requireLifecycleOrganization(tx,request),{occurrence}=await lifecycleOwnedOccurrence(tx,identity,id),page=await attemptPage(tx,identity,occurrence,before);
    await assertOrganizationCurrent(tx,request,identity);
    return {page:C.lifecycleAttemptPageSchema.parse({scope:identity.scope,occurrenceId:id,occurrenceKey:occurrence.occurrence_key,total:occurrence.attempt_count,attempts:page.attempts,nextCursor:page.nextCursor})};
  });
}

function exactOccurrence(occurrence:LifecycleOccurrenceRow,input:{expectedVersion:number;occurrenceKey:string}) {
  lifecycleVersion(occurrence.version,input.expectedVersion,"original occurrence");
  if(occurrence.occurrence_key!==input.occurrenceKey)throw new DomainError("LIFECYCLE_OCCURRENCE_CHANGED","Keep the exact original due-slot identity for this decision.",409);
}
function exactProject(request:LifecycleRequest,current:LifecycleOwnedOccurrence,expected:string|null) {
  if(current.definition.audience==="project_treasurer"&&(!expected||request.projectScope!==expected))throw new DomainError("LIFECYCLE_PROJECT_CHANGED","This decision needs the exact independently held original project header and reviewed scope.",409);
  if(current.definition.audience==="organization_aggregate"&&expected!==null)throw new DomainError("LIFECYCLE_PROJECT_CHANGED","An aggregate decision has no inherited project-profile scope.",409);
}
export async function retryLifecycleOccurrence(request:LifecycleRequest,id:string,raw:unknown) {
  const input=C.lifecycleOccurrenceRetrySchema.parse(raw),binding={id,input};
  return lifecycleSourceTx(async tx=>{
    await lifecycleWritable(tx);const identity=await requireLifecycleOrganization(tx,request,input.expectedScope,true),actor=lifecycleActor(identity),prior=await findLifecycleCommand(tx,actor,input,"occurrence_retry",binding);
    if(prior){await assertOrganizationCurrent(tx,request,identity);return {receipt:prior};}
    const current=await lifecycleOwnedOccurrence(tx,identity,id,true);exactOccurrence(current.occurrence,input);exactProject(request,current,input.expectedProjectScope);
    const caller=await checkLifecycleCaller(tx,request,identity,current.head,current.definition,true);if(!caller.allowed)throw new DomainError(caller.code!,caller.reason!,410);
    const production=(await checkLifecycleDelegation(tx,current.head,current.definition,"produce")).permission;if(!production.allowed)throw new DomainError(production.code!,production.reason!,409);
    const capture=await readLifecycleCapture(tx,current.occurrence);if(capture&&(await checkLifecycleSource(tx,identity,capture.source)).length)throw new DomainError("LIFECYCLE_SOURCE_WITHDRAWN","The saved source is no longer permitted; a retry cannot capture replacement historical facts.",410);
    const allowed=lifecycleRetryAllowed({occurrenceKey:current.occurrence.occurrence_key,requestedOccurrenceKey:input.occurrenceKey,savedSnapshotHash:current.occurrence.snapshot_hash,requestedSnapshotHash:input.expectedSnapshotHash,state:current.occurrence.state,knownModelResponse:false,modelDispatched:false,
      authorizationExpiresAt:current.occurrence.expires_at.toISOString(),observedAt:(await orgNow(tx)).toISOString(),nextRetryAt:current.occurrence.next_retry_at?.toISOString()??null});
    if(!allowed.allowed)throw new DomainError(allowed.code!,allowed.reason!,409);
    await tx.query("UPDATE fp_lifecycle_occurrences SET version=version+1,state='due',next_retry_at=NULL,last_code=NULL,updated_at=clock_timestamp() WHERE id=$1",[id]);
    await lifecycleAudit(tx,{organizationId:identity.organization.id},actor,"occurrence_retry",id,{occurrenceKey:input.occurrenceKey,originalSnapshotHash:input.expectedSnapshotHash,originalExpiresAt:current.occurrence.expires_at.toISOString()});
    const receipt=await saveLifecycleCommand(tx,actor,input,"occurrence_retry",{resourceId:id,resourceVersion:current.occurrence.version+1,message:"The same original occurrence is queued. Any saved capture and original authorization deadline remain unchanged; no model request or email was submitted."},binding);
    await assertOrganizationCurrent(tx,request,identity);
    const final=(await checkLifecycleDelegation(tx,current.head,current.definition,"produce")).permission;if(!final.allowed)throw new DomainError(final.code!,final.reason!,410);
    return {receipt};
  },false);
}
export async function reviewLifecycleOccurrence(request:LifecycleRequest,id:string,raw:unknown) {
  const input=C.lifecycleOccurrenceReviewSchema.parse(raw),binding={id,input};
  return lifecycleSourceTx(async tx=>{
    await lifecycleWritable(tx);const identity=await requireLifecycleOrganization(tx,request,input.expectedScope,true),actor=lifecycleActor(identity),prior=await findLifecycleCommand(tx,actor,input,"occurrence_review",binding);
    if(prior){await assertOrganizationCurrent(tx,request,identity);return {receipt:prior};}
    const current=await lifecycleOwnedOccurrence(tx,identity,id,true);exactOccurrence(current.occurrence,input);exactProject(request,current,input.expectedProjectScope);
    const view=await occurrenceView(tx,request,identity,current,true);
    if(!view.value.canReview||view.value.snapshotHash!==input.snapshotHash||view.value.contentHash!==input.contentHash)throw new DomainError("LIFECYCLE_REVIEW_REQUIRED","Review the exact current private draft, original capture and cited sources before recording this decision.",409);
    const reviewId=randomUUID();
    await tx.query("INSERT INTO fp_lifecycle_reviews(id,occurrence_id,snapshot_hash,content_hash,actor_key,decision,encrypted_data) VALUES($1,$2,$3,$4,$5,$6,$7)",[reviewId,id,input.snapshotHash,input.contentHash,actor,input.decision,sealPrivate({note:input.note,sourcesChecked:true,privateDraftOnly:true,deliveryAuthorized:false},lifecyclePrivateContext("review",reviewId))]);
    await tx.query("UPDATE fp_lifecycle_occurrences SET version=version+1,review_state=$2,updated_at=clock_timestamp() WHERE id=$1",[id,input.decision]);
    await lifecycleAudit(tx,{organizationId:identity.organization.id},actor,"occurrence_review",id,{decision:input.decision,snapshotHash:input.snapshotHash,contentHash:input.contentHash,reviewId,privateDraftOnly:true});
    const receipt=await saveLifecycleCommand(tx,actor,input,"occurrence_review",{resourceId:id,resourceVersion:current.occurrence.version+1,message:input.decision==="reviewed_private"?"Your review is bound to this exact private draft and original source. It authorizes no external delivery or payment.":"Requested changes are recorded against this exact private draft. Its original wording and capture remain retained."},binding);
    await assertOrganizationCurrent(tx,request,identity);
    const final=await checkLifecycleCaller(tx,request,identity,current.head,current.definition,true);if(!final.allowed)throw new DomainError(final.code!,final.reason!,410);
    return {receipt};
  });
}
export async function changeLifecycleOccurrence(request:LifecycleRequest,id:string,raw:unknown) {
  const input=C.lifecycleOccurrenceActionSchema.parse(raw),binding={id,input};
  return lifecycleSourceTx(async tx=>{
    await lifecycleWritable(tx);const identity=await requireLifecycleOrganization(tx,request,input.expectedScope,true),actor=lifecycleActor(identity),prior=await findLifecycleCommand(tx,actor,input,"occurrence_state",binding);
    if(prior){await assertOrganizationCurrent(tx,request,identity);return {receipt:prior};}
    const current=await lifecycleOwnedOccurrence(tx,identity,id,true);exactOccurrence(current.occurrence,input);
    const view=await occurrenceView(tx,request,identity,current,input.action==="read"||input.expectedProjectScope!==null);
    if(input.action==="read")exactProject(request,current,input.expectedProjectScope);
    if(input.contentHash!==view.value.contentHash||input.action==="read"&&!view.value.canRead||input.action==="archive"&&!view.value.canArchive||input.action==="unarchive"&&!view.value.canRestore)throw new DomainError("LIFECYCLE_OCCURRENCE_CHANGED","Use the current original occurrence and permitted action. Archiving changes only its retained inbox state.",409);
    const state=input.action==="read"?"read":input.action==="archive"?"archived":"unread";
    await tx.query("UPDATE fp_lifecycle_occurrences SET version=version+1,read_state=$2,updated_at=clock_timestamp() WHERE id=$1",[id,state]);
    await lifecycleAudit(tx,{organizationId:identity.organization.id},actor,"occurrence_state",id,{action:input.action,previous:current.occurrence.read_state,next:state,occurrenceKey:current.occurrence.occurrence_key});
    const receipt=await saveLifecycleCommand(tx,actor,input,"occurrence_state",{resourceId:id,resourceVersion:current.occurrence.version+1,message:"The original occurrence's reading state is saved. Its source, financial records and fixed authority deadline are unchanged."},binding);
    await assertOrganizationCurrent(tx,request,identity);
    if(input.action==="read") {
      const final=await checkLifecycleCaller(tx,request,identity,current.head,current.definition,true);
      if(!final.allowed||current.occurrence.expires_at<=await orgNow(tx))throw new DomainError(final.code??"LIFECYCLE_EXPIRED",final.reason??"The original authorization ended before the read decision could be saved.",410);
    }
    return {receipt};
  });
}
