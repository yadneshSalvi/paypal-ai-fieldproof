import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import * as C from "../organizations/contracts";
import type { SettlementReceipt } from "../contracts";
import { templateForPackages } from "../community/templates";
import { projectFundingPositions } from "../domain/funding-positions";
import { DomainError, assertMinor, validateReceipt } from "../domain/money";
import { currentPledgeCommitment } from "../funding/pledges";
import { query } from "./db";
import { readFundingJournal } from "./funding-positions";
import { readFundingPromises } from "./funding-promises";
import { pledgeContract, type PledgeRow } from "./purpose-store";
import { loadOrganizationPlanningAggregate, type OrganizationPlanningDependencies } from "./organization-planning-aggregate";

export const organizationProjectAggregateInputSchema = z.object({
  tenantId: z.string().min(1).max(160), projectId: z.string().min(1).max(160),
  linkId: z.uuid(), linkVersion: z.number().int().positive(), consentRevision: z.number().int().positive(),
  consentHash: z.string().regex(/^[a-f0-9]{64}$/), consentExpiresAt: z.iso.datetime(),
  disclosure: z.array(C.orgDisclosureSectionSchema).min(1).max(4).refine(values => new Set(values).size === values.length), asOf: z.iso.datetime(),
}).strict();
export type OrganizationProjectAggregateInput = z.infer<typeof organizationProjectAggregateInputSchema>;
export interface OrganizationExpenseDocumentDependency { id: string; version: number; contentHash: string | null; controlVersion: number; }
/** Private capture sidecar. Persist only in the authorized encrypted envelope;
 * never include it in any organization desk/report/detail/CSV response. */
