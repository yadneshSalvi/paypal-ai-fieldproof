import { randomUUID } from "node:crypto";
import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import type { FundingState } from "../contracts";
import { apportionMinorUnits } from "../domain/cancellation-apportionment";
import { assertCurrentFundingLots, projectFundingLots } from "../domain/funding-lots";
import { packagePositionTotals, projectFundingPositions, type FundingScope } from "../domain/funding-positions";
import { DomainError } from "../domain/money";
import { FUNDING_LIFECYCLE_VERSION, type CancellationCaseContract, type CancellationCaseReview, type CancellationCaseSource, type FundingCaseView, type FundingChoiceContract, type FundingChoiceView, type FundingDesk, type FundingPolicyContract } from "../funding/contracts";
import type { Session } from "./auth";
import { projectClaimLock } from "./claims";
import { database, initializeDatabase, query } from "./db";
import { assertCommittedFundingChoices, choiceContext } from "./funding-authority";
import { lockFundingScope, readFundingJournal, readFundingOrigins } from "./funding-positions";
import { appendFundingAssignment, fundingSourceDigest, persistFundingReceipt } from "./funding-writes";
import { requireCurrentRole, requireMembership } from "./membership";
import { openPrivate, sealPrivate } from "./private-values";
import { appendEvent } from "./repository";
import { outstandingPurposePledges } from "./purpose-store";

const scopeOf=(session:Pick<Session,"tenantId"|"projectId"|"mode">):FundingScope&{provenance:Session["mode"]}=>({tenantId:session.tenantId,projectId:session.projectId,provenance:session.mode});
const caseContext=(scope:Pick<FundingScope,"tenantId"|"projectId">,id:string)=>`funding-case:${scope.tenantId}:${scope.projectId}:${id}`;
const policyContext=(scope:Pick<FundingScope,"tenantId"|"projectId">,id:string)=>`funding-policy:${scope.tenantId}:${scope.projectId}:${id}`;
type Scope=Pick<Session,"tenantId"|"projectId">;
export interface CaseRow {id:string;tenant_id:string;project_id:string;package_id:string;package_version:number;version:number;revision:number;state:string;digest:string;encrypted_data:string;deadline:Date;created_by:string;membership_version:number;created_at:Date}
interface ChoiceRow {id:string;tenant_id:string;project_id:string;case_id:string;receipt_id:string;donor_actor_id:string;accepted_by:string;membership_version:number;version:number;kind:FundingChoiceContract["kind"];authority:FundingChoiceContract["authority"];amount_minor:string;state:string;digest:string;encrypted_data:string;expires_at:Date;revoked_at:Date|null;executed_id:string|null;last_code:string|null;created_at:Date}
interface PolicyRow {id:string;tenant_id:string;project_id:string;package_id:string;package_version:number;round_id:string;kind:FundingPolicyContract["kind"];state:string;digest:string;encrypted_data:string;expires_at:Date}
interface PackageRow {id:string;version:number;budget_minor:string;data:{title:string;description:string;fundingState:FundingState}}
const id=z.string().min(1).max(160),intent=z.string().uuid();
export const openCaseSchema=z.object({intentId:intent,packageId:id,expectedVersion:z.number().int().positive(),reviewDigest:z.string().regex(/^[a-f0-9]{64}$/),reason:z.string().trim().min(12).max(600),deadline:z.string().datetime(),replaceCaseId:id.optional(),acknowledged:z.literal(true)}).strict();
export const fundingPolicySchema=z.object({intentId:intent,packageId:id,expectedVersion:z.number().int().positive(),kind:z.enum(["reallocation","rollover","mixed"]),acknowledged:z.literal(true)}).strict();
export const fundingChoiceSchema=z.object({intentId:intent,caseId:id,caseDigest:z.string().regex(/^[a-f0-9]{64}$/),receiptId:id,expectedVersion:z.number().int().positive(),kind:z.enum(["return","reallocation","rollover"]),policyId:id.nullable(),policyDigest:z.string().regex(/^[a-f0-9]{64}$/).nullable(),acknowledged:z.literal(true)}).strict();
export const choiceActionSchema=z.object({intentId:intent,choiceId:id,digest:z.string().regex(/^[a-f0-9]{64}$/),expectedVersion:z.number().int().positive()}).strict();

function savedConflict():never {throw new DomainError("FUNDING_CONTRACT_CHANGED","The saved funding decision needs review before it can be used.");}
export function caseContract(row:CaseRow):CancellationCaseContract {
  const value=openPrivate<CancellationCaseContract>(row.encrypted_data,caseContext({tenantId:row.tenant_id,projectId:row.project_id},row.id));
  if (sha256(canonicalJson(value))!==row.digest || value.id!==row.id || value.tenantId!==row.tenant_id || value.projectId!==row.project_id ||
    value.packageId!==row.package_id || value.packageVersion!==row.package_version || value.revision!==row.revision || Date.parse(value.deadline)!==row.deadline.getTime() ||
    value.approvedBy!==row.created_by || value.membershipVersion!==row.membership_version) savedConflict();
  return value;
}
export function fundingChoiceContract(row:ChoiceRow):FundingChoiceContract {
  const value=openPrivate<FundingChoiceContract>(row.encrypted_data,choiceContext({tenantId:row.tenant_id,projectId:row.project_id},row.id));
  if (sha256(canonicalJson(value))!==row.digest || value.id!==row.id || value.tenantId!==row.tenant_id || value.projectId!==row.project_id ||
    value.caseId!==row.case_id || value.receiptId!==row.receipt_id || value.donorActorId!==row.donor_actor_id || value.acceptedBy!==row.accepted_by ||
    value.membershipVersion!==row.membership_version || value.version!==row.version || value.kind!==row.kind || value.authority!==row.authority ||
    value.amountMinor!==Number(row.amount_minor) || Date.parse(value.expiresAt)!==row.expires_at.getTime()) savedConflict();
  return value;
}
function policyContract(row:PolicyRow):FundingPolicyContract {
  const value=openPrivate<FundingPolicyContract>(row.encrypted_data,policyContext({tenantId:row.tenant_id,projectId:row.project_id},row.id));
  if (sha256(canonicalJson(value))!==row.digest || value.id!==row.id || value.tenantId!==row.tenant_id || value.projectId!==row.project_id ||
    value.packageId!==row.package_id || value.packageVersion!==row.package_version || value.roundId!==row.round_id || value.kind!==row.kind || Date.parse(value.expiresAt)!==row.expires_at.getTime()) savedConflict();
  return value;
}
export async function savedFundingPolicy(scope:Scope,policyId:string,tx:SqlConnection){
  const [row]=await query<PolicyRow>("SELECT * FROM fp_funding_policies WHERE id=$1 AND tenant_id=$2 AND project_id=$3",[policyId,scope.tenantId,scope.projectId],tx);
  if(!row)throw new DomainError("FUNDING_POLICY_NOT_FOUND","That purpose is outside this workspace.",404);
  return{row,value:policyContract(row)};
}
export async function ownedCase(scope:Scope,id:string,tx:SqlConnection):Promise<CaseRow>{const [row]=await query<CaseRow>("SELECT * FROM fp_funding_cases WHERE id=$1 AND tenant_id=$2 AND project_id=$3",[id,scope.tenantId,scope.projectId],tx);if(!row)throw new DomainError("CASE_NOT_FOUND","That cancellation is outside this workspace.",404);return row;}
async function ownedChoice(scope:Scope,id:string,tx:SqlConnection):Promise<ChoiceRow>{const [row]=await query<ChoiceRow>("SELECT * FROM fp_funding_choices WHERE id=$1 AND tenant_id=$2 AND project_id=$3",[id,scope.tenantId,scope.projectId],tx);if(!row)throw new DomainError("CHOICE_NOT_FOUND","That decision is outside this workspace.",404);return row;}
async function packages(scope:Scope,tx:SqlConnection){return query<PackageRow>("SELECT p.id,p.version,p.budget_minor,p.data FROM fp_packages p JOIN fp_projects project ON project.id=p.project_id WHERE p.project_id=$1 AND project.tenant_id=$2 ORDER BY p.id",[scope.projectId,scope.tenantId],tx);}
export async function actionResult(tx:SqlConnection,session:Session,intentId:string,kind:string,input:unknown):Promise<{id:string}|null>{
  const [row]=await query<{kind:string;input_hash:string;project_id:string;result:{id:string}}>("SELECT kind,input_hash,project_id,result FROM fp_funding_actions WHERE tenant_id=$1 AND actor_id=$2 AND intent_id=$3",[session.tenantId,session.actorId,intentId],tx);
  if(!row)return null;
  if(row.kind!==kind||row.project_id!==session.projectId||row.input_hash!==sha256(canonicalJson(input)))throw new DomainError("FUNDING_INTENT_CHANGED","This request already belongs to a different exact decision.");
  return row.result;
}
export async function saveAction(tx:SqlConnection,session:Session,intentId:string,kind:string,input:unknown,result:{id:string}){await tx.query("INSERT INTO fp_funding_actions(tenant_id,project_id,actor_id,intent_id,kind,input_hash,result) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",[session.tenantId,session.projectId,session.actorId,intentId,kind,sha256(canonicalJson(input)),JSON.stringify(result)]);}
export async function caseEvent(tx:SqlConnection,scope:Scope,caseId:string,actorId:string,kind:string,detail:string,extra:Record<string,unknown>={}){await tx.query("INSERT INTO fp_funding_case_events(id,tenant_id,project_id,case_id,actor_id,kind,data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",[randomUUID(),scope.tenantId,scope.projectId,caseId,actorId,kind,JSON.stringify({detail,...extra})]);}
export async function markCasesForLateReceipt(tx:SqlConnection,scope:Scope,packageId:string,receiptId:string):Promise<void>{
  const rows=await query<{id:string}>("UPDATE fp_funding_cases SET state='review_required' WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 AND state<>'superseded' RETURNING id",[scope.tenantId,scope.projectId,packageId],tx);
  for(const row of rows)await caseEvent(tx,scope,row.id,"system:receipt-observation","late_payment_observed","A newly observed original payment changes the frozen funding basis. Earlier decisions stay recorded; a separate review is required before another share can move.",{receiptId});
}
export async function refreshFundingCaseState(tx:SqlConnection,scope:Scope,caseId:string):Promise<void>{
  const row=await ownedCase(scope,caseId,tx);if(["review_required","superseded"].includes(row.state))return;
  const value=caseContract(row),choices=await query<ChoiceRow>("SELECT * FROM fp_funding_choices WHERE case_id=$1 ORDER BY version DESC",[caseId],tx);
  const resolved=value.sources.filter(source=>["executed","returned"].includes(choices.find(choice=>choice.receipt_id===source.receiptId)?.state??"")).reduce((sum,source)=>sum+source.entitlementMinor,0);
  await tx.query("UPDATE fp_funding_cases SET state=$2 WHERE id=$1",[caseId,resolved===value.totalMinor?"resolved":resolved>0?"partially_resolved":"choice_open"]);
}

