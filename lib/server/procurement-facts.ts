import type { SqlConnection } from "@fracture/paypal-core";
import type { PlanSourceBinding } from "../planning/contracts";
import * as C from "../procurement/contracts";
import { quoteArithmetic } from "../procurement/arithmetic";
import { packagePositionTotals, projectFundingPositions } from "../domain/funding-positions";
import { assertMinor, DomainError } from "../domain/money";
import { assessPackageFunding } from "../domain/package-funding";
import { currentPledgeCommitment } from "../funding/pledges";
import type { Session } from "./auth";
import { query } from "./db";
import { readFundingJournal } from "./funding-positions";
import { planningFunding } from "./planning";
import { alignmentViews, packageReadiness, signoffViews } from "./planning-evidence";
import { currentSourceCheck, planningHead, publishedPlan } from "./planning-store";
import { canonicalExpenseReadiness } from "./payout-funding";
import { pledgeContract, type PledgeRow } from "./purpose-store";
import { quotePayload, procurementHash, procurementProject, scopeValues, operationsHead, operationsPayload, currentResponsibility, responsibilityCurrent, openProcurement, integrity, requireQuote, type OperationsPayload, type OperationsRow } from "./procurement-store";
import { quoteVersion } from "./procurement-catalog";
import { procurementEvidenceDependencies } from "./procurement-evidence";
import { activeProjectPolicies } from "./project-policy";
import { procurementPolicyIssues } from "./procurement-policy";

export interface ProcurementCanonicalPackage { id: string; version: number; budget_minor: string; data: { title: string; fundingState: C.ProcurementPackage["fundingState"] }; }
export interface SelectionPayload {
  quoteId: string; quoteVersion: number; quoteHash: string; cycle: number;
  label: string; supplierName: string; amountMinor: number | null; currency: string;
  comparisonQuoteHeads: { id: string; version: number; contentHash: string }[];
  reason: string; shareScalarsWithAssignee: boolean; sharedWithResponsibilityId: string | null;
}
export interface SelectionRow { id: string; tenant_id: string; project_id: string; package_id: string; cycle: number; quote_id: string; quote_version: number; content_hash: string; encrypted_data: string; created_at: Date; }
export function selectionPayload(row: SelectionRow): SelectionPayload {
  const data = openProcurement<SelectionPayload>({ tenantId: row.tenant_id, projectId: row.project_id }, "selection", row.id, 1, row.encrypted_data);
  integrity(data, row.content_hash);
  if (data.quoteId !== row.quote_id || data.quoteVersion !== row.quote_version || data.cycle !== row.cycle) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "The saved quote selection no longer matches its original package cycle.", 409);
  return data;
}
export async function canonicalPackages(tx: SqlConnection, session: Pick<Session, "tenantId" | "projectId">): Promise<ProcurementCanonicalPackage[]> {
  return query<ProcurementCanonicalPackage>("SELECT k.* FROM fp_packages k JOIN fp_projects p ON p.id=k.project_id WHERE p.tenant_id=$1 AND k.project_id=$2 ORDER BY k.id", scopeValues(session), tx);
}
const amount = (value: unknown) => { const number = Number(value); assertMinor(number); return number; };
const sum = (values: number[]) => values.reduce((total, value) => amount(total + value), 0);

/** Current unpaid amounts use original collected principal per commitment.
 * Returns or assignments never turn an already collected promise unpaid. */