export interface OrganizationProjectAggregateDependencies {
  version: "organization-project-dependencies-v1"; tenantId: string; projectId: string; linkId: string;
  consentRevision: number; consentHash: string; planning: OrganizationPlanningDependencies | null;
  expenseDocuments: OrganizationExpenseDocumentDependency[];
}
interface ProjectRow { id: string; tenant_id: string; version: number; projection_version: number; metadata: Record<string, unknown>; mode: "sample" | "live_sandbox"; event_cursor: string; }
interface PackageRow { id: string; version: number; budget_minor: string; data: { title?: string; evidenceRequired?: number }; }
interface ReceiptRow { id: string; tenant_id: string; project_id: string; package_id: string; obligation_id: string; purpose: string | null; data: SettlementReceipt; }
interface ObligationRow { id: string; package_id: string; amount_minor: string; channel: string; eligible: boolean | null; current_version: number; package_version: number | null; status: string | null; withdrawn_at: Date | null; expires_at: Date | null; round_id: string | null; original_paid: string; current_policy: boolean; has_receipt: boolean; }
const parameters = (input: Pick<OrganizationProjectAggregateInput, "tenantId" | "projectId">) => [input.tenantId, input.projectId];
const digest = (value: unknown) => sha256(canonicalJson(value));
function minor(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) throw new DomainError("ORG_PROJECT_SOURCE_CHANGED", "A recorded aggregate amount is unavailable.");
  const amount = Number(value); assertMinor(amount); return amount;
}
function total(values: readonly number[]): number { let amount = 0; for (const value of values) { assertMinor(value); amount += value; assertMinor(amount); } return amount; }
function hidden(input: OrganizationProjectAggregateInput, state: "expired" | "unavailable", reason: string): C.OrgPortfolioProject {
  return C.orgPortfolioProjectSchema.parse({ linkId: input.linkId, linkVersion: input.linkVersion, consentRevision: input.consentRevision, state, project: null, lineage: null, disclosedSections: input.disclosure, budget: null, money: [], evidence: [], reasons: [reason], notices: [] });
}
async function assertCutoff(tx: SqlConnection, input: OrganizationProjectAggregateInput): Promise<void> {
  const [row] = await query<{ as_of: Date; isolation: string }>("SELECT transaction_timestamp() AS as_of,current_setting('transaction_isolation') AS isolation", [], tx);
  if (!row || !["repeatable read", "serializable"].includes(row.isolation) || row.as_of.getTime() !== Date.parse(input.asOf)) throw new DomainError("ORG_PROJECT_SOURCE_CHANGED", "This aggregate needs its exact coherent project cutoff. Review the current scope again.");
}
async function fundingFacts(tx: SqlConnection, input: OrganizationProjectAggregateInput, mode: ProjectRow["mode"], packages: PackageRow[]): Promise<C.OrgPortfolioFunding> {
  const scope = { tenantId: input.tenantId, projectId: input.projectId, provenance: mode }, journal = await readFundingJournal(scope, tx), projection = projectFundingPositions(journal, scope);
  const receipts = await query<ReceiptRow>(`SELECT r.id,r.tenant_id,r.project_id,r.package_id,r.obligation_id,o.purpose,r.data FROM fp_settlement_receipts r
    LEFT JOIN fp_obligations o ON o.id=r.obligation_id AND o.tenant_id=r.tenant_id AND o.project_id=r.project_id
    WHERE r.tenant_id=$1 AND r.project_id=$2 ORDER BY r.id`, parameters(input), tx);
  const aliases = new Set<string>();
  for (const row of receipts) {
    validateReceipt(row.data);
    if (row.tenant_id !== input.tenantId || row.project_id !== input.projectId || row.data.tenantId !== input.tenantId || row.data.projectId !== input.projectId || row.data.provenance !== mode || row.id !== row.data.id || row.package_id !== row.data.packageId || row.obligation_id !== row.data.donorObligationId || !["conditional_pledge", "sandbox_test"].includes(row.purpose ?? "")) throw new DomainError("ORG_PROJECT_SOURCE_CHANGED", "A recorded receipt no longer matches its exact project identity.");
    for (const alias of row.data.economicAliases) { if (aliases.has(alias)) throw new DomainError("DUPLICATE_PAYMENT_ALIAS", "A portfolio cannot count an economic receipt twice."); aliases.add(alias); }
  }
  const promises = await readFundingPromises({ tenantId: input.tenantId, projectId: input.projectId, mode }, tx, Date.parse(input.asOf));
  const pledges = await query<PledgeRow>("SELECT * FROM fp_purpose_pledges WHERE tenant_id=$1 AND project_id=$2 ORDER BY id", parameters(input), tx);
  const obligations = await query<ObligationRow>(`SELECT o.id,o.package_id,o.amount_minor,o.channel,(o.data->>'eligible')::boolean eligible,p.version current_version,
    c.package_version,c.status,c.withdrawn_at,c.expires_at,c.round_id,
    EXISTS(SELECT 1 FROM fp_funding_policies f WHERE f.tenant_id=o.tenant_id AND f.project_id=o.project_id AND f.package_id=o.package_id AND f.package_version=p.version) current_policy,
    EXISTS(SELECT 1 FROM fp_settlement_receipts r WHERE r.tenant_id=o.tenant_id AND r.project_id=o.project_id AND r.obligation_id=o.id) has_receipt,
    COALESCE((SELECT sum((r.data->>'creditedMinor')::bigint) FROM fp_settlement_receipts r WHERE r.tenant_id=o.tenant_id AND r.project_id=o.project_id AND r.obligation_id=o.id),0) original_paid
    FROM fp_obligations o JOIN fp_packages p ON p.project_id=o.project_id AND p.id=o.package_id
    LEFT JOIN fp_conditional_consents c ON c.obligation_id=o.id AND c.tenant_id=o.tenant_id AND c.project_id=o.project_id
    WHERE o.tenant_id=$1 AND o.project_id=$2 AND o.purpose='conditional_pledge' ORDER BY o.id`, parameters(input), tx);
  const pledgeObligations = new Set<string>(), unpaid: number[] = [], sponsor: number[] = [], at = Date.parse(input.asOf);
  for (const row of pledges) {
    if (row.tenant_id !== input.tenantId || row.project_id !== input.projectId) throw new DomainError("ORG_PROJECT_SOURCE_CHANGED", "A pledge no longer matches its original project.");
    const value = pledgeContract(row); if (value.provenance !== mode || value.currency !== "USD") throw new DomainError("ORG_PROJECT_SOURCE_CHANGED", "Pledge provenance or currency does not match its project.");
    pledgeObligations.add(row.obligation_id); const pkg = packages.find(item => item.id === row.package_id), collected = minor(row.collected_minor);
    const amount = pkg?.version === value.packageVersion ? Math.max(0, currentPledgeCommitment({ state: row.state, amountMinor: value.amountMinor, collectedMinor: collected, expiresAt: value.expiresAt, operationId: row.operation_id }, at) - collected) : 0;
    unpaid.push(amount); if (value.kind !== "donor") sponsor.push(amount);
  }
  for (const row of obligations) {
    if (pledgeObligations.has(row.id)) continue;
    const eligible = mode === "sample" ? row.eligible !== false && !["withdrawn", "cancelled", "refunded"].includes(row.channel) && (!row.current_policy || row.has_receipt) : !!row.eligible && !row.withdrawn_at && row.package_version === row.current_version && ["ready", "collecting", "collected"].includes(row.status ?? "") && !!(row.round_id || row.expires_at && row.expires_at.getTime() > at);
    if (eligible) unpaid.push(Math.max(0, minor(row.amount_minor) - minor(row.original_paid)));
  }
  const sumReceipt = (value: (row: ReceiptRow) => number) => total(receipts.map(value));
  return C.orgPortfolioFundingSchema.parse({
    originalGrossMinor: sumReceipt(row => row.data.grossSettledMinor), originalCreditedMinor: sumReceipt(row => row.data.creditedMinor),
    ordersGrossMinor: sumReceipt(row => row.data.sourceKind === "orders_capture" ? row.data.grossSettledMinor : 0), invoiceGrossMinor: sumReceipt(row => row.data.sourceKind === "invoice_payment" ? row.data.grossSettledMinor : 0), testGrossMinor: sumReceipt(row => row.purpose === "sandbox_test" ? row.data.grossSettledMinor : 0),
    returnedMinor: sumReceipt(row => row.data.completedAttributedRefundMinor), pendingReturnMinor: sumReceipt(row => row.data.pendingAttributedRefundReserveMinor), excludedMinor: sumReceipt(row => row.data.excludedMinor), excessLiabilityMinor: sumReceipt(row => row.data.excessLiabilityMinor),
    currentAssignedMinor: total(projection.positions.map(row => row.assignedMinor)), currentCollectedMinor: projection.totals.collectedMinor, eligibleMinor: projection.totals.fundingEligibleMinor,
    paidMinor: projection.paidMinor, reservedMinor: projection.reservedMinor, availableMinor: projection.availableMinor,
    originalCommitmentRecordMinor: total([...promises.values()]), unpaidCommitmentMinor: total(unpaid), acceptedSponsorUnpaidMinor: total(sponsor),
  });
}

