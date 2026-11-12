import { randomUUID } from "node:crypto";
import * as C from "../organizations/contracts";
import { buildOrganizationPortfolioSnapshot, normalizeOrganizationPortfolioFilters } from "../organizations/portfolio-projection";
import { DomainError } from "../domain/money";
import { query } from "./db";
import { openPrivate, sealPrivate } from "./private-values";
import {
  assertOrganizationCurrent, findOrgCommand, orgCursor, orgHash, orgNow, orgPage, orgPrivateContext, orgRateLimit,
  organizationAudit, organizationTransaction, requireOrganization, saveOrgCommand,
  type OrgIdentity, type OrgTx, type OrganizationRequest,
} from "./organization-core";
import { currentOrganizationLink, type OrgLinkRow } from "./organization-projects";
import { collectOrganizationProjectAggregateDependencies, loadOrganizationProjectAggregate, type OrganizationProjectAggregateDependencies } from "./organization-project-aggregate";

const emptyFilters: C.OrgPortfolioFilter = { templateIds: [], provenance: [], currencies: [], linkIds: [] };
const audience = (identity: OrgIdentity) => orgHash({ organizationId: identity.organization.id, membershipId: identity.member.id, version: identity.member.version, role: identity.member.role });
interface PortfolioEnvelope { schemaVersion: typeof C.ORG_PORTFOLIO_VERSION; report: C.OrgPortfolioReport; dependencies: OrganizationProjectAggregateDependencies[]; bindingHash: string; }
interface PortfolioRow {
  id: string; organization_id: string; membership_id: string; role: C.OrgRole; membership_version: number; scope_hash: string;
  intent_id: string; input_hash: string; content_hash: string; basis_hash: string; semantic_version: string; as_of: Date; encrypted_data: string; created_at: Date;
}
const unavailable = () => new DomainError("ORG_RESOURCE_UNAVAILABLE", "This edition is unavailable for the exact current organization profile and role.", 404);
function decode(row: PortfolioRow): PortfolioEnvelope {
  const value = openPrivate<PortfolioEnvelope>(row.encrypted_data, orgPrivateContext("portfolio", row.id)), report = C.orgPortfolioReportSchema.parse(value.report);
  if (value.schemaVersion !== C.ORG_PORTFOLIO_VERSION || report.id !== row.id || report.organization.id !== row.organization_id || report.audience.role !== row.role ||
    report.contentHash !== row.content_hash || orgHash({ ...report, contentHash: "" }) !== row.content_hash || report.snapshot.basisHash !== row.basis_hash ||
    report.snapshot.asOf !== row.as_of.toISOString() || report.snapshot.semanticVersion !== row.semantic_version || value.bindingHash !== orgHash({ report, dependencies: value.dependencies }))
    throw new DomainError("ORG_REPORT_CHANGED", "This original edition could not be verified. Its saved record is retained.", 409);
  for (const dependency of value.dependencies) {
    const project = report.snapshot.projects.find(item => item.linkId === dependency.linkId);
    if (!project?.project || project.project.id !== dependency.projectId || project.consentRevision !== dependency.consentRevision || project.lineage?.disclosureHash !== dependency.consentHash)
      throw new DomainError("ORG_REPORT_CHANGED", "A frozen aggregate dependency does not match its original disclosed project.", 409);
  }
  return { ...value, report };
}
function summary(report: C.OrgPortfolioReport): C.OrgPortfolioSummary {
  return C.orgPortfolioSummarySchema.parse({ id: report.id, label: report.label, asOf: report.snapshot.asOf, contentHash: report.contentHash,
    basisHash: report.snapshot.basisHash, role: report.audience.role, projectCount: report.snapshot.projects.filter(project => !!project.project).length });
}
async function getReport(tx: OrgTx, identity: OrgIdentity, id: string) {
  const [row] = await query<PortfolioRow>("SELECT * FROM fp_org_portfolios WHERE id=$1 AND organization_id=$2 AND membership_id=$3 AND role=$4 AND membership_version=$5 AND scope_hash=$6", [id, identity.organization.id, identity.member.id, identity.member.role, identity.member.version, audience(identity)], tx);
  if (!row) throw unavailable();
  return { row, value: decode(row) };
}
export async function collectOrganizationPortfolioSource(tx: OrgTx, identity: OrgIdentity, filters: C.OrgPortfolioFilter) {
  const [{ at }] = await query<{ at: Date }>("SELECT transaction_timestamp() AS at", [], tx), asOf = at.toISOString();
  const links = await query<OrgLinkRow>("SELECT * FROM fp_org_project_links WHERE organization_id=$1 ORDER BY id", [identity.organization.id], tx);
  if (links.length > 200) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This organization exceeds the reviewed two-hundred-project aggregate boundary.", 422);
  const projects: C.OrgPortfolioProject[] = [], dependencies: OrganizationProjectAggregateDependencies[] = [];
  for (const row of links) {
    if (filters.linkIds.length && !filters.linkIds.includes(row.id)) continue;
    const link = await currentOrganizationLink(tx, row), consent = link.consent;
    if (link.state !== "active") {
      projects.push(C.orgPortfolioProjectSchema.parse({ linkId: row.id, linkVersion: row.version, consentRevision: consent.revision, state: link.state,
        project: null, lineage: null, disclosedSections: consent.disclosure, budget: null, money: [], evidence: [], reasons: link.reasons, notices: [] }));
      continue;
    }
    const input = { tenantId: row.tenant_id, projectId: row.project_id, linkId: row.id, linkVersion: row.version,
      consentRevision: consent.revision, consentHash: consent.content_hash, consentExpiresAt: consent.expires_at.toISOString(), disclosure: consent.disclosure, asOf };
    projects.push(await loadOrganizationProjectAggregate(tx, input));
    dependencies.push(await collectOrganizationProjectAggregateDependencies(tx, input));
  }
  const snapshot = buildOrganizationPortfolioSnapshot({ projects, filters, asOf }), selected = new Set(snapshot.projects.filter(project => !!project.project).map(project => project.linkId));
  return { snapshot, dependencies: dependencies.filter(dependency => selected.has(dependency.linkId)) };
}
/** Fresh READ COMMITTED access checks are deliberately outside the coherent
 * capture. Waiting on authority must not preserve an earlier source permission. */
