import { randomUUID } from "node:crypto";
import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import type { CancellationCaseContract } from "../funding/contracts";
import { FUNDING_RECONCILIATION_VERSION as VERSION, type AdjustmentConsentContract, type AdjustmentView, type AllocationAdjustmentContract, type AllocationEvidence, type CaseRecoveryReview, type FundingRecoveryBlocker } from "../funding/reconciliation";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { projectClaimLock } from "./claims";
import { database, initializeDatabase, query } from "./db";
import { actionResult, cancellationCaseSnapshot, caseContract, caseEvent, ownedCase, reviseCancellationCase, saveAction, type CaseRow } from "./funding-lifecycle";
import { lockFundingScope } from "./funding-positions";
import { requireCurrentRole, requireMembership } from "./membership";
import { openPrivate, sealPrivate } from "./private-values";

type Scope=Pick<Session,"tenantId"|"projectId">;
export const reconciliationContext=(scope:Scope,id:string)=>`funding-reconciliation:${scope.tenantId}:${scope.projectId}:${id}`;
const consentContext=(scope:Scope,id:string)=>`funding-adjustment-consent:${scope.tenantId}:${scope.projectId}:${id}`;
const identity=z.string().min(1).max(180),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const adjustmentProposalSchema=z.object({intentId:z.string().uuid(),caseId:identity,caseDigest:hash,reviewDigest:hash,reason:z.string().trim().min(12).max(800),acknowledged:z.literal(true)}).strict();
export const adjustmentActionSchema=z.object({intentId:z.string().uuid(),adjustmentId:identity,digest:hash,expectedVersion:z.number().int().positive(),acknowledged:z.literal(true)}).strict();
export const adjustmentConsentSchema=adjustmentActionSchema.extend({decision:z.enum(["accept","decline"])}).strict();
export const residualCaseSchema=z.object({intentId:z.string().uuid(),caseId:identity,caseDigest:hash,reviewDigest:hash,reason:z.string().trim().min(12).max(800),acknowledged:z.literal(true)}).strict();
interface AdjustmentRow {id:string;tenant_id:string;project_id:string;case_id:string;kind:string;version:number;state:string;digest:string;encrypted_data:string;created_by:string;membership_version:number;expires_at:Date;result_case_id:string|null;applied_at:Date|null;created_at:Date}
interface ConsentRow {id:string;tenant_id:string;project_id:string;reconciliation_id:string;actor_id:string;membership_version:number;version:number;decision:"accept"|"decline";state:string;digest:string;encrypted_data:string;revoked_at:Date|null}
const conflict=()=>new DomainError("RECONCILIATION_CONTRACT_CHANGED","The saved reconciliation evidence changed. Keep the original record for review.");
function adjustmentContract(row:AdjustmentRow):AllocationAdjustmentContract{
  const value=openPrivate<AllocationAdjustmentContract>(row.encrypted_data,reconciliationContext({tenantId:row.tenant_id,projectId:row.project_id},row.id));
  if(sha256(canonicalJson(value))!==row.digest||value.schemaVersion!==VERSION||value.id!==row.id||value.kind!==row.kind||value.caseId!==row.case_id||value.tenantId!==row.tenant_id||value.projectId!==row.project_id||value.createdBy!==row.created_by||value.membershipVersion!==row.membership_version||Date.parse(value.deadline)!==row.expires_at.getTime())throw conflict();
  return value;
}
function consentContract(row:ConsentRow):AdjustmentConsentContract{
  const value=openPrivate<AdjustmentConsentContract>(row.encrypted_data,consentContext({tenantId:row.tenant_id,projectId:row.project_id},row.id));
  if(sha256(canonicalJson(value))!==row.digest||value.schemaVersion!==VERSION||value.id!==row.id||value.reconciliationId!==row.reconciliation_id||value.tenantId!==row.tenant_id||value.projectId!==row.project_id||value.actorId!==row.actor_id||value.membershipVersion!==row.membership_version||value.version!==row.version||value.decision!==row.decision)throw conflict();
  return value;
}
async function ownedAdjustment(scope:Scope,id:string,tx:SqlConnection){const [row]=await query<AdjustmentRow>("SELECT * FROM fp_funding_reconciliations WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND kind='allocation_adjustment'",[scope.tenantId,scope.projectId,id],tx);if(!row)throw new DomainError("ADJUSTMENT_NOT_FOUND","That adjustment is outside this workspace.",404);return row;}