export async function cancellationCaseReview(session:Session,packageId:string,tx?:SqlConnection):Promise<CancellationCaseReview>{
  if(!["organizer","auditor"].includes(session.role))throw new DomainError("ROLE_DENIED","Only the organizer or Auditor can review the complete cancellation.",403);
  if(!tx){await initializeDatabase();const result=await database().transaction(async connection=>{await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");return cancellationCaseReview(session,packageId,connection);});await requireCurrentRole(session,session.role);return result;}
  await requireCurrentRole(session,session.role,tx);
  return cancellationCaseSnapshot(session,packageId,tx);
}
/** Internal exact snapshot. The caller authorizes its read or write separately. */
export async function cancellationCaseSnapshot(session:Pick<Session,"tenantId"|"projectId"|"mode">,packageId:string,tx:SqlConnection):Promise<CancellationCaseReview>{
  const scope=scopeOf(session),pkg=(await packages(session,tx)).find(pkg=>pkg.id===packageId);
  if(!pkg)throw new DomainError("PACKAGE_NOT_FOUND","Choose a package in this workspace.",404);
  const journal=await readFundingJournal(scope,tx),projection=projectFundingPositions(journal,scope),origins=await readFundingOrigins(scope,tx);
  const rounds=await query<{id:string;state:string;package_version:number}>("SELECT id,state,package_version FROM fp_collection_rounds WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 ORDER BY id",[session.tenantId,session.projectId,packageId],tx);
  const rows=projection.positions.filter(row=>row.packageId===packageId&&row.assignedMinor>0);
  const apportion=apportionMinorUnits(rows.reduce((n,row)=>n+row.availableMinor,0),rows.map(row=>({id:row.receiptId,weightMinor:row.collectedMinor})));
  const conflicts:CancellationCaseContract["conflicts"]=[];
  const sources:CancellationCaseSource[]=rows.map(row=>{
    const source=journal.sources.find(source=>source.receipt.id===row.receiptId)!,origin=origins.find(origin=>origin.receiptId===row.receiptId);
    const share=apportion.rows.find(share=>share.id===row.receiptId)!;
    if(!origin)conflicts.push({receiptId:row.receiptId,code:"origin_unproven",amountMinor:share.amountMinor});
    if(row.reservedMinor)conflicts.push({receiptId:row.receiptId,code:"reserved_spending",amountMinor:row.reservedMinor});
    if(row.pendingRefundMinor)conflicts.push({receiptId:row.receiptId,code:"pending_return",amountMinor:row.pendingRefundMinor});
    if(row.excludedMinor)conflicts.push({receiptId:row.receiptId,code:"existing_exclusion",amountMinor:row.excludedMinor});
    if(share.amountMinor>row.availableMinor)conflicts.push({receiptId:row.receiptId,code:"source_capacity",amountMinor:share.amountMinor-row.availableMinor});
    const qualified=source.receipt.refundAdapter==="capture_refund"&&!!source.receipt.provenRefundableRef;
    if(share.amountMinor&&!qualified&&session.mode!=="sample")conflicts.push({receiptId:row.receiptId,code:"return_route_unqualified",amountMinor:share.amountMinor});
    return {receiptId:row.receiptId,receiptVersion:row.receiptVersion,donorObligationId:row.donorObligationId,donorActorId:origin?.donorActorId??"",
      originalPackageId:row.originalPackageId,sourceKind:row.sourceKind,providerReferenceSuffix:source.receipt.actualProviderPaymentRef.slice(-8),
      sourceDigest:fundingSourceDigest(journal,row.receiptId),assignmentIds:row.assignmentIds,assignedMinor:row.assignedMinor,refundedMinor:row.refundedMinor,
      pendingRefundMinor:row.pendingRefundMinor,excludedMinor:row.excludedMinor,paidMinor:row.paidMinor,reservedMinor:row.reservedMinor,
      weightMinor:row.collectedMinor,availableMinor:row.availableMinor,entitlementMinor:share.amountMinor,remainderNumerator:share.remainderNumerator,refundRouteQualified:qualified};
  });
  // The complete history is checked even when the purpose being cancelled is
  // itself a destination of a prior donor decision.
  try { const lots=projectFundingLots(journal,scope,origins); if(rows.length)assertCurrentFundingLots(lots,packageId,pkg.version); await assertCommittedFundingChoices(scope,journal.assignments,tx); }
  catch(error){if(!(error instanceof DomainError))throw error;conflicts.push({receiptId:"package",code:error.code,amountMinor:apportion.totalMinor});}
  const value={schemaVersion:FUNDING_LIFECYCLE_VERSION,packageId,packageVersion:pkg.version,title:pkg.data.title,purpose:pkg.data.description,currency:"USD" as const,
    state:pkg.data.fundingState,budgetMinor:Number(pkg.budget_minor),denominatorMinor:apportion.denominatorMinor,totalMinor:apportion.totalMinor,
    sources,conflicts,rounds,method:"largest-remainder-v1" as const};
  return {...value,digest:sha256(canonicalJson(value)),observedAt:new Date().toISOString()};
}

/** A separately reviewed residual snapshot keeps every earlier decision and the
 * original deadline. It never moves an expense use or edits a saved contract. */
export async function reviseCancellationCase(tx:SqlConnection,session:Session,row:CaseRow,review:CancellationCaseReview,reconciliation:NonNullable<CancellationCaseContract["reconciliation"]>,adjusted=false):Promise<string>{
  const member=await requireCurrentRole(session,"organizer",tx),original=caseContract(row);
  if(row.state==="superseded"||review.packageVersion!==original.packageVersion||review.title!==original.title||review.purpose!==original.purpose||review.state!=="cancelled")throw new DomainError("CASE_REVIEW_CHANGED","The exact cancelled purpose changed. Keep its existing financial history for review.");
  const started=await query("SELECT id FROM fp_funding_choices WHERE case_id=$1 AND state IN ('executing','return_pending')",[row.id],tx);
  if(started.length)throw new DomainError("CANCELLATION_DECISIONS_STARTED","Reconcile every started return before recording a new residual snapshot.");
  const sources=adjusted?review.sources.map(source=>({...source,entitlementMinor:source.availableMinor,remainderNumerator:"0"})):review.sources;
  const conflicts=adjusted?review.conflicts.filter(conflict=>conflict.code!=="source_capacity"):review.conflicts;
  const id=randomUUID(),contract:CancellationCaseContract={...original,id,revision:row.revision+1,supersedesId:row.id,reconciliation,
    method:adjusted?"source-capacity-consented-v1":"largest-remainder-v1",sources,conflicts,totalMinor:review.totalMinor,denominatorMinor:review.denominatorMinor,
    roundIds:review.rounds.map(round=>round.id),approvedBy:session.actorId,membershipVersion:member.membershipVersion,approvedAt:new Date().toISOString(),reviewDigest:review.digest};
  const digest=sha256(canonicalJson(contract));
  await tx.query("UPDATE fp_funding_cases SET state='superseded' WHERE id=$1",[row.id]);
  await tx.query("UPDATE fp_funding_choices SET state='revoked',revoked_at=clock_timestamp(),last_code='CASE_RECONCILED' WHERE case_id=$1 AND state='accepted'",[row.id]);
  await tx.query(`INSERT INTO fp_funding_cases(id,tenant_id,project_id,package_id,package_version,revision,supersedes_id,state,digest,encrypted_data,deadline,created_by,membership_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,session.tenantId,session.projectId,contract.packageId,contract.packageVersion,contract.revision,row.id,conflicts.some(conflict=>conflict.code!=="return_route_unqualified")?"review_required":"choice_open",digest,sealPrivate(contract,caseContext(session,id)),original.deadline,session.actorId,member.membershipVersion]);
  const detail=adjusted?"Every affected supporter accepted the source-specific remaining shares. A new immutable case records those shares; paid expenses, original payments, the total and the original decision deadline are preserved.":"Verified changes have a separate residual snapshot. Earlier returns and moves stay in their original history, and the original decision deadline is unchanged.";
  await caseEvent(tx,session,row.id,session.actorId,"reconciled",detail,{reconciliationId:reconciliation.id,resultCaseId:id});
  await caseEvent(tx,session,id,session.actorId,adjusted?"allocation_adjustment_applied":"residual_review_recorded",detail,{reconciliationId:reconciliation.id,supersedesId:row.id});
  await refreshFundingCaseState(tx,session,id);return id;
}

export async function openCancellationCase(session:Session,raw:z.infer<typeof openCaseSchema>):Promise<{id:string}>{
  const input=openCaseSchema.parse(raw);await initializeDatabase();
  return database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);const member=await requireCurrentRole(session,"organizer",tx);
    const prior=await actionResult(tx,session,input.intentId,"open_case",input);if(prior)return prior;
    const review=await cancellationCaseReview(session,input.packageId,tx);
    if(review.digest!==input.reviewDigest||review.packageVersion!==input.expectedVersion)throw new DomainError("CANCELLATION_REVIEW_CHANGED","The contribution position changed. Refresh and review every share before cancelling.");
    const now=Date.now(),deadline=Date.parse(input.deadline);
    if(deadline<=now+60_000||deadline>now+30*24*60*60_000)throw new DomainError("CHOICE_DEADLINE_INVALID","Choose a decision deadline between one minute and thirty days from now.",422);
    if(!review.sources.length)throw new DomainError("CANCELLATION_NO_CONTRIBUTIONS","This package has no recorded contributions to return or move.");
    if(review.rounds.some(round=>["compensating","cancelled"].includes(round.state))||review.state==="compensating")throw new DomainError("LEGACY_RETURN_ACTIVE","This purpose already has an original return workflow. Resolve that history before a new donor decision.");
    const [inFlight]=await query("SELECT i.consent_id FROM fp_collection_items i JOIN fp_collection_rounds r ON r.id=i.round_id WHERE r.project_id=$1 AND r.package_id=$2 AND i.state IN ('dispatching','unknown','buyer_action','awaiting_payment','recovery_invoice_open') LIMIT 1",[session.projectId,input.packageId],tx);
    if(inFlight)throw new DomainError("COLLECTION_IN_FLIGHT","An existing payment may still complete. Reconcile its original channel before freezing donor shares.");
    if((await query("SELECT id FROM fp_purpose_pledges WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 AND operation_id IS NOT NULL AND state NOT IN ('collected','partially_collected','returned','cancelled','withdrawn') LIMIT 1",[session.tenantId,session.projectId,input.packageId],tx)).length)
      throw new DomainError("COLLECTION_IN_FLIGHT","A buyer-present pledge still has a started checkout. Reconcile its original payment before freezing shares.");
    const active=await query<CaseRow>("SELECT * FROM fp_funding_cases WHERE project_id=$1 AND package_id=$2 AND package_version=$3 AND state<>'superseded'",[session.projectId,input.packageId,input.expectedVersion],tx);
    let revision=1;
    if(active.length){
      if(input.replaceCaseId!==active[0].id)throw new DomainError("CANCELLATION_ALREADY_OPEN","Open the saved cancellation and its original deadline.");
      const used=await query<ChoiceRow>("SELECT * FROM fp_funding_choices WHERE case_id=$1 AND state IN ('executing','return_pending','executed','returned')",[active[0].id],tx);
      const original=caseContract(active[0]),resolved=used.filter(choice=>["executed","returned"].includes(choice.state)).reduce((sum,choice)=>sum+Number(choice.amount_minor),0);
      if(used.some(choice=>["executing","return_pending"].includes(choice.state))||used.length&&resolved!==original.totalMinor)throw new DomainError("CANCELLATION_DECISIONS_STARTED","A started decision keeps its frozen denominator. Resolve its original operation rather than replacing the case.");
      const comparable=(snapshot:CancellationCaseContract|CancellationCaseReview)=>({packageVersion:snapshot.packageVersion,title:snapshot.title,purpose:snapshot.purpose,totalMinor:snapshot.totalMinor,denominatorMinor:snapshot.denominatorMinor,sources:snapshot.sources,conflicts:snapshot.conflicts});
      if(canonicalJson(comparable(original))===canonicalJson(comparable(review)))throw new DomainError("CASE_SNAPSHOT_UNCHANGED","This cancellation still has the same frozen shares. Its original deadline and decisions remain in place.");
      if(input.deadline!==original.deadline)throw new DomainError("CASE_DEADLINE_FIXED","The original donor deadline is fixed. Inspect the recovery review to record changed residual facts without extending it.");
      revision=active[0].revision+1;
      await tx.query("UPDATE fp_funding_cases SET state='superseded' WHERE id=$1",[active[0].id]);
      await tx.query("UPDATE fp_funding_choices SET state='revoked',revoked_at=clock_timestamp(),last_code='CASE_SUPERSEDED' WHERE case_id=$1 AND state='accepted'",[active[0].id]);
      await caseEvent(tx,session,active[0].id,session.actorId,"superseded","A separately reviewed cancellation replaces this unresolved snapshot; earlier choices do not carry forward.");
    }else if(input.replaceCaseId||review.state==="cancelled")throw new DomainError("CANCELLATION_CLOSED","This purpose has no replaceable donor-choice case.");
    const id=randomUUID(),contract:CancellationCaseContract={schemaVersion:FUNDING_LIFECYCLE_VERSION,id,...scopeOf(session),packageId:review.packageId,packageVersion:review.packageVersion,title:review.title,purpose:review.purpose,
      currency:"USD",reason:input.reason,deadline:input.deadline,defaultTreatment:"return_to_original_route",method:review.method,denominatorMinor:review.denominatorMinor,totalMinor:review.totalMinor,sources:review.sources,conflicts:review.conflicts,
      roundIds:review.rounds.map(round=>round.id),approvedBy:session.actorId,membershipVersion:member.membershipVersion,approvedAt:new Date(now).toISOString(),reviewDigest:review.digest,revision,supersedesId:input.replaceCaseId??null};
    const blocking=review.conflicts.some(conflict=>conflict.code!=="return_route_unqualified"),digest=sha256(canonicalJson(contract));
    await tx.query(`INSERT INTO fp_funding_cases(id,tenant_id,project_id,package_id,package_version,revision,supersedes_id,state,digest,encrypted_data,deadline,created_by,membership_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,session.tenantId,session.projectId,contract.packageId,contract.packageVersion,revision,contract.supersedesId,blocking?"review_required":"choice_open",digest,sealPrivate(contract,caseContext(session,id)),contract.deadline,session.actorId,member.membershipVersion]);
    await tx.query("UPDATE fp_packages SET data=jsonb_set(data,'{fundingState}','\"cancelled\"'::jsonb) WHERE project_id=$1 AND id=$2",[session.projectId,contract.packageId]);
    await tx.query("UPDATE fp_funding_policies SET state='closed' WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3",[session.tenantId,session.projectId,contract.packageId]);
    await tx.query("UPDATE fp_purpose_pledges SET state='cancelled' WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 AND operation_id IS NULL AND state IN ('pledged','held')",[session.tenantId,session.projectId,contract.packageId]);
    await tx.query("UPDATE fp_obligations SET data=jsonb_set(data,'{eligible}','false'::jsonb),channel='cancelled' WHERE id IN (SELECT obligation_id FROM fp_purpose_pledges WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 AND state='cancelled')",[session.tenantId,session.projectId,contract.packageId]);
    await tx.query("UPDATE fp_collection_rounds SET state='donor_choice',cancellation_reason='donor_choice',cancelled_by=$3,cancellation_requested_at=clock_timestamp() WHERE project_id=$1 AND package_id=$2 AND state NOT IN ('compensating','cancelled')",[session.projectId,contract.packageId,session.actorId]);
    await tx.query("UPDATE fp_outbox SET status='delivered',lease_until=NULL WHERE project_id=$1 AND kind='collection.collect' AND data->>'roundId'=ANY($2::text[]) AND status IN ('queued','retry')",[session.projectId,contract.roundIds]);
    await caseEvent(tx,session,id,session.actorId,"opened","This purpose is closed. Donors can choose an original-route return, a named new purpose or a separately renewed next cycle. Silence never moves a contribution.",{digest,revision});
    await appendEvent(tx,session,"funding.case_opened","Supporters have a say when plans change","The exact remaining shares, paid expenses, deadline and default return treatment are saved. No payment was sent and no donor consent was inferred.");
    await refreshFundingCaseState(tx,session,id);
    await requireCurrentRole(session,"organizer",tx);await saveAction(tx,session,input.intentId,"open_case",input,{id});return {id};
  });
}

export async function createFundingPolicy(session:Session,raw:z.infer<typeof fundingPolicySchema>):Promise<{id:string}>{
  const input=fundingPolicySchema.parse(raw);await initializeDatabase();
  return database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);const member=await requireCurrentRole(session,"organizer",tx);
    const prior=await actionResult(tx,session,input.intentId,"funding_policy",input);if(prior)return prior;
    const pkg=(await packages(session,tx)).find(pkg=>pkg.id===input.packageId);
    if(!pkg||pkg.version!==input.expectedVersion)throw new DomainError("PACKAGE_VERSION_CHANGED","Reload the current destination purpose before opening it for supporters.");
    if(["cancelled","compensating"].includes(pkg.data.fundingState))throw new DomainError("DESTINATION_CLOSED","Choose a current open purpose. A cancelled purpose stays cancelled.");
    if((await query("SELECT id FROM fp_collection_rounds WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 AND package_version=$4",[session.tenantId,session.projectId,pkg.id,pkg.version],tx)).length)
      throw new DomainError("DESTINATION_ROUND_EXISTS","This purpose already has a funding round. Review that original policy instead of replacing its deadline.");
    const id=randomUUID(),roundId=randomUUID(),createdAt=new Date(),expiresAt=new Date(createdAt.getTime()+48*60*60_000);
    const value:FundingPolicyContract={schemaVersion:FUNDING_LIFECYCLE_VERSION,id,...scopeOf(session),packageId:pkg.id,packageVersion:pkg.version,title:pkg.data.title,purpose:pkg.data.description,budgetMinor:Number(pkg.budget_minor),currency:"USD",roundId,kind:input.kind,expiresAt:expiresAt.toISOString(),createdBy:session.actorId,membershipVersion:member.membershipVersion,createdAt:createdAt.toISOString()};
    const digest=sha256(canonicalJson(value));
    await tx.query("INSERT INTO fp_collection_rounds(id,tenant_id,project_id,package_id,package_version,target_minor,collection_started_at,recovery_ends_at,policy_hash,state,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'allocation_open',$10::jsonb)",[roundId,session.tenantId,session.projectId,pkg.id,pkg.version,Number(pkg.budget_minor),createdAt,expiresAt,digest,JSON.stringify({kind:"donor_allocation",policyId:id,createdBy:session.actorId})]);
    await tx.query("INSERT INTO fp_funding_policies(id,tenant_id,project_id,package_id,package_version,round_id,kind,digest,encrypted_data,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[id,session.tenantId,session.projectId,pkg.id,pkg.version,roundId,input.kind,digest,sealPrivate(value,policyContext(session,id)),expiresAt]);
    const {refreshPurposeFunding}=await import("./purpose-pledges");await refreshPurposeFunding(tx,scopeOf(session),id);
    await appendEvent(tx,session,"funding.policy_opened","A new purpose is ready for donor decisions","This separate versioned purpose has its own target and 48-hour acceptance window. Pledges and other packages' funded states do not count as collected support.");
    await saveAction(tx,session,input.intentId,"funding_policy",input,{id});return{id};
  });
}

