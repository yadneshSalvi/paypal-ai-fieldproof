import { randomUUID } from "node:crypto";
import type { TemplateId } from "../../lib/community/templates";
import { createCommunityWorkspace, rememberWorkspace } from "../../lib/server/community-workspaces";
import { captureCommunitySnapshot, readCommunityDesk, saveCommunityBackTranslation, saveCommunityDraft, reviewCommunityTranslation } from "../../lib/server/community";
import type { Session } from "../../lib/server/auth";

export async function communityFixture(templateId:TemplateId="community-garden",libraryToken?:string,activeToken:string|null=null,expectedProjectId:string|null=null){
  const library=await rememberWorkspace(libraryToken??null,activeToken),input={intentId:randomUUID(),templateId,title:`Controlled ${templateId} fixture`,expectedProjectId,acknowledged:true};
  const workspace=await createCommunityWorkspace(library.token,activeToken,input);
  return {...workspace,libraryToken:library.token,createInput:input};
}
export async function draftFixture(session:Session,audience:"treasurer"|"supporter"="supporter"){
  const captured=await captureCommunitySnapshot(session,{intentId:randomUUID(),audience}),snapshot=(await readCommunityDesk(session)).snapshots.find(s=>s.id===captured.id)!;
  const saved=await saveCommunityDraft(session,{intentId:randomUUID(),snapshotId:snapshot.id,sourceHash:snapshot.contentHash,statementIds:snapshot.statements.map(s=>s.id),title:"Controlled source-bound test update"});
  const desk=await readCommunityDesk(session),draft=desk.drafts.find(d=>d.id===saved.id)!,translation=desk.translations.find(t=>t.draftId===draft.id)!;
  return {snapshot,draft,translation};
}
export async function sampleTranslationReview(session:Session,f:Awaited<ReturnType<typeof draftFixture>>){
  await saveCommunityBackTranslation(session,{intentId:randomUUID(),translationId:f.translation.id,contentHash:f.translation.contentHash,paragraphs:f.draft.paragraphs.map(p=>({paragraphId:p.id,text:p.english})),manualAcknowledged:true});
  const latest=(await readCommunityDesk(session)).translations.find(t=>t.id===f.translation.id)!;
  const reviewInput={intentId:randomUUID(),translationId:latest.id,contentHash:latest.contentHash,backTranslationHash:latest.backTranslation!.hash,decision:"approved" as const,kind:"sample_exercise" as const,note:"Controlled sample workflow exercise only; no fluent human review is represented.",sourceCompared:true,amountsAndConditionsChecked:true,fluentSpanishAttested:false};
  const review=await reviewCommunityTranslation(session,reviewInput);return {review,reviewInput,translation:latest};
}
