import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ORG_GOVERNANCE_VERSION, ORG_PAGE_SIZE, orgAdoptSchema, orgAdoptionReviewSchema, orgAdoptionSelectionSchema,
  orgAdoptionSummarySchema, orgPolicyApplicationSchema, orgProjectParticipationSchema,
  orgProjectRuleDeactivateSchema, orgProjectRuleReplaceReviewInputSchema, orgProjectRuleReplaceReviewSchema,
  orgProjectRuleReplaceSchema, type OrgAdoptionSelection, type OrgPolicyDefinition,
} from "../organizations/contracts";
import { proposedPlanSchema, type ProposedPlan } from "../planning/contracts";
import { manualPlan } from "../planning/templates";
import { validatePlan } from "../planning/geometry";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { query } from "./db";
import { appendEvent } from "./repository";
import { sealPrivate, openPrivate } from "./private-values";
import { currentSourceCheck, insertPlan, packageBindings, planPayload, planningHead, publishedPlan, requirePlan, sourceBindings } from "./planning-store";
import {
  assertOrganizationCurrent, findOrgCommand, orgCursor, orgHash, orgNow, orgPage, orgPrivateContext,
  organizationAudit, organizationCommand, organizationTransaction, requireOrganization, saveOrgCommand,
  type OrgIdentity, type OrgTx, type OrganizationRequest,
} from "./organization-core";
import {
  assertOrganizationProjectBasis, assertOrganizationProjectCurrent, currentOrganizationLink, lockProjectGovernanceHead,
  organizationLinkById, organizationProjectBasis, organizationProjectContext, organizationProjectSummary,
  projectPackageEncumbrances, requireOrganizationProject, type OrganizationProjectAuthority, type OrgLinkRow,
} from "./organization-projects";
import { organizationPolicyVersionById, policyConsumers, publishedOrganizationDefinition, publishedOrganizationPolicy, retainedProjectHistory } from "./organization-policies";
import {
  activeProjectPolicies, bindProjectPolicyArtifacts, compileProjectPolicy, mergeProjectRuleRequirements,
  projectPolicyDocument, projectPolicyLock, projectPolicyPlanIssues, projectRuleContext, projectRuleHash,
  type ActiveProjectRule, type ProjectPolicyRow, type ProjectRuleDocument,
} from "./project-policy";

