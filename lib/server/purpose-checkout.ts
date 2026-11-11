import { randomUUID } from "node:crypto";
import { canonicalJson, payloadHash, sha256, type AuthorizationDecision, type PaymentAction, type PaymentCommand, type PaymentCore, type PaymentOperation, type ProviderAdapter } from "@fracture/paypal-core";
import { z } from "zod";
import type { ApprovalRecord } from "../contracts";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { projectClaimLock } from "./claims";
import { database, query } from "./db";
import { lockFundingScope } from "./funding-positions";
import { requireCurrentRole } from "./membership";
import { applicationOrigin, ingestOwnedOrderRead, ingestPaymentOperation, paymentCore, paymentStore, paymentView, paypalProvider } from "./payments";
import { ownedPledge, pledgeContract } from "./purpose-store";
import { validateCurrentPledge } from "./purpose-pledges";
import { appendEvent } from "./repository";
import { readPaymentCommand } from "./stored-commands";

export const purposeCheckoutSchema=z.object({pledgeId:z.string().min(1).max(160),digest:z.string().regex(/^[a-f0-9]{64}$/),expectedVersion:z.number().int().positive(),action:z.enum(["create","capture","check","retry"]),orderId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),acknowledged:z.literal(true)}).strict();
export interface PurposeCheckoutDependencies {core:PaymentCore;provider:ProviderAdapter}
export function purposeCheckoutEnabled(){return process.env.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED==="true"&&process.env.FIELDPROOF_PROVIDER_ACCESS!=="disabled";}
function dependencies():PurposeCheckoutDependencies{if(!purposeCheckoutEnabled())throw new DomainError("PURPOSE_CHECKOUT_QUALIFICATION","Buyer-present checkout for these new purposes awaits this deployment's sandbox qualification. Your saved pledge is not a payment.",503);return{core:paymentCore(),provider:paypalProvider()};}
const policyHash=(pledgeDigest:string)=>sha256(`Fieldproof:purpose-buyer-present:v1:${pledgeDigest}`);