export async function currentDestination(session:Session,policyId:string,policyDigest:string,kind:FundingChoiceContract["kind"]|null,tx:SqlConnection){
  const [row]=await query<PolicyRow>("SELECT * FROM fp_funding_policies WHERE id=$1 AND tenant_id=$2 AND project_id=$3",[policyId,session.tenantId,session.projectId],tx);
  if(!row||row.digest!==policyDigest||row.state!=="open"||row.expires_at.getTime()<=Date.now())throw new DomainError("DESTINATION_POLICY_CHANGED","This destination's acceptance window changed or closed. Choose a current purpose.");
  const value=policyContract(row),pkg=(await packages(session,tx)).find(pkg=>pkg.id===value.packageId);
  const creator=await requireMembership(session.tenantId,session.projectId,value.createdBy,"organizer",tx);
  if(creator.version!==value.membershipVersion||value.provenance!==session.mode)throw new DomainError("DESTINATION_AUTHORITY_CHANGED","This purpose needs its organizer's current recorded authority.");
  if(!pkg||pkg.version!==value.packageVersion||pkg.data.title!==value.title||pkg.data.description!==value.purpose||Number(pkg.budget_minor)!==value.budgetMinor||["cancelled","compensating"].includes(pkg.data.fundingState))throw new DomainError("DESTINATION_VERSION_CHANGED","The destination purpose changed after its policy was approved.");
  if(kind&&value.kind!=="mixed"&&value.kind!==kind)throw new DomainError("DESTINATION_KIND_CHANGED","This purpose does not accept the selected kind of donor decision.");
  const [round]=await query<{state:string;policy_hash:string;package_version:number}>("SELECT state,policy_hash,package_version FROM fp_collection_rounds WHERE id=$1 AND tenant_id=$2 AND project_id=$3",[value.roundId,session.tenantId,session.projectId],tx);
  if(!round||round.state!=="allocation_open"||round.policy_hash!==row.digest||round.package_version!==pkg.version)throw new DomainError("DESTINATION_ROUND_CHANGED","The destination needs its own current open funding round.");
  return {row,value};
}

