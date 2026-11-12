import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import * as C from "../lib/organizations/contracts";
import { DomainError } from "../lib/domain/money";
import { query, database } from "../lib/server/db";
import { orgHash, organizationTransaction } from "../lib/server/organization-core";
import { readOrganizationDesk } from "../lib/server/organization-desk";
import { organizationPolicyDetail, retireOrganizationPolicy, saveOrganizationPolicy } from "../lib/server/organization-policies";
import { projectPackageEncumbrances, withdrawOrganizationProjectLink } from "../lib/server/organization-projects";
import { adoptOrganizationPolicy, deactivateProjectRule, organizationPolicyApplication, organizationProjectParticipation, replaceProjectRule, reviewOrganizationAdoption, reviewProjectRuleReplacement } from "../lib/server/organization-adoptions";
import { captureOrganizationPortfolio, exportOrganizationPortfolio, readOrganizationPortfolio, readOrganizationPortfolioReport, readOrganizationPortfolioProject } from "../lib/server/organization-portfolio";
import { activeProjectPolicies, assertProjectPolicyReview, enforceProjectFundDecision, recordProjectPolicyReview } from "../lib/server/project-policy";
import { createFundingPolicy, savedFundingPolicy } from "../lib/server/funding-lifecycle";
import { createSponsorOffer, acceptSponsorOffer } from "../lib/server/sponsors";
import { createPurposePledge } from "../lib/server/purpose-pledges";
import { readPlanningWorkspace, reviewPlan, savePlan } from "../lib/server/planning";
import { setPlanningSourcePermission } from "../lib/server/planning-sources";
import { appendEvent } from "../lib/server/repository";
import { organizationTestDatabase } from "./helpers/organization-database";
import { fundDefinition, organizationAdopt, organizationAdoptionSelection, organizationJoin, organizationLink, organizationOwner, organizationPublished, organizationScopes, organizationWorkflow } from "./helpers/organization-workflow";
import { organizationAggregateFixture, organizationExpenseFixture } from "./helpers/organization-aggregate";
import { storyPlanning, storyReceipt } from "./helpers/supporter-story";
import { alignedFixture, publishFixture } from "./helpers/planning";

