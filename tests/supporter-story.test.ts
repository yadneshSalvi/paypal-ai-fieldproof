import assert from "node:assert/strict";
import { describe,it } from "node:test";
import { randomUUID } from "node:crypto";
import { canonicalJson,sha256 } from "@fracture/paypal-core";
import { alignedFixture,bytesHash,errorCode,isolatedPlanningDatabase,publishFixture } from "./helpers/planning";
import { draftFixture,sampleTranslationReview } from "./helpers/community";
import { projectFingerprint,storyCase,storyChoice,storyFixture,storyPendingReturn,storyPlanning,storyPolicy,storyReceipt,storyUse } from "./helpers/supporter-story";
import { previewCommunityUpdate,readSupporterStory } from "../lib/server/community";
import { assertSupporterContext,readContributionSource,readStoryImage } from "../lib/server/supporter-story";
import { database,query } from "../lib/server/db";
import { appendFundingAssignment,persistFundingReceipt } from "../lib/server/funding-writes";
import { readFundingProjection } from "../lib/server/funding-positions";
import { observeOriginalReturns } from "../lib/server/funding-return-reconciliation";
import { revokeFundingChoice } from "../lib/server/funding-lifecycle";
import { setPlanningSourcePermission } from "../lib/server/planning-sources";
import { revokePhotoAlignment } from "../lib/server/planning-evidence";
import { createProofDerivative,createProofDraft,decideProofSnapshot,readProofDesk,reviewProofDerivative } from "../lib/server/proof";
import type { SupporterStory } from "../lib/community/contracts";

isolatedPlanningDatabase();
const expected=(story:SupporterStory)=>({contextHash:story.journey.contextHash,sourceHash:story.journey.sourceHash});