type Choice = Pick<OrgAdoptionSelection, "mappings" | "planSource" | "reviseCanonicalEmptyPackages" | "reviewedQuotes">;
type CanonicalRow = { id: string; version: number; budget_minor: string; data: Record<string, unknown> };
type PackageChange = z.infer<typeof orgAdoptionReviewSchema>["packageChanges"][number];
async function prepareRule(tx: OrgTx, project: OrganizationProjectAuthority, definition: OrgPolicyDefinition, choice: Choice, excludedId?: string, lock = false) {
  const session = project.session, packages = await packageBindings(session.projectId, tx), compiled = compileProjectPolicy(definition, choice.mappings, packages.map(pkg => pkg.packageId));
  const summary = await organizationProjectSummary(tx, session), blockers: string[] = [], warnings: string[] = [];
  if (!definition.templateIds.includes(summary.templateId)) blockers.push("This reusable definition does not include the target project's template.");
  if (summary.currency !== "USD") blockers.push("These reviewed package and fund rules use USD; the target project's currency must match explicitly.");
  const others = (await activeProjectPolicies(tx, session, false)).filter(rule => rule.row.id !== excludedId);
  const canonical = await query<CanonicalRow>("SELECT id,version,budget_minor,data FROM fp_packages WHERE project_id=$1 ORDER BY id", [session.projectId], tx);
  let plan: ProposedPlan | null = null;
  if (choice.planSource.strategy === "current_draft") {
    const head = await planningHead(session, tx);
    if (!head.current_plan_id) blockers.push("There is no current target-project draft to copy. Choose a validated local sketch instead.");
    else {
      const row = await requirePlan(session, head.current_plan_id, tx), payload = planPayload(row);
      if ((await currentSourceCheck(session, payload.sources, tx)).length) blockers.push("The selected current draft has a changed or withdrawn source. Review a new target draft first.");
      plan = structuredClone(payload.plan);
    }
  } else if (choice.planSource.strategy === "new_draft") plan = manualPlan(choice.planSource.sketchDocumentId!, choice.planSource.page!, packages);
  else if (definition.kind !== "fund_restriction") blockers.push("Evidence and package rules need an actual editable target-project plan.");
  if (definition.kind === "fund_restriction" && choice.reviseCanonicalEmptyPackages) blockers.push("A fund restriction cannot rewrite canonical package definitions.");
  const changes: PackageChange[] = [], usedQuotes = new Set<string>();
  if (!choice.reviseCanonicalEmptyPackages && choice.reviewedQuotes.length) blockers.push("Remove unused canonical quote mappings or explicitly review a canonical empty-package revision.");
  if (choice.reviseCanonicalEmptyPackages && definition.kind !== "package_library") blockers.push("Only an explicit package library can propose a canonical empty-package revision.");
  if (choice.reviseCanonicalEmptyPackages && definition.kind === "package_library") for (const mapping of choice.mappings) for (const id of mapping.targetPackageIds) {
    const source = definition.packages.find(pkg => pkg.key === mapping.policyPackageKey)!, target = canonical.find(pkg => pkg.id === id)!;
    const quotes = choice.reviewedQuotes.filter(quote => quote.policyPackageKey === mapping.policyPackageKey && quote.targetPackageId === id);
    if (quotes.length !== 1) { blockers.push(`Target purpose ${id} needs exactly one reviewed local quote and amount.`); continue; }
    const quote = quotes[0]; usedQuotes.add(`${mapping.policyPackageKey}:${id}`);
    const encumbrances = await projectPackageEncumbrances(tx, session, id);
    if (target.data.fundingState !== "open" || encumbrances.length) blockers.push(`Target purpose ${id} has original financial or evidence history and cannot be revised as empty.`);
    changes.push({ packageId: id, title: source.title, beforeVersion: target.version, beforeBudgetMinor: Number(target.budget_minor), proposedBudgetMinor: quote.reviewedBudgetMinor, quoteCitationId: quote.citation.id });
    if (source.proposedBudgetMinor !== quote.reviewedBudgetMinor) warnings.push(`The reviewed target quote for ${id} differs from the reusable library's proposed amount. Only the explicitly reviewed local amount would become canonical.`);
  }
  if (choice.reviewedQuotes.some(quote => !usedQuotes.has(`${quote.policyPackageKey}:${quote.targetPackageId}`))) blockers.push("A supplied quote is outside the exact mapped canonical revision.");
  let issues: ProjectRuleDocument["issues"] = [];
  if (plan) {
    const requirements = [...others.flatMap(rule => rule.document.compiled.requirements), ...compiled.requirements];
    for (const pkg of plan.packages) {
      const required = requirements.filter(item => item.packageId === pkg.packageId).flatMap(item => item.requirements);
      if (required.length) { pkg.requirements = mergeProjectRuleRequirements(pkg.packageId, pkg.requirements, required); pkg.reviewState = "needs_review"; }
      if (definition.kind === "package_library") {
        const mapping = choice.mappings.find(item => item.targetPackageIds.includes(pkg.packageId)), source = definition.packages.find(item => item.key === mapping?.policyPackageKey);
        if (source) { pkg.title = source.title; pkg.capabilities = source.capabilities; pkg.budgetMinor = source.proposedBudgetMinor; pkg.quoteCitationIds = []; pkg.reviewState = "needs_review"; }
      }
      const quote = choice.reviewedQuotes.find(item => item.targetPackageId === pkg.packageId);
      if (quote && choice.reviseCanonicalEmptyPackages) {
        const prior = plan.citations.find(item => item.id === quote.citation.id);
        if (prior && orgHash(prior) !== orgHash(quote.citation)) blockers.push("A reviewed quote reuses an existing citation identifier for different source content.");
        if (!prior) plan.citations.push(quote.citation);
        pkg.quoteCitationIds = [quote.citation.id]; pkg.budgetMinor = quote.reviewedBudgetMinor; pkg.reviewState = "needs_review";
      }
    }
    const strength = { included: 0, accepted_work: 1, safety_signoff: 2 };
    for (const dependency of [...others.flatMap(rule => rule.document.compiled.dependencies), ...compiled.dependencies]) {
      const current = plan.dependencies.find(item => item.packageId === dependency.packageId && item.prerequisiteId === dependency.prerequisiteId);
      if (!current) plan.dependencies.push({ ...dependency, citationId: null });
      else if (strength[current.kind] < strength[dependency.kind]) { current.kind = dependency.kind; current.reason = dependency.reason; }
    }
    plan = proposedPlanSchema.parse(plan);
    const sources = await sourceBindings(session, [plan.sourceDocumentId, ...plan.citations.map(c => c.documentId)], tx, lock);
    issues = validatePlan(plan, sources, packages.map(pkg => pkg.packageId)).issues;
    // Geometry/review issues remain an honest editable proposal. Source identity,
    // source permission and malformed citations are never invented for adoption.
    for (const issue of issues) if (["SOURCE_SKETCH_MISSING", "SOURCE_REGION_INVALID", "QUOTE_SOURCE_INVALID", "QUOTE_LINK_INVALID"].includes(issue.code)) blockers.push(issue.message);
    if (definition.kind === "evidence_policy" && sources.some(source => !definition.allowedSourceProvenance.includes(source.provenance))) blockers.push("The target draft includes a source class excluded by this evidence policy.");
    if (issues.length) warnings.push("This creates an editable proposal with unresolved checks. It does not approve a plan or certify completed physical work.");
  }
  if (choice.reviseCanonicalEmptyPackages && !plan) blockers.push("A canonical package revision requires a materialized plan carrying the reviewed local citations.");
  return { compiled, plan, issues, canonical, changes, blockers: [...new Set(blockers)], warnings: [...new Set(warnings)], project: summary };
}
async function adoptionSelection(tx: OrgTx, request: OrganizationRequest, identity: OrgIdentity, project: OrganizationProjectAuthority, selection: OrgAdoptionSelection, lock = false) {
  await assertOrganizationProjectBasis(tx, project.session, selection.expectedProjectBasis);
  const link = await organizationLinkById(tx, selection.linkId, identity.organization.id), current = await currentOrganizationLink(tx, link);
  if (link.tenant_id !== project.session.tenantId || link.project_id !== project.session.projectId || link.version !== selection.expectedLinkVersion || current.state !== "active") throw new DomainError("ORG_ADOPTION_CHANGED", "Adoption requires this exact active dual-authority project link. Review its current scope first.", 409);
  const version = await organizationPolicyVersionById(tx, identity.organization.id, selection.policyVersionId);
  if (version.state !== "active" || version.state_version !== selection.expectedPolicyStateVersion || version.content_hash !== selection.policyHash) throw new DomainError("ORG_POLICY_VERSION_CHANGED", "The selected published policy changed or retired. Review an active exact version.", 409);
  const definition = publishedOrganizationDefinition(version), prepared = await prepareRule(tx, project, definition, selection, undefined, lock);
  await assertOrganizationProjectBasis(tx, project.session, selection.expectedProjectBasis);
  const duplicates = await query("SELECT id FROM fp_project_policy_adoptions WHERE tenant_id=$1 AND project_id=$2 AND source_policy_id=$3 AND state IN ('materialized','applied')", [project.session.tenantId, project.session.projectId, version.policy_id], tx);
  if (duplicates.length) prepared.blockers.push("This reusable policy already has a current project-owned adoption. Replace or deactivate that exact original rule first.");
  const body = { selection, policy: publishedOrganizationPolicy(version, true), project: prepared.project, consumers: policyConsumers(definition.kind), proposedPlan: prepared.plan,
    issues: prepared.issues, packageChanges: prepared.changes, preservedHistory: retainedProjectHistory, warnings: prepared.warnings, blockers: prepared.blockers, canApply: !prepared.blockers.length };
  const review = orgAdoptionReviewSchema.parse({ ...body, reviewHash: orgHash(body) });
  await assertOrganizationCurrent(tx, request, identity); await assertOrganizationProjectCurrent(tx, request, project);
  return { review, prepared, version, link };
}
export async function reviewOrganizationAdoption(request: OrganizationRequest, linkId: string, raw: unknown) {
  const input = orgAdoptionSelectionSchema.parse(raw);
  if (input.linkId !== linkId) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "Review the exact selected project link.", 404);
  return organizationTransaction(async tx => {
    const identity = await requireOrganization(tx, request, input.expectedScope, ["owner", "coordinator"]), project = await requireOrganizationProject(tx, request, input.expectedProjectScope);
    return { review: (await adoptionSelection(tx, request, identity, project, input)).review };
  }, true);
}

