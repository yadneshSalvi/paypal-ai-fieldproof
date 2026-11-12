import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ORG_GOVERNANCE_VERSION, orgPackageMappingsSchema, orgPolicyDefinitionSchema, orgRuleSnapshotSchema,
  type OrgConsumerKind, type OrgPolicyDefinition,
} from "../organizations/contracts";
import { defaultRequirements, type EvidenceRequirement, type PlanDependency, type ProposedPlan } from "../planning/contracts";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { query } from "./db";
import { orgHash, orgPrivateContext, type OrgTx } from "./organization-core";
import { openPrivate, sealPrivate } from "./private-values";
import { publishedPlan, type PlanPayload } from "./planning-store";

export type ProjectPolicyMappings = z.infer<typeof orgPackageMappingsSchema>;
export interface CompiledProjectRule {
  packageIds: string[];
  requirements: { packageId: string; requirements: EvidenceRequirement[] }[];
  dependencies: Omit<PlanDependency, "citationId">[];
}
export interface ProjectRuleDocument {
  schemaVersion: typeof ORG_GOVERNANCE_VERSION;
  rule: z.infer<typeof orgRuleSnapshotSchema>;
  mappings: ProjectPolicyMappings;
  compiled: CompiledProjectRule;
  consumers: OrgConsumerKind[];
  issues: { code: string; path: string; message: string; severity: "error" | "review" | "notice" }[];
  materializedPlan: { id: string; revision: number; headVersion: number; contentHash: string } | null;
  canonicalRevision: { id: string; version: number; packages: { id: string; version: number; budgetMinor: number }[] } | null;
}
export interface ProjectPolicyRow {
  id: string; tenant_id: string; project_id: string; link_id: string; source_organization_id: string;
  source_policy_id: string | null; source_policy_version_id: string | null; parent_adoption_id: string | null;
  origin: "organization_adoption" | "project_revision"; kind: OrgPolicyDefinition["kind"]; title: string;
  rule_hash: string; encrypted_rule: string; mappings: ProjectPolicyMappings; adoption_head: number; version: number;
  state: "draft" | "materialized" | "applied" | "superseded" | "deactivated";
  project_actor_id: string; project_membership_version: number; project_session_id: string;
  org_membership_id: string | null; org_membership_version: number | null; org_session_id: string | null;
  materialized_plan_id: string | null; materialized_plan_revision: number | null; canonical_revision_id: string | null;
  superseded_by: string | null; deactivated_at: Date | null; adopted_at: Date; updated_at: Date;
}
export interface ActiveProjectRule { row: ProjectPolicyRow; document: ProjectRuleDocument; }
export const projectRuleContext = (scope: { tenant_id: string; project_id: string; id: string }) => orgPrivateContext(`project-rule:${scope.tenant_id}:${scope.project_id}`, scope.id);
export const projectRuleHash = (rule: Pick<ProjectRuleDocument["rule"], "origin" | "definition" | "sourceOrganizationPolicy">, mappings: ProjectPolicyMappings) => orgHash({ origin: rule.origin, definition: rule.definition, sourceOrganizationPolicy: rule.sourceOrganizationPolicy, mappings });
export function compileProjectPolicy(definition: OrgPolicyDefinition, rawMappings: ProjectPolicyMappings, targetPackageIds: string[]): CompiledProjectRule {
  const mappings = orgPackageMappingsSchema.parse(rawMappings), keys = definition.kind === "fund_restriction" ? definition.packageKeys : definition.packages.map(pkg => pkg.key);
  if (mappings.length !== keys.length || mappings.some(mapping => !keys.includes(mapping.policyPackageKey) || mapping.targetPackageIds.some(id => !targetPackageIds.includes(id)))) throw new DomainError("ORG_POLICY_INVALID", "Map every reusable key to an existing package in this exact target project.", 422);
  const all = mappings.flatMap(mapping => mapping.targetPackageIds);
  if (definition.kind === "package_library" && new Set(all).size !== all.length) throw new DomainError("ORG_POLICY_INVALID", "Each library package must map to its own target purpose; two proposed package definitions cannot overwrite one target.", 422);
  const requirements: CompiledProjectRule["requirements"] = [];
  if (definition.kind !== "fund_restriction") for (const mapping of mappings) {
    const source = definition.packages.find(pkg => pkg.key === mapping.policyPackageKey)!;
    for (const packageId of mapping.targetPackageIds) {
      let target = requirements.find(item => item.packageId === packageId);
      if (!target) { target = { packageId, requirements: [] }; requirements.push(target); }
      for (const requirement of source.requirements) target.requirements.push({ ...requirement,
        id: `org_${orgHash({ definition: orgHash(definition), key: mapping.policyPackageKey, requirement: requirement.id, packageId }).slice(0, 32)}` });
    }
  }
  const dependencies: CompiledProjectRule["dependencies"] = [];
  if (definition.kind === "package_library") for (const dependency of definition.dependencies) {
    for (const packageId of mappings.find(item => item.policyPackageKey === dependency.packageKey)!.targetPackageIds)
      for (const prerequisiteId of mappings.find(item => item.policyPackageKey === dependency.prerequisiteKey)!.targetPackageIds) {
        if (packageId === prerequisiteId) throw new DomainError("ORG_POLICY_INVALID", "A reusable prerequisite cannot map back to the same target package.", 422);
        dependencies.push({ packageId, prerequisiteId, kind: dependency.kind, reason: dependency.reason });
      }
  }
  return { packageIds: [...new Set(all)].sort(), requirements: requirements.sort((a, b) => a.packageId.localeCompare(b.packageId)), dependencies };
}
export function projectPolicyDocument(row: ProjectPolicyRow): ProjectRuleDocument {
  const document = openPrivate<ProjectRuleDocument>(row.encrypted_rule, projectRuleContext(row));
  orgRuleSnapshotSchema.parse(document.rule); orgPolicyDefinitionSchema.parse(document.rule.definition); orgPackageMappingsSchema.parse(document.mappings);
  const source = document.rule.sourceOrganizationPolicy;
  if (document.schemaVersion !== ORG_GOVERNANCE_VERSION || row.rule_hash !== document.rule.contentHash || row.rule_hash !== projectRuleHash(document.rule, document.mappings) ||
    row.kind !== document.rule.definition.kind || row.origin !== document.rule.origin || orgHash(row.mappings) !== orgHash(document.mappings) || document.rule.createdAt !== row.adopted_at.toISOString() ||
    (row.origin === "organization_adoption" ? !source || source.organizationId !== row.source_organization_id || source.policyId !== row.source_policy_id || source.versionId !== row.source_policy_version_id
      : source !== null || row.source_policy_id !== null || row.source_policy_version_id !== null) ||
    (document.materializedPlan?.id ?? null) !== row.materialized_plan_id || (document.materializedPlan?.revision ?? null) !== row.materialized_plan_revision || (document.canonicalRevision?.id ?? null) !== row.canonical_revision_id ||
    orgHash(document.compiled) !== orgHash(compileProjectPolicy(document.rule.definition, document.mappings, document.compiled.packageIds)))
    throw new DomainError("ORG_ADOPTION_CHANGED", "This original project rule could not be verified. Its saved history is retained.", 409);
  return document;
}
/** All adoption/deactivation writers take the exclusive form after the project
 * financial/planning locks. Shared acquisition also protects the empty-head case. */