async function commandForPurpose(session:Session,input:z.infer<typeof purposeCheckoutSchema>):Promise<PaymentCommand>{
  return database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);await requireCurrentRole(session,"donor",tx);
    const row=await ownedPledge(session,input.pledgeId,tx),value=pledgeContract(row);
    if(row.donor_actor_id!==session.actorId)throw new DomainError("PLEDGE_NOT_FOUND","Only your own pledge can open checkout.",404);
    if(row.digest!==input.digest||row.version!==input.expectedVersion)throw new DomainError("PLEDGE_VERSION_CHANGED","Review this exact pledge before checkout.");
    const kind=input.action==="capture"?"capture":"create",businessKey=`purpose:${row.id}:${kind}`;
    const [existing]=await query<{command:PaymentCommand}>("SELECT command FROM fp_payment_commands WHERE tenant_id=$1 AND project_id=$2 AND business_key=$3",[session.tenantId,session.projectId,businessKey],tx);
    if(existing){const command=readPaymentCommand(existing.command);if(kind==="capture"&&(command.action.kind!=="capture_order"||command.action.orderId!==input.orderId))throw new DomainError("PLEDGE_ORDER_CHANGED","This pledge already has a different original capture command.");return command;}
    await validateCurrentPledge(session,row,tx);
    if(session.mode!=="live_sandbox")throw new DomainError("LIVE_PLEDGE_REQUIRED","Sample support uses its labelled sample settlement action.");
    if(kind==="capture"){
      if(!input.orderId)throw new DomainError("PLEDGE_ORDER_REQUIRED","Return from the original checkout before completing the contribution.");
      const [order]=await query<{order_id:string}>("SELECT order_id FROM fp_provider_orders WHERE order_id=$1 AND tenant_id=$2 AND project_id=$3 AND obligation_id=$4",[input.orderId,session.tenantId,session.projectId,value.obligationId],tx);
      if(!order)throw new DomainError("ORDER_NOT_OWNED","That order is outside this exact pledge.",403);
    }
    const approval:ApprovalRecord={id:randomUUID(),tenantId:session.tenantId,actorId:session.actorId,operation:kind==="create"?"create_order":"capture_order",resourceId:value.obligationId,resourceVersion:row.version,amountMinor:value.amountMinor,currency:"USD",recipientVersion:null,policyHash:policyHash(row.digest),digest:"",expiresAt:new Date(Math.min(Date.now()+30*60_000,row.expires_at.getTime())).toISOString(),revokedAt:null};
    approval.digest=sha256(canonicalJson({...approval,digest:undefined}));
    const action:PaymentAction=kind==="create"?{kind:"create_order",money:{currency:"USD",minor:value.amountMinor},intent:"CAPTURE",customId:value.obligationId,experience:{returnUrl:`${applicationOrigin()}/funding?pledge=${encodeURIComponent(row.id)}&checkout=returned`,cancelUrl:`${applicationOrigin()}/funding?pledge=${encodeURIComponent(row.id)}&checkout=cancelled`,userAction:"PAY_NOW",shippingPreference:"NO_SHIPPING",brandName:"Fieldproof sandbox"}}:{kind:"capture_order",money:{currency:"USD",minor:value.amountMinor},orderId:input.orderId!};
    const command:PaymentCommand={scope:{tenantId:session.tenantId,projectId:session.projectId},operationId:randomUUID(),businessKey,intentId:value.obligationId,providerRequestId:randomUUID(),payloadHash:payloadHash(action),action,approval:{id:approval.id,version:approval.resourceVersion,digest:approval.digest,expiresAt:approval.expiresAt}};
    await tx.query("INSERT INTO fp_approval_records(id,tenant_id,project_id,actor_id,resource_id,resource_version,digest,expires_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",[approval.id,session.tenantId,session.projectId,session.actorId,value.obligationId,row.version,approval.digest,approval.expiresAt,JSON.stringify(approval)]);
    await tx.query("INSERT INTO fp_payment_commands(operation_id,tenant_id,project_id,obligation_id,session_id,business_key,payload_hash,command) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",[command.operationId,session.tenantId,session.projectId,value.obligationId,session.id,businessKey,command.payloadHash,JSON.stringify(command)]);
    await tx.query("UPDATE fp_purpose_pledges SET state='checkout',operation_id=$2,last_code=NULL WHERE id=$1",[row.id,command.operationId]);
    await appendEvent(tx,session,"funding.checkout_approved",kind==="create"?"The supporter opened an exact checkout":"The supporter is completing the original checkout","The saved amount, purpose and original provider request are fixed. A callback or repeated click cannot create another contribution.");return command;
  });
}

/** Core calls this again immediately before dispatch. The immutable command and
 * current donor, sponsor, purpose, deadline and owned Order all have to agree. */
