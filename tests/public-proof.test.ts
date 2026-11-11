import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { addActor, bytesHash, errorCode, isolatedPlanningDatabase, planningFixture, publishFixture, type PlanningFixture } from "./helpers/planning";
import { createProofDerivative, createProofDraft, decideProofSnapshot, privateProofImage, publicProofImage, readProofDesk, readPublicProof, reviewProofDerivative, revokeProofDerivative, withdrawProof } from "../lib/server/proof";
import { renderProofImage } from "../lib/server/proof-images";
import { query } from "../lib/server/db";
import { advanceTour } from "../lib/server/repository";
import { setPlanningSourcePermission } from "../lib/server/planning-sources";
import type { ProofSnapshotView } from "../lib/proof/contracts";

isolatedPlanningDatabase();
const imageInput = (f: PlanningFixture) => ({ intentId: randomUUID(), documentId: f.photo.id, page: 1, packageId: "electronics", crop: { x: 0, y: 0, width: 1, height: 1 }, masks: [{ x: .1, y: .1, width: .25, height: .2 }] });
async function reviewedImage(f: PlanningFixture) {
  const saved = await createProofDerivative(f.session, imageInput(f), f.storage);
  const image = (await readProofDesk(f.session)).derivatives.find(d => d.id === saved.id)!;
  await reviewProofDerivative(f.session, image.id, { intentId: randomUUID(), contentHash: image.contentHash, expectedVersion: image.reviewVersion, privacyChecked: true, publicSharingConfirmed: true });
  return image;
}
async function draft(f: PlanningFixture, derivativeIds: string[] = []) {
  const desk = await readProofDesk(f.session), pkg = desk.packages.find(p => p.id === "electronics")!;
  const saved = await createProofDraft(f.session, { intentId: randomUUID(), packageId: pkg.id, expectedVersion: pkg.headVersion, derivativeIds });
  return (await readProofDesk(f.session)).snapshots.find(s => s.id === saved.id)!;
}
async function decision(f: PlanningFixture, snapshot: ProofSnapshotView, next: "review" | "publish") {
  const desk = await readProofDesk(f.session), pkg = desk.packages.find(p => p.id === "electronics")!;
  return decideProofSnapshot(f.session, next, { intentId: randomUUID(), snapshotId: snapshot.id, expectedVersion: pkg.headVersion, contentHash: snapshot.contentHash, acknowledged: true });
}
async function publish(f: PlanningFixture, derivativeIds: string[] = []) {
  const snapshot = await draft(f, derivativeIds); await decision(f, snapshot, "review");
  return { ...await decision(f, snapshot, "publish"), snapshot };
}

