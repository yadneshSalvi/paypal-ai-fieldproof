import { canonicalJson, sha256 } from "@fracture/paypal-core";
import { DomainError } from "../domain/money";
import * as C from "./contracts";

export const ORGANIZATION_PORTFOLIO_SEMANTICS = "organization-aggregate-semantics-v1" as const;
type Provenance = C.OrgPortfolioGroup["provenance"];
type Metric = C.OrgDisclosureSection;
type GroupIdentity = { currency: string; provenance: Provenance };
const allFilters: C.OrgPortfolioFilter = { templateIds: [], provenance: [], currencies: [], linkIds: [] };
const metrics = C.orgDisclosureSectionSchema.options;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const unavailable = (message: string): never => { throw new DomainError("ORG_RESOURCE_UNAVAILABLE", message, 422); };
function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value)) unavailable("A portfolio amount or count exceeds its safe integer range. Review the exact project scope.");
    total += value;
  }
  return total;
}
export function normalizeOrganizationPortfolioFilters(filters: C.OrgPortfolioFilter): C.OrgPortfolioFilter {
  const parsed = C.orgPortfolioFilterSchema.parse(filters);
  return { templateIds: parsed.templateIds.sort(compare), provenance: parsed.provenance.sort(compare), currencies: parsed.currencies.sort(compare), linkIds: parsed.linkIds.sort(compare) };
}
function selected(identity: GroupIdentity, filters: C.OrgPortfolioFilter, group?: GroupIdentity): boolean {
  return (!filters.currencies.length || filters.currencies.includes(identity.currency)) &&
    (!filters.provenance.length || filters.provenance.includes(identity.provenance)) &&
    (!group || group.currency === identity.currency && group.provenance === identity.provenance);
}
function metadataFilters(filters: C.OrgPortfolioFilter): boolean { return !!(filters.templateIds.length || filters.provenance.length || filters.currencies.length); }
function identities(project: C.OrgPortfolioProject, metric: Metric): GroupIdentity[] {
  if (!project.project) return [];
  const fallback = { currency: project.project.currency, provenance: project.project.mode };
  if (metric === "budget") return [project.budget ?? fallback];
  if (metric === "evidence") return project.evidence.length ? project.evidence.map(row => ({ currency: project.project!.currency, provenance: row.provenance })) : [fallback];
  const available = project.money.filter(row => !!row[metric]);
  return available.length ? available : [fallback];
}
function provided(project: C.OrgPortfolioProject, metric: Metric, group?: GroupIdentity): boolean {
  if (metric === "budget") return !!project.budget && (!group || project.budget.currency === group.currency && project.budget.provenance === group.provenance);
  if (metric === "evidence") return project.evidence.some(row => !group || project.project?.currency === group.currency && row.provenance === group.provenance);
  return project.money.some(row => !!row[metric] && (!group || row.currency === group.currency && row.provenance === group.provenance));
}
function validateProjects(projects: readonly C.OrgPortfolioProject[]): C.OrgPortfolioProject[] {
  const links = new Set<string>(), knownProjects = new Set<string>();
  return projects.map(raw => {
    const row = C.orgPortfolioProjectSchema.parse(raw);
    if (links.has(row.linkId) || row.project && knownProjects.has(row.project.id)) unavailable("A portfolio cannot count the same current project or consent link twice.");
    links.add(row.linkId); if (row.project) knownProjects.add(row.project.id);
    return row;
  });
}
/** Withheld metadata is never secretly classified by a private template,
 * currency or provenance value. It remains a link-status row with an explicit
 * coverage limitation; its private project identity remains absent. */
export function filterOrganizationProjectAggregates(projects: readonly C.OrgPortfolioProject[], input: C.OrgPortfolioFilter = allFilters): C.OrgPortfolioProject[] {
  const filters = normalizeOrganizationPortfolioFilters(input);
  return validateProjects(projects).flatMap(row => {
    if (filters.linkIds.length && !filters.linkIds.includes(row.linkId)) return [];
    if (!row.project) return [{ ...row, notices: metadataFilters(filters) ? [...row.notices, "Withheld project metadata cannot be classified by the active template, currency or provenance filters."] : row.notices }];
    if (filters.templateIds.length && !filters.templateIds.includes(row.project.templateId)) return [];
    const possible = [ { currency: row.project.currency, provenance: row.project.mode }, ...metrics.flatMap(metric => identities(row, metric)) ];
    if (!possible.some(identity => selected(identity, filters))) return [];
    return [{ ...row,
      budget: row.budget && selected(row.budget, filters) ? row.budget : null,
      money: row.money.filter(item => selected(item, filters)),
      evidence: row.evidence.filter(item => selected({ currency: row.project!.currency, provenance: item.provenance }, filters)),
    }];
  }).sort((a, b) => compare(a.project?.title ?? "", b.project?.title ?? "") || compare(a.linkId, b.linkId));
}
/** A metric denominator includes only links that explicitly approved that
 * section. Missing/source-withdrawn values contribute an omission, never0.
 * A finance-only consent consequently cannot enlarge evidence coverage. */
