import { randomUUID } from "node:crypto";
import { sha256, type ProviderAdapter, type ProviderResource } from "@fracture/paypal-core";
import { DomainError } from "../domain/money";
import { database, initializeDatabase, query } from "./db";
import { ingestOwnedOrderRead, paypalProvider } from "./payments";
import { webhookInboxScope } from "./webhooks";
import { observeOwnedInvoice, type RecoveryDependencies } from "./recovery-invoices";
import { observeOwnedRefund, type RefundDependencies } from "./refunds";
import { observeOwnedPayout, type PayoutDependencies } from "./payouts";

type Job={inbox_id:string;event_id:string;event_type:string;resource_id:string;attempts:number;lease_id:string};
const supported=new Set(["CHECKOUT.ORDER.APPROVED","CHECKOUT.ORDER.COMPLETED","PAYMENT.CAPTURE.COMPLETED","PAYMENT.CAPTURE.PENDING","PAYMENT.CAPTURE.DENIED","PAYMENT.CAPTURE.DECLINED"]);
const validId=(value:string)=>/^[A-Za-z0-9_.:-]{1,128}$/.test(value);

/** A link yields a candidate ID only. We never fetch provider-supplied URLs. */
export function orderIdFromCapture(resource:ProviderResource):string|null {
  const ids=new Set<string>();
  for(const link of resource.links){
    if(link.rel!=="up"||link.method!=="GET")continue;
    try{
      const url=new URL(link.href);
      if(!["https://api-m.sandbox.paypal.com","https://api.sandbox.paypal.com"].includes(url.origin)||url.username||url.password||url.search||url.hash)continue;
      const match=/^\/v2\/checkout\/orders\/([A-Z0-9]{8,64})$/.exec(url.pathname);
      if(match)ids.add(match[1]);
    }catch{/* An invalid provider link cannot establish ownership. */}
  }
  return ids.size===1?[...ids][0]:null;
}

export async function enqueueVerifiedWebhooks():Promise<number> {
  await initializeDatabase();const scope=webhookInboxScope();
  // Canonical intake rows exist only after signature and reference-schema checks.
  // Never queue from the delivery table, which intentionally retains rejections.
  const result=await database().query(`INSERT INTO fp_webhook_jobs(inbox_id,event_id,event_type,resource_id)
    SELECT e.tenant_id,e.event_id,e.document::jsonb->>'eventType',e.document::jsonb->>'resourceId'
    FROM paycore_webhook_events e WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.status='queued'
      AND e.document::jsonb->>'verified'='true' AND e.document::jsonb->>'schemaValid'='true'
    ON CONFLICT(inbox_id,event_id) DO NOTHING`,[scope.tenantId,scope.projectId]);
  return result.rowCount;
}

async function claimJob():Promise<Job|null> {
  const scope=webhookInboxScope(),lease=randomUUID();
  const [job]=await query<Job>(`WITH ready AS (
    SELECT inbox_id,event_id FROM fp_webhook_jobs WHERE inbox_id=$1 AND
      ((status IN ('queued','retry') AND available_at<=now()) OR (status='processing' AND lease_until<=now()))
    ORDER BY available_at,created_at,event_id FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE fp_webhook_jobs j SET status='processing',lease_id=$2,lease_until=now()+interval '90 seconds',attempts=j.attempts+1
    FROM ready WHERE j.inbox_id=ready.inbox_id AND j.event_id=ready.event_id RETURNING j.*`,[scope.tenantId,lease]);
  return job??null;
}

async function finishJob(job:Job,status:"processed"|"retry"|"review",code:string,observation:unknown=null,owner?:{tenant_id:string;project_id:string}) {
  const scope=webhookInboxScope();
  await database().transaction(async tx=>{
    const result=await tx.query(`UPDATE fp_webhook_jobs SET status=$4,last_code=$5,lease_id=NULL,lease_until=NULL,
      available_at=now()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts,7)))::integer),
      observation=COALESCE($6::jsonb,observation),owner_tenant_id=COALESCE($7,owner_tenant_id),owner_project_id=COALESCE($8,owner_project_id),
      completed_at=CASE WHEN $4 IN ('processed','review') THEN now() ELSE NULL END
      WHERE inbox_id=$1 AND event_id=$2 AND lease_id=$3 AND status='processing'`,
      [job.inbox_id,job.event_id,job.lease_id,status,code,observation===null?null:JSON.stringify(observation),owner?.tenant_id??null,owner?.project_id??null]);
    if(result.rowCount&&status!=="retry")await tx.query("UPDATE paycore_webhook_events SET status=$4 WHERE tenant_id=$1 AND project_id=$2 AND event_id=$3",[scope.tenantId,scope.projectId,job.event_id,status==="processed"?"processed":"dead_letter"]);
  });
}