/** New purpose policies remain bound to their exact approved content when
 * spending begins. Older collection approvals keep their original contract. */
export async function assertFundedPurposePolicy(scope:Scope,packageId:string,roundId:string,tx:SqlConnection):Promise<void>{
  const [row]=await query<PolicyRow>("SELECT * FROM fp_funding_policies WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 AND round_id=$4",[scope.tenantId,scope.projectId,packageId,roundId],tx);
  if(!row)return;
  const value=policyContract(row),pkg=(await packages(scope,tx)).find(pkg=>pkg.id===packageId),creator=await requireMembership(scope.tenantId,scope.projectId,value.createdBy,"organizer",tx);
  const [round]=await query<{state:string;policy_hash:string;package_version:number}>("SELECT state,policy_hash,package_version FROM fp_collection_rounds WHERE id=$1 AND tenant_id=$2 AND project_id=$3",[roundId,scope.tenantId,scope.projectId],tx);
  if(row.state!=="funded"||!round||round.state!=="funded"||round.policy_hash!==row.digest||!pkg||pkg.version!==value.packageVersion||round.package_version!==value.packageVersion||pkg.data.title!==value.title||pkg.data.description!==value.purpose||Number(pkg.budget_minor)!==value.budgetMinor||creator.version!==value.membershipVersion)
    throw new DomainError("FUNDING_POLICY_CHANGED","The exact funded purpose or its recorded organizer authority changed. Review its funding before new spending.");
}