describe("public proof authority and immutable reviewed projections", () => {
  it("keeps a draft private and requires a separate exact review before publication", async () => {
    const f = await planningFixture(), snapshot = await draft(f), slug = (await readProofDesk(f.session)).packages.find(p => p.id === "electronics")!.slug!;
    assert.equal((await readPublicProof(slug)).state, "unavailable");
    await assert.rejects(decision(f, snapshot, "publish"), errorCode("PROOF_REVIEW_REQUIRED"));
    await decision(f, snapshot, "review"); assert.equal((await readPublicProof(slug)).state, "unavailable");
    await decision(f, snapshot, "publish");
    const result = await readPublicProof(slug); assert.equal(result.snapshot?.contentHash, snapshot.contentHash); assert.equal(result.state, "published");
  });
  it("publishes canonical all-rail totals without donor identities, private originals or full references", async () => {
    const f = await planningFixture();
    await advanceTour(f.session, 1); await advanceTour(f.session, 2);
    const image = await reviewedImage(f), published = await publish(f, [image.id]), result = await readPublicProof(published.slug), body = JSON.stringify(result);
    assert.equal(result.snapshot?.payload.funding.ordersMinor, 92500); assert.equal(result.snapshot?.payload.funding.invoiceMinor, 3500); assert.equal(result.snapshot?.payload.funding.fundingEligibleMinor, 96000);
    assert.equal(result.snapshot?.payload.funding.paymentCount, 8); assert.equal(result.snapshot?.payload.signoffs.length, 0);
    const originals = await query<{ provider_ref: string }>("SELECT provider_ref FROM fp_settlement_receipts WHERE project_id=$1", [f.session.projectId]);
    for (const value of [f.session.actorId, f.session.tenantId, f.session.projectId, f.photo.id, f.photo.filename, "encrypted_data", "pathname", "documentId", "donorLabel", "sourceOrderId", "sourceInvoiceId", ...originals.map(r => r.provider_ref)]) assert.equal(body.includes(value), false, "Private identity or lineage must not appear in a public projection");
    assert.equal(bytesHash(await publicProofImage(published.slug, image.id, undefined, f.storage)), image.contentHash);
  });
  it("rejects unreviewed copies and foreign sources/packages", async () => {
    const f = await planningFixture(), other = await planningFixture(), image = await createProofDerivative(f.session, imageInput(f), f.storage);
    await assert.rejects(draft(f, [image.id]), errorCode("PROOF_IMAGE_UNREVIEWED"));
    await assert.rejects(createProofDerivative(f.session, { ...imageInput(f), documentId: other.photo.id }, f.storage), errorCode("PROOF_SOURCE_UNAVAILABLE"));
    const approved = await reviewedImage(f);
    await assert.rejects(createProofDraft(f.session, { intentId: randomUUID(), packageId: "printing", expectedVersion: 0, derivativeIds: [approved.id] }), errorCode("PROOF_IMAGE_UNREVIEWED"));
    await assert.rejects(privateProofImage(other.session, approved.id, f.storage), errorCode("PROOF_IMAGE_NOT_FOUND"));
  });
  it("replays one immutable image intent once and rejects changed replays", async () => {
    const f = await planningFixture(), input = imageInput(f);
    const a = await createProofDerivative(f.session, input, f.storage), b = await createProofDerivative(f.session, input, f.storage);
    assert.deepEqual(a, b); assert.equal((await readProofDesk(f.session)).derivatives.length, 1);
    await assert.rejects(createProofDerivative(f.session, { ...input, masks: [] }, f.storage), errorCode("PLANNING_INTENT_CHANGED"));
  });
  it("serializes concurrent drafts and rejects wrong snapshot hashes", async () => {
    const f = await planningFixture();
    const results = await Promise.allSettled([1, 2].map(() => createProofDraft(f.session, { intentId: randomUUID(), packageId: "electronics", expectedVersion: 0, derivativeIds: [] })));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(results.filter(r => r.status === "rejected" && errorCode("PROOF_VERSION_CHANGED")(r.reason)).length, 1);
    const snapshot = (await readProofDesk(f.session)).snapshots[0];
    await assert.rejects(decision(f, { ...snapshot, contentHash: "a".repeat(64) }, "review"), errorCode("PROOF_HASH_CHANGED"));
  });
  it("blocks donor, expired-session and revoked-membership publication authority", async () => {
    const f = await planningFixture(), donor = await addActor(f.session, "donor"), snapshot = await draft(f);
    await assert.rejects(readProofDesk(donor), errorCode("ROLE_DENIED"));
    await assert.rejects(createProofDerivative(donor, imageInput(f), f.storage), errorCode("ROLE_DENIED"));
    await query("UPDATE fp_sessions SET expires_at=now()-interval '1 minute' WHERE id=$1", [f.session.id]);
    await assert.rejects(decision(f, snapshot, "review"), errorCode("ROLE_DENIED"));
    const fresh = await addActor(f.session, "organizer"); await query("UPDATE fp_memberships SET state='revoked',version=version+1 WHERE actor_id=$1", [fresh.actorId]);
    await assert.rejects(createProofDraft(fresh, { intentId: randomUUID(), packageId: "electronics", expectedVersion: 1, derivativeIds: [] }), errorCode("MEMBERSHIP_DENIED"));
  });
  it("requires a fresh snapshot after funding or package-version changes", async () => {
    const f = await planningFixture(), snapshot = await draft(f); await decision(f, snapshot, "review");
    await advanceTour(f.session, 1); await advanceTour(f.session, 2);
    await assert.rejects(decision(f, snapshot, "publish"), errorCode("PROOF_SOURCE_CHANGED"));
    const next = await draft(f); await query("UPDATE fp_packages SET version=version+1 WHERE project_id=$1 AND id='electronics'", [f.session.projectId]);
    await assert.rejects(decision(f, next, "review"), errorCode("PROOF_SOURCE_CHANGED"));
  });
  it("invalidates dependent public pages and all image URLs immediately after source withdrawal", async () => {
    const f = await planningFixture(), image = await reviewedImage(f), published = await publish(f, [image.id]);
    assert.equal((await readProofDesk(f.session)).packages.find(p => p.id === "electronics")?.publicationState, "published");
    await setPlanningSourcePermission(f.session, f.photo.id, { intentId: randomUUID(), expectedVersion: 1, permission: "withdrawn", reason: "Controlled public-source withdrawal test" });
    const start = performance.now(); assert.equal((await readPublicProof(published.slug)).state, "withdrawn");
    await assert.rejects(publicProofImage(published.slug, image.id, 1, f.storage), errorCode("PUBLIC_PROOF_WITHDRAWN"));
    assert.ok(performance.now() - start < 3000);
    assert.equal((await readProofDesk(f.session)).packages.find(p => p.id === "electronics")?.publicationState, "withdrawn");
    await setPlanningSourcePermission(f.session, f.photo.id, { intentId: randomUUID(), expectedVersion: 2, permission: "allowed", reason: "Controlled reinstatement must not restore an old public review" });
    assert.equal((await readPublicProof(published.slug)).state, "withdrawn");
    assert.equal((await readProofDesk(f.session)).packages.find(p => p.id === "electronics")?.publicationState, "withdrawn");
    assert.equal((await query<{ count: string }>("SELECT count(*) FROM fp_documents WHERE id=$1", [f.photo.id]))[0].count, "1");
  });
  it("revokes a derivative without deleting its private source or reviving previous publication", async () => {
    const f = await planningFixture(), image = await reviewedImage(f), first = await publish(f, [image.id]), second = await publish(f, [image.id]);
    assert.equal(first.slug, second.slug); assert.equal((await readPublicProof(first.slug, 1)).snapshot?.payload.revision, 1);
    await revokeProofDerivative(f.session, image.id, randomUUID());
    assert.equal((await readPublicProof(first.slug, 1)).state, "withdrawn"); assert.equal((await readPublicProof(first.slug)).state, "withdrawn");
    await assert.rejects(publicProofImage(first.slug, image.id, undefined, f.storage), errorCode("PUBLIC_PROOF_WITHDRAWN"));
  });
  it("withdraws all editions while retaining private audit, then publishes a fresh reviewed edition at the same slug", async () => {
    const f = await planningFixture(), first = await publish(f), second = await publish(f);
    assert.equal((await readPublicProof(first.slug)).history.length, 2);
    const pkg = (await readProofDesk(f.session)).packages.find(p => p.id === "electronics")!;
    await withdrawProof(f.session, "electronics", { intentId: randomUUID(), expectedVersion: pkg.headVersion, acknowledged: true });
    const publicResult = await readPublicProof(first.slug, 1); assert.equal(publicResult.snapshot, null); assert.deepEqual(publicResult.history, []);
    assert.equal((await readProofDesk(f.session)).snapshots.length, 2);
    const third = await publish(f); assert.equal(third.slug, second.slug); assert.equal((await readPublicProof(third.slug)).snapshot?.payload.revision, 3);
    assert.equal((await readPublicProof(third.slug, 1)).snapshot, null);
  });
  it("withdraws current content after publishing-review authority is revoked", async () => {
    const f = await planningFixture(), published = await publish(f);
    await query("UPDATE fp_memberships SET state='revoked',version=version+1 WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [f.session.tenantId, f.session.projectId, f.session.actorId]);
    assert.equal((await readPublicProof(published.slug)).state, "withdrawn");
  });
  it("withdraws proof with stale reviewed-plan sources rather than asserting physical completion", async () => {
    const f = await planningFixture(); await publishFixture(f); const published = await publish(f);
    const initial = await readPublicProof(published.slug); assert.ok(initial.snapshot?.payload.plan); assert.equal(initial.snapshot?.payload.plan?.acceptedReviews, 0);
    await setPlanningSourcePermission(f.session, f.quote.id, { intentId: randomUUID(), expectedVersion: 1, permission: "withdrawn", reason: "Controlled current-plan source withdrawal" });
    assert.equal((await readPublicProof(published.slug)).state, "withdrawn");
  });
  it("fails closed for substituted image bytes, unknown slugs and foreign image IDs", async () => {
    const f = await planningFixture(), image = await reviewedImage(f), published = await publish(f, [image.id]);
    assert.equal((await readPublicProof("unknown")).state, "unavailable");
    await assert.rejects(publicProofImage(published.slug, randomUUID(), undefined, f.storage), errorCode("PUBLIC_PROOF_WITHDRAWN"));
    const path = [...f.files.keys()].find(k => k.includes(`/public-proof/${image.id}/`))!;
    f.files.set(path, { ...f.files.get(path)!, bytes: Buffer.from("Substituted fixture") });
    await assert.rejects(publicProofImage(published.slug, image.id, undefined, f.storage), errorCode("PROOF_IMAGE_INTEGRITY"));
  });
});

describe("irreversible raster redaction", () => {
  it("burns opaque pixels, crops original coordinates, strips metadata and retains a sample label", async () => {
    const original = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#ffffff" } }).withMetadata({ exif: { IFD0: { Artist: "PRIVATE_ARTIST", Copyright: "PRIVATE_COPYRIGHT" } } }).png().toBuffer();
    const result = await renderProofImage(original, { x: .1, y: .1, width: .8, height: .8 }, [{ x: .2, y: .2, width: .2, height: .2 }], true);
    assert.equal(result.width, 640); assert.equal(result.height, 520);
    const pixel = await sharp(result.bytes).extract({ left: 120, top: 100, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.deepEqual([...pixel], [24, 53, 74]);
    const metadata = await sharp(result.bytes).metadata(); assert.equal(metadata.exif, undefined); assert.equal(metadata.xmp, undefined);
    assert.equal(result.sha256, bytesHash(result.bytes)); assert.equal(result.bytes.includes(Buffer.from("PRIVATE_ARTIST")), false);
  });
  it("rejects an out-of-bounds crop and masks", async () => {
    const bytes = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).png().toBuffer();
    await assert.rejects(renderProofImage(bytes, { x: .9, y: 0, width: .3, height: 1 }, [], true), errorCode("PROOF_IMAGE_REGION"));
    await assert.rejects(renderProofImage(bytes, { x: 0, y: 0, width: 1, height: 1 }, [{ x: -.1, y: 0, width: .1, height: .1 }], true), errorCode("PROOF_IMAGE_REGION"));
  });
});