export async function checkOrganizationPortfolioDependencies(tx: OrgTx, identity: OrgIdentity, dependencies: OrganizationProjectAggregateDependencies[]) {
  const reasons: string[] = [];
  for (const dependency of dependencies) {
    const scope = [dependency.tenantId, dependency.projectId];
    const [row] = await query<OrgLinkRow>("SELECT * FROM fp_org_project_links WHERE id=$1 AND organization_id=$2 AND tenant_id=$3 AND project_id=$4 FOR SHARE", [dependency.linkId, identity.organization.id, ...scope], tx);
    if (!row) { reasons.push("An original project disclosure is unavailable."); continue; }
    const current = await currentOrganizationLink(tx, row, true);
    if (current.state !== "active" || current.consent.revision !== dependency.consentRevision || current.consent.content_hash !== dependency.consentHash) { reasons.push("An original project disclosure or either authorizer's authority changed or ended."); continue; }
    const planning = dependency.planning;
    const sources = [
      ...dependency.expenseDocuments.map(source => ({ id: source.id, version: source.version, hash: source.contentHash, controlVersion: source.controlVersion, implicitControlVersion: 0 })),
      ...(planning?.documents ?? []).map(source => ({ id: source.documentId, version: source.documentVersion, hash: source.contentHash, controlVersion: source.controlVersion, implicitControlVersion: 1 })),
    ];
    for (const source of sources) {
      const [document] = await query<{ version: number; state: string; sha256: string | null }>("SELECT version,state,sha256 FROM fp_documents WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR SHARE", [source.id, ...scope], tx);
      const [control] = await query<{ version: number; permission: string }>("SELECT version,permission FROM fp_plan_source_controls WHERE document_id=$1 AND tenant_id=$2 AND project_id=$3 FOR SHARE", [source.id, ...scope], tx);
      if (!document || document.state !== "ready" || document.version !== source.version || document.sha256 !== source.hash || control?.permission === "withdrawn" || (control?.version ?? source.implicitControlVersion) !== source.controlVersion) reasons.push("An original counted source or its current sharing permission changed.");
    }
    if (planning?.publication) {
      const original = planning.publication;
      const [publication] = await query<{ plan_id: string; content_hash: string; state: string }>("SELECT plan_id,content_hash,state FROM fp_plan_publications WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR SHARE", [original.publicationId, ...scope], tx);
      if (!publication || publication.plan_id !== original.planId || publication.content_hash !== original.contentHash || publication.state === "revoked") reasons.push("The original counted plan publication was withdrawn.");
    }
    for (const qualification of planning?.qualifications ?? []) {
      const [record] = await query<{ version: number; state: string; valid_until: Date }>("SELECT version,state,valid_until FROM fp_reviewer_qualifications WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR SHARE", [qualification.id, ...scope], tx);
      const members = await query<{ actor_id: string; state: string; version: number; roles: string[] }>("SELECT actor_id,state,version,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=ANY($3::text[]) ORDER BY actor_id FOR SHARE", [...scope, [qualification.actorId, qualification.issuerId]], tx);
      const member = members.find(item => item.actor_id === qualification.actorId), issuer = members.find(item => item.actor_id === qualification.issuerId);
      if (!record || record.state !== "verified" || record.version !== qualification.version || record.valid_until.toISOString() !== qualification.validUntil || record.valid_until <= await orgNow(tx) ||
        !member || member.state !== "active" || member.version !== qualification.membershipVersion || !member.roles.some(role => ["organizer", "volunteer"].includes(role)) ||
        !issuer || issuer.state !== "active" || issuer.version !== qualification.issuerMembershipVersion || !issuer.roles.includes("organizer")) reasons.push("An original counted reviewer's independent qualification or authority changed or expired.");
    }
    // Original counted image/signoff identities are private sidecar records;
    // additions after the cutoff merely make an edition historical.
    for (const image of planning?.alignments ?? []) {
      const [record] = await query<{ state: string; content_hash: string }>("SELECT state,content_hash FROM fp_photo_alignments WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR SHARE", [image.id, ...scope], tx);
      if (!record || record.state !== "reviewed" || record.content_hash !== image.contentHash) reasons.push("An original counted image association was withdrawn.");
    }
    for (const signoff of planning?.signoffs ?? []) {
      const [record] = await query<{ content_hash: string; qualification_id: string; qualification_version: number }>("SELECT content_hash,qualification_id,qualification_version FROM fp_work_signoffs WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR SHARE", [signoff.id, ...scope], tx);
      if (!record || record.content_hash !== signoff.contentHash || record.qualification_id !== signoff.qualificationId || record.qualification_version !== signoff.qualificationVersion) reasons.push("An original counted physical review no longer matches its retained source binding.");
    }
    if (current.consent.expires_at <= await orgNow(tx)) reasons.push("The original fixed project disclosure deadline passed while this view was prepared.");
  }
  return [...new Set(reasons)];
}
async function viewWithin(tx: OrgTx, identity: OrgIdentity, value: PortfolioEnvelope, currentBasisHash: string): Promise<C.OrgPortfolioView> {
  const withdrawn = await checkOrganizationPortfolioDependencies(tx, identity, value.dependencies), changed = value.report.snapshot.basisHash !== currentBasisHash;
  return C.orgPortfolioViewSchema.parse({ summary: summary(value.report), status: withdrawn.length ? "withdrawn" : changed ? "historical" : "current",
    checkedAt: (await orgNow(tx)).toISOString(), currentBasisHash, report: withdrawn.length ? null : value.report,
    reasons: withdrawn.length ? withdrawn : changed ? ["Project records or disclosure changed after this exact saved cutoff. Its original figures remain frozen."] : [], canPrint: !withdrawn.length, canExport: !withdrawn.length });
}