export async function projectPolicyLock(tx: OrgTx, projectId: string, write = false) {
  await tx.query(`SELECT ${write ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared"}(hashtextextended($1,0))`, [`project-policy:${projectId}`]);
}
export async function activeProjectPolicies(tx: OrgTx, scope: Pick<Session, "tenantId" | "projectId">, lock = true): Promise<ActiveProjectRule[]> {
  if (lock) await projectPolicyLock(tx, scope.projectId);
  const rows = await query<ProjectPolicyRow>("SELECT * FROM fp_project_policy_adoptions WHERE tenant_id=$1 AND project_id=$2 AND state IN ('materialized','applied') ORDER BY adoption_head,id", [scope.tenantId, scope.projectId], tx);
  return rows.map(row => ({ row, document: projectPolicyDocument(row) }));
}
const strength = { included: 0, accepted_work: 1, safety_signoff: 2 };
export function projectPolicyPlanIssues(plan: ProposedPlan, rules: ActiveProjectRule[]): ProjectRuleDocument["issues"] {
  const issues: ProjectRuleDocument["issues"] = [];
  for (const { document } of rules) {
    for (const expected of document.compiled.requirements) {
      const pkg = plan.packages.find(item => item.packageId === expected.packageId);
      for (const requirement of expected.requirements) if (!pkg?.requirements.some(item => orgHash(item) === orgHash(requirement))) issues.push({ code: "ORG_REQUIRED_REVIEW", path: `packages.${expected.packageId}.requirements`, message: "The plan omits or changes a required review from its current project-owned rule.", severity: "error" });
    }
    for (const expected of document.compiled.dependencies) if (!plan.dependencies.some(item => item.packageId === expected.packageId && item.prerequisiteId === expected.prerequisiteId && strength[item.kind] >= strength[expected.kind])) issues.push({ code: "ORG_REQUIRED_PREREQUISITE", path: "dependencies", message: "The plan omits or weakens a current project-owned prerequisite.", severity: "error" });
  }
  return issues;
}
export function mergeProjectRuleRequirements(packageId: string, original: EvidenceRequirement[], required: EvidenceRequirement[]): EvidenceRequirement[] {
  const merged = new Map([...defaultRequirements(packageId), ...original].map(item => [item.id, item]));
  for (const baseline of defaultRequirements(packageId)) merged.set(baseline.id, baseline);
  for (const item of required) merged.set(item.id, item);
  if (merged.size > 12) throw new DomainError("ORG_POLICY_INVALID", "The merged baseline and adopted reviews exceed twelve requirements for a target package. Use a narrower explicit policy.", 422);
  return [...merged.values()];
}
export async function enforceProjectPolicyPlan(tx: OrgTx, session: Session, payload: PlanPayload): Promise<ActiveProjectRule[]> {
  const rules = await activeProjectPolicies(tx, session), issues = projectPolicyPlanIssues(payload.plan, rules);
  for (const { document } of rules) if (document.rule.definition.kind === "evidence_policy") {
    const definition = document.rule.definition;
    const relevant = new Set([payload.plan.sourceDocumentId, ...payload.plan.packages.filter(pkg => document.compiled.packageIds.includes(pkg.packageId)).flatMap(pkg => pkg.quoteCitationIds).map(id => payload.plan.citations.find(citation => citation.id === id)?.documentId).filter((id): id is string => !!id)]);
    if (payload.sources.some(source => relevant.has(source.documentId) && !definition.allowedSourceProvenance.includes(source.provenance))) issues.push({ code: "ORG_SOURCE_PROVENANCE", path: "sources", message: "A mapped project source is outside the copied evidence policy's permitted source classes.", severity: "error" });
  }
  if (issues.length) throw new DomainError("ORG_PLAN_REVIEW_REQUIRED", "The current project-owned policy has unresolved plan requirements. Save a new compliant revision before approval or publication.", 409);
  return rules;
}
export async function bindProjectPolicyArtifacts(tx: OrgTx, rules: ActiveProjectRule[], consumer: OrgConsumerKind, artifactId: string, artifactHash: string,
  authority: Pick<Session, "actorId" | "id" | "role"> | null, state: "enforced" | "materialized" | "pending" | "not_applicable" = "enforced", limitations: string[] = []) {
  for (const { row, document } of rules) {
    if (!document.consumers.includes(consumer)) continue;
    const [known] = await query("SELECT id FROM fp_project_policy_artifacts WHERE adoption_id=$1 AND consumer=$2 AND artifact_id=$3 AND artifact_hash=$4", [row.id, consumer, artifactId, artifactHash], tx);
    if (known) continue;
    const id = randomUUID(), value = { schemaVersion: ORG_GOVERNANCE_VERSION, adoptionId: row.id, adoptionHead: row.adoption_head, ruleHash: row.rule_hash,
      tenantId: row.tenant_id, projectId: row.project_id, consumer, artifactId, artifactHash, state, authority, limitations };
    await tx.query("INSERT INTO fp_project_policy_artifacts(id,adoption_id,tenant_id,project_id,consumer,artifact_id,artifact_hash,state,adoption_head,encrypted_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [id, row.id, row.tenant_id, row.project_id, consumer, artifactId, artifactHash, state, row.adoption_head, sealPrivate({ ...value, bindingHash: orgHash(value) }, orgPrivateContext("policy-artifact", id))]);
  }
}

export interface ProjectFundDecision {
  consumer: "funding_policy" | "sponsor_offer" | "purpose_pledge" | "expense_review" | "payable_approval";
  packages: { packageId: string; expenseMinor?: number; feeMinor?: number; sponsorCapMinor?: number }[];
  fundingKind?: "reallocation" | "rollover" | "mixed";
  sponsorKind?: "grant" | "match";
  matchBasisPoints?: number;
  totalCapMinor?: number;
}
/** Only new decisions call this guard. Provider observation, original settlement
 * reconciliation and existing donor-owned financial contracts never do. */
export async function enforceProjectFundDecision(tx: OrgTx, session: Session, decision: ProjectFundDecision): Promise<ActiveProjectRule[]> {
  const all = await activeProjectPolicies(tx, session), rules = all.filter(rule => rule.document.rule.definition.kind === "fund_restriction" && decision.packages.some(pkg => rule.document.compiled.packageIds.includes(pkg.packageId)));
  let needPlan = false, acceptedIds: string[] = [];
  for (const rule of rules) {
    const definition = rule.document.rule.definition;
    if (definition.kind !== "fund_restriction") continue;
    const packages = decision.packages.filter(pkg => rule.document.compiled.packageIds.includes(pkg.packageId));
    const expense = packages.reduce((sum, pkg) => sum + (pkg.expenseMinor ?? 0), 0), fees = packages.reduce((sum, pkg) => sum + (pkg.feeMinor ?? 0), 0);
    const cap = Math.min(decision.totalCapMinor ?? Number.MAX_SAFE_INTEGER, packages.reduce((sum, pkg) => sum + (pkg.sponsorCapMinor ?? 0), 0));
    const denied = expense > 0 && !definition.allowedUses.includes("reviewed_expense") || fees > 0 && !definition.allowedUses.includes("provider_fee") ||
      definition.maximumExpenseMinor !== null && expense > definition.maximumExpenseMinor || definition.maximumFeeAllowanceMinor !== null && fees > definition.maximumFeeAllowanceMinor ||
      decision.sponsorKind === "grant" && !definition.allowGrants || decision.sponsorKind === "match" && !definition.allowMatches ||
      definition.maximumSponsorCapMinor !== null && cap > definition.maximumSponsorCapMinor ||
      decision.sponsorKind === "match" && definition.maximumMatchBasisPoints !== null && (decision.matchBasisPoints ?? 0) > definition.maximumMatchBasisPoints ||
      ["reallocation", "mixed"].includes(decision.fundingKind ?? "") && !definition.allowReallocation || ["rollover", "mixed"].includes(decision.fundingKind ?? "") && !definition.allowRollover;
    if (denied) throw new DomainError("ORG_POLICY_INVALID", "This new decision exceeds its current project-owned fund rule. Review that rule and the exact purpose before continuing.", 409);
    needPlan ||= definition.requireReviewedPlan;
    if (["expense_review", "payable_approval"].includes(decision.consumer) && definition.requireAcceptedWorkBeforeNewSpending && expense + fees > 0) acceptedIds.push(...packages.map(pkg => pkg.packageId));
  }
  if (needPlan || acceptedIds.length) {
    const publication = await publishedPlan(session, tx);
    if (!publication || publication.view.state !== "current" || projectPolicyPlanIssues(publication.payload.plan, all).length) throw new DomainError("ORG_PLAN_REVIEW_REQUIRED", "This project-owned fund rule requires a current reviewed plan that meets the copied project requirements.", 409);
    if (acceptedIds.length) {
      const { alignmentViews, signoffViews, packageReadiness } = await import("./planning-evidence");
      const readiness = packageReadiness(publication.payload, true, await alignmentViews(session, tx, true), await signoffViews(session, tx, true), []);
      if (acceptedIds.some(id => !readiness.find(pkg => pkg.packageId === id && pkg.accepted && pkg.prerequisitesMet))) throw new DomainError("ORG_PLAN_REVIEW_REQUIRED", "The copied fund rule requires current scoped acceptance of this work and its prerequisites before a new spending decision.", 409);
    }
  }
  return rules;
}
export async function enforceProjectEvidenceDecision(tx: OrgTx, session: Session, packageId: string, sources: { provenance: "sample_document" | "user_upload" }[], sharing?: "reviewers_only" | "project_members") {
  const rules = (await activeProjectPolicies(tx, session)).filter(rule => rule.document.rule.definition.kind === "evidence_policy" && rule.document.compiled.packageIds.includes(packageId));
  for (const rule of rules) {
    const definition = rule.document.rule.definition;
    if (definition.kind !== "evidence_policy") continue;
    if (sources.some(source => !definition.allowedSourceProvenance.includes(source.provenance)) || sharing === "project_members" && definition.maximumImageSharing === "reviewers_only")
      throw new DomainError("ORG_POLICY_INVALID", "This new evidence decision exceeds the copied project's source or image-sharing rule. Keep the original source private and review a compliant proposal.", 409);
  }
  return rules;
}
export async function pinnedProjectPolicyRules(tx: OrgTx, scope: Pick<Session, "tenantId" | "projectId">, consumer: OrgConsumerKind, artifactId: string): Promise<ActiveProjectRule[]> {
  const rows = await query<ProjectPolicyRow>(`SELECT a.* FROM fp_project_policy_adoptions a JOIN fp_project_policy_artifacts b ON b.adoption_id=a.id
    WHERE a.tenant_id=$1 AND a.project_id=$2 AND b.tenant_id=$1 AND b.project_id=$2 AND b.consumer=$3 AND b.artifact_id=$4 AND b.state='enforced' ORDER BY a.id`, [scope.tenantId, scope.projectId, consumer, artifactId], tx);
  return rows.map(row => ({ row, document: projectPolicyDocument(row) }));
}
const ruleIdentities = (rules: ActiveProjectRule[]) => rules.map(rule => ({ id: rule.row.id, head: rule.row.adoption_head, hash: rule.row.rule_hash })).sort((a, b) => a.id.localeCompare(b.id));
export async function recordProjectPolicyReview(tx: OrgTx, session: Session, artifactId: string, artifactHash: string, rules: ActiveProjectRule[]) {
  const id = randomUUID(), bindings = ruleIdentities(rules), value = { tenantId: session.tenantId, projectId: session.projectId, artifactId, artifactHash, bindings };
  await tx.query("INSERT INTO fp_project_policy_subjects(id,tenant_id,project_id,consumer,artifact_id,artifact_hash,bindings_hash,encrypted_data) VALUES($1,$2,$3,'payable_approval',$4,$5,$6,$7)",
    [id, session.tenantId, session.projectId, artifactId, artifactHash, orgHash(bindings), sealPrivate(value, orgPrivateContext("policy-subject", id))]);
  await bindProjectPolicyArtifacts(tx, rules, "payable_approval", `review:${artifactId}`, artifactHash, session);
}
export async function assertProjectPolicyReview(tx: OrgTx, session: Session, artifactId: string, artifactHash: string, rules: ActiveProjectRule[]) {
  const [row] = await query<{ id: string; artifact_hash: string; bindings_hash: string; encrypted_data: string }>("SELECT * FROM fp_project_policy_subjects WHERE tenant_id=$1 AND project_id=$2 AND consumer='payable_approval' AND artifact_id=$3", [session.tenantId, session.projectId, artifactId], tx);
  // An original pre-governance review remains usable if no new rule now applies.
  // An original payable renewal follows its already committed contract instead.
  if (!row && !rules.length) return;
  if (!row || row.artifact_hash !== artifactHash || row.bindings_hash !== orgHash(ruleIdentities(rules))) throw new DomainError("ORG_POLICY_REVIEW_REQUIRED", "The prospective project fund rule changed after this payment review. Prepare a fresh review; existing approved payments retain their original contract.", 409);
  const value = openPrivate<{ tenantId: string; projectId: string; artifactId: string; artifactHash: string; bindings: unknown }>(row.encrypted_data, orgPrivateContext("policy-subject", row.id));
  if (value.tenantId !== session.tenantId || value.projectId !== session.projectId || value.artifactId !== artifactId || value.artifactHash !== artifactHash || orgHash(value.bindings) !== row.bindings_hash) throw new DomainError("ORG_POLICY_REVIEW_REQUIRED", "The original policy review binding could not be verified.", 409);
}
