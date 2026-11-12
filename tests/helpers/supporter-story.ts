import { createHash, randomBytes, randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "@fracture/paypal-core";
import type { Session } from "../../lib/server/auth";
import type { SettlementReceipt } from "../../lib/contracts";
import { database, query } from "../../lib/server/db";
import { createProject, sampleReceipt } from "../../lib/server/seed";
import { recordSampleOrigin } from "../../lib/server/sample-funding-origins";
import { recordSampleFundingUse } from "../../lib/server/funding-adjustments";
import { persistFundingReceipt } from "../../lib/server/funding-writes";
import { cancellationCaseReview, createFundingPolicy, executeFundingChoice, fundingDesk, openCancellationCase, recordFundingChoice } from "../../lib/server/funding-lifecycle";
import { importSamplePlanningSources } from "../../lib/server/planning-sources";
import { readPlanningWorkspace } from "../../lib/server/planning";
import { packageBindings } from "../../lib/server/planning-store";
import { samplePlan } from "../../lib/planning/templates";
import { memoryStorage, type PlanningFixture } from "./planning";

/** Only new, explicitly fictional records. No provider adapter is available. */
export async function storyFixture(expiresAt=new Date(Date.now()+2*3_600_000).toISOString()) {
  const identity={tenantId:randomUUID(),projectId:randomUUID(),mode:"sample" as const};
  await database().transaction(async tx=>{
    // Empty packages first; no unrelated walkthrough donors are borrowed.
    await createProject(tx,identity.tenantId,identity.projectId,`story-fixture-${randomUUID()}`,"live_sandbox");
    await tx.query("UPDATE fp_tenants SET mode='sample' WHERE id=$1",[identity.tenantId]);
  });
  const actors: {key:string;token:string;session:Session}[]=[];
  for(const [key,role] of [["organizer","organizer"],["donor-a","donor"],["donor-b","donor"],["auditor","auditor"],["volunteer","volunteer"]] as const) {
    const token=randomBytes(32).toString("base64url"),session:Session={...identity,id:randomUUID(),actorId:randomUUID(),role,expiresAt};
    await query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,$4::jsonb)",[identity.tenantId,identity.projectId,session.actorId,JSON.stringify(role==="organizer"?["organizer","volunteer","donor","auditor"]:[role])]);
    await query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",[session.id,createHash("sha256").update(token).digest("hex"),identity.tenantId,identity.projectId,session.actorId,role,expiresAt]);
    actors.push({key,token,session});
  }
  const [organizer,a,b,auditor,volunteer]=actors,{files,storage}=memoryStorage();
  return {...identity,organizer:organizer.session,donors:[a.session,b.session],auditor:auditor.session,volunteer:volunteer.session,actors,files,storage};
}
export type StoryFixture=Awaited<ReturnType<typeof storyFixture>>;
export async function storyReceipt(f:StoryFixture,donor:Session,packageId="electronics",amountMinor=12000,invoice=false,origin=true) {
  const obligationId=randomUUID(),receipt=sampleReceipt(f.tenantId,f.projectId,obligationId,packageId,amountMinor,randomUUID(),invoice);
  receipt.observedAt=new Date().toISOString();
  await database().transaction(async tx=>{
    const [pkg]=await query<{version:number;data:{title:string;description:string}}>("SELECT version,data FROM fp_packages WHERE project_id=$1 AND id=$2",[f.projectId,packageId],tx);
    await tx.query("INSERT INTO fp_obligations(id,tenant_id,project_id,package_id,actor_id,amount_minor,channel,purpose,data) VALUES($1,$2,$3,$4,$5,$6,'collected','conditional_pledge',$7::jsonb)",[obligationId,f.tenantId,f.projectId,packageId,donor.actorId,amountMinor,JSON.stringify({donorLabel:`Private fixture label ${donor.actorId}`,consentPolicy:"Fictional Sample starting authority only."})]);
    if(origin)await recordSampleOrigin(tx,{tenantId:f.tenantId,projectId:f.projectId,obligationId,packageId,packageVersion:pkg.version,donorActorId:donor.actorId,amountMinor,title:pkg.data.title,purpose:pkg.data.description});
    await tx.query("INSERT INTO fp_settlement_receipts(id,tenant_id,project_id,obligation_id,package_id,provider_ref,provenance,data) VALUES($1,$2,$3,$4,$5,$6,'sample',$7::jsonb)",[receipt.id,f.tenantId,f.projectId,obligationId,packageId,receipt.actualProviderPaymentRef,JSON.stringify(receipt)]);
    await tx.query("INSERT INTO fp_economic_aliases(merchant_scope,alias,receipt_id) VALUES($1,$2,$3)",[f.tenantId,receipt.economicAliases[0],receipt.id]);
  });
  return receipt;
}
export async function storyUse(f:StoryFixture,receipt:SettlementReceipt,amountMinor:number,kind:"claim"|"fee"="claim",state:"paid"|"reserved"="paid") {
  const id=randomUUID();await database().transaction(async tx=>{
    await tx.query("INSERT INTO fp_receipt_allocations(id,tenant_id,project_id,receipt_id,claim_id,claim_line_id,package_id,amount_minor,state,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[id,f.tenantId,f.projectId,receipt.id,randomUUID(),randomUUID(),receipt.packageId,amountMinor,state,kind]);
    if(state==="paid")await recordSampleFundingUse(tx,f.organizer,id);
  });return id;
}
/** Synthetic existing return state, never a dispatch or an approval claim. */
export async function storyPendingReturn(f:StoryFixture,receipt:SettlementReceipt,amountMinor:number,state:"unknown"|"refused"|"not_sent"="unknown") {
  if(receipt.provenance!=="sample")throw new Error("Only fictional return fixtures are permitted");
  const id=randomUUID(),digest=sha256(canonicalJson({fixture:true,id,receipt:receipt.id,amountMinor,state}));
  await database().transaction(async tx=>{
    const [current]=await query<{version:number;data:SettlementReceipt}>("SELECT version,data FROM fp_settlement_receipts WHERE id=$1",[receipt.id],tx);
    const version=await persistFundingReceipt(tx,{...f,provenance:"sample"},current,{...current.data,pendingAttributedRefundReserveMinor:amountMinor},[{packageId:receipt.packageId,pendingRefundMinor:amountMinor-current.data.pendingAttributedRefundReserveMinor}]);
    const owner=f.actors.find(actor=>actor.session.actorId===f.donors[0].actorId)!.session;
    await tx.query(`INSERT INTO fp_refunds(id,tenant_id,project_id,receipt_id,obligation_id,actor_id,session_id,approved_role,intent_id,reason,amount_minor,attributed_minor,excess_minor,receipt_version,receipt_identity_digest,approval_digest,state,budget,observed_at,funding_package_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,'donor',$8,'Explicitly fictional saved return state; no actual provider request or human approval occurred.',$9,$9,0,$10,$11,$11,$12,$13::jsonb,$14,$15)`,[id,f.tenantId,f.projectId,receipt.id,receipt.donorObligationId,owner.actorId,owner.id,randomUUID(),amountMinor,version,digest,state,JSON.stringify({fixture:true,provenance:"sample",noProviderRequest:true}),new Date().toISOString(),receipt.packageId]);
  });return id;
}
export async function storyPolicy(f:StoryFixture,packageId:string) {
  const [pkg]=await query<{version:number}>("SELECT version FROM fp_packages WHERE project_id=$1 AND id=$2",[f.projectId,packageId]);
  const saved=await createFundingPolicy(f.organizer,{intentId:randomUUID(),packageId,expectedVersion:pkg.version,kind:"mixed",acknowledged:true});
  return (await fundingDesk(f.organizer)).policies.find(row=>row.id===saved.id)!;
}
export async function storyCase(f:StoryFixture,packageId:string,deadline=new Date(Date.now()+60*60_000).toISOString()) {
  const review=await cancellationCaseReview(f.organizer,packageId);
  const saved=await openCancellationCase(f.organizer,{intentId:randomUUID(),packageId,expectedVersion:review.packageVersion,reviewDigest:review.digest,reason:"Explicit fictional change of purpose for the isolated contribution-story exercise.",deadline,acknowledged:true});
  return (await fundingDesk(f.organizer)).cases.find(row=>row.id===saved.id)!;
}
export async function storyChoice(f:StoryFixture,donor:Session,receipt:SettlementReceipt,saved:Awaited<ReturnType<typeof storyCase>>,target:Awaited<ReturnType<typeof storyPolicy>>|null,execute=true) {
  const source=saved.sources.find(row=>row.receiptId===receipt.id)!;
  const result=await recordFundingChoice(donor,{intentId:randomUUID(),caseId:saved.id,caseDigest:saved.digest,receiptId:receipt.id,expectedVersion:source.receiptVersion,kind:target?"reallocation":"return",policyId:target?.id??null,policyDigest:target?.digest??null,acknowledged:true});
  const selected=(await fundingDesk(donor)).cases.find(row=>row.id===saved.id)!.sources.find(row=>row.receiptId===receipt.id)!.choice!;
  const command={intentId:randomUUID(),choiceId:result.id,digest:selected.digest,expectedVersion:selected.version};
  if(execute)await executeFundingChoice(donor,command);return command;
}
export async function storyPlanning(f:StoryFixture):Promise<PlanningFixture> {
  await importSamplePlanningSources(f.organizer,randomUUID(),f.storage);
  const workspace=await readPlanningWorkspace(f.organizer),sources=workspace.sources;
  const sketch=sources.find(s=>s.purpose==="sketch")!,quote=sources.find(s=>s.purpose==="quote")!,photo=sources.find(s=>s.purpose==="photo")!,credential=sources.find(s=>s.purpose==="signoff")!;
  const plan=samplePlan(sketch.id,quote.id,await packageBindings(f.projectId));
  plan.assumptions=["Isolated fictional story exercise. No actual physical work, professional qualification or independent human review is claimed."];
  plan.zones.forEach(zone=>zone.reviewState="reviewed");plan.packages.forEach(pkg=>pkg.reviewState="reviewed");
  return {session:f.organizer,storage:f.storage,files:f.files,sources,sketch,quote,photo,credential,plan};
}
export async function projectFingerprint(projectId:string) {
  const tables=await query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename");
  const rows:Record<string,string>={};
  for(const {tablename} of tables) {
    if(!/^[a-z0-9_]+$/.test(tablename))throw new Error("Unexpected fixture table");
    const columns=await query<{column_name:string}>("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1",[tablename]);
    if(!columns.some(row=>row.column_name==="project_id"))continue;
    const values=await query(`SELECT row_to_json(t) value FROM "${tablename}" t WHERE project_id=$1 ORDER BY row_to_json(t)::text`,[projectId]);
    rows[tablename]=sha256(canonicalJson(values));
  }
  return rows;
}
