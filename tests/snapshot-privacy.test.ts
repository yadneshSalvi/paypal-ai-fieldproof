import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { query } from "../lib/server/db";
import { projectSnapshot } from "../lib/server/repository";
import { PUBLIC_PROJECT, sampleEvidence } from "../lib/server/seed";
import { isolatedPlanningDatabase } from "./helpers/planning";
import { projectFingerprint, storyCase, storyChoice, storyFixture, storyPolicy, storyReceipt, storyUse } from "./helpers/supporter-story";

isolatedPlanningDatabase();

describe("page, bootstrap and refresh snapshot disclosure",()=>{
  it("keeps whole-project funding conserved while disclosing only each donor's sources and no volunteer receipts",async()=>{
    const f=await storyFixture(),a=await storyReceipt(f,f.donors[0],"electronics",5000),b=await storyReceipt(f,f.donors[1],"printing",7000,true);
    await storyPolicy(f,"printing");await storyUse(f,b,500);await storyUse(f,b,25,"fee");
    const target=await storyPolicy(f,"materials"),closed=await storyCase(f,"printing"),choice=await storyChoice(f,f.donors[1],b,closed,target);
    const before=await projectFingerprint(f.projectId),full=await projectSnapshot(f.organizer);
    assert.equal(full.financialScope,"project");assert.deepEqual(new Set(full.receipts.map(row=>row.id)),new Set([a.id,b.id]));
    assert.equal(full.packages.reduce((sum,row)=>sum+row.collectedMinor,0),12000);
    assert.equal(full.packages.find(row=>row.id==="printing")?.collectedMinor,525);assert.equal(full.packages.find(row=>row.id==="materials")?.collectedMinor,6475);
    for(const [actor,own,other] of [[f.donors[0],a,b],[f.donors[1],b,a]] as const){
      const snapshot=await projectSnapshot(actor),serialized=JSON.stringify(snapshot);
      assert.equal(snapshot.financialScope,"own");assert.deepEqual(snapshot.receipts.map(row=>row.id),[own.id]);assert.deepEqual(snapshot.obligations.map(row=>row.id),[own.donorObligationId]);
      assert.deepEqual(snapshot.packages,full.packages);
      for(const secret of [other.id,other.donorObligationId,other.actualProviderPaymentRef,other.sourceOrderId,other.sourceInvoiceId,...other.economicAliases].filter(Boolean) as string[])assert.equal(serialized.includes(secret),false);
      if(actor.actorId===f.donors[0].actorId)for(const secret of [f.donors[1].actorId,choice.choiceId,choice.digest])assert.equal(serialized.includes(secret),false);
    }
    const volunteer=await projectSnapshot(f.volunteer);assert.equal(volunteer.financialScope,"none");assert.deepEqual(volunteer.receipts,[]);assert.deepEqual(volunteer.obligations,[]);assert.deepEqual(volunteer.packages,full.packages);
    for(const secret of [a.id,b.id,a.donorObligationId,b.donorObligationId,...f.donors.map(row=>row.actorId),choice.choiceId,choice.digest])assert.equal(JSON.stringify(volunteer).includes(secret),false);
    const auditor=await projectSnapshot(f.auditor);assert.equal(auditor.financialScope,"project");assert.deepEqual(auditor.receipts,full.receipts);assert.deepEqual(auditor.obligations,full.obligations);assert.deepEqual(auditor.packages,full.packages);
    assert.deepEqual(await projectFingerprint(f.projectId),before);
  });

  it("does not serialize nested consent, destination or decision additions from storage into the page contract",async()=>{
    const f=await storyFixture(),own=await storyReceipt(f,f.donors[0]),other=await storyReceipt(f,f.donors[1],"materials",6500,true);
    const marker=`private-source-${randomUUID()}`,privateData={reviewEvidence:{originalConsent:{actorId:f.donors[1].actorId,receiptId:other.id},destination:{email:`${marker}@example.invalid`},decision:{id:marker,digest:marker}}};
    for(const [table,id] of [["fp_settlement_receipts",own.id],["fp_obligations",own.donorObligationId]] as const)await query(`UPDATE ${table} SET data=data || $2::jsonb WHERE id=$1`,[id,JSON.stringify(privateData)]);
    await query("UPDATE fp_projects SET metadata=metadata || $2::jsonb WHERE id=$1",[f.projectId,JSON.stringify(privateData)]);
    await query("UPDATE fp_packages SET data=jsonb_set(data || $2::jsonb,'{zone,label}',(data->'zone'->'label') || $2::jsonb) WHERE project_id=$1 AND id='electronics'",[f.projectId,JSON.stringify(privateData)]);
    await query("INSERT INTO fp_events(id,tenant_id,project_id,type,data) VALUES($1,$2,$3,'planning.draft_saved',$4::jsonb)",[randomUUID(),f.tenantId,f.projectId,JSON.stringify({title:"A project event",detail:"A public description.",provenance:"sample",...privateData})]);
    const privateEvidence={...sampleEvidence(f.projectId)[0],id:randomUUID(),submittedBy:f.donors[1].actorId,assetPath:`/private/${marker}`,...privateData};
    await query("INSERT INTO fp_evidence(id,tenant_id,project_id,data) VALUES($1,$2,$3,$4::jsonb)",[privateEvidence.id,f.tenantId,f.projectId,JSON.stringify(privateEvidence)]);
    const before=await projectFingerprint(f.projectId);
    for(const actor of [f.donors[0],f.volunteer]){
      const value=await projectSnapshot(actor),serialized=JSON.stringify(value);
      for(const secret of [marker,f.donors[1].actorId,other.id,other.actualProviderPaymentRef,"reviewEvidence",privateEvidence.id])assert.equal(serialized.includes(secret),false,secret);
      assert.deepEqual(value.evidence,[]);
    }
    assert.equal((await projectSnapshot(f.organizer)).evidence[0].id,privateEvidence.id);
    assert.deepEqual(await projectFingerprint(f.projectId),before);
  });

  it("retains the public fictional walkthrough without borrowing private workspace sources",async()=>{
    const f=await storyFixture(),receipt=await storyReceipt(f,f.donors[0]);
    const publicView=await projectSnapshot();assert.equal(publicView.id,PUBLIC_PROJECT);assert.equal(publicView.session,null);assert.equal(publicView.financialScope,"project");assert.ok(publicView.receipts.length>0);assert.equal(publicView.evidence.length,3);
    for(const secret of [f.projectId,f.donors[0].actorId,receipt.id,receipt.actualProviderPaymentRef])assert.equal(JSON.stringify(publicView).includes(secret),false);
  });
});
