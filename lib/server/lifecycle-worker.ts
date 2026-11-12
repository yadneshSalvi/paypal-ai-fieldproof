import {randomUUID} from "node:crypto";
import * as C from "../lifecycle/contracts";
import {buildLifecycleDraft} from "../lifecycle/inbox";
import {DomainError} from "../domain/money";
import {query} from "./db";
import {sealPrivate} from "./private-values";
import {orgNow,type OrgTx} from "./organization-core";
import {checkLifecycleDelegation} from "./lifecycle-authority";
import {lifecycleActor,lifecycleAudit,lifecyclePrivateContext,lifecycleTx,lifecycleWritable,type LifecycleDefinition,type LifecycleOccurrenceRow,type LifecycleScheduleHead} from "./lifecycle-core";
import {lifecycleDue,lockLifecycleSources} from "./lifecycle-schedules";
import {checkLifecycleSource,collectLifecycleSource,lifecycleSourceTx} from "./lifecycle-sources";
import {readLifecycleCapture} from "./lifecycle-records";

const bounded=(value:number|undefined,defaultValue=20)=>{
  const limit=value??defaultValue;if(!Number.isInteger(limit)||limit<1||limit>20)throw new DomainError("INVALID_INPUT","Use a bounded lifecycle work page of one to twenty original records.",400);return limit;
};
const endedState=(code:string|null):C.LifecycleOccurrence["state"]=>code==="LIFECYCLE_EXPIRED"?"expired":code==="LIFECYCLE_SOURCE_WITHDRAWN"?"blocked_source":code==="LIFECYCLE_SCHEDULE_DISABLED"?"cancelled":"blocked_authority";
interface WorkerContext {head:LifecycleScheduleHead;definition:LifecycleDefinition;occurrence:LifecycleOccurrenceRow;}
export interface LifecycleWorkClaim {occurrenceId:string;leaseToken:string;attemptId:string;stage:"capture"|"draft";}
async function workContext(tx:OrgTx,id:string,lock=true):Promise<WorkerContext|null> {
  const [bound]=await query<{schedule_id:string;definition_id:string}>("SELECT schedule_id,definition_id FROM fp_lifecycle_occurrences WHERE id=$1",[id],tx);
  if(!bound)return null;
  const [head]=await query<LifecycleScheduleHead>(`SELECT * FROM fp_lifecycle_schedules WHERE id=$1${lock?" FOR UPDATE":" FOR SHARE"}`,[bound.schedule_id],tx);
  const [occurrence]=await query<LifecycleOccurrenceRow>(`SELECT * FROM fp_lifecycle_occurrences WHERE id=$1${lock?" FOR UPDATE":" FOR SHARE"}`,[id],tx);
  const [definition]=await query<LifecycleDefinition>("SELECT * FROM fp_lifecycle_schedule_versions WHERE id=$1 AND schedule_id=$2",[bound.definition_id,bound.schedule_id],tx);
  return head&&occurrence&&definition?{head,definition,occurrence}:null;
}
function requireClaim(current:WorkerContext|null,claim:LifecycleWorkClaim,at:Date):asserts current is WorkerContext {
  if(!current||current.occurrence.lease_token!==claim.leaseToken||!current.occurrence.lease_until||current.occurrence.lease_until<=at||!['capturing','drafting'].includes(current.occurrence.state))
    throw new DomainError("LIFECYCLE_BUSY","The original worker lease ended or another worker owns this same occurrence. Its saved source remains unchanged.",409);
}
async function terminalAttempt(tx:OrgTx,claim:LifecycleWorkClaim,outcome:"succeeded"|"retryable"|"blocked"|"failed",code:string|null,at:Date,retryAt:Date|null=null) {
  await tx.query("UPDATE fp_lifecycle_attempts SET outcome=$3,code=$4,completed_at=$5,next_retry_at=$6 WHERE id=$1 AND lease_token=$2 AND outcome='running'",[claim.attemptId,claim.leaseToken,outcome,code,at,retryAt]);
}
/** Materialization is provider/model-free. Each fixed slot is recorded before
 * the MAX(due_at) cursor can advance. Current permission never widens it. */
