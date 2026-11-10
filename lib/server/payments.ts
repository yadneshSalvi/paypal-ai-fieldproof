import { randomUUID } from "node:crypto";
import {
  PaymentCore, SandboxPayPalProvider, SqlPaymentStore, canonicalJson, payloadHash, sha256,
  type AuthorizationDecision, type PaymentAction, type PaymentCommand, type PaymentOperation, type ProviderResource,
} from "@fracture/paypal-core";
import type { ApprovalRecord, SettlementReceipt } from "../contracts";
import { assertBalanced, DomainError, splitSettlement, validateReceipt } from "../domain/money";
import type { Session } from "./auth";
import { database, initializeDatabase, query } from "./db";
import { appendEvent } from "./repository";

export const CHECKOUT_TEST_MINOR = 100;
const GLOBAL_TEST_CEILING_MINOR = 5000;
const policyHash = sha256("Fieldproof:explicit-buyer-present-sandbox-checkout:v1:USD100:session500:global5000");
export function applicationOrigin(): string {
  const value = process.env.APP_URL ?? (process.env.VERCEL ? "https://paypal-ai-fieldproof.vercel.app" : "http://localhost:4102");
  if (!["http://localhost:4102","https://paypal-ai-fieldproof.vercel.app"].includes(value)) throw new Error("Fieldproof APP_URL must match a registered application origin.");
  return value;
}
export function providerConfiguration() {
  if (process.env.PAYPAL_ENVIRONMENT !== "sandbox" || process.env.PAYPAL_PROJECT_ISOLATED !== "true") throw new DomainError("PAYPAL_NOT_ISOLATED","This sandbox connection has not passed its isolation check.",503);
  const clientId = process.env.PAYPAL_CLIENT_ID, clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if(!clientId || !clientSecret) throw new DomainError("PAYPAL_NOT_CONFIGURED","The sandbox payment connection is not configured.",503);
  return {environment:"sandbox" as const,baseUrl:process.env.PAYPAL_API_BASE_URL ?? "https://api-m.sandbox.paypal.com",clientId,clientSecret,isolatedProject:"fieldproof"};
}
const runtime = globalThis as typeof globalThis & {fieldproofProvider?:SandboxPayPalProvider};
export function paypalProvider(): SandboxPayPalProvider { return runtime.fieldproofProvider ??= new SandboxPayPalProvider(providerConfiguration()); }
function deny(command:PaymentCommand, reason:string):AuthorizationDecision {
  return {allowed:false,reason,resourceIds:[],currency:"USD",maximumMinor:0,approvalId:command.approval.id,approvalVersion:command.approval.version,approvalDigest:command.approval.digest};
}
export async function authorizePayment(command: PaymentCommand): Promise<AuthorizationDecision> {
  const [row] = await query<{
    command:PaymentCommand;session_role:string;session_expires:Date;session_revoked:Date|null;
    actor_id:string;tenant_id:string;project_id:string;obligation_version:number;amount_minor:string;
    approval_data:ApprovalRecord;approval_revoked:Date|null;approval_expires:Date;mode:string;
  }>(`SELECT c.command,c.tenant_id,c.project_id,s.role session_role,s.expires_at session_expires,s.revoked_at session_revoked,
    s.actor_id,o.version obligation_version,o.amount_minor,a.data approval_data,a.revoked_at approval_revoked,a.expires_at approval_expires,t.mode
    FROM fp_payment_commands c JOIN fp_sessions s ON s.id=c.session_id JOIN fp_obligations o ON o.id=c.obligation_id
    JOIN fp_approval_records a ON a.id=(c.command->'approval'->>'id') JOIN fp_tenants t ON t.id=c.tenant_id
    WHERE c.operation_id=$1 AND c.tenant_id=$2 AND c.project_id=$3`,[command.operationId,command.scope.tenantId,command.scope.projectId]);
  if(!row) return deny(command,"No owned payment authority exists.");
  const approval=row.approval_data;
  if(row.mode!=="live_sandbox" || row.session_role!=="donor" || row.session_revoked || row.session_expires.getTime()<=Date.now()) return deny(command,"Current donor session authority is required.");
  if(row.approval_revoked || row.approval_expires.getTime()<=Date.now() || approval.resourceVersion!==row.obligation_version || approval.actorId!==row.actor_id) return deny(command,"The payment approval is expired, revoked or changed.");
  if(canonicalJson(row.command)!==canonicalJson(command) || payloadHash(command.action)!==command.payloadHash || approval.digest!==command.approval.digest || approval.policyHash!==policyHash) return deny(command,"The exact approved command has changed.");
  if(command.action.money.currency!=="USD" || command.action.money.minor!==Number(row.amount_minor) || command.action.money.minor!==CHECKOUT_TEST_MINOR) return deny(command,"The approved test amount does not match.");
  const resourceIds:string[]=[];
  if(command.action.kind==="capture_order"){
    const owned=await query("SELECT order_id FROM fp_provider_orders WHERE order_id=$1 AND tenant_id=$2 AND project_id=$3 AND obligation_id=$4",[command.action.orderId,command.scope.tenantId,command.scope.projectId,approval.resourceId]);
    if(!owned.length) return deny(command,"This order does not belong to the approved obligation.");
    resourceIds.push(command.action.orderId);
  } else if(command.action.kind!=="create_order") return deny(command,"This approval does not authorize that financial operation.");
  return {allowed:true,reason:"Current exact donor approval",resourceIds,currency:"USD",maximumMinor:CHECKOUT_TEST_MINOR,approvalId:approval.id,approvalVersion:approval.resourceVersion,approvalDigest:approval.digest,checkoutOrigins:[applicationOrigin()]};
}
export function paymentCore(): PaymentCore { return new PaymentCore({store:new SqlPaymentStore(database()),provider:paypalProvider(),policy:{authorize:authorizePayment}}); }