export async function authorizePurposePayment(command:PaymentCommand):Promise<AuthorizationDecision>{
  const deny=(reason:string):AuthorizationDecision=>({allowed:false,reason,resourceIds:[],currency:"USD",maximumMinor:0,approvalId:command.approval.id,approvalVersion:command.approval.version,approvalDigest:command.approval.digest});
  if(!purposeCheckoutEnabled())return deny("Buyer-present checkout for new purposes is not qualified on this deployment.");
  try{return await database().transaction(async tx=>{
    await projectClaimLock(tx,command.scope.projectId);await lockFundingScope(command.scope,tx);
    const [stored]=await query<{command:PaymentCommand;pledge_id:string;session_id:string;actor_id:string;role:Session["role"];expires_at:Date;mode:Session["mode"];approval:ApprovalRecord;revoked_at:Date|null;approval_expires:Date;approval_digest:string}>(
      `SELECT pc.command,p.id pledge_id,pc.session_id,s.actor_id,s.role,s.expires_at,t.mode,a.data approval,a.revoked_at,a.expires_at approval_expires,a.digest approval_digest
       FROM fp_payment_commands pc JOIN fp_purpose_pledges p ON p.obligation_id=pc.obligation_id AND p.tenant_id=pc.tenant_id AND p.project_id=pc.project_id
       JOIN fp_sessions s ON s.id=pc.session_id JOIN fp_tenants t ON t.id=pc.tenant_id JOIN fp_approval_records a ON a.id=(pc.command->'approval'->>'id')
       WHERE pc.operation_id=$1 AND pc.tenant_id=$2 AND pc.project_id=$3`,[command.operationId,command.scope.tenantId,command.scope.projectId],tx);
    if(!stored||stored.mode!=="live_sandbox"||!["create_order","capture_order"].includes(command.action.kind))return deny("No current owned buyer-present pledge approval exists.");
    const session:Session={...command.scope,id:stored.session_id,actorId:stored.actor_id,role:stored.role,mode:stored.mode,expiresAt:stored.expires_at.toISOString()},row=await ownedPledge(session,stored.pledge_id,tx),{value}=await validateCurrentPledge(session,row,tx);
    const approval=stored.approval;
    if(canonicalJson(readPaymentCommand(stored.command))!==canonicalJson(command)||payloadHash(command.action)!==command.payloadHash||stored.revoked_at||stored.approval_expires.getTime()<=Date.now()||approval.digest!==stored.approval_digest||approval.digest!==command.approval.digest||approval.resourceId!==value.obligationId||approval.resourceVersion!==value.version||approval.actorId!==value.donorActorId||approval.policyHash!==policyHash(row.digest)||command.action.money.currency!=="USD"||command.action.money.minor!==value.amountMinor)return deny("The exact pledge payment command or approval changed.");
    const resourceIds:string[]=[];
    if(command.action.kind==="capture_order"){
      const [order]=await query<{order_id:string}>("SELECT order_id FROM fp_provider_orders WHERE order_id=$1 AND tenant_id=$2 AND project_id=$3 AND obligation_id=$4",[command.action.orderId,session.tenantId,session.projectId,value.obligationId],tx);if(!order)return deny("The original Order does not belong to this pledge.");resourceIds.push(order.order_id);
    }else if(command.action.kind==="create_order"&&(command.action.customId!==value.obligationId||command.action.savedWallet||command.action.saveWalletOnSuccess))return deny("Only the original buyer-present pledge checkout is approved.");
    return{allowed:true,reason:"Exact current buyer-present purpose pledge",resourceIds,currency:"USD",maximumMinor:value.amountMinor,approvalId:approval.id,approvalVersion:approval.resourceVersion,approvalDigest:approval.digest,checkoutOrigins:[applicationOrigin()]};
  });}catch(error){if(error instanceof DomainError)return deny(error.message);throw error;}
}
async function recordPurposeOperation(session:Session,pledgeId:string,operation:PaymentOperation){
  await ingestPaymentOperation(operation);
  await database().transaction(async tx=>{await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);
    const row=await ownedPledge(session,pledgeId,tx);if(Number(row.collected_minor)>=Number(row.amount_minor)||["returned","partially_collected","cancelled","withdrawn","held","expired"].includes(row.state))return;
    if(row.operation_id&&row.operation_id!==operation.command.operationId&&operation.command.action.kind==="create_order"){
      const [current]=await query<{command:PaymentCommand}>("SELECT command FROM fp_payment_commands WHERE operation_id=$1 AND tenant_id=$2 AND project_id=$3",[row.operation_id,session.tenantId,session.projectId],tx);
      if(current&&readPaymentCommand(current.command).action.kind==="capture_order")return;
    }
    const order=operation.receipt?.resources.find(resource=>resource.kind==="order");
    const state=operation.status==="pending_reconciliation"?"unknown":operation.status==="refused"?"refused":operation.status==="not_sent"?"not_sent":operation.status==="succeeded"&&operation.command.action.kind==="create_order"?order?.status==="APPROVED"?"ready_capture":"buyer_action":"checkout";
    await tx.query("UPDATE fp_purpose_pledges SET state=$2,operation_id=$3,last_code=$4 WHERE id=$1",[row.id,state,operation.command.operationId,operation.error?.kind??null]);
  });
}
export async function purposeCheckout(session:Session,raw:z.infer<typeof purposeCheckoutSchema>,injected?:PurposeCheckoutDependencies){
  const input=purposeCheckoutSchema.parse(raw);await requireCurrentRole(session,"donor");
  const row=await ownedPledge(session,input.pledgeId,database());if(row.donor_actor_id!==session.actorId)throw new DomainError("PLEDGE_NOT_FOUND","This pledge belongs to another supporter.",404);
  if(row.digest!==input.digest||row.version!==input.expectedVersion)throw new DomainError("PLEDGE_VERSION_CHANGED","Reload the exact saved pledge.");
  if(session.mode!=="live_sandbox")throw new DomainError("LIVE_PLEDGE_REQUIRED","Use the clearly labelled Sample contribution action in this workspace.");
  const deps=injected??dependencies();
  if(input.action==="check"||input.action==="retry"){
    if(!row.operation_id)throw new DomainError("PLEDGE_NOT_STARTED","This pledge has no provider operation to check.");
    const prior=await paymentStore().get(session,row.operation_id);
    let operation:PaymentOperation;
    if(!prior){
      if(input.action!=="retry")throw new DomainError("PLEDGE_NOT_DISPATCHED","The original checkout was saved before dispatch. Retry that same saved operation to continue.");
      const [saved]=await query<{command:PaymentCommand}>("SELECT command FROM fp_payment_commands WHERE operation_id=$1 AND tenant_id=$2 AND project_id=$3 AND obligation_id=$4",[row.operation_id,session.tenantId,session.projectId,row.obligation_id]);
      if(!saved)throw new DomainError("PLEDGE_ORIGINAL_MISSING","The original saved checkout needs review before it can continue.");
      operation=await deps.core.execute(readPaymentCommand(saved.command),AbortSignal.timeout(25_000));
    }else operation=input.action==="retry"?await deps.core.retry(session,row.operation_id):await deps.core.reconcile(session,row.operation_id);
    await recordPurposeOperation(session,row.id,operation);
    const orderId=paymentView(operation).orderId;
    if(orderId&&input.action==="check"){
      const resources=await deps.provider.read("order",orderId,AbortSignal.timeout(15_000));await ingestOwnedOrderRead(orderId,resources);
      const [latest]=await query<{state:string}>("SELECT state FROM fp_purpose_pledges WHERE id=$1",[row.id]);
      const order=resources.find(resource=>resource.kind==="order");if(order?.status==="APPROVED"&&latest.state!=="collected")await query("UPDATE fp_purpose_pledges SET state='ready_capture' WHERE id=$1 AND state NOT IN ('collected','returned','withdrawn','held')",[row.id]);
    }
    operation=(await paymentStore().get(session,row.operation_id))??operation;return paymentView(operation);
  }
  if(input.action==="capture"){
    if(!input.orderId)throw new DomainError("PLEDGE_ORDER_REQUIRED","Choose the original order after buyer approval.");
    const owned=await query("SELECT order_id FROM fp_provider_orders WHERE order_id=$1 AND tenant_id=$2 AND project_id=$3 AND obligation_id=$4",[input.orderId,session.tenantId,session.projectId,row.obligation_id]);if(!owned.length)throw new DomainError("ORDER_NOT_OWNED","That order does not belong to this pledge.",403);
    const resources=await deps.provider.read("order",input.orderId,AbortSignal.timeout(15_000));await ingestOwnedOrderRead(input.orderId,resources);
    if(resources.some(resource=>resource.kind==="capture"&&resource.status==="COMPLETED")){
      if(!row.operation_id)throw new DomainError("PLEDGE_ORIGINAL_MISSING","Reconcile the original captured payment.");const saved=await paymentStore().get(session,row.operation_id);if(!saved)throw new DomainError("PLEDGE_ORIGINAL_MISSING","Reconcile the original captured payment.");return paymentView(saved);
    }
    if(!resources.some(resource=>resource.kind==="order"&&resource.id===input.orderId&&resource.status==="APPROVED"))throw new DomainError("BUYER_APPROVAL_REQUIRED","PayPal has not confirmed approval of this exact original order.");
  }
  const command=await commandForPurpose(session,input),existing=await paymentStore().get(session,command.operationId);
  // Reload/repetition is an observation. Only the explicit retry action can
  // dispatch a positively refused or never-sent original again.
  const operation=existing??await deps.core.execute(command,AbortSignal.timeout(25_000));await recordPurposeOperation(session,row.id,operation);return paymentView(operation);
}
