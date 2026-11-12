import { randomUUID } from "node:crypto";
import { canonicalJson, type SqlConnection } from "@fracture/paypal-core";
import type { DonorObligation, EvidenceItem, PackageView, ProjectEvent, ProjectSnapshot, SettlementReceipt } from "../contracts";
import { DomainError } from "../domain/money";
import { packagePositionTotals } from "../domain/funding-positions";
import { assessPackageFunding } from "../domain/package-funding";
import { database, query } from "./db";
import { ensurePublicProject, PUBLIC_PROJECT, sampleEvidence, sampleReceipt } from "./seed";
import type { Session } from "./auth";
import { requireMakerspaceScenario } from "./community-workspaces";
import { requireCurrentRole, currentViewRoles } from "./membership";
import { lockFundingScope, readFundingProjection } from "./funding-positions";
import { projectClaimLock } from "./claims";
import { readFundingPromises } from "./funding-promises";

// JSON storage is extensible; serializing it wholesale would also serialize
// future private consent, destination or source metadata into every page.
function receiptView(r: SettlementReceipt): SettlementReceipt {
  return {id:r.id,tenantId:r.tenantId,projectId:r.projectId,packageId:r.packageId,donorObligationId:r.donorObligationId,
    sourceKind:r.sourceKind,provenance:r.provenance,actualProviderPaymentRef:r.actualProviderPaymentRef,economicAliases:[...r.economicAliases],
    sourceOrderId:r.sourceOrderId,sourceInvoiceId:r.sourceInvoiceId,authoritativeObservedState:r.authoritativeObservedState,observedAt:r.observedAt,
    currency:r.currency,grossSettledMinor:r.grossSettledMinor,creditedMinor:r.creditedMinor,completedAttributedRefundMinor:r.completedAttributedRefundMinor,
    pendingAttributedRefundReserveMinor:r.pendingAttributedRefundReserveMinor,excludedMinor:r.excludedMinor,excessLiabilityMinor:r.excessLiabilityMinor,
    provenRefundableRef:r.provenRefundableRef,refundAdapter:r.refundAdapter};
}
function evidenceView(e: EvidenceItem): EvidenceItem {
  return {id:e.id,title:e.title,kind:e.kind,packageIds:[...e.packageIds],provenance:e.provenance,state:e.state,submittedBy:e.submittedBy,
    ...(e.amountMinor===undefined?{}:{amountMinor:e.amountMinor}),description:e.description,reviewer:e.reviewer,reviewedAt:e.reviewedAt,assetPath:e.assetPath};
}