export async function commandFor(session:Session, intentId:string, kind:"create"|"capture", orderId?:string):Promise<PaymentCommand> {
  if(session.mode!=="live_sandbox" || session.role!=="donor") throw new DomainError("ROLE_DENIED","A donor in a live sandbox workspace must approve this test payment.",403);
  await initializeDatabase();
  return database().transaction(async tx=>{
    const [current]=await query<{role:string;expires_at:Date;revoked_at:Date|null;sandbox_limit_minor:string}>("SELECT * FROM fp_sessions WHERE id=$1 FOR UPDATE",[session.id],tx);
    if(!current || current.revoked_at || current.expires_at.getTime()<=Date.now() || current.role!=="donor") throw new DomainError("ROLE_DENIED","Your current role cannot authorize this payment.",403);
    const obligationId=`${session.tenantId}:checkout:${intentId}`, businessKey=`checkout:${intentId}:${kind}`;
    const [existing]=await query<{command:PaymentCommand}>("SELECT command FROM fp_payment_commands WHERE tenant_id=$1 AND business_key=$2",[session.tenantId,businessKey],tx);
    if(existing){
      if(kind==="capture" && existing.command.action.kind==="capture_order" && existing.command.action.orderId!==orderId) throw new DomainError("COMMAND_CONFLICT","This approval is already bound to a different order.");
      return existing.command;
    }
    if(kind==="create"){
      await tx.query("SELECT pg_advisory_xact_lock(410202613)");
      const [limits]=await query<{session_total:string;global_total:string}>("SELECT COALESCE(sum(amount_minor) FILTER(WHERE actor_id=$1),0) session_total,COALESCE(sum(amount_minor),0) global_total FROM fp_obligations WHERE purpose='sandbox_test'",[session.actorId],tx);
      if(Number(limits.session_total)+CHECKOUT_TEST_MINOR>Number(current.sandbox_limit_minor) || Number(limits.global_total)+CHECKOUT_TEST_MINOR>GLOBAL_TEST_CEILING_MINOR) throw new DomainError("SANDBOX_LIMIT","This sandbox has reached its test contribution limit. Existing payments can still be checked.");
      await tx.query("INSERT INTO fp_obligations(id,tenant_id,project_id,package_id,actor_id,amount_minor,channel,purpose,data) VALUES($1,$2,$3,'electronics',$4,$5,'uncollected','sandbox_test',$6::jsonb)",[obligationId,session.tenantId,session.projectId,session.actorId,CHECKOUT_TEST_MINOR,JSON.stringify({donorLabel:"You",provenance:"live_sandbox",consentPolicy:"One explicitly approved $1.00 sandbox test payment. No automatic future charge.",policyHash})]);
    }
    const [obligation]=await query<{version:number;amount_minor:string}>("SELECT version,amount_minor FROM fp_obligations WHERE id=$1 AND tenant_id=$2 AND actor_id=$3 FOR UPDATE",[obligationId,session.tenantId,session.actorId],tx);
    if(!obligation) throw new DomainError("OBLIGATION_NOT_FOUND","The original payment request could not be found.",404);
    if(kind==="capture" && !(await query("SELECT order_id FROM fp_provider_orders WHERE order_id=$1 AND tenant_id=$2 AND project_id=$3 AND obligation_id=$4",[orderId,session.tenantId,session.projectId,obligationId],tx)).length) throw new DomainError("ORDER_NOT_OWNED","That PayPal order does not belong to this payment request.",403);
    const approval:ApprovalRecord={id:randomUUID(),tenantId:session.tenantId,actorId:session.actorId,operation:kind==="create"?"create_order":"capture_order",resourceId:obligationId,resourceVersion:obligation.version,amountMinor:CHECKOUT_TEST_MINOR,currency:"USD",recipientVersion:null,policyHash,digest:"",expiresAt:new Date(Date.now()+30*60*1000).toISOString(),revokedAt:null};
    approval.digest=sha256(canonicalJson({...approval,digest:undefined}));
    const action:PaymentAction=kind==="create"?{kind:"create_order",money:{currency:"USD",minor:CHECKOUT_TEST_MINOR},intent:"CAPTURE",customId:obligationId,experience:{returnUrl:`${applicationOrigin()}/sandbox?checkout=returned`,cancelUrl:`${applicationOrigin()}/sandbox?checkout=cancelled`,userAction:"PAY_NOW",shippingPreference:"NO_SHIPPING",brandName:"Fieldproof sandbox"}}:{kind:"capture_order",money:{currency:"USD",minor:CHECKOUT_TEST_MINOR},orderId:orderId!};
    const command:PaymentCommand={scope:{tenantId:session.tenantId,projectId:session.projectId},operationId:randomUUID(),businessKey,intentId:obligationId,providerRequestId:randomUUID(),payloadHash:payloadHash(action),action,approval:{id:approval.id,version:approval.resourceVersion,digest:approval.digest,expiresAt:approval.expiresAt}};
    await tx.query("INSERT INTO fp_approval_records(id,tenant_id,project_id,actor_id,resource_id,resource_version,digest,expires_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",[approval.id,session.tenantId,session.projectId,session.actorId,obligationId,approval.resourceVersion,approval.digest,approval.expiresAt,JSON.stringify(approval)]);
    await tx.query("INSERT INTO fp_payment_commands(operation_id,tenant_id,project_id,obligation_id,session_id,business_key,payload_hash,command) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",[command.operationId,session.tenantId,session.projectId,obligationId,session.id,businessKey,command.payloadHash,JSON.stringify(command)]);
    await appendEvent(tx,session,"payment.approved",kind==="create"?"A sandbox checkout begins":"Checking buyer approval",kind==="create"?"One $1.00 test payment, with a fixed amount and your own approval.":"PayPal will confirm buyer approval of the exact order before any capture.");
    return command;
  });
}

