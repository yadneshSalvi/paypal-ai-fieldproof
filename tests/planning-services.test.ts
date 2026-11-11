import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { database, query } from "../lib/server/db";
import { documentOriginal, documentPreview, documentUploadGrant } from "../lib/server/documents";
import { createReviewerInvite, permittedReviewerScopes, redeemReviewerInvite, revokeReviewerInvite, reviewerAccessViews } from "../lib/server/planning-reviewer-access";
import { alignmentViews, packageReadiness, qualificationViews, recordWorkSignoff, requestReviewerQualification, reviewPhotoAlignment, reviewReviewerQualification, revokePhotoAlignment, savePhotoAlignment, sharedAlignmentImage, signoffViews } from "../lib/server/planning-evidence";
import { redactPlanningImage } from "../lib/server/planning-images";
import { setPlanningSourcePermission } from "../lib/server/planning-sources";
import { planPayload, publishedPlan, requirePlan } from "../lib/server/planning-store";
import { planningScenario, publishReviewedPlan, readPlanningVersion, readPlanningWorkspace, reviewPlan, revokePublishedPlan, savePlan } from "../lib/server/planning";
import { materializeStudioDataset, readStudioSnapshot, requireStudioDataset } from "../lib/server/studio-datasets";
import { addActor, alignedFixture, bytesHash, errorCode, isolatedPlanningDatabase, planningFixture, publishFixture, qualificationFixture, role, uploadFixture, type PlanningFixture } from "./helpers/planning";
import type { Session } from "../lib/server/auth";
import type { QualificationView } from "../lib/planning/contracts";

isolatedPlanningDatabase();
const saveInput = (f: PlanningFixture, expectedVersion = 0) => ({ intentId: randomUUID(), expectedVersion, plan: f.plan, origin: "manual" as const, sourceRunId: null });
async function signoffInput(f: PlanningFixture, actor: Session, qualification: QualificationView, packageId: string, documentIds: string[]) {
  const published = (await publishedPlan(f.session))!, requirement = published.payload.plan.packages.find(p => p.packageId === packageId)!.requirements.find(r => r.scope === qualification.scope)!;
  return { intentId: randomUUID(), planId: published.row.id, packageId, requirementId: requirement.id, qualificationId: qualification.id, qualificationVersion: qualification.version,
    documentIds, decision: "accepted" as const, statement: "Controlled test decision. No real inspection or physical outcome is represented by this fixture.", limitations: "Fixture exercises authorization only; no professional or physical acceptance is established.",
    observedAt: new Date().toISOString(), expectedPlanHash: published.row.content_hash, scopeConfirmed: true as const, sampleAcknowledged: actor.mode === "sample" };
}