export async function readOrganizationPortfolio(request: OrganizationRequest, before?: string, rawFilters: C.OrgPortfolioFilter = emptyFilters) {
  const filters = normalizeOrganizationPortfolioFilters(rawFilters);
  const captured = await organizationTransaction(async tx => {
    const identity = await requireOrganization(tx, request, request.organizationScope), live = await collectOrganizationPortfolioSource(tx, identity, filters);
    const owner = `${audience(identity)}:portfolio`, cursor = orgCursor(before, owner);
    const rows = await query<PortfolioRow>("SELECT * FROM fp_org_portfolios WHERE organization_id=$1 AND membership_id=$2 AND role=$3 AND membership_version=$4 AND scope_hash=$5 AND ($6::timestamptz IS NULL OR (as_of,id)<($6::timestamptz,$7::text)) ORDER BY as_of DESC,id DESC LIMIT $8", [identity.organization.id, identity.member.id, identity.member.role, identity.member.version, audience(identity), cursor?.at ?? null, cursor?.id ?? null, C.ORG_PAGE_SIZE + 1], tx);
    const page = orgPage(rows.map(row => ({ ...row, created_at: row.as_of })), owner), values = page.rows.map(decode);
    const selected = before ? null : values[0] ?? null;
    const selectedBasisHash = selected && orgHash(selected.report.snapshot.filters) !== orgHash(filters)
      ? (await collectOrganizationPortfolioSource(tx, identity, selected.report.snapshot.filters)).snapshot.basisHash : live.snapshot.basisHash;
    await assertOrganizationCurrent(tx, request, identity);
    return { scope: identity.scope, audience: audience(identity), ...live, values, nextCursor: page.nextCursor, selected, selectedBasisHash };
  }, true);
  return organizationTransaction(async tx => {
    const identity = await requireOrganization(tx, request, request.organizationScope);
    if (captured.scope !== identity.scope || captured.audience !== audience(identity)) throw unavailable();
    if ((await checkOrganizationPortfolioDependencies(tx, identity, captured.dependencies)).length) throw new DomainError("ORG_PROJECT_SOURCE_CHANGED", "An approved project or counted source changed while this aggregate was prepared. Refresh its current scope.", 409);
    const selected = captured.selected ? await viewWithin(tx, identity, captured.selected, captured.selectedBasisHash) : null;
    const portfolio = C.orgPortfolioDeskSchema.parse({ scope: identity.scope, live: captured.snapshot, history: captured.values.map(value => summary(value.report)),
      nextCursor: captured.nextCursor, selected, canCapture: true });
    JSON.stringify(portfolio);
    await assertOrganizationCurrent(tx, request, identity);
    return { portfolio };
  });
}
export async function readOrganizationPortfolioReport(request: OrganizationRequest, id: string) {
  const captured = await organizationTransaction(async tx => {
    const identity = await requireOrganization(tx, request, request.organizationScope), saved = await getReport(tx, identity, id);
    const current = await collectOrganizationPortfolioSource(tx, identity, saved.value.report.snapshot.filters);
    return { ...saved, currentBasisHash: current.snapshot.basisHash, audience: audience(identity) };
  }, true);
  return organizationTransaction(async tx => {
    const identity = await requireOrganization(tx, request, request.organizationScope);
    if (captured.audience !== audience(identity)) throw unavailable();
    const view = await viewWithin(tx, identity, captured.value, captured.currentBasisHash);
    JSON.stringify(view); await assertOrganizationCurrent(tx, request, identity);
    return { view };
  });
}
export async function captureOrganizationPortfolio(request: OrganizationRequest, raw: unknown) {
  const input = C.orgPortfolioCaptureSchema.parse(raw);
  const receipt = await organizationTransaction(async tx => {
    const identity = await requireOrganization(tx, request, input.expectedScope, undefined, true);
    if (request.organizationScope !== input.expectedScope) throw new DomainError("ORG_CONTEXT_CHANGED", "Capture the original reviewed organization context.", 409);
    const actorKey = `session:${identity.session.id}`, saved = await findOrgCommand(tx, actorKey, input.intentId, "capture_portfolio", input);
    if (saved) return C.orgCommandReceiptSchema.parse(saved.result);
    const current = await collectOrganizationPortfolioSource(tx, identity, normalizeOrganizationPortfolioFilters(input.filters));
    if (current.snapshot.basisHash !== input.expectedBasisHash) throw new DomainError("ORG_PROJECT_SOURCE_CHANGED", "The reviewed portfolio basis changed. Review its current exact figures before capturing a new edition.", 409);
    await orgRateLimit(tx, `${identity.organization.id}:${identity.member.id}:portfolio:${new Date().toISOString().slice(0, 10)}`, 200);
    const id = randomUUID(), report = C.orgPortfolioReportSchema.parse({ schemaVersion: C.ORG_PORTFOLIO_VERSION, id, label: input.label, contentHash: "0".repeat(64),
      organization: { id: identity.organization.id, name: identity.organization.name, identityProvenance: "self_declared" },
      audience: { role: identity.member.role, label: C.orgRoleLabels[identity.member.role], scope: "approved_project_aggregates" }, snapshot: current.snapshot });
    report.contentHash = orgHash({ ...report, contentHash: "" });
    const value: PortfolioEnvelope = { schemaVersion: C.ORG_PORTFOLIO_VERSION, report, dependencies: current.dependencies, bindingHash: orgHash({ report, dependencies: current.dependencies }) };
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 4 * 1024 * 1024) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This aggregate edition exceeds the reviewed capture size. Choose a narrower explicit project filter.", 422);
    await tx.query(`INSERT INTO fp_org_portfolios(id,organization_id,membership_id,role,membership_version,scope_hash,intent_id,input_hash,content_hash,basis_hash,semantic_version,as_of,encrypted_data)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id, identity.organization.id, identity.member.id, identity.member.role, identity.member.version, audience(identity), input.intentId, orgHash(input), report.contentHash, report.snapshot.basisHash,
      report.snapshot.semanticVersion, report.snapshot.asOf, sealPrivate(value, orgPrivateContext("portfolio", id))]);
    await tx.query("INSERT INTO fp_org_portfolio_audit(id,report_id,organization_id,membership_id,membership_version,role,content_hash,event) VALUES($1,$2,$3,$4,$5,$6,$7,'captured')", [randomUUID(), id, identity.organization.id, identity.member.id, identity.member.version, identity.member.role, report.contentHash]);
    await organizationAudit(tx, identity.organization.id, "organization.portfolio_captured", identity, { title: "An immutable aggregate portfolio was captured", detail: "The edition preserves one coherent cutoff and the exact approved project sections. It grants no private source, pooled-fund or payment authority.", reportId: id, contentHash: report.contentHash });
    await assertOrganizationCurrent(tx, request, identity);
    return saveOrgCommand(tx, actorKey, input, "capture_portfolio", input,
      { resourceId: id, resourceVersion: 1, message: "The exact aggregate edition is saved. Current authority and source permission remain required before reading, printing or exporting it." }, { identity });
  }, true);
  return { receipt, ...await readOrganizationPortfolioReport(request, receipt.resourceId!) };
}
const definitions: C.OrgPortfolioDetail["definitions"] = [
  { metric: "budget", label: "Canonical package budget", basis: "The target project's current canonical package budgets at the original cutoff.", unit: "minor_units", limitations: ["A budget is a plan, not collected funds or purchasing permission."] },
  { metric: "original_receipts", label: "Original observed receipts", basis: "Each original contribution receipt is counted once, with its original gross, credited amount and rail.", unit: "minor_units", limitations: ["Actual Sandbox records and fictional Sample records remain separate provenance groups."] },
  { metric: "current_funding", label: "Current purpose position", basis: "Retained credit after original returns, exclusions and paired purpose assignments, with paid, reserved and available uses separated.", unit: "minor_units", limitations: ["Do not add this position to original receipts. Accounting availability is not verified merchant liquidity."] },
  { metric: "unpaid_promises", label: "Unpaid support", basis: "Outstanding amounts from the original still-applicable named-purpose and conditional commitment contracts.", unit: "minor_units", limitations: ["Accepted sponsor unpaid promises are already a subset; neither measure is collected money."] },
  { metric: "expenses", label: "Reviewed expense and repayment position", basis: "Approved expenses, original delivered principal, returned principal, undelivered release, current paid principal, known actual fees and unresolved reservations remain distinct.", unit: "minor_units", limitations: ["An allowance is not an observed fee. Conflicting fee observations remain unknown."] },
  { metric: "evidence", label: "Current scoped review coverage", basis: "Accepted requirements and packages use their exact currently published plan and independent reviewer scope denominator.", unit: "ratio", limitations: ["Sample exercises and reviewed images do not prove actual installation, safety or community impact."] },
];
export async function readOrganizationPortfolioProject(request: OrganizationRequest, linkId: string, reportId?: string) {
  let project: C.OrgPortfolioProject, asOf: string, contentHash: string;
  if (reportId) {
    const { view } = await readOrganizationPortfolioReport(request, reportId);
    if (!view.report) throw new DomainError("ORG_REPORT_WITHDRAWN", "The original edition's project or source permission ended. Its private aggregate detail is withheld.", 410);
    const found = view.report.snapshot.projects.find(row => row.linkId === linkId);
    if (!found) throw unavailable();
    project = found; asOf = view.report.snapshot.asOf; contentHash = view.report.contentHash;
  } else {
    const { portfolio } = await readOrganizationPortfolio(request, undefined, { ...emptyFilters, linkIds: [linkId] });
    const found = portfolio.live.projects.find(row => row.linkId === linkId);
    if (!found) throw unavailable();
    project = found; asOf = portfolio.live.asOf; contentHash = project.lineage?.aggregateHash ?? portfolio.live.basisHash;
  }
  return { detail: C.orgPortfolioDetailSchema.parse({ scope: request.organizationScope, reportId: reportId ?? null, contentHash, asOf, project,
    definitions: definitions.filter(item => project.disclosedSections.includes(item.metric === "original_receipts" || item.metric === "current_funding" || item.metric === "unpaid_promises" ? "funding" : item.metric)),
    notices: ["This drill-through contains only explicitly approved project aggregates. Private actors, receipts, evidence documents, provider identifiers and source images are not included."] }) };
}
function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export async function exportOrganizationPortfolio(request: OrganizationRequest, id: string) {
  const { view } = await readOrganizationPortfolioReport(request, id);
  if (!view.report || !view.canExport) throw new DomainError("ORG_REPORT_WITHDRAWN", "The original source or disclosure permission ended. This edition cannot be exported.", 410);
  const report = view.report, rows: unknown[][] = [["Edition", report.id], ["Edition label", report.label], ["Organization", report.organization.name, "Self-declared"],
    ["Content SHA-256", report.contentHash], ["Basis SHA-256", report.snapshot.basisHash], ["Semantic version", report.snapshot.semanticVersion], ["Original cutoff UTC", report.snapshot.asOf], ["Status", view.status],
    ["Audience", report.audience.label], ["Scope", report.audience.scope], ["Original explicit filters", JSON.stringify(report.snapshot.filters)],
    ["Original source observed range UTC", report.snapshot.sourceObservedRange?.earliest ?? "", report.snapshot.sourceObservedRange?.latest ?? ""],
    ["Values", "All money columns use integer minor units; separate currencies/provenance must never be summed together."], [],
    ["Coverage", "Metric", "Value"]];
  for (const [section, coverage] of Object.entries(report.snapshot.coverage)) for (const [key, value] of Object.entries(coverage)) rows.push([section, key, value]);
  rows.push([], ["Group currency", "Group provenance", "Metric", "Value"]);
  for (const group of report.snapshot.groups) {
    rows.push([group.currency, group.provenance, "Project count", group.projectCount], [group.currency, group.provenance, "Budget minor", group.budgetMinor]);
    for (const section of ["funding", "expenses", "evidence"] as const) if (group[section]) for (const [key, value] of Object.entries(group[section]!)) rows.push([group.currency, group.provenance, `${section}.${key}`, value]);
    for (const [section, coverage] of Object.entries(group.coverage)) for (const [key, value] of Object.entries(coverage)) rows.push([group.currency, group.provenance, `${section}.coverage.${key}`, value]);
  }
  rows.push([],
    ["Project", "Link", "State", "Currency", "Provenance", "Metric", "Value", "Denominator", "Original project version", "Original event cursor", "Original disclosure revision"]);
  for (const project of report.snapshot.projects) {
    const add = (currency: string, provenance: string, metric: string, value: unknown, denominator: unknown = "") => rows.push([project.project?.title ?? "Disclosure unavailable", project.linkId, project.state, currency, provenance, metric, value, denominator, project.lineage?.projectVersion ?? "", project.lineage?.eventCursor ?? "", project.consentRevision]);
    if (!project.project) add("", "", "Reason", project.reasons.join(" "));
    if (project.lineage) for (const [key, value] of Object.entries(project.lineage)) add("", "", `Original lineage.${key}`, value);
    if (project.budget) add(project.budget.currency, project.budget.provenance, "Canonical budget minor", project.budget.amountMinor);
    for (const money of project.money) for (const section of ["funding", "expenses"] as const) if (money[section]) for (const [key, value] of Object.entries(money[section]!)) add(money.currency, money.provenance, `${section}.${key}`, value);
    for (const evidence of project.evidence) {
      add(project.project?.currency ?? "", evidence.provenance, "Accepted review items", evidence.values.acceptedReviewItems, evidence.values.requiredReviewItems);
      add(project.project?.currency ?? "", evidence.provenance, "Accepted packages", evidence.values.acceptedPackages, evidence.values.packageCount);
      add(project.project?.currency ?? "", evidence.provenance, "Current scoped signoffs", evidence.values.currentScopedSignoffs);
      add(project.project?.currency ?? "", evidence.provenance, "Reviewed illustrations", evidence.values.reviewedIllustrations);
    }
    for (const notice of [...project.reasons, ...project.notices]) add("", "", "Limitation", notice);
  }
  for (const notice of report.snapshot.notices) rows.push(["Edition limitation", notice]);
  const csv = rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const checked = await readOrganizationPortfolioReport(request, id);
  if (!checked.view.canExport || checked.view.summary.contentHash !== report.contentHash) throw new DomainError("ORG_REPORT_WITHDRAWN", "Permission changed while this export was prepared. Its content is withheld.", 410);
  return { csv, filename: `fieldproof-organization-portfolio-${id}.csv` };
}
