import { randomUUID } from "node:crypto";
import type { SqlConnection } from "@fracture/paypal-core";
import { backTranslationSchema, captureBriefSchema, previewUpdateSchema, reviewTranslationSchema, saveBriefSchema, saveTranslationSchema,
  type BriefDraft, type BriefSnapshot, type BriefSource, type BriefStatement, type CommunityDesk, type CommunityRunView, type SupporterStory, type TranslationParagraph, type TranslationView } from "../community/contracts";
import { authoredTranslation, assertStatementSources, selectStatements, validateTranslation } from "../community/content";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { database, query } from "./db";
import { requireCurrentRole } from "./membership";
import { lockPlanningAuthority, planningHash } from "./planning-store";
import { openPrivate, sealPrivate } from "./private-values";
import { communitySource, personalCommunitySource } from "./community-source";

export interface SnapshotRow { id:string;tenant_id:string;project_id:string;actor_id:string;role:Session["role"];membership_version:number;audience:BriefSource["audience"];content_hash:string;snapshot_hash:string;encrypted_source:string;captured_at:Date; }
export interface DraftRow { id:string;tenant_id:string;project_id:string;actor_id:string;snapshot_id:string;source_hash:string;content_hash:string;audience:BriefSource["audience"];origin:BriefDraft["origin"];source_run_id:string|null;encrypted_content:string;created_at:Date; }
export interface TranslationRow { id:string;tenant_id:string;project_id:string;actor_id:string;draft_id:string;revision:number;source_hash:string;content_hash:string;origin:TranslationView["origin"];source_run_id:string|null;encrypted_content:string;created_at:Date; }
interface BackRow { id:string;translation_id:string;translation_hash:string;content_hash:string;origin:"manual"|"model";source_run_id:string|null;actor_id:string;encrypted_content:string;created_at:Date; }
interface ReviewRow { id:string;translation_hash:string;backtranslation_id:string;backtranslation_hash:string;decision:"approved"|"needs_changes";kind:"fluent_reviewer"|"sample_exercise";reviewer_actor_id:string;membership_version:number;encrypted_note:string;created_at:Date; }
export const communityContext = (kind:string,row:{id:string;tenant_id:string;project_id:string})=>`community-${kind}:${row.tenant_id}:${row.project_id}:${row.id}`;
export async function lockCommunity(session:Session,tx:SqlConnection,roles:Session["role"][]=["organizer"]) {
  const version=await lockPlanningAuthority(session,roles,tx);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`community:${session.tenantId}:${session.projectId}`]);
  await requireCurrentRole(session,session.role,tx);
  return version;
}
export async function communityAction<T>(session:Session,intentId:string,kind:string,input:unknown,tx:SqlConnection,work:()=>Promise<T>):Promise<T> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`community-intent:${session.tenantId}:${session.actorId}:${intentId}`]);
  const hash=planningHash(input),context=`community-action:${session.tenantId}:${session.actorId}:${intentId}`;
  const [prior]=await query<{project_id:string;kind:string;input_hash:string;encrypted_result:string}>("SELECT project_id,kind,input_hash,encrypted_result FROM fp_community_actions WHERE tenant_id=$1 AND actor_id=$2 AND intent_id=$3",[session.tenantId,session.actorId,intentId],tx);
  if(prior){if(prior.project_id!==session.projectId||prior.kind!==kind||prior.input_hash!==hash)throw new DomainError("COMMUNITY_INTENT_CHANGED","This request identity already describes a different source-bound action.",409);return openPrivate<T>(prior.encrypted_result,context);}
  const result=await work();
  await tx.query("INSERT INTO fp_community_actions(tenant_id,project_id,actor_id,intent_id,kind,input_hash,encrypted_result) VALUES($1,$2,$3,$4,$5,$6,$7)",[session.tenantId,session.projectId,session.actorId,intentId,kind,hash,sealPrivate(result,context)]);
  return result;
}
export function snapshotSource(row:SnapshotRow):BriefSource {
  const source=openPrivate<BriefSource>(row.encrypted_source,communityContext("snapshot",row));
  const {capturedAt,contentHash,...stable}=source;
  if(planningHash(stable)!==contentHash||contentHash!==row.content_hash||source.projectId!==row.project_id||source.audience!==row.audience||capturedAt!==row.captured_at.toISOString()||planningHash({tenantId:row.tenant_id,projectId:row.project_id,actorId:row.actor_id,role:row.role,membershipVersion:row.membership_version,source})!==row.snapshot_hash)throw new DomainError("BRIEF_SOURCE_INTEGRITY","The saved source snapshot could not be verified.",409);
  assertStatementSources(source);return source;
}
export async function requireSnapshot(session:Session,id:string,tx:SqlConnection,shared=false):Promise<SnapshotRow> {
  const [row]=await query<SnapshotRow>(`SELECT * FROM fp_community_snapshots WHERE id=$1 AND tenant_id=$2 AND project_id=$3 ${shared?"AND audience='supporter'":"AND actor_id=$4"}`,[id,session.tenantId,session.projectId,...(shared?[]:[session.actorId])],tx);
  if(!row||(row.audience==="treasurer"&&!["organizer","auditor"].includes(session.role)))throw new DomainError("BRIEF_NOT_FOUND","That source snapshot is unavailable in your current workspace.",404);
  snapshotSource(row);return row;
}
export async function snapshotCurrent(session:Session,row:SnapshotRow,tx:SqlConnection,source?:BriefSource):Promise<boolean> {
  const [authority]=await query<{version:number;state:string;roles:string[]}>("SELECT version,state,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3",[session.tenantId,session.projectId,row.actor_id],tx);
  return !!authority&&authority.state==="active"&&authority.version===row.membership_version&&authority.roles.includes(row.role)&&(source??await communitySource(session,row.audience,tx)).contentHash===row.content_hash;
}
export async function assertSnapshotCurrent(session:Session,row:SnapshotRow,tx:SqlConnection) {
  if(!await snapshotCurrent(session,row,tx))throw new DomainError("BRIEF_SOURCE_CHANGED","The project facts or their authority changed. Capture a fresh snapshot; the earlier source and review remain in history.",409);
}
export async function captureCommunitySnapshot(session:Session,raw:unknown):Promise<{id:string}> {
  const input=captureBriefSchema.parse(raw);
  return database().transaction(async tx=>{
    const version=await lockCommunity(session,tx);
    return communityAction(session,input.intentId,"snapshot",input,tx,async()=>{
      const source=await communitySource(session,input.audience,tx),id=randomUUID(),row={id,tenant_id:session.tenantId,project_id:session.projectId};
      const hash=planningHash({tenantId:session.tenantId,projectId:session.projectId,actorId:session.actorId,role:session.role,membershipVersion:version,source});
      await tx.query("INSERT INTO fp_community_snapshots(id,tenant_id,project_id,actor_id,role,membership_version,audience,content_hash,snapshot_hash,encrypted_source,captured_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[id,session.tenantId,session.projectId,session.actorId,session.role,version,input.audience,source.contentHash,hash,sealPrivate(source,communityContext("snapshot",row)),source.capturedAt]);
      return {id};
    });
  });
}
export async function requireDraft(session:Session,id:string,tx:SqlConnection,shared=false):Promise<DraftRow> {
  const [row]=await query<DraftRow>(`SELECT * FROM fp_community_drafts WHERE id=$1 AND tenant_id=$2 AND project_id=$3 ${shared?"AND audience='supporter'":"AND actor_id=$4"}`,[id,session.tenantId,session.projectId,...(shared?[]:[session.actorId])],tx);
  if(!row||(row.audience==="treasurer"&&!["organizer","auditor"].includes(session.role)))throw new DomainError("BRIEF_NOT_FOUND","That draft is unavailable in your current workspace.",404);
  return row;
}
export async function draftView(session:Session,row:DraftRow,tx:SqlConnection,source?:BriefSource,shared=false):Promise<BriefDraft> {
  const body=openPrivate<{title:string;paragraphs:BriefStatement[]}>(row.encrypted_content,communityContext("draft",row));
  if(planningHash({snapshotId:row.snapshot_id,sourceHash:row.source_hash,audience:row.audience,...body})!==row.content_hash)throw new DomainError("BRIEF_DRAFT_INTEGRITY","The saved draft could not be verified.",409);
  const snapshot=await requireSnapshot(session,row.snapshot_id,tx,shared),original=snapshotSource(snapshot);
  if(row.source_hash!==original.contentHash||planningHash(selectStatements(original,body.paragraphs.map(p=>p.id)))!==planningHash(body.paragraphs))throw new DomainError("BRIEF_CITATION_INVALID","The draft no longer matches its saved source sentences.",409);
  return {id:row.id,snapshotId:row.snapshot_id,sourceHash:row.source_hash,contentHash:row.content_hash,title:body.title,audience:row.audience,createdAt:row.created_at.toISOString(),origin:row.origin,sourceRunId:row.source_run_id,paragraphs:body.paragraphs,current:await snapshotCurrent(session,snapshot,tx,source)};
}
export async function insertDraft(session:Session,snapshot:SnapshotRow,title:string,paragraphs:BriefStatement[],origin:BriefDraft["origin"],runId:string|null,tx:SqlConnection):Promise<string> {
  const original=snapshotSource(snapshot);
  if(planningHash(selectStatements(original,paragraphs.map(p=>p.id)))!==planningHash(paragraphs))throw new DomainError("BRIEF_CITATION_INVALID","Each saved sentence must retain its exact authorized factual source.",422);
  const id=randomUUID(),body={title,paragraphs},hash=planningHash({snapshotId:snapshot.id,sourceHash:snapshot.content_hash,audience:snapshot.audience,...body}),context=communityContext("draft",{id,tenant_id:session.tenantId,project_id:session.projectId});
  await tx.query("INSERT INTO fp_community_drafts(id,tenant_id,project_id,actor_id,snapshot_id,source_hash,content_hash,audience,origin,source_run_id,encrypted_content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[id,session.tenantId,session.projectId,session.actorId,snapshot.id,snapshot.content_hash,hash,snapshot.audience,origin,runId,sealPrivate(body,context)]);
  await tx.query("INSERT INTO fp_community_translation_heads(draft_id) VALUES($1)",[id]);
  const row=await requireDraft(session,id,tx),draft=await draftView(session,row,tx);
  await insertTranslation(session,draft,authoredTranslation(draft),"authored_starter",null,0,tx);
  return id;
}
export async function saveCommunityDraft(session:Session,raw:unknown):Promise<{id:string}> {
  const input=saveBriefSchema.parse(raw);
  return database().transaction(async tx=>{
    await lockCommunity(session,tx);
    return communityAction(session,input.intentId,"draft",input,tx,async()=>{
      const row=await requireSnapshot(session,input.snapshotId,tx);await assertSnapshotCurrent(session,row,tx);
      if(row.content_hash!==input.sourceHash)throw new DomainError("BRIEF_SOURCE_CHANGED","The selected source hash does not match this snapshot.",409);
      return {id:await insertDraft(session,row,input.title,selectStatements(snapshotSource(row),input.statementIds),"selected",null,tx)};
    });
  });
}
export async function requireTranslation(session:Session,id:string,tx:SqlConnection,shared=false):Promise<TranslationRow> {
  const [row]=await query<TranslationRow>(`SELECT * FROM fp_community_translations WHERE id=$1 AND tenant_id=$2 AND project_id=$3 ${shared?"":"AND actor_id=$4"}`,[id,session.tenantId,session.projectId,...(shared?[]:[session.actorId])],tx);
  if(!row)throw new DomainError("TRANSLATION_NOT_FOUND","That translation is unavailable in this workspace.",404);
  return row;
}
export async function translationHead(id:string,tx:SqlConnection,lock=false):Promise<number> {
  const [row]=await query<{version:number}>(`SELECT version FROM fp_community_translation_heads WHERE draft_id=$1${lock?" FOR UPDATE":""}`,[id],tx);
  if(!row)throw new DomainError("TRANSLATION_NOT_FOUND","The translation history is unavailable.",404);return row.version;
}
export async function insertTranslation(session:Session,draft:BriefDraft,paragraphs:TranslationParagraph[],origin:TranslationView["origin"],runId:string|null,expectedHead:number,tx:SqlConnection):Promise<string> {
  const head=await translationHead(draft.id,tx,true);
  if(head!==expectedHead)throw new DomainError("TRANSLATION_VERSION_CHANGED","A newer translation exists. Compare it with your wording before saving.",409);
  const values=validateTranslation(draft,{paragraphs}),id=randomUUID(),row={id,tenant_id:session.tenantId,project_id:session.projectId},hash=planningHash({sourceHash:draft.contentHash,paragraphs:values});
  await tx.query("INSERT INTO fp_community_translations(id,tenant_id,project_id,actor_id,draft_id,revision,source_hash,content_hash,origin,source_run_id,encrypted_content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[id,session.tenantId,session.projectId,session.actorId,draft.id,head+1,draft.contentHash,hash,origin,runId,sealPrivate({paragraphs:values},communityContext("translation",row))]);
  await tx.query("UPDATE fp_community_translation_heads SET version=version+1 WHERE draft_id=$1",[draft.id]);return id;
}
export async function translationView(session:Session,row:TranslationRow,draft:BriefDraft,tx:SqlConnection):Promise<TranslationView> {
  const body=openPrivate<{paragraphs:TranslationParagraph[]}>(row.encrypted_content,communityContext("translation",row));
  const paragraphs=validateTranslation(draft,body);
  if(row.source_hash!==draft.contentHash||planningHash({sourceHash:row.source_hash,paragraphs})!==row.content_hash)throw new DomainError("TRANSLATION_INTEGRITY","The translation no longer matches its exact English source.",409);
  const [back]=await query<BackRow>("SELECT * FROM fp_community_backtranslations WHERE translation_id=$1 AND translation_hash=$2 ORDER BY created_at DESC,id DESC LIMIT 1",[row.id,row.content_hash],tx);
  let backTranslation:TranslationView["backTranslation"]=null;
  if(back){const content=openPrivate<{paragraphs:TranslationParagraph[]}>(back.encrypted_content,`community-backtranslation:${row.id}:${back.id}`);validateTranslation(draft,content);if(planningHash({translationHash:row.content_hash,...content})!==back.content_hash)throw new DomainError("BACKTRANSLATION_INTEGRITY","The back-translation could not be verified.",409);backTranslation={paragraphs:content.paragraphs,hash:back.content_hash,origin:back.origin,sourceRunId:back.source_run_id};}
  const [review]=await query<ReviewRow>("SELECT * FROM fp_community_translation_reviews WHERE translation_id=$1 AND translation_hash=$2 ORDER BY created_at DESC,id DESC LIMIT 1",[row.id,row.content_hash],tx);
  let current=draft.current&&(await translationHead(draft.id,tx))===row.revision,viewReview:TranslationView["review"]=null;
  if(review){const [authority]=await query<{version:number;state:string;roles:string[]}>("SELECT version,state,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3",[session.tenantId,session.projectId,review.reviewer_actor_id],tx);
    if(!authority||authority.version!==review.membership_version||authority.state!=="active"||!authority.roles.includes("organizer"))current=false;
    if(back&&review.backtranslation_id===back.id&&review.backtranslation_hash===back.content_hash)viewReview={decision:review.decision,kind:review.kind,reviewedAt:review.created_at.toISOString(),reviewerLabel:review.kind==="fluent_reviewer"?"Organizer · Spanish fluency attested":"Sample workflow exercise",note:openPrivate<string>(review.encrypted_note,`community-review:${row.id}:${review.id}`)};
  }
  return {id:row.id,draftId:row.draft_id,revision:row.revision,sourceHash:row.source_hash,contentHash:row.content_hash,paragraphs,origin:row.origin,createdAt:row.created_at.toISOString(),current,backTranslation,review:viewReview,status:!current?"stale":viewReview?.decision==="needs_changes"?"changes_requested":viewReview?.decision==="approved"?viewReview.kind==="fluent_reviewer"?"reviewed":"sample_review":"review_pending"};
}
export async function saveCommunityTranslation(session:Session,raw:unknown):Promise<{id:string}> {
  const input=saveTranslationSchema.parse(raw);
  return database().transaction(async tx=>{await lockCommunity(session,tx);return communityAction(session,input.intentId,"translation",input,tx,async()=>{
    const row=await requireDraft(session,input.draftId,tx),draft=await draftView(session,row,tx);
    if(!draft.current||input.sourceHash!==draft.contentHash)throw new DomainError("BRIEF_SOURCE_CHANGED","Capture and draft the current English source before translating it.",409);
    return {id:await insertTranslation(session,draft,input.paragraphs,"manual",null,input.expectedHead,tx)};
  });});
}
export async function insertBackTranslation(session:Session,translation:TranslationRow,draft:BriefDraft,paragraphs:TranslationParagraph[],origin:"manual"|"model",runId:string|null,tx:SqlConnection):Promise<string> {
  const content={paragraphs:validateTranslation(draft,{paragraphs})},hash=planningHash({translationHash:translation.content_hash,...content}),id=randomUUID();
  await tx.query("INSERT INTO fp_community_backtranslations(id,translation_id,translation_hash,content_hash,origin,source_run_id,actor_id,encrypted_content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,translation.id,translation.content_hash,hash,origin,runId,session.actorId,sealPrivate(content,`community-backtranslation:${translation.id}:${id}`)]);return id;
}
export async function saveCommunityBackTranslation(session:Session,raw:unknown):Promise<{id:string}> {
  const input=backTranslationSchema.parse(raw);
  return database().transaction(async tx=>{await lockCommunity(session,tx);return communityAction(session,input.intentId,"backtranslation",input,tx,async()=>{
    const row=await requireTranslation(session,input.translationId,tx),draft=await draftView(session,await requireDraft(session,row.draft_id,tx),tx),view=await translationView(session,row,draft,tx);
    if(!view.current||input.contentHash!==row.content_hash)throw new DomainError("TRANSLATION_CHANGED","The English source or Spanish revision changed before this back-translation.",409);
    return {id:await insertBackTranslation(session,row,draft,input.paragraphs,"manual",null,tx)};
  });});
}
export async function reviewCommunityTranslation(session:Session,raw:unknown):Promise<{id:string}> {
  const input=reviewTranslationSchema.parse(raw);
  return database().transaction(async tx=>{const version=await lockCommunity(session,tx);return communityAction(session,input.intentId,"translation-review",input,tx,async()=>{
    if(input.kind==="fluent_reviewer"&&!input.fluentSpanishAttested)throw new DomainError("FLUENT_REVIEW_REQUIRED","A fluent reviewer must personally attest their Spanish fluency. A model or back-translation cannot make that assertion.",422);
    if(input.kind==="sample_exercise"&&(session.mode!=="sample"||input.fluentSpanishAttested))throw new DomainError("SAMPLE_REVIEW_ONLY","A sample workflow exercise belongs in a sample workspace and must not claim fluent human review.",422);
    const row=await requireTranslation(session,input.translationId,tx),draft=await draftView(session,await requireDraft(session,row.draft_id,tx),tx),view=await translationView(session,row,draft,tx);
    if(!view.current||input.contentHash!==row.content_hash)throw new DomainError("TRANSLATION_CHANGED","Review the current source and Spanish revision.",409);
    const [back]=await query<BackRow>("SELECT * FROM fp_community_backtranslations WHERE translation_id=$1 AND translation_hash=$2 ORDER BY created_at DESC,id DESC LIMIT 1",[row.id,row.content_hash],tx);
    if(!back||input.backTranslationHash!==back.content_hash)throw new DomainError("BACKTRANSLATION_CHANGED","Compare the exact latest back-translation before recording this review.",409);
    const id=randomUUID();
    await tx.query("INSERT INTO fp_community_translation_reviews(id,translation_id,translation_hash,backtranslation_id,backtranslation_hash,reviewer_actor_id,reviewer_session_id,membership_version,decision,kind,encrypted_note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[id,row.id,row.content_hash,back.id,back.content_hash,session.actorId,session.id,version,input.decision,input.kind,sealPrivate(input.note,`community-review:${row.id}:${id}`)]);return {id};
  });});
}
export async function previewCommunityUpdate(session:Session,raw:unknown):Promise<{id:string}> {
  const input=previewUpdateSchema.parse(raw);
  return database().transaction(async tx=>{await lockCommunity(session,tx);return communityAction(session,input.intentId,"update-preview",input,tx,async()=>{
    const row=await requireDraft(session,input.draftId,tx),draft=await draftView(session,row,tx);
    if(!draft.current||draft.audience!=="supporter")throw new DomainError("UPDATE_SOURCE_REQUIRED","Choose a current supporter draft. Private treasurer facts cannot appear in a supporter preview.",409);
    let translation:TranslationView|null=null;
    if(input.translationId){const row=await requireTranslation(session,input.translationId,tx);if(row.draft_id!==draft.id)throw new DomainError("TRANSLATION_CHANGED","Choose the Spanish version of this exact draft.",409);translation=await translationView(session,row,draft,tx);if(!["reviewed","sample_review"].includes(translation.status))throw new DomainError("UPDATE_REVIEW_REQUIRED","Record a current fluent review or a clearly labelled sample workflow review before previewing this Spanish version.",409);}
    const id=randomUUID();await tx.query("INSERT INTO fp_community_update_previews(id,tenant_id,project_id,actor_id,draft_id,translation_id,source_hash,draft_hash,translation_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[id,session.tenantId,session.projectId,session.actorId,draft.id,translation?.id??null,draft.sourceHash,draft.contentHash,translation?.contentHash??null]);return {id};
  });});
}
export async function readCommunityDesk(session:Session):Promise<CommunityDesk> {
  return database().transaction(async tx=>{
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");await requireCurrentRole(session,session.role,tx);
    if(!["organizer","auditor"].includes(session.role))throw new DomainError("ROLE_DENIED","The private update desk requires the organizer or auditor view.",403);
    const sources={treasurer:await communitySource(session,"treasurer",tx),supporter:await communitySource(session,"supporter",tx)};
    const snapshotRows=await query<SnapshotRow>("SELECT * FROM fp_community_snapshots WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 ORDER BY captured_at DESC,id DESC LIMIT 30",[session.tenantId,session.projectId,session.actorId],tx);
    const snapshots:BriefSnapshot[]=[];for(const row of snapshotRows)snapshots.push({...snapshotSource(row),id:row.id,snapshotHash:row.snapshot_hash,current:await snapshotCurrent(session,row,tx,sources[row.audience])});
    const draftRows=await query<DraftRow>("SELECT * FROM fp_community_drafts WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 ORDER BY created_at DESC,id DESC LIMIT 30",[session.tenantId,session.projectId,session.actorId],tx);
    const drafts:BriefDraft[]=[],translations:TranslationView[]=[];
    for(const row of draftRows){const draft=await draftView(session,row,tx,sources[row.audience]);drafts.push(draft);const rows=await query<TranslationRow>("SELECT * FROM fp_community_translations WHERE draft_id=$1 ORDER BY revision DESC LIMIT 20",[row.id],tx);for(const translation of rows)translations.push(await translationView(session,translation,draft,tx));}
    const runs=await communityRunViews(session,tx);
    return {projectId:session.projectId,projectTitle:sources.supporter.title,role:session.role,mode:session.mode,snapshots,drafts,translations,runs,modelConfigured:!!(process.env.OPENAI_API_KEY&&(process.env.OPENAI_COMMUNITY_MODEL||process.env.OPENAI_MODEL)),scheduleEnabled:false,deliveryMode:"preview_only"};
  });
}
export async function communityRunViews(session:Session,tx:SqlConnection):Promise<CommunityRunView[]> {
  const rows=await query<{id:string;task:CommunityRunView["task"];state:CommunityRunView["state"];model:string;input_hash:string;response_identity_hash:string|null;output_hash:string|null;result_id:string|null;created_at:Date;completed_at:Date|null;code:string|null;dispatch_count:number;poll_count:number;duration_ms:number|null;input_tokens:number|null;output_tokens:number|null}>("SELECT id,task,state,model,input_hash,response_identity_hash,output_hash,result_id,created_at,completed_at,code,dispatch_count,poll_count,duration_ms,input_tokens,output_tokens FROM fp_community_runs WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 ORDER BY created_at DESC,id DESC LIMIT 40",[session.tenantId,session.projectId,session.actorId],tx);
  return rows.map(r=>({id:r.id,task:r.task,state:r.state,model:r.model,inputHash:r.input_hash,responseIdentityHash:r.response_identity_hash,outputHash:r.output_hash,resultId:r.result_id,createdAt:r.created_at.toISOString(),completedAt:r.completed_at?.toISOString()??null,code:r.code,dispatchCount:r.dispatch_count,pollCount:r.poll_count,durationMs:r.duration_ms,inputTokens:r.input_tokens,outputTokens:r.output_tokens}));
}
export async function readSupporterStory(session:Session):Promise<SupporterStory> {
  return database().transaction(async tx=>{
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");await requireCurrentRole(session,session.role,tx);
    const source=await communitySource(session,"supporter",tx),personal=await personalCommunitySource(session,tx);
    const previews=await query<{draft_id:string;translation_id:string|null;source_hash:string;draft_hash:string;translation_hash:string|null}>("SELECT DISTINCT ON(draft_id) draft_id,translation_id,source_hash,draft_hash,translation_hash FROM fp_community_update_previews WHERE tenant_id=$1 AND project_id=$2 ORDER BY draft_id,created_at DESC,id DESC LIMIT 20",[session.tenantId,session.projectId],tx);
    const drafts:SupporterStory["drafts"]=[];
    for(const preview of previews){if(preview.source_hash!==source.contentHash)continue;const draft=await draftView(session,await requireDraft(session,preview.draft_id,tx,true),tx,source,true);if(!draft.current||preview.draft_hash!==draft.contentHash)continue;let translation:TranslationView|null=null;if(preview.translation_id){const row=await requireTranslation(session,preview.translation_id,tx,true);translation=await translationView(session,row,draft,tx);if(!["reviewed","sample_review"].includes(translation.status)||preview.translation_hash!==translation.contentHash)translation=null;}drafts.push({draft,translation});}
    return {source,personal,translation:{status:"authored_unreviewed",sourceHash:source.contentHash},drafts};
  });
}
