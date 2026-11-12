import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { before, describe, it } from "node:test";
import { procurementTestDatabase } from "./helpers/procurement-database";
import { procurementQuoteDraft } from "./helpers/procurement";
import * as C from "../lib/procurement/contracts";

const unit = await procurementTestDatabase();
const { procurementWorkspaceFixture } = await import("./helpers/procurement-workspace");
const { communityFixture } = await import("./helpers/community");
const { readProcurementDesk, readProcurementDetail, readProcurementHistory, readProcurementHistoryDetail, readProcurementCollection } = await import("../lib/server/procurement-projection");
const { proposeProcurementResponsibility, actOnProcurementResponsibility } = await import("../lib/server/procurement-responsibility");
const { prepareProcurementTransition, commitProcurementTransition, recordProcurementProgress, openProcurementException, resolveProcurementException, selectProcurementQuote } = await import("../lib/server/procurement-commands");
const { saveProcurementSupplier, saveProcurementQuote, reviewProcurementQuote } = await import("../lib/server/procurement-catalog");
const { readProcurementQuoteSource, readProcurementQuotePreview } = await import("../lib/server/procurement-sources");
const { procurementAuthority, procurementHash, sealProcurement } = await import("../lib/server/procurement-store");
const { setPlanningSourcePermission } = await import("../lib/server/planning-sources");
const { setRole, sessionForToken } = await import("../lib/server/auth");
let f: Awaited<ReturnType<typeof procurementWorkspaceFixture>>;
before(async () => { f = await procurementWorkspaceFixture(); });
const code = (expected: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === expected;
async function detail() { const scope = (await procurementAuthority(f.workspace.session)).scope; return readProcurementDetail(f.workspace.session, scope, "electronics"); }
async function transition(to: C.ProcurementState) {
  const d = await detail(), input: C.ProcurementTransitionPrepare = { expectedScope: d.scope, packageId: "electronics", expectedVersion: d.package.operationsVersion, expectedCycle: d.package.cycle, expectedBasisHash: d.basisHash, to, reason: "Controlled Sample operational review; no actual work or purchasing.", sharedWithResponsibilityId: null, reportedWorkOnly: true, historicalObligationsAcknowledged: true };
  const review = await prepareProcurementTransition(f.workspace.session, input);
  return { review, input, commit: { intentId: randomUUID(), expectedScope: d.scope, reviewHash: review.reviewHash, review: input, acknowledged: true as const } };
}
async function recordQuote(document = false) {
  const scope = (await procurementAuthority(f.workspace.session)).scope, draft = procurementQuoteDraft();
  const supplier = await saveProcurementSupplier(f.workspace.session, { intentId: randomUUID(), expectedScope: scope, supplierId: null, expectedVersion: 0, draft: { name: "PRIVATE PROCUREMENT SUPPLIER CANARY", description: "Controlled Sample self-declaration, never verified or contacted.", declaredLocation: null, sourceNote: "Explicitly fictional test source, not an actual supplier response.", provenance: "sample", acknowledged: true } });
  draft.supplierId = supplier.resourceId; draft.validUntil = new Date(Date.now() + 60 * 60_000).toISOString();
  if (document) { const source = (await readProcurementDesk(f.workspace.session, scope)).sources.find(source => source.documentId === f.planning!.quote.id)!; draft.source = { kind: "document", documentId: source.documentId, documentVersion: source.version, contentHash: source.contentHash, controlVersion: source.controlVersion, page: 1, region: { x: .1, y: .1, width: .7, height: .7 }, excerpt: "PRIVATE ORIGINAL QUOTE EXCERPT CANARY · controlled Sample only", sourceChecked: true }; }
  else draft.source = { kind: "entered_estimate", note: "Controlled Sample estimate only, without any supplier communication.", declaredAt: new Date().toISOString(), sourceChecked: true };
  const saved = await saveProcurementQuote(f.workspace.session, { intentId: randomUUID(), expectedScope: scope, quoteId: null, expectedVersion: 0, expectedPackageVersions: { electronics: 1 }, revisionReason: "Initial controlled quote-source declaration.", draft });
  const quote = (await readProcurementDesk(f.workspace.session, scope)).quotes.find(quote => quote.id === saved.resourceId)!;
  const reviewed = await reviewProcurementQuote(f.workspace.session, quote.id, { intentId: randomUUID(), expectedScope: scope, expectedVersion: quote.version, contentHash: quote.contentHash, decision: "reviewed", note: "Controlled source and arithmetic check; no supplier identity verification.", sourceChecked: true, amountsChecked: true, limitationsAcknowledged: true });
  return (await readProcurementDesk(f.workspace.session, scope)).quotes.find(quote => quote.id === reviewed.resourceId)!;
}

describe("real operational decisions remain independent of financial and physical authority", () => {
  it("reads an ordinary empty Sample desk without materializing operational heads or missing evidence as accepted work", async () => {
    const desk = await readProcurementDesk(f.workspace.session), d = await detail();
    assert.equal(desk.packages.length, 6); assert.ok(desk.packages.every(pkg => pkg.operationsVersion === 0 && pkg.storedState === "draft" && pkg.progressPercent === null)); assert.equal(d.requirements.filter(row => row.satisfied).length, 0); assert.ok(d.requirements.length > 0); assert.equal(d.money?.currentCollectedMinor, 0); assert.equal(d.money?.unpaidCommitmentMinor, 0);
    assert.equal((await unit.db.query<{ count: string }>("SELECT count(*) FROM fp_package_operations")).rows[0].count, "0");
  });
  it("requires a separate exact current responsibility response and keeps one immutable event per operational version", async () => {
    const desk = await readProcurementDesk(f.workspace.session), candidate = desk.candidates.find(row => row.own)!;
    const input = { intentId: randomUUID(), expectedScope: desk.scope, packageId: "electronics", expectedOperationsVersion: 0, expectedCycle: 1, candidateId: candidate.id, candidateAuthorityHash: candidate.authorityHash, candidateMembershipVersion: candidate.membershipVersion, note: "Explicit controlled proposal to the actual current organizer profile.", acceptOwnResponsibility: false, acknowledged: true as const };
    const proposal = await proposeProcurementResponsibility(f.workspace.session, input); assert.deepEqual(await proposeProcurementResponsibility(f.workspace.session, input), proposal);
    let d = await detail(); assert.equal(d.package.responsible?.state, "proposed"); assert.equal(d.package.responsible?.canAccept, true);
    const response = { intentId: randomUUID(), expectedScope: d.scope, expectedVersion: 1, action: "accept" as const, reason: "The exact controlled current profile explicitly accepts this cycle.", acknowledged: true as const };
    const accepted = await actOnProcurementResponsibility(f.workspace.session, proposal.resourceId, response); assert.deepEqual(await actOnProcurementResponsibility(f.workspace.session, proposal.resourceId, response), accepted);
    d = await detail(); assert.equal(d.package.operationsVersion, 2); assert.equal(d.package.responsible?.state, "accepted"); assert.equal(d.package.responsible?.role, "organizer");
    const page = await readProcurementHistory(f.workspace.session, d.scope, "electronics", null); assert.deepEqual(page.items.map(row => row.version), [2, 1]);
    assert.equal((await unit.db.query<{ count: string }>("SELECT count(*) FROM fp_procurement_access")).rows[0].count, "0"); // Assignment granted no member/profile.
  });
  it("commits only the exact prepared review and treats changed progress/issue facts as a new review requirement", async () => {
    const approval = await transition("approved"); assert.equal(approval.review.canCommit, true);
    const receipt = await commitProcurementTransition(f.workspace.session, approval.commit); assert.deepEqual(await commitProcurementTransition(f.workspace.session, approval.commit), receipt);
    let d = await detail(); assert.equal(d.package.storedState, "approved");
    const readiness = await transition("procurement_ready"); assert.equal(readiness.review.canCommit, false); assert.ok(readiness.review.blockers.some(value => /quote|ledger|funding/i.test(value))); await assert.rejects(commitProcurementTransition(f.workspace.session, readiness.commit), code("PROCUREMENT_REVIEW_REQUIRED"));
    const cancel = await transition("canceled"); await recordProcurementProgress(f.workspace.session, { intentId: randomUUID(), expectedScope: d.scope, packageId: "electronics", expectedVersion: d.package.operationsVersion, expectedCycle: d.package.cycle, percent: 100, note: "Controlled self-report only; 100 percent is no physical acceptance.", observedAt: new Date().toISOString(), acknowledged: true });
    await assert.rejects(commitProcurementTransition(f.workspace.session, cancel.commit), code("PROCUREMENT_VERSION_CHANGED"));
    d = await detail(); assert.equal(d.package.progressPercent, 100); assert.equal(d.requirements.filter(row => row.satisfied).length, 0); assert.notEqual(d.package.storedState, "accepted");
    const issue = await openProcurementException(f.workspace.session, { intentId: randomUUID(), expectedScope: d.scope, packageId: "electronics", expectedVersion: d.package.operationsVersion, expectedCycle: d.package.cycle, category: "other", title: "Controlled reported coordination issue", reason: "A fictional reported issue is not an actual funding or source-state change.", acknowledged: true });
    d = await detail(); assert.equal(d.exceptions.find(row => row.id === issue.resourceId)?.state, "open");
    await resolveProcurementException(f.workspace.session, issue.resourceId, { intentId: randomUUID(), expectedScope: d.scope, expectedVersion: 1, reason: "Explicitly resolve this controlled report without altering derived evidence gates.", acknowledged: true });
    d = await detail(); assert.equal(d.exceptions.find(row => row.id === issue.resourceId)?.state, "resolved"); assert.equal(d.requirements.filter(row => row.satisfied).length, 0);
  });
  it("keeps selected source bytes private and withholds retained source-derived values when the original permission is withdrawn", async () => {
    const quote = await recordQuote(true), d = await detail();
    const selected = await selectProcurementQuote(f.workspace.session, { intentId: randomUUID(), expectedScope: d.scope, packageId: "electronics", expectedOperationsVersion: d.package.operationsVersion, expectedCycle: d.package.cycle, expectedBasisHash: d.basisHash, quoteId: quote.id, quoteVersion: quote.version, quoteHash: quote.contentHash, comparisonQuoteHeads: [{ id: quote.id, version: quote.version, contentHash: quote.contentHash }], reason: "Controlled reviewed cost-share comparison only; no purchase or supplier response.", shareScalarsWithAssignee: true, acknowledged: true });
    const before = await detail(); assert.equal(before.package.selectedQuote?.amountMinor, 450); assert.equal(before.package.selectedQuote?.id, selected.resourceId);
    const source = await readProcurementQuoteSource(f.workspace.session, d.scope, quote.id, quote.version); assert.equal(source.originalDocumentAccess, true); assert.ok(source.preview);
    const bytes = await readProcurementQuotePreview(f.workspace.session, d.scope, quote.id, quote.version, 1, f.storage); assert.equal(createHash("sha256").update(bytes).digest("hex"), source.preview.contentHash);
    const headBefore = (await unit.db.query("SELECT * FROM fp_procurement_quote_versions WHERE quote_id=$1 ORDER BY version", [quote.id])).rows;
    await setPlanningSourcePermission(f.workspace.session, f.planning!.quote.id, { intentId: randomUUID(), expectedVersion: 1, permission: "withdrawn", reason: "Withdraw this controlled original source to test private disclosure." });
    const after = await detail(), retained = after.quotes.find(row => row.id === quote.id)!; assert.equal(retained.state, "source_withdrawn"); assert.equal(retained.draft, null); assert.equal(retained.supplier, null); assert.equal(retained.arithmetic, null); assert.equal(after.package.selectedQuote, null);
    assert.ok(!JSON.stringify(after).includes("PRIVATE ORIGINAL QUOTE EXCERPT CANARY")); assert.ok(!JSON.stringify(after).includes("PRIVATE PROCUREMENT SUPPLIER CANARY"));
    await assert.rejects(readProcurementQuotePreview(f.workspace.session, d.scope, quote.id, quote.version, 1, f.storage), code("PROCUREMENT_SOURCE_WITHDRAWN"));
    assert.deepEqual((await unit.db.query("SELECT * FROM fp_procurement_quote_versions WHERE quote_id=$1 ORDER BY version", [quote.id])).rows, headBefore);
    const events = await readProcurementHistory(f.workspace.session, d.scope, "electronics", null), selectedEvent = events.items.find(row => row.kind === "quote_selection")!; const retainedEvent = await readProcurementHistoryDetail(f.workspace.session, d.scope, selectedEvent.id); assert.equal(retainedEvent.status, "withdrawn"); assert.equal(retainedEvent.snapshot, null);
  });
  it("cancels and explicitly reopens despite unavailable source facts without rewriting financial/evidence history or renewing the old cycle", async () => {
    const protectedTables = ["fp_settlement_receipts", "fp_funding_assignments", "fp_receipt_allocations", "fp_payables", "fp_approval_records", "fp_work_signoffs", "fp_photo_alignments", "fp_purpose_pledges"], originals = new Map<string, unknown>();
    for (const table of protectedTables) originals.set(table, (await unit.db.query(`SELECT * FROM ${table} ORDER BY 1`)).rows);
    const before = await detail(), cancel = await transition("canceled"); assert.equal(cancel.review.canCommit, true); await commitProcurementTransition(f.workspace.session, cancel.commit);
    const canceled = await detail(); assert.equal(canceled.package.storedState, "canceled"); assert.equal(canceled.package.fundingState, before.package.fundingState);
    const reopen = await transition("reopened"); assert.equal(reopen.review.canCommit, true); await commitProcurementTransition(f.workspace.session, reopen.commit);
    const after = await detail(); assert.equal(after.package.cycle, before.package.cycle + 1); assert.equal(after.package.responsible, null); assert.equal(after.package.selectedQuote, null); assert.equal(after.package.progressPercent, null);
    for (const table of protectedTables) assert.deepEqual((await unit.db.query(`SELECT * FROM ${table} ORDER BY 1`)).rows, originals.get(table));
    const history = await readProcurementHistory(f.workspace.session, after.scope, "electronics", null); assert.ok(history.items.some(row => row.to === "canceled" && row.cycle === 1)); assert.equal(history.items[0].to, "reopened"); assert.equal(history.items[0].cycle, 2);
  });
  it("exposes Auditor metadata and no member/vendor/source/private reason, and refuses donor or stale-role reads", async () => {
    const original = f.workspace.session, scope = (await procurementAuthority(original)).scope;
    try { await setRole(original, "auditor"); const auditor = await sessionForToken(f.workspace.token); assert.ok(auditor); const aScope = (await procurementAuthority(auditor)).scope, desk = await readProcurementDesk(auditor, aScope); assert.equal(desk.suppliers.length, 0); assert.equal(desk.quotes.length, 0); assert.equal(desk.sources.length, 0); assert.equal(desk.candidates.length, 0); assert.ok(desk.packages.every(row => !row.responsible && !row.selectedQuote && !row.canOpen)); assert.ok(!JSON.stringify(desk).includes("PRIVATE PROCUREMENT")); const history = await readProcurementHistory(auditor, aScope, "electronics", null); assert.ok(history.items.every(row => row.reason === null && !row.canInspect)); await assert.rejects(readProcurementDetail(auditor, aScope, "electronics"), code("PROCUREMENT_ROLE_DENIED")); await assert.rejects(readProcurementDesk(original, scope), code("PROCUREMENT_AUTHORITY_ENDED")); await setRole(auditor, "donor"); const donor = await sessionForToken(f.workspace.token); assert.ok(donor); await assert.rejects(readProcurementDesk(donor), code("PROCUREMENT_ROLE_DENIED")); }
    finally { const current = await sessionForToken(f.workspace.token); if (current && current.role !== "organizer") await setRole(current, "organizer"); }
  });
  it("paginates distinct PostgreSQL microseconds inside one millisecond without losing or duplicating any supplier", async () => {
    const plain = await communityFixture("community-garden"), authority = await procurementAuthority(plain.session), when = new Date(Date.now() - 60_000).toISOString().slice(0, -1), ids: string[] = [];
    for (let index = 1; index <= 27; index++) { const id = randomUUID(), data = { contractVersion: C.PROCUREMENT_VERSION, supplierId: id, version: 1, state: "active" as const, draft: { name: `Controlled timestamp supplier ${index}`, description: "Explicit synthetic timestamp-boundary fixture only.", declaredLocation: null, sourceNote: "Test distinct database microseconds without rewriting any original timestamp.", provenance: "sample" as const, acknowledged: true as const } }; ids.push(id); await unit.db.query("INSERT INTO fp_procurement_suppliers(id,tenant_id,project_id,created_by,created_role,created_session_id,created_membership_version,created_at) VALUES($1,$2,$3,$4,'organizer',$5,$6,$7)", [id, plain.session.tenantId, plain.session.projectId, plain.session.actorId, plain.session.id, authority.membershipVersion, `${when}${String(index * 17).padStart(3, "0")}Z`]); await unit.db.query("INSERT INTO fp_procurement_supplier_versions(supplier_id,tenant_id,project_id,version,state,content_hash,encrypted_data,actor_id,actor_session_id,actor_role,membership_version) VALUES($1,$2,$3,1,'active',$4,$5,$6,$7,'organizer',$8)", [id, plain.session.tenantId, plain.session.projectId, procurementHash(data), sealProcurement(plain.session, "supplier", id, 1, data), plain.session.actorId, plain.session.id, authority.membershipVersion]); }
    const first = C.procurementSupplierPageSchema.parse(await readProcurementCollection(plain.session, authority.scope, "suppliers", null)), next = C.procurementSupplierPageSchema.parse(await readProcurementCollection(plain.session, authority.scope, "suppliers", first.nextCursor)); assert.equal(first.items.length, 20); assert.equal(next.items.length, 7); assert.equal(next.nextCursor, null); assert.deepEqual([...first.items, ...next.items].map(row => row.id), ids.sort().reverse());
    await assert.rejects(readProcurementCollection(f.workspace.session, (await procurementAuthority(f.workspace.session)).scope, "suppliers", first.nextCursor), code("PROCUREMENT_CONTEXT_CHANGED"));
  });
});