interface ExpenseSource { claim_id: string; currency: string | null; reviewed_at: Date | null; has_current_review: boolean; document_id: string; document_version: number; document_hash: string | null; document_state: string; control_version: number | null; permission: string | null; }
interface PayableFact { id: string; claim_id: string; amount_minor: string; actual_fee_minor: string | null; fee_state: string; last_code: string | null; principal_paid_at: Date | null; principal_returned_at: Date | null; first_dispatched_at: Date | null; observed_at: Date | null; }
async function expenseFacts(tx: SqlConnection, input: OrganizationProjectAggregateInput): Promise<{ values: C.OrgPortfolioExpenses; documents: OrganizationExpenseDocumentDependency[] }> {
  const sources = await query<ExpenseSource>(`SELECT c.id claim_id,c.currency,c.reviewed_at,
    EXISTS(SELECT 1 FROM fp_claim_line_reviews l WHERE l.claim_id=c.id AND l.review_version=c.version) has_current_review,
    d.id document_id,d.version document_version,d.sha256 document_hash,d.state document_state,s.version control_version,s.permission
    FROM fp_claims c JOIN fp_documents d ON d.id=c.document_id AND d.tenant_id=c.tenant_id AND d.project_id=c.project_id
    LEFT JOIN fp_plan_source_controls s ON s.document_id=d.id AND s.tenant_id=d.tenant_id AND s.project_id=d.project_id
    WHERE c.tenant_id=$1 AND c.project_id=$2 AND (
      c.reviewed_at IS NOT NULL OR EXISTS(SELECT 1 FROM fp_payables p WHERE p.claim_id=c.id AND p.tenant_id=c.tenant_id AND p.project_id=c.project_id)
      OR EXISTS(SELECT 1 FROM fp_receipt_allocations a WHERE a.claim_id=c.id AND a.tenant_id=c.tenant_id AND a.project_id=c.project_id AND a.state IN ('reserved','paid')))
    ORDER BY c.id`, parameters(input), tx);
  if (sources.some(source => source.document_state !== "ready" || !source.document_hash || source.permission === "withdrawn")) throw new DomainError("ORG_SOURCE_UNAVAILABLE", "An expense source or its current disclosure permission is unavailable; no expense total was substituted.");
  const reviews = await query<{ claim_id: string; approved_minor: string }>(`SELECT l.claim_id,l.approved_minor FROM fp_claim_line_reviews l
    JOIN fp_claims c ON c.id=l.claim_id JOIN fp_packages p ON p.project_id=c.project_id AND p.id=l.package_id
    WHERE c.tenant_id=$1 AND c.project_id=$2 AND c.currency='USD' AND c.reviewed_at IS NOT NULL
      AND l.review_version=c.version AND l.decision='approved' ORDER BY l.claim_id,l.claim_line_id`, parameters(input), tx);
  const allocations = await query<{ claim_id: string; kind: string; state: string; amount_minor: string }>(`SELECT a.claim_id,a.kind,a.state,a.amount_minor FROM fp_receipt_allocations a
    JOIN fp_settlement_receipts r ON r.id=a.receipt_id AND r.tenant_id=a.tenant_id AND r.project_id=a.project_id
    JOIN fp_obligations o ON o.id=r.obligation_id AND o.tenant_id=r.tenant_id AND o.project_id=r.project_id
    JOIN fp_claims c ON c.id=a.claim_id AND c.tenant_id=a.tenant_id AND c.project_id=a.project_id
    WHERE a.tenant_id=$1 AND a.project_id=$2 AND o.purpose='conditional_pledge' AND a.state IN ('reserved','paid') ORDER BY a.id`, parameters(input), tx);
  const payables = await query<PayableFact>(`SELECT p.id,p.claim_id,p.amount_minor,p.actual_fee_minor,p.fee_state,p.last_code,p.principal_paid_at,p.principal_returned_at,p.first_dispatched_at,p.observed_at
    FROM fp_payables p JOIN fp_claims c ON c.id=p.claim_id AND c.tenant_id=p.tenant_id AND c.project_id=p.project_id
    WHERE p.tenant_id=$1 AND p.project_id=$2 ORDER BY p.id`, parameters(input), tx);
  const documentMap = new Map<string, OrganizationExpenseDocumentDependency>();
  const checkedClaims = new Set(sources.map(source => source.claim_id));
  if ([...reviews, ...allocations, ...payables].some(row => !checkedClaims.has(row.claim_id))) throw new DomainError("ORG_SOURCE_UNAVAILABLE", "A recorded expense has no permitted source in its exact project scope.");
  for (const source of sources) {
    const binding = { id: source.document_id, version: source.document_version, contentHash: source.document_hash, controlVersion: source.control_version ?? 0 }, prior = documentMap.get(source.document_id);
    if (prior && canonicalJson(prior) !== canonicalJson(binding)) throw new DomainError("ORG_PROJECT_SOURCE_CHANGED", "An expense source has conflicting current bindings.");
    documentMap.set(source.document_id, binding);
  }
  const sumAllocated = (kind: string, state: string) => total(allocations.filter(row => row.kind === kind && row.state === state).map(row => minor(row.amount_minor)));
  return { values: C.orgPortfolioExpensesSchema.parse({
    approvedExpenseMinor: total(reviews.map(row => minor(row.approved_minor))),
    deliveredPrincipalMinor: total(payables.filter(row => row.principal_paid_at && !row.principal_returned_at).map(row => minor(row.amount_minor))),
    returnedPrincipalMinor: total(payables.filter(row => row.principal_paid_at && row.principal_returned_at).map(row => minor(row.amount_minor))),
    undeliveredPrincipalMinor: total(payables.filter(row => !row.principal_paid_at && row.principal_returned_at).map(row => minor(row.amount_minor))),
    paidPrincipalMinor: sumAllocated("claim", "paid"), knownPaidFeeMinor: total(payables.filter(row => row.actual_fee_minor !== null && row.last_code !== "PAYOUT_FEE_CHANGED").map(row => minor(row.actual_fee_minor))),
    unobservedFeeCount: payables.filter(row => row.last_code === "PAYOUT_FEE_CHANGED" || row.actual_fee_minor === null && !!(row.principal_paid_at || row.principal_returned_at || row.first_dispatched_at || row.observed_at)).length,
    reservedPrincipalMinor: sumAllocated("claim", "reserved"), reservedFeeMinor: sumAllocated("fee", "reserved"),
    claimCount: new Set(sources.filter(row => row.currency === "USD" && row.reviewed_at && row.has_current_review).map(row => row.claim_id)).size,
  }), documents: [...documentMap.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}

async function enforcedPolicyRevisions(tx: SqlConnection, input: OrganizationProjectAggregateInput, publication: NonNullable<OrganizationPlanningDependencies["publication"]>): Promise<C.OrgPortfolioEvidence["policyRevisions"]> {
  const rows = await query<{ policy_id: string; revision: number; content_hash: string }>(`SELECT DISTINCT v.policy_id,v.revision,v.content_hash
    FROM fp_project_policy_adoptions a
    JOIN fp_org_project_links l ON l.id=a.link_id AND l.organization_id=a.source_organization_id AND l.tenant_id=a.tenant_id AND l.project_id=a.project_id
    JOIN fp_org_policy_versions v ON v.id=a.source_policy_version_id AND v.policy_id=a.source_policy_id AND v.organization_id=a.source_organization_id
    WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.link_id=$3 AND l.version=$4
      AND a.origin='organization_adoption' AND a.state IN ('materialized','applied') AND a.superseded_by IS NULL AND a.deactivated_at IS NULL
      AND EXISTS(SELECT 1 FROM fp_project_policy_artifacts f WHERE f.adoption_id=a.id AND f.tenant_id=a.tenant_id AND f.project_id=a.project_id
        AND f.adoption_head=a.adoption_head AND f.consumer='plan_publication' AND f.state='enforced' AND f.artifact_id=$5 AND f.artifact_hash=$6)
    ORDER BY v.policy_id,v.revision`, [...parameters(input), input.linkId, input.linkVersion, publication.publicationId, publication.contentHash], tx);
  // Retirement prevents a new adoption. It does not erase an immutable rule
  // already enforced by this exact current publication and adoption head.
  return rows.map(row => ({ policyId: row.policy_id, revision: row.revision, contentHash: row.content_hash }));
}

interface AggregateBundle { aggregate: C.OrgPortfolioProject; dependencies: OrganizationProjectAggregateDependencies; }
async function loadBundle(tx: SqlConnection, raw: OrganizationProjectAggregateInput): Promise<AggregateBundle> {
  const input = organizationProjectAggregateInputSchema.parse(raw);
  const dependencies: OrganizationProjectAggregateDependencies = { version: "organization-project-dependencies-v1", tenantId: input.tenantId, projectId: input.projectId, linkId: input.linkId, consentRevision: input.consentRevision, consentHash: input.consentHash, planning: null, expenseDocuments: [] };
  await assertCutoff(tx, input);
  if (Date.parse(input.consentExpiresAt) <= Date.parse(input.asOf)) return { aggregate: hidden(input, "expired", "This disclosure's fixed original deadline ended. A new consent review is required."), dependencies };
  const [project] = await query<ProjectRow>(`SELECT p.id,p.tenant_id,p.version,p.projection_version,p.metadata,t.mode,
    (SELECT COALESCE(max(sequence),0) FROM fp_events WHERE tenant_id=$1 AND project_id=$2) event_cursor
    FROM fp_projects p JOIN fp_tenants t ON t.id=p.tenant_id WHERE p.tenant_id=$1 AND p.id=$2`, parameters(input), tx);
  if (!project) return { aggregate: hidden(input, "unavailable", "The exact linked project is unavailable; no project amounts or private source details were substituted."), dependencies };
  const packages = await query<PackageRow>(`SELECT p.id,p.version,p.budget_minor,p.data FROM fp_packages p
    JOIN fp_projects j ON j.id=p.project_id WHERE j.tenant_id=$1 AND j.id=$2 ORDER BY p.id`, parameters(input), tx);
  const summary = C.orgProjectSummarySchema.safeParse({ id: project.id, title: project.metadata.title, templateId: project.metadata.templateId ?? templateForPackages(packages.map(row => row.id))?.id, currency: project.metadata.currency, mode: project.mode });
  if (project.tenant_id !== input.tenantId || project.id !== input.projectId || !summary.success) return { aggregate: hidden(input, "unavailable", "The linked project metadata or currency/provenance identity is unavailable; no default project identity was inferred."), dependencies };
  const packageHash = digest({ tenantId: input.tenantId, projectId: input.projectId, packages }), reasons: string[] = [], notices: string[] = [
    "Only this link's approved aggregate sections are disclosed. Organization affiliation supplies no project role, private source access or pooled funds.",
    "Original contribution receipts, current assigned funding and unpaid promises overlap; they are not additive. A sponsor promise is a subset of unpaid commitments.",
  ];
  let budget: C.OrgPortfolioProject["budget"] = null, funding: C.OrgPortfolioFunding | null = null, expenses: C.OrgPortfolioExpenses | null = null;
  const evidence: C.OrgPortfolioProject["evidence"] = [];
  // Existing canonical package/funding/expense records are denominated in USD.
  // An unsupported metadata currency cannot relabel or convert those records.
  if (summary.data.currency !== "USD" && input.disclosure.some(section => section !== "evidence")) reasons.push("Canonical money in this reader is recorded in USD. The project's different currency is not converted or relabelled; those approved money sections are unavailable.");
  if (summary.data.currency === "USD") {
    if (input.disclosure.includes("budget")) budget = { currency: "USD", provenance: project.mode, amountMinor: total(packages.map(row => minor(row.budget_minor))), packageCount: packages.length, basis: "current_canonical_packages" };
    if (input.disclosure.includes("funding")) funding = await fundingFacts(tx, input, project.mode, packages);
    if (input.disclosure.includes("expenses")) {
      try { const value = await expenseFacts(tx, input); expenses = value.values; dependencies.expenseDocuments = value.documents; }
      catch (error) { if (!(error instanceof DomainError) || error.code !== "ORG_SOURCE_UNAVAILABLE") throw error; reasons.push("The approved expense section has an unavailable or withdrawn source. No expense value was replaced by zero."); }
    }
  }
  let planningHash: string | null = null, planRevision: number | null = null, planHash: string | null = null;
  if (input.disclosure.includes("evidence")) {
    const planning = await loadOrganizationPlanningAggregate(tx, input, input.asOf, packages.map(row => ({ packageId: row.id, requiredCount: minor(row.data.evidenceRequired) })));
    planningHash = planning.sourceVersionHash;
    if (planning.available) {
      dependencies.planning = planning.dependencies; planRevision = planning.planRevision; planHash = planning.planHash;
      evidence.push({ provenance: project.mode, values: C.orgPortfolioEvidenceSchema.parse({ acceptedReviewItems: planning.acceptedReviewItems, requiredReviewItems: planning.requiredReviewItems, acceptedPackages: planning.acceptedPackages, packageCount: planning.packageCount, currentScopedSignoffs: planning.currentScopedSignoffs, reviewedIllustrations: planning.reviewedIllustrations, planRevision, policyRevisions: planning.dependencies.publication ? await enforcedPolicyRevisions(tx, input, planning.dependencies.publication) : [], limitations: planning.limitations }) });
    } else reasons.push("The approved evidence section has a stale or withdrawn plan/source binding. It is omitted rather than represented as zero current acceptance.");
  }
  const lineage = { asOf: input.asOf, aggregateHash: "0".repeat(64), projectVersion: project.version, projectionVersion: project.projection_version, eventCursor: minor(project.event_cursor), planRevision, planHash, packageHash, disclosureRevision: input.consentRevision, disclosureHash: input.consentHash, disclosureExpiresAt: input.consentExpiresAt };
  const aggregate = C.orgPortfolioProjectSchema.parse({ linkId: input.linkId, linkVersion: input.linkVersion, consentRevision: input.consentRevision, state: reasons.length ? "partial" : "included", project: summary.data, lineage, disclosedSections: input.disclosure, budget, money: funding || expenses ? [{ currency: "USD", provenance: project.mode, funding, expenses }] : [], evidence, reasons, notices });
  aggregate.lineage!.aggregateHash = digest({ semantics: "organization-project-aggregate-v1", tenantId: input.tenantId, projectId: input.projectId, ...aggregate, lineage: { ...aggregate.lineage, asOf: undefined, aggregateHash: undefined }, planningHash });
  return { aggregate, dependencies };
}

/** Aggregate projection only. The caller must validate/lock exact organization
 * authority and original project consent before this repeatable-read snapshot,
 * and recheck current authority/source permissions after serialization. This
 * helper issues no membership, session, source-control row or payment command. */
export async function loadOrganizationProjectAggregate(tx: SqlConnection, input: OrganizationProjectAggregateInput): Promise<C.OrgPortfolioProject> {
  return (await loadBundle(tx, input)).aggregate;
}

/** Capture-time private sidecar, intentionally separate from the public DTO.
 * Call in the same coherent transaction as the aggregate. The consumer must
 * persist it only encrypted and use its original bindings for future checks. */
export async function collectOrganizationProjectAggregateDependencies(tx: SqlConnection, input: OrganizationProjectAggregateInput): Promise<OrganizationProjectAggregateDependencies> {
  return (await loadBundle(tx, input)).dependencies;
}