export async function materializeLifecycleSchedules(options:{limit?:number;slotsPerDefinition?:number}={}) {
  const limit=bounded(options.limit),slotsPerDefinition=bounded(options.slotsPerDefinition);
  const candidates=await lifecycleTx(tx=>query<{id:string;schedule_id:string}>(`SELECT d.id,d.schedule_id FROM fp_lifecycle_schedule_versions d
    LEFT JOIN LATERAL(SELECT MAX(due_at) AS last_due FROM fp_lifecycle_occurrences o WHERE o.definition_id=d.id) x ON true
    WHERE COALESCE(x.last_due+(d.interval_minutes*interval '1 minute'),d.first_due_at)<=clock_timestamp()
      AND COALESCE(x.last_due+(d.interval_minutes*interval '1 minute'),d.first_due_at)<d.expires_at
    ORDER BY COALESCE(x.last_due+(d.interval_minutes*interval '1 minute'),d.first_due_at),d.id LIMIT $1`,[limit],tx));
  let recorded=0;
  for(const candidate of candidates)recorded+=await lifecycleSourceTx(async tx=>{
    await lifecycleWritable(tx);
    const [head]=await query<LifecycleScheduleHead>("SELECT * FROM fp_lifecycle_schedules WHERE id=$1 FOR UPDATE",[candidate.schedule_id],tx);
    const [definition]=await query<LifecycleDefinition>("SELECT * FROM fp_lifecycle_schedule_versions WHERE id=$1 AND schedule_id=$2",[candidate.id,candidate.schedule_id],tx);
    if(!head||!definition)return 0;
    const at=await orgNow(tx),due=await lifecycleDue(tx,head,definition,at,slotsPerDefinition),grant=await checkLifecycleDelegation(tx,head,definition,"produce");
    for(const slot of due.slots) {
      let state:C.LifecycleOccurrence["state"]=slot.state,code:string|null=null;
      if(state==="due"&&!grant.permission.allowed&&grant.permission.code!=="LIFECYCLE_SCHEDULE_PAUSED") {state=endedState(grant.permission.code);code=grant.permission.code;}
      await tx.query(`INSERT INTO fp_lifecycle_occurrences(id,organization_id,schedule_id,definition_id,definition_version,occurrence_key,audience,due_at,expires_at,state,last_code,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,[randomUUID(),head.organization_id,head.id,definition.id,definition.definition_version,slot.occurrenceKey,definition.audience,slot.dueAt,definition.expires_at,state,code,at]);
    }
    return due.slots.length;
  },false);
  return {definitions: candidates.length,recorded,morePossible:candidates.length===limit};
}

/** A claim retains the same occurrence key and optional saved source. A timed
 * out worker gets a terminal attempt; it never gets a second business slot. */
export async function claimLifecycleOccurrence(id:string):Promise<LifecycleWorkClaim|null> {
  return lifecycleSourceTx(async tx=>{
    await lifecycleWritable(tx);
    const current=await workContext(tx,id);if(!current)return null;
    const {head,definition,occurrence}=current,at=await orgNow(tx);
    if(!['due','retry_wait','capturing','drafting'].includes(occurrence.state)||occurrence.lease_until&&occurrence.lease_until>at||occurrence.next_retry_at&&occurrence.next_retry_at>at)return null;
    if(occurrence.lease_token)await tx.query("UPDATE fp_lifecycle_attempts SET outcome='retryable',code='LIFECYCLE_LEASE_EXPIRED',completed_at=$2,next_retry_at=$2 WHERE occurrence_id=$1 AND outcome='running'",[id,at]);
    const grant=await checkLifecycleDelegation(tx,head,definition,"produce");
    if(!grant.permission.allowed) {
      if(grant.permission.code==="LIFECYCLE_SCHEDULE_PAUSED") {
        if(occurrence.lease_token)await tx.query("UPDATE fp_lifecycle_occurrences SET version=version+1,state='due',lease_token=NULL,lease_until=NULL,next_retry_at=NULL,last_code=$2,updated_at=$3 WHERE id=$1",[id,grant.permission.code,at]);
        return null;
      }
      await tx.query("UPDATE fp_lifecycle_occurrences SET version=version+1,state=$2,lease_token=NULL,lease_until=NULL,next_retry_at=NULL,last_code=$3,updated_at=$4 WHERE id=$1",[id,endedState(grant.permission.code),grant.permission.code,at]);return null;
    }
    const capture=await readLifecycleCapture(tx,occurrence);
    if(capture&&(await checkLifecycleSource(tx,grant.identity!,capture.source)).length){await tx.query("UPDATE fp_lifecycle_occurrences SET version=version+1,state='blocked_source',lease_token=NULL,lease_until=NULL,next_retry_at=NULL,last_code='LIFECYCLE_SOURCE_WITHDRAWN',updated_at=$2 WHERE id=$1",[id,at]);return null;}
    const claim:LifecycleWorkClaim={occurrenceId:id,leaseToken:randomUUID(),attemptId:randomUUID(),stage:capture?"draft":"capture"},until=new Date(Math.min(at.getTime()+45_000,occurrence.expires_at.getTime()));
    if(until<=at)return null;
    await tx.query("INSERT INTO fp_lifecycle_attempts(id,occurrence_id,ordinal,lease_token,stage,outcome,started_at) VALUES($1,$2,$3,$4,$5,'running',$6)",[claim.attemptId,id,occurrence.attempt_count+1,claim.leaseToken,claim.stage,at]);
    await tx.query("UPDATE fp_lifecycle_occurrences SET version=version+1,state=$2,attempt_count=attempt_count+1,lease_token=$3,lease_until=$4,next_retry_at=NULL,last_code=NULL,updated_at=$5 WHERE id=$1",[id,claim.stage==="capture"?"capturing":"drafting",claim.leaseToken,until,at]);
    return claim;
  },false);
}

export async function captureLifecycleOccurrence(claim:LifecycleWorkClaim) {
  if(claim.stage!=="capture")throw new DomainError("LIFECYCLE_OCCURRENCE_CHANGED","Retain this attempt's original capture stage.",409);
  const source=await lifecycleSourceTx(async tx=>{
    const current=await workContext(tx,claim.occurrenceId,false);requireClaim(current,claim,await orgNow(tx));
    const grant=await checkLifecycleDelegation(tx,current.head,current.definition,"produce");
    if(!grant.permission.allowed)throw new DomainError(grant.permission.code!,grant.permission.reason!,410);
    await lockLifecycleSources(tx,grant.identity!,grant.delegation.review.authorization.links);
    const source=await collectLifecycleSource(tx,grant.identity!,grant.delegation.request,grant.delegation.review.input.proposal);
    if(Date.parse(source.snapshot.asOf)<current.occurrence.due_at.getTime())throw new DomainError("LIFECYCLE_OCCURRENCE_CHANGED","The actual source cutoff cannot precede its original due slot.",409);
    const issues=await checkLifecycleSource(tx,grant.identity!,source);if(issues.length)throw new DomainError("LIFECYCLE_SOURCE_WITHDRAWN",issues.join(" ").slice(0,1000),410);
    requireClaim(current,claim,await orgNow(tx));return source;
  });
  return lifecycleSourceTx(async tx=>{
    await lifecycleWritable(tx);const current=await workContext(tx,claim.occurrenceId);requireClaim(current,claim,await orgNow(tx));
    const grant=await checkLifecycleDelegation(tx,current.head,current.definition,"produce");if(!grant.permission.allowed)throw new DomainError(grant.permission.code!,grant.permission.reason!,410);
    const issues=await checkLifecycleSource(tx,grant.identity!,source);if(issues.length)throw new DomainError("LIFECYCLE_SOURCE_WITHDRAWN",issues.join(" ").slice(0,1000),410);
    if(current.occurrence.snapshot_hash)throw new DomainError("LIFECYCLE_OCCURRENCE_CHANGED","The original capture is already saved. Its source cannot be replaced.",409);
    const id=randomUUID(),at=await orgNow(tx);requireClaim(current,claim,at);
    await tx.query("INSERT INTO fp_lifecycle_snapshots(id,occurrence_id,snapshot_hash,basis_hash,captured_at,encrypted_data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",[id,current.occurrence.id,source.snapshot.snapshotHash,source.snapshot.basisHash,source.snapshot.asOf,sealPrivate(source,lifecyclePrivateContext("snapshot",id)),at]);
    await tx.query("UPDATE fp_lifecycle_occurrences SET version=version+1,state='due',captured_at=$2,snapshot_hash=$3,lease_token=NULL,lease_until=NULL,next_retry_at=NULL,updated_at=$4 WHERE id=$1",[current.occurrence.id,source.snapshot.asOf,source.snapshot.snapshotHash,at]);
    await terminalAttempt(tx,claim,"succeeded",null,at);
    await lifecycleAudit(tx,{organizationId:current.head.organization_id},`delegated:${lifecycleActor(grant.identity!)}`,"occurrence_capture",current.occurrence.id,{occurrenceKey:current.occurrence.occurrence_key,originalDueAt:current.occurrence.due_at.toISOString(),actualCapturedAt:source.snapshot.asOf,snapshotHash:source.snapshot.snapshotHash});
    requireClaim(current,claim,await orgNow(tx));
    return {state:"captured" as const};
  },false);
}

export async function draftLifecycleOccurrence(claim:LifecycleWorkClaim) {
  if(claim.stage!=="draft")throw new DomainError("LIFECYCLE_OCCURRENCE_CHANGED","Retain this attempt's original draft stage.",409);
  return lifecycleSourceTx(async tx=>{
    await lifecycleWritable(tx);const current=await workContext(tx,claim.occurrenceId);requireClaim(current,claim,await orgNow(tx));
    const grant=await checkLifecycleDelegation(tx,current.head,current.definition,"produce");if(!grant.permission.allowed)throw new DomainError(grant.permission.code!,grant.permission.reason!,410);
    const capture=await readLifecycleCapture(tx,current.occurrence);if(!capture)throw new DomainError("LIFECYCLE_SOURCE_CHANGED","This draft needs its original durable capture before it can be prepared.",409);
    const issues=await checkLifecycleSource(tx,grant.identity!,capture.source);if(issues.length)throw new DomainError("LIFECYCLE_SOURCE_WITHDRAWN",issues.join(" ").slice(0,1000),410);
    const content=buildLifecycleDraft(capture.source.snapshot,{title:grant.delegation.review.input.proposal.title}),id=randomUUID(),encrypted=sealPrivate(content,lifecyclePrivateContext("content",id)),at=await orgNow(tx);requireClaim(current,claim,at);
    await tx.query("INSERT INTO fp_lifecycle_contents(id,occurrence_id,snapshot_id,snapshot_hash,content_hash,origin,encrypted_data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,current.occurrence.id,capture.row.id,capture.row.snapshot_hash,content.contentHash,content.origin,encrypted,at]);
    await tx.query("UPDATE fp_lifecycle_occurrences SET version=version+1,state='ready',content_hash=$2,lease_token=NULL,lease_until=NULL,next_retry_at=NULL,last_code=NULL,updated_at=$3 WHERE id=$1",[current.occurrence.id,content.contentHash,at]);
    await terminalAttempt(tx,claim,"succeeded",null,at);
    await lifecycleAudit(tx,{organizationId:current.head.organization_id},`delegated:${lifecycleActor(grant.identity!)}`,"occurrence_drafted",current.occurrence.id,{occurrenceKey:current.occurrence.occurrence_key,snapshotHash:capture.row.snapshot_hash,contentHash:content.contentHash,actualCapturedAt:content.asOf,delivery:"private_in_app",externalSendingAuthorized:false});
    requireClaim(current,claim,await orgNow(tx));
    return {state:"ready" as const};
  },false);
}

export async function failLifecycleOccurrence(claim:LifecycleWorkClaim,error:unknown) {
  const code=error instanceof DomainError&&C.LIFECYCLE_ERROR_CODES.some(value=>value===error.code)?error.code:error instanceof DomainError&&error.code==="ORG_COMMAND_BUSY"?"LIFECYCLE_BUSY":"REQUEST_UNAVAILABLE";
  return lifecycleSourceTx(async tx=>{
    await lifecycleWritable(tx);const current=await workContext(tx,claim.occurrenceId);
    if(!current||current.occurrence.lease_token!==claim.leaseToken)return {state:"already_resolved" as const};
    const at=await orgNow(tx),grant=await checkLifecycleDelegation(tx,current.head,current.definition,"produce");
    let state:C.LifecycleOccurrence["state"],resultCode:string=code,next:Date|null=null;
    if(current.occurrence.expires_at<=at){state="expired";resultCode="LIFECYCLE_EXPIRED";}
    else if(!grant.permission.allowed&&grant.permission.code!=="LIFECYCLE_SCHEDULE_PAUSED") {state=endedState(grant.permission.code);resultCode=grant.permission.code!;}
    else if(code==="LIFECYCLE_SOURCE_WITHDRAWN")state="blocked_source";
    else if(["LIFECYCLE_ORGANIZATION_CHANGED","LIFECYCLE_PROJECT_CHANGED","LIFECYCLE_AUTHORITY_ENDED","ORG_CONTEXT_CHANGED","ORG_PROJECT_CONTEXT_CHANGED"].includes(code))state="blocked_authority";
    else if(["LIFECYCLE_BUSY","REQUEST_UNAVAILABLE"].includes(code)&&current.occurrence.attempt_count<5){
      next=new Date(at.getTime()+Math.min(300_000,30_000*current.occurrence.attempt_count));state=next<current.occurrence.expires_at?"retry_wait":"expired";if(state==="expired"){next=null;resultCode="LIFECYCLE_EXPIRED";}
    }else state="failed";
    await tx.query("UPDATE fp_lifecycle_occurrences SET version=version+1,state=$2,lease_token=NULL,lease_until=NULL,next_retry_at=$3,last_code=$4,updated_at=$5 WHERE id=$1",[current.occurrence.id,state,next,resultCode,at]);
    await terminalAttempt(tx,claim,state==="retry_wait"?"retryable":['expired','blocked_authority','blocked_source','cancelled'].includes(state)?"blocked":"failed",resultCode,at,next);
    await lifecycleAudit(tx,{organizationId:current.head.organization_id},"lifecycle-worker:original-lease","occurrence_attempt_result",current.occurrence.id,{occurrenceKey:current.occurrence.occurrence_key,attemptId:claim.attemptId,stage:claim.stage,state,code:resultCode,originalExpiresAt:current.occurrence.expires_at.toISOString(),savedSnapshotHash:current.occurrence.snapshot_hash});
    return {state};
  },false);
}

/** Operator permission selects bounded work only. Every capture/draft checks
 * its original real delegator and every immutable deadline independently. */
export async function runLifecycleSchedules(options:{definitions?:number;occurrences?:number;slotsPerDefinition?:number}={}) {
  const materialized=await materializeLifecycleSchedules({limit:options.definitions??5,slotsPerDefinition:options.slotsPerDefinition??20}),limit=bounded(options.occurrences,5);
  const candidates=await lifecycleTx(tx=>query<{id:string}>(`SELECT o.id FROM fp_lifecycle_occurrences o JOIN fp_lifecycle_schedules s ON s.id=o.schedule_id
    WHERE o.state IN ('due','retry_wait','capturing','drafting') AND (o.lease_until IS NULL OR o.lease_until<=clock_timestamp())
      AND (o.next_retry_at IS NULL OR o.next_retry_at<=clock_timestamp()) AND (s.state<>'paused' OR o.expires_at<=clock_timestamp())
    ORDER BY o.due_at,o.id LIMIT $1`,[limit],tx));
  let claimed=0,captured=0,ready=0,retained=0;
  for(const candidate of candidates) {
    for(let stage=0;stage<2;stage++) {
      const claim=await claimLifecycleOccurrence(candidate.id);if(!claim){retained++;break;}
      claimed++;
      try {
        if(claim.stage==="capture"){await captureLifecycleOccurrence(claim);captured++;continue;}
        await draftLifecycleOccurrence(claim);ready++;break;
      }catch(error){await failLifecycleOccurrence(claim,error);retained++;break;}
    }
  }
  return {...materialized,selected:candidates.length,claimed,captured,ready,retained,morePossible:materialized.morePossible||candidates.length===limit,providerCalls:0,modelCalls:0,emailSends:0};
}