async function unpaidByPackage(tx: SqlConnection, session: Session, packages: ProcurementCanonicalPackage[], at: number) {
  const result = new Map(packages.map(pkg => [pkg.id, { unpaid: 0, sponsor: 0 }]));
  const pledges = await query<PledgeRow>("SELECT * FROM fp_purpose_pledges WHERE tenant_id=$1 AND project_id=$2 ORDER BY id", scopeValues(session), tx);
  const namedObligations = new Set<string>();
  for (const row of pledges) {
    const value = pledgeContract(row), pkg = packages.find(pkg => pkg.id === row.package_id), target = result.get(row.package_id);
    if (value.tenantId !== session.tenantId || value.projectId !== session.projectId || value.provenance !== session.mode || value.currency !== "USD") throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "A commitment no longer matches its original project and source mode.", 409);
    namedObligations.add(row.obligation_id);
    const collected = amount(row.collected_minor), unpaid = pkg?.version === value.packageVersion ? Math.max(0, currentPledgeCommitment({ state: row.state, amountMinor: value.amountMinor, collectedMinor: collected, expiresAt: value.expiresAt, operationId: row.operation_id }, at) - collected) : 0;
    if (target) { target.unpaid = amount(target.unpaid + unpaid); if (value.kind !== "donor") target.sponsor = amount(target.sponsor + unpaid); }
  }
  const legacy = await query<{ id: string; package_id: string; amount_minor: string; channel: string; eligible: boolean | null; current_version: number; package_version: number | null; status: string | null; withdrawn_at: Date | null; expires_at: Date | null; round_id: string | null; original_paid: string; current_policy: boolean; has_receipt: boolean }>(`SELECT o.id,o.package_id,o.amount_minor,o.channel,(o.data->>'eligible')::boolean eligible,k.version current_version,c.package_version,c.status,c.withdrawn_at,c.expires_at,c.round_id,
    EXISTS(SELECT 1 FROM fp_funding_policies f WHERE f.tenant_id=o.tenant_id AND f.project_id=o.project_id AND f.package_id=o.package_id AND f.package_version=k.version) current_policy,
    EXISTS(SELECT 1 FROM fp_settlement_receipts r WHERE r.tenant_id=o.tenant_id AND r.project_id=o.project_id AND r.obligation_id=o.id) has_receipt,
    COALESCE((SELECT sum((r.data->>'creditedMinor')::bigint) FROM fp_settlement_receipts r WHERE r.tenant_id=o.tenant_id AND r.project_id=o.project_id AND r.obligation_id=o.id),0) original_paid
    FROM fp_obligations o JOIN fp_packages k ON k.project_id=o.project_id AND k.id=o.package_id
    LEFT JOIN fp_conditional_consents c ON c.obligation_id=o.id AND c.tenant_id=o.tenant_id AND c.project_id=o.project_id
    WHERE o.tenant_id=$1 AND o.project_id=$2 AND o.purpose='conditional_pledge' ORDER BY o.id`, scopeValues(session), tx);
  for (const row of legacy) {
    if (namedObligations.has(row.id)) continue;
    const eligible = session.mode === "sample" ? row.eligible !== false && !["withdrawn", "cancelled", "refunded"].includes(row.channel) && (!row.current_policy || row.has_receipt) : !!row.eligible && !row.withdrawn_at && row.package_version === row.current_version && ["ready", "collecting", "collected"].includes(row.status ?? "") && !!(row.round_id || row.expires_at && row.expires_at.getTime() > at);
    const target = result.get(row.package_id); if (target && eligible) target.unpaid = amount(target.unpaid + Math.max(0, amount(row.amount_minor) - amount(row.original_paid)));
  }
  return result;
}

export interface ProcurementFacts {
  checkedAt: string; packages: ProcurementCanonicalPackage[];
  publication: Awaited<ReturnType<typeof publishedPlan>>;
  planHeadVersion: number; sourceBindings: PlanSourceBinding[];
  alignments: Awaited<ReturnType<typeof alignmentViews>>; signoffs: Awaited<ReturnType<typeof signoffViews>>;
  readiness: ReturnType<typeof packageReadiness>;
  cycleAccepted: Set<string>; prerequisiteCurrent: Map<string, boolean>; evidenceDependencies: Awaited<ReturnType<typeof procurementEvidenceDependencies>>;
  policyIssues: Map<string, string[]>; policyVerified: boolean;
  money: Map<string, C.ProcurementMoney>; fundingHash: string; policyHash: string; claimsHash: string;
  fundingStates: Map<string, C.ProcurementPackage["fundingState"]>;
  financialReasons: string[];
}
/** Internal observations only: the caller has real authority and owns this
 * transaction. Private source, actor and payment IDs never become scalar UI. */