organizationTestDatabase();
const code = (wanted: string) => (error: unknown) => error instanceof DomainError && error.code === wanted;
const none = { strategy: "none" as const, sketchDocumentId: null, page: null };
async function funding(f: Awaited<ReturnType<typeof organizationWorkflow>>, packageId = "materials", kind: "reallocation" | "rollover" | "mixed" = "mixed") {
  const saved = await createFundingPolicy(f.project.organizer, { intentId: randomUUID(), packageId, expectedVersion: 1, kind, acknowledged: true });
  return database().transaction(tx => savedFundingPolicy(f.project.organizer, saved.id, tx));
}
function evidenceDefinition(): C.OrgPolicyDefinition {
  return C.orgPolicyDefinitionSchema.parse({ kind: "evidence_policy", title: "Controlled scoped evidence rule", description: "An explicit synthetic source and image-sharing policy.", templateIds: ["makerspace"],
    packages: [{ key: "shared-purpose", requirements: [{ id: "fresh-review", kind: "installation_review", label: "Fresh scoped equipment review", scope: "equipment_setup" }] }],
    allowedSourceProvenance: ["sample_document"], maximumImageSharing: "reviewers_only" });
}
describe("organization governance uses real separate project consumers", () => {
  it("keeps organization authority separate and owner-only drafts/rosters private", async () => {
    const f = await organizationWorkflow(), auditor = await organizationJoin(f.request, "auditor");
    const unpublished = await saveOrganizationPolicy(f.request, { intentId: randomUUID(), expectedScope: f.request.organizationScope, policyId: null, expectedHead: 0, definition: fundDefinition({ title: "Private unpublished owner canary" }) });
    const desk = await readOrganizationDesk(auditor.request); assert.equal(desk.desk.roster, null); assert.equal(desk.desk.policies.length, 0);
    assert.equal(JSON.stringify(desk).includes("Private unpublished owner canary"), false);
    await assert.rejects(organizationPolicyDetail(auditor.request, unpublished.receipt.resourceId!), code("ORG_RESOURCE_UNAVAILABLE"));
    assert.equal((await organizationProjectParticipation(auditor.request)).participation.projectContext.state, "none");
    const projectOnly = { ...f.request, organizationToken: null, organizationScope: undefined };
    assert.equal((await organizationProjectParticipation(projectOnly)).participation.links[0].id, f.linkId);
    assert.equal((await readOrganizationDesk(f.request)).desk.profile.role, "owner");
  });
  it("applies a copied fund rule to new purpose construction and retains exact same-intent adoption", async () => {
    const f = await organizationWorkflow(), originalDeadline = f.project.organizer.expiresAt;
    const policy = await organizationPublished(f.request, fundDefinition({ allowRollover: false }));
    const applied = await organizationAdopt(f.request, f.linkId, policy);
    assert.equal(applied.result.application.summary.state, "applied"); assert.ok(applied.result.application.bindings.every(binding => binding.state === "enforced"));
    const recovered = await adoptOrganizationPolicy(f.request, f.linkId, applied.input); assert.deepEqual(recovered.receipt, applied.result.receipt);
    await assert.rejects(funding(f, "materials", "rollover"), code("ORG_POLICY_INVALID"));
    const allowed = await funding(f, "materials", "reallocation");
    const [artifact] = await query<{ artifact_id: string; artifact_hash: string }>("SELECT * FROM fp_project_policy_artifacts WHERE adoption_id=$1 AND consumer='funding_policy' AND artifact_id=$2", [applied.result.receipt.resourceId, allowed.row.id]);
    assert.equal(artifact.artifact_hash, allowed.row.digest);
    const [session] = await query<{ expires_at: Date }>("SELECT expires_at FROM fp_sessions WHERE id=$1", [f.project.organizer.id]); assert.equal(session.expires_at.toISOString(), originalDeadline);
  });
  it("retains an already accepted sponsor promise while refusing a new acceptance under changed prospective rules", async () => {
    const f = await organizationWorkflow(), purpose = await funding(f);
    const offerInput = { intentId: randomUUID(), kind: "grant" as const, name: "Controlled sample grant", note: "Fictional independent donor promise; no payment or person is asserted.", totalCapMinor: 100, matchBasisPoints: 10000,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), packages: [{ policyId: purpose.row.id, policyDigest: purpose.row.digest, capMinor: 100 }], acknowledged: true as const };
    const first = await createSponsorOffer(f.project.organizer, offerInput), second = await createSponsorOffer(f.project.organizer, { ...offerInput, intentId: randomUUID() });
    const [firstRow, secondRow] = await query<{ id: string; digest: string; version: number }>("SELECT id,digest,version FROM fp_sponsor_offers WHERE id=ANY($1::text[]) ORDER BY created_at,id", [[first.id, second.id]]);
    const selected = [firstRow, secondRow].find(row => row.id === first.id)!, waiting = [firstRow, secondRow].find(row => row.id === second.id)!;
    await acceptSponsorOffer(f.project.donors[0], { intentId: randomUUID(), offerId: selected.id, digest: selected.digest, expectedVersion: selected.version, acknowledged: true });
    const before = await query("SELECT row_to_json(p) value FROM fp_purpose_pledges p WHERE project_id=$1 ORDER BY id", [f.project.projectId]);
    await organizationAdopt(f.request, f.linkId, await organizationPublished(f.request, fundDefinition({ allowGrants: false })));
    await assert.rejects(acceptSponsorOffer(f.project.donors[1], { intentId: randomUUID(), offerId: waiting.id, digest: waiting.digest, expectedVersion: waiting.version, acknowledged: true }), code("ORG_POLICY_INVALID"));
    assert.deepEqual(await query("SELECT row_to_json(p) value FROM fp_purpose_pledges p WHERE project_id=$1 ORDER BY id", [f.project.projectId]), before);
    assert.equal(before.length, 1);
  });
  it("enforces sponsor caps and new expense limits in the real constructors", async () => {
    const f = await organizationWorkflow(), purpose = await funding(f, "printing");
    const policy = await organizationPublished(f.request, fundDefinition({ maximumExpenseMinor: 1000, maximumSponsorCapMinor: 90, maximumMatchBasisPoints: 10000 }));
    await organizationAdopt(f.request, f.linkId, policy, { mappings: [{ policyPackageKey: "shared-purpose", targetPackageIds: ["printing"] }] });
    await assert.rejects(createSponsorOffer(f.project.organizer, { intentId: randomUUID(), kind: "match", name: "Controlled capped match", note: "Synthetic matching offer with a deliberately excessive ratio.", totalCapMinor: 100, matchBasisPoints: 20000, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), packages: [{ policyId: purpose.row.id, policyDigest: purpose.row.digest, capMinor: 100 }], acknowledged: true }), code("ORG_POLICY_INVALID"));
    await assert.rejects(organizationExpenseFixture(f.project), code("ORG_POLICY_INVALID"));
    const claims = await query<{ approved_minor: string }>("SELECT approved_minor FROM fp_claims WHERE project_id=$1", [f.project.projectId]); assert.equal(claims.length, 1); assert.equal(Number(claims[0].approved_minor), 0);
    assert.equal((await query("SELECT id FROM fp_sponsor_offers WHERE project_id=$1", [f.project.projectId])).length, 0);
  });
  it("materializes an editable evidence plan and binds actual reviewed publication/image consumers", async () => {
    const f = await organizationWorkflow(), planning = await storyPlanning(f.project); await publishFixture(planning);
    const policy = await organizationPublished(f.request, evidenceDefinition()), adopted = await organizationAdopt(f.request, f.linkId, policy,
      { mappings: [{ policyPackageKey: "shared-purpose", targetPackageIds: ["printing"] }], planSource: { strategy: "current_draft", sketchDocumentId: null, page: null } });
    assert.equal(adopted.result.application.summary.state, "materialized"); assert.ok(adopted.result.application.materializedPlan);
    const current = (await readPlanningWorkspace(f.project.organizer)).current!;
    assert.equal(current.id, adopted.result.application.materializedPlan.id); assert.equal(current.plan.packages.find(pkg => pkg.packageId === "printing")!.reviewState, "needs_review");
    const bypass = structuredClone(current.plan); bypass.packages.forEach(pkg => { pkg.reviewState = "reviewed"; pkg.requirements = pkg.requirements.filter(item => !item.id.startsWith("org_")); });
    const saved = await savePlan(f.project.organizer, { intentId: randomUUID(), expectedVersion: (await readPlanningWorkspace(f.project.organizer)).headVersion, plan: bypass, origin: "manual", sourceRunId: null });
    const rejected = (await readPlanningWorkspace(f.project.organizer)).current!;
    await assert.rejects(reviewPlan(f.project.organizer, { intentId: randomUUID(), expectedVersion: saved.headVersion, planId: saved.id, contentHash: rejected.contentHash, decision: "approved", note: "Controlled omitted rule check", sourceReviewConfirmed: true }), code("ORG_PLAN_REVIEW_REQUIRED"));
    const compliant = structuredClone(current.plan); compliant.packages.forEach(pkg => { pkg.reviewState = "reviewed"; });
    const published = await publishFixture({ ...planning, plan: compliant });
    const application = await organizationPolicyApplication(f.request, f.linkId, adopted.result.receipt.resourceId!); assert.equal(application.application.summary.complianceState, "current");
    const [binding] = await query<{ artifact_hash: string }>("SELECT artifact_hash FROM fp_project_policy_artifacts WHERE adoption_id=$1 AND consumer='plan_publication' AND artifact_id=$2", [adopted.result.receipt.resourceId, published.view.publicationId]); assert.equal(binding.artifact_hash, published.row.content_hash);
    await assert.rejects(alignedFixture(planning, "printing", "project_members"), code("ORG_POLICY_INVALID"));
    const image = await alignedFixture(planning, "printing", "reviewers_only"); await image.review();
    assert.equal((await query("SELECT id FROM fp_project_policy_artifacts WHERE adoption_id=$1 AND consumer='image_review' AND artifact_id=$2", [adopted.result.receipt.resourceId, image.id])).length, 1);
    const blockers = await database().transaction(tx => projectPackageEncumbrances(tx, f.project.organizer, "printing"));
    assert.ok(blockers.includes("Original image-association history"));
  });
  it("revises only an explicitly reviewed empty canonical package and retains its complete original version", async () => {
    const f = await organizationWorkflow(), planning = await storyPlanning(f.project); await publishFixture(planning);
    const before = (await query<{ version: number; budget_minor: string; data: unknown }>("SELECT version,budget_minor,data FROM fp_packages WHERE project_id=$1 AND id='materials'", [f.project.projectId]))[0];
    const definition = C.orgPolicyDefinitionSchema.parse({ kind: "package_library", title: "Controlled reusable materials", description: "Fictional target-specific quoted proposal.", templateIds: ["makerspace"], dependencies: [],
      packages: [{ key: "shared-purpose", title: "Shared materials cupboard", description: "Fictional supplies for a controlled review.", proposedBudgetMinor: 999, currency: "USD", category: "Supplies", capabilities: ["Shared materials"], requirements: [{ id: "library-photo", kind: "photo_association", label: "Review the supplied illustration", scope: null }] }] });
    const policy = await organizationPublished(f.request, definition), quote = { id: "target-materials-quote", documentId: planning.quote.id, page: 1, region: { x: .1, y: .1, width: .3, height: .1 }, text: "Controlled fictional target amount 7.77 USD", confidence: 1, kind: "quote" as const };
    const applied = await organizationAdopt(f.request, f.linkId, policy, { planSource: { strategy: "current_draft", sketchDocumentId: null, page: null }, reviseCanonicalEmptyPackages: true,
      reviewedQuotes: [{ policyPackageKey: "shared-purpose", targetPackageId: "materials", reviewedBudgetMinor: 777, citation: quote }] });
    const after = (await query<{ version: number; budget_minor: string }>("SELECT version,budget_minor FROM fp_packages WHERE project_id=$1 AND id='materials'", [f.project.projectId]))[0];
    assert.equal(after.version, before.version + 1); assert.equal(Number(after.budget_minor), 777); assert.ok(applied.review.warnings.some(message => message.includes("differs")));
    assert.equal(applied.result.application.canonicalRevision!.packages[0].budgetMinor, 777);
    const [revision] = await query<{ encrypted_data: string }>("SELECT encrypted_data FROM fp_project_package_revisions WHERE id=$1", [applied.result.application.canonicalRevision!.id]);
    assert.ok(revision.encrypted_data && !revision.encrypted_data.includes("Shared materials cupboard"));
    await assert.rejects(query("UPDATE fp_project_package_revisions SET content_hash=$2 WHERE id=$1", [applied.result.application.canonicalRevision!.id, "b".repeat(64)]), (error: unknown) => (error as { code: string }).code === "23514");
    const [other] = await query<{ budget_minor: string; version: number }>("SELECT budget_minor,version FROM fp_packages WHERE project_id=$1 AND id='woodworking'", [f.project.projectId]); assert.equal(other.version, 1);
    assert.equal((await query("SELECT id FROM fp_obligations WHERE project_id=$1", [f.project.projectId])).length, 0);
  });
  it("blocks empty-package revision once an original named-purpose promise exists", async () => {
    const f = await organizationWorkflow(), purpose = await funding(f), planning = await storyPlanning(f.project); await publishFixture(planning);
    await createPurposePledge(f.project.donors[0], { intentId: randomUUID(), policyId: purpose.row.id, policyDigest: purpose.row.digest, amountMinor: 100, acknowledged: true });
    const definition = C.orgPolicyDefinitionSchema.parse({ kind: "package_library", title: "A deliberately blocked library", description: "Controlled encumbrance guard.", templateIds: ["makerspace"], dependencies: [], packages: [{ key: "shared-purpose", title: "A changed purpose", description: "Controlled proposed change", proposedBudgetMinor: 777, currency: "USD", category: "Supplies", capabilities: [], requirements: [{ id: "photo", kind: "photo_association", label: "Image review", scope: null }] }] });
    const policy = await organizationPublished(f.request, definition), selection = await organizationAdoptionSelection(f.request, f.linkId, policy, { planSource: { strategy: "current_draft", sketchDocumentId: null, page: null }, reviseCanonicalEmptyPackages: true,
      reviewedQuotes: [{ policyPackageKey: "shared-purpose", targetPackageId: "materials", reviewedBudgetMinor: 777, citation: { id: "blocked-quote", documentId: planning.quote.id, page: 1, region: { x: .1, y: .1, width: .3, height: .1 }, text: "Fictional amount", confidence: 1, kind: "quote" } }] });
    const { review } = await reviewOrganizationAdoption(f.request, f.linkId, selection); assert.equal(review.canApply, false); assert.match(review.blockers.join(" "), /original financial or evidence history/);
    await assert.rejects(adoptOrganizationPolicy(f.request, f.linkId, { intentId: randomUUID(), expectedScope: f.request.organizationScope!, expectedProjectScope: f.request.projectScope!, selection, reviewHash: review.reviewHash, acknowledged: true, preservedHistoryAcknowledged: true }), code("ORG_POLICY_REVIEW_REQUIRED"));
    assert.equal((await query<{ version: number }>("SELECT version FROM fp_packages WHERE project_id=$1 AND id='materials'", [f.project.projectId]))[0].version, 1);
  });
  it("keeps copied rules after policy retirement/disclosure withdrawal, with independent project replacement and deactivation", async () => {
    const f = await organizationWorkflow(), policy = await organizationPublished(f.request, fundDefinition({ allowRollover: false })), adopted = await organizationAdopt(f.request, f.linkId, policy), id = adopted.result.receipt.resourceId!;
    await retireOrganizationPolicy(f.request, policy.policyId, { intentId: randomUUID(), expectedScope: f.request.organizationScope, versionId: policy.version.id, expectedStateVersion: 1, reason: "Controlled reusable-version retirement", acknowledged: true });
    await withdrawOrganizationProjectLink(f.request, f.linkId, { authority: "organization", intentId: randomUUID(), expectedScope: f.request.organizationScope, expectedVersion: 1, reason: "Controlled aggregate withdrawal only", acknowledged: true });
    await assert.rejects(funding(f, "materials", "rollover"), code("ORG_POLICY_INVALID"));
    const independent = { ...f.request, organizationToken: null, organizationScope: undefined }, application = (await organizationPolicyApplication(independent, f.linkId, id)).application;
    const input = { expectedProjectScope: independent.projectScope!, expectedProjectBasis: application.projectBasis, expectedVersion: application.summary.version,
      definition: fundDefinition({ title: "Project-owned replacement", allowRollover: true }), mappings: application.mappings, planSource: none, reviseCanonicalEmptyPackages: false, reviewedQuotes: [] };
    const { review } = await reviewProjectRuleReplacement(independent, f.linkId, id, input);
    const replacement = await replaceProjectRule(independent, f.linkId, id, { intentId: randomUUID(), expectedProjectScope: input.expectedProjectScope, expectedProjectBasis: input.expectedProjectBasis, expectedVersion: input.expectedVersion, reason: "Controlled independent project replacement", acknowledged: true, preservedHistoryAcknowledged: true, reviewHash: review.reviewHash, input });
    assert.equal(replacement.application.rule.origin, "project_revision"); assert.equal(replacement.application.rule.sourceOrganizationPolicy, null);
    assert.equal((await organizationPolicyApplication(independent, f.linkId, id)).application.summary.state, "superseded");
    const next = replacement.application, ended = { intentId: randomUUID(), expectedProjectScope: independent.projectScope!, expectedProjectBasis: next.projectBasis, expectedVersion: next.summary.version, reason: "Controlled prospective deactivation", acknowledged: true, preservedHistoryAcknowledged: true };
    const receipt = await deactivateProjectRule(independent, f.linkId, next.summary.id, ended); assert.deepEqual(await deactivateProjectRule(independent, f.linkId, next.summary.id, ended), receipt);
    assert.equal((await database().transaction(tx => activeProjectPolicies(tx, f.project.organizer))).length, 0);
    const [original] = await query<{ rule_hash: string }>("SELECT rule_hash FROM fp_project_policy_adoptions WHERE id=$1", [id]); assert.equal(original.rule_hash, adopted.result.application.rule.contentHash);
  });
  it("pins the zero-rule payment-review boundary and rejects adding a fund rule before approval", async () => {
    const f = await organizationWorkflow(), reviewId = randomUUID(), originalHash = orgHash({ controlled: "exact payout review" });
    await database().transaction(tx => recordProjectPolicyReview(tx, f.project.organizer, reviewId, originalHash, []));
    const adopted = await organizationAdopt(f.request, f.linkId, await organizationPublished(f.request, fundDefinition({ maximumExpenseMinor: 500 })));
    await assert.rejects(database().transaction(async tx => {
      const rules = await enforceProjectFundDecision(tx, f.project.organizer, { consumer: "payable_approval", packages: [{ packageId: "materials", expenseMinor: 100, feeMinor: 5 }] });
      await assertProjectPolicyReview(tx, f.project.organizer, reviewId, originalHash, rules);
    }), code("ORG_POLICY_REVIEW_REQUIRED"));
    assert.equal((await query("SELECT id FROM fp_project_policy_subjects WHERE artifact_id=$1", [reviewId])).length, 1);
    assert.ok(adopted.result.application.bindings.some(binding => binding.consumer === "payable_approval"));
  });
});

