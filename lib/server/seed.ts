import { randomUUID } from "node:crypto";
import type { SqlConnection } from "@fracture/paypal-core";
import { HERO_OBLIGATION_AMOUNTS, type EvidenceItem, type PackageView, type SettlementReceipt } from "../contracts";
import { database, initializeDatabase, query } from "./db";
import { runtimeControl } from "./runtime-control";
import { DomainError } from "../domain/money";
import { recordSampleOrigin } from "./sample-funding-origins";

export const PUBLIC_PROJECT = "project_public_sample";
export const PUBLIC_TENANT = "tenant_public_sample";
export const publicMetadata = {
  title: "Room for possibility.", subtitle: "The Eastside makerspace project", organizer: "Ms. Okafor",
  location: "Eastside Middle School", currency: "USD", targetMinor: 841000, deadline: "2026-12-31T23:59:59Z",
};
type SeedPackage = Omit<PackageView, "pledgedMinor" | "version" | "collectedMinor" | "fundingEligibleMinor" | "shortfallMinor" | "pendingRefundMinor" | "excessLiabilityMinor">;
export const packageSeeds: SeedPackage[] = [
  { id: "electronics", title: "Electronics benches", shortTitle: "Electronics", description: "Six places to solder, tinker, and turn a first idea into something that works.", budgetMinor: 96000, fundingState: "recovering", workState: "planned", evidenceAccepted: 0, evidenceRequired: 3, dependencies: [], category: "Make a first spark", icon: "spark", zone: { packageId: "electronics", points: [{x:.52,y:.08},{x:.95,y:.08},{x:.95,y:.48},{x:.52,y:.48}], label:{x:.735,y:.27} } },
  { id: "printing", title: "3D-printer bay", shortTitle: "3D printing", description: "From a screen to something you can hold. A home for three student-ready printers.", budgetMinor: 120000, fundingState: "funded", workState: "review_needed", evidenceAccepted: 0, evidenceRequired: 3, dependencies: [], category: "Bring ideas into shape", icon: "printer", zone:{packageId:"printing",points:[{x:.05,y:.08},{x:.48,y:.08},{x:.48,y:.48},{x:.05,y:.48}],label:{x:.265,y:.27}} },
  { id: "woodworking", title: "Woodworking corner", shortTitle: "Woodworking", description: "A sturdy workbench, hand tools, and room to make carefully, together.", budgetMinor: 140000, fundingState: "open", workState: "planned", evidenceAccepted: 0, evidenceRequired: 3, dependencies: [], category: "Build something lasting", icon: "saw", zone:{packageId:"woodworking",points:[{x:.05,y:.53},{x:.38,y:.53},{x:.38,y:.94},{x:.05,y:.94}],label:{x:.215,y:.735}} },
  { id: "safety", title: "Safety & ventilation", shortTitle: "Safety & air", description: "Fresh air, protective equipment, and qualified safety review before the first class.", budgetMinor: 210000, fundingState: "open", workState: "planned", evidenceAccepted: 0, evidenceRequired: 3, dependencies: [], category: "A safe place to begin", icon: "shield", zone:{packageId:"safety",points:[{x:.42,y:.53},{x:.66,y:.53},{x:.66,y:.94},{x:.42,y:.94}],label:{x:.54,y:.735}} },
  { id: "laser", title: "Laser-cutter station", shortTitle: "Laser cutting", description: "Precision tools for big imaginations, after ventilation and qualified signoff are accepted.", budgetMinor: 185000, fundingState: "open", workState: "planned", evidenceAccepted: 0, evidenceRequired: 4, dependencies: ["safety"], category: "Make the next leap", icon: "laser", zone:{packageId:"laser",points:[{x:.70,y:.53},{x:.95,y:.53},{x:.95,y:.78},{x:.70,y:.78}],label:{x:.825,y:.65}} },
  { id: "materials", title: "Student materials fund", shortTitle: "Materials", description: "The everyday supplies that let every student join in, with no shopping list to take home.", budgetMinor: 90000, fundingState: "open", workState: "planned", evidenceAccepted: 0, evidenceRequired: 2, dependencies: [], category: "Keep curiosity going", icon: "box", zone:{packageId:"materials",points:[{x:.70,y:.82},{x:.95,y:.82},{x:.95,y:.94},{x:.70,y:.94}],label:{x:.825,y:.885}} },
];