export async function ingestPaymentOperation(operation:PaymentOperation):Promise<void> {
  const command=operation.command;
  await ingestOwnedResources(command,operation.receipt?.resources??[],["claimed","dispatching","pending_reconciliation"].includes(operation.status));
}

/** Fresh reads are observations, never fabricated mutation receipts. */
export async function ingestOwnedOrderRead(orderId:string,resources:ProviderResource[]):Promise<void> {
  const [owned]=await query<{command:PaymentCommand}>(`SELECT c.command FROM fp_provider_orders p
    JOIN fp_payment_commands c ON c.operation_id=p.operation_id AND c.tenant_id=p.tenant_id
      AND c.project_id=p.project_id AND c.obligation_id=p.obligation_id
    JOIN fp_tenants t ON t.id=p.tenant_id AND t.mode='live_sandbox' WHERE p.order_id=$1`,[orderId]);
  if(!owned)throw new DomainError("ORDER_NOT_OWNED","The observed order has no exact project owner.",409);
  const orders=resources.filter(r=>r.kind==="order");
  if(orders.length!==1||orders[0].id!==orderId||resources.some(r=>r.source!=="live_sandbox"))throw new DomainError("READ_IDENTITY_MISMATCH","The current provider observation does not match the owned order.",409);
  await ingestOwnedResources(owned.command,resources,false);
}

