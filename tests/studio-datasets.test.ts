import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresDatabase, type SqlConnection } from "@fracture/paypal-core";
import type { Session } from "../lib/server/auth";
import { database, initializeDatabase, query } from "../lib/server/db";
import { createProject, sampleReceipt } from "../lib/server/seed";
import { assertStudioProjection, materializeStudioDataset, readStudioSnapshot, requireStudioDataset } from "../lib/server/studio-datasets";
import { readStudioReport, saveStudioReport } from "../lib/server/studio-reports";
import { validateStudioHistory } from "../lib/studio/history";
import { sealPrivate } from "../lib/server/private-values";
import { claimContext } from "../lib/server/claims";
import type { ClaimPrivateData } from "../lib/domain/claims";
import type { AgReportHistory } from "ag-studio";

const originalUrl = process.env.DATABASE_URL!, schema = `fp_studio_test_${randomUUID().replaceAll("-", "")}`;
const admin = new PostgresDatabase(originalUrl);
before(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(originalUrl); url.searchParams.set("options", `-c search_path=${schema}`); process.env.DATABASE_URL = url.href;
  await initializeDatabase();
});
after(async () => { await database().close(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.close(); process.env.DATABASE_URL = originalUrl; });

async function fixture() {
  const session: Session = { id: randomUUID(), tenantId: randomUUID(), projectId: randomUUID(), actorId: randomUUID(), role: "organizer", mode: "live_sandbox", expiresAt: new Date(Date.now() + 600000).toISOString() };
  const otherActor = randomUUID();
  await database().transaction(async tx => {
    await createProject(tx, session.tenantId, session.projectId, `studio-fixture-${randomUUID()}`, session.mode);
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [session.id, randomUUID(), session.tenantId, session.projectId, session.actorId, session.role, session.expiresAt]);
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,$4::jsonb)", [session.tenantId, session.projectId, session.actorId, JSON.stringify(["donor", "volunteer", "organizer", "auditor"])]);
  });
  const receipts: string[] = [];
  async function addReceipt(value: number, invoice: boolean, purpose: "conditional_pledge" | "sandbox_test", actorId = session.actorId) {
    const obligation = randomUUID(), receipt = sampleReceipt(session.tenantId, session.projectId, obligation, "electronics", value, randomUUID(), invoice);
    receipt.provenance = "live_sandbox";
    receipt.actualProviderPaymentRef = `private-provider-resource-${randomUUID()}`;
    receipt.sourceOrderId = invoice ? null : `private-provider-order-${randomUUID()}`;
    await query("INSERT INTO fp_obligations(id,tenant_id,project_id,package_id,actor_id,amount_minor,channel,purpose,data) VALUES($1,$2,$3,'electronics',$4,$5,'collected',$6,'{}')", [obligation, session.tenantId, session.projectId, actorId, value, purpose]);
    await query("INSERT INTO fp_settlement_receipts(id,tenant_id,project_id,obligation_id,package_id,provider_ref,provenance,data) VALUES($1,$2,$3,$4,'electronics',$5,'live_sandbox',$6::jsonb)", [receipt.id, session.tenantId, session.projectId, obligation, receipt.actualProviderPaymentRef, JSON.stringify(receipt)]);
    receipts.push(receipt.id); return receipt;
  }
  for (const value of [20000, 20000, 17500, 15000, 10000, 5000, 5000]) await addReceipt(value, false, "conditional_pledge", value === 17500 ? otherActor : session.actorId);
  await addReceipt(100, false, "sandbox_test");
  return { session, otherActor, receipts, addReceipt };
}
async function role(session: Session, next: Session["role"]) { await query("UPDATE fp_sessions SET role=$2 WHERE id=$1", [session.id, next]); session.role = next; }
async function addReviewedClaim(session: Session, actorId = session.actorId) {
  const id = randomUUID(), document = randomUUID(), group = randomUUID();
  const data: ClaimPrivateData = { title: "Private receipt at private-person@example.invalid", note: "Private note", sourceHash: "fixture-source", sourceDocumentVersion: 1, sourceOutputHash: null,
    extraction: null, extractionValidation: null, requesterTotalMinor: 8640,
    review: { sourceTotalMinor: 8640, note: "Controlled fixture review only", reviewedAt: new Date().toISOString(), reviewerActorId: session.actorId, sampleAcknowledged: true, receiptSplit: false, duplicateResolutions: [] },
    lines: [1800, 1250, 1600, 900, 1200, 1050, 840].map((value, i) => ({ id: `line-${i + 1}`, description: `Private fixture item ${i + 1}`, sourceIndex: i, sourceRegion: null,
      extractedMinor: value, requestedMinor: value, packageId: i === 6 ? null : i === 4 ? "safety" : "electronics", needsAttention: i === 6, attentionReason: null,
      decision: i === 6 ? "hold" : "approved", reviewedSourceMinor: value, approvedMinor: i === 6 ? 0 : value, receiptLineKey: String(i + 1), reviewNote: "Fixture review" })) };
  await query(`INSERT INTO fp_documents(id,tenant_id,project_id,actor_id,intent_id,purpose,provenance,content_type,declared_bytes,expected_sha256,pathname,encrypted_data,state,upload_expires_at)
    VALUES($1,$2,$3,$4,$5,'receipt','sample_document','image/png',100,$6,$7,$8,'ready',now()+interval '1 hour')`, [document, session.tenantId, session.projectId, actorId, randomUUID(), "fixture-hash", `fixture-source-${document}`, sealPrivate({}, `fixture:${document}`)]);
  await query("INSERT INTO fp_receipt_groups(id,tenant_id,project_id,reviewed_total_minor,currency) VALUES($1,$2,$3,8640,'USD')", [group, session.tenantId, session.projectId]);
  await query(`INSERT INTO fp_claims(id,tenant_id,project_id,actor_id,document_id,group_id,intent_id,state,version,currency,requested_minor,approved_minor,encrypted_data,reviewed_by,reviewed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'reviewed',3,'USD',8640,7800,$8,$4,now())`, [id, session.tenantId, session.projectId, actorId, document, group, randomUUID(), sealPrivate(data, claimContext({ id, tenant_id: session.tenantId, project_id: session.projectId, version: 3 }))]);
  for (const line of data.lines) await query("INSERT INTO fp_claim_line_reviews(claim_id,claim_line_id,group_id,receipt_line_key,package_id,package_version,source_minor,approved_minor,decision,review_version) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,3)", [id, line.id, group, line.receiptLineKey, line.packageId, line.reviewedSourceMinor, line.approvedMinor, line.decision]);
  return { id, document };
}
function history(): AgReportHistory {
  const current = { version: "3.1.0", selectedPageId: "board", pages: [{ id: "board", widgets: { blueprint: { type: "fieldproof-blueprint", dataMapping: {} } }, widgetLayout: { blueprint: { xTrack: 0, yTrack: 0, xSpan: 7, ySpan: 5 } } }] };
  return { type: "AgReportHistory", current, undo: [{ id: "native-history-fixture", label: "Move widget", labelKey: "historyMoveWidget", at: Date.now(), source: { type: "ui" }, state: { ...current, pages: [{ ...current.pages[0], widgetLayout: { blueprint: { xTrack: 1, yTrack: 0, xSpan: 7, ySpan: 5 } } }] } }], redo: [] } as unknown as AgReportHistory;
}

