import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ORG_PAGE_SIZE, orgPolicyDefinitionSchema, orgPolicyDetailSchema, orgPolicyPublishReviewInputSchema, orgPolicyPublishReviewSchema,
  orgPolicyPublishSchema, orgPolicyRetireSchema, orgPolicySaveSchema, orgPolicySummarySchema, orgPublishedPolicySchema,
  type OrgConsumerKind, type OrgPolicyDefinition, type OrgPolicyDetail, type OrgPolicyPublishReview, type OrgPolicySummary, type OrgPublishedPolicy,
} from "../organizations/contracts";
import { DomainError } from "../domain/money";
import { query } from "./db";
import { openPrivate, sealPrivate } from "./private-values";
import {
  assertOrganizationCurrent, orgCapabilities, orgCursor, orgHash, orgPage, orgPrivateContext,
  organizationAudit, organizationCommand, organizationTransaction, requireOrganization,
  type OrgIdentity, type OrgTx, type OrganizationRequest,
} from "./organization-core";

export interface OrgPolicyRow {
  id: string; organization_id: string; head_version: number; kind: OrgPolicyDefinition["kind"]; title: string;
  template_ids: string[]; draft_hash: string; encrypted_draft: string; latest_revision: number; latest_version_id: string | null;
  created_at: Date; updated_at: Date;
}
export interface OrgPolicyVersionRow {
  id: string; policy_id: string; organization_id: string; revision: number; content_hash: string; encrypted_definition: string;
  publisher_membership_id: string; publisher_membership_version: number; publisher_session_id: string; publisher_role: "owner" | "coordinator";
  state: "active" | "retired"; state_version: number; published_at: Date; retired_at: Date | null;
}
export const retainedProjectHistory = [
  "Existing project funding choices, buyer approvals, receipts, returns, repayment requests and provider operation identities keep their original exact contracts.",
  "Existing plan, source, image and physical-review history remains recorded. New requirements require a new target-project plan and fresh applicable reviews.",
  "Retiring an organization policy or withdrawing aggregate disclosure does not remove a separately adopted project-owned rule.",
];
export function policyConsumers(kind: OrgPolicyDefinition["kind"]): OrgConsumerKind[] {
  if (kind === "fund_restriction") return ["funding_policy", "sponsor_offer", "purpose_pledge", "expense_review", "payable_approval"];
  if (kind === "evidence_policy") return ["planning_draft", "plan_review", "plan_publication", "image_review", "physical_signoff"];
  return ["planning_draft", "canonical_empty_packages", "plan_review", "plan_publication"];
}
export function publishedOrganizationDefinition(row: OrgPolicyVersionRow): OrgPolicyDefinition {
  const definition = orgPolicyDefinitionSchema.parse(openPrivate(row.encrypted_definition, orgPrivateContext("policy-version", row.id)));
  if (orgHash(definition) !== row.content_hash) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This original policy version could not be verified. Its history is retained.", 409);
  return definition;
}
function draftDefinition(row: OrgPolicyRow) {
  const definition = orgPolicyDefinitionSchema.parse(openPrivate(row.encrypted_draft, orgPrivateContext("policy-draft", row.id)));
  if (orgHash(definition) !== row.draft_hash || definition.kind !== row.kind) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This saved policy draft could not be verified.", 409);
  return definition;
}
export async function organizationPolicyById(tx: OrgTx, organizationId: string, id: string, lock = false) {
  const [row] = await query<OrgPolicyRow>(`SELECT * FROM fp_org_policies WHERE organization_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`, [organizationId, id], tx);
  if (!row) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This policy is unavailable in the current organization.", 404);
  return row;
}
export async function organizationPolicyVersionById(tx: OrgTx, organizationId: string, id: string, lock = false) {
  const [row] = await query<OrgPolicyVersionRow>(`SELECT * FROM fp_org_policy_versions WHERE organization_id=$1 AND id=$2${lock ? " FOR SHARE" : ""}`, [organizationId, id], tx);
  if (!row) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This published version is unavailable in the current organization.", 404);
  return row;
}
export function publishedOrganizationPolicy(row: OrgPolicyVersionRow, canWrite: boolean): OrgPublishedPolicy {
  return orgPublishedPolicySchema.parse({ id: row.id, revision: row.revision, contentHash: row.content_hash, state: row.state,
    stateVersion: row.state_version, publishedAt: row.published_at.toISOString(), retiredAt: row.retired_at?.toISOString() ?? null,
    publisherRole: row.publisher_role, definition: publishedOrganizationDefinition(row), canRetire: canWrite && row.state === "active" });
}
async function policySummary(tx: OrgTx, identity: OrgIdentity, row: OrgPolicyRow): Promise<OrgPolicySummary> {
  const canWrite = orgCapabilities(identity.member.role).canWritePolicies;
  const latest = row.latest_version_id ? await organizationPolicyVersionById(tx, identity.organization.id, row.latest_version_id) : null;
  if (!canWrite && !latest) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This unpublished policy is unavailable for the current organization role.", 404);
  const definition = canWrite ? draftDefinition(row) : publishedOrganizationDefinition(latest!);
  const [{ count }] = await query<{ count: string }>("SELECT count(*) FROM fp_org_policy_versions WHERE organization_id=$1 AND policy_id=$2 AND state='active'", [identity.organization.id, row.id], tx);
  return orgPolicySummarySchema.parse({ id: row.id, headVersion: row.head_version, title: definition.title, kind: definition.kind, templateIds: definition.templateIds,
    hasDraft: canWrite && (!latest || row.draft_hash !== latest.content_hash), latestRevision: row.latest_revision, latestHash: latest?.content_hash ?? null,
    publishedAt: latest?.published_at.toISOString() ?? null, activeVersionCount: Number(count), canEdit: canWrite });
}
export async function organizationPoliciesPage(tx: OrgTx, identity: OrgIdentity, before?: string) {
  const writer = orgCapabilities(identity.member.role).canReadPolicyDrafts, owner = `${identity.organization.id}:${identity.member.role}:policies`, cursor = orgCursor(before, owner);
  const rows = await query<OrgPolicyRow>("SELECT * FROM fp_org_policies WHERE organization_id=$1 AND ($2::boolean OR latest_revision>0) AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::text)) ORDER BY created_at DESC,id DESC LIMIT $5", [identity.organization.id, writer, cursor?.at ?? null, cursor?.id ?? null, ORG_PAGE_SIZE + 1], tx);
  const page = orgPage(rows, owner), policies: OrgPolicySummary[] = [];
  for (const row of page.rows) policies.push(await policySummary(tx, identity, row));
  return { policies, nextCursor: page.nextCursor };
}
export async function organizationPolicyDetail(request: OrganizationRequest, id: string, before?: string, versionId?: string): Promise<{ policy: OrgPolicyDetail }> {
  if (versionId) z.uuid().parse(versionId);
  return organizationTransaction(async tx => {
    const identity = await requireOrganization(tx, request, request.organizationScope), row = await organizationPolicyById(tx, identity.organization.id, id);
    const summary = await policySummary(tx, identity, row), writer = orgCapabilities(identity.member.role).canWritePolicies;
    const owner = `${identity.organization.id}:${id}:versions`, cursor = orgCursor(before, owner);
    const rows = await query<OrgPolicyVersionRow>("SELECT * FROM fp_org_policy_versions WHERE organization_id=$1 AND policy_id=$2 AND ($3::timestamptz IS NULL OR (published_at,id)<($3::timestamptz,$4::text)) ORDER BY published_at DESC,id DESC LIMIT $5", [identity.organization.id, id, cursor?.at ?? null, cursor?.id ?? null, ORG_PAGE_SIZE + 1], tx);
    const page = orgPage(rows.map(item => ({ ...item, created_at: item.published_at })), owner), selectedId = versionId ?? row.latest_version_id;
    const selected = selectedId ? await organizationPolicyVersionById(tx, identity.organization.id, selectedId) : null;
    if (selected && selected.policy_id !== id) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This version is outside the selected policy.", 404);
    const policy = orgPolicyDetailSchema.parse({ scope: identity.scope, summary,
      draft: writer ? { headVersion: row.head_version, contentHash: row.draft_hash, definition: draftDefinition(row), updatedAt: row.updated_at.toISOString() } : null,
      selectedVersion: selected ? publishedOrganizationPolicy(selected, writer) : null,
      versions: page.rows.map(item => { const { definition: _privateDefinition, ...version } = publishedOrganizationPolicy(item, writer); return version; }), nextCursor: page.nextCursor });
    await assertOrganizationCurrent(tx, request, identity);
    return { policy };
  }, true);
}