interface UseRow {id:string;receipt_id:string;claim_id:string;payable_id:string|null;package_id:string;kind:string;amount_minor:string;state:string;revision:number;audit_matches:boolean;principal_paid_at:Date|null;principal_returned_at:Date|null;fee_state:string|null;actual_fee_minor:string|null;item_hash:string|null;provider_status:string|null}
function useIdentity(row:UseRow){return{id:row.id,receiptId:row.receipt_id,claimId:row.claim_id,payableId:row.payable_id,packageId:row.package_id,kind:row.kind,amountMinor:Number(row.amount_minor),state:row.state,revision:row.revision};}
/** A fictional expense gets a fictional immutable source at creation, never a
 * fabricated provider result. This helper is unavailable to Live workspaces. */
export async function recordSampleFundingUse(tx:SqlConnection,scope:Scope,allocationId:string):Promise<void>{
  const [row]=await query<UseRow&{mode:string;provenance:string}>("SELECT a.*,t.mode,r.provenance FROM fp_receipt_allocations a JOIN fp_tenants t ON t.id=a.tenant_id JOIN fp_settlement_receipts r ON r.id=a.receipt_id WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.id=$3",[scope.tenantId,scope.projectId,allocationId],tx);
  if(!row||row.mode!=="sample"||row.provenance!=="sample"||row.state!=="paid")throw new DomainError("SAMPLE_USE_REQUIRED","A Sample allocation source belongs only to a fictional Sample expense.");
  const value={schemaVersion:VERSION,...scope,provenance:"sample",use:useIdentity(row),label:"Fictional Sample expense; no provider payment occurred"},digest=sha256(canonicalJson(value));
  await tx.query("INSERT INTO fp_sample_funding_use_evidence(allocation_id,tenant_id,project_id,document_digest,encrypted_data) VALUES($1,$2,$3,$4,$5)",[allocationId,scope.tenantId,scope.projectId,digest,sealPrivate(value,`sample-funding-use:${scope.tenantId}:${scope.projectId}:${allocationId}`)]);
}
async function allocationEvidence(session:Session,packageId:string,tx:SqlConnection):Promise<AllocationEvidence[]>{
  const rows=await query<UseRow>(`SELECT a.*,p.principal_paid_at,p.principal_returned_at,p.fee_state,p.actual_fee_minor,p.item_hash,p.provider_status,
    EXISTS(SELECT 1 FROM fp_allocation_revisions v WHERE v.allocation_id=a.id AND v.revision=a.revision AND v.receipt_id=a.receipt_id AND v.payable_id=a.payable_id AND v.package_id=a.package_id AND v.purpose=CASE WHEN a.kind='fee' THEN 'provider_fee' ELSE 'reviewed_expense' END AND v.amount_minor=a.amount_minor AND v.state=a.state) audit_matches
    FROM fp_receipt_allocations a LEFT JOIN fp_payables p ON p.id=a.payable_id AND p.tenant_id=a.tenant_id AND p.project_id=a.project_id
    WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.package_id=$3 AND a.state IN ('paid','reserved') ORDER BY a.id`,[session.tenantId,session.projectId,packageId],tx);
  const result:AllocationEvidence[]=[];
  for(const row of rows){
    let verified=!!(row.audit_matches&&row.item_hash&&(row.kind==="fee"?row.fee_state==="confirmed"&&Number(row.actual_fee_minor)>=Number(row.amount_minor):row.principal_paid_at&&!row.principal_returned_at&&row.provider_status==="SUCCESS"));
    let proof:unknown={auditMatches:row.audit_matches,itemHash:row.item_hash,principalPaidAt:row.principal_paid_at,principalReturnedAt:row.principal_returned_at,feeState:row.fee_state,actualFeeMinor:row.actual_fee_minor,providerStatus:row.provider_status};
    if(session.mode==="sample"){
      const [sample]=await query<{document_digest:string;encrypted_data:string}>("SELECT document_digest,encrypted_data FROM fp_sample_funding_use_evidence WHERE allocation_id=$1 AND tenant_id=$2 AND project_id=$3",[row.id,session.tenantId,session.projectId],tx);
      if(sample){const value=openPrivate<{provenance:string;use:ReturnType<typeof useIdentity>}>(sample.encrypted_data,`sample-funding-use:${session.tenantId}:${session.projectId}:${row.id}`);verified=value.provenance==="sample"&&sha256(canonicalJson(value))===sample.document_digest&&canonicalJson(value.use)===canonicalJson(useIdentity(row));proof={sampleDigest:sample.document_digest};}else verified=false;
    }
    result.push({...useIdentity(row),digest:sha256(canonicalJson({use:useIdentity(row),proof})),verified:row.state==="paid"&&verified,detail:row.state==="reserved"?"An unresolved expense reservation must reach its original outcome first.":verified?session.mode==="sample"?"Immutable fictional Sample expense source.":"Exact paid allocation revision and confirmed original Payout item.":"The paid allocation lacks matching immutable expense and payment evidence. Inspect its original expense before changing donor shares."});
  }
  return result;
}
async function adjustmentBasis(session:Session,row:CaseRow,tx:SqlConnection){
  const original=caseContract(row),review=await cancellationCaseSnapshot(session,original.packageId,tx),evidence=await allocationEvidence(session,original.packageId,tx),blockers:FundingRecoveryBlocker[]=[];
  if(row.state==="superseded")blockers.push({code:"CASE_SUPERSEDED",detail:"Open the current case; this earlier snapshot remains in the history."});
  if(review.packageVersion!==original.packageVersion||review.title!==original.title||review.purpose!==original.purpose)blockers.push({code:"PURPOSE_CHANGED",detail:"The cancelled purpose version or text changed. Resolve its exact purpose before another adjustment."});
  if(row.deadline.getTime()<=Date.now())blockers.push({code:"DECISION_WINDOW_ENDED",detail:"The original decision deadline ended. It is not extended by a reconciliation; new-purpose choices remain unavailable."});
  const comparable=(value:typeof original|typeof review)=>({packageVersion:value.packageVersion,totalMinor:value.totalMinor,denominatorMinor:value.denominatorMinor,sources:value.sources.map(({entitlementMinor: _entitlement,remainderNumerator: _remainder,...source})=>source)});
  const basisChanged=canonicalJson(comparable(original))!==canonicalJson(comparable(review));
  if(basisChanged)blockers.push({code:"FROZEN_BASIS_CHANGED",detail:"Verified source facts changed after the frozen review. Record a separate residual snapshot before proposing different shares."});
  if(original.method==="source-capacity-consented-v1")blockers.push({code:"ADJUSTMENT_ALREADY_RECORDED",detail:"This case already records the unanimously accepted source-specific shares. Use its separate donor choices; only changed financial facts can require a new residual review."});
  if(!review.conflicts.some(item=>item.code==="source_capacity"))blockers.push({code:"NO_CAPACITY_ADJUSTMENT",detail:"The current shares have no unequal source-capacity conflict. Keep the original calculation."});
  for(const item of review.conflicts.filter(item=>!["source_capacity","return_route_unqualified"].includes(item.code)))blockers.push({code:item.code,receiptId:item.receiptId,detail:item.code==="existing_exclusion"?"Inspect the original return evidence and reconcile this source’s review hold first.":item.code==="pending_return"?"Check the existing return’s original operation before changing shares.":item.code==="reserved_spending"?"The original expense reservation is unresolved; inspect that expense before changing shares.":"This source’s original consent, purpose or version still needs evidence."});
  for(const item of evidence.filter(item=>!item.verified))blockers.push({code:"EXPENSE_EVIDENCE_REQUIRED",receiptId:item.receiptId,detail:item.detail});
  const started=await query("SELECT id FROM fp_funding_choices WHERE case_id=$1 AND state IN ('executing','return_pending','executed','returned')",[row.id],tx);
  if(started.length)blockers.push({code:"DECISION_ALREADY_STARTED",detail:"Started decisions retain their exact shares. Resolve their outcomes and review only the residual support."});
  const pending=await query("SELECT id FROM fp_funding_choices WHERE case_id=$1 AND state IN ('executing','return_pending')",[row.id],tx);
  const holds=await query("SELECT h.id FROM fp_funding_return_holds h JOIN fp_settlement_receipts r ON r.id=h.receipt_id WHERE h.tenant_id=$1 AND h.project_id=$2 AND h.state='held' AND r.id=ANY($3::text[])",[session.tenantId,session.projectId,review.sources.map(source=>source.receiptId)],tx);
  const digest=sha256(canonicalJson({version:VERSION,caseId:row.id,caseDigest:row.digest,review:{...review,observedAt:undefined},evidence}));
  return{original,review,evidence,blockers,digest,canRefresh:basisChanged&&row.state!=="superseded"&&!pending.length&&!holds.length&&review.packageVersion===original.packageVersion&&review.title===original.title&&review.purpose===original.purpose};
}
async function adjustmentViews(session:Session,caseId:string,tx:SqlConnection):Promise<AdjustmentView[]>{
  const rows=await query<AdjustmentRow>("SELECT * FROM fp_funding_reconciliations WHERE tenant_id=$1 AND project_id=$2 AND case_id=$3 AND kind='allocation_adjustment' ORDER BY created_at DESC,id",[session.tenantId,session.projectId,caseId],tx),full=["organizer","auditor"].includes(session.role),result:AdjustmentView[]=[];
  for(const row of rows){
    const value=adjustmentContract(row),votes=await query<ConsentRow>("SELECT * FROM fp_funding_reconciliation_consents WHERE reconciliation_id=$1 ORDER BY version DESC",[row.id],tx),actors=[...new Set(value.shares.map(share=>share.donorActorId))];
    const active=votes.filter(vote=>vote.state==="recorded");for(const vote of votes){const consent=consentContract(vote);if(consent.reconciliationDigest!==row.digest)throw conflict();}
    const own=votes.find(vote=>vote.actor_id===session.actorId),accepted=active.filter(vote=>vote.decision==="accept").length,declined=active.filter(vote=>vote.decision==="decline").length,open=row.state==="awaiting_donors"&&row.expires_at.getTime()>Date.now();
    result.push({id:row.id,digest:row.digest,version:row.version,state:row.state==="awaiting_donors"&&row.expires_at.getTime()<=Date.now()?"expired":row.state,reason:value.reason,deadline:value.deadline,createdAt:value.createdAt,appliedAt:row.applied_at?.toISOString()??null,resultCaseId:row.result_case_id,totalMinor:value.totalMinor,supporters:actors.length,accepted,declined,
      ownConsent:own?{id:own.id,version:own.version,state:own.state,decision:own.decision}:null,
      shares:value.shares.filter(share=>full||share.donorActorId===session.actorId).map(share=>({receiptId:share.receiptId,originalMinor:share.originalMinor,proposedMinor:share.proposedMinor,paidMinor:share.paidMinor,own:share.donorActorId===session.actorId})),
      evidence:full?value.evidence:value.evidence.filter(item=>value.shares.some(share=>share.donorActorId===session.actorId&&share.receiptId===item.receiptId)),
      canRespond:open&&session.role==="donor"&&actors.includes(session.actorId)&&(!own||own.state==="revoked"),canRevoke:open&&session.role==="donor"&&own?.state==="recorded",canApply:open&&session.role==="organizer"&&value.createdBy===session.actorId&&accepted===actors.length,canWithdraw:row.state==="awaiting_donors"&&session.role==="organizer"&&value.createdBy===session.actorId});
  }return result;
}
export async function caseRecoveryReview(session:Session,caseId:string):Promise<CaseRecoveryReview>{
  await initializeDatabase();const result=await database().transaction(async tx=>{
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");await requireCurrentRole(session,session.role,tx);const row=await ownedCase(session,caseId,tx),original=caseContract(row),full=["organizer","auditor"].includes(session.role);
    if(!full&&!(session.role==="donor"&&original.sources.some(source=>source.donorActorId===session.actorId)))throw new DomainError("CASE_NOT_FOUND","This recovery review is outside your view.",404);
    const basis=await adjustmentBasis(session,row,tx),adjustments=await adjustmentViews(session,caseId,tx),visible=basis.review.sources.filter(source=>full||source.donorActorId===session.actorId);
    return{caseId:row.id,caseDigest:row.digest,packageId:original.packageId,title:original.title,purpose:original.purpose,revision:row.revision,state:row.state,deadline:original.deadline,observedAt:basis.review.observedAt,digest:basis.digest,denominatorMinor:original.denominatorMinor,totalMinor:full?basis.review.totalMinor:visible.reduce((sum,source)=>sum+source.availableMinor,0),
      sources:visible.map(source=>({receiptId:source.receiptId,originalMinor:original.sources.find(saved=>saved.receiptId===source.receiptId)?.entitlementMinor??0,proposedMinor:source.availableMinor,paidMinor:source.paidMinor,reservedMinor:source.reservedMinor,excludedMinor:source.excludedMinor,pendingReturnMinor:source.pendingRefundMinor,own:source.donorActorId===session.actorId})),
      evidence:basis.evidence.filter(item=>full||visible.some(source=>source.receiptId===item.receiptId)),blockers:basis.blockers.filter(item=>full||!item.receiptId||item.receiptId==="package"||visible.some(source=>source.receiptId===item.receiptId)),canPropose:session.role==="organizer"&&!basis.blockers.length&&!adjustments.some(item=>item.state==="awaiting_donors"),canRefreshCase:session.role==="organizer"&&basis.canRefresh,adjustments};
  });await requireCurrentRole(session,session.role);return result;
}
export async function proposeAllocationAdjustment(session:Session,raw:z.infer<typeof adjustmentProposalSchema>):Promise<{id:string}>{
  const input=adjustmentProposalSchema.parse(raw);return database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);const member=await requireCurrentRole(session,"organizer",tx),prior=await actionResult(tx,session,input.intentId,"propose_adjustment",input);if(prior)return prior;
    const row=await ownedCase(session,input.caseId,tx),basis=await adjustmentBasis(session,row,tx);
    if(row.digest!==input.caseDigest||basis.digest!==input.reviewDigest)throw new DomainError("ADJUSTMENT_REVIEW_CHANGED","The source position or expense evidence changed. Inspect the current review again.");
    if(basis.blockers.length)throw new DomainError("ADJUSTMENT_EVIDENCE_REQUIRED",basis.blockers[0].detail);
    if((await query("SELECT id FROM fp_funding_reconciliations WHERE case_id=$1 AND kind='allocation_adjustment' AND state='awaiting_donors'",[row.id],tx)).length)throw new DomainError("ADJUSTMENT_ALREADY_OPEN","The saved adjustment is waiting for supporters. Keep its exact original terms.");
    const id=randomUUID(),value:AllocationAdjustmentContract={schemaVersion:VERSION,id,tenantId:session.tenantId,projectId:session.projectId,provenance:session.mode,kind:"allocation_adjustment",caseId:row.id,caseDigest:row.digest,packageId:basis.original.packageId,packageVersion:basis.original.packageVersion,title:basis.original.title,purpose:basis.original.purpose,reason:input.reason,basisDigest:basis.digest,denominatorMinor:basis.original.denominatorMinor,totalMinor:basis.original.totalMinor,deadline:basis.original.deadline,
      shares:basis.original.sources.map(source=>({receiptId:source.receiptId,donorActorId:source.donorActorId,originalMinor:source.entitlementMinor,proposedMinor:source.availableMinor,paidMinor:source.paidMinor,source})),evidence:basis.evidence,createdBy:session.actorId,membershipVersion:member.membershipVersion,createdAt:new Date().toISOString()};
    const digest=sha256(canonicalJson(value));await tx.query("INSERT INTO fp_funding_reconciliations(id,tenant_id,project_id,kind,case_id,state,digest,encrypted_data,created_by,membership_version,expires_at) VALUES($1,$2,$3,'allocation_adjustment',$4,'awaiting_donors',$5,$6,$7,$8,$9)",[id,session.tenantId,session.projectId,row.id,digest,sealPrivate(value,reconciliationContext(session,id)),session.actorId,member.membershipVersion,value.deadline]);
    await caseEvent(tx,session,row.id,session.actorId,"allocation_adjustment_proposed","The organizer proposed source-specific remaining shares backed by the exact expense history. Every affected supporter must explicitly accept; no share, receipt, expense or deadline changed.",{adjustmentId:id});await saveAction(tx,session,input.intentId,"propose_adjustment",input,{id});return{id};
  });
}
export async function respondAllocationAdjustment(session:Session,raw:z.infer<typeof adjustmentConsentSchema>):Promise<{id:string}>{
  const input=adjustmentConsentSchema.parse(raw);return database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);const member=await requireCurrentRole(session,"donor",tx),prior=await actionResult(tx,session,input.intentId,"respond_adjustment",input);if(prior)return prior;
    const row=await ownedAdjustment(session,input.adjustmentId,tx),value=adjustmentContract(row),shares=value.shares.filter(share=>share.donorActorId===session.actorId);
    if(!shares.length)throw new DomainError("ADJUSTMENT_NOT_FOUND","Only the affected supporter can decide on their own revised shares.",404);
    if(row.digest!==input.digest||row.version!==input.expectedVersion||row.state!=="awaiting_donors"||row.expires_at.getTime()<=Date.now())throw new DomainError("ADJUSTMENT_AUTHORITY_CHANGED","This adjustment changed, ended or was already applied. Keep its saved record.");
    const basis=await adjustmentBasis(session,await ownedCase(session,row.case_id,tx),tx);if(basis.digest!==value.basisDigest||basis.blockers.length)throw new DomainError("ADJUSTMENT_REVIEW_CHANGED","The underlying contribution or expense evidence changed. The organizer must inspect the saved review.");
    const rows=await query<ConsentRow>("SELECT * FROM fp_funding_reconciliation_consents WHERE reconciliation_id=$1 AND actor_id=$2 ORDER BY version DESC",[row.id,session.actorId],tx);if(rows.some(vote=>vote.state==="recorded"))throw new DomainError("ADJUSTMENT_RESPONSE_EXISTS","Withdraw your uncommitted response before changing it.");
    const id=randomUUID(),consent:AdjustmentConsentContract={schemaVersion:VERSION,id,reconciliationId:row.id,reconciliationDigest:row.digest,tenantId:session.tenantId,projectId:session.projectId,actorId:session.actorId,membershipVersion:member.membershipVersion,version:(rows[0]?.version??0)+1,decision:input.decision,shares:shares.map(share=>({receiptId:share.receiptId,originalMinor:share.originalMinor,proposedMinor:share.proposedMinor})),acceptedAt:new Date().toISOString(),deadline:value.deadline};
    await tx.query("INSERT INTO fp_funding_reconciliation_consents(id,tenant_id,project_id,reconciliation_id,actor_id,membership_version,version,decision,digest,encrypted_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[id,session.tenantId,session.projectId,row.id,session.actorId,member.membershipVersion,consent.version,input.decision,sha256(canonicalJson(consent)),sealPrivate(consent,consentContext(session,id))]);
    await caseEvent(tx,session,row.case_id,session.actorId,input.decision==="accept"?"allocation_adjustment_accepted":"allocation_adjustment_declined",input.decision==="accept"?"A supporter explicitly accepted their revised source-specific remaining shares. Payment and new-purpose choices remain separate.":"A supporter declined the proposed shares. The original review remains held; no consent was inferred.",{adjustmentId:row.id,consentId:id});await saveAction(tx,session,input.intentId,"respond_adjustment",input,{id});return{id};
  });
}
export async function revokeAdjustmentResponse(session:Session,raw:z.infer<typeof adjustmentActionSchema>):Promise<{id:string}>{
  const input=adjustmentActionSchema.parse(raw);return database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);await requireCurrentRole(session,"donor",tx);const prior=await actionResult(tx,session,input.intentId,"revoke_adjustment",input);if(prior)return prior;
    const row=await ownedAdjustment(session,input.adjustmentId,tx);adjustmentContract(row);if(row.digest!==input.digest||row.version!==input.expectedVersion||row.state!=="awaiting_donors")throw new DomainError("ADJUSTMENT_ALREADY_APPLIED","A recorded adjustment retains the agreement used to create its case. Only an unapplied response can be withdrawn.");
    const [vote]=await query<ConsentRow>("SELECT * FROM fp_funding_reconciliation_consents WHERE reconciliation_id=$1 AND actor_id=$2 AND state='recorded'",[row.id,session.actorId],tx);if(!vote)throw new DomainError("ADJUSTMENT_RESPONSE_NOT_FOUND","Only your own uncommitted response can be withdrawn.",404);consentContract(vote);
    await tx.query("UPDATE fp_funding_reconciliation_consents SET state='revoked',revoked_at=clock_timestamp() WHERE id=$1",[vote.id]);await caseEvent(tx,session,row.case_id,session.actorId,"allocation_adjustment_response_withdrawn","The supporter withdrew their response before the adjustment was applied.",{adjustmentId:row.id,consentId:vote.id});await saveAction(tx,session,input.intentId,"revoke_adjustment",input,{id:vote.id});return{id:vote.id};
  });
}
export async function applyAllocationAdjustment(session:Session,raw:z.infer<typeof adjustmentActionSchema>):Promise<{id:string}>{
  const input=adjustmentActionSchema.parse(raw);return database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);const member=await requireCurrentRole(session,"organizer",tx),prior=await actionResult(tx,session,input.intentId,"apply_adjustment",input);if(prior)return prior;
    const row=await ownedAdjustment(session,input.adjustmentId,tx),value=adjustmentContract(row);
    if(row.digest!==input.digest||row.version!==input.expectedVersion||row.state!=="awaiting_donors"||row.expires_at.getTime()<=Date.now()||value.createdBy!==session.actorId||value.membershipVersion!==member.membershipVersion)throw new DomainError("ADJUSTMENT_AUTHORITY_CHANGED","The original adjustment approver needs the same current authority and unchanged decision window.");
    const currentCase=await ownedCase(session,row.case_id,tx),basis=await adjustmentBasis(session,currentCase,tx);if(basis.digest!==value.basisDigest||basis.blockers.length)throw new DomainError("ADJUSTMENT_REVIEW_CHANGED","The current receipt, expense evidence or frozen review changed. No revised shares were applied.");
    const votes=await query<ConsentRow>("SELECT * FROM fp_funding_reconciliation_consents WHERE reconciliation_id=$1 AND state='recorded'",[row.id],tx);
    for(const actorId of new Set(value.shares.map(share=>share.donorActorId))){const vote=votes.find(vote=>vote.actor_id===actorId);if(!vote||vote.decision!=="accept")throw new DomainError("ADJUSTMENT_CONSENT_REQUIRED","Every affected supporter must explicitly accept their exact revised shares. Silence or a decline keeps this review held.");const consent=consentContract(vote),authority=await requireMembership(session.tenantId,session.projectId,actorId,"donor",tx);if(consent.reconciliationDigest!==row.digest||authority.version!==consent.membershipVersion||canonicalJson(consent.shares)!==canonicalJson(value.shares.filter(share=>share.donorActorId===actorId).map(share=>({receiptId:share.receiptId,originalMinor:share.originalMinor,proposedMinor:share.proposedMinor}))))throw new DomainError("ADJUSTMENT_CONSENT_CHANGED","A supporter’s recorded acceptance no longer has the same exact shares or current authority.");}
    const id=await reviseCancellationCase(tx,session,currentCase,basis.review,{id:row.id,digest:row.digest,kind:"allocation_adjustment"},true);await tx.query("UPDATE fp_funding_reconciliations SET state='applied',result_case_id=$2,applied_at=clock_timestamp() WHERE id=$1",[row.id,id]);await saveAction(tx,session,input.intentId,"apply_adjustment",input,{id});return{id};
  });
}
export async function withdrawAllocationAdjustment(session:Session,raw:z.infer<typeof adjustmentActionSchema>):Promise<{id:string}>{
  const input=adjustmentActionSchema.parse(raw);return database().transaction(async tx=>{await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);await requireCurrentRole(session,"organizer",tx);const prior=await actionResult(tx,session,input.intentId,"withdraw_adjustment",input);if(prior)return prior;const row=await ownedAdjustment(session,input.adjustmentId,tx),value=adjustmentContract(row);if(row.digest!==input.digest||row.version!==input.expectedVersion||row.state!=="awaiting_donors"||value.createdBy!==session.actorId)throw new DomainError("ADJUSTMENT_AUTHORITY_CHANGED","Only the original organizer can withdraw this unapplied proposal.");await tx.query("UPDATE fp_funding_reconciliations SET state='withdrawn' WHERE id=$1",[row.id]);await caseEvent(tx,session,row.case_id,session.actorId,"allocation_adjustment_withdrawn","The unapplied proposal was withdrawn. Original shares, consent history and the deadline remain intact.",{adjustmentId:row.id});await saveAction(tx,session,input.intentId,"withdraw_adjustment",input,{id:row.id});return{id:row.id};});
}
export async function refreshResidualCase(session:Session,raw:z.infer<typeof residualCaseSchema>):Promise<{id:string}>{
  const input=residualCaseSchema.parse(raw);return database().transaction(async tx=>{await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);const member=await requireCurrentRole(session,"organizer",tx),prior=await actionResult(tx,session,input.intentId,"residual_case_review",input);if(prior)return prior;const row=await ownedCase(session,input.caseId,tx),basis=await adjustmentBasis(session,row,tx);if(row.digest!==input.caseDigest||basis.digest!==input.reviewDigest||!basis.canRefresh)throw new DomainError("RESIDUAL_REVIEW_REQUIRED","Resolve the outstanding return evidence and inspect the changed source facts before recording a residual review.");
    const reviewId=randomUUID(),record={schemaVersion:VERSION,id:reviewId,kind:"residual_review",caseId:row.id,caseDigest:row.digest,basisDigest:basis.digest,reason:input.reason,createdBy:session.actorId,membershipVersion:member.membershipVersion,createdAt:new Date().toISOString()},digest=sha256(canonicalJson(record));
    await caseEvent(tx,session,row.id,session.actorId,"residual_review_approved","The organizer approved the exact changed source position for a separate residual case, retaining the original deadline.",{reviewId,digest,encryptedReview:sealPrivate(record,reconciliationContext(session,reviewId))});
    const id=await reviseCancellationCase(tx,session,row,basis.review,{id:reviewId,digest,kind:"residual_review"});await tx.query("UPDATE fp_funding_reconciliations SET state='superseded' WHERE case_id=$1 AND state='awaiting_donors'",[row.id]);await saveAction(tx,session,input.intentId,"residual_case_review",input,{id});return{id};});
}
/** Adjusted shares can only be used through their immutable unanimous contract. */
export async function assertAppliedAdjustment(tx:SqlConnection,scope:Scope,saved:CancellationCaseContract):Promise<void>{
  if(saved.method!=="source-capacity-consented-v1")return;if(saved.reconciliation?.kind!=="allocation_adjustment")throw conflict();
  const row=await ownedAdjustment(scope,saved.reconciliation.id,tx),value=adjustmentContract(row);
  if(row.state!=="applied"||row.result_case_id!==saved.id||row.digest!==saved.reconciliation.digest||value.deadline!==saved.deadline||value.totalMinor!==saved.totalMinor||value.shares.some(share=>saved.sources.find(source=>source.receiptId===share.receiptId)?.entitlementMinor!==share.proposedMinor))throw conflict();
  const votes=await query<ConsentRow>("SELECT * FROM fp_funding_reconciliation_consents WHERE reconciliation_id=$1 AND state='recorded'",[row.id],tx);
  for(const actorId of new Set(value.shares.map(share=>share.donorActorId))){const vote=votes.find(vote=>vote.actor_id===actorId);if(!vote||vote.decision!=="accept"||consentContract(vote).reconciliationDigest!==row.digest)throw conflict();}
}
