import * as C from "../lifecycle/contracts";
import { verifyLifecycleDraft,verifyLifecycleSnapshot } from "../lifecycle/inbox";
import { query } from "./db";
import { openPrivate } from "./private-values";
import type { OrgIdentity,OrgTx } from "./organization-core";
import { lifecycleOwnedSchedule } from "./lifecycle-authority";
import { lifecyclePrivateContext,lifecycleUnavailable,type LifecycleDefinition,type LifecycleOccurrenceRow,type LifecycleScheduleHead } from "./lifecycle-core";
import type { LifecycleCapturedSource } from "./lifecycle-sources";

export interface LifecycleSnapshotRow { id:string;occurrence_id:string;snapshot_hash:string;basis_hash:string;captured_at:Date;encrypted_data:string;created_at:Date; }
export interface LifecycleContentRow { id:string;occurrence_id:string;snapshot_id:string;snapshot_hash:string;content_hash:string;origin:C.LifecycleContent["origin"];encrypted_data:string;created_at:Date; }
export async function readLifecycleCapture(tx:OrgTx,occurrence:LifecycleOccurrenceRow) {
  const [row]=await query<LifecycleSnapshotRow>("SELECT * FROM fp_lifecycle_snapshots WHERE occurrence_id=$1",[occurrence.id],tx);
  if(!row){if(occurrence.snapshot_hash)throw lifecycleUnavailable();return null;}
  const source=openPrivate<LifecycleCapturedSource>(row.encrypted_data,lifecyclePrivateContext("snapshot",row.id)),snapshot=verifyLifecycleSnapshot(source.snapshot);
  if(row.snapshot_hash!==occurrence.snapshot_hash||snapshot.snapshotHash!==row.snapshot_hash||snapshot.basisHash!==row.basis_hash||snapshot.asOf!==row.captured_at.toISOString()
    ||occurrence.captured_at?.toISOString()!==snapshot.asOf||snapshot.audience!==occurrence.audience||Date.parse(snapshot.asOf)<occurrence.due_at.getTime())throw lifecycleUnavailable();
  return {row,source};
}
export async function readLifecycleContent(tx:OrgTx,occurrence:LifecycleOccurrenceRow,capture:NonNullable<Awaited<ReturnType<typeof readLifecycleCapture>>>) {
  const [row]=await query<LifecycleContentRow>("SELECT * FROM fp_lifecycle_contents WHERE occurrence_id=$1",[occurrence.id],tx);
  if(!row){if(occurrence.content_hash)throw lifecycleUnavailable();return null;}
  const content=verifyLifecycleDraft(openPrivate<C.LifecycleContent>(row.encrypted_data,lifecyclePrivateContext("content",row.id)),capture.source.snapshot);
  if(row.content_hash!==occurrence.content_hash||content.contentHash!==row.content_hash||row.snapshot_hash!==occurrence.snapshot_hash||row.snapshot_id!==capture.row.id||row.origin!==content.origin)throw lifecycleUnavailable();
  return {row,content};
}
export interface LifecycleOwnedOccurrence { head:LifecycleScheduleHead;definition:LifecycleDefinition;occurrence:LifecycleOccurrenceRow; }
export async function lifecycleOwnedOccurrence(tx:OrgTx,identity:OrgIdentity,id:string,lock=false):Promise<LifecycleOwnedOccurrence> {
  const [bound]=await query<{schedule_id:string;definition_version:number}>(`SELECT o.schedule_id,o.definition_version FROM fp_lifecycle_occurrences o
    JOIN fp_lifecycle_schedules s ON s.id=o.schedule_id AND s.organization_id=o.organization_id
    WHERE o.id=$1 AND o.organization_id=$2 AND s.owner_membership_id=$3`,[id,identity.organization.id,identity.member.id],tx);
  if(!bound)throw lifecycleUnavailable();
  const schedule=await lifecycleOwnedSchedule(tx,identity,bound.schedule_id,bound.definition_version,lock);
  const [occurrence]=await query<LifecycleOccurrenceRow>(`SELECT * FROM fp_lifecycle_occurrences WHERE id=$1 AND definition_id=$2${lock?" FOR UPDATE":""}`,[id,schedule.definition.id],tx);
  if(!occurrence)throw lifecycleUnavailable();
  return {...schedule,occurrence};
}
