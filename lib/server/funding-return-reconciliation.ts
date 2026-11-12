import { randomUUID } from "node:crypto";
import { canonicalJson, sha256, type ProviderAdapter, type SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import { assertCurrentFundingLots, projectFundingLots } from "../domain/funding-lots";
import { projectFundingPositions } from "../domain/funding-positions";
import { assertBalanced, DomainError } from "../domain/money";
import { FUNDING_RECONCILIATION_VERSION as VERSION, type FundingRecoveryBlocker, type OriginalReturnEvidence, type ReturnAttributionContract, type ReturnHoldContract, type ReturnObservationContract, type ReturnRecoveryReview } from "../funding/reconciliation";
import type { Session } from "./auth";
import { projectClaimLock } from "./claims";
import { database, initializeDatabase, query } from "./db";
import { reconciliationContext } from "./funding-adjustments";
import { actionResult, cancellationCaseSnapshot, caseContract, caseEvent, ownedCase, reviseCancellationCase, saveAction, savedFundingPolicy, type CaseRow } from "./funding-lifecycle";
import { lockFundingScope, readFundingJournal, readFundingOrigins } from "./funding-positions";
import { assertCommittedFundingChoices } from "./funding-authority";
import { fundingSourceDigest, persistFundingReceipt } from "./funding-writes";
import { requireCurrentRole, requireMembership } from "./membership";
import { openPrivate, sealPrivate } from "./private-values";
import { appendEvent } from "./repository";

type Scope=Pick<Session,"tenantId"|"projectId">;
const scopeOf=(session:Session)=>({...session,provenance:session.mode});
const holdContext=(scope:Scope,id:string)=>`funding-return-hold:${scope.tenantId}:${scope.projectId}:${id}`;
const observationContext=(scope:Scope,id:string)=>`funding-return-observation:${scope.tenantId}:${scope.projectId}:${id}`;
const externalContext=(scope:Scope,id:string)=>`funding-external-return-record:${scope.tenantId}:${scope.projectId}:${id}`;
const identity=z.string().min(1).max(180),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const observeReturnsSchema=z.object({intentId:z.string().uuid(),receiptId:identity,expectedVersion:z.number().int().positive(),references:z.array(z.string().trim().regex(/^[A-Za-z0-9_-]{3,180}$/)).max(20).default([]),sampleReturnMinor:z.number().int().min(1).max(100_000_000).optional(),acknowledged:z.literal(true)}).strict();
export const reconcileReturnsSchema=z.object({intentId:z.string().uuid(),receiptId:identity,expectedVersion:z.number().int().positive(),reviewDigest:hash,observationId:identity,observationDigest:hash,reason:z.string().trim().min(12).max(800),acknowledged:z.literal(true)}).strict();
interface HoldRow {id:string;tenant_id:string;project_id:string;receipt_id:string;digest:string;encrypted_data:string;state:string;released_by:string|null;released_at:Date|null;created_at:Date}
interface ObservationRow {id:string;tenant_id:string;project_id:string;receipt_id:string;receipt_version:number;digest:string;encrypted_data:string;created_by:string;created_at:Date}
interface ExternalRow {id:string;tenant_id:string;project_id:string;receipt_id:string;reconciliation_id:string;provider_refund_hash:string;amount_minor:string;digest:string;encrypted_data:string;created_at:Date}
const conflict=()=>new DomainError("RETURN_REVIEW_CONTRACT_CHANGED","The original return evidence or saved review identity changed. Keep this source held for inspection.");
export function holdContract(row:HoldRow):ReturnHoldContract{const value=openPrivate<ReturnHoldContract>(row.encrypted_data,holdContext({tenantId:row.tenant_id,projectId:row.project_id},row.id));if(sha256(canonicalJson(value))!==row.digest||value.schemaVersion!==VERSION||value.id!==row.id||value.tenantId!==row.tenant_id||value.projectId!==row.project_id||value.receiptId!==row.receipt_id)throw conflict();return value;}
function observationContract(row:ObservationRow):ReturnObservationContract{const value=openPrivate<ReturnObservationContract>(row.encrypted_data,observationContext({tenantId:row.tenant_id,projectId:row.project_id},row.id));if(sha256(canonicalJson(value))!==row.digest||value.schemaVersion!==VERSION||value.id!==row.id||value.tenantId!==row.tenant_id||value.projectId!==row.project_id||value.receiptId!==row.receipt_id||value.receiptVersion!==row.receipt_version||value.createdBy!==row.created_by)throw conflict();return value;}
export function externalReturnRecord(row:ExternalRow){const value=openPrivate<{id:string;tenantId:string;projectId:string;receiptId:string;reconciliationId:string;providerRefundId:string;amountMinor:number;packageId:string;provenance:string;observedAt:string}>(row.encrypted_data,externalContext({tenantId:row.tenant_id,projectId:row.project_id},row.id));if(sha256(canonicalJson(value))!==row.digest||value.id!==row.id||value.tenantId!==row.tenant_id||value.projectId!==row.project_id||value.receiptId!==row.receipt_id||value.reconciliationId!==row.reconciliation_id||sha256(value.providerRefundId)!==row.provider_refund_hash||value.amountMinor!==Number(row.amount_minor))throw conflict();return value;}
async function authorizedSource(session:Session,receiptId:string,tx:SqlConnection){
  await requireCurrentRole(session,session.role,tx);
  const [owner]=await query<{actor_id:string}>("SELECT o.actor_id FROM fp_settlement_receipts r JOIN fp_obligations o ON o.id=r.obligation_id AND o.tenant_id=r.tenant_id AND o.project_id=r.project_id WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.id=$3 AND o.purpose='conditional_pledge'",[session.tenantId,session.projectId,receiptId],tx);
  if(!owner||!(["organizer","auditor"].includes(session.role)||session.role==="donor"&&owner.actor_id===session.actorId))throw new DomainError("FUNDING_RECEIPT_NOT_FOUND","That original payment is outside your current view.",404);
  const journal=await readFundingJournal(scopeOf(session),tx),source=journal.sources.find(source=>source.receipt.id===receiptId);if(!source)throw conflict();return{journal,source};
}

/** Called only under the project claim and deterministic full funding locks.
 * The hold records precisely which exclusions it introduced; release cannot
 * remove an older exclusion or manufacture credit on another source. */
export async function recordExternalReturnHold(tx:SqlConnection,session:Session,receiptId:string,providerIds:string[],consumedMinor:number):Promise<HoldRow>{
  const [existing]=await query<HoldRow>("SELECT * FROM fp_funding_return_holds WHERE tenant_id=$1 AND project_id=$2 AND receipt_id=$3 AND state='held'",[session.tenantId,session.projectId,receiptId],tx);if(existing){holdContract(existing);return existing;}
  const {journal,source}=await authorizedSource(session,receiptId,tx),scope=scopeOf(session),positions=projectFundingPositions(journal,scope).positions.filter(position=>position.receiptId===receiptId),held=positions.reduce((sum,position)=>sum+position.availableMinor,0),packageIds=[...new Set(positions.filter(position=>position.assignedMinor>0).map(position=>position.packageId))];
  const policies=await query<{id:string;package_id:string;state:string}>("SELECT id,package_id,state FROM fp_funding_policies WHERE tenant_id=$1 AND project_id=$2 AND package_id=ANY($3::text[]) ORDER BY id",[session.tenantId,session.projectId,packageIds],tx);
  const id=randomUUID(),value:ReturnHoldContract={schemaVersion:VERSION,id,tenantId:session.tenantId,projectId:session.projectId,receiptId,receiptVersion:source.version,sourceDigest:fundingSourceDigest(journal,receiptId),createdAt:new Date().toISOString(),createdBy:session.actorId,providerIds:[...new Set(providerIds)].sort(),consumedMinor,positions:positions.filter(position=>position.availableMinor>0).map(position=>({packageId:position.packageId,amountMinor:position.availableMinor})),policies:policies.map(policy=>({id:policy.id,packageId:policy.package_id,state:policy.state}))};
  if(held){const next=structuredClone(source.receipt);next.excludedMinor+=held;await persistFundingReceipt(tx,scope,{version:source.version,data:source.receipt},next,value.positions.map(position=>({packageId:position.packageId,excludedMinor:position.amountMinor})));}
  await tx.query("INSERT INTO fp_funding_return_holds(id,tenant_id,project_id,receipt_id,digest,encrypted_data) VALUES($1,$2,$3,$4,$5,$6)",[id,session.tenantId,session.projectId,receiptId,sha256(canonicalJson(value)),sealPrivate(value,holdContext(session,id))]);
  await tx.query("UPDATE fp_packages SET data=jsonb_set(data,'{fundingState}','\"funding_review\"'::jsonb) WHERE project_id=$1 AND id=ANY($2::text[]) AND data->>'fundingState' NOT IN ('cancelled','compensating')",[session.projectId,packageIds]);
  await tx.query("UPDATE fp_collection_rounds SET state='funding_review' WHERE tenant_id=$1 AND project_id=$2 AND package_id=ANY($3::text[]) AND state IN ('funded','allocation_open')",[session.tenantId,session.projectId,packageIds]);
  await tx.query("UPDATE fp_funding_policies SET state='review_required' WHERE tenant_id=$1 AND project_id=$2 AND package_id=ANY($3::text[]) AND state IN ('open','funded')",[session.tenantId,session.projectId,packageIds]);
  const cases=await query<{id:string}>("UPDATE fp_funding_cases SET state='review_required' WHERE tenant_id=$1 AND project_id=$2 AND package_id=ANY($3::text[]) AND state<>'superseded' RETURNING id",[session.tenantId,session.projectId,packageIds],tx);
  for(const row of cases)await caseEvent(tx,session,row.id,session.actorId,"external_return_review","The original route reports a return without exact local attribution. This source’s remaining credit is held until its original evidence is reconciled. No new return was sent.",{holdId:id,receiptId,receiptVersion:source.version+(held?1:0),heldMinor:held});
  return(await query<HoldRow>("SELECT * FROM fp_funding_return_holds WHERE id=$1",[id],tx))[0];
}

async function knownReturns(scope:Scope,receiptId:string,tx:SqlConnection){
  const local=await query<{id:string;provider_refund_hash:string|null;amount_minor:string;state:string}>("SELECT id,provider_refund_hash,amount_minor,state FROM fp_refunds WHERE tenant_id=$1 AND project_id=$2 AND receipt_id=$3",[scope.tenantId,scope.projectId,receiptId],tx),external=await query<ExternalRow>("SELECT * FROM fp_funding_external_returns WHERE tenant_id=$1 AND project_id=$2 AND receipt_id=$3 ORDER BY created_at,id",[scope.tenantId,scope.projectId,receiptId],tx);
  for(const row of external)externalReturnRecord(row);
  return{local,external,hashes:new Set([...local.flatMap(row=>row.provider_refund_hash?[row.provider_refund_hash]:[]),...external.map(row=>row.provider_refund_hash)])};
}
async function returnBasis(session:Session,receiptId:string,tx:SqlConnection){
  const {journal,source}=await authorizedSource(session,receiptId,tx),scope=scopeOf(session),projection=projectFundingPositions(journal,scope),positions=projection.positions.filter(position=>position.receiptId===receiptId),origins=await readFundingOrigins(scope,tx),origin=origins.find(origin=>origin.receiptId===receiptId),known=await knownReturns(session,receiptId,tx);
  const [holdRow]=await query<HoldRow>("SELECT * FROM fp_funding_return_holds WHERE tenant_id=$1 AND project_id=$2 AND receipt_id=$3 AND state='held'",[session.tenantId,session.projectId,receiptId],tx),hold=holdRow?holdContract(holdRow):null;
  const [observationRow]=await query<ObservationRow>("SELECT * FROM fp_funding_return_observations WHERE tenant_id=$1 AND project_id=$2 AND receipt_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1",[session.tenantId,session.projectId,receiptId],tx),observation=observationRow?observationContract(observationRow):null,blockers:FundingRecoveryBlocker[]=[];
  const sourceDigest=fundingSourceDigest(journal,receiptId),heldMinor=hold?.positions.reduce((sum,part)=>sum+part.amountMinor,0)??0;
  if(!hold)blockers.push({code:"NO_RETURN_HOLD",detail:"This source has no unresolved outside-return hold. Its recorded returns remain in the contribution trail."});
  if(!observation)blockers.push({code:"ORIGINAL_RETURN_EVIDENCE_REQUIRED",detail:"Read the original capture and each actual return reference. A total or screenshot alone cannot prove exact original-route attribution."});
  if(!origin)blockers.push({code:"ORIGINAL_PURPOSE_UNPROVEN",detail:"The original donor, restricted purpose and version need their owned collection or pledge record."});
  let eligibleReturns:OriginalReturnEvidence["refunds"]=[];
  if(observation){
    const evidence=observation.evidence;
    if(observation.receiptVersion!==source.version||observation.sourceDigest!==sourceDigest)blockers.push({code:"RETURN_SOURCE_CHANGED",detail:"The contribution changed after the provider observation. Read its original returns again before recording attribution."});
    if(Date.now()-Date.parse(evidence.observedAt)>5*60_000||Date.parse(evidence.observedAt)>Date.now()+5_000)blockers.push({code:"RETURN_OBSERVATION_STALE",detail:"Read the original payment again. Applying a return review requires evidence from the last five minutes."});
    if(evidence.provenance!==session.mode||evidence.captureId!==(session.mode==="sample"?source.receipt.provenRefundableRef??source.receipt.actualProviderPaymentRef:source.receipt.provenRefundableRef)||evidence.capturedMinor!==source.receipt.grossSettledMinor||evidence.currency!==source.receipt.currency)blockers.push({code:"RETURN_SOURCE_IDENTITY_UNPROVEN",detail:"The independently read capture must match this exact original payment, amount, currency and provenance."});
    if(!evidence.historyComplete)blockers.push({code:"RETURN_HISTORY_INCOMPLETE",detail:"The current capture does not establish its complete return history. Supply the original provider return references and inspect them; keep the hold until that history can be corroborated."});
    if(new Set(evidence.refunds.map(refund=>refund.id)).size!==evidence.refunds.length||evidence.refunds.some(refund=>refund.captureId!==evidence.captureId||!Number.isSafeInteger(refund.amountMinor)||refund.amountMinor<0))throw conflict();
    if(hold?.providerIds.some(id=>!evidence.refunds.some(refund=>refund.id===id)))blockers.push({code:"PREVIOUS_RETURN_UNRESOLVED",detail:"A previously observed outside return is absent from this evidence. Read that exact original reference before releasing its hold."});
    for(const refund of evidence.refunds){
      if(known.hashes.has(sha256(refund.id))){const recorded=[...known.local,...known.external].find(row=>row.provider_refund_hash===sha256(refund.id));if(!recorded||Number(recorded.amount_minor)!==refund.amountMinor||refund.status!=="COMPLETED")blockers.push({code:"RECORDED_RETURN_CONFLICT",detail:"The provider history contradicts an already recorded return. Reconcile that original operation before this review can proceed."});continue;}
      if(refund.status==="COMPLETED")eligibleReturns.push(refund);
      else if(!["FAILED","CANCELLED","CANCELED","DENIED"].includes(refund.status))blockers.push({code:"OUTSIDE_RETURN_UNRESOLVED",detail:"An outside return is still pending or unknown. Check the same original reference; it cannot be treated as returned or released yet."});
    }
  }
  if(known.local.some(row=>row.state!=="completed"))blockers.push({code:"LOCAL_RETURN_UNRESOLVED",detail:"An owned refund operation is still unresolved. Check or retry that original operation in the donor decision before attributing an outside return."});
  const amountMinor=eligibleReturns.reduce((sum,refund)=>sum+refund.amountMinor,0);
  if(amountMinor&&source.receipt.excessLiabilityMinor)blockers.push({code:"EXCESS_ATTRIBUTION_UNPROVEN",detail:"This capture includes uncredited excess. The outside return does not prove which amount was restricted support and which was excess; retain the hold and reconcile its original return operation."});
  // The provider adapter proves a refund's original capture, not its creation
  // time or a changed restricted purpose. Never infer a destination from the
  // latest aggregate when any assignment has occurred on that capture.
  if(amountMinor&&journal.assignments.some(entry=>entry.receiptId===receiptId))blockers.push({code:"TRANSFERRED_RETURN_PURPOSE_UNPROVEN",detail:"This original payment has changed purposes. Provider capture evidence alone does not prove which versioned purpose the outside return reduced. Inspect the saved decisions and reconcile a matching original refund operation; this hold cannot be released by choosing an arbitrary destination."});
  try{projectFundingLots(journal,scope,origins);}catch(error){if(!(error instanceof DomainError))throw error;blockers.push({code:error.code,detail:"The complete original-purpose and credit-lot history needs review before any held credit can be released."});}
  for(const part of hold?.positions??[]){if((positions.find(position=>position.packageId===part.packageId)?.excludedMinor??0)<part.amountMinor)blockers.push({code:"RETURN_HOLD_CHANGED",detail:"The exact exclusion introduced by this hold has changed. Reconcile its current deduction version without releasing an older exclusion."});}
  const originalPosition=positions.find(position=>position.packageId===source.receipt.packageId),originalHeld=hold?.positions.find(part=>part.packageId===source.receipt.packageId)?.amountMinor??0;
  if(amountMinor>(originalPosition?.availableMinor??0)+originalHeld)blockers.push({code:"ORIGINAL_RETURN_CAPACITY_CONFLICT",detail:"The proven outside return exceeds this original source’s unspent capacity. Paid expenses and other donors’ payments cannot be moved to manufacture capacity."});
  const digest=sha256(canonicalJson({version:VERSION,receiptId,sourceDigest,positions,hold:holdRow?{id:holdRow.id,digest:holdRow.digest}:null,observation:observationRow?{id:observationRow.id,digest:observationRow.digest}:null,known:{local:known.local,external:known.external.map(row=>({id:row.id,digest:row.digest}))},eligibleReturns,origin:origin??null}));
  return{journal,source,positions,origin,holdRow,hold,observationRow,observation,known,blockers,eligibleReturns,amountMinor,heldMinor,digest,sourceDigest};
}
export async function returnRecoveryReview(session:Session,receiptId:string):Promise<ReturnRecoveryReview>{
  await initializeDatabase();const result=await database().transaction(async tx=>{
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");const basis=await returnBasis(session,receiptId,tx),receipt=basis.source.receipt;
    const cases=await query<CaseRow>("SELECT * FROM fp_funding_cases WHERE tenant_id=$1 AND project_id=$2 AND state<>'superseded' ORDER BY created_at,id",[session.tenantId,session.projectId],tx),caseIds=cases.filter(row=>caseContract(row).sources.some(source=>source.receiptId===receiptId)).map(row=>row.id);
    const history=await query<{id:string;kind:string;detail:string;created_at:Date}>("SELECT id,kind,data->>'detail' detail,created_at FROM fp_funding_case_events WHERE tenant_id=$1 AND project_id=$2 AND data->>'receiptId'=$3 ORDER BY created_at,id",[session.tenantId,session.projectId,receiptId],tx);
    return{receiptId,receiptVersion:basis.source.version,referenceSuffix:receipt.actualProviderPaymentRef.slice(-8),originalPackageId:receipt.packageId,originalTitle:basis.origin?.title??`Original purpose: ${receipt.packageId}`,provenance:session.mode,digest:basis.digest,observedAt:new Date().toISOString(),heldMinor:basis.heldMinor,availableMinor:basis.positions.reduce((sum,position)=>sum+position.availableMinor,0),paidMinor:basis.positions.reduce((sum,position)=>sum+position.paidMinor,0),pendingReturnMinor:receipt.pendingAttributedRefundReserveMinor,alreadyReturnedMinor:receipt.completedAttributedRefundMinor,
      observation:basis.observation&&basis.observationRow?{id:basis.observationRow.id,digest:basis.observationRow.digest,observedAt:basis.observation.evidence.observedAt,historyComplete:basis.observation.evidence.historyComplete,captureStatus:basis.observation.evidence.captureStatus,returns:basis.observation.evidence.refunds.map(refund=>({referenceSuffix:refund.id.slice(-8),amountMinor:refund.amountMinor,state:refund.status.toLowerCase(),recorded:basis.known.hashes.has(sha256(refund.id))}))}:null,
      attributableMinor:basis.amountMinor,releasableMinor:Math.max(0,basis.heldMinor-basis.amountMinor),blockers:basis.blockers,canObserve:["organizer","donor"].includes(session.role),canReconcile:session.role==="organizer"&&!basis.blockers.length,hasHold:!!basis.hold,caseIds,history:history.map(row=>({id:row.id,kind:row.kind,detail:row.detail,createdAt:row.created_at.toISOString()}))};
  });await requireCurrentRole(session,session.role);return result;
}

/** Provider reads are explicit; no refund is dispatched by inspection. */
export async function observeOriginalReturns(session:Session,raw:z.infer<typeof observeReturnsSchema>,provider?:ProviderAdapter):Promise<{id:string}>{
  const input=observeReturnsSchema.parse(raw);await initializeDatabase();
  if(!["organizer","donor"].includes(session.role))throw new DomainError("ROLE_DENIED","The Auditor can inspect recorded evidence; a donor or organizer must deliberately request a fresh original-route observation.",403);
  const initial=await database().transaction(async tx=>{const {journal,source}=await authorizedSource(session,input.receiptId,tx),prior=await actionResult(tx,session,input.intentId,"observe_original_returns",input);if(prior)return{prior};if(source.version!==input.expectedVersion)throw new DomainError("RETURN_SOURCE_CHANGED","Refresh the current receipt version before reading its original returns.");const [hold]=await query<HoldRow>("SELECT * FROM fp_funding_return_holds WHERE receipt_id=$1 AND state='held'",[input.receiptId],tx),[previous]=await query<ObservationRow>("SELECT * FROM fp_funding_return_observations WHERE receipt_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",[input.receiptId],tx);return{source,sourceDigest:fundingSourceDigest(journal,input.receiptId),hold:hold?holdContract(hold):null,previous:previous?observationContract(previous):null};});
  if(initial.prior)return initial.prior;
  let evidence:OriginalReturnEvidence;
  if(session.mode==="sample"){
    if(input.references.length)throw new DomainError("SAMPLE_REFERENCES_ONLY","Sample observations use fictional references already saved in this workspace.");
    if(input.sampleReturnMinor&&session.role!=="organizer")throw new DomainError("ROLE_DENIED","Only the organizer can add a labelled fictional outside-return observation.",403);
    const refunds=structuredClone(initial.previous?.evidence.refunds??[]),receipt=initial.source!.receipt;
    if(input.sampleReturnMinor)refunds.push({id:`sample-outside-return:${randomUUID()}`,status:"COMPLETED",amountMinor:input.sampleReturnMinor,captureId:receipt.provenRefundableRef??receipt.actualProviderPaymentRef});
    const total=refunds.filter(refund=>["COMPLETED","PENDING"].includes(refund.status)).reduce((sum,refund)=>sum+refund.amountMinor,0);if(total>receipt.grossSettledMinor)throw new DomainError("SAMPLE_RETURN_CAPACITY","The fictional return total exceeds the original Sample payment.");
    evidence={schemaVersion:VERSION,provenance:"sample",captureId:receipt.provenRefundableRef??receipt.actualProviderPaymentRef,captureStatus:total===receipt.grossSettledMinor?"REFUNDED":total?"PARTIALLY_REFUNDED":"COMPLETED",capturedMinor:receipt.grossSettledMinor,currency:"USD",observedAt:new Date().toISOString(),historyComplete:true,owningOrderId:receipt.sourceOrderId??null,refunds};
  }else{
    if(input.sampleReturnMinor)throw new DomainError("SAMPLE_OBSERVATION_FORBIDDEN","A Live source requires independent provider evidence; typed amounts cannot create financial facts.");
    const {readOriginalReturnEvidence}=await import("./refunds"),{paypalProvider}=await import("./payments");evidence=await readOriginalReturnEvidence(initial.source!.receipt,provider??paypalProvider(),[...new Set([...input.references,...(initial.hold?.providerIds??[])])]);
  }
  return database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);const member=await requireCurrentRole(session,session.role,tx),prior=await actionResult(tx,session,input.intentId,"observe_original_returns",input);if(prior)return prior;
    const before=await authorizedSource(session,input.receiptId,tx);if(before.source.version!==input.expectedVersion||fundingSourceDigest(before.journal,input.receiptId)!==initial.sourceDigest)throw new DomainError("RETURN_SOURCE_CHANGED","The receipt changed while its original returns were read. Refresh and repeat the read; no return was sent.");
    const known=await knownReturns(session,input.receiptId,tx),unknown=evidence.refunds.filter(refund=>!known.hashes.has(sha256(refund.id))&&["COMPLETED","PENDING"].includes(refund.status)),consumed=evidence.refunds.filter(refund=>["COMPLETED","PENDING"].includes(refund.status)).reduce((sum,refund)=>sum+refund.amountMinor,0);
    if(unknown.length||["REFUNDED","PARTIALLY_REFUNDED"].includes(evidence.captureStatus)&&!evidence.historyComplete)await recordExternalReturnHold(tx,session,input.receiptId,unknown.map(refund=>refund.id),evidence.captureStatus==="REFUNDED"?Math.max(consumed,evidence.capturedMinor):consumed);
    const after=await authorizedSource(session,input.receiptId,tx),id=randomUUID(),value:ReturnObservationContract={schemaVersion:VERSION,id,tenantId:session.tenantId,projectId:session.projectId,receiptId:input.receiptId,receiptVersion:after.source.version,sourceDigest:fundingSourceDigest(after.journal,input.receiptId),evidence,createdBy:session.actorId,membershipVersion:member.membershipVersion,createdAt:new Date().toISOString()};
    await tx.query("INSERT INTO fp_funding_return_observations(id,tenant_id,project_id,receipt_id,receipt_version,digest,encrypted_data,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,session.tenantId,session.projectId,input.receiptId,value.receiptVersion,sha256(canonicalJson(value)),sealPrivate(value,observationContext(session,id)),session.actorId]);
    const cases=await query<CaseRow>("SELECT * FROM fp_funding_cases WHERE tenant_id=$1 AND project_id=$2 AND state<>'superseded'",[session.tenantId,session.projectId],tx);for(const row of cases.filter(row=>caseContract(row).sources.some(source=>source.receiptId===input.receiptId)))await caseEvent(tx,session,row.id,session.actorId,"original_return_observed",session.mode==="sample"?"A labelled fictional outside-return observation was saved for this Sample source. No provider was called.":"The original capture and individual return resources were independently read. This inspection did not send a financial return.",{receiptId:input.receiptId,observationId:id});
    await saveAction(tx,session,input.intentId,"observe_original_returns",input,{id});return{id};
  });
}

