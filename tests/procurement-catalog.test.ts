import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, describe, it } from "node:test";
import { procurementTestDatabase } from "./helpers/procurement-database";
import { procurementQuoteDraft } from "./helpers/procurement";

const unit = await procurementTestDatabase();
const { communityFixture } = await import("./helpers/community");
const { saveProcurementSupplier, changeProcurementSupplierState, saveProcurementQuote, reviewProcurementQuote } = await import("../lib/server/procurement-catalog");
const { procurementAuthority, quotePayload } = await import("../lib/server/procurement-store");
const { setRole, sessionForToken } = await import("../lib/server/auth");
let workspace: Awaited<ReturnType<typeof communityFixture>>, foreign: Awaited<ReturnType<typeof communityFixture>>;
before(async () => { workspace = await communityFixture("makerspace"); foreign = await communityFixture("community-garden"); });
const supplierDraft = (label = "Sample · fictional workshop supplier") => ({ name: label, description: "A controlled fictional supplier declaration; no external response or purchase.", declaredLocation: null, sourceNote: "Controlled source for deterministic isolated service tests only.", provenance: "sample" as const, acknowledged: true as const });
async function supplier(f = workspace, label?: string) { const scope = (await procurementAuthority(f.session)).scope; const input = { intentId: randomUUID(), expectedScope: scope, supplierId: null, expectedVersion: 0, draft: supplierDraft(label) }; const receipt = await saveProcurementSupplier(f.session, input); return { input, receipt, scope }; }
async function quote(f = workspace) {
  const s = await supplier(f), draft = procurementQuoteDraft(); draft.supplierId = s.receipt.resourceId; draft.supplierVersion = s.receipt.resourceVersion; draft.source = { kind: "entered_estimate", note: "Controlled fictional estimate only; no supplier communication was made.", declaredAt: new Date().toISOString(), sourceChecked: true }; draft.validUntil = new Date(Date.now() + 3600_000).toISOString();
  const input = { intentId: randomUUID(), expectedScope: s.scope, quoteId: null, expectedVersion: 0, expectedPackageVersions: { electronics: 1 }, revisionReason: "Initial controlled fictional quote proposal.", draft }, receipt = await saveProcurementQuote(f.session, input); return { supplier: s, input, receipt };
}
async function sourceVersion(id: string, version: number) { return (await unit.db.query<import("../lib/server/procurement-store").QuoteVersionRow & Record<string, unknown>>("SELECT * FROM fp_procurement_quote_versions WHERE quote_id=$1 AND version=$2", [id, version])).rows[0]; }
const code = (value: unknown, expected: string) => value instanceof Error && "code" in value && value.code === expected;

