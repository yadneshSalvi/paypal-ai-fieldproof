import { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PostgresDatabase } from "@fracture/paypal-core";
import sharp from "sharp";
import type { Session } from "../../lib/server/auth";
import { database, initializeDatabase, query } from "../../lib/server/db";
import { createProject } from "../../lib/server/seed";
import { createUploadDocument, finalizeDocument } from "../../lib/server/documents";
import type { DocumentStorage, StoredDocumentBytes } from "../../lib/server/document-storage";
import { importSamplePlanningSources } from "../../lib/server/planning-sources";
import { packageBindings, publishedPlan } from "../../lib/server/planning-store";
import { publishReviewedPlan, readPlanningWorkspace, reviewPlan, savePlan } from "../../lib/server/planning";
import { samplePlan } from "../../lib/planning/templates";
import type { CompetencyScope, PlanSourceView } from "../../lib/planning/contracts";
import { alignmentViews, qualificationViews, requestReviewerQualification, reviewPhotoAlignment, reviewReviewerQualification, savePhotoAlignment } from "../../lib/server/planning-evidence";

export function isolatedPlanningDatabase() {
  const original = process.env.DATABASE_URL!, schema = `fp_planning_test_${randomUUID().replaceAll("-", "")}`, admin = new PostgresDatabase(original);
  before(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(original); url.searchParams.set("options", `-c search_path=${schema}`); process.env.DATABASE_URL = url.href;
    await initializeDatabase();
  });
  after(async () => { await database().close(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.close(); process.env.DATABASE_URL = original; });
}
export const bytesHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function memoryStorage() {
  const files = new Map<string, StoredDocumentBytes>();
  const storage: DocumentStorage = {
    async read(pathname, maxBytes = 8 * 1024 * 1024) { const value = files.get(pathname); assert.ok(value, "Controlled fixture bytes must exist"); assert.ok(value.bytes.length <= maxBytes); return { ...value, bytes: Buffer.from(value.bytes) }; },
    async write(pathname, bytes, contentType) { const previous = files.get(pathname); if (previous) { assert.equal(bytesHash(previous.bytes), bytesHash(bytes)); assert.equal(previous.contentType, contentType); } else files.set(pathname, { pathname, bytes: Buffer.from(bytes), contentType }); },
  };
  return { files, storage };
}
export async function addActor(project: Pick<Session, "tenantId" | "projectId" | "mode">, role: Session["role"] = "volunteer", roles: Session["role"][] = [role]): Promise<Session> {
  const session: Session = { ...project, id: randomUUID(), actorId: randomUUID(), role, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() };
  await query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,$4::jsonb)", [session.tenantId, session.projectId, session.actorId, JSON.stringify(roles)]);
  await query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [session.id, randomUUID(), session.tenantId, session.projectId, session.actorId, role, session.expiresAt]);
  return session;
}
export async function uploadFixture(session: Session, storage: DocumentStorage, purpose: PlanSourceView["purpose"], provenance: PlanSourceView["provenance"] = "user_upload") {
  // Synthetic fixture only: never delivered as a real site, credential, supplier or inspection record.
  const bytes = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#f6ede0" } }).composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><text x="70" y="140" font-size="32">CONTROLLED SYNTHETIC TEST FIXTURE</text><text x="70" y="190" font-size="22">No purchase, credential or physical work is established.</text></svg>') }]).png().toBuffer();
  const draft = await createUploadDocument(session, { intentId: randomUUID(), filename: `Controlled synthetic ${purpose} fixture.png`, purpose, size: bytes.length, contentType: "image/png", sha256: bytesHash(bytes), permissionConfirmed: true }, provenance);
  await storage.write(draft.pathname, bytes, "image/png");
  return finalizeDocument(session, draft.document.id, storage);
}
export async function planningFixture(mode: Session["mode"] = "sample") {
  const identity = { tenantId: randomUUID(), projectId: randomUUID(), mode };
  await database().transaction(tx => createProject(tx, identity.tenantId, identity.projectId, `planning-fixture-${randomUUID()}`, mode));
  const session = await addActor(identity, "organizer", ["organizer", "volunteer", "donor", "auditor"]), { files, storage } = memoryStorage();
  if (mode === "sample") await importSamplePlanningSources(session, randomUUID(), storage);
  else for (const purpose of ["sketch", "quote", "photo", "signoff"] as const) await uploadFixture(session, storage, purpose);
  const workspace = await readPlanningWorkspace(session), sources = workspace.sources;
  const sketch = sources.find(s => s.purpose === "sketch")!, quote = sources.find(s => s.purpose === "quote")!, photo = sources.find(s => s.purpose === "photo")!, credential = sources.find(s => s.purpose === "signoff")!;
  const plan = samplePlan(sketch.id, quote.id, await packageBindings(session.projectId));
  plan.assumptions = ["Controlled source and review fixture. No real physical outcome or independent human review is claimed."];
  plan.zones.forEach(zone => zone.reviewState = "reviewed"); plan.packages.forEach(pkg => pkg.reviewState = "reviewed");
  return { session, storage, files, sources, sketch, quote, photo, credential, plan };
}
export type PlanningFixture = Awaited<ReturnType<typeof planningFixture>>;
export async function publishFixture(f: PlanningFixture) {
  let workspace = await readPlanningWorkspace(f.session);
  const saved = await savePlan(f.session, { intentId: randomUUID(), expectedVersion: workspace.headVersion, plan: f.plan, origin: f.session.mode === "sample" ? "sample" : "manual", sourceRunId: null });
  workspace = await readPlanningWorkspace(f.session); const current = workspace.current!;
  const review = await reviewPlan(f.session, { intentId: randomUUID(), expectedVersion: saved.headVersion, planId: saved.id, contentHash: current.contentHash, decision: "approved", note: "Controlled fixture review; not an independent human inspection.", sourceReviewConfirmed: true });
  await publishReviewedPlan(f.session, { intentId: randomUUID(), expectedVersion: review.headVersion, planId: saved.id, reviewId: review.reviewId, contentHash: current.contentHash, acknowledged: true });
  return (await publishedPlan(f.session))!;
}
export async function alignedFixture(f: PlanningFixture, packageId = "electronics", sharing: "reviewers_only" | "project_members" = "project_members") {
  const published = (await publishedPlan(f.session))!, zone = published.payload.plan.zones.find(z => z.packageId === packageId)!;
  const anchors = [{ x: .18, y: .22 }, { x: .82, y: .22 }, { x: .18, y: .82 }].map((photo, i) => ({ photo, plan: zone.polygon[[0, 1, zone.polygon.length - 2][i]] }));
  const saved = await savePhotoAlignment(f.session, { intentId: randomUUID(), planId: published.row.id, expectedPlanHash: published.row.content_hash, packageId, documentId: f.photo.id, sourcePage: 1,
    imageSharing: sharing, displayCrop: { x: .1, y: .1, width: .8, height: .8 }, redactions: [{ x: .35, y: .35, width: .15, height: .15 }], anchors, note: "Controlled image-association fixture, no site accuracy or physical outcome claimed." }, f.storage);
  const row = (await alignmentViews(f.session)).find(a => a.id === saved.id)!;
  return { ...row, review: () => reviewPhotoAlignment(f.session, row.id, { intentId: randomUUID(), contentHash: row.contentHash, expectedRevision: row.revision, anchorsConfirmed: true, illustrativeOnlyConfirmed: true, sharedImageConfirmed: sharing === "project_members" }) };
}
export async function qualificationFixture(f: PlanningFixture, actor: Session, scope: CompetencyScope, sample = false) {
  const document = sample && actor.actorId === f.session.actorId ? f.credential : await uploadFixture(actor, f.storage, "signoff", sample ? "sample_document" : "user_upload");
  const request = await requestReviewerQualification(actor, { intentId: randomUUID(), scope, documentId: document.id, displayName: "Controlled test reviewer", basis: "Synthetic credential evidence used only to test authorization and version checks; not a verified real credential.", validUntil: new Date(Date.now() + 86400_000).toISOString(), sampleAcknowledged: sample });
  await reviewReviewerQualification(f.session, request.id, { intentId: randomUUID(), expectedVersion: 1, decision: "verified", note: "Controlled credential-review fixture, not a human professional verification.", evidenceChecked: true, sampleAcknowledged: sample });
  return (await qualificationViews(actor)).find(q => q.id === request.id)!;
}
export async function role(session: Session, next: Session["role"]) { await query("UPDATE fp_sessions SET role=$2 WHERE id=$1", [session.id, next]); session.role = next; }
export function errorCode(code: string) { return (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code; }
