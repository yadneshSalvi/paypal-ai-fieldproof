import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { procurementTestDatabase } from "./helpers/procurement-database";
import { procurementQuoteDraft } from "./helpers/procurement";

const unit = await procurementTestDatabase();
const { procurementWorkspaceFixture } = await import("./helpers/procurement-workspace");
const { uploadFixture } = await import("./helpers/planning");
const { sourceBindings } = await import("../lib/server/planning-store");
const { setPlanningSourcePermission } = await import("../lib/server/planning-sources");
const { procurementRead } = await import("../lib/server/procurement-read");
const { procurementAuthority } = await import("../lib/server/procurement-store");
const { readProcurementDesk } = await import("../lib/server/procurement-projection");
const { saveProcurementSupplier, saveProcurementQuote } = await import("../lib/server/procurement-catalog");
const { readProcurementQuotePreview } = await import("../lib/server/procurement-sources");
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const code = (expected: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === expected;

describe("source permission is current at procurement disclosure", () => {
  it("sees the first real permission-control insertion after the original repeatable-read snapshot", async () => {
    const f = await procurementWorkspaceFixture(), session = f.workspace.session, document = await uploadFixture(session, f.storage, "quote"), scope = (await procurementAuthority(session)).scope, captured = deferred<void>(), release = deferred<void>();
    assert.equal((await unit.db.query<{ count: string }>("SELECT count(*) FROM fp_plan_source_controls WHERE document_id=$1", [document.id])).rows[0].count, "0");
    // This is the same real disclosure boundary used by collections/history.
    // Its source read intentionally precedes the canonical writer's first row.
    const pending = procurementRead(session, scope, ["organizer"], async tx => { const bindings = await sourceBindings(session, [document.id], tx); captured.resolve(); await release.promise; return { value: { filename: document.filename, privateSourceCanary: "Captured only under original permitted source" }, bindings }; }); pending.catch(() => {});
    try { await captured.promise; await setPlanningSourcePermission(session, document.id, { intentId: randomUUID(), expectedVersion: 1, permission: "withdrawn", reason: "Controlled first permission withdrawal after an already captured private read." }); } finally { release.resolve(); }
    await assert.rejects(pending, code("PROCUREMENT_SOURCE_WITHDRAWN")); assert.equal((await unit.db.query<{ version: number; permission: string }>("SELECT version,permission FROM fp_plan_source_controls WHERE document_id=$1", [document.id])).rows[0].permission, "withdrawn");
  });
  it("returns no original page bytes when permission is withdrawn while the private storage read is pending", async () => {
    const f = await procurementWorkspaceFixture(), session = f.workspace.session, scope = (await procurementAuthority(session)).scope, document = await uploadFixture(session, f.storage, "quote"), supplier = await saveProcurementSupplier(session, { intentId: randomUUID(), expectedScope: scope, supplierId: null, expectedVersion: 0, draft: { name: "Controlled source-race supplier", description: "Explicitly fictional declaration; no supplier communication.", declaredLocation: null, sourceNote: "A test-owned original; no verified supplier or real purchase.", provenance: "sample", acknowledged: true } }), draft = procurementQuoteDraft();
    draft.supplierId = supplier.resourceId; draft.validUntil = new Date(Date.now() + 60_000).toISOString(); draft.source = { kind: "document", documentId: document.id, documentVersion: document.version, contentHash: document.contentHash, controlVersion: 1, page: 1, region: { x: 0, y: 0, width: 1, height: 1 }, excerpt: "Controlled original page wording with a deliberate delayed storage read.", sourceChecked: true };
    const saved = await saveProcurementQuote(session, { intentId: randomUUID(), expectedScope: scope, quoteId: null, expectedVersion: 0, expectedPackageVersions: { electronics: 1 }, revisionReason: "Record this exact controlled original page and no supplier response.", draft }), quote = (await readProcurementDesk(session)).quotes.find(row => row.id === saved.resourceId)!, reading = deferred<void>(), release = deferred<void>();
    const storage = { ...f.storage, read: async (pathname: string) => { reading.resolve(); await release.promise; return f.storage.read(pathname); } }, pending = readProcurementQuotePreview(session, scope, quote.id, quote.version, 1, storage); pending.catch(() => {});
    try { await reading.promise; await setPlanningSourcePermission(session, document.id, { intentId: randomUUID(), expectedVersion: 1, permission: "withdrawn", reason: "Controlled real withdrawal while the original image bytes are still being read." }); } finally { release.resolve(); }
    await assert.rejects(pending, code("PROCUREMENT_SOURCE_WITHDRAWN"));
  });
});
