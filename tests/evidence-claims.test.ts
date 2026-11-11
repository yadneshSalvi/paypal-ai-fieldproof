import { before, after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { PostgresDatabase } from "@fracture/paypal-core";
import sharp from "sharp";
import { database, initializeDatabase, query } from "../lib/server/db";
import type { Session } from "../lib/server/auth";
import { createProject } from "../lib/server/seed";
import { createUploadDocument, documentPreview, documentUploadGrant, documentView, finalizeDocument, importSampleReceipt, requireDocument } from "../lib/server/documents";
import type { DocumentStorage } from "../lib/server/document-storage";
import { receiptRuns, runReceiptExtraction, startReceiptExtraction, type ReceiptModel } from "../lib/server/receipt-extraction";
import { receiptComparisons } from "../lib/server/receipt-comparison";
import { extractedReceiptSchema, perceptualDistance, validateExtraction, type ExtractedReceipt } from "../lib/domain/evidence";
import { claimContext, claimPrivate, claimView, createClaim, reviewClaim, saveClaimDraft, type ClaimRow } from "../lib/server/claims";
import { sealPrivate } from "../lib/server/private-values";
import type { ClaimView } from "../lib/domain/claims";
import { reviewClaimSchema } from "../lib/domain/claims";
import { z } from "zod";
import { processDocumentBytes } from "../lib/server/document-processing";

const schema = `fp_evidence_test_${randomUUID().replaceAll("-", "")}`;
const originalUrl = process.env.DATABASE_URL!;
const admin = new PostgresDatabase(originalUrl);
before(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(originalUrl); url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.href;
  await initializeDatabase();
});
afterEach(async () => {
  const tables = await query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname=$1", [schema]);
  await database().query(`TRUNCATE ${tables.map(row => `"${schema}"."${row.tablename}"`).join(",")} RESTART IDENTITY CASCADE`);
});
after(async () => { await database().close(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.close(); process.env.DATABASE_URL = originalUrl; });
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function storageFixture() {
  const files = new Map<string, { bytes: Buffer; contentType: string }>();
  const storage: DocumentStorage = {
    async write(pathname, bytes, contentType) {
      const previous = files.get(pathname);
      if (previous) { assert.equal(hash(previous.bytes), hash(bytes)); assert.equal(previous.contentType, contentType); }
      else files.set(pathname, { bytes, contentType });
    },
    async read(pathname, maxBytes = 8 * 1024 * 1024) {
      const value = files.get(pathname); assert.ok(value); assert.ok(value.bytes.length <= maxBytes);
      return { ...value, pathname };
    },
  };
  return { storage, files };
}
// An in-memory parser fixture, never published as a user document or physical evidence.
function pdfFixture(pageCount = 1, active = false): Buffer {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R${active ? " /OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >>" : ""} >>`,
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let i = 0; i < pageCount; i++) {
    const content = "BT /F1 20 Tf 36 120 Td (Parser fixture - sample only) Tj ET";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  let file = "%PDF-1.7\n", offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(file)); file += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(file);
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(file);
}
async function fixture() {
  const session: Session = { id: randomUUID(), tenantId: randomUUID(), projectId: randomUUID(), actorId: randomUUID(), role: "volunteer", expiresAt: new Date(Date.now() + 600000).toISOString(), mode: "live_sandbox" };
  await database().transaction(async tx => {
    await createProject(tx, session.tenantId, session.projectId, `evidence-fixture-${randomUUID()}`, session.mode);
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [session.id, randomUUID(), session.tenantId, session.projectId, session.actorId, session.role, session.expiresAt]);
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,$4::jsonb)", [session.tenantId, session.projectId, session.actorId, JSON.stringify(["volunteer", "organizer", "donor", "auditor"])]);
  });
  const { storage, files } = storageFixture();
  const document = await importSampleReceipt(session, randomUUID(), "original", storage);
  return { session, storage, files, document };
}
async function role(session: Session, next: Session["role"]) { await query("UPDATE fp_sessions SET role=$2 WHERE id=$1", [session.id, next]); session.role = next; }
function extraction(): ExtractedReceipt {
  const amounts = [1800, 1250, 1600, 900, 1200, 1050, 840];
  return { vendor: "Fixture Supply", receiptDate: "2026-11-10", receiptNumber: "FIXTURE-014", currency: "USD", subtotalMinor: null, taxMinor: null, totalMinor: 8640,
    lineAmountsIncludeTax: true, isReceipt: true, documentWarnings: ["Fictional sample document; not a merchant purchase."],
    lines: amounts.map((amount, i) => ({ description: i === 6 ? "Parts" : `Fixture item ${i + 1}`, quantity: 1, unitMinor: amount, totalMinor: amount,
      kind: "item", sourceText: `Fixture item ${i + 1}: ${amount}`, sourceRegion: { page: 1, x: .08, y: .2 + i * .06, width: .84, height: .04 },
      suggestedPackageId: i === 4 ? "safety" : i === 6 ? null : "electronics", needsReview: i === 6,
      reviewReason: i === 6 ? "The purpose of parts is unclear." : null, confidence: i === 6 ? .6 : .98 })) };
}
const modelFixture = (value = extraction()): ReceiptModel => ({ async extract() { return { extraction: value, responseId: "fixture-model-response", inputTokens: 100, outputTokens: 200 }; } });
async function claimFixture() {
  const f = await fixture(), run = await startReceiptExtraction(f.session, f.document.id);
  await runReceiptExtraction(run.id, modelFixture(), f.storage);
  let claim = await createClaim(f.session, { documentId: f.document.id, runId: run.id, intentId: randomUUID() });
  claim = await saveClaimDraft(f.session, claim.id, draft(claim), true);
  return { ...f, run, claim };
}
function draft(claim: ClaimView) {
  return { expectedVersion: claim.version, title: claim.title, note: "Fictional fixture claim", currency: "USD", totalMinor: 8640,
    lines: claim.lines.map(line => ({ id: line.id, description: line.description, requestedMinor: line.requestedMinor, packageId: line.packageId })) };
}
function review(claim: ClaimView): z.infer<typeof reviewClaimSchema> {
  return { expectedVersion: claim.version, sourceTotalMinor: 8640, currency: "USD", note: "Checked against the clearly labeled fictional fixture source.", sourceChecked: true,
    sampleAcknowledged: true, receiptSplit: false, duplicateResolutions: [],
    lines: claim.lines.map((line, index) => ({ id: line.id, receiptLineKey: String(index + 1), description: line.description,
      sourceMinor: line.extractedMinor ?? line.requestedMinor, approvedMinor: index === 6 ? 0 : line.requestedMinor,
      decision: index === 6 ? "hold" : "approved", packageId: line.packageId,
      reviewNote: index === 6 ? "Keep the ambiguous parts line on hold." : "Checked this source line and its package.", uncertaintyResolved: index !== 6 })) };
}

describe("private evidence and bounded extraction", () => {
  it("renders PDF bytes and rejects active or excessive-page PDFs", async () => {
    const result = await processDocumentBytes(pdfFixture(), "application/pdf");
    assert.equal(result.pages.length, 1); assert.equal((await sharp(result.pages[0].bytes).metadata()).format, "png");
    await assert.rejects(processDocumentBytes(pdfFixture(1, true), "application/pdf"), { code: "ACTIVE_PDF_REJECTED" });
    await assert.rejects(processDocumentBytes(pdfFixture(13), "application/pdf"), { code: "DOCUMENT_PAGE_LIMIT" });
  });
  it("validates a real raster, strips metadata and restricts source access to the uploader/organizer", async () => {
    const f = await fixture();
    assert.equal(f.document.state, "ready"); assert.equal(f.document.provenance, "sample_document"); assert.equal(f.document.pageCount, 1);
    const bytes = await documentPreview(f.session, f.document.id, 1, f.storage), metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, "png"); assert.equal(metadata.exif, undefined); assert.ok(metadata.height! <= 1800);
    const other = await fixture(); await assert.rejects(requireDocument(other.session, f.document.id), { code: "DOCUMENT_NOT_FOUND" });
    await role(f.session, "donor"); await assert.rejects(requireDocument(f.session, f.document.id), { code: "DOCUMENT_NOT_FOUND" });
    await role(f.session, "volunteer"); await query("UPDATE fp_memberships SET state='revoked' WHERE project_id=$1", [f.session.projectId]);
    await assert.rejects(documentPreview(f.session, f.document.id, 1, f.storage), { code: "MEMBERSHIP_DENIED" });
  });
  it("binds a signed upload to exact owner, purpose, bytes, hash and pathname", async () => {
    const f = await fixture(), bytes = await sharp({ create: { width: 50, height: 70, channels: 3, background: "#f4f1ea" } }).png().toBuffer();
    const input = { intentId: randomUUID(), filename: "My private receipt.png", contentType: "image/png" as const, size: bytes.length, sha256: hash(bytes), purpose: "receipt" as const, permissionConfirmed: true as const };
    const [a, b] = await Promise.all([createUploadDocument(f.session, input), createUploadDocument(f.session, input)]);
    assert.equal(a.document.id, b.document.id);
    const grant = await documentUploadGrant(f.session, a.document.id, a.pathname);
    assert.equal(grant.maximumSizeInBytes, bytes.length); assert.equal(grant.allowOverwrite, false); assert.deepEqual(grant.allowedContentTypes, ["image/png"]);
    await assert.rejects(documentUploadGrant(f.session, a.document.id, a.pathname + "x"), { code: "UPLOAD_SCOPE" });
    await assert.rejects(createUploadDocument(f.session, { ...input, sha256: "0".repeat(64) }), { code: "DOCUMENT_INTENT_CHANGED" });
    await f.storage.write(a.pathname, bytes, "image/png");
    assert.equal((await finalizeDocument(f.session, a.document.id, f.storage)).state, "ready");
    await assert.rejects(documentUploadGrant(f.session, a.document.id, a.pathname), { code: "UPLOAD_SCOPE" });
  });
  it("rejects a disguised active file before rendering or model use", async () => {
    const f = await fixture(), bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const d = await createUploadDocument(f.session, { intentId: randomUUID(), filename: "disguised.png", contentType: "image/png", size: bytes.length, sha256: hash(bytes), purpose: "receipt", permissionConfirmed: true });
    await f.storage.write(d.pathname, bytes, "image/png");
    await assert.rejects(finalizeDocument(f.session, d.document.id, f.storage), { code: "DOCUMENT_TYPE_MISMATCH" });
    assert.equal(documentView(await requireDocument(f.session, d.document.id)).state, "rejected");
    await assert.rejects(startReceiptExtraction(f.session, d.document.id), { code: "RECEIPT_NOT_READY" });
  });
  it("persists genuine model-shaped proposals as nonpayable encrypted output and reuses the same completed run", async () => {
    const f = await fixture(), run = await startReceiptExtraction(f.session, f.document.id);
    let calls = 0; const model: ReceiptModel = { async extract(input) { calls++; assert.equal(input.pages.length, 1); return modelFixture().extract(input); } };
    await Promise.all([runReceiptExtraction(run.id, model, f.storage), runReceiptExtraction(run.id, model, f.storage)]);
    const [observed] = await receiptRuns(f.session, f.document.id); assert.equal(observed.state, "succeeded"); assert.equal(calls, 1);
    assert.equal(observed.extraction?.lines.length, 7); assert.equal(observed.validation?.lineTotalMinor, 8640); assert.equal(observed.validation?.uncertainLineCount, 1); assert.equal(observed.validation?.payable, false);
    const [{ encrypted_output }] = await query<{ encrypted_output: string }>("SELECT encrypted_output FROM fp_ai_runs WHERE id=$1", [run.id]);
    assert.ok(encrypted_output.startsWith("v1.")); assert.ok(!encrypted_output.includes("Fixture Supply"));
    assert.equal((await startReceiptExtraction(f.session, f.document.id)).id, run.id);
    assert.equal((await query<{ total: string }>("SELECT count(*) AS total FROM fp_claims"))[0].total, "0");
  });
  it("fails closed on source/package changes and malicious extra output fields", async () => {
    const f = await fixture(), first = await startReceiptExtraction(f.session, f.document.id);
    let calls = 0;
    await query("UPDATE fp_packages SET version=version+1 WHERE project_id=$1 AND id='electronics'", [f.session.projectId]);
    await runReceiptExtraction(first.id, { async extract(input) { calls++; return modelFixture().extract(input); } }, f.storage);
    assert.equal(calls, 0); assert.equal((await receiptRuns(f.session, f.document.id))[0].code, "SOURCE_CHANGED");
    const second = await startReceiptExtraction(f.session, f.document.id);
    assert.notEqual(second.id, first.id);
    await runReceiptExtraction(second.id, modelFixture({ ...extraction(), executePayout: true } as unknown as ExtractedReceipt), f.storage);
    assert.equal((await receiptRuns(f.session, f.document.id))[0].code, "EXTRACTION_SCHEMA_INVALID");
  });
  it("keeps duplicate evidence separate and never invents alignment", async () => {
    const f = await fixture(), copy = await importSampleReceipt(f.session, randomUUID(), "original", f.storage);
    const [candidate] = await receiptComparisons(f.session, f.document.id);
    assert.equal(candidate.documentId, copy.id); assert.equal(candidate.exactByteMatch, true); assert.equal(candidate.perceptualDistance, 0);
    assert.equal(candidate.alignment, "not_performed"); assert.deepEqual(candidate.ocrMatches, []);
    assert.equal(perceptualDistance("0000000000000000", "ffffffffffffffff"), 64);
    assert.equal(perceptualDistance("invalid", "ffffffffffffffff"), null);
  });
  it("routes missing currency, discounts, arithmetic and invalid source regions to review", () => {
    const x = extraction(); x.currency = null; x.lines[0].sourceRegion!.width = .99; x.lines[1].kind = "discount"; x.lines[1].totalMinor = -1250;
    const validation = validateExtraction(extractedReceiptSchema.parse(x), ["electronics", "safety"], 1);
    assert.ok(validation.codes.includes("CURRENCY_UNREADABLE")); assert.ok(validation.codes.includes("DISCOUNT_ALLOCATION_REVIEW"));
    assert.ok(validation.codes.includes("LINE_TOTAL_DIFFERENCE")); assert.ok(validation.codes.includes("SOURCE_REGION_INVALID")); assert.equal(validation.payable, false);
  });
});

describe("reviewed claims share a bounded receipt budget", () => {
  it("preserves extracted source reasons through note-only submission and displays legacy revisions without rewriting them", async () => {
    const { session, claim } = await claimFixture();
    assert.deepEqual(claim.lines.map(line => line.attentionReason), [null, null, null, null, null, null, "The purpose of parts is unclear."]);
    const saved = await saveClaimDraft(session, claim.id, { ...draft(claim), note: "Only this requester note changed; the extracted lines are unchanged." }, true);
    assert.equal(saved.sourceOutputHash, claim.sourceOutputHash);
    assert.equal(saved.sourceRunId, claim.sourceRunId);
    assert.deepEqual(saved.lines, claim.lines);
    const [row] = await query<ClaimRow>("SELECT * FROM fp_claims WHERE id=$1", [claim.id]);
    const historical = claimPrivate(row);
    historical.lines[0].attentionReason = "Entered manually; compare with the source.";
    const encrypted = sealPrivate(historical, claimContext(row));
    await query("UPDATE fp_claims SET encrypted_data=$2 WHERE id=$1", [claim.id, encrypted]);
    const projected = await claimView(session, claim.id);
    assert.equal(projected.lines[0].attentionReason, null);
    assert.equal(projected.lines[0].sourceIndex, 0);
    assert.equal(projected.lines[0].extractedMinor, 1800);
    const [unchanged] = await query<ClaimRow>("SELECT * FROM fp_claims WHERE id=$1", [claim.id]);
    assert.equal(unchanged.encrypted_data, encrypted);
    assert.equal(unchanged.version, row.version);
  });
  it("holds an ambiguous line and requires a separate later payment authorization", async () => {
    const f = await claimFixture(); await role(f.session, "organizer");
    const claim = await reviewClaim(f.session, f.claim.id, review(f.claim));
    assert.equal(claim.state, "reviewed"); assert.equal(claim.approvedMinor, 7800); assert.equal(claim.lines[6].decision, "hold");
    assert.equal(claim.lines[6].approvedMinor, 0); assert.deepEqual([...new Set(claim.lines.filter(l => l.approvedMinor).map(l => l.packageId))].sort(), ["electronics", "safety"]);
    assert.equal((await query<{ total: string }>("SELECT count(*) AS total FROM fp_approval_records"))[0].total, "0");
    assert.equal((await query<{ total: string }>("SELECT count(*) AS total FROM fp_claim_revisions WHERE claim_id=$1", [claim.id]))[0].total, "3");
  });
  it("rejects stale authority, unresolved ambiguity, excess totals and missing sample acknowledgement", async () => {
    const f = await claimFixture();
    await assert.rejects(reviewClaim(f.session, f.claim.id, review(f.claim)), { code: "ROLE_DENIED" });
    await role(f.session, "organizer");
    await assert.rejects(reviewClaim(f.session, f.claim.id, { ...review(f.claim), expectedVersion: 1 }), { code: "CLAIM_VERSION_CHANGED" });
    const invalid = review(f.claim); invalid.lines[6] = { ...invalid.lines[6], decision: "approved", approvedMinor: 840, packageId: "electronics" };
    await assert.rejects(reviewClaim(f.session, f.claim.id, invalid), { code: "LINE_REVIEW_REQUIRED" });
    await assert.rejects(reviewClaim(f.session, f.claim.id, { ...review(f.claim), sourceTotalMinor: 5000 }), { code: "CLAIM_EXCEEDS_RECEIPT" });
    await assert.rejects(reviewClaim(f.session, f.claim.id, { ...review(f.claim), sampleAcknowledged: false }), { code: "SAMPLE_ACK_REQUIRED" });
  });
  it("requires an exact duplicate decision and prevents reimbursement of an already claimed line", async () => {
    const f = await claimFixture(), copy = await importSampleReceipt(f.session, randomUUID(), "original", f.storage);
    await role(f.session, "organizer");
    await assert.rejects(reviewClaim(f.session, f.claim.id, review(f.claim)), { code: "DUPLICATE_REVIEW_REQUIRED" });
    const first = review(f.claim); first.duplicateResolutions = [{ documentId: copy.id, decision: "same_receipt", reason: "Identical fixture bytes; one purchase budget." }];
    const accepted = await reviewClaim(f.session, f.claim.id, first);
    await role(f.session, "volunteer");
    const run = await startReceiptExtraction(f.session, copy.id); await runReceiptExtraction(run.id, modelFixture(), f.storage);
    let second = await createClaim(f.session, { documentId: copy.id, runId: run.id, intentId: randomUUID() }); second = await saveClaimDraft(f.session, second.id, draft(second), true);
    await role(f.session, "organizer");
    const request = review(second); request.receiptSplit = true; request.duplicateResolutions = [{ documentId: f.document.id, decision: "same_receipt", reason: "This is a second copy of the original source." }];
    for (const line of request.lines) { line.approvedMinor = 0; line.decision = "hold"; }
    request.lines[0].approvedMinor = 500; request.lines[0].decision = "approved";
    await assert.rejects(reviewClaim(f.session, second.id, request), { code: "RECEIPT_LINE_ALREADY_CLAIMED" });
    assert.equal((await claimView(f.session, accepted.id)).approvedMinor, 7800);
  });
  it("permits an explicit remaining-line split while enforcing the original total", async () => {
    const f = await claimFixture(); await role(f.session, "organizer"); await reviewClaim(f.session, f.claim.id, review(f.claim));
    await role(f.session, "volunteer");
    let second = await createClaim(f.session, { documentId: f.document.id, runId: f.run.id, intentId: randomUUID() }); second = await saveClaimDraft(f.session, second.id, draft(second), true);
    await role(f.session, "organizer"); const request = review(second); request.receiptSplit = true;
    request.lines.forEach(line => { line.approvedMinor = 0; line.decision = "rejected"; });
    request.lines[6] = { ...request.lines[6], description: "Parts — fictional reviewed interpretation", approvedMinor: 840, decision: "approved", packageId: "electronics", uncertaintyResolved: true, reviewNote: "Explicitly assigned for this fictional test only." };
    const accepted = await reviewClaim(f.session, second.id, request);
    assert.equal(accepted.approvedMinor, 840); assert.equal(accepted.groupOtherApprovedMinor, 7800); assert.equal(accepted.groupReviewedTotalMinor, 8640);
    await role(f.session, "volunteer");
    await saveClaimDraft(f.session, accepted.id, { ...draft(accepted), note: "A source correction invalidates the earlier review." });
    assert.equal((await claimView(f.session, accepted.id)).approvedMinor, 0);
  });
  it("serializes concurrent reviews of the same source budget", async () => {
    const f = await claimFixture();
    let second = await createClaim(f.session, { documentId: f.document.id, runId: f.run.id, intentId: randomUUID() }); second = await saveClaimDraft(f.session, second.id, draft(second), true);
    await role(f.session, "organizer");
    const results = await Promise.allSettled([reviewClaim(f.session, f.claim.id, { ...review(f.claim), receiptSplit: true }), reviewClaim(f.session, second.id, { ...review(second), receiptSplit: true })]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal((await query<{ amount: string }>("SELECT sum(approved_minor) AS amount FROM fp_claims"))[0].amount, "7800");
  });
});
