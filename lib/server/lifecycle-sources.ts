import * as C from "../lifecycle/contracts";
import { aggregateLifecycleSnapshot, projectLifecycleSnapshot, withLifecycleOperationalFacts, verifyLifecycleSnapshot, type LifecycleOperationalFacts } from "../lifecycle/inbox";
import type { OrgPortfolioFilter } from "../organizations/contracts";
import { normalizeOrganizationPortfolioFilters } from "../organizations/portfolio-projection";
import { DomainError } from "../domain/money";
import { communitySource } from "./community-source";
import { query } from "./db";
import { assertOrganizationCurrent, orgHash, orgNow, requireOrganization, type OrgIdentity, type OrgTx } from "./organization-core";
import { assertOrganizationProjectCurrent, currentOrganizationLink, organizationLinkById, organizationProjectBasis, organizationProjectSummary, requireOrganizationProject, type CurrentOrgLink, type OrgLinkRow, type OrganizationProjectAuthority } from "./organization-projects";
import { collectOrganizationPortfolioSource, checkOrganizationPortfolioDependencies } from "./organization-portfolio";
import { collectOrganizationProjectAggregateDependencies, type OrganizationProjectAggregateDependencies } from "./organization-project-aggregate";
import { lifecycleCutoff, lifecycleTx, requireLifecycleOrganization, type LifecycleRequest } from "./lifecycle-core";

export interface LifecycleDocumentBinding { tenantId: string; projectId: string; id: string; version: number; contentHash: string; controlVersion: number; }
/** Encrypted server sidecar only. Source IDs, credential identities and private
 * document locations are never copied into a lifecycle DTO or model input. */
export interface LifecycleCapturedSource { snapshot: C.LifecycleSnapshot; dependencies: OrganizationProjectAggregateDependencies[]; documents: LifecycleDocumentBinding[]; }
/** Take this before any snapshot read. A first withdrawal inserts a control
 * row, so locking only an already-present row cannot protect an absent default
 * permission in repeatable read. Reads create no source controls. */
export async function lifecycleSourceTx<T>(work:(tx:OrgTx)=>Promise<T>,repeatable=true):Promise<T> {
  // A waiter in repeatable read can discover that another exact intent won
  // after its snapshot began. Retry only a server-rolled-back transaction,
  // once, with the same command. No provider or model work occurs here.
  for(let attempt=0;attempt<2;attempt++) {
    try { return await lifecycleTx(async tx=>{await tx.query("LOCK TABLE fp_plan_source_controls IN SHARE MODE");return work(tx);},repeatable); }
    catch(error) {
      const code=error&&typeof error==="object"&&"code" in error?String(error.code):"";
      if(attempt!==0||!["ORG_COMMAND_BUSY","23505"].includes(code))throw error;
    }
  }
  throw new DomainError("LIFECYCLE_BUSY","Keep the original request and recover its saved result before retrying.",409);
}
export const lifecyclePin = (current: CurrentOrgLink): C.LifecycleConsentPin => C.lifecycleConsentPinSchema.parse({ linkId: current.row.id, linkVersion: current.row.version, consentRevision: current.consent.revision,
  consentHash: current.consent.content_hash, expiresAt: current.consent.expires_at.toISOString(), disclosure: current.consent.disclosure });
const pinsEqual = (left: C.LifecycleConsentPin, right: C.LifecycleConsentPin) => orgHash({ ...left, disclosure: [...left.disclosure].sort() }) === orgHash({ ...right, disclosure: [...right.disclosure].sort() });

