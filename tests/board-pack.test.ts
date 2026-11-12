import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "@fracture/paypal-core";
import type { Session } from "../lib/server/auth";
import { database, query } from "../lib/server/db";
import { assertBoardPackContext, captureBoardPack, exportBoardPack, readBoardPack, readBoardPackDesk, readBoardPackImage, readBoardPackSource } from "../lib/server/board-packs";
import { boardPackSourceId } from "../lib/reports/board-pack-contracts";
import { alignedFixture, bytesHash, errorCode, isolatedPlanningDatabase, publishFixture, qualificationFixture } from "./helpers/planning";
import { communityFixture } from "./helpers/community";
import { projectFingerprint, storyCase, storyChoice, storyFixture, storyPlanning, storyPolicy, storyReceipt } from "./helpers/supporter-story";
import { setPlanningSourcePermission } from "../lib/server/planning-sources";
import { recordWorkSignoff } from "../lib/server/planning-evidence";
import { createProofDerivative, createProofDraft, decideProofSnapshot, readProofDesk, reviewProofDerivative, revokeProofDerivative } from "../lib/server/proof";
import { boardPackExpenseFixture } from "./helpers/board-pack";
import { createPurposePledge, settleSamplePurposePledge } from "../lib/server/purpose-pledges";
import { acceptSponsorOffer, createSponsorOffer } from "../lib/server/sponsors";
import { fundingDesk } from "../lib/server/funding-lifecycle";

isolatedPlanningDatabase();
async function capture(session: Session, label = "Controlled Sample Board Pack") {
  const desk = await readBoardPackDesk(session);
  await assertBoardPackContext(session, desk.scope);
  const input = { intentId: randomUUID(), label, expectedProjectionVersion: desk.projectionVersion };
  const view = await captureBoardPack(session, input);
  assert.ok(view.report);
  return { input, view, report: view.report, desk };
}
const business = (fingerprint: Record<string, string>) => Object.fromEntries(Object.entries(fingerprint).filter(([name]) => !name.startsWith("fp_board_pack")));