describe("actual scoped supplier/quote services with no external execution", () => {
  it("creates immutable self-declared supplier revisions and replays only the identical original request", async () => {
    const s = await supplier(), first = await saveProcurementSupplier(workspace.session, s.input); assert.deepEqual(first, s.receipt);
    await assert.rejects(saveProcurementSupplier(workspace.session, { ...s.input, draft: supplierDraft("Changed original intent") }), error => code(error, "PROCUREMENT_INTENT_CHANGED"));
    const edited = await saveProcurementSupplier(workspace.session, { intentId: randomUUID(), expectedScope: s.scope, supplierId: s.receipt.resourceId, expectedVersion: 1, draft: supplierDraft("Sample · corrected declaration") }); assert.equal(edited.resourceVersion, 2);
    const versions = await unit.db.query<{ version: number; encrypted_data: string }>("SELECT version,encrypted_data FROM fp_procurement_supplier_versions WHERE supplier_id=$1 ORDER BY version", [s.receipt.resourceId]); assert.deepEqual(versions.rows.map(row => row.version), [1, 2]); assert.doesNotMatch(versions.rows[0].encrypted_data, /fictional workshop supplier/);
    await assert.rejects(unit.db.query("UPDATE fp_procurement_supplier_versions SET encrypted_data='changed' WHERE supplier_id=$1 AND version=1", [s.receipt.resourceId]), /immutable/);
    assert.equal((await unit.db.query<{ encrypted_data: string }>("SELECT encrypted_data FROM fp_procurement_supplier_versions WHERE supplier_id=$1 AND version=1", [s.receipt.resourceId])).rows[0].encrypted_data, versions.rows[0].encrypted_data);
  });
  it("serializes concurrent identical creations into one supplier and one original receipt", async () => {
    const scope = (await procurementAuthority(workspace.session)).scope, input = { intentId: randomUUID(), expectedScope: scope, supplierId: null, expectedVersion: 0, draft: supplierDraft("Sample · concurrent declaration") };
    const values = await Promise.all([saveProcurementSupplier(workspace.session, input), saveProcurementSupplier(workspace.session, input)]); assert.deepEqual(values[0], values[1]); const count = await unit.db.query<{ count: string }>("SELECT count(*) count FROM fp_procurement_commands WHERE intent_id=$1", [input.intentId]); assert.equal(Number(count.rows[0].count), 1);
  });
  it("saves/reviews exact quote versions, preserves a bundled source and never overwrites canonical budget or creates a payable", async () => {
    const q = await quote(), original = await sourceVersion(q.receipt.resourceId, 1), beforePackage = await unit.db.query("SELECT version,budget_minor,data FROM fp_packages WHERE project_id=$1 AND id='electronics'", [workspace.session.projectId]);
    const review = await reviewProcurementQuote(workspace.session, q.receipt.resourceId, { intentId: randomUUID(), expectedScope: q.input.expectedScope, expectedVersion: 1, contentHash: original.content_hash, decision: "reviewed", note: "Controlled review of declared fictional arithmetic and scope only.", sourceChecked: true, amountsChecked: true, limitationsAcknowledged: true }); assert.equal(review.resourceVersion, 2);
    const reviewed = quotePayload(await sourceVersion(q.receipt.resourceId, 2)); assert.equal(reviewed.state, "reviewed"); assert.equal(reviewed.draft.statedTotalMinor, 450); assert.deepEqual(reviewed.packageVersions, { electronics: 1 }); assert.equal(reviewed.supplier.name, q.supplier.input.draft.name);
    assert.deepEqual((await unit.db.query("SELECT version,budget_minor,data FROM fp_packages WHERE project_id=$1 AND id='electronics'", [workspace.session.projectId])).rows, beforePackage.rows); assert.deepEqual(await sourceVersion(q.receipt.resourceId, 1), original); assert.deepEqual(await saveProcurementQuote(workspace.session, q.input), q.receipt);
    for (const table of ["fp_payables", "fp_settlement_receipts", "paycore_operations", "fp_work_signoffs"]) assert.equal(Number((await unit.db.query<{ count: string }>(`SELECT count(*) count FROM ${table}`)).rows[0].count), 0);
  });
  it("retains unknown costs without zero and refuses arithmetic conflicts as reviewed source facts", async () => {
    const q = await quote(), draft = { ...q.input.draft, deliveryMinor: null }, changed = await saveProcurementQuote(workspace.session, { ...q.input, intentId: randomUUID(), quoteId: q.receipt.resourceId, expectedVersion: 1, draft, revisionReason: "Delivery is absent from this fictional source, not free." }); assert.equal(changed.resourceVersion, 2);
    const row = await sourceVersion(q.receipt.resourceId, 2); assert.equal(quotePayload(row).draft.deliveryMinor, null);
    const bad = await quote(); bad.input.draft.lines[0].unitMinor = 201; const broken = await saveProcurementQuote(workspace.session, { ...bad.input, intentId: randomUUID(), quoteId: bad.receipt.resourceId, expectedVersion: 1, revisionReason: "Source arithmetic needs explicit clarification." });
    const source = await sourceVersion(broken.resourceId, 2); await assert.rejects(reviewProcurementQuote(workspace.session, broken.resourceId, { intentId: randomUUID(), expectedScope: bad.input.expectedScope, expectedVersion: 2, contentHash: source.content_hash, decision: "reviewed", note: "This intentionally inconsistent source must remain unapproved.", sourceChecked: true, amountsChecked: true, limitationsAcknowledged: true }), error => code(error, "PROCUREMENT_QUOTE_INVALID")); assert.equal((await sourceVersion(broken.resourceId, 2)).state, "draft");
  });
  it("denies foreign supplier scope, changed package versions, extra instruction fields and stale source/cost decisions", async () => {
    const other = await supplier(foreign, "PRIVATE_FOREIGN_SUPPLIER_CANARY"), local = await quote();
    await assert.rejects(saveProcurementQuote(workspace.session, { ...local.input, intentId: randomUUID(), draft: { ...local.input.draft, supplierId: other.receipt.resourceId } }), error => code(error, "PROCUREMENT_NOT_FOUND") && error instanceof Error && !error.message.includes("PRIVATE_FOREIGN"));
    await assert.rejects(saveProcurementQuote(workspace.session, { ...local.input, intentId: randomUUID(), expectedPackageVersions: { electronics: 99 } }), error => code(error, "PROCUREMENT_BASIS_CHANGED"));
    await assert.rejects(saveProcurementQuote(workspace.session, { ...local.input, intentId: randomUUID(), sendPayout: true } as typeof local.input));
    const row = await sourceVersion(local.receipt.resourceId, 1); await assert.rejects(reviewProcurementQuote(workspace.session, local.receipt.resourceId, { intentId: randomUUID(), expectedScope: local.input.expectedScope, expectedVersion: 1, contentHash: "0".repeat(64), decision: "reviewed", note: "Wrong source hash must never approve a quote.", sourceChecked: true, amountsChecked: true, limitationsAcknowledged: true }), error => code(error, "PROCUREMENT_SOURCE_CHANGED")); assert.deepEqual(await sourceVersion(local.receipt.resourceId, 1), row);
  });
  it("archives/restores a supplier through new revisions without reviving a retired quote or extending its original deadline", async () => {
    const q = await quote(), deadline = q.input.draft.validUntil, source = await sourceVersion(q.receipt.resourceId, 1);
    const archived = await changeProcurementSupplierState(workspace.session, q.supplier.receipt.resourceId, { intentId: randomUUID(), expectedScope: q.supplier.scope, expectedVersion: 1, action: "archive", reason: "Stop new procurement while retaining original source history.", acknowledged: true }); assert.equal(archived.resourceVersion, 2);
    await assert.rejects(reviewProcurementQuote(workspace.session, q.receipt.resourceId, { intentId: randomUUID(), expectedScope: q.input.expectedScope, expectedVersion: 1, contentHash: source.content_hash, decision: "reviewed", note: "Archived supplier availability must block a prospective selection.", sourceChecked: true, amountsChecked: true, limitationsAcknowledged: true }), error => code(error, "PROCUREMENT_SUPPLIER_CHANGED"));
    await changeProcurementSupplierState(workspace.session, q.supplier.receipt.resourceId, { intentId: randomUUID(), expectedScope: q.supplier.scope, expectedVersion: 2, action: "restore", reason: "Explicitly restore this declaration for a new quote review.", acknowledged: true });
    const retired = await reviewProcurementQuote(workspace.session, q.receipt.resourceId, { intentId: randomUUID(), expectedScope: q.input.expectedScope, expectedVersion: 1, contentHash: source.content_hash, decision: "retired", note: "Retire this original fictional estimate without new source facts.", sourceChecked: true, amountsChecked: true, limitationsAcknowledged: true });
    await assert.rejects(saveProcurementQuote(workspace.session, { ...q.input, intentId: randomUUID(), quoteId: q.receipt.resourceId, expectedVersion: retired.resourceVersion, draft: { ...q.input.draft, supplierVersion: 3 } }), error => code(error, "PROCUREMENT_VERSION_CHANGED")); assert.equal(quotePayload(await sourceVersion(q.receipt.resourceId, retired.resourceVersion)).draft.validUntil, deadline);
  });
  it("rejects stale organizer tabs and current Auditor/Donor commands; a legitimate founder volunteer view alone is no assignment", async () => {
    const scope = (await procurementAuthority(workspace.session)).scope, input = { intentId: randomUUID(), expectedScope: scope, supplierId: null, expectedVersion: 0, draft: supplierDraft() };
    try {
      await setRole(workspace.session, "auditor"); const auditor = await sessionForToken(workspace.token); assert.ok(auditor); await assert.rejects(saveProcurementSupplier(workspace.session, input), error => code(error, "PROCUREMENT_AUTHORITY_ENDED")); await assert.rejects(saveProcurementSupplier(auditor, input), error => code(error, "PROCUREMENT_ROLE_DENIED"));
      await setRole(auditor, "donor"); const donor = await sessionForToken(workspace.token); assert.ok(donor); await assert.rejects(saveProcurementSupplier(donor, input), error => code(error, "PROCUREMENT_ROLE_DENIED"));
      await setRole(donor, "volunteer"); const volunteer = await sessionForToken(workspace.token); assert.ok(volunteer); const ownScope = (await procurementAuthority(volunteer)).scope; await assert.rejects(saveProcurementSupplier(volunteer, { ...input, intentId: randomUUID(), expectedScope: ownScope }), error => code(error, "PROCUREMENT_ASSIGNMENT_REQUIRED"));
      // This is explicitly the existing founder's allowed view, not a claimed
      // public volunteer join. Genuine volunteer entry has its own service tests.
      await setRole(volunteer, "organizer");
    } finally { const current = await sessionForToken(workspace.token); if (current && current.role !== "organizer") await setRole(current, "organizer"); }
  });
});