export async function loadProcurementFacts(tx: SqlConnection, session: Session, checkedAt: string): Promise<ProcurementFacts> {
  const packages = await canonicalPackages(tx, session), head = await planningHead(session, tx), publication = await publishedPlan(session, tx);
  const alignments = await alignmentViews(session, tx, true), signoffs = await signoffViews(session, tx, true, Date.parse(checkedAt));
  const evidenceDependencies = await procurementEvidenceDependencies(tx, session, publication, alignments, signoffs), sourceBindings = evidenceDependencies.documents;
  const project = await procurementProject(session, tx), heads = await query<OperationsRow>("SELECT * FROM fp_package_operations WHERE tenant_id=$1 AND project_id=$2 ORDER BY package_id", scopeValues(session), tx), cycles = new Map(heads.map(row => [row.package_id, operationsPayload(row).cycleStartedAt]));
  const cycleAccepted = new Set<string>();
  if (publication?.view.state === "current") for (const pkg of publication.payload.plan.packages) { const start = Date.parse(cycles.get(pkg.packageId) ?? project.createdAt); if (pkg.requirements.length && pkg.requirements.every(requirement => requirement.kind === "photo_association" ? alignments.some(row => row.packageId === pkg.packageId && row.state === "reviewed") : signoffs.some(row => row.packageId === pkg.packageId && row.requirementId === requirement.id && row.current && row.decision === "accepted" && Date.parse(row.recordedAt) >= start))) cycleAccepted.add(pkg.packageId); }
  const prerequisiteCurrent = new Map<string, boolean>(), visiting = new Set<string>();
  function prerequisites(id: string): boolean { if (prerequisiteCurrent.has(id)) return prerequisiteCurrent.get(id)!; if (!publication || publication.view.state !== "current" || visiting.has(id) || !publication.payload.plan.packages.some(pkg => pkg.packageId === id)) return false; visiting.add(id); const value = publication.payload.plan.dependencies.filter(row => row.packageId === id).every(row => prerequisites(row.prerequisiteId) && (row.kind === "included" || cycleAccepted.has(row.prerequisiteId))); visiting.delete(id); prerequisiteCurrent.set(id, value); return value; }
  packages.forEach(pkg => prerequisites(pkg.id));
  const policyRows = await query("SELECT id,version,state,source_policy_version_id,rule_hash,adoption_head,mappings FROM fp_project_policy_adoptions WHERE tenant_id=$1 AND project_id=$2 ORDER BY id", scopeValues(session), tx);
  let policyVerified = true; const policyIssues = new Map<string, string[]>();
  try { const rules = await activeProjectPolicies(tx, session, false); for (const pkg of packages) policyIssues.set(pkg.id, procurementPolicyIssues(pkg.id, publication?.view.state === "current" ? publication.payload : null, rules, alignments, evidenceDependencies.decisions)); }
  catch (error) { if (!(error instanceof DomainError)) throw error; policyVerified = false; for (const pkg of packages) policyIssues.set(pkg.id, ["Current project-owned rule integrity is unknown. Retain existing history and review the original rule before a new positive decision."]); }
  const claims = await query("SELECT id,version,state,currency,requested_minor,approved_minor,document_id FROM fp_claims WHERE tenant_id=$1 AND project_id=$2 ORDER BY id", scopeValues(session), tx);
  const rawFinance = await query("SELECT id,version,data FROM fp_settlement_receipts WHERE tenant_id=$1 AND project_id=$2 ORDER BY id", scopeValues(session), tx);
  const rawUses = await query("SELECT id,receipt_id,package_id,state,amount_minor FROM fp_receipt_allocations WHERE tenant_id=$1 AND project_id=$2 ORDER BY id", scopeValues(session), tx);
  let fundedIds: string[] = [], financialReasons: string[] = [], fundingHash = procurementHash({ rawFinance, rawUses }), money = new Map<string, C.ProcurementMoney>(), fundingStates = new Map<string, C.ProcurementPackage["fundingState"]>();
  try {
    const journal = await readFundingJournal({ tenantId: session.tenantId, projectId: session.projectId, provenance: session.mode }, tx), positions = projectFundingPositions(journal, { tenantId: session.tenantId, projectId: session.projectId, provenance: session.mode });
    const commitments = await unpaidByPackage(tx, session, packages, Date.parse(checkedAt)), funding = await planningFunding(session, tx), live = session.mode === "live_sandbox" ? await canonicalExpenseReadiness(tx, session) : null;
    const rounds = await query<{ package_id: string; package_version: number; state: string }>("SELECT package_id,package_version,state FROM fp_collection_rounds WHERE tenant_id=$1 AND project_id=$2 ORDER BY collection_started_at DESC,id DESC", scopeValues(session), tx);
    fundedIds = funding.filter(row => row.complete).map(row => row.packageId);
    for (const pkg of packages) {
      const total = packagePositionTotals(positions.positions, pkg.id, amount(pkg.budget_minor)), rows = positions.positions.filter(row => row.packageId === pkg.id), originals = journal.sources.filter(row => row.receipt.packageId === pkg.id);
      const round = rounds.find(row => row.package_id === pkg.id && row.package_version === pkg.version) ?? rounds.find(row => row.package_id === pkg.id);
      fundingStates.set(pkg.id, assessPackageFunding({ state: pkg.data.fundingState, version: pkg.version, budgetMinor: amount(pkg.budget_minor), eligibleMinor: total.fundingEligibleMinor, provenance: session.mode, round: round ? { packageVersion: round.package_version, state: round.state } : undefined }).state);
      money.set(pkg.id, C.procurementMoneySchema.parse({ currency: "USD", originalGrossMinor: sum(originals.map(row => row.receipt.grossSettledMinor)), returnedMinor: sum(originals.map(row => row.receipt.completedAttributedRefundMinor)), currentCollectedMinor: total.collectedMinor, unpaidCommitmentMinor: commitments.get(pkg.id)?.unpaid ?? 0, acceptedSponsorUnpaidMinor: commitments.get(pkg.id)?.sponsor ?? 0, eligibleMinor: total.fundingEligibleMinor, reservedExpenseMinor: sum(rows.map(row => row.reservedMinor)), paidExpenseMinor: sum(rows.map(row => row.paidMinor)), availableMinor: sum(rows.map(row => row.availableMinor)), financialReady: live ? live.get(pkg.id)?.ready === true : fundedIds.includes(pkg.id), providerLiquidity: "not_checked", cutoff: checkedAt }));
    }
    fundingHash = procurementHash({ journal, commitments: [...commitments], money: [...money].map(([id, { cutoff: _cutoff, ...values }]) => [id, values]) });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    // A financial integrity failure must never appear as zero available money.
    financialReasons = ["The canonical ledger needs reconciliation. Cost and operational history remain recorded; new funding readiness is unknown."];
    money = new Map();
    fundingStates = new Map();
    fundingHash = procurementHash({ rawFinance, rawUses, unavailable: error.code });
  }
  return { checkedAt, packages, publication, planHeadVersion: head.version, sourceBindings, alignments, signoffs, readiness: packageReadiness(publication?.payload ?? null, publication?.view.state === "current", alignments, signoffs, fundedIds), cycleAccepted, prerequisiteCurrent, evidenceDependencies, policyIssues, policyVerified, money, fundingStates, fundingHash, policyHash: procurementHash(policyRows), claimsHash: procurementHash(claims), financialReasons };
}

