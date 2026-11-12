import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "@fracture/paypal-core";
import { describe, it } from "node:test";
import { ORG_GOVERNANCE_VERSION, orgPolicyDefinitionSchema } from "../lib/organizations/contracts";
import type { Session } from "../lib/server/auth";
import type { QualificationView } from "../lib/planning/contracts";
import { loadOrganizationProjectAggregate, collectOrganizationProjectAggregateDependencies } from "../lib/server/organization-project-aggregate";
import { database, query } from "../lib/server/db";
import { recordWorkSignoff, reviewReviewerQualification } from "../lib/server/planning-evidence";
import { setPlanningSourcePermission } from "../lib/server/planning-sources";
import { readPlanningWorkspace, revokePublishedPlan } from "../lib/server/planning";
import { publishedPlan } from "../lib/server/planning-store";
import { sealPrivate } from "../lib/server/private-values";
import { createOrganization, organizationBootstrap } from "../lib/server/organization-entry";
import { organizationTransaction, orgToken, type OrganizationRequest } from "../lib/server/organization-core";
import { commitOrganizationProjectLink, organizationProjectContext, reviewOrganizationProjectLink } from "../lib/server/organization-projects";
import { organizationTestDatabase } from "./helpers/organization-database";
import { organizationAggregateFixture, organizationAggregateInput, organizationAggregateRead } from "./helpers/organization-aggregate";
import { alignedFixture, publishFixture, qualificationFixture, type PlanningFixture } from "./helpers/planning";
import { storyPlanning, type StoryFixture } from "./helpers/supporter-story";

organizationTestDatabase();
async function fixture() {
  const story = await organizationAggregateFixture(), planning = await storyPlanning(story), publication = await publishFixture(planning);
  return { story, planning, publication };
}
async function signoff(f: PlanningFixture, actor: Session, qualification: QualificationView, packageId = "printing", decision: "accepted" | "needs_information" | "rejected" = "accepted") {
  const publication = (await publishedPlan(f.session))!, requirement = publication.payload.plan.packages.find(pkg => pkg.packageId === packageId)!.requirements.find(row => row.scope === qualification.scope)!;
  return recordWorkSignoff(actor, { intentId: randomUUID(), planId: publication.row.id, expectedPlanHash: publication.row.content_hash, packageId, requirementId: requirement.id, qualificationId: qualification.id, qualificationVersion: qualification.version, documentIds: [qualification.documentId!], decision, statement: "Controlled synthetic project-scope exercise only; no real inspection or person is asserted.", limitations: "Fictional evidence exercises exact source, qualification, plan and membership validation.", observedAt: new Date().toISOString(), scopeConfirmed: true, sampleAcknowledged: true });
}
async function linked(story: StoryFixture & { token: string; expiresAt: string }) {
  const request: OrganizationRequest = { organizationToken: null, libraryToken: null, browserKey: orgToken(), projectToken: story.token }, initial = await organizationBootstrap(request);
  const result = await createOrganization(request, { intentId: randomUUID(), expectedScope: initial.context.scope, expectedLibraryScope: initial.library.scope, organizationName: "Controlled projection organization", description: "Fictional isolated projection test only.", displayName: "Controlled creation-capability owner", expiresHours: 12, contractVersion: ORG_GOVERNANCE_VERSION, acknowledged: true });
  for (const cookie of result.cookies ?? []) if (cookie.kind === "session") request.organizationToken = cookie.token; else if (cookie.kind === "library") request.libraryToken = cookie.token;
  const context = await organizationBootstrap(request), project = await organizationTransaction(tx => organizationProjectContext(tx, request));
  const input = { expectedScope: context.context.scope, expectedProjectScope: project.scope, expectedProjectBasis: project.basis!, existingLinkId: null, expectedLinkVersion: 0, proposal: { disclosure: ["budget", "funding", "expenses", "evidence"], expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() } };
  const { review } = await reviewOrganizationProjectLink(request, input); assert.equal(review.canCommit, true);
  const { receipt } = await commitOrganizationProjectLink(request, { ...input, intentId: randomUUID(), reviewHash: review.reviewHash, acknowledged: true });
  const [consent] = await query<{ content_hash: string; expires_at: Date; revision: number; link_version: number }>("SELECT c.content_hash,c.expires_at,c.revision,l.version link_version FROM fp_org_project_consents c JOIN fp_org_project_links l ON l.id=c.link_id AND l.current_consent_id=c.id WHERE c.link_id=$1 AND c.tenant_id=$2 AND c.project_id=$3", [receipt.resourceId, story.tenantId, story.projectId]);
  return { request, profile: result.body.welcome.profile, input: organizationAggregateInput(story, { linkId: receipt.resourceId!, linkVersion: consent.link_version, consentRevision: consent.revision, consentHash: consent.content_hash, consentExpiresAt: consent.expires_at.toISOString() }) };
}