async function materializeRule(tx: OrgTx, project: OrganizationProjectAuthority, definition: OrgPolicyDefinition, choice: Choice,
  prepared: Awaited<ReturnType<typeof prepareRule>>, link: OrgLinkRow, identity: OrgIdentity | null,
  source: ProjectRuleDocument["rule"]["sourceOrganizationPolicy"], parentId: string | null = null) {
  if (prepared.blockers.length) throw new DomainError("ORG_POLICY_REVIEW_REQUIRED", "Resolve the exact adoption review before applying this project-owned rule.", 409);
  const session = project.session, id = randomUUID(), at = await orgNow(tx), origin = source ? "organization_adoption" : "project_revision";
  const [{ version: priorHead }] = await query<{ version: number }>("SELECT version FROM fp_project_governance_heads WHERE tenant_id=$1 AND project_id=$2", [session.tenantId, session.projectId], tx);
  const adoptionHead = priorHead + 1;
  let canonicalRevision: ProjectRuleDocument["canonicalRevision"] = null, canonicalHash: string | null = null;
  if (choice.reviseCanonicalEmptyPackages && definition.kind === "package_library") {
    const [oldProject] = await query<{ version: number; metadata: Record<string, unknown> }>("SELECT version,metadata FROM fp_projects WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [session.projectId, session.tenantId], tx);
    const revised: CanonicalRow[] = [];
    for (const change of prepared.changes) {
      const old = prepared.canonical.find(pkg => pkg.id === change.packageId)!, mapping = choice.mappings.find(item => item.targetPackageIds.includes(old.id))!;
      const item = definition.packages.find(pkg => pkg.key === mapping.policyPackageKey)!;
      const data = { ...old.data, title: item.title, shortTitle: item.title, description: item.description, category: item.category,
        budgetMinor: change.proposedBudgetMinor, capabilities: item.capabilities };
      const updated = await query<CanonicalRow>("UPDATE fp_packages SET version=version+1,budget_minor=$3,data=$4::jsonb WHERE project_id=$1 AND id=$2 AND version=$5 RETURNING *", [session.projectId, old.id, change.proposedBudgetMinor, JSON.stringify(data), old.version], tx);
      if (!updated.length) throw new DomainError("ORG_PROJECT_SOURCE_CHANGED", "The exact canonical package changed during this review.", 409);
      revised.push(updated[0]);
    }
    const all = await packageBindings(session.projectId, tx), total = all.reduce((sum, pkg) => sum + pkg.budgetMinor, 0);
    if (!Number.isSafeInteger(total)) throw new DomainError("ORG_POLICY_INVALID", "The resulting canonical budget exceeds the supported exact range.", 422);
    const nextMetadata = { ...oldProject.metadata, targetMinor: total };
    await tx.query("UPDATE fp_projects SET version=version+1,metadata=$3::jsonb WHERE id=$1 AND tenant_id=$2", [session.projectId, session.tenantId, JSON.stringify(nextMetadata)]);
    const [{ version }] = await query<{ version: number }>("SELECT COALESCE(max(version),0)::integer+1 AS version FROM fp_project_package_revisions WHERE tenant_id=$1 AND project_id=$2", [session.tenantId, session.projectId], tx);
    const revisionId = randomUUID(), value = { schemaVersion: ORG_GOVERNANCE_VERSION, adoptionId: id, tenantId: session.tenantId, projectId: session.projectId,
      before: { project: oldProject, packages: prepared.canonical.filter(pkg => prepared.changes.some(change => change.packageId === pkg.id)) },
      after: { project: { version: oldProject.version + 1, metadata: nextMetadata }, packages: revised }, reviewedQuotes: choice.reviewedQuotes,
      authority: { sessionId: session.id, actorId: session.actorId, membershipVersion: project.membershipVersion }, at: at.toISOString() };
    canonicalHash = orgHash(value);
    await tx.query("INSERT INTO fp_project_package_revisions(id,tenant_id,project_id,adoption_id,version,content_hash,encrypted_data,actor_id,membership_version,session_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [revisionId, session.tenantId, session.projectId, id, version, canonicalHash, sealPrivate(value, orgPrivateContext("canonical-revision", revisionId)), session.actorId, project.membershipVersion, session.id, at]);
    canonicalRevision = { id: revisionId, version, packages: revised.map(pkg => ({ id: pkg.id, version: pkg.version, budgetMinor: Number(pkg.budget_minor) })) };
  }
  let materializedPlan: ProjectRuleDocument["materializedPlan"] = null;
  if (prepared.plan) {
    const head = await planningHead(session, tx, true), row = await insertPlan(session, head, prepared.plan, "manual", null, tx);
    materializedPlan = { id: row.id, revision: row.revision, headVersion: head.version + 1, contentHash: row.content_hash };
  }
  const rule = { origin, definition, sourceOrganizationPolicy: source, createdAt: at.toISOString() } as const;
  const hash = projectRuleHash(rule, choice.mappings), document: ProjectRuleDocument = { schemaVersion: ORG_GOVERNANCE_VERSION,
    rule: { ...rule, contentHash: hash }, mappings: choice.mappings, compiled: prepared.compiled, consumers: policyConsumers(definition.kind),
    issues: prepared.issues, materializedPlan, canonicalRevision };
  const [row] = await query<ProjectPolicyRow>(`INSERT INTO fp_project_policy_adoptions(id,tenant_id,project_id,link_id,source_organization_id,source_policy_id,source_policy_version_id,parent_adoption_id,origin,kind,title,rule_hash,encrypted_rule,mappings,adoption_head,state,project_actor_id,project_membership_version,project_session_id,org_membership_id,org_membership_version,org_session_id,materialized_plan_id,materialized_plan_revision,canonical_revision_id,adopted_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$26) RETURNING *`,
    [id, session.tenantId, session.projectId, link.id, link.organization_id, source?.policyId ?? null, source?.versionId ?? null, parentId, origin, definition.kind, definition.title,
      hash, sealPrivate(document, projectRuleContext({ id, tenant_id: session.tenantId, project_id: session.projectId })), JSON.stringify(choice.mappings), adoptionHead,
      definition.kind === "fund_restriction" ? "applied" : "materialized", session.actorId, project.membershipVersion, session.id, identity?.member.id ?? null,
      identity?.member.version ?? null, identity?.session.id ?? null, materializedPlan?.id ?? null, materializedPlan?.revision ?? null, canonicalRevision?.id ?? null, at], tx);
  await tx.query("UPDATE fp_project_governance_heads SET version=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND project_id=$2", [session.tenantId, session.projectId, adoptionHead]);
  const rules = [{ row, document }];
  for (const consumer of document.consumers) {
    if (consumer === "planning_draft" && materializedPlan) await bindProjectPolicyArtifacts(tx, rules, consumer, materializedPlan.id, materializedPlan.contentHash, session, "materialized", ["An editable proposal requires a fresh target-project review and publication."]);
    else if (consumer === "canonical_empty_packages") await bindProjectPolicyArtifacts(tx, rules, consumer, canonicalRevision?.id ?? `not-selected:${id}`, canonicalHash ?? hash, session,
      canonicalRevision ? "enforced" : "not_applicable", canonicalRevision ? ["Only reviewed empty canonical purposes changed; their prior values remain in an immutable revision."] : ["The project explicitly retained its current canonical packages."]);
    else await bindProjectPolicyArtifacts(tx, rules, consumer, `guard:${id}:${consumer}`, hash, session, "enforced", ["Prospective decisions use this copied rule. Original decisions keep their original contracts."]);
  }
  await appendEvent(tx, session, "organization.project_rule_adopted", source ? "A reusable rule was adopted into this project" : "A project-owned rule received a deliberate replacement", "The exact target mapping and prospective rule were recorded. Original financial decisions, physical reviews and access deadlines remain unchanged.");
  await organizationAudit(tx, link.organization_id, "organization.project_rule_adopted", identity,
    { title: "A project recorded its own rule revision", detail: "The project reviewed its exact mapping and prospective consumers. Its existing approvals and financial history remain unchanged.", adoptionId: id, linkId: link.id, sourceVersionId: source?.versionId ?? null },
    identity ? undefined : { origin: "project_session", sessionId: session.id, membershipVersion: project.membershipVersion, role: session.role });
  return row;
}
export async function adoptOrganizationPolicy(request: OrganizationRequest, linkId: string, raw: unknown) {
  const input = orgAdoptSchema.parse(raw);
  if (input.selection.linkId !== linkId) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "Apply the exact reviewed project link.", 404);
  const receipt = await organizationCommand(request, input, "adopt_policy", ["owner", "coordinator"], async (tx, identity) => {
    const project = await requireOrganizationProject(tx, request, input.expectedProjectScope, true);
    await lockProjectGovernanceHead(tx, project.session); await projectPolicyLock(tx, project.session.projectId, true);
    const selected = await adoptionSelection(tx, request, identity, project, input.selection, true);
    if (!selected.review.canApply || selected.review.reviewHash !== input.reviewHash) throw new DomainError("ORG_POLICY_REVIEW_REQUIRED", "Apply only the original exact target-project review after resolving its blockers.", 409);
    const v = selected.version, row = await materializeRule(tx, project, selected.review.policy.definition, input.selection, selected.prepared, selected.link, identity,
      { organizationId: identity.organization.id, policyId: v.policy_id, versionId: v.id, revision: v.revision, contentHash: v.content_hash });
    await assertOrganizationProjectCurrent(tx, request, project);
    return { resourceId: row.id, resourceVersion: row.version, message: row.state === "applied" ? "The copied project fund rule now guards new decisions. Original choices and payments are retained." : "The copied project rule produced an editable target plan. Review and publish it before claiming current evidence compliance." };
  }, { linkId });
  return { receipt, ...await organizationPolicyApplication(request, linkId, receipt.resourceId!) };
}

async function projectAdoption(tx: OrgTx, project: OrganizationProjectAuthority, linkId: string, id: string, lock = false) {
  const [row] = await query<ProjectPolicyRow>(`SELECT * FROM fp_project_policy_adoptions WHERE tenant_id=$1 AND project_id=$2 AND link_id=$3 AND id=$4${lock ? " FOR UPDATE" : ""}`,
    [project.session.tenantId, project.session.projectId, linkId, id], tx);
  if (!row) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This copied rule is outside your independent current project.", 404);
  return row;
}
async function adoptionState(tx: OrgTx, row: ProjectPolicyRow) {
  const document = projectPolicyDocument(row), historical = ["superseded", "deactivated"].includes(row.state);
  if (historical || row.kind === "fund_restriction") return { document, state: row.state, complianceState: historical ? "historical" as const : "current" as const, issues: historical ? document.issues : [] };
  const published = await publishedPlan({ tenantId: row.tenant_id, projectId: row.project_id }, tx);
  const issues = published?.view.state === "current" ? projectPolicyPlanIssues(published.payload.plan, [{ row, document }]) : document.issues;
  const [bound] = published?.view.state === "current" && !issues.length ? await query("SELECT id FROM fp_project_policy_artifacts WHERE adoption_id=$1 AND consumer='plan_publication' AND artifact_id=$2 AND artifact_hash=$3 AND adoption_head=$4 AND state='enforced'", [row.id, published.view.publicationId, published.row.content_hash, row.adoption_head], tx) : [];
  return { document, state: bound ? "applied" : row.state, complianceState: bound ? "current" as const : published ? "gap" as const : "pending_publication" as const, issues };
}
export async function organizationAdoptionSummary(tx: OrgTx, row: ProjectPolicyRow, projectPrivate = false) {
  const current = await adoptionState(tx, row), source = current.document.rule.sourceOrganizationPolicy;
  return orgAdoptionSummarySchema.parse({ id: row.id, linkId: row.link_id, version: row.version, policyId: row.source_policy_id, policyVersionId: row.source_policy_version_id,
    policyRevision: source?.revision ?? null, policyHash: source?.contentHash ?? null, ruleHash: row.rule_hash, origin: row.origin,
    title: row.origin === "project_revision" && !projectPrivate ? "Project-owned rule revision" : row.title, kind: row.kind, state: current.state,
    adoptedAt: row.adopted_at.toISOString(), complianceState: current.complianceState, issueCount: current.issues.length,
    materializedPlanRevision: row.materialized_plan_revision, consumers: current.document.consumers });
}
export async function organizationAdoptionsPage(tx: OrgTx, identity: OrgIdentity, linkId?: string, before?: string) {
  const owner = `${identity.organization.id}:${linkId ?? "all"}:adoptions`, cursor = orgCursor(before, owner);
  const links = await query<OrgLinkRow>("SELECT * FROM fp_org_project_links WHERE organization_id=$1 AND ($2::text IS NULL OR id=$2) ORDER BY id FOR SHARE", [identity.organization.id, linkId ?? null], tx);
  if (linkId && !links.length) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This project link is unavailable in the current organization.", 404);
  const active: string[] = [];
  for (const link of links) if ((await currentOrganizationLink(tx, link, true)).state === "active") active.push(link.id);
  const rows = await query<ProjectPolicyRow>("SELECT * FROM fp_project_policy_adoptions WHERE source_organization_id=$1 AND link_id=ANY($2::text[]) AND ($3::timestamptz IS NULL OR (adopted_at,id)<($3::timestamptz,$4::text)) ORDER BY adopted_at DESC,id DESC LIMIT $5", [identity.organization.id, active, cursor?.at ?? null, cursor?.id ?? null, ORG_PAGE_SIZE + 1], tx);
  const page = orgPage(rows.map(row => ({ ...row, created_at: row.adopted_at })), owner);
  const adoptions = []; for (const row of page.rows) adoptions.push(await organizationAdoptionSummary(tx, row));
  return { adoptions, nextCursor: page.nextCursor };
}
export async function organizationProjectParticipation(request: OrganizationRequest, before?: string) {
  return organizationTransaction(async tx => {
    const context = await organizationProjectContext(tx, request);
    if (context.state !== "active" || context.role !== "organizer") return { participation: orgProjectParticipationSchema.parse({ projectContext: context, links: [], adoptions: [], nextAdoptionCursor: null }) };
    const project = await requireOrganizationProject(tx, request, request.projectScope ?? context.scope), owner = `${project.session.id}:project-adoptions`, cursor = orgCursor(before, owner);
    const rows = await query<OrgLinkRow & { organization_name: string }>("SELECT l.*,o.name AS organization_name FROM fp_org_project_links l JOIN fp_organizations o ON o.id=l.organization_id WHERE l.tenant_id=$1 AND l.project_id=$2 ORDER BY l.created_at,l.id", [project.session.tenantId, project.session.projectId], tx);
    const links = [];
    for (const row of rows) {
      const current = await currentOrganizationLink(tx, row);
      links.push({ id: row.id, version: row.version, organizationName: row.organization_name, state: current.state, disclosure: current.consent.disclosure,
        expiresAt: current.consent.expires_at.toISOString(), canWithdraw: row.state !== "withdrawn", reasons: current.reasons });
    }
    const adopted = await query<ProjectPolicyRow>("SELECT * FROM fp_project_policy_adoptions WHERE tenant_id=$1 AND project_id=$2 AND ($3::timestamptz IS NULL OR (adopted_at,id)<($3::timestamptz,$4::text)) ORDER BY adopted_at DESC,id DESC LIMIT $5", [project.session.tenantId, project.session.projectId, cursor?.at ?? null, cursor?.id ?? null, ORG_PAGE_SIZE + 1], tx);
    const page = orgPage(adopted.map(row => ({ ...row, created_at: row.adopted_at })), owner), adoptions = [];
    for (const row of page.rows) adoptions.push(await organizationAdoptionSummary(tx, row, true));
    await assertOrganizationProjectCurrent(tx, request, project);
    return { participation: orgProjectParticipationSchema.parse({ projectContext: context, links, adoptions, nextAdoptionCursor: page.nextCursor }) };
  }, true);
}
export async function organizationPolicyApplication(request: OrganizationRequest, linkId: string, id: string) {
  return organizationTransaction(async tx => {
    const project = await requireOrganizationProject(tx, request, request.projectScope), row = await projectAdoption(tx, project, linkId, id), current = await adoptionState(tx, row);
    const artifacts = await query<{ id: string; consumer: string; state: string; adoption_head: number; encrypted_data: string; created_at: Date }>("SELECT * FROM fp_project_policy_artifacts WHERE adoption_id=$1 ORDER BY created_at,id", [id], tx);
    // Bounded one-per-consumer projection; actual immutable subject bindings stay
    // in the private audit. Prefer a current real artifact over its guard record.
    const bindings = new Map<string, unknown>();
    for (const artifact of artifacts) {
      const value = openPrivate<{ bindingHash: string; limitations: string[]; [key: string]: unknown }>(artifact.encrypted_data, orgPrivateContext("policy-artifact", artifact.id));
      const { bindingHash, ...body } = value;
      if (bindingHash !== orgHash(body)) throw new DomainError("ORG_ADOPTION_CHANGED", "This original consumer binding could not be verified.", 409);
      bindings.set(artifact.consumer, { consumer: artifact.consumer, state: artifact.state, adoptionHead: artifact.adoption_head, bindingHash,
        appliedAt: artifact.created_at.toISOString(), limitations: value.limitations });
    }
    const historical = ["deactivated", "superseded"].includes(row.state);
    const application = orgPolicyApplicationSchema.parse({ projectScope: project.scope, summary: await organizationAdoptionSummary(tx, row, true), rule: current.document.rule,
      projectBasis: await organizationProjectBasis(tx, project.session), mappings: current.document.mappings, bindings: [...bindings.values()],
      materializedPlan: current.document.materializedPlan, canonicalRevision: current.document.canonicalRevision,
      issues: current.issues, preservedHistory: retainedProjectHistory, canDeactivate: !historical, canReplace: !historical });
    await assertOrganizationProjectCurrent(tx, request, project);
    return { application };
  }, true);
}
async function replacementReview(tx: OrgTx, project: OrganizationProjectAuthority, row: ProjectPolicyRow, input: z.infer<typeof orgProjectRuleReplaceReviewInputSchema>, lock = false) {
  await assertOrganizationProjectBasis(tx, project.session, input.expectedProjectBasis);
  if (row.version !== input.expectedVersion || ["superseded", "deactivated"].includes(row.state)) throw new DomainError("ORG_ADOPTION_CHANGED", "This project rule changed or ended. Review its current saved state first.", 409);
  const prepared = await prepareRule(tx, project, input.definition, input, row.id, lock);
  await assertOrganizationProjectBasis(tx, project.session, input.expectedProjectBasis);
  const body = { input, issues: prepared.issues, blockers: prepared.blockers, warnings: prepared.warnings, proposedPlan: prepared.plan,
    consumers: policyConsumers(input.definition.kind), preservedHistory: retainedProjectHistory, canApply: !prepared.blockers.length };
  return { prepared, review: orgProjectRuleReplaceReviewSchema.parse({ ...body, reviewHash: orgHash({ adoptionId: row.id, ...body }) }) };
}
export async function reviewProjectRuleReplacement(request: OrganizationRequest, linkId: string, id: string, raw: unknown) {
  const input = orgProjectRuleReplaceReviewInputSchema.parse(raw);
  return organizationTransaction(async tx => {
    const project = await requireOrganizationProject(tx, request, input.expectedProjectScope), row = await projectAdoption(tx, project, linkId, id);
    const result = await replacementReview(tx, project, row, input);
    await assertOrganizationProjectCurrent(tx, request, project);
    return { review: result.review };
  }, true);
}
export async function replaceProjectRule(request: OrganizationRequest, linkId: string, id: string, raw: unknown) {
  const input = orgProjectRuleReplaceSchema.parse(raw);
  const result = await organizationTransaction(async tx => {
    const project = await requireOrganizationProject(tx, request, input.expectedProjectScope, true), actorKey = `project:${project.session.id}`, original = { input, linkId, id };
    const saved = await findOrgCommand(tx, actorKey, input.intentId, "replace_project_rule", original);
    if (saved) return { receipt: saved.result };
    await lockProjectGovernanceHead(tx, project.session); await projectPolicyLock(tx, project.session.projectId, true);
    const row = await projectAdoption(tx, project, linkId, id, true), selected = await replacementReview(tx, project, row, input.input, true);
    if (!selected.review.canApply || selected.review.reviewHash !== input.reviewHash) throw new DomainError("ORG_POLICY_REVIEW_REQUIRED", "Replace only the exact separately reviewed project rule.", 409);
    const link = await organizationLinkById(tx, linkId), next = await materializeRule(tx, project, input.input.definition, input.input, selected.prepared, link, null, null, id);
    await tx.query("UPDATE fp_project_policy_adoptions SET state='superseded',superseded_by=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1", [id, next.id]);
    await assertOrganizationProjectCurrent(tx, request, project);
    return { receipt: await saveOrgCommand(tx, actorKey, input, "replace_project_rule", original,
      { resourceId: next.id, resourceVersion: next.version, message: "A new project-owned rule replaces this rule prospectively. The original organization version and prior decisions remain recorded." }, { organizationId: row.source_organization_id }) };
  });
  return { ...result, ...await organizationPolicyApplication(request, linkId, (result.receipt as { resourceId: string }).resourceId) };
}
export async function deactivateProjectRule(request: OrganizationRequest, linkId: string, id: string, raw: unknown) {
  const input = orgProjectRuleDeactivateSchema.parse(raw);
  return organizationTransaction(async tx => {
    const project = await requireOrganizationProject(tx, request, input.expectedProjectScope, true), actorKey = `project:${project.session.id}`, original = { input, linkId, id };
    const saved = await findOrgCommand(tx, actorKey, input.intentId, "deactivate_project_rule", original);
    if (saved) return { receipt: saved.result };
    const head = await lockProjectGovernanceHead(tx, project.session); await projectPolicyLock(tx, project.session.projectId, true);
    await assertOrganizationProjectBasis(tx, project.session, input.expectedProjectBasis);
    const row = await projectAdoption(tx, project, linkId, id, true);
    if (row.version !== input.expectedVersion || ["superseded", "deactivated"].includes(row.state)) throw new DomainError("ORG_ADOPTION_CHANGED", "This rule changed or ended. Review its current version.", 409);
    await tx.query("UPDATE fp_project_policy_adoptions SET state='deactivated',deactivated_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1", [id]);
    await tx.query("UPDATE fp_project_governance_heads SET version=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND project_id=$2", [project.session.tenantId, project.session.projectId, head.adoptionHead + 1]);
    await appendEvent(tx, project.session, "organization.project_rule_deactivated", "A project-owned rule was ended prospectively", "Existing plans, physical reviews, promised funding terms, payments and original history are retained.");
    await organizationAudit(tx, row.source_organization_id, "organization.project_rule_deactivated", null,
      { title: "A project ended a copied rule for new decisions", detail: "The independent project organizer retained original decisions and financial history.", adoptionId: id, reason: input.reason },
      { origin: "project_session", sessionId: project.session.id, membershipVersion: project.membershipVersion, role: "organizer" });
    await assertOrganizationProjectCurrent(tx, request, project);
    return { receipt: await saveOrgCommand(tx, actorKey, input, "deactivate_project_rule", original,
      { resourceId: id, resourceVersion: row.version + 1, message: "The rule no longer applies to new decisions. Original rule and artifact bindings remain retained." }, { organizationId: row.source_organization_id }) };
  });
}
