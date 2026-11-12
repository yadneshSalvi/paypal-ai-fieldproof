import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as C from "../../lib/organizations/contracts";
import { orgToken, organizationTransaction, type OrganizationRequest } from "../../lib/server/organization-core";
import { createOrganization, organizationBootstrap, acceptOrganizationInvitation, reviewOrganizationEntry } from "../../lib/server/organization-entry";
import { createOrganizationInvitation } from "../../lib/server/organization-members";
import { commitOrganizationProjectLink, organizationProjectContext, reviewOrganizationProjectLink } from "../../lib/server/organization-projects";
import { organizationPolicyDetail, publishOrganizationPolicy, reviewOrganizationPolicyPublication, saveOrganizationPolicy } from "../../lib/server/organization-policies";
import { adoptOrganizationPolicy, reviewOrganizationAdoption } from "../../lib/server/organization-adoptions";
import { query } from "../../lib/server/db";
import { organizationAggregateFixture } from "./organization-aggregate";

export const organizationBrowser = (): OrganizationRequest => ({ organizationToken: null, libraryToken: null, projectToken: null, browserKey: orgToken() });
export function organizationCookies(request: OrganizationRequest, result: { cookies?: { kind: string; token: string | null }[] }) {
  for (const cookie of result.cookies ?? []) if (cookie.kind === "session") request.organizationToken = cookie.token; else if (cookie.kind === "library") request.libraryToken = cookie.token;
}
export async function organizationScopes(request: OrganizationRequest) {
  const context = await organizationBootstrap(request), project = await organizationTransaction(tx => organizationProjectContext(tx, request));
  request.organizationScope = context.context.scope; request.projectScope = project.scope;
  return { context, project };
}
export async function organizationOwner(projectToken: string | null = null) {
  const request = organizationBrowser(); request.projectToken = projectToken;
  const before = await organizationBootstrap(request);
  const created = await createOrganization(request, { intentId: randomUUID(), expectedScope: before.context.scope, expectedLibraryScope: before.library.scope,
    organizationName: "Controlled Sample network", description: "Fictional integration test; no independent person or legal organization is asserted.", displayName: "Controlled Sample owner", expiresHours: 12, contractVersion: C.ORG_GOVERNANCE_VERSION, acknowledged: true });
  organizationCookies(request, created); await organizationScopes(request);
  return { request, created };
}
export async function organizationJoin(request: OrganizationRequest, role: C.OrgRole) {
  const invitation = await createOrganizationInvitation(request, { intentId: randomUUID(), expectedScope: request.organizationScope, role, label: `Controlled ${role} entry`, expiresHours: 6, acknowledged: true });
  const recipient = organizationBrowser(), token = invitation.invitation.path.split("#invite=")[1], { entry } = await reviewOrganizationEntry(recipient, { kind: "invite", token });
  const joined = await acceptOrganizationInvitation(recipient, { intentId: randomUUID(), expectedScope: entry.scope, token, displayName: `Controlled independent ${role}`, contractVersion: C.ORG_GOVERNANCE_VERSION, acknowledged: true });
  organizationCookies(recipient, joined); await organizationScopes(recipient);
  return { request: recipient, invitation, joined };
}
export async function organizationLink(request: OrganizationRequest, disclosure: C.OrgDisclosureSection[] = ["budget", "funding", "expenses", "evidence"]) {
  const { project } = await organizationScopes(request);
  const input = { expectedScope: request.organizationScope!, expectedProjectScope: project.scope, expectedProjectBasis: project.basis!, existingLinkId: null, expectedLinkVersion: 0,
    proposal: { disclosure, expiresAt: new Date(Math.min(Date.now() + 30 * 60_000, Date.parse(project.expiresAt!))).toISOString() } };
  const { review } = await reviewOrganizationProjectLink(request, input); assert.equal(review.canCommit, true);
  const { receipt } = await commitOrganizationProjectLink(request, { ...input, intentId: randomUUID(), reviewHash: review.reviewHash, acknowledged: true });
  return receipt.resourceId!;
}
export async function organizationWorkflow() {
  const project = await organizationAggregateFixture(), owner = await organizationOwner(project.token), linkId = await organizationLink(owner.request);
  return { ...owner, project, linkId };
}
export function fundDefinition(overrides: Partial<Extract<C.OrgPolicyDefinition, { kind: "fund_restriction" }>> = {}): C.OrgPolicyDefinition {
  return C.orgPolicyDefinitionSchema.parse({ kind: "fund_restriction", title: "Controlled future spending rule", description: "A prospective controlled policy; original promises remain unchanged.", templateIds: ["makerspace", "community-garden", "mutual-aid"],
    packageKeys: ["shared-purpose"], allowedUses: ["reviewed_expense", "provider_fee"], maximumExpenseMinor: null, maximumFeeAllowanceMinor: null, maximumSponsorCapMinor: null,
    maximumMatchBasisPoints: null, allowGrants: true, allowMatches: true, allowReallocation: true, allowRollover: true, requireReviewedPlan: false, requireAcceptedWorkBeforeNewSpending: false, ...overrides });
}
export async function organizationPublished(request: OrganizationRequest, definition: C.OrgPolicyDefinition) {
  const saved = await saveOrganizationPolicy(request, { intentId: randomUUID(), expectedScope: request.organizationScope, policyId: null, expectedHead: 0, definition });
  const policyId = saved.receipt.resourceId!, detail = await organizationPolicyDetail(request, policyId), draft = detail.policy.draft!;
  const input = { expectedScope: request.organizationScope!, policyId, expectedHead: draft.headVersion, definitionHash: draft.contentHash };
  const { review } = await reviewOrganizationPolicyPublication(request, policyId, input);
  await publishOrganizationPolicy(request, policyId, { ...input, intentId: randomUUID(), reviewHash: review.reviewHash, acknowledged: true });
  return { policyId, version: (await organizationPolicyDetail(request, policyId)).policy.selectedVersion! };
}
export async function organizationAdoptionSelection(request: OrganizationRequest, linkId: string, policy: Awaited<ReturnType<typeof organizationPublished>>, options: Partial<C.OrgAdoptionSelection> = {}) {
  const { project } = await organizationScopes(request), [link] = await query<{ version: number }>("SELECT version FROM fp_org_project_links WHERE id=$1", [linkId]);
  return C.orgAdoptionSelectionSchema.parse({ expectedScope: request.organizationScope, expectedProjectScope: project.scope, expectedProjectBasis: project.basis, linkId,
    expectedLinkVersion: link.version, policyVersionId: policy.version.id, policyHash: policy.version.contentHash, expectedPolicyStateVersion: policy.version.stateVersion,
    mappings: [{ policyPackageKey: "shared-purpose", targetPackageIds: ["materials"] }], planSource: { strategy: "none", sketchDocumentId: null, page: null },
    reviseCanonicalEmptyPackages: false, reviewedQuotes: [], ...options });
}
export async function organizationAdopt(request: OrganizationRequest, linkId: string, policy: Awaited<ReturnType<typeof organizationPublished>>, options: Partial<C.OrgAdoptionSelection> = {}) {
  const selection = await organizationAdoptionSelection(request, linkId, policy, options), { review } = await reviewOrganizationAdoption(request, linkId, selection);
  assert.equal(review.canApply, true, review.blockers.join(" "));
  const input = { intentId: randomUUID(), expectedScope: request.organizationScope!, expectedProjectScope: request.projectScope!, selection, reviewHash: review.reviewHash, preservedHistoryAcknowledged: true as const, acknowledged: true as const };
  return { result: await adoptOrganizationPolicy(request, linkId, input), input, review };
}
