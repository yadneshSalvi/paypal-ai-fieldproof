import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {it} from "node:test";
import {lifecycleOccurrenceKey} from "../lib/lifecycle/schedule";
import {database,query} from "../lib/server/db";
import {lifecyclePrivateContext,type LifecycleDefinition,type LifecycleScheduleHead} from "../lib/server/lifecycle-core";
import {lifecycleDelegation} from "../lib/server/lifecycle-authority";
import {sealPrivate} from "../lib/server/private-values";
import {lifecycleSchedules} from "../lib/server/lifecycle-schedules";
import {lifecycleOccurrences,lifecycleOccurrenceAttempts} from "../lib/server/lifecycle-occurrences";
import {afterTime,enabledFixture,originalOccurrence} from "./helpers/lifecycle-scheduled";

it("pages exact same-millisecond schedule, occurrence and attempt ties without loss or duplication",async()=>{
  const f=await enabledFixture(),original=await originalOccurrence(f);
  const [head]=await query<LifecycleScheduleHead>("SELECT * FROM fp_lifecycle_schedules WHERE id=$1",[f.id]);
  const [definition]=await query<LifecycleDefinition>("SELECT * FROM fp_lifecycle_schedule_versions WHERE schedule_id=$1",[f.id]);
  const grant=lifecycleDelegation(definition),scheduleIds=[f.id],occurrenceIds=[original.id];
  // Only pagination data uses constructed SQL timestamps. The ordinary first
  // schedule supplies valid original authority; no real participants, sends or
  // additional reviewed business commands are claimed for these synthetic ties.
  const base=head.created_at.toISOString(),recorded=original.created_at.toISOString();
  await database().transaction(async tx=>{
    for(let i=1;i<=26;i++){
      const scheduleId=randomUUID(),definitionId=randomUUID(),occurrenceId=randomUUID();scheduleIds.push(scheduleId);occurrenceIds.push(occurrenceId);
      await tx.query(`INSERT INTO fp_lifecycle_schedules(id,organization_id,owner_membership_id,created_at,updated_at)
        VALUES($1,$2,$3,$4::timestamptz+$5::int*interval '1 microsecond',$4::timestamptz+$5::int*interval '1 microsecond')`,[scheduleId,head.organization_id,head.owner_membership_id,base,i]);
      await tx.query(`INSERT INTO fp_lifecycle_schedule_versions(id,schedule_id,organization_id,definition_version,definition_hash,review_hash,audience,issuer_session_id,issuer_membership_id,issuer_membership_version,issuer_role,project_session_id,program_version,first_due_at,interval_minutes,expires_at,encrypted_data,created_at)
        SELECT $1,$2,organization_id,definition_version,definition_hash,review_hash,audience,issuer_session_id,issuer_membership_id,issuer_membership_version,issuer_role,project_session_id,program_version,first_due_at,interval_minutes,expires_at,$3,created_at FROM fp_lifecycle_schedule_versions WHERE id=$4`,
        [definitionId,scheduleId,sealPrivate(grant,lifecyclePrivateContext("definition",definitionId)),definition.id]);
      await tx.query(`INSERT INTO fp_lifecycle_occurrences(id,organization_id,schedule_id,definition_id,definition_version,occurrence_key,audience,due_at,expires_at,state,created_at,updated_at)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,'due',$9::timestamptz+$10::int*interval '1 microsecond',$9::timestamptz+$10::int*interval '1 microsecond')`,
        [occurrenceId,head.organization_id,scheduleId,definitionId,lifecycleOccurrenceKey(scheduleId,1,original.due_at.toISOString()),original.audience,original.due_at,original.expires_at,recorded,i]);
    }
  });
  const schedules1=(await lifecycleSchedules(f.request)).desk,schedules2=(await lifecycleSchedules(f.request,schedules1.nextCursor!)).desk;
  assert.equal(schedules1.schedules.length,20);assert.equal(schedules2.schedules.length,7);assert.equal(schedules2.nextCursor,null);
  assert.deepEqual([...schedules1.schedules,...schedules2.schedules].map(row=>row.id).sort(),scheduleIds.sort());
  const occurrences1=(await lifecycleOccurrences(f.request)).page,occurrences2=(await lifecycleOccurrences(f.request,occurrences1.nextCursor!)).page;
  assert.equal(occurrences1.occurrences.length,20);assert.equal(occurrences2.occurrences.length,7);assert.equal(occurrences2.nextCursor,null);
  assert.deepEqual([...occurrences1.occurrences,...occurrences2.occurrences].map(row=>row.id).sort(),occurrenceIds.sort());
  const at=(await query<{at:Date}>("SELECT date_trunc('milliseconds',clock_timestamp()) at"))[0].at.toISOString();
  await database().transaction(async tx=>{
    for(let ordinal=1;ordinal<=27;ordinal++)await tx.query(`INSERT INTO fp_lifecycle_attempts(id,occurrence_id,ordinal,lease_token,stage,outcome,code,started_at,completed_at)
      VALUES($1,$2,$3,$4,'capture','failed','CONTROLLED_PAGINATION_ONLY',$5::timestamptz+$3::int*interval '1 microsecond',$5::timestamptz+interval '1 millisecond')`,[randomUUID(),original.id,ordinal,randomUUID(),at]);
    await tx.query("UPDATE fp_lifecycle_occurrences SET version=version+1,attempt_count=27 WHERE id=$1",[original.id]);
  });
  const attempts1=(await lifecycleOccurrenceAttempts(f.request,original.id)).page,attempts2=(await lifecycleOccurrenceAttempts(f.request,original.id,attempts1.nextCursor!)).page;
  assert.equal(attempts1.attempts.length,20);assert.equal(attempts2.attempts.length,7);assert.equal(attempts2.nextCursor,null);
  assert.deepEqual([...attempts1.attempts,...attempts2.attempts].map(row=>row.attempt).sort((a,b)=>a-b),Array.from({length:27},(_,i)=>i+1));
});