describe("fixed-cutoff Board Packs and exact audience scope", () => {
  it("preserves 500c original credit, 200c returned and 300c assigned without reviving paid promises", async () => {
    const f = await storyFixture();
    const receipts = [];
    for (const amount of [200, 100, 100, 100]) receipts.push(await storyReceipt(f, f.donors[0], "electronics", amount));
    const materials = await storyPolicy(f, "materials"), wood = await storyPolicy(f, "woodworking"), cancelled = await storyCase(f, "electronics");
    await storyChoice(f, f.donors[0], receipts[0], cancelled, null);
    for (const [index, target] of [[1, materials], [2, materials], [3, wood]] as const) await storyChoice(f, f.donors[0], receipts[index], cancelled, target);
    const before = business(await projectFingerprint(f.projectId));
    const { report, view } = await capture(f.organizer);
    assert.equal(view.status, "current");
    assert.equal(report.data.settlements.length, 4);
    assert.equal(report.totals.receipts.grossMinor, 500);
    assert.equal(report.totals.receipts.creditedMinor, 500);
    assert.equal(report.totals.receipts.returnedMinor, 200);
    assert.equal(report.totals.positions.collectedMinor, 300);
    assert.equal(report.totals.project.currentCollectedMinor, 300);
    assert.equal(report.totals.project.unpaidCommitmentMinor, 0);
    assert.equal(report.assignments.length, 3);
    assert.equal(report.assignments.reduce((sum, item) => sum + item.amountMinor, 0), 300);
    for (const [id, expected] of [["electronics", 0], ["materials", 200], ["woodworking", 100]] as const) {
      assert.equal(report.data.funding_positions!.filter(p => p.packageId === id).reduce((sum, p) => sum + p.collectedMinor, 0), expected);
    }
    assert.equal(report.packages.find(p => p.packageId === "electronics")?.lifecycleState, "cancelled");
    assert.equal(report.reviewedImages.length, 0);
    const detail = await readBoardPackSource(f.organizer, report.id, boardPackSourceId("receipt", receipts[0].id));
    assert.equal(detail.contentHash, report.contentHash);
    assert.equal(detail.asOf, report.asOf);
    assert.ok(detail.fields.some(field => field.value === "USD 2.00"));
    await exportBoardPack(f.organizer, report.id);
    assert.deepEqual(business(await projectFingerprint(f.projectId)), before);
  });

  it("separates project totals from donor-owned Orders and Invoice details and rejects cross-actor captures", async () => {
    const f = await storyFixture(), own = await storyReceipt(f, f.donors[0], "electronics", 100), other = await storyReceipt(f, f.donors[1], "materials", 35, true);
    const a = await capture(f.donors[0]), b = await capture(f.donors[1]), volunteer = await capture(f.volunteer), audit = await capture(f.auditor);
    assert.equal(a.report.totals.project.currentCollectedMinor, 135);
    assert.equal(a.report.totals.receipts.scope, "own_contributions");
    assert.equal(a.report.totals.receipts.grossMinor, 100);
    assert.deepEqual(a.report.data.settlements.map(row => row.id), [own.id]);
    assert.deepEqual(b.report.data.settlements.map(row => row.id), [other.id]);
    assert.equal(b.report.totals.receipts.invoiceGrossMinor, 35);
    assert.equal(volunteer.report.data.settlements.length, 0);
    assert.equal(volunteer.report.totals.project.currentCollectedMinor, 135);
    assert.equal(audit.report.data.settlements.length, 2);
    const serialized = canonicalJson(a.report);
    for (const value of [other.id, other.donorObligationId, other.actualProviderPaymentRef, f.donors[1].actorId, "Private fixture label", "encrypted_data", "pathname"]) assert.equal(serialized.includes(value), false, value);
    await assert.rejects(readBoardPack(f.donors[1], a.report.id), errorCode("BOARD_PACK_UNAVAILABLE"));
    await assert.rejects(readBoardPackSource(f.donors[0], a.report.id, boardPackSourceId("receipt", other.id)), errorCode("BOARD_PACK_SOURCE_UNAVAILABLE"));
    await assert.rejects(assertBoardPackContext(f.donors[1], a.desk.scope), errorCode("BOARD_PACK_CONTEXT_CHANGED"));
    const foreign = await storyFixture();
    await assert.rejects(readBoardPack(foreign.organizer, a.report.id), errorCode("BOARD_PACK_UNAVAILABLE"));
  });

  it("retains one original capture through a retry, marks later changes historical, and never mutates its audit", async () => {
    const f = await storyFixture(), saved = await capture(f.organizer, "Private immutable label =formula");
    await query("UPDATE fp_projects SET projection_version=projection_version+1 WHERE id=$1", [f.projectId]);
    const retry = await captureBoardPack(f.organizer, saved.input);
    assert.equal(retry.summary.id, saved.report.id);
    assert.equal(retry.status, "historical");
    assert.deepEqual(retry.report, saved.report);
    assert.equal((await readBoardPackDesk(f.organizer)).history.length, 1);
    await assert.rejects(captureBoardPack(f.organizer, { ...saved.input, label: "changed label" }), errorCode("BOARD_PACK_INTENT_CHANGED"));
    await assert.rejects(captureBoardPack(f.organizer, { ...saved.input, intentId: randomUUID() }), errorCode("BOARD_PACK_PROJECT_CHANGED"));
    const [row] = await query<{ encrypted_data: string; content_hash: string }>("SELECT encrypted_data,content_hash FROM fp_board_packs WHERE id=$1", [saved.report.id]);
    assert.equal(row.encrypted_data.includes(saved.report.label), false);
    assert.equal(row.content_hash, saved.report.contentHash);
    await assert.rejects(query("UPDATE fp_board_packs SET content_hash='changed' WHERE id=$1", [saved.report.id]), error => (error as { code: string }).code === "23514");
    await assert.rejects(query("DELETE FROM fp_board_pack_audit WHERE report_id=$1", [saved.report.id]), error => (error as { code: string }).code === "23514");
    assert.equal((await query<{ count: string }>("SELECT count(*) FROM fp_board_pack_audit WHERE report_id=$1", [saved.report.id]))[0].count, "1");
    await query("UPDATE fp_memberships SET state='revoked',version=version+1 WHERE project_id=$1 AND actor_id=$2", [f.projectId, f.organizer.actorId]);
    await assert.rejects(readBoardPack(f.organizer, saved.report.id), errorCode("MEMBERSHIP_DENIED"));
  });

  it("uses each template's own packages and preserves an honest empty report", async () => {
    for (const template of ["makerspace", "community-garden", "mutual-aid"] as const) {
      const f = await communityFixture(template), { report } = await capture(f.session);
      assert.equal(report.project.templateId, template);
      assert.equal(report.project.title, f.createInput.title);
      assert.equal(report.data.settlements.length, 0);
      assert.equal(report.assignments.length, 0);
      assert.equal(report.expenses.length, 0);
      assert.equal(report.balance.state, "not_recorded");
      assert.equal(report.totals.project.currentCollectedMinor, 0);
      assert.ok(report.packages.length > 0);
      assert.ok(report.packages.every(p => p.requirements.length === 0 && p.blockers.length > 0));
      assert.ok(report.notices.some(note => note.includes("fictional")));
      assert.equal((await exportBoardPack(f.session, report.id)).csv.startsWith("\ufeff"), true);
    }
  });

  it("deduplicates concurrent capture requests and recovers the same report from the original intent", async () => {
    const f = await storyFixture(), desk = await readBoardPackDesk(f.organizer), input = { intentId: randomUUID(), label: "Concurrent controlled capture", expectedProjectionVersion: desk.projectionVersion };
    const attempts = await Promise.allSettled([captureBoardPack(f.organizer, input), captureBoardPack(f.organizer, input)]);
    const successful = attempts.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof captureBoardPack>>> => item.status === "fulfilled");
    assert.ok(successful.length >= 1);
    for (const item of attempts) if (item.status === "rejected") assert.equal(item.reason.code, "BOARD_PACK_CAPTURE_BUSY");
    const retried = await captureBoardPack(f.organizer, input);
    assert.ok(successful.every(item => item.value.summary.id === retried.summary.id));
    assert.equal((await readBoardPackDesk(f.organizer)).history.length, 1);
    assert.equal((await query<{ count: string }>("SELECT count(*) FROM fp_board_pack_audit WHERE project_id=$1", [f.projectId]))[0].count, "1");
  });

  it("does not save or disclose a report if the original session expires while waiting for a membership lock", async () => {
    const f = await storyFixture(new Date(Date.now() + 2000).toISOString());
    const desk = await readBoardPackDesk(f.organizer);
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const blocker = database().transaction(async tx => {
      await tx.query("SELECT actor_id FROM fp_memberships WHERE project_id=$1 AND actor_id=$2 FOR UPDATE", [f.projectId, f.organizer.actorId]);
      locked(); await gate;
    });
    await ready;
    const attempt = captureBoardPack(f.organizer, { intentId: randomUUID(), label: "Must not survive original expiry", expectedProjectionVersion: desk.projectionVersion });
    const denied = assert.rejects(attempt, error => ["ROLE_DENIED", "MEMBERSHIP_DENIED"].includes((error as { code: string }).code));
    await new Promise(resolve => setTimeout(resolve, 2100)); release(); await blocker; await denied;
    assert.equal((await query<{ count: string }>("SELECT count(*) FROM fp_board_packs WHERE project_id=$1", [f.projectId]))[0].count, "0");
    assert.equal((await query<{ count: string }>("SELECT count(*) FROM fp_board_pack_audit WHERE project_id=$1", [f.projectId]))[0].count, "0");
  });

  it("binds reviewed printable images and hides the whole old report after source permission is withdrawn", async () => {
    const f = await storyFixture(), plan = await storyPlanning(f);
    await publishFixture(plan);
    const image = await alignedFixture(plan); await image.review();
    const saved = await capture(f.donors[0]);
    assert.equal(saved.report.reviewedImages.length, 1);
    const descriptor = saved.report.reviewedImages[0];
    assert.equal(bytesHash(await readBoardPackImage(f.donors[0], saved.report.id, descriptor.sourceId, f.storage)), descriptor.contentHash);
    const detail = await readBoardPackSource(f.donors[0], saved.report.id, descriptor.sourceId);
    assert.ok(detail.image?.url.startsWith(`/api/board-packs/${saved.report.id}/sources/`));
    for (const privateValue of [plan.photo.id, "pathname", "Controlled image-association fixture"]) assert.equal(canonicalJson(saved.report).includes(privateValue), false);
    await setPlanningSourcePermission(f.organizer, plan.photo.id, { intentId: randomUUID(), expectedVersion: 1, permission: "withdrawn", reason: "Controlled report source-permission withdrawal." });
    const hidden = await readBoardPack(f.donors[0], saved.report.id);
    assert.equal(hidden.status, "withdrawn"); assert.equal(hidden.report, null); assert.equal(hidden.canPrint, false); assert.equal(hidden.canExport, false);
    await assert.rejects(exportBoardPack(f.donors[0], saved.report.id), errorCode("BOARD_PACK_SOURCE_WITHDRAWN"));
    await assert.rejects(readBoardPackImage(f.donors[0], saved.report.id, descriptor.sourceId, f.storage), errorCode("BOARD_PACK_SOURCE_WITHDRAWN"));
    assert.equal((await readBoardPackDesk(f.donors[0])).history[0].contentHash, saved.report.contentHash);
  });

  it("does not put a reviewers-only image into a supporter's saved report", async () => {
    const f = await storyFixture(), plan = await storyPlanning(f); await publishFixture(plan);
    const image = await alignedFixture(plan, "electronics", "reviewers_only"); await image.review();
    const donor = await capture(f.donors[0]), organizer = await capture(f.organizer);
    assert.equal(donor.report.reviewedImages.length, 0); assert.equal(organizer.report.reviewedImages.length, 1);
    const donorImageSource = donor.report.sources.find(s => s.id === boardPackSourceId("evidence", `planning-photo:${image.id}`));
    assert.ok(donorImageSource);
    assert.equal((await readBoardPackSource(f.donors[0], donor.report.id, donorImageSource.id)).image, null);
  });

  it("rechecks image permission after slow storage and never sends the already-read private bytes", async () => {
    const f = await storyFixture(), plan = await storyPlanning(f); await publishFixture(plan);
    const image = await alignedFixture(plan); await image.review();
    const saved = await capture(f.donors[0]); let changed = false;
    const gated = { ...f.storage, async read(pathname: string, maxBytes?: number) {
      const value = await f.storage.read(pathname, maxBytes);
      if (!changed) { changed = true; await setPlanningSourcePermission(f.organizer, plan.photo.id, { intentId: randomUUID(), expectedVersion: 1, permission: "withdrawn", reason: "Controlled withdrawal while image bytes were loading." }); }
      return value;
    } };
    await assert.rejects(readBoardPackImage(f.donors[0], saved.report.id, saved.report.reviewedImages[0].sourceId, gated), error => ["ALIGNMENT_IMAGE_UNAVAILABLE", "BOARD_PACK_SOURCE_WITHDRAWN"].includes((error as { code: string }).code));
    assert.equal(changed, true);
  });

  it("reuses the exact public edition guards when a captured redacted derivative is revoked", async () => {
    const f = await storyFixture(), plan = await storyPlanning(f); await publishFixture(plan);
    const made = await createProofDerivative(f.organizer, { intentId: randomUUID(), documentId: plan.photo.id, page: 1, packageId: "electronics", crop: { x: 0, y: 0, width: 1, height: 1 }, masks: [{ x: .1, y: .1, width: .2, height: .2 }] }, f.storage);
    let desk = await readProofDesk(f.organizer); const image = desk.derivatives.find(row => row.id === made.id)!;
    await reviewProofDerivative(f.organizer, image.id, { intentId: randomUUID(), contentHash: image.contentHash, expectedVersion: image.reviewVersion, privacyChecked: true, publicSharingConfirmed: true });
    desk = await readProofDesk(f.organizer);
    const draft = await createProofDraft(f.organizer, { intentId: randomUUID(), packageId: "electronics", expectedVersion: desk.packages.find(row => row.id === "electronics")!.headVersion, derivativeIds: [image.id] });
    for (const step of ["review", "publish"] as const) { desk = await readProofDesk(f.organizer); const snapshot = desk.snapshots.find(row => row.id === draft.id)!; await decideProofSnapshot(f.organizer, step, { intentId: randomUUID(), snapshotId: draft.id, expectedVersion: desk.packages.find(row => row.id === "electronics")!.headVersion, contentHash: snapshot.contentHash, acknowledged: true }); }
    const saved = await capture(f.donors[0]), descriptor = saved.report.reviewedImages.find(row => row.sourceId.includes(`proof:${draft.id}:`))!;
    assert.ok(descriptor); assert.equal(bytesHash(await readBoardPackImage(f.donors[0], saved.report.id, descriptor.sourceId, f.storage)), image.contentHash);
    await revokeProofDerivative(f.organizer, image.id, randomUUID());
    assert.equal((await readBoardPack(f.donors[0], saved.report.id)).report, null);
    await assert.rejects(readBoardPackSource(f.donors[0], saved.report.id, descriptor.sourceId), errorCode("BOARD_PACK_SOURCE_WITHDRAWN"));
  });

  it("binds private inspection and credential sources before retaining scoped signoff detail", async () => {
    const f = await storyFixture(), plan = await storyPlanning(f), publication = await publishFixture(plan);
    const requirement = publication.payload.plan.packages.find(p => p.packageId === "electronics")!.requirements.find(r => r.scope)!;
    const qualification = await qualificationFixture(plan, f.organizer, requirement.scope!, true);
    const savedSignoff = await recordWorkSignoff(f.organizer, { intentId: randomUUID(), planId: publication.row.id, expectedPlanHash: publication.row.content_hash, packageId: "electronics", requirementId: requirement.id, qualificationId: qualification.id, qualificationVersion: qualification.version, documentIds: [plan.credential.id], decision: "accepted", observedAt: new Date().toISOString(), statement: "Private controlled inspection statement canary.", limitations: "Synthetic scope only; no actual installed work is established.", scopeConfirmed: true, sampleAcknowledged: true });
    const saved = await capture(f.organizer);
    const detail = await readBoardPackSource(f.organizer, saved.report.id, boardPackSourceId("evidence", `planning-signoff:${savedSignoff.id}`));
    assert.ok(canonicalJson(detail).includes("Private controlled inspection statement canary."));
    await setPlanningSourcePermission(f.organizer, plan.credential.id, { intentId: randomUUID(), expectedVersion: 1, permission: "withdrawn", reason: "Controlled inspection and qualification source withdrawal." });
    assert.equal((await readBoardPack(f.organizer, saved.report.id)).report, null);
    const current = await capture(f.organizer);
    const historical = await readBoardPackSource(f.organizer, current.report.id, boardPackSourceId("evidence", `planning-signoff:${savedSignoff.id}`));
    assert.equal(canonicalJson(historical).includes("Private controlled inspection statement canary."), false);
    assert.equal(canonicalJson(historical).includes("Controlled test reviewer"), false);
  });

  it("keeps approved expense, delivered principal, paid fee, reserved allowance and earlier balance evidence separate", async () => {
    const f = await storyFixture(), source = await boardPackExpenseFixture(f);
    const organizer = await capture(f.organizer), audit = await capture(f.auditor), claimant = await capture(f.volunteer), donor = await capture(f.donors[0]);
    const totals = organizer.report.totals.project;
    assert.equal(totals.approvedExpenseMinor, 3050); assert.equal(totals.deliveredPrincipalMinor, 1800);
    assert.equal(totals.paidFeeMinor, 25); assert.equal(totals.reservedFeeMinor, 75);
    assert.equal(totals.paidMinor, 1825); assert.equal(totals.reservedMinor, 1325);
    assert.equal(organizer.report.expenses[0].repayments.length, 2);
    assert.equal(organizer.report.balance.observedAt, source.earlier);
    assert.equal(organizer.report.balance.availableMinor, 500000);
    assert.notEqual(organizer.report.balance.observedAt, organizer.report.asOf);
    assert.equal(claimant.report.expenses[0].title, source.canaries[2]);
    assert.equal(audit.report.expenses[0].title, "Reviewed expense"); assert.equal(audit.report.expenses[0].claimId, null);
    assert.equal(donor.report.expenses.length, 0); assert.equal(donor.report.balance.availableMinor, null);
    for (const view of [organizer, audit, claimant, donor]) for (const value of source.canaries.slice(0, 2)) assert.equal(canonicalJson(view.report).includes(value), false);
    for (const view of [audit, donor]) for (const value of source.canaries.slice(2)) assert.equal(canonicalJson(view.report).includes(value), false);
    // Receipt originals are not a planning-permission action. Model a stored
    // original becoming unavailable; no public financial history is rewritten.
    await query("UPDATE fp_documents SET state='failed',version=version+1 WHERE id=$1 AND project_id=$2", [source.document.id, f.projectId]);
    assert.equal((await readBoardPack(f.organizer, organizer.report.id)).report, null);
    const current = await capture(f.organizer); for (const value of source.canaries.slice(2)) assert.equal(canonicalJson(current.report).includes(value), false);
  });

  it("treats accepted sponsor promises as an unpaid subset and never subtracts moved credit from a pledge", async () => {
    const f = await storyFixture(), target = await storyPolicy(f, "materials");
    const made = await createPurposePledge(f.donors[0], { intentId: randomUUID(), policyId: target.id, policyDigest: target.digest, amountMinor: 250, acknowledged: true });
    const offered = await createSponsorOffer(f.organizer, { intentId: randomUUID(), kind: "grant", name: "Controlled Sample grant", note: "Fictional promise only; no money has moved.", totalCapMinor: 100, matchBasisPoints: 10000, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), packages: [{ policyId: target.id, policyDigest: target.digest, capMinor: 100 }], acknowledged: true });
    const offer = (await fundingDesk(f.organizer)).sponsors.find(row => row.id === offered.id)!;
    await acceptSponsorOffer(f.donors[1], { intentId: randomUUID(), offerId: offer.id, digest: offer.digest, expectedVersion: offer.version, acknowledged: true });
    const before = await capture(f.organizer);
    assert.equal(before.report.totals.project.unpaidCommitmentMinor, 350);
    assert.equal(before.report.totals.project.acceptedSponsorUnpaidMinor, 100);
    assert.equal(before.report.totals.project.currentCollectedMinor, 0);
    const pledge = (await fundingDesk(f.donors[0])).pledges.find(row => row.id === made.id)!;
    await settleSamplePurposePledge(f.donors[0], { intentId: randomUUID(), pledgeId: pledge.id, digest: pledge.digest, expectedVersion: pledge.version });
    const after = await capture(f.organizer);
    assert.equal(after.report.totals.project.unpaidCommitmentMinor, 100); assert.equal(after.report.totals.project.currentCollectedMinor, 250);
    assert.equal(after.report.totals.project.acceptedSponsorUnpaidMinor, 100);
    const original = await readBoardPack(f.organizer, before.report.id); assert.equal(original.status, "historical"); assert.equal(original.report?.totals.project.currentCollectedMinor, 0);
    const exported = await exportBoardPack(f.organizer, after.report.id); assert.ok(exported.csv.includes("Sponsor"));
  });
});