export async function appendEvent(tx: SqlConnection, session: Pick<Session,"tenantId"|"projectId"|"mode">, type: string, title: string, detail: string): Promise<void> {
  const id = randomUUID();
  await tx.query("INSERT INTO fp_events(id,tenant_id,project_id,type,data) VALUES($1,$2,$3,$4,$5::jsonb)",[id,session.tenantId,session.projectId,type,JSON.stringify({title,detail,provenance:session.mode})]);
  await tx.query("UPDATE fp_projects SET projection_version=projection_version+1 WHERE id=$1",[session.projectId]);
  await tx.query("INSERT INTO fp_outbox(id,tenant_id,project_id,kind,data,status) VALUES($1,$2,$3,'projection.changed',$4::jsonb,'delivered')",[randomUUID(),session.tenantId,session.projectId,JSON.stringify({eventId:id})]);
}
export async function projectSnapshot(session: Session | null = null): Promise<ProjectSnapshot> {
  if (session) await requireCurrentRole(session, session.role);
  await ensurePublicProject();
  const projectId = session?.projectId ?? PUBLIC_PROJECT;
  const snapshot=await database().transaction(async tx=>{
  await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  if(session) await requireCurrentRole(session,session.role,tx);
  const [project] = await query<{id:string;tenant_id:string;slug:string;version:number;projection_version:number;tour_step:number;metadata:Record<string,unknown>;mode:"sample"|"live_sandbox"}>("SELECT p.*,t.mode FROM fp_projects p JOIN fp_tenants t ON t.id=p.tenant_id WHERE p.id=$1",[projectId],tx);
  if (!project) throw new DomainError("PROJECT_NOT_FOUND","This project is no longer available.",404);
  if (session && project.tenant_id!==session.tenantId) throw new DomainError("PROJECT_NOT_FOUND","This project is no longer available.",404);
  const financialScope: NonNullable<ProjectSnapshot["financialScope"]> = !session || session.role==="organizer" || session.role==="auditor" ? "project" : session.role==="donor" ? "own" : "none";
  const [packageRows,obligationRows,receiptRows,evidenceRows,eventRows,roundRows] = await Promise.all([
    query<{id:string;version:number;budget_minor:string;data:PackageView}>("SELECT * FROM fp_packages WHERE project_id=$1 ORDER BY COALESCE((data->>'order')::integer,CASE id WHEN 'electronics' THEN 0 WHEN 'printing' THEN 1 WHEN 'woodworking' THEN 2 WHEN 'safety' THEN 3 WHEN 'laser' THEN 4 ELSE 5 END),id",[projectId],tx),
    query<{id:string;actor_id:string;package_id:string;amount_minor:string;channel:DonorObligation["channel"];consent_version:number;purpose:DonorObligation["purpose"];created_at:Date;data:{donorLabel:string}}>("SELECT * FROM fp_obligations WHERE tenant_id=$1 AND project_id=$2 AND ($3='project' OR ($3='own' AND actor_id=$4)) ORDER BY created_at,id",[project.tenant_id,projectId,financialScope,session?.actorId??null],tx),
    query<{id:string;obligation_id:string;data:SettlementReceipt}>(`SELECT r.id,r.obligation_id,r.data FROM fp_settlement_receipts r
      JOIN fp_obligations o ON o.id=r.obligation_id AND o.tenant_id=r.tenant_id AND o.project_id=r.project_id
      WHERE r.tenant_id=$1 AND r.project_id=$2 AND ($3='project' OR ($3='own' AND o.actor_id=$4)) ORDER BY r.created_at,r.id`,[project.tenant_id,projectId,financialScope,session?.actorId??null],tx),
    query<{data:EvidenceItem}>("SELECT data FROM fp_evidence WHERE project_id=$1 ORDER BY created_at,id",[projectId],tx),
    query<{id:string;sequence:string;type:string;occurred_at:Date;data:Omit<ProjectEvent,"id"|"sequence"|"type"|"occurredAt">}>("SELECT * FROM fp_events WHERE project_id=$1 ORDER BY sequence DESC LIMIT 30",[projectId],tx),
    query<{package_id:string;package_version:number;state:string}>("SELECT package_id,package_version,state FROM fp_collection_rounds WHERE tenant_id=$1 AND project_id=$2 ORDER BY collection_started_at DESC,id DESC",[project.tenant_id,projectId],tx),
  ]);
  const funding=await readFundingProjection({tenantId:project.tenant_id,projectId,provenance:project.mode},tx);
  const promises=await readFundingPromises({tenantId:project.tenant_id,projectId,mode:project.mode},tx);
  const receipts = receiptRows.map(row => receiptView(row.data));
  const obligations: DonorObligation[] = obligationRows.map(row=>({id:row.id,packageId:row.package_id,amountMinor:Number(row.amount_minor),channel:row.channel,consentVersion:row.consent_version,donorLabel:row.data.donorLabel,provenance:project.mode,createdAt:row.created_at.toISOString(),purpose:row.purpose}));
  const packages: PackageView[] = packageRows.map(row=>{
    const totals = packagePositionTotals(funding.positions,row.id,Number(row.budget_minor));
    const pledgedMinor = promises.get(row.id)??0;
    const round=roundRows.find(r=>r.package_id===row.id&&r.package_version===row.version)??roundRows.find(r=>r.package_id===row.id);
    const policy=assessPackageFunding({state:row.data.fundingState,version:row.version,budgetMinor:Number(row.budget_minor),eligibleMinor:totals.fundingEligibleMinor,provenance:project.mode,round:round?{packageVersion:round.package_version,state:round.state}:undefined});
    const p=row.data;
    return {id:row.id,title:p.title,shortTitle:p.shortTitle,description:p.description,budgetMinor:Number(row.budget_minor),version:row.version,pledgedMinor,
      ...totals,fundingState:policy.state,workState:p.workState,evidenceAccepted:p.evidenceAccepted,evidenceRequired:p.evidenceRequired,
      dependencies:[...p.dependencies],category:p.category,icon:p.icon,
      zone:{packageId:p.zone.packageId,points:p.zone.points.map(({x,y})=>({x,y})),label:{x:p.zone.label.x,y:p.zone.label.y},...(p.zone.rotation===undefined?{}:{rotation:p.zone.rotation})}};
  });
  const m = project.metadata as unknown as Pick<ProjectSnapshot,"title"|"subtitle"|"organizer"|"location"|"currency"|"targetMinor"|"deadline"|"templateId"|"templateWorkspace">;
  const evidence=evidenceRows.map(row=>evidenceView(row.data));
  // Legacy illustrations are public fictional documents. Uploaded/private
  // evidence is disclosed only through its separately permissioned source view.
  const illustrations=sampleEvidence(projectId).map(row=>canonicalJson(row));
  const visibleEvidence=financialScope==="project"?evidence:evidence.filter(row=>project.mode==="sample"&&illustrations.includes(canonicalJson(row)));
  return {title:m.title,subtitle:m.subtitle,organizer:m.organizer,location:m.location,currency:m.currency,targetMinor:m.targetMinor,deadline:m.deadline,
    ...(m.templateId?{templateId:m.templateId,templateWorkspace:m.templateWorkspace}:{}),id:project.id,tenantId:project.tenant_id,slug:project.slug,mode:project.mode,version:project.version,projectionVersion:project.projection_version,packages,obligations,receipts,financialScope,
    evidence:visibleEvidence,events:eventRows.map(row=>({title:row.data.title,detail:row.data.detail,provenance:row.data.provenance,id:row.id,sequence:Number(row.sequence),type:row.type,occurredAt:row.occurred_at.toISOString()})),tourStep:project.tour_step,session:session?{role:session.role,allowedRoles:await currentViewRoles(session,tx),actorId:session.actorId,expiresAt:session.expiresAt}:null,capabilities:{checkoutConfigured:!!process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_PROJECT_ISOLATED === "true",savedWalletQualified:false,payoutQualified:false,invoiceQualified:false,studioConfigured:!!process.env.AG_STUDIO_LICENSE_KEY}};
  });
  if(session) await requireCurrentRole(session,session.role);
  return snapshot;
}
export async function addSamplePledge(session: Session, input:{amountMinor:number;packageId:string;expectedVersion:number;intentId:string}): Promise<void> {
  if(session.mode!=="sample") throw new DomainError("CONSENT_CAPABILITY_PENDING","Conditional wallet collection is still being qualified. Use the explicit sandbox checkout to test a payment.");
  if(session.role!=="donor") throw new DomainError("ROLE_DENIED","Choose the donor role to make your own sample pledge.",403);
  await database().transaction(async tx=>{
    await requireCurrentRole(session,"donor",tx);
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);
    if((await query("SELECT id FROM fp_funding_policies WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3",[session.tenantId,session.projectId,input.packageId],tx)).length)throw new DomainError("PURPOSE_PLEDGE_REQUIRED","Open the funding desk to choose this purpose's exact current pledge and deadline.");
    const [item] = await query<{version:number;state:string}>("SELECT version,data->>'fundingState' state FROM fp_packages WHERE project_id=$1 AND id=$2 FOR UPDATE",[session.projectId,input.packageId],tx);
    if(!item) throw new DomainError("PACKAGE_NOT_FOUND","That package is not part of this project.",404);
    if(item.version!==input.expectedVersion) throw new DomainError("VERSION_CHANGED","The plan changed. Review the current package before pledging.");
    if(["cancelled","compensating"].includes(item.state))throw new DomainError("PURPOSE_CLOSED","This purpose is closed. Review current purposes in the funding desk.");
    const id = `${session.tenantId}:${input.intentId}`;
    const [existing]=await query<{amount_minor:string;package_id:string}>("SELECT amount_minor,package_id FROM fp_obligations WHERE id=$1",[id],tx);
    if(existing){
      if(Number(existing.amount_minor)!==input.amountMinor || existing.package_id!==input.packageId)throw new DomainError("PLEDGE_CONFLICT","This pledge request was already saved with a different amount or package. Review the saved commitment.");
      return;
    }
    const result = await tx.query("INSERT INTO fp_obligations(id,tenant_id,project_id,package_id,actor_id,amount_minor,channel,purpose,data) VALUES($1,$2,$3,$4,$5,$6,'uncollected','conditional_pledge',$7::jsonb) ON CONFLICT(id) DO NOTHING RETURNING id",[id,session.tenantId,session.projectId,input.packageId,session.actorId,input.amountMinor,JSON.stringify({donorLabel:"You",provenance:"sample",consentPolicy:"Payer-present conditional pledge; 48-hour recovery policy v1; sample only."})]);
    if(result.rowCount) await appendEvent(tx,session,"pledge.created","You backed an idea","Your sample pledge is saved. It has not charged a payment method.");
  });
}
export async function advanceTour(session: Session, step: number): Promise<void> {
  if(session.mode!=="sample") throw new DomainError("SAMPLE_ONLY","The walkthrough runs in a separate sample workspace.");
  await database().transaction(async tx=>{
    await projectClaimLock(tx,session.projectId);await lockFundingScope(session,tx);
    await requireMakerspaceScenario(session,tx);
    const [project] = await query<{tour_step:number}>("SELECT tour_step FROM fp_projects WHERE id=$1 FOR UPDATE",[session.projectId],tx);
    if(!project || step<=project.tour_step) return;
    if(step>project.tour_step+1) throw new DomainError("TOUR_SEQUENCE","Continue from the current walkthrough step.");
    if(step===2){
      if((await query("SELECT id FROM fp_funding_policies WHERE tenant_id=$1 AND project_id=$2 AND package_id='electronics'",[session.tenantId,session.projectId],tx)).length)throw new DomainError("SAMPLE_PURPOSE_CHANGED","Your workspace now has a separately reviewed funding purpose. Start another Sample walkthrough to replay the original collection story.");
      const [purpose]=await query<{state:string}>("SELECT data->>'fundingState' state FROM fp_packages WHERE project_id=$1 AND id='electronics'",[session.projectId],tx);
      if(!purpose||["cancelled","compensating"].includes(purpose.state))throw new DomainError("SAMPLE_PURPOSE_CLOSED","This purpose was closed in your workspace. Its saved donor decisions remain in place; start a separate Sample walkthrough to explore the original story.");
      const obligationId = `${session.projectId}-obligation-hero-8`;
      const receipt = sampleReceipt(session.tenantId,session.projectId,obligationId,"electronics",3500,"hero-8-invoice",true);
      await tx.query("INSERT INTO fp_settlement_receipts(id,tenant_id,project_id,obligation_id,package_id,provider_ref,provenance,data) VALUES($1,$2,$3,$4,'electronics',$5,'sample',$6::jsonb)",[receipt.id,session.tenantId,session.projectId,obligationId,receipt.actualProviderPaymentRef,JSON.stringify(receipt)]);
      await tx.query("INSERT INTO fp_economic_aliases(merchant_scope,alias,receipt_id) VALUES($1,$2,$3)",[session.tenantId,receipt.economicAliases[0],receipt.id]);
      await tx.query("UPDATE fp_obligations SET channel='collected',version=version+1 WHERE id=$1",[obligationId]);
      await appendEvent(tx,session,"sample.invoice_settled","One ledger, across both payment routes","Sample scenario: $925 in capture receipts plus a $35 invoice payment completes the $960 collection. No actual PayPal invoice was paid.");
    } else if(step===3) {
      await appendEvent(tx,session,"sample.receipt_opened","A receipt becomes a review task","Maria's $86.40 sample receipt still needs a human review. No repayment has been made.");
    }
    await tx.query("UPDATE fp_projects SET tour_step=$1,projection_version=projection_version+1 WHERE id=$2",[step,session.projectId]);
  });
}