describe("personal contribution story and exact source boundaries",()=>{
  it("keeps both payment rails and the original receipt while following a current-purpose transfer and paid fee",async()=>{
    const f=await storyFixture(),orders=await storyReceipt(f,f.donors[0]),invoice=await storyReceipt(f,f.donors[0],"materials",10001,true),other=await storyReceipt(f,f.donors[1],"safety",7000,true);
    await storyPolicy(f,"electronics");await storyUse(f,orders,3200);await storyUse(f,orders,25,"fee");
    const target=await storyPolicy(f,"printing"),closed=await storyCase(f,"electronics");await storyChoice(f,f.donors[0],orders,closed,target);
    const before=await projectFingerprint(f.projectId),story=await readSupporterStory(f.donors[0]);
    assert.equal(story.journey.scope,"own_contributions");assert.equal(story.journey.contributions.length,2);
    assert.deepEqual(new Set(story.journey.contributions.map(row=>row.sourceKind)),new Set(["orders_capture","invoice_payment"]));
    const contribution=story.journey.contributions.find(row=>row.id===orders.id)!;
    const origin=contribution.positions.find(row=>row.packageId==="electronics")!,destination=contribution.positions.find(row=>row.packageId==="printing")!;
    assert.equal(origin.paidMinor,3225);assert.equal(origin.feeMinor,25);assert.equal(origin.availableMinor,0);assert.equal(origin.netMinor,3225);
    assert.equal(destination.netMinor,8775);assert.equal(destination.budget.amountMinor,120000);assert.equal(destination.share?.percentNumerator,"117");assert.equal(destination.share?.percentDenominator,"16");assert.equal(destination.share?.percentTenths,"73");
    assert.equal(contribution.original.amountMinor,96000);assert.equal(contribution.timeline.filter(row=>row.kind==="payment").length,1);assert.equal(contribution.timeline.filter(row=>row.kind==="assignment").length,1);
    assert.equal(contribution.timeline.find(row=>row.kind==="fee")?.review?.status,"missing");
    const full=await readFundingProjection({...f,provenance:"sample"},database());
    for(const row of contribution.positions){const canonical=full.positions.find(value=>value.receiptId===orders.id&&value.packageId===row.packageId)!;assert.equal(row.netMinor,canonical.collectedMinor);assert.equal(row.availableMinor,canonical.availableMinor);assert.equal(row.availableMinor+row.paidMinor+row.committedMinor+row.pendingReturnMinor+row.reviewMinor,row.netMinor);}
    const source=await readContributionSource(f.donors[0],orders.id,expected(story));
    assert.equal(source.document.receipt.sourceKind,"orders_capture");assert.equal(source.document.receipt.sourceOrderId,orders.sourceOrderId);assert.equal(source.document.receipt.donorObligationId,orders.donorObligationId);assert.equal(source.document.decisions.length,1);assert.equal(source.document.decisions[0].destination?.packageId,"printing");
    assert.equal(sha256(source.downloadText),source.downloadHash);assert.equal(source.downloadText,canonicalJson(source.document));
    const invoiceSource=await readContributionSource(f.donors[0],invoice.id,expected(story));assert.equal(invoiceSource.document.receipt.sourceInvoiceId,invoice.sourceInvoiceId);assert.equal(invoiceSource.document.receipt.refundAdapter,"unqualified");
    const text=JSON.stringify([story,source,invoiceSource]);for(const forbidden of [other.id,other.donorObligationId,other.actualProviderPaymentRef,f.donors[1].actorId,"encrypted_data","pathname"])assert.equal(text.includes(forbidden),false,forbidden);
    await readSupporterStory(f.donors[0]);await readContributionSource(f.donors[0],orders.id,expected(story));assert.deepEqual(await projectFingerprint(f.projectId),before);
  });
  it("isolates two donors, a project-only volunteer, authorized organizer/auditor, and another workspace",async()=>{
    const f=await storyFixture(),a=await storyReceipt(f,f.donors[0]),b=await storyReceipt(f,f.donors[1],"materials",7000,true),foreign=await storyFixture();
    const own=await readSupporterStory(f.donors[0]),other=await readSupporterStory(f.donors[1]),volunteer=await readSupporterStory(f.volunteer);
    assert.deepEqual(own.journey.contributions.map(row=>row.id),[a.id]);assert.deepEqual(other.journey.contributions.map(row=>row.id),[b.id]);assert.equal(volunteer.journey.scope,"project_only");assert.equal(volunteer.journey.contributions.length,0);
    for(const actor of [f.organizer,f.auditor]){const full=await readSupporterStory(actor);assert.equal(full.journey.scope,"project_contributions");assert.equal(full.journey.contributions.length,2);assert.equal((await readContributionSource(actor,b.id,expected(full))).document.receipt.id,b.id);}
    await assert.rejects(readContributionSource(f.donors[0],b.id,expected(own)),errorCode("STORY_RECEIPT_NOT_FOUND"));
    await assert.rejects(readContributionSource(f.volunteer,a.id,expected(volunteer)),errorCode("STORY_RECEIPT_NOT_FOUND"));
    await assert.rejects(readContributionSource(foreign.donors[0],a.id,expected(own)),errorCode("STORY_CONTEXT_CHANGED"));
    await assert.rejects(assertSupporterContext(f.donors[1],own.journey.contextHash),errorCode("STORY_CONTEXT_CHANGED"));
  });
  it("keeps uncollected pledges and a saved wallet out of the collected story",async()=>{
    const f=await storyFixture();await query("INSERT INTO fp_obligations(id,tenant_id,project_id,package_id,actor_id,amount_minor,channel,purpose,data) VALUES($1,$2,$3,'electronics',$4,4900,'uncollected','conditional_pledge',$5::jsonb)",[randomUUID(),f.tenantId,f.projectId,f.donors[0].actorId,JSON.stringify({walletToken:"private-synthetic-wallet",donorLabel:"private-unpaid-label"})]);
    const story=await readSupporterStory(f.donors[0]);assert.equal(story.journey.contributions.length,0);assert.deepEqual(story.journey.unpaid,{count:1,amountMinor:4900});assert.equal(JSON.stringify(story).includes("private-synthetic-wallet"),false);
  });
  it("binds an earlier contribution to its saved denominator, and refuses an unknown or conflicting budget",async()=>{
    const f=await storyFixture(),receipt=await storyReceipt(f,f.donors[0]);await storyPolicy(f,"electronics");
    await query("UPDATE fp_packages SET version=version+1,budget_minor=99000,data=jsonb_set(data,'{budgetMinor}','99000'::jsonb) WHERE project_id=$1 AND id='electronics'",[f.projectId]);
    const old=(await readSupporterStory(f.donors[0])).journey.contributions[0].positions[0];assert.equal(old.state,"earlier_version");assert.equal(old.budget.version,1);assert.equal(old.currentVersion,2);assert.equal(old.budget.amountMinor,96000);assert.equal(old.share?.numeratorMinor,receipt.creditedMinor);
    const missing=await storyFixture();await storyReceipt(missing,missing.donors[0],"electronics",7500,false,false);const unbound=(await readSupporterStory(missing.donors[0])).journey.contributions[0];assert.equal(unbound.originalShare,null);assert.equal(unbound.positions[0].share,null);assert.equal(unbound.positions[0].netMinor,7500);
    const conflict=await storyFixture();await storyReceipt(conflict,conflict.donors[0]);await query("UPDATE fp_packages SET budget_minor=97000 WHERE project_id=$1 AND id='electronics'",[conflict.projectId]);const uncertain=(await readSupporterStory(conflict.donors[0])).journey.contributions[0].positions[0];assert.equal(uncertain.budget.status,"conflict");assert.equal(uncertain.share,null);assert.equal(uncertain.netMinor,12000);
  });
  it("does not collapse distinct historical package versions into one convenient denominator",async()=>{
    const f=await storyFixture(),receipt=await storyReceipt(f,f.donors[0]);
    const consentedAt=new Date(Date.now()-1000).toISOString(),consentExpiresAt=new Date(Date.now()+60_000).toISOString();
    await database().transaction(async tx=>{for(const sequence of [1,2])await appendFundingAssignment(tx,{...f,provenance:"sample"},{id:randomUUID(),receiptId:receipt.id,sequence,kind:"reallocation",reversesId:null,tenantId:f.tenantId,projectId:f.projectId,provenance:"sample",currency:"USD",amountMinor:6000,debit:{packageId:"electronics",packageVersion:1},credit:{packageId:"printing",packageVersion:sequence},consentId:`fictional-consent-${sequence}`,consentDigest:sha256(`fictional-consent-${sequence}`),donorActorId:f.donors[0].actorId,consentedAt,consentExpiresAt,committedAt:new Date().toISOString()});});
    const position=(await readSupporterStory(f.donors[0])).journey.contributions[0].positions.find(row=>row.packageId==="printing")!;
    assert.deepEqual(position.versions,[1,2]);assert.equal(position.sourceIssue,"MULTIPLE_PURPOSE_VERSIONS");assert.equal(position.netMinor,12000);assert.equal(position.share,null);
  });
  it("preserves withdrawn choices and a fully completed return without a remaining share",async()=>{
    const f=await storyFixture(),receipt=await storyReceipt(f,f.donors[0],"electronics",5000);await storyPolicy(f,"electronics");const target=await storyPolicy(f,"printing"),closed=await storyCase(f,"electronics");
    const earlier=await storyChoice(f,f.donors[0],receipt,closed,target,false);await revokeFundingChoice(f.donors[0],{...earlier,intentId:randomUUID()});await storyChoice(f,f.donors[0],receipt,closed,null);
    const story=await readSupporterStory(f.donors[0]),position=story.journey.contributions[0].positions[0];assert.equal(position.state,"returned");assert.equal(position.netMinor,0);assert.equal(position.availableMinor,0);assert.equal(position.returnedMinor,5000);assert.equal(position.share?.percentTenths,"0");
    assert.equal(story.journey.contributions[0].timeline.filter(row=>row.kind==="return").length,1);assert.ok(story.journey.contributions[0].timeline.some(row=>row.state==="revoked"));
    const source=await readContributionSource(f.donors[0],receipt.id,expected(story));assert.equal(source.document.decisions.length,2);assert.ok(source.document.decisions.some(row=>row.revokedAt));assert.equal(source.document.receipt.grossMinor,5000);
  });
  it("keeps pending returns, expense reservations and outside-return holds out of available support",async()=>{
    const f=await storyFixture(),receipt=await storyReceipt(f,f.donors[0],"electronics",10000);await storyUse(f,receipt,1500,"claim","reserved");
    await database().transaction(tx=>persistFundingReceipt(tx,{...f,provenance:"sample"},{version:1,data:receipt},{...receipt,pendingAttributedRefundReserveMinor:2500},[{packageId:"electronics",pendingRefundMinor:2500}]));
    let story=await readSupporterStory(f.donors[0]),position=story.journey.contributions[0].positions[0];assert.equal(position.state,"pending_return");assert.equal(position.committedMinor,1500);assert.equal(position.pendingReturnMinor,2500);assert.equal(position.availableMinor,6000);assert.equal(position.netMinor,10000);
    const held=await storyFixture(),heldReceipt=await storyReceipt(held,held.donors[0]);await observeOriginalReturns(held.organizer,{intentId:randomUUID(),receiptId:heldReceipt.id,expectedVersion:1,references:[],sampleReturnMinor:1000,acknowledged:true});
    story=await readSupporterStory(held.donors[0]);position=story.journey.contributions[0].positions[0];assert.equal(position.state,"review");assert.equal(position.reviewMinor,12000);assert.equal(position.availableMinor,0);assert.equal(position.returnedMinor,0);assert.ok(story.journey.contributions[0].timeline.some(row=>row.kind==="hold"));
  });
  it("rejects source downloads when membership, actor role or source changes before disclosure",async()=>{
    for(const change of ["membership","role","source"] as const){const f=await storyFixture(),receipt=await storyReceipt(f,f.donors[0]),story=await readSupporterStory(f.donors[0]);
      await assert.rejects(readContributionSource(f.donors[0],receipt.id,expected(story),async()=>{
        if(change==="membership")await query("UPDATE fp_memberships SET state='revoked',version=version+1 WHERE actor_id=$1",[f.donors[0].actorId]);
        else if(change==="role")await query("UPDATE fp_sessions SET role='volunteer' WHERE id=$1",[f.donors[0].id]);
        else await query("UPDATE fp_packages SET version=version+1 WHERE project_id=$1 AND id='electronics'",[f.projectId]);
      }),errorCode(change==="membership"?"MEMBERSHIP_DENIED":change==="role"?"ROLE_DENIED":"STORY_SOURCE_CHANGED"));
    }
  });
  it("describes refused and never-sent returns without presenting them as underway or releasing their reserved share",async()=>{
    for(const state of ["refused","not_sent","unknown"] as const){const f=await storyFixture(),receipt=await storyReceipt(f,f.donors[0],"electronics",5000);const id=await storyPendingReturn(f,receipt,3500,state);
      const before=await projectFingerprint(f.projectId),story=await readSupporterStory(f.donors[0]),contribution=story.journey.contributions[0],event=contribution.timeline.find(row=>row.id===`refund:${id}`)!;
      assert.equal(event.state,state);assert.equal(event.amountMinor,3500);assert.equal(event.packageId,"electronics");assert.equal(event.title,state==="refused"?"Original-route return refused":state==="not_sent"?"Original-route return not sent":"Original-route return needs an outcome check");assert.doesNotMatch(event.title,/in progress|completed/);assert.match(event.detail,/original|same operation/);
      assert.equal(contribution.positions[0].pendingReturnMinor,3500);assert.equal(contribution.positions[0].returnedMinor,0);assert.equal(contribution.positions[0].availableMinor,1500);await readContributionSource(f.donors[0],receipt.id,expected(story));assert.deepEqual(await projectFingerprint(f.projectId),before);
    }
  });
  it("discloses only reviewed shared images and preserves source and package-version tombstones",async()=>{
    const f=await storyFixture();await storyReceipt(f,f.donors[0]);const plan=await storyPlanning(f);await publishFixture(plan);const shared=await alignedFixture(plan);await shared.review();const privateImage=await alignedFixture(plan,"printing","reviewers_only");await privateImage.review();
    let story=await readSupporterStory(f.donors[0]);assert.ok(story.journey.evidence.some(row=>row.id===`alignment:${shared.id}`));assert.equal(JSON.stringify(story).includes(privateImage.id),false);assert.equal(JSON.stringify(story).includes(plan.photo.filename),false);
    const evidence=story.journey.evidence.find(row=>row.id===`alignment:${shared.id}`)!;assert.equal(evidence.packageVersion,1);assert.equal(evidence.sourceClass,"sample");assert.ok(evidence.reviewedAt);assert.equal(bytesHash(await readStoryImage(f.donors[0],evidence.id,expected(story),f.storage)),evidence.sourceHash);
    await revokePhotoAlignment(f.organizer,shared.id,{intentId:randomUUID(),contentHash:shared.contentHash,expectedRevision:shared.revision,reason:"Fictional review copy withdrawn for the source-bound story exercise."});
    story=await readSupporterStory(f.donors[0]);const revoked=story.journey.evidence.find(row=>row.id===evidence.id)!;assert.equal(revoked.state,"revoked");assert.equal(revoked.previewUrl,null);assert.equal(revoked.sourceHash,null);await assert.rejects(readStoryImage(f.donors[0],evidence.id,expected(story),f.storage),errorCode("STORY_IMAGE_UNAVAILABLE"));
  });
  it("never returns image bytes after withdrawal or membership revocation during storage read",async()=>{
    for(const change of ["source","membership"] as const){const f=await storyFixture();await storyReceipt(f,f.donors[0]);const plan=await storyPlanning(f);await publishFixture(plan);const shared=await alignedFixture(plan);await shared.review();const story=await readSupporterStory(f.donors[0]);let changed=false;
      const gated={...f.storage,async read(pathname:string,maxBytes?:number){const bytes=await f.storage.read(pathname,maxBytes);if(!changed){changed=true;if(change==="source")await setPlanningSourcePermission(f.organizer,plan.photo.id,{intentId:randomUUID(),expectedVersion:1,permission:"withdrawn",reason:"Fictional source removed while its copy was being read."});else await query("UPDATE fp_memberships SET state='revoked',version=version+1 WHERE actor_id=$1",[f.donors[0].actorId]);}return bytes;}};
      await assert.rejects(readStoryImage(f.donors[0],`alignment:${shared.id}`,expected(story),gated));assert.equal(changed,true);
    }
  });
  it("uses existing public privacy-reviewed derivatives and withdraws their private-story image at source revocation",async()=>{
    const f=await storyFixture();await storyReceipt(f,f.donors[0]);const plan=await storyPlanning(f);await publishFixture(plan);
    const saved=await createProofDerivative(f.organizer,{intentId:randomUUID(),documentId:plan.photo.id,page:1,packageId:"electronics",crop:{x:0,y:0,width:1,height:1},masks:[{x:.1,y:.1,width:.2,height:.2}]},f.storage);
    let desk=await readProofDesk(f.organizer),image=desk.derivatives.find(row=>row.id===saved.id)!;await reviewProofDerivative(f.organizer,image.id,{intentId:randomUUID(),contentHash:image.contentHash,expectedVersion:image.reviewVersion,privacyChecked:true,publicSharingConfirmed:true});
    desk=await readProofDesk(f.organizer);const draft=await createProofDraft(f.organizer,{intentId:randomUUID(),packageId:"electronics",expectedVersion:desk.packages.find(row=>row.id==="electronics")!.headVersion,derivativeIds:[image.id]});
    for(const step of ["review","publish"] as const){desk=await readProofDesk(f.organizer);const snapshot=desk.snapshots.find(row=>row.id===draft.id)!;await decideProofSnapshot(f.organizer,step,{intentId:randomUUID(),snapshotId:draft.id,expectedVersion:desk.packages.find(row=>row.id==="electronics")!.headVersion,contentHash:snapshot.contentHash,acknowledged:true});}
    let story=await readSupporterStory(f.donors[0]);const evidence=story.journey.evidence.find(row=>row.kind==="public_image")!;assert.ok(evidence);assert.ok(evidence.reviewedAt);assert.ok(evidence.reviewerLabel?.includes("privacy"));assert.equal(bytesHash(await readStoryImage(f.donors[0],evidence.id,expected(story),f.storage)),image.contentHash);
    await setPlanningSourcePermission(f.organizer,plan.photo.id,{intentId:randomUUID(),expectedVersion:1,permission:"withdrawn",reason:"Fictional public derivative withdrawal test for private story."});
    story=await readSupporterStory(f.donors[0]);assert.equal(story.journey.evidence.some(row=>row.previewUrl),false);assert.ok(story.journey.evidence.some(row=>row.kind==="publication"&&row.state==="revoked"));
  });
  it("keeps bilingual source binding honest and withholds a stale Spanish preview without creating new reviews",async()=>{
    const f=await storyFixture();await storyReceipt(f,f.donors[0]);const draft=await draftFixture(f.organizer);await sampleTranslationReview(f.organizer,draft);await previewCommunityUpdate(f.organizer,{intentId:randomUUID(),draftId:draft.draft.id,translationId:draft.translation.id,acknowledged:true});
    let story=await readSupporterStory(f.donors[0]);assert.equal(story.translation.status,"authored_unreviewed");assert.equal(story.translation.sourceHash,story.source.contentHash);assert.equal(story.drafts[0].translation?.status,"sample_review");assert.equal(story.drafts[0].translation?.sourceHash,story.drafts[0].draft.contentHash);assert.equal(story.drafts[0].draft.sourceHash,story.source.contentHash);
    const before=await projectFingerprint(f.projectId);await readSupporterStory(f.donors[0]);assert.deepEqual(await projectFingerprint(f.projectId),before);
    await query("UPDATE fp_packages SET version=version+1 WHERE project_id=$1 AND id='electronics'",[f.projectId]);story=await readSupporterStory(f.donors[0]);assert.equal(story.drafts.length,0);assert.equal(story.journey.hiddenUpdateCount,1);assert.equal(story.translation.status,"authored_unreviewed");
  });
});