export async function saveOrganizationPolicy(request: OrganizationRequest, raw: unknown) {
  const input = orgPolicySaveSchema.parse(raw);
  return { receipt: await organizationCommand(request, input, "save_policy", ["owner", "coordinator"], async (tx, identity) => {
    const id = input.policyId ?? randomUUID(), definition = input.definition, hash = orgHash(definition);
    if (input.policyId) {
      const current = await organizationPolicyById(tx, identity.organization.id, id, true);
      if (current.head_version !== input.expectedHead || current.kind !== definition.kind) throw new DomainError("ORG_POLICY_VERSION_CHANGED", "The policy draft changed or uses another rule type. Review its current head before saving.", 409);
      await tx.query("UPDATE fp_org_policies SET head_version=head_version+1,title=$2,template_ids=$3::jsonb,draft_hash=$4,encrypted_draft=$5,updated_at=clock_timestamp() WHERE id=$1", [id, definition.title, JSON.stringify(definition.templateIds), hash, sealPrivate(definition, orgPrivateContext("policy-draft", id))]);
    } else {
      if (input.expectedHead !== 0) throw new DomainError("ORG_POLICY_VERSION_CHANGED", "A new reusable policy starts with an empty draft head.", 409);
      await tx.query("INSERT INTO fp_org_policies(id,organization_id,kind,title,template_ids,draft_hash,encrypted_draft) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)", [id, identity.organization.id, definition.kind, definition.title, JSON.stringify(definition.templateIds), hash, sealPrivate(definition, orgPrivateContext("policy-draft", id))]);
    }
    await organizationAudit(tx, identity.organization.id, "organization.policy_draft_saved", identity, { title: "A reusable policy draft was saved", detail: "Saving a typed draft does not publish it, adopt it into a project, or change existing decisions.", policyId: id });
    return { resourceId: id, resourceVersion: input.expectedHead + 1, message: "The editable policy draft was saved. Review its exact definition before publishing." };
  }) };
}
function publishReview(identity: OrgIdentity, row: OrgPolicyRow, input: z.infer<typeof orgPolicyPublishReviewInputSchema>): OrgPolicyPublishReview {
  if (row.head_version !== input.expectedHead || row.draft_hash !== input.definitionHash) throw new DomainError("ORG_POLICY_VERSION_CHANGED", "The saved draft changed. Review the current exact version.", 409);
  const definition = draftDefinition(row), value = { policyId: row.id, expectedHead: row.head_version, definitionHash: row.draft_hash, definition,
    issues: [], effectiveConsumers: policyConsumers(definition.kind), preservedHistory: retainedProjectHistory, canPublish: true };
  return orgPolicyPublishReviewSchema.parse({ ...value, reviewHash: orgHash({ scope: identity.scope, ...value }) });
}
export async function reviewOrganizationPolicyPublication(request: OrganizationRequest, id: string, raw: unknown) {
  const input = orgPolicyPublishReviewInputSchema.parse(raw);
  if (input.policyId !== id) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "Review the exact selected policy.", 404);
  return organizationTransaction(async tx => {
    const identity = await requireOrganization(tx, request, input.expectedScope, ["owner", "coordinator"]), row = await organizationPolicyById(tx, identity.organization.id, id);
    const review = publishReview(identity, row, input);
    await assertOrganizationCurrent(tx, request, identity);
    return { review };
  });
}
export async function publishOrganizationPolicy(request: OrganizationRequest, id: string, raw: unknown) {
  const input = orgPolicyPublishSchema.parse(raw);
  if (input.policyId !== id) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "Publish the exact selected policy.", 404);
  return { receipt: await organizationCommand(request, input, "publish_policy", ["owner", "coordinator"], async (tx, identity) => {
    const row = await organizationPolicyById(tx, identity.organization.id, id, true), review = publishReview(identity, row, input);
    if (review.reviewHash !== input.reviewHash) throw new DomainError("ORG_POLICY_REVIEW_REQUIRED", "Review this original exact draft before publishing it.", 409);
    const latest = row.latest_version_id ? await organizationPolicyVersionById(tx, identity.organization.id, row.latest_version_id) : null;
    if (latest?.content_hash === row.draft_hash) throw new DomainError("ORG_POLICY_VERSION_CHANGED", "This exact definition already has an immutable published version. Save a deliberate changed draft before publishing another.", 409);
    const versionId = randomUUID(), revision = row.latest_revision + 1;
    await tx.query(`INSERT INTO fp_org_policy_versions(id,policy_id,organization_id,revision,content_hash,encrypted_definition,publisher_membership_id,publisher_membership_version,publisher_session_id,publisher_role)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [versionId, id, identity.organization.id, revision, row.draft_hash, sealPrivate(review.definition, orgPrivateContext("policy-version", versionId)), identity.member.id, identity.member.version, identity.session.id, identity.member.role]);
    await tx.query("UPDATE fp_org_policies SET latest_revision=$2,latest_version_id=$3,head_version=head_version+1,updated_at=clock_timestamp() WHERE id=$1", [id, revision, versionId]);
    await organizationAudit(tx, identity.organization.id, "organization.policy_published", identity,
      { title: "An immutable reusable policy version was published", detail: "Each project must separately review its own target changes and prospective consumers. Publication does not apply it automatically.", policyId: id, versionId, revision, contentHash: row.draft_hash });
    return { resourceId: versionId, resourceVersion: revision, message: "The exact policy version is published and ready for separate project review." };
  }) };
}
export async function retireOrganizationPolicy(request: OrganizationRequest, id: string, raw: unknown) {
  const input = orgPolicyRetireSchema.parse(raw);
  return { receipt: await organizationCommand(request, input, "retire_policy", ["owner", "coordinator"], async (tx, identity) => {
    const version = await organizationPolicyVersionById(tx, identity.organization.id, input.versionId, true);
    if (version.policy_id !== id) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This version is outside the selected policy.", 404);
    if (version.state !== "active" || version.state_version !== input.expectedStateVersion) throw new DomainError("ORG_POLICY_VERSION_CHANGED", "This policy version changed. Review its current publication state.", 409);
    await tx.query("UPDATE fp_org_policy_versions SET state='retired',state_version=state_version+1,retired_at=clock_timestamp() WHERE id=$1", [version.id]);
    await organizationAudit(tx, identity.organization.id, "organization.policy_retired", identity, { title: "A reusable policy version was retired", detail: input.reason, versionId: version.id, retainedProjectRules: true });
    return { resourceId: version.id, resourceVersion: version.state_version + 1, message: "New adoption of this version ended. Existing project-owned copies and exact original decisions remain unchanged." };
  }, { policyId: id }) };
}