describe("organization evidence projection uses current independently qualified project facts", () => {
  it("counts one reviewed illustrative-image requirement without inventing physical acceptance, exposing a rendition or upgrading an old package state", async () => {
    const f = await fixture(), image = await alignedFixture(f.planning, "printing"); await image.review();
    await query("UPDATE fp_packages SET data=jsonb_set(jsonb_set(data,'{evidenceAccepted}','99'::jsonb),'{workState}','\"accepted\"'::jsonb) WHERE project_id=$1 AND id='printing'", [f.story.projectId]);
    const input = organizationAggregateInput(f.story), aggregate = await organizationAggregateRead(input, loadOrganizationProjectAggregate), evidence = aggregate.evidence[0].values;
    assert.equal(evidence.acceptedReviewItems, 1); assert.equal(evidence.requiredReviewItems, 14); assert.equal(evidence.acceptedPackages, 0); assert.equal(evidence.currentScopedSignoffs, 0); assert.equal(evidence.reviewedIllustrations, 1); assert.match(evidence.limitations.join(" "), /not physical acceptance/);
    assert.equal(aggregate.lineage!.planHash, f.publication.row.content_hash); assert.equal(evidence.planRevision, f.publication.row.revision);
    const dependencies = await organizationAggregateRead(input, collectOrganizationProjectAggregateDependencies); assert.equal(dependencies.planning!.publication!.publicationId, f.publication.view.publicationId); assert.ok(dependencies.planning!.documents.some(row => row.documentId === f.planning.photo.id)); assert.deepEqual(dependencies.planning!.qualifications, []);
    assert.deepEqual(dependencies.planning!.alignments, [{ id: image.id, contentHash: image.contentHash }]); assert.deepEqual(dependencies.planning!.signoffs, []);
    for (const id of [f.planning.photo.id, f.planning.sketch.id, f.planning.quote.id, image.id, f.publication.row.id, f.publication.view.publicationId]) assert.equal(JSON.stringify(aggregate).includes(id), false);
  });
  it("uses exact current scoped competence and source bindings, and never revives an earlier accepted decision after a later negative review", async () => {
    const f = await fixture(), image = await alignedFixture(f.planning, "printing"); await image.review();
    const qualification = await qualificationFixture(f.planning, f.planning.session, "equipment_setup", true), first = await signoff(f.planning, f.planning.session, qualification), input = organizationAggregateInput(f.story);
    const accepted = await organizationAggregateRead(input, loadOrganizationProjectAggregate); assert.equal(accepted.evidence[0].values.acceptedReviewItems, 2); assert.equal(accepted.evidence[0].values.acceptedPackages, 1); assert.equal(accepted.evidence[0].values.currentScopedSignoffs, 1);
    const bound = await organizationAggregateRead(input, collectOrganizationProjectAggregateDependencies); assert.equal(bound.planning!.qualifications[0].id, qualification.id); assert.equal(bound.planning!.validThrough, qualification.validUntil);
    const [stored] = await query<{ content_hash: string }>("SELECT content_hash FROM fp_work_signoffs WHERE id=$1 AND tenant_id=$2 AND project_id=$3", [first.id, f.story.tenantId, f.story.projectId]);
    assert.deepEqual(bound.planning!.signoffs, [{ id: first.id, contentHash: stored.content_hash, qualificationId: qualification.id, qualificationVersion: qualification.version }]);
    await signoff(f.planning, f.planning.session, qualification, "printing", "needs_information");
    const later = await organizationAggregateRead(input, loadOrganizationProjectAggregate); assert.equal(later.evidence[0].values.acceptedReviewItems, 1); assert.equal(later.evidence[0].values.acceptedPackages, 0); assert.equal(later.evidence[0].values.currentScopedSignoffs, 0); assert.notEqual(later.lineage!.aggregateHash, accepted.lineage!.aggregateHash);
    const [old] = await query<{ decision: string }>("SELECT decision FROM fp_work_signoffs WHERE id=$1", [first.id]); assert.equal(old.decision, "accepted", "Original physical-review history remains untouched");
    assert.deepEqual((await organizationAggregateRead(input, collectOrganizationProjectAggregateDependencies)).planning!.signoffs, [], "A later negative decision leaves no positively counted signoff dependency");
  });
  it("removes a revoked competence from current coverage and retains only the independent reviewed image", async () => {
    const f = await fixture(), image = await alignedFixture(f.planning, "printing"); await image.review();
    const qualification = await qualificationFixture(f.planning, f.planning.session, "equipment_setup", true); await signoff(f.planning, f.planning.session, qualification);
    await reviewReviewerQualification(f.planning.session, qualification.id, { intentId: randomUUID(), expectedVersion: qualification.version, decision: "revoked", note: "Controlled synthetic qualification withdrawal", evidenceChecked: true, sampleAcknowledged: true });
    const aggregate = await organizationAggregateRead(organizationAggregateInput(f.story), loadOrganizationProjectAggregate); assert.equal(aggregate.evidence[0].values.currentScopedSignoffs, 0); assert.equal(aggregate.evidence[0].values.acceptedReviewItems, 1); assert.equal(aggregate.evidence[0].values.acceptedPackages, 0);
  });
  it("invalidates competence on its fixed expiry or changed issuer membership while preserving immutable plan/review history", async () => {
    for (const reason of ["expiry", "issuer"] as const) {
      const f = await fixture(), qualification = await qualificationFixture(f.planning, f.story.volunteer, "equipment_setup", true); await signoff(f.planning, f.story.volunteer, qualification);
      if (reason === "expiry") await query("UPDATE fp_reviewer_qualifications SET valid_until=now()-interval '1 second' WHERE id=$1", [qualification.id]);
      else await query("UPDATE fp_memberships SET version=version+1 WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [f.story.tenantId, f.story.projectId, f.story.organizer.actorId]);
      const aggregate = await organizationAggregateRead(organizationAggregateInput(f.story), loadOrganizationProjectAggregate); assert.equal(aggregate.evidence[0].values.currentScopedSignoffs, 0); assert.equal(aggregate.evidence[0].values.acceptedReviewItems, 0); assert.equal(aggregate.evidence[0].values.planRevision, f.publication.row.revision);
      const [history] = await query<{ count: string }>("SELECT count(*) count FROM fp_work_signoffs WHERE tenant_id=$1 AND project_id=$2", [f.story.tenantId, f.story.projectId]); assert.equal(Number(history.count), 1);
    }
  });
  it("omits withdrawn planning sources as unavailable instead of zero current evidence and never discloses their identifiers", async () => {
    const f = await fixture(); await setPlanningSourcePermission(f.planning.session, f.planning.sketch.id, { intentId: randomUUID(), expectedVersion: 1, permission: "withdrawn", reason: "Controlled aggregate source withdrawal" });
    const aggregate = await organizationAggregateRead(organizationAggregateInput(f.story), loadOrganizationProjectAggregate); assert.equal(aggregate.state, "partial"); assert.deepEqual(aggregate.evidence, []); assert.equal(aggregate.lineage!.planRevision, null); assert.equal(aggregate.lineage!.planHash, null); assert.ok(aggregate.money[0].funding); assert.ok(aggregate.reasons.length);
    assert.equal(JSON.stringify(aggregate).includes(f.planning.sketch.id), false);
  });
  it("does not revive withdrawn illustrative bindings after permission returns or copy old acceptance into a new publication", async () => {
    const f = await fixture(), image = await alignedFixture(f.planning, "printing"); await image.review(); const input = organizationAggregateInput(f.story);
    assert.equal((await organizationAggregateRead(input, loadOrganizationProjectAggregate)).evidence[0].values.acceptedReviewItems, 1);
    await setPlanningSourcePermission(f.planning.session, f.planning.photo.id, { intentId: randomUUID(), expectedVersion: 1, permission: "withdrawn", reason: "Controlled image withdrawal" });
    await setPlanningSourcePermission(f.planning.session, f.planning.photo.id, { intentId: randomUUID(), expectedVersion: 2, permission: "allowed", reason: "New source permission needs a new exact review" });
    const changed = await organizationAggregateRead(input, loadOrganizationProjectAggregate); assert.equal(changed.evidence[0].values.acceptedReviewItems, 0); assert.equal(changed.evidence[0].values.reviewedIllustrations, 0);
    await publishFixture(f.planning);
    const newer = await organizationAggregateRead(input, loadOrganizationProjectAggregate); assert.equal(newer.evidence[0].values.acceptedReviewItems, 0); assert.equal(newer.evidence[0].values.planRevision, f.publication.row.revision + 1);
  });
  it("omits a revoked published edition without destroying its history or reporting a fabricated current plan", async () => {
    const f = await fixture(), workspace = await readPlanningWorkspace(f.planning.session);
    await revokePublishedPlan(f.planning.session, { intentId: randomUUID(), expectedVersion: workspace.headVersion, publicationId: f.publication.view.publicationId, reason: "Controlled plan withdrawal for aggregate test" });
    const aggregate = await organizationAggregateRead(organizationAggregateInput(f.story), loadOrganizationProjectAggregate); assert.deepEqual(aggregate.evidence, []); assert.equal(aggregate.state, "partial"); assert.equal(aggregate.lineage!.planHash, null);
    const [retained] = await query<{ state: string }>("SELECT state FROM fp_plan_publications WHERE id=$1", [f.publication.view.publicationId]); assert.equal(retained.state, "revoked");
  });
  it("reports only this link's immutable policy revision enforced by the exact current publication; pointers, wrong hashes/heads and other organizations do not qualify", async () => {
    const f = await fixture(), link = await linked(f.story), other = await linked(f.story), current = await publishFixture(f.planning);
    const definition = orgPolicyDefinitionSchema.parse({ kind: "evidence_policy", title: "Controlled immutable evidence rules", description: "Synthetic stored artifact test only; no actual application or physical work is claimed.", templateIds: ["makerspace"], packages: [{ key: "shared-work", requirements: [{ id: "photo", label: "Reviewed image association", kind: "photo_association", scope: null }] }], allowedSourceProvenance: ["sample_document", "user_upload"], maximumImageSharing: "project_members" }), hash = sha256(canonicalJson(definition)), policies: string[] = [];
    async function storedPolicy(target: typeof link, binding: "none" | "exact" | "wrong_hash" | "wrong_head" | "draft" | "old_publication" | "plan_id", retired = false) {
      const policyId = randomUUID(), versionId = randomUUID(), adoptionId = randomUUID(); policies.push(policyId);
      const [session] = await query<{ id: string }>("SELECT id FROM fp_org_sessions WHERE membership_id=$1", [target.profile.membershipId]);
      await database().transaction(async tx => {
        await tx.query("INSERT INTO fp_org_policies(id,organization_id,kind,title,template_ids,draft_hash,encrypted_draft,latest_revision) VALUES($1,$2,'evidence_policy','Controlled immutable test policy','[\"makerspace\"]'::jsonb,$3,$4,1)", [policyId, target.profile.organizationId, hash, sealPrivate(definition, `controlled-policy:${policyId}`)]);
        await tx.query("INSERT INTO fp_org_policy_versions(id,policy_id,organization_id,revision,content_hash,encrypted_definition,publisher_membership_id,publisher_membership_version,publisher_session_id,publisher_role,state,retired_at) VALUES($1,$2,$3,1,$4,$5,$6,1,$7,'owner',$8,$9)", [versionId, policyId, target.profile.organizationId, hash, sealPrivate(definition, `controlled-policy-version:${versionId}`), target.profile.membershipId, session.id, retired ? "retired" : "active", retired ? new Date().toISOString() : null]);
        await tx.query("INSERT INTO fp_project_policy_adoptions(id,tenant_id,project_id,link_id,source_organization_id,source_policy_id,source_policy_version_id,origin,kind,title,rule_hash,encrypted_rule,mappings,adoption_head,state,project_actor_id,project_membership_version,project_session_id,org_membership_id,org_membership_version,org_session_id) VALUES($1,$2,$3,$4,$5,$6,$7,'organization_adoption','evidence_policy','Controlled stored rule',$8,$9,'[{\"policyPackageKey\":\"shared-work\",\"targetPackageIds\":[\"printing\"]}]'::jsonb,1,$10,$11,1,$12,$13,1,$14)", [adoptionId, f.story.tenantId, f.story.projectId, target.input.linkId, target.profile.organizationId, policyId, versionId, hash, sealPrivate(definition, `controlled-adoption:${adoptionId}`), binding === "draft" ? "draft" : binding === "none" ? "materialized" : "applied", f.story.organizer.actorId, f.story.organizer.id, target.profile.membershipId, session.id]);
        if (binding !== "none") await tx.query("INSERT INTO fp_project_policy_artifacts(id,adoption_id,tenant_id,project_id,consumer,artifact_id,artifact_hash,state,adoption_head,encrypted_data) VALUES($1,$2,$3,$4,'plan_publication',$5,$6,'enforced',$7,$8)", [randomUUID(), adoptionId, f.story.tenantId, f.story.projectId, binding === "old_publication" ? f.publication.view.publicationId : binding === "plan_id" ? current.row.id : current.view.publicationId, binding === "wrong_hash" ? "b".repeat(64) : current.row.content_hash, binding === "wrong_head" ? 2 : 1, sealPrivate({ sample: true, controlledStoredBinding: true }, `controlled-policy-artifact:${adoptionId}`)]);
      });
      return policyId;
    }
    await storedPolicy(link, "none"); await storedPolicy(link, "wrong_hash"); await storedPolicy(link, "wrong_head"); await storedPolicy(link, "draft"); await storedPolicy(link, "old_publication"); await storedPolicy(link, "plan_id"); await storedPolicy(other, "exact"); const enforced = await storedPolicy(link, "exact", true);
    const aggregate = await organizationAggregateRead(link.input, loadOrganizationProjectAggregate), revisions = aggregate.evidence[0].values.policyRevisions;
    assert.deepEqual(revisions, [{ policyId: enforced, revision: 1, contentHash: hash }]);
    for (const excluded of policies.filter(id => id !== enforced)) assert.equal(JSON.stringify(aggregate).includes(excluded), false);
  });
});