describe("immutable organization portfolios disclose only approved aggregates", () => {
  it("captures two independently linked templates with per-section coverage and no private actors, sources or provider references", async () => {
    const f = await organizationWorkflow(), privateReceipt = await storyReceipt(f.project, f.project.donors[0], "materials", 500);
    const expense = await organizationExpenseFixture(f.project), second = await organizationAggregateFixture("community-garden");
    f.request.projectToken = second.token; await organizationScopes(f.request); const secondLink = await organizationLink(f.request, ["budget"]);
    const aggregateOnly = { ...f.request, projectToken: null, projectScope: undefined }, { portfolio } = await readOrganizationPortfolio(aggregateOnly);
    assert.equal(portfolio.live.knownLinks, 2); assert.equal(portfolio.live.coverage.budget.denominatorProjects, 2); assert.equal(portfolio.live.coverage.funding.denominatorProjects, 1);
    const input = { intentId: randomUUID(), expectedScope: aggregateOnly.organizationScope!, label: "Controlled scoped portfolio edition", expectedBasisHash: portfolio.live.basisHash, filters: portfolio.live.filters, acknowledged: true as const };
    const capture = await captureOrganizationPortfolio(aggregateOnly, input), recovered = await captureOrganizationPortfolio(aggregateOnly, input);
    assert.deepEqual(recovered.receipt, capture.receipt); assert.equal(recovered.view.summary.contentHash, capture.view.summary.contentHash); assert.equal(capture.view.status, "current");
    const changedFilters = await readOrganizationPortfolio(aggregateOnly, undefined, { ...portfolio.live.filters, linkIds: [secondLink] });
    assert.equal(changedFilters.portfolio.live.projects.length, 1); assert.equal(changedFilters.portfolio.selected!.status, "current");
    assert.equal(changedFilters.portfolio.selected!.currentBasisHash, capture.view.summary.basisHash);
    const payload = JSON.stringify(capture);
    for (const privateValue of [f.project.organizer.actorId, f.project.volunteer.actorId, privateReceipt.id, privateReceipt.actualProviderPaymentRef, expense.claim.id, expense.document.id, ...expense.canaries]) assert.equal(payload.includes(privateValue), false, "Only approved scalar lineage is public to the organization");
    const detail = await readOrganizationPortfolioProject(aggregateOnly, secondLink, capture.view.summary.id); assert.equal(detail.detail.project.money.length, 0); assert.equal(detail.detail.project.evidence.length, 0); assert.deepEqual(detail.detail.definitions.map(row => row.metric), ["budget"]);
    const csv = await exportOrganizationPortfolio(aggregateOnly, capture.view.summary.id); assert.match(csv.csv, /originalGrossMinor/); assert.match(csv.csv, /unpaidCommitmentMinor/); assert.equal(expense.canaries.some(value => csv.csv.includes(value)), false);
    const auditor = await organizationJoin(f.request, "auditor"); assert.equal((await readOrganizationPortfolio(auditor.request)).portfolio.history.length, 0);
    await assert.rejects(readOrganizationPortfolioReport(auditor.request, capture.view.summary.id), code("ORG_RESOURCE_UNAVAILABLE"));
    const other = await organizationOwner(); await assert.rejects(readOrganizationPortfolioReport(other.request, capture.view.summary.id), code("ORG_RESOURCE_UNAVAILABLE"));
    await assert.rejects(query("DELETE FROM fp_org_portfolios WHERE id=$1", [capture.view.summary.id]), (error: unknown) => (error as { code: string }).code === "23514");
  });
  it("keeps later activity historical, but withholds the original edition after source permission withdrawal", async () => {
    const f = await organizationWorkflow(), planning = await storyPlanning(f.project); await publishFixture(planning);
    const image = await alignedFixture(planning, "printing"); await image.review();
    const live = (await readOrganizationPortfolio(f.request)).portfolio.live;
    const capture = await captureOrganizationPortfolio(f.request, { intentId: randomUUID(), expectedScope: f.request.organizationScope, label: "Original source-bound edition", expectedBasisHash: live.basisHash, filters: live.filters, acknowledged: true });
    const original = await query("SELECT row_to_json(r) value FROM fp_org_portfolios r WHERE id=$1", [capture.view.summary.id]);
    await database().transaction(tx => appendEvent(tx, f.project.organizer, "controlled.later_activity", "Controlled later project fact", "No source or deadline changed."));
    const historical = await readOrganizationPortfolioReport(f.request, capture.view.summary.id); assert.equal(historical.view.status, "historical"); assert.equal(historical.view.report!.contentHash, capture.view.summary.contentHash);
    await setPlanningSourcePermission(f.project.organizer, planning.photo.id, { intentId: randomUUID(), expectedVersion: planning.photo.controlVersion, permission: "withdrawn", reason: "Controlled original-source withdrawal" });
    const withdrawn = (await readOrganizationPortfolioReport(f.request, capture.view.summary.id)).view;
    assert.equal(withdrawn.status, "withdrawn"); assert.equal(withdrawn.report, null); assert.equal(withdrawn.canPrint, false); assert.equal(withdrawn.canExport, false);
    await assert.rejects(exportOrganizationPortfolio(f.request, capture.view.summary.id), code("ORG_REPORT_WITHDRAWN"));
    await assert.rejects(readOrganizationPortfolioProject(f.request, f.linkId, capture.view.summary.id), code("ORG_REPORT_WITHDRAWN"));
    assert.deepEqual(await query("SELECT row_to_json(r) value FROM fp_org_portfolios r WHERE id=$1", [capture.view.summary.id]), original);
  });
  it("ends aggregate access on independent project withdrawal while retaining the immutable report and original profile deadlines", async () => {
    const f = await organizationWorkflow(), live = (await readOrganizationPortfolio(f.request)).portfolio.live;
    const capture = await captureOrganizationPortfolio(f.request, { intentId: randomUUID(), expectedScope: f.request.organizationScope, label: "Original project consent edition", expectedBasisHash: live.basisHash, filters: live.filters, acknowledged: true });
    const prior = await query("SELECT id,expires_at FROM fp_sessions WHERE project_id=$1 ORDER BY id", [f.project.projectId]);
    await withdrawOrganizationProjectLink({ ...f.request, organizationToken: null, organizationScope: undefined }, f.linkId, { authority: "project", intentId: randomUUID(), expectedProjectScope: f.request.projectScope, expectedVersion: 1, reason: "Controlled independent project withdrawal", acknowledged: true });
    const view = (await readOrganizationPortfolioReport(f.request, capture.view.summary.id)).view; assert.equal(view.report, null); assert.equal(view.status, "withdrawn");
    const current = (await readOrganizationPortfolio(f.request)).portfolio.live; assert.equal(current.projects[0].project, null); assert.equal(current.withdrawnLinks, 1);
    assert.deepEqual(await query("SELECT id,expires_at FROM fp_sessions WHERE project_id=$1 ORDER BY id", [f.project.projectId]), prior);
  });
});