async function ingestOwnedResources(command:PaymentCommand,resources:ProviderResource[],pending:boolean):Promise<void> {
  const [owner]=await query<{obligation_id:string;session_id:string;package_id:string;amount_minor:string;command:PaymentCommand}>(`SELECT c.obligation_id,c.session_id,o.package_id,o.amount_minor,c.command
    FROM fp_payment_commands c JOIN fp_obligations o ON o.id=c.obligation_id AND o.tenant_id=c.tenant_id AND o.project_id=c.project_id
    WHERE c.operation_id=$1 AND c.tenant_id=$2 AND c.project_id=$3`,[command.operationId,command.scope.tenantId,command.scope.projectId]);
  if(!owner||canonicalJson(owner.command)!==canonicalJson(command))throw new DomainError("COMMAND_NOT_FOUND","The payment has no exact domain owner.");
  await database().transaction(async tx=>{
    await tx.query("SELECT id FROM fp_obligations WHERE id=$1 FOR UPDATE",[owner.obligation_id]);
    for(const resource of resources){
      if(resource.kind==="order") await tx.query("INSERT INTO fp_provider_orders(order_id,tenant_id,project_id,obligation_id,operation_id,observed_state) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(order_id) DO UPDATE SET observed_state=CASE WHEN fp_provider_orders.observed_state='COMPLETED' THEN fp_provider_orders.observed_state ELSE EXCLUDED.observed_state END WHERE fp_provider_orders.obligation_id=EXCLUDED.obligation_id",[resource.id,command.scope.tenantId,command.scope.projectId,owner.obligation_id,command.operationId,resource.status]);
      if(resource.kind!=="capture" || resource.status!=="COMPLETED" || resource.source!=="live_sandbox") continue;
      if(!resource.money || resource.money.currency!=="USD") throw new DomainError("PAYMENT_AMOUNT_UNPROVEN","The payment currency could not be confirmed.");
      const merchantScope=sha256(providerConfiguration().clientId), alias=`paypal:capture:${resource.id}`;
      if((await query("SELECT receipt_id FROM fp_economic_aliases WHERE merchant_scope=$1 AND alias=$2",[merchantScope,alias],tx)).length) continue;
      const prior=await query<{data:SettlementReceipt}>("SELECT data FROM fp_settlement_receipts WHERE obligation_id=$1",[owner.obligation_id],tx);
      const split=splitSettlement(resource.money.minor,Number(owner.amount_minor),prior.reduce((sum,r)=>sum+r.data.creditedMinor,0));
      const receipt:SettlementReceipt={id:randomUUID(),tenantId:command.scope.tenantId,projectId:command.scope.projectId,packageId:owner.package_id,donorObligationId:owner.obligation_id,sourceKind:"orders_capture",provenance:"live_sandbox",actualProviderPaymentRef:resource.id,economicAliases:[alias],sourceOrderId:command.action.kind==="capture_order"?command.action.orderId:resources.find(r=>r.kind==="order")?.id??resource.parentId,sourceInvoiceId:null,authoritativeObservedState:"COMPLETED",observedAt:resource.observedAt,currency:"USD",grossSettledMinor:resource.money.minor,...split,completedAttributedRefundMinor:0,pendingAttributedRefundReserveMinor:0,excludedMinor:0,provenRefundableRef:resource.id,refundAdapter:"capture_refund"};
      validateReceipt(receipt);
      const entries=[{account:"paypal_clearing",side:"debit" as const,amountMinor:receipt.grossSettledMinor},{account:"package_funds",side:"credit" as const,amountMinor:receipt.creditedMinor},{account:"excess_refund_liability",side:"credit" as const,amountMinor:receipt.excessLiabilityMinor}];
      assertBalanced(entries);
      await tx.query("INSERT INTO fp_settlement_receipts(id,tenant_id,project_id,obligation_id,package_id,provider_ref,provenance,data) VALUES($1,$2,$3,$4,$5,$6,'live_sandbox',$7::jsonb)",[receipt.id,receipt.tenantId,receipt.projectId,receipt.donorObligationId,receipt.packageId,receipt.actualProviderPaymentRef,JSON.stringify(receipt)]);
      await tx.query("INSERT INTO fp_economic_aliases(merchant_scope,alias,receipt_id) VALUES($1,$2,$3)",[merchantScope,alias,receipt.id]);
      for(const entry of entries) if(entry.amountMinor) await tx.query("INSERT INTO fp_journal(id,tenant_id,project_id,receipt_id,account,side,amount_minor,currency) VALUES($1,$2,$3,$4,$5,$6,$7,'USD')",[randomUUID(),receipt.tenantId,receipt.projectId,receipt.id,entry.account,entry.side,entry.amountMinor]);
      await tx.query("UPDATE fp_obligations SET channel=$1 WHERE id=$2",[receipt.excessLiabilityMinor?"excess_reconciliation":"collected",owner.obligation_id]);
      await appendEvent(tx,{...command.scope,mode:"live_sandbox"},"payment.settled","PayPal confirmed your test payment","The actual captured amount is now linked to one canonical receipt. Physical evidence remains unreviewed.");
    }
    if(pending){
      await tx.query("UPDATE fp_obligations SET channel='unknown_reconciling' WHERE id=$1 AND channel NOT IN ('collected','excess_reconciliation')",[owner.obligation_id]);
      await tx.query("INSERT INTO fp_outbox(id,tenant_id,project_id,kind,data) VALUES($1,$2,$3,'payment.reconcile',$4::jsonb) ON CONFLICT(id) DO NOTHING",[`reconcile:${command.operationId}`,command.scope.tenantId,command.scope.projectId,JSON.stringify({operationId:command.operationId})]);
    }
  });
}
export function paymentView(operation:PaymentOperation) {
  const resources=operation.receipt?.resources??[], order=resources.find(r=>r.kind==="order");
  const capture=resources.find(r=>r.kind==="capture" && r.status==="COMPLETED");
  const approval=order?.links.find(link=>{
    try { const url=new URL(link.href);return (link.rel==="payer-action" || link.rel==="approve") && url.protocol==="https:" && url.hostname==="www.sandbox.paypal.com"; } catch { return false; }
  });
  return {operationId:operation.command.operationId,status:operation.status,orderId:order?.id??(operation.command.action.kind==="capture_order"?operation.command.action.orderId:null),captureId:capture?.id??null,approvalUrl:approval?.href??null,amountMinor:operation.command.action.money.minor,source:operation.receipt?.source??null,observedAt:operation.receipt?.observedAt??null,message:operation.error?.message??null};
}
export type PaymentView = ReturnType<typeof paymentView>;
export async function createCheckout(session:Session,intentId:string){
  const operation=await paymentCore().execute(await commandFor(session,intentId,"create"));
  await ingestPaymentOperation(operation);
  return paymentView(operation);
}
export async function captureCheckout(session:Session,intentId:string,orderId:string){
  const operation=await paymentCore().execute(await commandFor(session,intentId,"capture",orderId));
  await ingestPaymentOperation(operation);
  return paymentView(operation);
}
export async function ownedPayment(session:Session,operationId:string,reconcile=false){
  const [owner]=await query<{command:PaymentCommand}>("SELECT command FROM fp_payment_commands WHERE operation_id=$1 AND tenant_id=$2 AND session_id=$3",[operationId,session.tenantId,session.id]);
  if(!owner) throw new DomainError("PAYMENT_NOT_FOUND","That payment does not belong to this workspace.",404);
  const operation=reconcile?await paymentCore().reconcile(owner.command.scope,operationId):await new SqlPaymentStore(database()).get(owner.command.scope,operationId);
  if(!operation) throw new DomainError("PAYMENT_NOT_FOUND","The payment has not been dispatched.",404);
  if(reconcile) await ingestPaymentOperation(operation);
  return paymentView(operation);
}
export async function checkCheckoutIntent(session:Session,intentId:string){
  const [owner]=await query<{operation_id:string}>("SELECT operation_id FROM fp_payment_commands WHERE tenant_id=$1 AND session_id=$2 AND obligation_id=$3 ORDER BY created_at DESC LIMIT 1",[session.tenantId,session.id,`${session.tenantId}:checkout:${intentId}`]);
  if(!owner)throw new DomainError("PAYMENT_NOT_FOUND","No payment request exists for this checkout yet.",404);
  return ownedPayment(session,owner.operation_id,true);
}