async function restoreHeldPolicies(tx:SqlConnection,session:Session,hold:ReturnHoldContract){
  const {refreshPurposeFunding}=await import("./purpose-pledges"),scope=scopeOf(session);
  for(const previous of hold.policies.filter(policy=>["open","funded"].includes(policy.state))){
    const {row,value}=await savedFundingPolicy(session,previous.id,tx);if(row.state!=="review_required")continue;
    const [pkg]=await query<{version:number;budget_minor:string;data:{title:string;description:string;fundingState:string}}>("SELECT version,budget_minor,data FROM fp_packages WHERE project_id=$1 AND id=$2",[session.projectId,previous.packageId],tx);if(!pkg||["cancelled","compensating"].includes(pkg.data.fundingState)||pkg.version!==value.packageVersion||pkg.data.title!==value.title||pkg.data.description!==value.purpose||Number(pkg.budget_minor)!==value.budgetMinor)continue;
    let owner;try{owner=await requireMembership(session.tenantId,session.projectId,value.createdBy,"organizer",tx);}catch(error){if(error instanceof DomainError)continue;throw error;}if(owner.version!==value.membershipVersion)continue;
    const journal=await readFundingJournal(scope,tx),projection=projectFundingPositions(journal,scope);if(projection.positions.some(position=>position.packageId===value.packageId&&(position.excludedMinor>0||position.pendingRefundMinor>0)))continue;
    const eligible=projection.positions.filter(position=>position.packageId===value.packageId).reduce((sum,position)=>sum+position.collectedMinor-position.excludedMinor-position.pendingRefundMinor,0);
    if(eligible>value.budgetMinor)continue;
    try{if(eligible)assertCurrentFundingLots(projectFundingLots(journal,scope,await readFundingOrigins(scope,tx)),value.packageId,value.packageVersion);await assertCommittedFundingChoices(scope,journal.assignments,tx);}catch(error){if(error instanceof DomainError)continue;throw error;}
    if(row.expires_at.getTime()<=Date.now()&&eligible<value.budgetMinor){await tx.query("UPDATE fp_funding_policies SET state='expired' WHERE id=$1",[row.id]);await tx.query("UPDATE fp_collection_rounds SET state='expired' WHERE id=$1",[value.roundId]);continue;}
    const state=eligible===value.budgetMinor?"funded":"open";
    await tx.query("UPDATE fp_funding_policies SET state=$2 WHERE id=$1",[row.id,state]);await tx.query("UPDATE fp_collection_rounds SET state=$2 WHERE id=$1",[value.roundId,state==="funded"?"funded":"allocation_open"]);await tx.query("UPDATE fp_packages SET data=jsonb_set(data,'{fundingState}',$3::jsonb) WHERE project_id=$1 AND id=$2",[session.projectId,value.packageId,JSON.stringify(state)]);await refreshPurposeFunding(tx,scope,row.id);
  }
}
export async function reconcileOriginalReturns(session:Session,raw:z.infer<typeof reconcileReturnsSchema>):Promise<{id:string}>{
  const input=reconcileReturnsSchema.parse(raw);return database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);const member=await requireCurrentRole(session,"organizer",tx),prior=await actionResult(tx,session,input.intentId,"reconcile_original_returns",input);if(prior)return prior;
    const basis=await returnBasis(session,input.receiptId,tx);
    if(basis.source.version!==input.expectedVersion||basis.digest!==input.reviewDigest||basis.observationRow?.id!==input.observationId||basis.observationRow.digest!==input.observationDigest)throw new DomainError("RETURN_REVIEW_CHANGED","The source, expense position or provider evidence changed. Inspect the exact current review before recording attribution.");
    if(basis.blockers.length)throw new DomainError("RETURN_ATTRIBUTION_UNPROVEN",basis.blockers[0].detail);
    const hold=basis.hold!,holdRow=basis.holdRow!,observation=basis.observation!,receipt=basis.source.receipt,id=randomUUID(),createdAt=new Date().toISOString();
    const contract:ReturnAttributionContract={schemaVersion:VERSION,id,tenantId:session.tenantId,projectId:session.projectId,provenance:session.mode,kind:"return_attribution",receiptId:receipt.id,receiptVersion:basis.source.version,sourceDigest:basis.sourceDigest,observationId:input.observationId,observationDigest:input.observationDigest,holdId:hold.id,holdDigest:holdRow.digest,reviewDigest:basis.digest,packageId:receipt.packageId,originalPackageVersion:basis.origin!.packageVersion,amountMinor:basis.amountMinor,releasedMinor:basis.heldMinor,returns:basis.eligibleReturns.map(refund=>({id:refund.id,amountMinor:refund.amountMinor})),reason:input.reason,createdBy:session.actorId,membershipVersion:member.membershipVersion,createdAt};
    const digest=sha256(canonicalJson(contract));await tx.query("INSERT INTO fp_funding_reconciliations(id,tenant_id,project_id,kind,receipt_id,state,digest,encrypted_data,created_by,membership_version,expires_at,applied_at) VALUES($1,$2,$3,'return_attribution',$4,'applied',$5,$6,$7,$8,$9,clock_timestamp())",[id,session.tenantId,session.projectId,receipt.id,digest,sealPrivate(contract,reconciliationContext(session,id)),session.actorId,member.membershipVersion,new Date(Date.parse(observation.evidence.observedAt)+5*60_000)]);
    const next=structuredClone(receipt);next.completedAttributedRefundMinor+=basis.amountMinor;next.excludedMinor-=basis.heldMinor;
    const deltas=hold.positions.map(position=>({packageId:position.packageId,excludedMinor:-position.amountMinor,refundedMinor:position.packageId===receipt.packageId?basis.amountMinor:0}));
    if(basis.amountMinor&&!deltas.some(delta=>delta.packageId===receipt.packageId))deltas.push({packageId:receipt.packageId,excludedMinor:0,refundedMinor:basis.amountMinor});
    const version=await persistFundingReceipt(tx,scopeOf(session),{version:basis.source.version,data:receipt},next,deltas);
    for(const refund of basis.eligibleReturns){
      if((await query("SELECT id FROM fp_refunds WHERE provider_refund_hash=$1 UNION ALL SELECT id FROM fp_funding_external_returns WHERE provider_refund_hash=$1",[sha256(refund.id)],tx)).length)throw new DomainError("RETURN_ALREADY_RECORDED","This exact provider return is already recorded. Reload its original history.");
      const entryId=randomUUID(),value={schemaVersion:VERSION,id:entryId,tenantId:session.tenantId,projectId:session.projectId,receiptId:receipt.id,reconciliationId:id,providerRefundId:refund.id,amountMinor:refund.amountMinor,packageId:receipt.packageId,originalPackageVersion:basis.origin!.packageVersion,provenance:session.mode,observedAt:observation.evidence.observedAt,observationId:input.observationId,receiptVersion:version};
      await tx.query("INSERT INTO fp_funding_external_returns(id,tenant_id,project_id,receipt_id,reconciliation_id,provider_refund_hash,amount_minor,digest,encrypted_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[entryId,session.tenantId,session.projectId,receipt.id,id,sha256(refund.id),refund.amountMinor,sha256(canonicalJson(value)),sealPrivate(value,externalContext(session,entryId))]);
      const entries=[{account:"package_funds",side:"debit" as const,amountMinor:refund.amountMinor},{account:session.mode==="sample"?"sample_clearing":"paypal_clearing",side:"credit" as const,amountMinor:refund.amountMinor}];assertBalanced(entries);for(const entry of entries)await tx.query("INSERT INTO fp_journal(id,tenant_id,project_id,receipt_id,account,side,amount_minor,currency,operation_id,entry_kind) VALUES($1,$2,$3,$4,$5,$6,$7,'USD',$8,'external_refund_reconciliation')",[randomUUID(),session.tenantId,session.projectId,receipt.id,entry.account,entry.side,entry.amountMinor,id]);
    }
    await tx.query("UPDATE fp_funding_return_holds SET state='released',released_by=$2,released_at=clock_timestamp() WHERE id=$1",[hold.id,id]);
    const {refreshPurposePledge}=await import("./purpose-pledges");await refreshPurposePledge(tx,scopeOf(session),receipt.donorObligationId);const {refreshSponsorsForScope}=await import("./sponsors");await refreshSponsorsForScope(tx,session);
    const cases=await query<CaseRow>("SELECT * FROM fp_funding_cases WHERE tenant_id=$1 AND project_id=$2 AND state<>'superseded' ORDER BY id",[session.tenantId,session.projectId],tx);
    for(const row of cases.filter(row=>caseContract(row).sources.some(source=>source.receiptId===receipt.id))){
      await caseEvent(tx,session,row.id,session.actorId,"outside_return_reconciled",session.mode==="sample"?"The fictional Sample outside return was attributed to its proven original purpose. Only this review hold’s exclusion was released; the original payment, paid uses and prior decisions remain unchanged.":"Independently observed returns were attributed to the proven original purpose. Only this review hold’s exclusion was released; the original payment, paid uses and prior decisions remain unchanged.",{receiptId:receipt.id,reconciliationId:id,attributedMinor:basis.amountMinor,releasedMinor:basis.heldMinor,receiptVersion:version});
      const pending=await query("SELECT id FROM fp_funding_choices WHERE case_id=$1 AND state IN ('executing','return_pending')",[row.id],tx);
      if(!pending.length){const review=await cancellationCaseSnapshot(session,row.package_id,tx);if(review.packageVersion===row.package_version&&review.state==="cancelled")await reviseCancellationCase(tx,session,row,review,{id,digest,kind:"return_attribution"});}
    }
    await restoreHeldPolicies(tx,session,hold);
    await appendEvent(tx,session,"funding.return_reconciled","An original return has a complete record","The observed return, exact source version, current-purpose deductions and released review hold are linked. No new financial return was sent and no paid expense was reassigned.");await saveAction(tx,session,input.intentId,"reconcile_original_returns",input,{id});return{id};
  });
}