describe("authorized Studio datasets and report histories", () => {
  it("joins both receipt rails, excludes the separate test and never invents spendable allocations", async () => {
    const f = await fixture();
    let snapshot = await readStudioSnapshot(f.session);
    assert.equal(snapshot.data.packages.find(row => row.id === "electronics")?.collectedMinor, 92500);
    assert.equal(snapshot.data.packages.find(row => row.id === "electronics")?.availableAllocationMinor, 0);
    assert.deepEqual(snapshot.data.allocations, []);
    await f.addReceipt(3500, true, "conditional_pledge");
    snapshot = await readStudioSnapshot(f.session);
    const pkg = snapshot.data.packages.find(row => row.id === "electronics")!;
    assert.equal(pkg.collectedMinor, 96000); assert.equal(pkg.shortfallMinor, 0); assert.equal(pkg.availableAllocationMinor, 0, "a funded-round authorization is still required");
    assert.equal(snapshot.data.settlements.filter(row => row.sourceKind === "orders_capture" && row.purpose === "conditional_pledge").reduce((sum, row) => sum + row.creditedMinor, 0), 92500);
    assert.equal(snapshot.data.settlements.find(row => row.purpose === "sandbox_test")?.fundingEligibleMinor, 0);
    assert.equal(JSON.stringify(snapshot).includes("private-provider-"), false);
  });
  it("gives donors only their receipts and no private expense originals even through materialization", async () => {
    const f = await fixture(); await addReviewedClaim(f.session);
    await role(f.session, "donor");
    const snapshot = await materializeStudioDataset(f.session);
    assert.equal(snapshot.data.settlements.length, 7);
    assert.ok(snapshot.data.settlements.every(row => row.grossMinor !== 17500));
    assert.ok(snapshot.data.evidence.every(row => row.documentId === null && !row.sourceAvailable));
    assert.equal(JSON.stringify(snapshot).includes("private-person"), false);
    assert.equal(snapshot.data.packages.find(row => row.id === "electronics")?.approvedExpenseMinor, 6600);
    assert.deepEqual((await requireStudioDataset(f.session, snapshot.datasetHandle)).data, snapshot.data);
    const [stored] = await query<{ encrypted_data: string }>("SELECT encrypted_data FROM fp_studio_snapshots WHERE id=$1", [snapshot.datasetHandle]);
    assert.ok(stored.encrypted_data.startsWith("v1.")); assert.equal(stored.encrypted_data.includes("Electronics"), false);
  });
  it("gives auditors redacted financial review facts with no source or recipient access", async () => {
    const f = await fixture(); await addReviewedClaim(f.session);
    await role(f.session, "auditor"); const snapshot = await readStudioSnapshot(f.session);
    assert.equal(snapshot.data.evidence.length, 2);
    assert.equal(snapshot.data.evidence.reduce((sum, row) => sum + (row.amountMinor ?? 0), 0), 7800);
    assert.ok(snapshot.data.evidence.every(row => row.documentId === null && row.claimId === null && !row.sourceAvailable));
    assert.equal(JSON.stringify(snapshot).includes("private-person"), false);
    assert.equal(snapshot.data.exceptions.find(row => row.category === "expense_review")?.affectedMinor, 840);
    assert.ok(snapshot.data.packages.every(row => row.reviewedItemCount === 0 && row.paidExpenseMinor === 0));
  });
  it("lets volunteers open only their own reviewed sources", async () => {
    const f = await fixture(), own = await addReviewedClaim(f.session); await addReviewedClaim(f.session, f.otherActor);
    await role(f.session, "volunteer"); const snapshot = await readStudioSnapshot(f.session);
    assert.equal(snapshot.data.settlements.length, 0);
    assert.equal(snapshot.data.evidence.length, 2);
    assert.ok(snapshot.data.evidence.every(row => row.documentId === own.document && row.claimId === own.id && row.sourceAvailable));
  });
  it("rejects revoked memberships, forged roles and another actor's dataset handle", async () => {
    const f = await fixture(), snapshot = await materializeStudioDataset(f.session);
    await assert.rejects(readStudioSnapshot({ ...f.session, role: "auditor" }), { code: "ROLE_DENIED" });
    const other = await fixture(); await assert.rejects(requireStudioDataset(other.session, snapshot.datasetHandle), { code: "STUDIO_DATASET_EXPIRED" });
    await query("UPDATE fp_memberships SET version=version+1 WHERE project_id=$1 AND actor_id=$2", [f.session.projectId, f.session.actorId]);
    await assert.rejects(requireStudioDataset(f.session, snapshot.datasetHandle), { code: "STUDIO_DATASET_EXPIRED" });
    await query("UPDATE fp_memberships SET state='revoked' WHERE project_id=$1 AND actor_id=$2", [f.session.projectId, f.session.actorId]);
    await assert.rejects(readStudioSnapshot(f.session), { code: "MEMBERSHIP_DENIED" });
  });
  it("refuses a private field even if a client intends to hide its column", async () => {
    const f = await fixture(), snapshot = await readStudioSnapshot(f.session);
    snapshot.data.packages[0].recipientEmail = "not-allowed@example.invalid";
    assert.throws(() => assertStudioProjection(snapshot.data), { code: "STUDIO_FIELD_DENIED" });
  });
  it("persists complete native undo/redo history separately from a truthful client-observed audit", async () => {
    const f = await fixture(), value = history();
    assert.equal((await readStudioReport(f.session)).history, null);
    const saved = await saveStudioReport(f.session, 0, value), loaded = await readStudioReport(f.session);
    assert.deepEqual(loaded.history, value); assert.equal(saved.revision, 1); assert.equal(loaded.audit[0].provenance, "client_observed_layout");
    assert.equal((await saveStudioReport(f.session, 0, value)).revision, 1, "identical retry is idempotent");
    const changed = structuredClone(value); changed.current.pages[0].widgetLayout!.blueprint!.xTrack = 2;
    await assert.rejects(saveStudioReport(f.session, 0, changed), { code: "STUDIO_REPORT_CONFLICT" });
    const [stored] = await query<{ encrypted_history: string }>("SELECT encrypted_history FROM fp_studio_reports WHERE project_id=$1", [f.session.projectId]);
    assert.equal(stored.encrypted_history.includes("fieldproof-blueprint"), false);
    await role(f.session, "auditor"); assert.equal((await readStudioReport(f.session)).history, null);
  });
  it("acknowledges its own committed history when another tab saves before the response resumes", async () => {
    const f = await fixture(), first = history(), later = structuredClone(first);
    later.current.pages[0].widgetLayout!.blueprint!.xTrack = 3;
    const db = database(), transaction = db.transaction;
    let interleaved = false;
    // Delay delivery of the first committed transaction, then let another tab
    // commit a real PostgreSQL save. This makes the post-commit response race
    // deterministic without replacing any SQL or report operation with a mock.
    db.transaction = async <T>(work: (tx: SqlConnection) => Promise<T>): Promise<T> => {
      const result = await transaction.call(db, work) as T;
      if (!interleaved) {
        interleaved = true; db.transaction = transaction;
        assert.equal((await saveStudioReport(f.session, 1, later)).revision, 2);
      }
      return result;
    };
    try {
      const acknowledged = await saveStudioReport(f.session, 0, first);
      assert.equal(interleaved, true);
      assert.equal(acknowledged.revision, 1, "a tab must not inherit an unseen writer's CAS token");
      assert.deepEqual(acknowledged.history, first);
      assert.deepEqual((await readStudioReport(f.session)).history, later);
      await assert.rejects(saveStudioReport(f.session, acknowledged.revision, first), { code: "STUDIO_REPORT_CONFLICT" });
    } finally { db.transaction = transaction; }
  });
  it("rejects corrupt history instead of dropping the undo stack or accepting remote content", () => {
    const value = history(); assert.deepEqual(validateStudioHistory(value), value);
    assert.throws(() => validateStudioHistory({ ...value, current: { ...value.current, selectedPageId: "missing" } }));
    assert.throws(() => validateStudioHistory(value.current));
    const malicious = structuredClone(value); (malicious.current.pages[0].widgets!.blueprint as unknown as Record<string, unknown>).image = "https://external.invalid/secret";
    assert.throws(() => validateStudioHistory(malicious));
  });
});