export interface PackageObservation {
  canonical: ProcurementCanonicalPackage; operations: OperationsPayload;
  responsibility: Awaited<ReturnType<typeof currentResponsibility>>; responsibilityCurrent: boolean;
  selection: { row: SelectionRow; data: SelectionPayload; current: boolean; validUntil: string | null; capabilitiesKnown: boolean } | null;
  basis: C.ProcurementBasis; requirements: C.ProcurementDetail["requirements"]; prerequisites: C.ProcurementDetail["prerequisites"];
  capabilities: string[]; exceptions: number; bindings: PlanSourceBinding[];
}
export async function observeProcurementPackage(tx: SqlConnection, session: Session, facts: ProcurementFacts, packageId: string): Promise<PackageObservation> {
  const canonical = facts.packages.find(row => row.id === packageId); if (!canonical) throw new DomainError("PROCUREMENT_NOT_FOUND", "This package is outside the current project.", 404);
  const { data: operations } = await operationsHead(tx, session, packageId), responsibility = await currentResponsibility(tx, session, packageId);
  const responsibleCurrent = !!responsibility && await responsibilityCurrent(tx, responsibility);
  let selection: PackageObservation["selection"] = null;
  const bindings = [...facts.sourceBindings];
  if (operations.selectionId) {
    const [row] = await query<SelectionRow>("SELECT * FROM fp_procurement_selections WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND package_id=$4 AND cycle=$5", [...scopeValues(session), operations.selectionId, packageId, operations.cycle], tx);
    if (!row) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "The selection no longer matches this exact package cycle.", 409);
    const data = selectionPayload(row), quote = await requireQuote(tx, session, data.quoteId), version = await quoteVersion(tx, session, quote, data.quoteVersion), payload = quotePayload(version), arithmetic = quoteArithmetic(payload.draft);
    const [supplier] = await query<{ state: string; version: number }>("SELECT state,version FROM fp_procurement_suppliers WHERE tenant_id=$1 AND project_id=$2 AND id=$3", [...scopeValues(session), payload.draft.supplierId], tx);
    const permissionCurrent = !payload.sourceBinding || !(await currentSourceCheck(session, [payload.sourceBinding], tx)).length;
    if (payload.sourceBinding) bindings.push(payload.sourceBinding);
    const current = permissionCurrent && quote.version === data.quoteVersion && quote.state === "reviewed" && version.content_hash === data.quoteHash && supplier?.state === "active" && supplier.version === payload.draft.supplierVersion && payload.packageVersions[packageId] === canonical.version;
    selection = { row, data, current, validUntil: payload.draft.validUntil, capabilitiesKnown: !!facts.publication && (facts.publication.payload.plan.packages.find(row => row.packageId === packageId)?.capabilities ?? []).every(capability => payload.draft.capabilityAssessment.some(row => row.capability === capability && row.state === "supported")) && arithmetic.complete && arithmetic.allocationComplete };
  }
  const currentPublication = facts.publication?.view.state === "current" ? facts.publication : null;
  const planned = currentPublication?.payload.plan.packages.find(row => row.packageId === packageId), ready = facts.readiness.find(row => row.packageId === packageId);
  const requirements: C.ProcurementDetail["requirements"] = (planned?.requirements ?? []).map(requirement => {
    const decision = facts.signoffs.find(row => row.packageId === packageId && row.requirementId === requirement.id && row.current && row.decision === "accepted"), alignment = facts.alignments.find(row => row.packageId === packageId && row.state === "reviewed"), summary = ready?.requirements.find(row => row.id === requirement.id);
    return { id: requirement.id, label: requirement.label, kind: requirement.kind == "photo_association" ? "photo_association" as const : "physical_review" as const, scope: requirement.scope, satisfied: summary?.satisfied === true, currentCycleSatisfied: summary?.satisfied === true && (requirement.kind === "photo_association" || !!decision && Date.parse(decision.recordedAt) >= Date.parse(operations.cycleStartedAt)), provenance: requirement.kind === "photo_association" ? alignment?.sourceClass === "sample_illustration" ? "sample" : alignment ? "reviewer_attested" : "unreviewed" : decision?.provenance ?? "unreviewed", reviewedAt: requirement.kind === "photo_association" ? alignment?.reviewedAt ?? null : decision?.recordedAt ?? null, detail: summary?.detail ?? "The current evidence scope is not available." };
  });
  const prerequisites = (currentPublication?.payload.plan.dependencies.filter(row => row.packageId === packageId) ?? []).map(dependency => {
    const predecessor = facts.readiness.find(row => row.packageId === dependency.prerequisiteId);
    return { packageId: dependency.prerequisiteId, title: predecessor?.title ?? dependency.prerequisiteId, kind: dependency.kind, satisfied: facts.prerequisiteCurrent.get(dependency.prerequisiteId) === true && (dependency.kind === "included" || facts.cycleAccepted.has(dependency.prerequisiteId)), detail: dependency.kind === "included" ? "The prerequisite must remain included in the current valid plan." : dependency.kind === "safety_signoff" ? "The prerequisite needs its current qualified safety decisions for its own operational cycle." : "The prerequisite needs current accepted work evidence for its own operational cycle." };
  });
  const [{ count }] = await query<{ count: string }>("SELECT count(*) FROM fp_procurement_exceptions WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 AND cycle=$4 AND state='open'", [...scopeValues(session), packageId, operations.cycle], tx);
  const sourcePermissionHash = procurementHash({ bindings, selectionCurrent: selection?.current ?? null, quoteDeadlineCurrent: !!selection?.validUntil && Date.parse(selection.validUntil) > Date.parse(facts.checkedAt), planState: facts.publication?.view.state ?? "missing" });
  const basis = C.procurementBasisSchema.parse({ packageId, packageVersion: canonical.version, budgetMinor: amount(canonical.budget_minor), currency: "USD", fundingState: facts.fundingStates.get(packageId) ?? canonical.data.fundingState, plan: currentPublication ? { publicationId: currentPublication.view.publicationId, planId: currentPublication.row.id, revision: currentPublication.row.revision, contentHash: currentPublication.row.content_hash, headVersion: facts.planHeadVersion } : null, planStatus: facts.publication?.view.state ?? "missing", fundingHash: facts.fundingHash, policyHash: facts.policyHash, evidenceHash: procurementHash({ positiveBindings: facts.evidenceDependencies, alignments: facts.alignments.map(row => ({ id: row.id, hash: row.contentHash, state: row.state })), signoffs: facts.signoffs.map(row => ({ id: row.id, current: row.current, decision: row.decision, recordedAt: row.recordedAt })), requirements }), sourcePermissionHash, dependencyHash: procurementHash(prerequisites), assignmentHash: procurementHash({ id: responsibility?.id ?? null, version: responsibility?.version ?? null, state: responsibility?.state ?? null, current: responsibleCurrent }), selectionHash: procurementHash(selection ? { id: selection.row.id, hash: selection.row.content_hash, current: selection.current } : null), claimsHash: facts.claimsHash });
  return { canonical, operations, responsibility, responsibilityCurrent: responsibleCurrent, selection, basis, requirements, prerequisites, capabilities: planned?.capabilities ?? [], exceptions: Number(count), bindings };
}