describe("immutable source plans and current-role publication", () => {
  it("replays the same intent once, rejects changed replays and permits only one concurrent version save", async () => {
    const f = await planningFixture(), input = saveInput(f);
    const [a, b] = await Promise.all([savePlan(f.session, input), savePlan(f.session, input)]);
    assert.deepEqual(a, b); assert.equal((await readPlanningWorkspace(f.session)).history.length, 1);
    await assert.rejects(savePlan(f.session, { ...input, plan: { ...input.plan, title: "Different input" } }), errorCode("PLANNING_INTENT_CHANGED"));
    const raced = await Promise.allSettled([savePlan(f.session, saveInput(f, 1)), savePlan(f.session, saveInput(f, 1))]);
    assert.equal(raced.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(raced.filter(r => r.status === "rejected" && errorCode("PLAN_VERSION_CHANGED")(r.reason)).length, 1);
  });
  it("requires actual extraction lineage and an exact approved plan hash", async () => {
    const f = await planningFixture();
    await assert.rejects(savePlan(f.session, { ...saveInput(f), origin: "model" }), errorCode("MODEL_LINEAGE_REQUIRED"));
    const saved = await savePlan(f.session, saveInput(f)), current = (await readPlanningWorkspace(f.session)).current!;
    await assert.rejects(reviewPlan(f.session, { intentId: randomUUID(), expectedVersion: saved.headVersion, planId: saved.id, contentHash: "a".repeat(64), decision: "approved", note: "Controlled wrong hash review", sourceReviewConfirmed: true }), errorCode("PLAN_HASH_CHANGED"));
    await assert.rejects(publishReviewedPlan(f.session, { intentId: randomUUID(), expectedVersion: saved.headVersion, planId: saved.id, reviewId: randomUUID(), contentHash: current.contentHash, acknowledged: true }), errorCode("PLAN_APPROVAL_REQUIRED"));
  });
  it("keeps quote disagreements as proposals without changing approved budgets or consent versions", async () => {
    const f = await planningFixture(); f.plan.packages[0].budgetMinor! += 100;
    const before = await query("SELECT id,version,budget_minor FROM fp_packages WHERE project_id=$1 ORDER BY id", [f.session.projectId]);
    const saved = await savePlan(f.session, saveInput(f)), current = (await readPlanningWorkspace(f.session)).current!;
    await assert.rejects(reviewPlan(f.session, { intentId: randomUUID(), expectedVersion: saved.headVersion, planId: saved.id, contentHash: current.contentHash, decision: "approved", note: "Controlled budget mismatch test", sourceReviewConfirmed: true }), errorCode("PACKAGE_BUDGET_REVIEW_REQUIRED"));
    assert.deepEqual(await query("SELECT id,version,budget_minor FROM fp_packages WHERE project_id=$1 ORDER BY id", [f.session.projectId]), before);
  });
  it("projects no private originals, source text, model runs or review notes to a donor", async () => {
    const f = await planningFixture(); f.plan.citations[0].text = "PRIVATE_SOURCE_NOTE_test@example.invalid";
    const published = await publishFixture(f), donor = await addActor(f.session, "donor");
    const workspace = await readPlanningWorkspace(donor), serialized = JSON.stringify(workspace);
    assert.equal(workspace.published?.contentHash, published.row.content_hash); assert.deepEqual(workspace.sources, []); assert.deepEqual(workspace.runs, []); assert.deepEqual(workspace.history, []); assert.equal(workspace.current, null);
    for (const secret of [f.sketch.id, f.quote.id, "PRIVATE_SOURCE_NOTE", "test@example.invalid", "Controlled fixture review"]) assert.equal(serialized.includes(secret), false, `Private field ${secret.slice(0, 12)} must be absent`);
    await assert.rejects(readPlanningVersion(donor, published.row.id));
    await assert.rejects(savePlan(donor, saveInput(f, workspace.headVersion)), errorCode("ROLE_DENIED"));
    const foreign = await planningFixture(); await assert.rejects(readPlanningVersion(foreign.session, published.row.id), errorCode("PLAN_NOT_FOUND"));
    await assert.rejects(readPlanningWorkspace({ ...donor, mode: "live_sandbox" }), errorCode("PROJECT_NOT_FOUND"));
  });
  it("withdraws permission across original routes and makes dependent reviews stale even after reinstatement", async () => {
    const f = await planningFixture(), publication = await publishFixture(f);
    await setPlanningSourcePermission(f.session, f.quote.id, { intentId: randomUUID(), expectedVersion: 1, permission: "withdrawn", reason: "Controlled source-permission withdrawal fixture" });
    assert.equal((await publishedPlan(f.session))?.view.state, "stale");
    await assert.rejects(documentPreview(f.session, f.quote.id, 1, f.storage), errorCode("SOURCE_PERMISSION_WITHDRAWN"));
    await assert.rejects(documentOriginal(f.session, f.quote.id, f.storage), errorCode("SOURCE_PERMISSION_WITHDRAWN"));
    await assert.rejects(documentUploadGrant(f.session, f.quote.id, "unused"), errorCode("SOURCE_PERMISSION_WITHDRAWN"));
    await setPlanningSourcePermission(f.session, f.quote.id, { intentId: randomUUID(), expectedVersion: 2, permission: "allowed", reason: "Controlled permission reinstatement requires fresh review" });
    assert.equal((await publishedPlan(f.session))?.view.state, "stale");
    assert.equal(planPayload(await requirePlan(f.session, publication.row.id)).sources.find(s => s.documentId === f.quote.id)?.controlVersion, 1);
    await publishFixture(f); assert.equal((await publishedPlan(f.session))?.view.state, "current");
  });
  it("rejects a role changed in storage before a local mutation", async () => {
    const f = await planningFixture(); await query("UPDATE fp_sessions SET role='donor' WHERE id=$1", [f.session.id]);
    await assert.rejects(savePlan(f.session, saveInput(f)), errorCode("ROLE_DENIED"));
    assert.equal((await query<{ count: string }>("SELECT count(*) FROM fp_plan_versions WHERE project_id=$1", [f.session.projectId]))[0].count, "0");
  });
  it("keeps modeled allocation and all prerequisites separate from financial writes", async () => {
    const f = await planningFixture(), plan = await publishFixture(f);
    const before = await query("SELECT id,data FROM fp_settlement_receipts WHERE project_id=$1 ORDER BY id", [f.session.projectId]);
    const scenario = await planningScenario(f.session, { planId: plan.row.id, requestedIds: ["laser"], basis: "prospective", prospectiveBudgetMinor: 185000 });
    assert.equal(scenario.requested.feasible, false); assert.ok(scenario.requested.closure.includes("safety")); assert.equal(scenario.meaning, "budget_model_only");
    assert.deepEqual(await query("SELECT id,data FROM fp_settlement_receipts WHERE project_id=$1 ORDER BY id", [f.session.projectId]), before);
    assert.equal((await query<{ count: string }>("SELECT count(*) FROM fp_receipt_allocations WHERE project_id=$1", [f.session.projectId]))[0].count, "0");
  });
});

describe("private originals and independently reviewed image renditions", () => {
  it("burns opaque masks into cropped PNG bytes and strips source metadata", async () => {
    const original = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#ff0000" } }).withMetadata({ exif: { IFD0: { Artist: "PRIVATE ORIGINAL NAME" } } }).png().toBuffer();
    const result = await redactPlanningImage(original, { x: .1, y: .1, width: .8, height: .8 }, [{ x: .35, y: .35, width: .15, height: .15 }], false);
    assert.equal(result.width, 640); assert.equal(result.height, 480); assert.notEqual(bytesHash(result.bytes), bytesHash(original));
    const metadata = await sharp(result.bytes).metadata(); assert.equal(metadata.exif, undefined);
    const pixel = await sharp(result.bytes).extract({ left: 250, top: 180, width: 1, height: 1 }).removeAlpha().raw().toBuffer(); assert.deepEqual([...pixel], [24, 44, 64]);
    await assert.rejects(redactPlanningImage(original, { x: .95, y: 0, width: .1, height: 1 }, [], false), errorCode("IMAGE_REGION_INVALID"));
    await assert.rejects(redactPlanningImage(original, { x: 0, y: 0, width: .01, height: .01 }, [], false), errorCode("IMAGE_CROP_TOO_SMALL"));
  });
  it("requires explicit sharing review, denies drafts to donors and serves only exact approved bytes", async () => {
    const f = await planningFixture(); await publishFixture(f); const image = await alignedFixture(f), donor = await addActor(f.session, "donor");
    await assert.rejects(sharedAlignmentImage(donor, image.id, f.storage), errorCode("ALIGNMENT_IMAGE_UNAVAILABLE"));
    await assert.rejects(reviewPhotoAlignment(f.session, image.id, { intentId: randomUUID(), contentHash: image.contentHash, expectedRevision: image.revision, anchorsConfirmed: true, illustrativeOnlyConfirmed: true, sharedImageConfirmed: false }), errorCode("SHARED_IMAGE_REVIEW_REQUIRED"));
    await image.review(); const view = (await alignmentViews(donor))[0]; assert.equal(view.documentId, null); assert.deepEqual(view.redactions, []);
    assert.equal(bytesHash(await sharedAlignmentImage(donor, image.id, f.storage)), view.sharedPreviewHash);
    await assert.rejects(documentOriginal(donor, f.photo.id, f.storage), errorCode("DOCUMENT_NOT_FOUND"));
    const readiness = (await readPlanningWorkspace(donor)).readiness.find(p => p.packageId === "electronics")!;
    assert.equal(readiness.acceptedCount, 1); assert.equal(readiness.accepted, false); assert.equal(readiness.provenance, "sample");
  });
  it("cannot share a reviewers-only rendition and honors a later explicit withdrawal", async () => {
    const f = await planningFixture(); await publishFixture(f); const image = await alignedFixture(f, "electronics", "reviewers_only"), donor = await addActor(f.session, "donor");
    await image.review(); assert.deepEqual(await alignmentViews(donor), []);
    await assert.rejects(sharedAlignmentImage(donor, image.id, f.storage), errorCode("ALIGNMENT_IMAGE_UNAVAILABLE"));
    await revokePhotoAlignment(f.session, image.id, { intentId: randomUUID(), contentHash: image.contentHash, expectedRevision: image.revision, reason: "Controlled image withdrawal fixture" });
    await assert.rejects(sharedAlignmentImage(f.session, image.id, f.storage), errorCode("ALIGNMENT_IMAGE_UNAVAILABLE"));
    assert.equal((await readPlanningWorkspace(f.session)).readiness.find(p => p.packageId === "electronics")?.acceptedCount, 0);
  });
  it("rejects a source withdrawn while storage is loading, including the original-document path", async () => {
    const f = await planningFixture(); await publishFixture(f); const image = await alignedFixture(f); await image.review(); const donor = await addActor(f.session, "donor");
    let withdrawn = false;
    const slow = { ...f.storage, async read(path: string, max?: number) { const result = await f.storage.read(path, max); if (!withdrawn) { withdrawn = true; await setPlanningSourcePermission(f.session, f.photo.id, { intentId: randomUUID(), expectedVersion: 1, permission: "withdrawn", reason: "Withdrawal during a controlled slow image read" }); } return result; } };
    await assert.rejects(sharedAlignmentImage(donor, image.id, slow), errorCode("ALIGNMENT_IMAGE_UNAVAILABLE"));
    await setPlanningSourcePermission(f.session, f.photo.id, { intentId: randomUUID(), expectedVersion: 2, permission: "allowed", reason: "Controlled source restore for original route test" });
    const originalSlow = { ...f.storage, async read(path: string, max?: number) { const result = await f.storage.read(path, max); await setPlanningSourcePermission(f.session, f.photo.id, { intentId: randomUUID(), expectedVersion: 3, permission: "withdrawn", reason: "Withdrawal during a controlled original read" }); return result; } };
    await assert.rejects(documentOriginal(f.session, f.photo.id, originalSlow), errorCode("SOURCE_PERMISSION_WITHDRAWN"));
  });
  it("rejects invisible or foreign-package anchors and changed image bytes", async () => {
    const f = await planningFixture(), plan = await publishFixture(f), zone = plan.payload.plan.zones.find(z => z.packageId === "electronics")!;
    const anchors = [{ x: .2, y: .2 }, { x: .8, y: .2 }, { x: .2, y: .8 }].map((photo, i) => ({ photo, plan: zone.polygon[[0, 1, 3][i]] }));
    const input = { intentId: randomUUID(), planId: plan.row.id, expectedPlanHash: plan.row.content_hash, packageId: "electronics", documentId: f.photo.id, sourcePage: 1, imageSharing: "project_members" as const, displayCrop: { x: 0, y: 0, width: 1, height: 1 }, redactions: [{ x: .1, y: .1, width: .2, height: .2 }], anchors, note: "Controlled redacted landmark test" };
    await assert.rejects(savePhotoAlignment(f.session, input, f.storage), errorCode("ANCHOR_REDACTED"));
    await assert.rejects(savePhotoAlignment(f.session, { ...input, redactions: [], anchors: anchors.map(a => ({ ...a, plan: { x: .01, y: .01 } })) }, f.storage), errorCode("ANCHOR_OUTSIDE_PACKAGE"));
    const image = await alignedFixture(f); await image.review();
    const altered = { ...f.storage, async read(path: string, max?: number) { const read = await f.storage.read(path, max); return { ...read, bytes: Buffer.concat([read.bytes, Buffer.from("tampered")]) }; } };
    await assert.rejects(sharedAlignmentImage(f.session, image.id, altered), errorCode("ALIGNMENT_IMAGE_INTEGRITY"));
  });
});

describe("bounded reviewer authority and separate physical requirements", () => {
  it("does not allow self-verification of submitted real credential sources", async () => {
    const f = await planningFixture("live_sandbox"), request = await requestReviewerQualification(f.session, { intentId: randomUUID(), scope: "equipment_setup", documentId: f.credential.id,
      displayName: "Controlled test subject", basis: "Synthetic evidence to test the prohibition on self-verification.", validUntil: new Date(Date.now() + 86400_000).toISOString(), sampleAcknowledged: false });
    await assert.rejects(reviewReviewerQualification(f.session, request.id, { intentId: randomUUID(), expectedVersion: 1, decision: "verified", note: "A controlled attempted self-verification fixture", evidenceChecked: true, sampleAcknowledged: false }), errorCode("INDEPENDENT_QUALIFICATION_REVIEW"));
  });
  it("requires the actor's exact scope and a separate inspection record, then invalidates superseded credentials", async () => {
    const f = await planningFixture("live_sandbox"); await publishFixture(f); const actor = await addActor(f.session), qualification = await qualificationFixture(f, actor, "equipment_setup");
    const input = await signoffInput(f, actor, qualification, "electronics", [qualification.documentId!]);
    await assert.rejects(recordWorkSignoff(actor, input), errorCode("INSPECTION_DOCUMENT_REQUIRED"));
    const inspection = await uploadFixture(actor, f.storage, "signoff"); input.documentIds = [inspection.id];
    await assert.rejects(recordWorkSignoff(f.session, { ...input, intentId: randomUUID() }), errorCode("SIGNOFF_AUTHORITY"));
    const saved = await recordWorkSignoff(actor, input); assert.equal((await signoffViews(actor)).find(s => s.id === saved.id)?.current, true);
    assert.equal((await readPlanningWorkspace(actor)).readiness.find(p => p.packageId === "electronics")?.accepted, false, "A scoped signoff still needs a separate image association");
    await reviewReviewerQualification(f.session, qualification.id, { intentId: randomUUID(), expectedVersion: 2, decision: "revoked", note: "Controlled scope withdrawal after a signoff fixture", evidenceChecked: true, sampleAcknowledged: false });
    assert.equal((await signoffViews(actor)).find(s => s.id === saved.id)?.current, false);
    await assert.rejects(recordWorkSignoff(actor, { ...input, intentId: randomUUID() }), errorCode("SIGNOFF_AUTHORITY"));
  });
  it("requires ventilation and electrical acceptance before the laser prerequisite is satisfied", async () => {
    const f = await planningFixture(); const plan = await publishFixture(f); const image = await alignedFixture(f, "safety"); await image.review();
    for (const scope of ["ventilation", "electrical_safety"] as const) {
      const qualification = await qualificationFixture(f, f.session, scope, true);
      await recordWorkSignoff(f.session, await signoffInput(f, f.session, qualification, "safety", [f.credential.id]));
      const current = await readPlanningWorkspace(f.session), laser = current.readiness.find(p => p.packageId === "laser")!;
      assert.equal(laser.prerequisitesMet, scope === "electrical_safety");
      assert.equal(laser.accepted, false); assert.equal(laser.providerLiquidity, "not_checked");
    }
    const current = await readPlanningWorkspace(f.session); assert.equal(current.readiness.find(p => p.packageId === "safety")?.provenance, "sample");
    plan.payload.plan.dependencies.push({ packageId: "safety", prerequisiteId: "woodworking", kind: "accepted_work", reason: "Controlled transitive prerequisite test", citationId: null });
    const transitive = packageReadiness(plan.payload, true, await alignmentViews(f.session), await signoffViews(f.session), []);
    assert.equal(transitive.find(p => p.packageId === "safety")?.prerequisitesMet, false); assert.equal(transitive.find(p => p.packageId === "laser")?.prerequisitesMet, false);
  });
  it("retains the latest decision, expires credentials and clears acceptance when the shared plan is withdrawn", async () => {
    const f = await planningFixture(); await publishFixture(f); const qualification = await qualificationFixture(f, f.session, "equipment_setup", true), input = await signoffInput(f, f.session, qualification, "electronics", [f.credential.id]);
    const first = await recordWorkSignoff(f.session, input); await recordWorkSignoff(f.session, { ...input, intentId: randomUUID(), decision: "needs_information" });
    const decisions = await signoffViews(f.session); assert.equal(decisions.find(s => s.id === first.id)?.current, false); assert.ok(decisions.find(s => s.current)?.decision === "needs_information");
    await query("UPDATE fp_reviewer_qualifications SET valid_until=now()-interval '1 second' WHERE id=$1", [qualification.id]);
    assert.equal((await qualificationViews(f.session)).find(q => q.id === qualification.id)?.state, "expired");
    assert.ok((await signoffViews(f.session)).every(s => !s.current));
    const workspace = await readPlanningWorkspace(f.session);
    await revokePublishedPlan(f.session, { intentId: randomUUID(), expectedVersion: workspace.headVersion, publicationId: workspace.published!.publicationId, reason: "Controlled plan withdrawal fixture" });
    assert.ok((await readPlanningWorkspace(f.session)).readiness.every(p => p.acceptedCount === 0 && !p.planningReady));
  });
});

describe("one-use reviewer access and Studio provenance", () => {
  it("retains secrets encrypted, restricts the invitation scope, and revokes its session and dependent reviews", async () => {
    const f = await planningFixture("live_sandbox"); await publishFixture(f);
    const input = { intentId: randomUUID(), label: "Controlled independent actor fixture", scopes: ["electrical_safety" as const], expiresHours: 1, acknowledged: true as const };
    const invite = await createReviewerInvite(f.session, input); assert.equal((await createReviewerInvite(f.session, input)).token, invite.token);
    assert.equal(JSON.stringify(await reviewerAccessViews(f.session)).includes(invite.token), false);
    const actions = await query("SELECT result,encrypted_input FROM fp_planning_actions WHERE project_id=$1", [f.session.projectId]); assert.equal(JSON.stringify(actions).includes(invite.token), false);
    const redemption = { token: invite.token, redemptionNonce: randomUUID(), acknowledged: true as const };
    await assert.rejects(redeemReviewerInvite(redemption, f.session), errorCode("INDEPENDENT_REVIEWER_REQUIRED"));
    const joined = await redeemReviewerInvite(redemption, null), replay = await redeemReviewerInvite(redemption, null);
    assert.equal(joined.sessionToken, replay.sessionToken); assert.deepEqual(await permittedReviewerScopes(joined.session), ["electrical_safety"]);
    assert.deepEqual((await readPlanningWorkspace(joined.session)).allowedRoles, ["volunteer"]);
    await assert.rejects(redeemReviewerInvite({ ...redemption, redemptionNonce: randomUUID() }, null), errorCode("REVIEWER_INVITE_USED"));
    const credential = await uploadFixture(joined.session, f.storage, "signoff");
    await assert.rejects(requestReviewerQualification(joined.session, { intentId: randomUUID(), scope: "laser_safety", documentId: credential.id, displayName: "Controlled fixture reviewer", basis: "Synthetic scope escalation attempt for an isolated test.", validUntil: new Date(Date.now() + 86400_000).toISOString(), sampleAcknowledged: false }), errorCode("REVIEWER_SCOPE_DENIED"));
    const qualification = await qualificationFixture(f, joined.session, "electrical_safety"); const inspection = await uploadFixture(joined.session, f.storage, "signoff");
    await recordWorkSignoff(joined.session, await signoffInput(f, joined.session, qualification, "safety", [inspection.id]));
    await revokeReviewerInvite(f.session, invite.id, { intentId: randomUUID(), expectedVersion: 2, reason: "Controlled temporary reviewer-access revocation" });
    await assert.rejects(readPlanningWorkspace(joined.session));
    assert.ok((await signoffViews(f.session)).every(s => !s.current));
    await assert.rejects(redeemReviewerInvite(redemption, null), errorCode("REVIEWER_INVITE_UNAVAILABLE"));
  });
  it("cannot redeem an expired link or a link whose issuer lost authority", async () => {
    const f = await planningFixture(), input = { intentId: randomUUID(), label: "Controlled expiry test", scopes: ["equipment_setup" as const], expiresHours: 1, acknowledged: true as const };
    const expired = await createReviewerInvite(f.session, input); await query("UPDATE fp_reviewer_invites SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
    await assert.rejects(redeemReviewerInvite({ token: expired.token, redemptionNonce: randomUUID(), acknowledged: true }, null), errorCode("REVIEWER_INVITE_UNAVAILABLE"));
    const changed = await createReviewerInvite(f.session, { ...input, intentId: randomUUID() }); await query("UPDATE fp_memberships SET version=version+1 WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [f.session.tenantId, f.session.projectId, f.session.actorId]);
    await assert.rejects(redeemReviewerInvite({ token: changed.token, redemptionNonce: randomUUID(), acknowledged: true }, null), errorCode("REVIEWER_INVITE_AUTHORITY"));
  });
  it("projects reviewed geometry and current physical counts into Studio without changing money or disclosing sources", async () => {
    const f = await planningFixture(), before = await readStudioSnapshot(f.session), plan = await publishFixture(f), image = await alignedFixture(f); await image.review();
    const qualification = await qualificationFixture(f, f.session, "equipment_setup", true); await recordWorkSignoff(f.session, await signoffInput(f, f.session, qualification, "electronics", [f.credential.id]));
    const studio = await readStudioSnapshot(f.session), row = studio.data.packages.find(p => p.id === "electronics")!, prior = before.data.packages.find(p => p.id === "electronics")!;
    assert.equal(studio.geometrySource?.planHash, plan.row.content_hash); assert.equal(row.reviewedItemCount, row.requiredItemCount); assert.equal(row.workState, "sample_review_complete");
    assert.deepEqual(studio.geometry[row.geometryRef].points, plan.view.zones.find(z => z.packageId === row.id)?.polygon);
    for (const field of ["collectedMinor", "fundingEligibleMinor", "approvedExpenseMinor", "paidExpenseMinor", "allocationReservedMinor"] as const) assert.equal(row[field], prior[field]);
    const materialized = await materializeStudioDataset(f.session); assert.equal((await requireStudioDataset(f.session, materialized.datasetHandle)).geometrySource?.planHash, plan.row.content_hash);
    const donor = await addActor(f.session, "donor"), publicView = JSON.stringify(await readStudioSnapshot(donor)); assert.equal(publicView.includes(f.photo.id), false); assert.equal(publicView.includes(f.credential.id), false); assert.equal(publicView.includes("Synthetic credential"), false);
    await setPlanningSourcePermission(f.session, f.sketch.id, { intentId: randomUUID(), expectedVersion: 1, permission: "withdrawn", reason: "Controlled Studio source withdrawal fixture" });
    const stale = await readStudioSnapshot(donor); assert.deepEqual(stale.geometry, {}); assert.equal(stale.geometrySource?.state, "stale"); assert.ok(stale.data.packages.every(p => p.reviewedItemCount === 0));
    assert.ok(stale.data.exceptions.some(e => e.category === "plan_review"));
  });
});