export async function lifecycleLinks(tx: OrgTx, identity: OrgIdentity, pins: readonly C.LifecycleConsentPin[], lock = false) {
  const links: CurrentOrgLink[] = [];
  for (const expected of [...pins].sort((a,b) => a.linkId.localeCompare(b.linkId))) {
    const row = await organizationLinkById(tx, expected.linkId, identity.organization.id, lock), current = await currentOrganizationLink(tx, row, lock);
    if (current.state !== "active" || !pinsEqual(expected, lifecyclePin(current))) throw new DomainError("LIFECYCLE_SOURCE_WITHDRAWN", "An exact original project disclosure changed or ended. A later consent cannot replace this schedule's original permission.", 410);
    links.push(current);
  }
  return links;
}
export async function lifecycleTargets(request: LifecycleRequest, audience: C.LifecycleSchedule["audience"], rawFilters?: OrgPortfolioFilter) {
  const captured = await lifecycleSourceTx(async tx => {
    const identity = await requireLifecycleOrganization(tx, request);
    if (audience === "project_treasurer") {
      if(!request.projectScope)throw new DomainError("LIFECYCLE_PROJECT_CHANGED","Keep the independently current project scope header before reading private schedule targets.",409);
      const project = await requireOrganizationProject(tx, request, request.projectScope);
      const [row] = await query<OrgLinkRow>("SELECT * FROM fp_org_project_links WHERE organization_id=$1 AND tenant_id=$2 AND project_id=$3", [identity.organization.id,project.session.tenantId,project.session.projectId],tx);
      const link = row ? await currentOrganizationLink(tx,row,true) : null;
      const targets = C.lifecycleTargetsSchema.parse({ scope: identity.scope, projectScope: project.scope, checkedAt: (await orgNow(tx)).toISOString(), audience,
        project: link?.state === "active" ? { project: await organizationProjectSummary(tx,project.session), projectBasis: await organizationProjectBasis(tx,project.session), link:lifecyclePin(link) } : null,
        aggregate:null, reasons:link?.state === "active" ? [] : ["Approve a current project disclosure using the separate original organizer and organization roles before scheduling."] });
      await assertOrganizationProjectCurrent(tx,request,project); await assertOrganizationCurrent(tx,request,identity);
      return { targets, original: identity, pins: link?.state === "active" ? [lifecyclePin(link)] : [] };
    }
    const filters = normalizeOrganizationPortfolioFilters(rawFilters ?? {templateIds:[],provenance:[],currencies:[],linkIds:[]});
    const rows = await query<OrgLinkRow>("SELECT * FROM fp_org_project_links WHERE organization_id=$1 ORDER BY id LIMIT 201",[identity.organization.id],tx);
    if(rows.length>200) throw new DomainError("LIFECYCLE_SOURCE_CHANGED","Narrow this organization to the supported two-hundred-disclosure boundary before reviewing a schedule.",422);
    const available: NonNullable<C.LifecycleTargets["aggregate"]>["availableLinks"] = [];
    for(const row of rows) { const current=await currentOrganizationLink(tx,row); if(current.state === "active") available.push({project:await organizationProjectSummary(tx,{tenantId:row.tenant_id,projectId:row.project_id}),link:lifecyclePin(current)}); }
    // Freeze All as the exact selected link set. Future affiliations cannot
    // join a previously reviewed scheduled audience.
    const initial = await collectOrganizationPortfolioSource(tx,identity,filters), ids=initial.snapshot.projects.filter(value=>value.project!==null).map(value=>value.linkId).sort();
    const fixed={...filters,linkIds:ids}, selected=available.filter(value=>ids.includes(value.link.linkId));
    const source=ids.length?await collectOrganizationPortfolioSource(tx,identity,fixed):null;
    const targets=C.lifecycleTargetsSchema.parse({scope:identity.scope,projectScope:null,checkedAt:(await orgNow(tx)).toISOString(),audience,project:null,
      aggregate:source&&selected.length?{basisHash:source.snapshot.basisHash,filters:fixed,links:selected.map(value=>value.link),availableLinks:available,notices:source.snapshot.notices}:null,
      reasons:selected.length?[]:["No currently approved project aggregate matches this exact filter. Missing disclosure does not become zero."]});
    await assertOrganizationCurrent(tx,request,identity);return {targets,original:identity,pins:selected.map(value=>value.link)};
  },true);
  return lifecycleSourceTx(async tx=>{
    const identity=await requireLifecycleOrganization(tx,request);
    if(identity.scope!==captured.original.scope)throw new DomainError("LIFECYCLE_ORGANIZATION_CHANGED","The original organization profile changed while targets were prepared.",409);
    await lifecycleLinks(tx,identity,captured.pins,true); await assertOrganizationCurrent(tx,request,identity);
    if(audience==="project_treasurer")await requireOrganizationProject(tx,request,request.projectScope);
    return {targets:captured.targets};
  },false);
}
async function privateClaimDocuments(tx:OrgTx,project:OrganizationProjectAuthority):Promise<LifecycleDocumentBinding[]> {
  const rows=await query<{id:string;version:number;sha256:string|null;state:string;control_version:number;permission:string}>(`SELECT DISTINCT d.id,d.version,d.sha256,d.state,COALESCE(c.version,0) control_version,COALESCE(c.permission,'allowed') permission
    FROM fp_claims cl JOIN fp_documents d ON d.id=cl.document_id AND d.tenant_id=cl.tenant_id AND d.project_id=cl.project_id
    LEFT JOIN fp_plan_source_controls c ON c.document_id=d.id AND c.tenant_id=d.tenant_id AND c.project_id=d.project_id
    WHERE cl.tenant_id=$1 AND cl.project_id=$2 ORDER BY d.id`,[project.session.tenantId,project.session.projectId],tx);
  if(rows.some(row=>row.state!=="ready"||!row.sha256||row.permission!=="allowed"))throw new DomainError("LIFECYCLE_SOURCE_WITHDRAWN","A receipt source used by the private expense summary is no longer permitted. Its earlier private values are withheld.",410);
  return rows.map(row=>({tenantId:project.session.tenantId,projectId:project.session.projectId,id:row.id,version:row.version,contentHash:row.sha256!,controlVersion:row.control_version}));
}
async function operationalFacts(tx:OrgTx,project:OrganizationProjectAuthority,source:Awaited<ReturnType<typeof communitySource>>):Promise<LifecycleOperationalFacts> {
  const scope=[project.session.tenantId,project.session.projectId],asOf=source.capturedAt,at=Date.parse(asOf),horizon=at+24*3600_000;
  const payables=await query<{id:string;state:string;principal_paid_at:Date|null;principal_returned_at:Date|null;fee_state:string;last_code:string|null;observed_at:Date|null}>("SELECT id,state,principal_paid_at,principal_returned_at,fee_state,last_code,observed_at FROM fp_payables WHERE tenant_id=$1 AND project_id=$2 ORDER BY id",scope,tx);
  const legacy=await query<{id:string;status:string;expires_at:Date;withdrawn_at:Date|null}>("SELECT id,status,expires_at,withdrawn_at FROM fp_conditional_consents WHERE tenant_id=$1 AND project_id=$2 ORDER BY id",scope,tx);
  const purpose=await query<{id:string;state:string;expires_at:Date;amount_minor:string;collected_minor:string}>("SELECT id,state,expires_at,amount_minor,collected_minor FROM fp_purpose_pledges WHERE tenant_id=$1 AND project_id=$2 ORDER BY id",scope,tx);
  const commands=await query<{operation_id:string;reconciliation_code:string|null;reconciled_at:Date|null}>("SELECT operation_id,reconciliation_code,reconciled_at FROM fp_payment_commands WHERE tenant_id=$1 AND project_id=$2 ORDER BY operation_id",scope,tx);
  const holds=await query<{id:string;state:string}>("SELECT id,state FROM fp_funding_return_holds WHERE tenant_id=$1 AND project_id=$2 ORDER BY id",scope,tx);
  const adjustments=await query<{id:string;state:string;expires_at:Date}>("SELECT id,state,expires_at FROM fp_funding_reconciliations WHERE tenant_id=$1 AND project_id=$2 ORDER BY id",scope,tx);
  const unresolved=payables.filter(row=>!row.principal_paid_at&&!row.principal_returned_at&&!["failed","cancelled","returned"].includes(row.state));
  const expiringLegacy=legacy.filter(row=>!row.withdrawn_at&&!["collected","refunded","refunding","cancelled"].includes(row.status)&&row.expires_at.getTime()>at&&row.expires_at.getTime()<=horizon);
  const expiringPurpose=purpose.filter(row=>!["withdrawn","cancelled","expired","returned","collected"].includes(row.state)&&Number(row.amount_minor)>Number(row.collected_minor)&&row.expires_at.getTime()>at&&row.expires_at.getTime()<=horizon);
  const exceptions=commands.filter(row=>!!row.reconciliation_code).length+holds.filter(row=>row.state==="held").length+adjustments.filter(row=>row.state==="awaiting_donors").length+payables.filter(row=>["unknown","blocked","review_required","refused","not_sent"].includes(row.state)||row.fee_state==="review_required").length;
  const complete=(scopeLabel:string,count:number,records:unknown[],basis:unknown=records)=>({state:"available" as const,count,sourceHash:orgHash(basis),scopeLabel,complete:true,includedRecords:records.length,denominatorRecords:records.length,reason:null});
  const plan=source.rows.find(row=>row.id==="evidence:plan"),required=plan?.fields.requiredReviewCount,accepted=plan?.fields.acceptedReviewCount;
  const missing=plan?.fields.state==="current"&&typeof required==="number"&&typeof accepted==="number"&&accepted<=required
    ? {state:"available" as const,count:required-accepted,sourceHash:plan.hash,scopeLabel:"All required review slots in the current published project plan",complete:true,includedRecords:required,denominatorRecords:required,reason:null}
    : {state:"unavailable" as const,count:null,sourceHash:null,scopeLabel:"Current published plan review requirements",complete:false,includedRecords:null,denominatorRecords:null,reason:"A current published plan with a valid requirement denominator is needed; missing evidence is not inferred as zero."};
  return {asOf,unsettledRepayments:complete("All original project repayment records; unresolved principal",unresolved.length,payables),missingEvidence:missing,
    expiringConsents:{...complete("Original collection consents and named-purpose unpaid pledge deadlines",expiringLegacy.length+expiringPurpose.length,[...legacy,...purpose],{legacy,purpose,nearLegacy:expiringLegacy.map(row=>row.id),nearPurpose:expiringPurpose.map(row=>row.id),withinHours:24}),withinHours:24,legacyIncluded:true,purposePledgesIncluded:true},
    reconciliationExceptions:{...complete("Stored payment-command errors, return holds, donor adjustments and repayment exceptions",exceptions,[...commands,...holds,...adjustments,...payables]),providerLag:"Stored observations only: this draft makes no provider request. Reconciliation or delivery states may lag the provider; a pending or unknown result remains unconfirmed."}};
}
export async function collectLifecycleSource(tx:OrgTx,identity:OrgIdentity,request:LifecycleRequest,proposal:C.LifecycleScheduleProposal):Promise<LifecycleCapturedSource> {
  const target=proposal.target,pins=target.kind==="project_treasurer"?[target.link]:target.links,links=await lifecycleLinks(tx,identity,pins),asOf=await lifecycleCutoff(tx);
  if(target.kind==="organization_aggregate") {
    if(orgHash([...target.filters.linkIds].sort())!==orgHash(pins.map(pin=>pin.linkId).sort()))throw new DomainError("LIFECYCLE_SOURCE_CHANGED","An aggregate schedule must pin every exact filtered disclosure; future affiliations cannot widen it.",409);
    const collected=await collectOrganizationPortfolioSource(tx,identity,target.filters);
    return {snapshot:aggregateLifecycleSnapshot({organizationName:identity.organization.name,snapshot:collected.snapshot,links:pins,topics:proposal.topics}),dependencies:collected.dependencies,documents:[]};
  }
  const project=await requireOrganizationProject(tx,request,target.expectedProjectScope),link=links[0];
  if(project.session.projectId!==target.projectId||link.row.project_id!==target.projectId||link.row.tenant_id!==project.session.tenantId)throw new DomainError("LIFECYCLE_PROJECT_CHANGED","The original private project and disclosure must match the independent organizer profile.",409);
  const documents=proposal.topics.includes("expenses")?await privateClaimDocuments(tx,project):[];
  const source=await communitySource(project.session,"treasurer",tx),snapshot=withLifecycleOperationalFacts(projectLifecycleSnapshot({project:await organizationProjectSummary(tx,project.session),source,topics:proposal.topics}),await operationalFacts(tx,project,source),proposal.topics);
  // Captured under the independently held organizer session. This sidecar is
  // never an organization DTO or an extension of aggregate disclosure.
  const sections=proposal.topics.filter(topic=>["budget","funding","expenses","evidence"].includes(topic)) as ("budget"|"funding"|"expenses"|"evidence")[];
  const dependencies=await collectOrganizationProjectAggregateDependencies(tx,{tenantId:project.session.tenantId,projectId:project.session.projectId,linkId:link.row.id,linkVersion:link.row.version,consentRevision:link.consent.revision,consentHash:link.consent.content_hash,consentExpiresAt:link.consent.expires_at.toISOString(),disclosure:sections.length?sections:["budget"],asOf});
  await assertOrganizationProjectCurrent(tx,request,project);return {snapshot,dependencies:[dependencies],documents};
}
export async function checkLifecycleSource(tx:OrgTx,identity:OrgIdentity,captured:LifecycleCapturedSource):Promise<string[]> {
  verifyLifecycleSnapshot(captured.snapshot);
  const reasons=await checkOrganizationPortfolioDependencies(tx,identity,captured.dependencies);
  for(const source of captured.documents) {
    const [row]=await query<{version:number;state:string;sha256:string|null}>("SELECT version,state,sha256 FROM fp_documents WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR SHARE",[source.id,source.tenantId,source.projectId],tx);
    const [control]=await query<{version:number;permission:string}>("SELECT version,permission FROM fp_plan_source_controls WHERE document_id=$1 AND tenant_id=$2 AND project_id=$3 FOR SHARE",[source.id,source.tenantId,source.projectId],tx);
    if(!row||row.state!=="ready"||row.version!==source.version||row.sha256!==source.contentHash||(control?.version??0)!==source.controlVersion||control?.permission==="withdrawn")reasons.push("An original counted private receipt source changed or its permission was withdrawn.");
  }
  return [...new Set(reasons)];
}