export async function recordFundingChoice(session:Session,raw:z.infer<typeof fundingChoiceSchema>):Promise<{id:string}>{
  const input=fundingChoiceSchema.parse(raw);await initializeDatabase();
  return database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);const member=await requireCurrentRole(session,"donor",tx);
    const prior=await actionResult(tx,session,input.intentId,"donor_choice",input);if(prior)return prior;
    const row=await ownedCase(session,input.caseId,tx),value=caseContract(row),source=value.sources.find(source=>source.receiptId===input.receiptId&&source.donorActorId===session.actorId);
    const {assertAppliedAdjustment}=await import("./funding-adjustments");await assertAppliedAdjustment(tx,session,value);
    if(!source)throw new DomainError("CONTRIBUTION_NOT_OWNED","Choose a contribution that belongs to your current donor identity.",404);
    if(row.digest!==input.caseDigest||source.receiptVersion!==input.expectedVersion||!["choice_open","partially_resolved"].includes(row.state)||row.deadline.getTime()<=Date.now())throw new DomainError("DONOR_CHOICE_STALE","This decision window or contribution changed. Refresh your current choices.");
    if(source.entitlementMinor<=0)throw new DomainError("NO_REMAINING_SHARE","This contribution has no uncommitted share to return or move.");
    const current=await readFundingJournal(scopeOf(session),tx);
    if(fundingSourceDigest(current,source.receiptId)!==source.sourceDigest)throw new DomainError("CONTRIBUTION_CHANGED","Your contribution changed after this cancellation was reviewed. Ask the organizer to refresh the unresolved case.");
    if(input.kind==="return"&&(input.policyId!==null||input.policyDigest!==null)||input.kind!=="return"&&(!input.policyId||!input.policyDigest))throw new DomainError("CHOICE_PURPOSE_REQUIRED","A return and a specific new purpose are separate choices.",422);
    const target=input.kind==="return"?null:await currentDestination(session,input.policyId!,input.policyDigest!,input.kind,tx);
    if(target?.value.packageId===value.packageId)throw new DomainError("DESTINATION_CLOSED","The cancelled purpose cannot become its own destination.");
    const [last]=await query<{version:number}>("SELECT COALESCE(max(version),0)::integer version FROM fp_funding_choices WHERE case_id=$1 AND receipt_id=$2",[row.id,source.receiptId],tx);
    if((await query("SELECT id FROM fp_funding_choices WHERE case_id=$1 AND receipt_id=$2 AND state IN ('accepted','executing','return_pending','executed','returned')",[row.id,source.receiptId],tx)).length)throw new DomainError("CHOICE_ALREADY_SAVED","Your current choice is saved. Withdraw it before choosing again; a started return cannot be replaced.");
    const id=randomUUID(),consentedAt=new Date().toISOString(),expiresAt=new Date(Math.min(row.deadline.getTime(),target?.row.expires_at.getTime()??Infinity)).toISOString();
    const contract:FundingChoiceContract={schemaVersion:FUNDING_LIFECYCLE_VERSION,id,...scopeOf(session),caseId:row.id,caseDigest:row.digest,receiptId:source.receiptId,receiptVersion:source.receiptVersion,sourceDigest:source.sourceDigest,sourcePackageId:value.packageId,sourcePackageVersion:value.packageVersion,amountMinor:source.entitlementMinor,currency:"USD",donorActorId:session.actorId,acceptedBy:session.actorId,membershipVersion:member.membershipVersion,version:last.version+1,authority:"donor",kind:input.kind,
      destination:target?{policyId:target.value.id,policyDigest:target.row.digest,packageId:target.value.packageId,packageVersion:target.value.packageVersion,title:target.value.title,purpose:target.value.purpose,roundId:target.value.roundId}:null,consentedAt,expiresAt};
    await insertChoice(tx,session,contract);
    await caseEvent(tx,session,row.id,session.actorId,"choice_saved",input.kind==="return"?"The donor chose a return to the original payment route.":input.kind==="rollover"?"The donor explicitly renewed support for a named next cycle.":"The donor chose the exact named new purpose.",{choiceId:id,receiptId:source.receiptId});
    await saveAction(tx,session,input.intentId,"donor_choice",input,{id});return{id};
  });
}
async function insertChoice(tx:SqlConnection,scope:Scope,contract:FundingChoiceContract){const digest=sha256(canonicalJson(contract));await tx.query(`INSERT INTO fp_funding_choices(id,tenant_id,project_id,case_id,receipt_id,donor_actor_id,accepted_by,membership_version,version,kind,authority,amount_minor,digest,encrypted_data,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[contract.id,scope.tenantId,scope.projectId,contract.caseId,contract.receiptId,contract.donorActorId,contract.acceptedBy,contract.membershipVersion,contract.version,contract.kind,contract.authority,contract.amountMinor,digest,sealPrivate(contract,choiceContext(scope,contract.id)),contract.expiresAt]);}

export async function revokeFundingChoice(session:Session,raw:z.infer<typeof choiceActionSchema>):Promise<{id:string}>{const input=choiceActionSchema.parse(raw);return database().transaction(async tx=>{
  await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);await requireCurrentRole(session,"donor",tx);
  const prior=await actionResult(tx,session,input.intentId,"revoke_choice",input);if(prior)return prior;
  const row=await ownedChoice(session,input.choiceId,tx);fundingChoiceContract(row);
  if(row.donor_actor_id!==session.actorId||row.authority!=="donor")throw new DomainError("CHOICE_NOT_FOUND","Only your own donor decision can be withdrawn.",404);
  if(row.digest!==input.digest||row.version!==input.expectedVersion||row.state!=="accepted")throw new DomainError("CHOICE_STARTED","This choice changed or has started. Check its original result before trying again.");
  await tx.query("UPDATE fp_funding_choices SET state='revoked',revoked_at=clock_timestamp() WHERE id=$1",[row.id]);
  await caseEvent(tx,session,row.case_id,session.actorId,"choice_revoked","The donor withdrew this unexecuted decision; no new-purpose consent remains.",{choiceId:row.id,receiptId:row.receipt_id});
  await saveAction(tx,session,input.intentId,"revoke_choice",input,{id:row.id});return{id:row.id};
});}

async function validateChoiceForExecution(tx:SqlConnection,session:Session,row:ChoiceRow){
  if(!["donor","organizer"].includes(session.role))throw new DomainError("ROLE_DENIED","Only the donor or organizer can apply a recorded decision.",403);
  await requireCurrentRole(session,session.role,tx);const choice=fundingChoiceContract(row),caseRow=await ownedCase(session,row.case_id,tx),saved=caseContract(caseRow);
  const {assertAppliedAdjustment}=await import("./funding-adjustments");await assertAppliedAdjustment(tx,session,saved);
  if(session.role==="donor"&&row.donor_actor_id!==session.actorId)throw new DomainError("CHOICE_NOT_FOUND","This decision belongs to another donor.",404);
  if(!["choice_open","partially_resolved"].includes(caseRow.state)||caseRow.digest!==choice.caseDigest||row.state!=="accepted"||row.revoked_at||row.expires_at.getTime()<=Date.now())throw new DomainError("CHOICE_AUTHORITY_CHANGED","This saved decision is expired, withdrawn or already started. Refresh its current status.");
  const member=await requireMembership(session.tenantId,session.projectId,row.accepted_by,row.authority==="donor"?"donor":"organizer",tx);
  if(member.version!==row.membership_version)throw new DomainError("CHOICE_MEMBERSHIP_CHANGED","The person who approved this decision no longer has the same authority.");
  const pkg=(await packages(session,tx)).find(pkg=>pkg.id===saved.packageId);
  if(!pkg||pkg.version!==saved.packageVersion||pkg.data.title!==saved.title||pkg.data.description!==saved.purpose||pkg.data.fundingState!=="cancelled")throw new DomainError("SOURCE_PURPOSE_CHANGED","The cancelled purpose changed after this donor decision.");
  const source=saved.sources.find(source=>source.receiptId===row.receipt_id);
  if(!source||source.donorActorId!==row.donor_actor_id||source.entitlementMinor!==Number(row.amount_minor)||source.sourceDigest!==choice.sourceDigest) savedConflict();
  if(saved.conflicts.some(conflict=>conflict.code!=="return_route_unqualified"))throw new DomainError("CANCELLATION_REVIEW_REQUIRED","Resolve the recorded spending or source-capacity conflict before applying any share.");
  const scope=scopeOf(session),journal=await readFundingJournal(scope,tx),projection=projectFundingPositions(journal,scope);
  if(fundingSourceDigest(journal,row.receipt_id)!==choice.sourceDigest)throw new DomainError("CONTRIBUTION_CHANGED","The original contribution changed after consent. Keep the history and review a new decision.");
  const position=projection.positions.find(position=>position.receiptId===row.receipt_id&&position.packageId===saved.packageId);
  if(!position||position.availableMinor<choice.amountMinor)throw new DomainError("CHOICE_FUNDS_CHANGED","This share is no longer fully available under its original purpose.");
  const lots=projectFundingLots(journal,scope,await readFundingOrigins(scope,tx));assertCurrentFundingLots(lots,saved.packageId,saved.packageVersion);
  await assertCommittedFundingChoices(scope,journal.assignments,tx);
  return {choice,saved,journal,scope,projection};
}

export async function executeFundingChoice(session:Session,raw:z.infer<typeof choiceActionSchema>,refundDependencies?:import("./refunds").RefundDependencies):Promise<{id:string}>{
  const input=choiceActionSchema.parse(raw);
  const result=await database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);
    if(!["donor","organizer"].includes(session.role))throw new DomainError("ROLE_DENIED","This view can only inspect donor decisions.",403);
    await requireCurrentRole(session,session.role,tx);
    const prior=await actionResult(tx,session,input.intentId,"execute_choice",input);if(prior)return {...prior,kind:"done" as const};
    const row=await ownedChoice(session,input.choiceId,tx);
    if(row.digest!==input.digest||row.version!==input.expectedVersion)throw new DomainError("CHOICE_VERSION_CHANGED","Reload the exact saved decision before applying it.");
    if(session.role==="donor"&&row.donor_actor_id!==session.actorId)throw new DomainError("CHOICE_NOT_FOUND","This decision belongs to another donor.",404);
    if(["executed","returned","return_pending"].includes(row.state)){await saveAction(tx,session,input.intentId,"execute_choice",input,{id:row.id});return{id:row.id,kind:"done" as const};}
    const {choice,saved,journal,scope,projection}=await validateChoiceForExecution(tx,session,row);
    if(choice.kind==="return"){
      if(session.mode==="live_sandbox")return{id:row.id,kind:"return" as const};
      const source=journal.sources.find(source=>source.receipt.id===row.receipt_id)!,next=structuredClone(source.receipt);
      next.completedAttributedRefundMinor+=choice.amountMinor;
      await persistFundingReceipt(tx,scope,{version:source.version,data:source.receipt},next,[{packageId:saved.packageId,refundedMinor:choice.amountMinor}]);
      const {refreshPurposePledge}=await import("./purpose-pledges");await refreshPurposePledge(tx,scope,source.receipt.donorObligationId);
      const {refreshSponsorsForScope}=await import("./sponsors");await refreshSponsorsForScope(tx,session);
      await tx.query("UPDATE fp_funding_choices SET state='returned',executed_id=$2,executed_at=clock_timestamp() WHERE id=$1",[row.id,`sample-return:${row.id}`]);
      await caseEvent(tx,session,row.case_id,session.actorId,"sample_return_recorded","A labelled Sample return was recorded. No provider was called and no actual payment was returned.",{choiceId:row.id,receiptId:row.receipt_id});
    }else{
      const target=await currentDestination(session,choice.destination!.policyId,choice.destination!.policyDigest,choice.kind,tx);
      const eligible=packagePositionTotals(projection.positions,target.value.packageId,target.value.budgetMinor).fundingEligibleMinor;
      const promised=await outstandingPurposePledges(session,target.value.packageId,tx);
      if(eligible+promised+choice.amountMinor>target.value.budgetMinor)throw new DomainError("DESTINATION_CAPACITY","This full share no longer fits the destination's approved target and existing pledges. Choose another current purpose or return.");
      const sequence=journal.assignments.filter(entry=>entry.receiptId===row.receipt_id).length+1,assignmentId=randomUUID();
      const entry={id:assignmentId,receiptId:row.receipt_id,sequence,kind:choice.kind,reversesId:null,...scope,currency:"USD" as const,amountMinor:choice.amountMinor,
        debit:{packageId:saved.packageId,packageVersion:saved.packageVersion},credit:{packageId:target.value.packageId,packageVersion:target.value.packageVersion},consentId:row.id,consentDigest:row.digest,donorActorId:row.donor_actor_id,consentedAt:choice.consentedAt,consentExpiresAt:choice.expiresAt,committedAt:new Date().toISOString()};
      projectFundingLots({...journal,assignments:[...journal.assignments,entry]},scope,await readFundingOrigins(scope,tx));
      await appendFundingAssignment(tx,scope,entry);
      await tx.query("UPDATE fp_funding_choices SET state='executed',executed_id=$2,executed_at=clock_timestamp() WHERE id=$1",[row.id,assignmentId]);
      await assertCommittedFundingChoices(scope,[...journal.assignments,entry],tx);
      if(eligible+choice.amountMinor===target.value.budgetMinor){
        await tx.query("UPDATE fp_funding_policies SET state='funded' WHERE id=$1",[target.row.id]);
        await tx.query("UPDATE fp_collection_rounds SET state='funded' WHERE id=$1",[target.value.roundId]);
        await tx.query("UPDATE fp_packages SET data=jsonb_set(data,'{fundingState}','\"funded\"'::jsonb) WHERE project_id=$1 AND id=$2",[session.projectId,target.value.packageId]);
      }
      await caseEvent(tx,session,row.case_id,session.actorId,"choice_applied",choice.kind==="rollover"?"The donor's explicitly renewed next-cycle purpose now owns this share. The original payment and return route remain unchanged.":"The exact donor-approved destination now owns this share. The cancelled purpose stays closed.",{choiceId:row.id,receiptId:row.receipt_id,assignmentId});
      const {refreshSponsorsForScope}=await import("./sponsors");await refreshSponsorsForScope(tx,session);
    }
    await refreshFundingCaseState(tx,session,row.case_id);
    await appendEvent(tx,session,"funding.choice_applied","A supporter's decision is recorded","The original payment trail is retained. Current-purpose funding, available expense sources and the cancellation history use the same recorded decision.");
    await saveAction(tx,session,input.intentId,"execute_choice",input,{id:row.id});return{id:row.id,kind:"done" as const};
  });
  if(result.kind==="return"){
    const {requestCaseRefund}=await import("./refunds");
    await requestCaseRefund(session,input.choiceId,refundDependencies);
    await database().transaction(async tx=>{await projectClaimLock(tx,session.projectId);await requireCurrentRole(session,session.role,tx);const prior=await actionResult(tx,session,input.intentId,"execute_choice",input);if(!prior)await saveAction(tx,session,input.intentId,"execute_choice",input,{id:input.choiceId});});
  }
  return{id:result.id};
}

/** Silent donors receive only the explicitly reviewed original-route default.
 * This is recorded as organizer/default authority, never fabricated consent. */
export async function applyCancellationDefaults(session:Session,caseId:string):Promise<{ids:string[]}>{
  return database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);const member=await requireCurrentRole(session,"organizer",tx);
    const row=await ownedCase(session,caseId,tx),saved=caseContract(row);
    const {assertAppliedAdjustment}=await import("./funding-adjustments");await assertAppliedAdjustment(tx,session,saved);
    if(!["choice_open","partially_resolved"].includes(row.state)||row.deadline.getTime()>Date.now())throw new DomainError("DEFAULT_NOT_DUE","The donor decision window is still open or this case needs review.");
    if(saved.approvedBy!==session.actorId||saved.membershipVersion!==member.membershipVersion)throw new DomainError("CASE_AUTHORITY_CHANGED","The exact cancellation approver needs current authority before default returns are prepared.");
    const ids:string[]=[];
    for(const source of saved.sources.filter(source=>source.entitlementMinor>0)){
      const choices=await query<ChoiceRow>("SELECT * FROM fp_funding_choices WHERE case_id=$1 AND receipt_id=$2 ORDER BY version DESC",[caseId,source.receiptId],tx),latest=choices[0];
      if(latest&&["executed","returned","return_pending","executing"].includes(latest.state))continue;
      if(latest?.authority==="case_default"){if(latest.state==="accepted")ids.push(latest.id);continue;}
      if(latest?.state==="accepted")await tx.query("UPDATE fp_funding_choices SET state='expired',last_code='CHOICE_EXPIRED' WHERE id=$1",[latest.id]);
      const id=randomUUID(),contract:FundingChoiceContract={schemaVersion:FUNDING_LIFECYCLE_VERSION,id,...scopeOf(session),caseId,caseDigest:row.digest,receiptId:source.receiptId,receiptVersion:source.receiptVersion,sourceDigest:source.sourceDigest,sourcePackageId:saved.packageId,sourcePackageVersion:saved.packageVersion,amountMinor:source.entitlementMinor,currency:"USD",donorActorId:source.donorActorId,acceptedBy:session.actorId,membershipVersion:member.membershipVersion,version:(latest?.version??0)+1,authority:"case_default",kind:"return",destination:null,consentedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+24*60*60_000).toISOString()};
      await insertChoice(tx,session,contract);ids.push(id);
      await caseEvent(tx,session,caseId,session.actorId,"default_return_prepared","The decision window ended. An original-route return was prepared under the reviewed default; no new-purpose permission was inferred.",{choiceId:id,receiptId:source.receiptId});
    }
    return{ids};
  });
}

export async function fundingDesk(session:Session):Promise<FundingDesk>{
  await initializeDatabase();
  const result=await database().transaction(async tx=>{
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");await requireCurrentRole(session,session.role,tx);
    const scope=scopeOf(session),projection=projectFundingPositions(await readFundingJournal(scope,tx),scope),packageRows=await packages(session,tx);
    const [project]=await query<{metadata:{title?:string}}>("SELECT metadata FROM fp_projects WHERE id=$1 AND tenant_id=$2",[session.projectId,session.tenantId],tx);
    const full=["organizer","auditor"].includes(session.role),caseRows=await query<CaseRow>("SELECT * FROM fp_funding_cases WHERE tenant_id=$1 AND project_id=$2 ORDER BY created_at DESC,id",[session.tenantId,session.projectId],tx);
    const choiceRows=await query<ChoiceRow>("SELECT * FROM fp_funding_choices WHERE tenant_id=$1 AND project_id=$2 ORDER BY version DESC",[session.tenantId,session.projectId],tx);
    const policies=await query<PolicyRow>("SELECT * FROM fp_funding_policies WHERE tenant_id=$1 AND project_id=$2 ORDER BY created_at DESC",[session.tenantId,session.projectId],tx);
    const returns=await query<{id:string;funding_choice_id:string;state:string}>("SELECT id,funding_choice_id,state FROM fp_refunds WHERE tenant_id=$1 AND project_id=$2 AND funding_choice_id IS NOT NULL",[session.tenantId,session.projectId],tx);
    const caseViews:FundingCaseView[]=[];
    for(const row of caseRows){
      const value=caseContract(row),visible=value.sources.filter(source=>full||session.role==="donor"&&source.donorActorId===session.actorId);
      if(!full&&!visible.length)continue;
      let returned=0,moved=0;
      const visibleSources=visible.map(source=>{
        const choice=choiceRows.find(choice=>choice.case_id===row.id&&choice.receipt_id===source.receiptId),contract=choice?fundingChoiceContract(choice):null;
        const refund=choice?returns.find(item=>item.funding_choice_id===choice.id):null;
        if(choice?.state==="returned")returned+=Number(choice.amount_minor);
        if(choice?.state==="executed")moved+=Number(choice.amount_minor);
        const choiceView:FundingChoiceView|null=choice&&contract?{id:choice.id,version:choice.version,kind:choice.kind,authority:choice.authority,amountMinor:Number(choice.amount_minor),state:choice.state,destination:contract.destination,consentedAt:contract.consentedAt,expiresAt:contract.expiresAt,revokedAt:choice.revoked_at?.toISOString()??null,executedId:choice.executed_id,code:choice.last_code,digest:choice.digest,
          canRevoke:session.role==="donor"&&source.donorActorId===session.actorId&&choice.authority==="donor"&&choice.state==="accepted",
          canExecute:["organizer","donor"].includes(session.role)&&["choice_open","partially_resolved"].includes(row.state)&&choice.state==="accepted"&&!choice.revoked_at&&choice.expires_at.getTime()>Date.now(),
          returnStatus:refund?{id:refund.id,state:refund.state,canCheck:["organizer","donor"].includes(session.role)&&refund.state!=="completed",canRetry:["organizer","donor"].includes(session.role)&&["refused","not_sent"].includes(refund.state)&&choice.expires_at.getTime()>Date.now()}:null}:null;
        const {donorActorId,sourceDigest,...safe}=source;void sourceDigest;
        return {...safe,own:donorActorId===session.actorId,choice:choiceView};
      });
      const total=visible.reduce((n,source)=>n+source.entitlementMinor,0),unresolved=total-returned-moved;
      const histories=await query<{id:string;kind:string;data:{detail:string;receiptId?:string};created_at:Date}>("SELECT id,kind,data,created_at FROM fp_funding_case_events WHERE case_id=$1 ORDER BY created_at,id",[row.id],tx);
      const currentConflicts=value.conflicts.filter(conflict=>full||visible.some(source=>source.receiptId===conflict.receiptId));
      caseViews.push({id:row.id,version:row.version,revision:row.revision,digest:row.digest,packageId:value.packageId,packageVersion:value.packageVersion,title:value.title,purpose:value.purpose,reason:value.reason,deadline:value.deadline,defaultTreatment:value.defaultTreatment,method:value.method,reconciliationId:value.reconciliation?.id??null,
        state:row.state==="superseded"?"superseded":row.state==="review_required"?"review_required":unresolved===0?"resolved":returned+moved>0?"partially_resolved":"choice_open",createdAt:row.created_at.toISOString(),totalMinor:total,denominatorMinor:value.denominatorMinor,paidMinor:visible.reduce((n,s)=>n+s.paidMinor,0),reservedMinor:visible.reduce((n,s)=>n+s.reservedMinor,0),returnedMinor:returned,movedMinor:moved,unresolvedMinor:unresolved,conflicts:currentConflicts,sources:visibleSources,
        history:histories.filter(event=>full||!event.data.receiptId||visible.some(source=>source.receiptId===event.data.receiptId)).map(event=>({id:event.id,kind:event.kind,detail:event.data.detail,createdAt:event.created_at.toISOString()}))});
    }
    const policyViews=await Promise.all(policies.map(async row=>{const value=policyContract(row),pkg=packageRows.find(pkg=>pkg.id===value.packageId),eligible=packagePositionTotals(projection.positions,value.packageId,value.budgetMinor).fundingEligibleMinor,promised=await outstandingPurposePledges(session,value.packageId,tx);return{id:row.id,digest:row.digest,packageId:value.packageId,packageVersion:value.packageVersion,title:value.title,purpose:value.purpose,budgetMinor:value.budgetMinor,remainingMinor:Math.max(0,value.budgetMinor-eligible-promised),pledgedMinor:promised,kind:value.kind,state:!pkg||pkg.version!==value.packageVersion||["cancelled","compensating"].includes(pkg.data.fundingState)?"closed":row.state==="open"&&row.expires_at.getTime()<=Date.now()?"expired":row.state,expiresAt:value.expiresAt};}));
    const rounds=await query<{package_id:string;package_version:number}>("SELECT package_id,package_version FROM fp_collection_rounds WHERE tenant_id=$1 AND project_id=$2",[session.tenantId,session.projectId],tx);
    const {purposePledgeViews}=await import("./purpose-pledges"),{sponsorViews}=await import("./sponsors"),{purposeCheckoutEnabled}=await import("./purpose-checkout");
    return {schemaVersion:FUNDING_LIFECYCLE_VERSION,projectId:session.projectId,projectTitle:project?.metadata.title??"Community project",role:session.role,mode:session.mode,observedAt:new Date().toISOString(),checkoutEnabled:purposeCheckoutEnabled(),packages:packageRows.map(pkg=>{const positions=projection.positions.filter(position=>position.packageId===pkg.id);return{id:pkg.id,version:pkg.version,title:pkg.data.title,purpose:pkg.data.description,budgetMinor:Number(pkg.budget_minor),eligibleMinor:positions.reduce((n,p)=>n+p.fundingEligibleMinor,0),availableMinor:positions.reduce((n,p)=>n+p.availableMinor,0),state:pkg.data.fundingState,hasRound:rounds.some(round=>round.package_id===pkg.id&&round.package_version===pkg.version)};}),policies:policyViews,cases:caseViews,pledges:await purposePledgeViews(session,tx),sponsors:await sponsorViews(session,tx)};
  });
  await requireCurrentRole(session,session.role);return result;
}

/** Used only inside the refund reservation transaction, after funding locks.
 * A provider budget read cannot stand in for revalidating current consent. */
export async function validateCaseReturn(tx:SqlConnection,session:Session,choiceId:string){
  const row=await ownedChoice(session,choiceId,tx);
  const validated=await validateChoiceForExecution(tx,session,row);
  if(validated.choice.kind!=="return")throw new DomainError("RETURN_CHOICE_REQUIRED","This donor chose a different purpose, not a return.");
  return {...validated,row};
}

export async function authorizeReservedCaseReturn(scope:FundingScope,choiceId:string,refundId:string,packageId:string,sourceDigest:string,tx:SqlConnection):Promise<void>{
  const row=await ownedChoice(scope,choiceId,tx),choice=fundingChoiceContract(row),caseRow=await ownedCase(scope,row.case_id,tx),saved=caseContract(caseRow);
  if(row.kind!=="return"||row.state!=="return_pending"||row.revoked_at||row.executed_id!==refundId||row.expires_at.getTime()<=Date.now()||caseRow.digest!==choice.caseDigest||!["choice_open","partially_resolved"].includes(caseRow.state)||saved.packageId!==packageId)
    throw new DomainError("RETURN_AUTHORITY_CHANGED","The original return decision is no longer current. Its pending value remains unavailable for spending.");
  const member=await requireMembership(scope.tenantId,scope.projectId,row.accepted_by,row.authority==="donor"?"donor":"organizer",tx);
  if(member.version!==row.membership_version)throw new DomainError("RETURN_AUTHORITY_CHANGED","The recorded return approver's membership changed.");
  const [pkg]=await query<PackageRow>("SELECT id,version,budget_minor,data FROM fp_packages WHERE project_id=$1 AND id=$2",[scope.projectId,packageId],tx);
  if(!pkg||pkg.version!==saved.packageVersion||pkg.data.fundingState!=="cancelled"||pkg.data.title!==saved.title||pkg.data.description!==saved.purpose)throw new DomainError("RETURN_AUTHORITY_CHANGED","The cancelled purpose changed after this return was approved.");
  if(fundingSourceDigest(await readFundingJournal(scope,tx),row.receipt_id)!==sourceDigest)throw new DomainError("RETURN_SOURCE_CHANGED","The exact reserved return source changed. Reconcile its original operation.");
}