export function sampleReceipt(tenantId: string, projectId: string, obligationId: string, packageId: string, amount: number, key: string, invoice = false): SettlementReceipt {
  return {
    id: `${projectId}-receipt-${key}`, tenantId, projectId, packageId, donorObligationId: obligationId,
    sourceKind: invoice ? "invoice_payment" : "orders_capture", provenance: "sample",
    actualProviderPaymentRef: `sample-payment-${key}`, economicAliases: [`sample:${projectId}:${key}`],
    sourceOrderId: invoice ? null : `sample-order-${key}`, sourceInvoiceId: invoice ? `sample-invoice-${key}` : null,
    authoritativeObservedState: "COMPLETED", observedAt: "2026-11-10T10:00:00.000Z", currency: "USD",
    grossSettledMinor: amount, creditedMinor: amount, completedAttributedRefundMinor: 0,
    pendingAttributedRefundReserveMinor: 0, excludedMinor: 0, excessLiabilityMinor: 0,
    provenRefundableRef: invoice ? null : `sample-payment-${key}`, refundAdapter: invoice ? "unqualified" : "capture_refund",
  };
}

export async function createProject(tx: SqlConnection, tenantId: string, projectId: string, slug: string, mode: "sample" | "live_sandbox"): Promise<void> {
  await tx.query("INSERT INTO fp_tenants(id,mode) VALUES($1,$2)", [tenantId,mode]);
  await tx.query("INSERT INTO fp_projects(id,tenant_id,slug,metadata) VALUES($1,$2,$3,$4::jsonb)", [projectId,tenantId,slug,JSON.stringify(publicMetadata)]);
  for (const item of packageSeeds) {
    const data = {...item, fundingState: mode === "sample" ? item.fundingState : "open"};
    await tx.query("INSERT INTO fp_packages(id,project_id,budget_minor,data) VALUES($1,$2,$3,$4::jsonb)", [item.id,projectId,item.budgetMinor,JSON.stringify(data)]);
  }
  if (mode === "live_sandbox") return;
  const labels = ["A neighbour", "A family", "A neighbour", "A family", "A local maker", "Dana", "A neighbour", "A family"];
  const amounts: {amount:number;packageId:string;label:string;collected:boolean;key:string}[] = HERO_OBLIGATION_AMOUNTS.map((amount,i) => ({amount,packageId:"electronics",label:labels[i],collected:i<7,key:`hero-${i+1}`}));
  amounts.push(...[
    {amount:120000,packageId:"printing",label:"The school community",collected:true,key:"printing"},
    {amount:42500,packageId:"woodworking",label:"The school community",collected:false,key:"woodworking"},
    {amount:168000,packageId:"safety",label:"The school community",collected:false,key:"safety"},
    {amount:20000,packageId:"laser",label:"The school community",collected:false,key:"laser"},
    {amount:45000,packageId:"materials",label:"The school community",collected:false,key:"materials"},
  ]);
  for (const [index, item] of amounts.entries()) {
    const id = `${projectId}-obligation-${item.key}`;
    const channel = item.collected ? "collected" : item.key === "hero-8" ? "definitively_declined" : "uncollected";
    const data = {donorLabel:item.label,provenance:"sample",consentPolicy:"Sample only — not an actual PayPal agreement."};
    await tx.query("INSERT INTO fp_obligations(id,tenant_id,project_id,package_id,actor_id,amount_minor,channel,purpose,data) VALUES($1,$2,$3,$4,$5,$6,$7,'conditional_pledge',$8::jsonb)", [id,tenantId,projectId,item.packageId,`sample-person-${index}`,item.amount,channel,JSON.stringify(data)]);
    const originalPackage=packageSeeds.find(pkg=>pkg.id===item.packageId)!;
    await recordSampleOrigin(tx,{tenantId,projectId,obligationId:id,packageId:item.packageId,packageVersion:1,donorActorId:`sample-person-${index}`,amountMinor:item.amount,title:originalPackage.title,purpose:originalPackage.description});
    if (item.collected) {
      const receipt = sampleReceipt(tenantId,projectId,id,item.packageId,item.amount,item.key);
      await tx.query("INSERT INTO fp_settlement_receipts(id,tenant_id,project_id,obligation_id,package_id,provider_ref,provenance,data) VALUES($1,$2,$3,$4,$5,$6,'sample',$7::jsonb)",[receipt.id,tenantId,projectId,id,item.packageId,receipt.actualProviderPaymentRef,JSON.stringify(receipt)]);
      await tx.query("INSERT INTO fp_economic_aliases(merchant_scope,alias,receipt_id) VALUES($1,$2,$3)",[tenantId,receipt.economicAliases[0],receipt.id]);
    }
  }
  const evidence: EvidenceItem[] = [
    { id:`${projectId}-receipt-maria`, title:"Maria's materials receipt", kind:"receipt", packageIds:["electronics","materials"], provenance:"sample", state:"pending_review", submittedBy:"Maria", amountMinor:8640, description:"Seven sample line items. Two packages. One uncertain description needs a person to check it.", reviewer:null, reviewedAt:null, assetPath:"/samples/maria-receipt.svg" },
    { id:`${projectId}-quote`, title:"Six soldering stations", kind:"quote", packageIds:["electronics"], provenance:"sample", state:"pending_review", submittedBy:"Ms. Okafor", amountMinor:96000, description:"Fictional supplier quote for the sample plan. A quote is budget evidence, not a purchase.",reviewer:null,reviewedAt:null,assetPath:null },
    { id:`${projectId}-safety`, title:"Ventilation signoff", kind:"signoff", packageIds:["safety","laser"], provenance:"sample", state:"pending_review", submittedBy:"Ms. Okafor", description:"A qualified reviewer must inspect the actual space. No physical signoff is claimed by this sample.",reviewer:null,reviewedAt:null,assetPath:null },
  ];
  for (const item of evidence) await tx.query("INSERT INTO fp_evidence(id,tenant_id,project_id,data) VALUES($1,$2,$3,$4::jsonb)",[item.id,tenantId,projectId,JSON.stringify(item)]);
  const events = [
    {type:"plan.published",title:"An idea gets a plan",detail:"Six work packages, with clear budgets and evidence requirements."},
    {type:"pledges.threshold",title:"Eight pledges. One shared goal.",detail:"The sample Electronics Benches commitments total exactly $960."},
    {type:"collection.recovering",title:"$35 still needs attention",detail:"Seven sample payments total $925. The final obligation is awaiting recovery."},
  ];
  for (const item of events) await tx.query("INSERT INTO fp_events(id,tenant_id,project_id,type,data) VALUES($1,$2,$3,$4,$5::jsonb)",[randomUUID(),tenantId,projectId,item.type,JSON.stringify({...item,provenance:"sample"})]);
}
export async function ensurePublicProject(): Promise<void> {
  await initializeDatabase();
  await database().transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(410202612)");
    if ((await query("SELECT id FROM fp_projects WHERE id=$1",[PUBLIC_PROJECT],tx)).length) return;
    if ((await runtimeControl(tx)).held) throw new DomainError("WORKSPACE_MAINTENANCE", "This preview is temporarily read-only. Existing private workspaces remain available.", 503);
    await createProject(tx,PUBLIC_TENANT,PUBLIC_PROJECT,"eastside-makerspace","sample");
  });
}