async function processJob(job:Job,provider:Pick<ProviderAdapter,"read">,deadline:number,domain:{recovery?:RecoveryDependencies;refunds?:RefundDependencies;payouts?:PayoutDependencies}={}) {
  if(!validId(job.resource_id)) {await finishJob(job,"review","INVALID_RESOURCE_ID");return "review" as const;}
  if(job.event_type.startsWith("INVOICING.INVOICE.")) {
    const owner=await observeOwnedInvoice(job.resource_id,domain.recovery);
    await finishJob(job,"processed","CURRENT_OWNED_INVOICE_APPLIED",{observedAt:new Date().toISOString(),invoiceIdHash:sha256(job.resource_id),financialWrites:0},owner);
    return "processed" as const;
  }
  if(job.event_type.startsWith("PAYMENT.PAYOUTS-ITEM.") || job.event_type.startsWith("PAYMENT.PAYOUTSBATCH.")) {
    const owner=await observeOwnedPayout(job.resource_id,job.event_type.startsWith("PAYMENT.PAYOUTS-ITEM.")?"item":"batch",domain.payouts);
    await finishJob(job,"processed","CURRENT_OWNED_PAYOUT_ITEM_APPLIED",{observedAt:new Date().toISOString(),resourceIdHash:sha256(job.resource_id),financialWrites:0},owner);
    return "processed" as const;
  }
  if(["PAYMENT.CAPTURE.REFUNDED","PAYMENT.REFUND.PENDING","PAYMENT.REFUND.FAILED"].includes(job.event_type)) {
    const owner=await observeOwnedRefund(job.resource_id,domain.refunds);
    await finishJob(job,"processed","CURRENT_OWNED_REFUND_APPLIED",{observedAt:new Date().toISOString(),refundIdHash:sha256(job.resource_id),financialWrites:0},owner);
    return "processed" as const;
  }
  if(!supported.has(job.event_type)) {await finishJob(job,"review","DOMAIN_ADAPTER_REQUIRED");return "review" as const;}
  const signal=()=>AbortSignal.timeout(Math.max(1,Math.min(12000,deadline-Date.now())));
  let capture:ProviderResource|undefined;
  let orderId=job.resource_id;
  if(job.event_type.startsWith("PAYMENT.CAPTURE.")){
    const result=await provider.read("capture",job.resource_id,signal());
    capture=result.find(r=>r.kind==="capture"&&r.id===job.resource_id&&r.source==="live_sandbox");
    if(!capture)throw new DomainError("CURRENT_CAPTURE_UNAVAILABLE","The exact current capture could not be read.",503);
    const linkedOrder=orderIdFromCapture(capture);
    const [known]=linkedOrder?[]:await query<{order_id:string}>("SELECT data->>'sourceOrderId' order_id FROM fp_settlement_receipts WHERE provider_ref=$1 AND provenance='live_sandbox'",[capture.id]);
    orderId=linkedOrder??known?.order_id;
    if(!orderId)throw new DomainError("ORDER_OWNERSHIP_UNRESOLVED","The capture has no proven owning order yet.",409);
  }
  const [owner]=await query<{tenant_id:string;project_id:string}>(`SELECT p.tenant_id,p.project_id FROM fp_provider_orders p
    JOIN fp_payment_commands c ON c.operation_id=p.operation_id AND c.tenant_id=p.tenant_id AND c.project_id=p.project_id AND c.obligation_id=p.obligation_id
    JOIN fp_tenants t ON t.id=p.tenant_id AND t.mode='live_sandbox' WHERE p.order_id=$1`,[orderId]);
  if(!owner)throw new DomainError("ORDER_OWNERSHIP_UNRESOLVED","This event does not yet map to an exact owned order.",409);
  const resources=await provider.read("order",orderId,signal());
  const order=resources.find(r=>r.kind==="order"&&r.id===orderId&&r.source==="live_sandbox");
  if(!order||resources.some(r=>r.source!=="live_sandbox"))throw new DomainError("CURRENT_ORDER_UNAVAILABLE","The current owned order could not be confirmed.",503);
  if(capture){
    const corroborated=resources.find(r=>r.kind==="capture"&&r.id===capture!.id);
    if(!corroborated||corroborated.status!==capture.status||JSON.stringify(corroborated.money)!==JSON.stringify(capture.money))throw new DomainError("CAPTURE_ORDER_MISMATCH","The owned order and capture reads do not agree yet.",409);
  }
  // Recoverable crash boundary: projection has a locked obligation plus a unique
  // merchant/capture economic alias. Repeating it after a crash cannot add money.
  await ingestOwnedOrderRead(orderId,resources);
  const observation={observedAt:new Date().toISOString(),orderIdHash:sha256(orderId),resources:resources.map(r=>({kind:r.kind,idHash:sha256(r.id),status:r.status,money:r.money,observedAt:r.observedAt})),financialWrites:0};
  await finishJob(job,"processed","CURRENT_OWNED_RESOURCES_APPLIED",observation,owner);
  return "processed" as const;
}

/** Bounded scheduler batch; every provider call is a read. */
export async function processVerifiedWebhooks(options:{limit?:number;provider?:Pick<ProviderAdapter,"read">;budgetMs?:number;recovery?:RecoveryDependencies;refunds?:RefundDependencies;payouts?:PayoutDependencies}={}) {
  const limit=Math.max(1,Math.min(options.limit??3,20)),budget=Math.max(1000,Math.min(options.budgetMs??40000,45000));
  await enqueueVerifiedWebhooks();const deadline=Date.now()+budget,provider=options.provider??paypalProvider();
  const summary={processed:0,retry:0,review:0};
  for(let i=0;i<limit&&Date.now()<deadline;i++){
    const job=await claimJob();if(!job)break;
    try{summary[await processJob(job,provider,deadline,options)]++;}
    catch(error){
      const code=error instanceof DomainError?error.code:"PROVIDER_READ_UNAVAILABLE";
      const status=job.attempts>=8?"review":"retry";
      await finishJob(job,status,code);summary[status]++;
    }
  }
  return summary;
}
