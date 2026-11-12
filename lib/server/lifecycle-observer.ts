import {randomUUID} from "node:crypto";
import {z} from "zod";
import {query} from "./db";
import {openPrivate,sealPrivate} from "./private-values";
import {lifecycleNow,lifecyclePrivateContext,lifecycleTx,lifecycleWritable} from "./lifecycle-core";
import {observeLifecyclePersonal} from "./lifecycle-personal";

interface ObserverHead {name:string;version:number;encrypted_cursor:string|null;lease_token:string|null;lease_until:Date|null;}
/** The cursor advances only after the observer's idempotent original-grant
 * page commits. Loss or expired ownership repeats that page without duplicate
 * event identities, then continues rather than starving older profiles. */
export async function runLifecyclePersonalPage(limit=5) {
  z.number().int().min(1).max(20).parse(limit);
  const claim=await lifecycleTx(async tx=>{
    await lifecycleWritable(tx);
    await tx.query("INSERT INTO fp_lifecycle_observer_heads(name) VALUES('personal-v1') ON CONFLICT(name) DO NOTHING");
    const [head]=await query<ObserverHead>("SELECT * FROM fp_lifecycle_observer_heads WHERE name='personal-v1' FOR UPDATE",[],tx),at=await lifecycleNow(tx);
    if(head.lease_until&&head.lease_until>at)return null;
    const token=randomUUID(),cursor=head.encrypted_cursor?z.string().max(2500).parse(openPrivate(head.encrypted_cursor,lifecyclePrivateContext("observer","personal-v1"))):undefined;
    await tx.query("UPDATE fp_lifecycle_observer_heads SET version=version+1,lease_token=$1,lease_until=$2,last_code=NULL,updated_at=$3 WHERE name='personal-v1'",[token,new Date(at.getTime()+55_000),at]);
    return {token,cursor};
  });
  if(!claim)return {state:"busy" as const,checked:0,created:0,skipped:0,morePossible:true};
  try{
    const result=await observeLifecyclePersonal({limit,before:claim.cursor});
    const retained=await lifecycleTx(async tx=>{
      await lifecycleWritable(tx);const [head]=await query<ObserverHead>("SELECT * FROM fp_lifecycle_observer_heads WHERE name='personal-v1' FOR UPDATE",[],tx),at=await lifecycleNow(tx);
      if(head.lease_token!==claim.token||!head.lease_until||head.lease_until<=at)return false;
      await tx.query("UPDATE fp_lifecycle_observer_heads SET version=version+1,encrypted_cursor=$1,lease_token=NULL,lease_until=NULL,last_completed_at=$2,last_code=NULL,last_result=$3::jsonb,updated_at=$2 WHERE name='personal-v1'",
        [result.nextCursor?sealPrivate(result.nextCursor,lifecyclePrivateContext("observer","personal-v1")):null,at,JSON.stringify({checked:result.checked,created:result.created,skipped:result.skipped,hasMore:!!result.nextCursor})]);return true;
    });
    return {state:retained?"completed" as const:"retained_cursor" as const,checked:result.checked,created:result.created,skipped:result.skipped,morePossible:!retained||!!result.nextCursor};
  }catch(error){
    await lifecycleTx(async tx=>{
      await lifecycleWritable(tx);
      await tx.query("UPDATE fp_lifecycle_observer_heads SET version=version+1,lease_token=NULL,lease_until=NULL,last_code='LIFECYCLE_PAGE_RETRY',updated_at=clock_timestamp() WHERE name='personal-v1' AND lease_token=$1",[claim.token]);
    }).catch(()=>undefined);
    throw error;
  }
}