export function organizationPortfolioCoverage(projects: readonly C.OrgPortfolioProject[], options: { filters?: C.OrgPortfolioFilter; group?: GroupIdentity } = {}): C.OrgPortfolioCoverage {
  const filters = normalizeOrganizationPortfolioFilters(options.filters ?? allFilters), rows = validateProjects(projects);
  const result = {} as C.OrgPortfolioCoverage;
  for (const metric of metrics) {
    let included = 0, omitted = 0, unknownClassification = 0;
    const reasons = new Set<string>();
    for (const project of rows) {
      if (filters.linkIds.length && !filters.linkIds.includes(project.linkId)) continue;
      if (project.project && filters.templateIds.length && !filters.templateIds.includes(project.project.templateId)) continue;
      if (!project.disclosedSections.includes(metric)) continue;
      if (!project.project && (metadataFilters(filters) || options.group)) { unknownClassification++; continue; }
      if (project.project && !identities(project, metric).some(identity => selected(identity, filters, options.group))) continue;
      if (provided(project, metric, options.group)) included++;
      else { omitted++; reasons.add(`${orgMetricName(metric)} is unavailable for ${project.project ? "a selected project" : "a metadata-only disclosure"}; no zero value was substituted.`); }
    }
    if (unknownClassification) reasons.add(`${unknownClassification} metadata-only ${unknownClassification === 1 ? "link cannot" : "links cannot"} be classified in this ${options.group ? "currency/provenance group" : "filtered scope"}; ${unknownClassification === 1 ? "it is" : "they are"} excluded from this metric denominator.`);
    result[metric] = { includedProjects: included, omittedProjects: omitted, denominatorProjects: included + omitted, complete: omitted === 0 && unknownClassification === 0, reasons: [...reasons].sort(compare) };
  }
  return C.orgPortfolioCoverageSchema.parse(result);
}
function orgMetricName(metric: Metric) { return ({ budget: "Budget", funding: "Funding", expenses: "Expense information", evidence: "Evidence information" })[metric]; }
function sumFunding(rows: C.OrgPortfolioFunding[]): C.OrgPortfolioFunding | null {
  if (!rows.length) return null;
  return C.orgPortfolioFundingSchema.parse(Object.fromEntries(Object.keys(rows[0]).map(key => [key, sum(rows.map(row => row[key as keyof C.OrgPortfolioFunding]))])));
}
function sumExpenses(rows: C.OrgPortfolioExpenses[]): C.OrgPortfolioExpenses | null {
  if (!rows.length) return null;
  return C.orgPortfolioExpensesSchema.parse(Object.fromEntries(Object.keys(rows[0]).map(key => [key, sum(rows.map(row => row[key as keyof C.OrgPortfolioExpenses]))])));
}
function sumEvidence(rows: C.OrgPortfolioEvidence[], projectCount: number): C.OrgPortfolioEvidence | null {
  if (!rows.length) return null;
  const revisions = new Map<string, C.OrgPortfolioEvidence["policyRevisions"][number]>(), limitations = new Set<string>();
  for (const row of rows) {
    row.limitations.forEach(value => limitations.add(value));
    for (const revision of row.policyRevisions) {
      const key = `${revision.policyId}:${revision.revision}`, prior = revisions.get(key);
      if (prior && prior.contentHash !== revision.contentHash) unavailable("The same immutable policy revision has inconsistent aggregate bindings.");
      revisions.set(key, revision);
    }
  }
  return C.orgPortfolioEvidenceSchema.parse({
    acceptedReviewItems: sum(rows.map(row => row.acceptedReviewItems)), requiredReviewItems: sum(rows.map(row => row.requiredReviewItems)),
    acceptedPackages: sum(rows.map(row => row.acceptedPackages)), packageCount: sum(rows.map(row => row.packageCount)),
    currentScopedSignoffs: sum(rows.map(row => row.currentScopedSignoffs)), reviewedIllustrations: sum(rows.map(row => row.reviewedIllustrations)),
    planRevision: projectCount === 1 && rows.length === 1 ? rows[0].planRevision : null,
    policyRevisions: [...revisions.values()].sort((a, b) => compare(a.policyId, b.policyId) || a.revision - b.revision), limitations: [...limitations].sort(compare),
  });
}
export function groupOrganizationProjectAggregates(projects: readonly C.OrgPortfolioProject[], input: C.OrgPortfolioFilter = allFilters): C.OrgPortfolioGroup[] {
  const filters = normalizeOrganizationPortfolioFilters(input), rows = filterOrganizationProjectAggregates(projects, filters), groups = new Map<string, GroupIdentity>();
  for (const project of rows) {
    if (!project.project) continue;
    const all = [{ currency: project.project.currency, provenance: project.project.mode }, ...metrics.flatMap(metric => identities(project, metric))];
    for (const identity of all) if (selected(identity, filters)) groups.set(`${identity.currency}:${identity.provenance}`, identity);
  }
  return [...groups.values()].sort((a, b) => compare(a.currency, b.currency) || compare(a.provenance, b.provenance)).flatMap(group => {
    const members = rows.filter(row => row.project && metrics.some(metric => row.disclosedSections.includes(metric) && identities(row, metric).some(identity => selected(identity, filters, group))));
    if (!members.length) return [];
    const budgets = members.flatMap(row => row.budget && row.budget.currency === group.currency && row.budget.provenance === group.provenance ? [row.budget.amountMinor] : []);
    const funding = members.flatMap(row => row.money.flatMap(item => item.currency === group.currency && item.provenance === group.provenance && item.funding ? [item.funding] : []));
    const expenses = members.flatMap(row => row.money.flatMap(item => item.currency === group.currency && item.provenance === group.provenance && item.expenses ? [item.expenses] : []));
    const evidence = members.flatMap(row => row.project?.currency === group.currency ? row.evidence.flatMap(item => item.provenance === group.provenance ? [item.values] : []) : []);
    return [C.orgPortfolioGroupSchema.parse({ ...group, projectCount: members.length, budgetMinor: budgets.length ? sum(budgets) : null, funding: sumFunding(funding), expenses: sumExpenses(expenses), evidence: sumEvidence(evidence, members.length), coverage: organizationPortfolioCoverage(rows, { filters, group }) })];
  });
}
export function buildOrganizationPortfolioSnapshot(input: { projects: readonly C.OrgPortfolioProject[]; filters: C.OrgPortfolioFilter; asOf: string }): C.OrgPortfolioSnapshot {
  const asOf = new Date(input.asOf); if (!Number.isFinite(asOf.getTime())) unavailable("A portfolio needs its original coherent UTC cutoff.");
  const filters = normalizeOrganizationPortfolioFilters(input.filters), projects = filterOrganizationProjectAggregates(input.projects, filters);
  if (projects.some(project => project.lineage && project.lineage.asOf !== asOf.toISOString())) unavailable("Project aggregates must share this portfolio's exact transaction cutoff.");
  const coverage = organizationPortfolioCoverage(projects, { filters }), groups = groupOrganizationProjectAggregates(projects, filters);
  const stableProjects = projects.map(project => ({ ...project, lineage: project.lineage ? { ...project.lineage, asOf: undefined } : null }));
  const basisHash = sha256(canonicalJson({ semanticVersion: ORGANIZATION_PORTFOLIO_SEMANTICS, filters, projects: stableProjects, groups, coverage }));
  return C.orgPortfolioSnapshotSchema.parse({ schemaVersion: C.ORG_PORTFOLIO_VERSION, semanticVersion: ORGANIZATION_PORTFOLIO_SEMANTICS, basisHash, asOf: asOf.toISOString(), filters, projects, groups, coverage,
    knownLinks: projects.length, activeLinks: projects.filter(project => ["included", "partial", "unavailable"].includes(project.state)).length,
    suspendedLinks: projects.filter(project => project.state === "suspended").length, expiredLinks: projects.filter(project => project.state === "expired").length, withdrawnLinks: projects.filter(project => project.state === "withdrawn").length,
    sourceObservedRange: null, notices: [
      "One coherent database cutoff covers the selected approved aggregates. Current authorization and disclosure are checked separately before every private response.",
      "Currencies and provenance groups remain separate. Original receipts, current funding positions and outstanding promises are different non-additive measures; sponsor unpaid promises are already included in unpaid commitments.",
      "Provider/source observation-time ranges are not included in this aggregate projection; the cutoff above must not be presented as their observation time.",
      "Metric denominators include only links that approved that section. Unavailable values are omissions, not zero; metadata-only links cannot be secretly classified by project filters.",
    ] });
}
