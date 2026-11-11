import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import { type DocumentView, newDocumentSchema, MAX_DOCUMENT_BYTES } from "../domain/evidence";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { database, query } from "./db";
import { requireCurrentRole, requireMembership } from "./membership";
import { openPrivate, sealPrivate } from "./private-values";
import { appendEvent } from "./repository";
import { DOCUMENT_PROCESSOR_VERSION, processDocumentBytes } from "./document-processing";
import { privateDocumentStorage, type DocumentStorage } from "./document-storage";
import { withExecutionLease } from "./maintenance";

export interface DocumentPrivateData {
  filename: string;
  permissionConfirmedAt: string;
  uploaderRole: "volunteer" | "organizer";
  sampleVariant?: "original" | "rotated" | "cropped";
  pages: { number: number; width: number; height: number; pathname: string; sha256: string }[];
}
export interface DocumentRow {
  id: string; tenant_id: string; project_id: string; actor_id: string; intent_id: string;
  purpose: DocumentView["purpose"]; provenance: DocumentView["provenance"];
  content_type: string; declared_bytes: number; expected_sha256: string; pathname: string; encrypted_data: string;
  state: DocumentView["state"]; version: number; sha256: string | null; perceptual_hash: string | null;
  page_count: number | null; validation_code: string | null; lease_id: string | null;
  lease_until: Date | null; upload_expires_at: Date; created_at: Date;
}
export function documentContext(row: Pick<DocumentRow, "tenant_id" | "project_id" | "id">): string {
  return `document:${row.tenant_id}:${row.project_id}:${row.id}`;
}
export function documentPrivate(row: DocumentRow): DocumentPrivateData { return openPrivate(row.encrypted_data, documentContext(row)); }
async function assertSourcePermission(row: DocumentRow): Promise<void> {
  if (row.purpose === "receipt") return;
  const [control] = await query<{ permission: string }>("SELECT permission FROM fp_plan_source_controls WHERE document_id=$1 AND tenant_id=$2 AND project_id=$3", [row.id, row.tenant_id, row.project_id]);
  if (control?.permission === "withdrawn") throw new DomainError("SOURCE_PERMISSION_WITHDRAWN", "Permission to use this planning source has been withdrawn.", 404);
}
export async function requireDocument(session: Session, id: string, tx: SqlConnection = database()): Promise<DocumentRow> {
  await requireCurrentRole(session, session.role, tx);
  const [row] = await query<DocumentRow>("SELECT * FROM fp_documents WHERE id=$1 AND tenant_id=$2 AND project_id=$3", [id, session.tenantId, session.projectId], tx);
  if (!row || !(session.role === "organizer" || (session.role === "volunteer" && row.actor_id === session.actorId)))
    throw new DomainError("DOCUMENT_NOT_FOUND", "This source document is not available in your current view.", 404);
  return row;
}
export function documentView(row: DocumentRow): DocumentView {
  const data = documentPrivate(row);
  return { id: row.id, filename: data.filename, purpose: row.purpose, provenance: row.provenance,
    state: row.state, version: row.version, contentType: row.content_type, size: row.declared_bytes, contentHash: row.expected_sha256, uploadPathname: row.state === "awaiting_upload" ? row.pathname : null,
    pageCount: row.page_count, code: row.validation_code, createdAt: row.created_at.toISOString(),
    pages: row.state === "ready" ? data.pages.map(page => ({ number: page.number, width: page.width,
      height: page.height, previewUrl: `/api/documents/${row.id}/preview?page=${page.number}` })) : [] };
}
export async function documentsView(session: Session): Promise<DocumentView[]> {
  await requireCurrentRole(session, session.role);
  if (!["volunteer", "organizer"].includes(session.role)) return [];
  const rows = await query<DocumentRow>("SELECT * FROM fp_documents WHERE tenant_id=$1 AND project_id=$2 AND ($3::boolean OR actor_id=$4) ORDER BY created_at DESC LIMIT 100", [session.tenantId, session.projectId, session.role === "organizer", session.actorId]);
  return rows.map(documentView);
}
async function assertUploader(session: Session, purpose: DocumentRow["purpose"], tx: SqlConnection = database()) {
  if (!["volunteer", "organizer"].includes(session.role) || (purpose === "sketch" && session.role !== "organizer"))
    throw new DomainError("ROLE_DENIED", "Choose the volunteer or organizer view to add evidence.", 403);
  await requireCurrentRole(session, session.role, tx);
}
export async function createUploadDocument(session: Session, input: z.infer<typeof newDocumentSchema>, provenance: DocumentRow["provenance"] = "user_upload", sampleVariant?: DocumentPrivateData["sampleVariant"]): Promise<{ document: DocumentView; pathname: string }> {
  const data = newDocumentSchema.parse(input);
  const row = await database().transaction(async tx => {
    await assertUploader(session, data.purpose, tx);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`document-intent:${session.tenantId}:${session.actorId}:${data.intentId}`]);
    const [existing] = await query<DocumentRow>("SELECT * FROM fp_documents WHERE tenant_id=$1 AND actor_id=$2 AND intent_id=$3", [session.tenantId, session.actorId, data.intentId], tx);
    if (existing) {
      const privateData = documentPrivate(existing);
      if (existing.project_id !== session.projectId || existing.content_type !== data.contentType || existing.declared_bytes !== data.size || existing.expected_sha256 !== data.sha256 || existing.purpose !== data.purpose || existing.provenance !== provenance || privateData.filename !== data.filename || privateData.sampleVariant !== sampleVariant)
        throw new DomainError("DOCUMENT_INTENT_CHANGED", "This upload draft already describes a different file. Start a new draft.", 409);
      return existing;
    }
    const [count] = await query<{ count: string }>("SELECT count(*) FROM fp_documents WHERE tenant_id=$1 AND created_at>now()-interval '24 hours'", [session.tenantId], tx);
    if (Number(count.count) >= 150) throw new DomainError("UPLOAD_LIMIT", "This workspace has reached its daily document limit. Existing drafts remain available.", 429);
    const id = randomUUID();
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" }[data.contentType];
    const pathname = `fieldproof/${id}/original.${ext}`;
    const encrypted = sealPrivate({ filename: data.filename, permissionConfirmedAt: new Date().toISOString(), uploaderRole: session.role as "volunteer" | "organizer", pages: [], ...(sampleVariant ? { sampleVariant } : {}) } satisfies DocumentPrivateData,
      documentContext({ tenant_id: session.tenantId, project_id: session.projectId, id }));
    const [created] = await query<DocumentRow>("INSERT INTO fp_documents(id,tenant_id,project_id,actor_id,intent_id,purpose,provenance,content_type,declared_bytes,expected_sha256,pathname,encrypted_data,upload_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()+interval '20 minutes') RETURNING *", [id, session.tenantId, session.projectId, session.actorId, data.intentId, data.purpose, provenance, data.contentType, data.size, data.sha256, pathname, encrypted], tx);
    await appendEvent(tx, session, "evidence.upload_drafted", "A private evidence draft is ready", provenance === "sample_document" ? "A labeled sample document will demonstrate the review workflow. It is not proof of a purchase." : "The original stays private. File validation and a separate review are still required.");
    return created;
  });
  return { document: documentView(row), pathname: row.pathname };
}

export async function documentUploadGrant(session: Session, id: string, pathname: string) {
  const row = await requireDocument(session, id);
  await assertSourcePermission(row);
  await assertUploader(session, row.purpose);
  if (row.actor_id !== session.actorId || row.provenance !== "user_upload" || row.pathname !== pathname || row.state !== "awaiting_upload")
    throw new DomainError("UPLOAD_SCOPE", "This upload token does not match your original draft.", 403);
  if (row.upload_expires_at.getTime() <= Date.now()) throw new DomainError("UPLOAD_EXPIRED", "This upload link expired. Renew the link to continue the same draft.", 409);
  return { allowedContentTypes: [row.content_type], maximumSizeInBytes: row.declared_bytes,
    validUntil: Math.min(row.upload_expires_at.getTime(), Date.now() + 10 * 60_000), addRandomSuffix: false,
    allowOverwrite: false, cacheControlMaxAge: 60, tokenPayload: JSON.stringify({ documentId: row.id, tenantId: row.tenant_id }) };
}
export async function renewDocumentUpload(session: Session, id: string): Promise<DocumentView> {
  const row = await requireDocument(session, id);
  if (row.actor_id !== session.actorId || row.state !== "awaiting_upload") throw new DomainError("UPLOAD_NOT_RENEWABLE", "This file is already being checked or has completed validation.", 409);
  const [updated] = await query<DocumentRow>("UPDATE fp_documents SET upload_expires_at=now()+interval '20 minutes',updated_at=now() WHERE id=$1 AND state='awaiting_upload' RETURNING *", [id]);
  return documentView(updated ?? row);
}

export async function finalizeDocument(session: Session, id: string, storage: DocumentStorage = privateDocumentStorage): Promise<DocumentView> {
  const row = await requireDocument(session, id);
  if (row.actor_id !== session.actorId && session.role !== "organizer") throw new DomainError("ROLE_DENIED", "Only the uploader or organizer can validate this file.", 403);
  await validateStoredDocument(row.id, row.tenant_id, storage);
  return documentView(await requireDocument(session, id));
}
async function performDocumentValidation(id: string, tenantId: string, storage: DocumentStorage = privateDocumentStorage): Promise<void> {
  const leaseId = randomUUID();
  const [row] = await query<DocumentRow>("UPDATE fp_documents SET state='validating',lease_id=$3,lease_until=now()+interval '3 minutes',validation_code=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND (state='awaiting_upload' OR (state='validating' AND lease_until<now())) RETURNING *", [id, tenantId, leaseId]);
  if (!row) return;
  const privateData = documentPrivate(row);
  try {
    await requireMembership(row.tenant_id, row.project_id, row.actor_id, privateData.uploaderRole);
    const original = await storage.read(row.pathname, MAX_DOCUMENT_BYTES);
    if (original.pathname !== row.pathname || original.contentType !== row.content_type || original.bytes.length !== row.declared_bytes || createHash("sha256").update(original.bytes).digest("hex") !== row.expected_sha256)
      throw new DomainError("UPLOAD_CONTENT_CHANGED", "The uploaded file does not match the size and type of your draft.", 422);
    const processed = await processDocumentBytes(original.bytes, row.content_type);
    const pages: DocumentPrivateData["pages"] = [];
    for (const page of processed.pages) {
      const pathname = `fieldproof/${row.id}/${DOCUMENT_PROCESSOR_VERSION}/${processed.sha256}/page-${page.number}.png`;
      await storage.write(pathname, page.bytes, "image/png");
      pages.push({ number: page.number, width: page.width, height: page.height, pathname, sha256: page.sha256 });
    }
    await database().transaction(async tx => {
      const completed = await tx.query("UPDATE fp_documents SET state='ready',sha256=$4,perceptual_hash=$5,page_count=$6,encrypted_data=$7,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND lease_id=$3 RETURNING id", [row.id, row.tenant_id, leaseId, processed.sha256, processed.perceptualHash, pages.length, sealPrivate({ ...privateData, pages }, documentContext(row))]);
      if (completed.rows.length) {
        const [tenant] = await query<{ mode: Session["mode"] }>("SELECT mode FROM fp_tenants WHERE id=$1", [row.tenant_id], tx);
        await appendEvent(tx, { tenantId: row.tenant_id, projectId: row.project_id, mode: tenant.mode }, "evidence.file_validated", "A private source is ready for review", `${pages.length} page${pages.length === 1 ? "" : "s"} validated and rendered. This checks the file format; it does not verify a purchase or physical work.`);
      }
    });
  } catch (error) {
    const retryable = !(error instanceof DomainError) || ["UPLOAD_NOT_AVAILABLE", "UPLOAD_LIMIT"].includes(error.code);
    await query("UPDATE fp_documents SET state=$4,validation_code=$5,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND lease_id=$3", [row.id, row.tenant_id, leaseId, retryable ? "awaiting_upload" : "rejected", error instanceof DomainError ? error.code : "DOCUMENT_PROCESSING_UNAVAILABLE"]);
    if (!retryable) throw error;
  }
}
export async function validateStoredDocument(...args: Parameters<typeof performDocumentValidation>): Promise<void> {
  try { await withExecutionLease("background:document-validation", () => performDocumentValidation(...args)); }
  catch (error) { if (!(error instanceof DomainError && error.code === "WORKSPACE_MAINTENANCE")) throw error; }
}
export async function documentPreview(session: Session, id: string, pageNumber: number, storage: DocumentStorage = privateDocumentStorage): Promise<Buffer> {
  const row = await requireDocument(session, id);
  await assertSourcePermission(row);
  const page = documentPrivate(row).pages.find(page => page.number === pageNumber);
  if (row.state !== "ready" || !page) throw new DomainError("PREVIEW_NOT_READY", "The private preview is not ready yet.", 404);
  const result = await storage.read(page.pathname, 20 * 1024 * 1024);
  if (result.contentType !== "image/png" || createHash("sha256").update(result.bytes).digest("hex") !== page.sha256) throw new DomainError("PREVIEW_INVALID", "This preview could not be verified.", 409);
  await assertSourcePermission(await requireDocument(session, id));
  return result.bytes;
}
export async function documentOriginal(session: Session, id: string, storage: DocumentStorage = privateDocumentStorage) {
  const row = await requireDocument(session, id);
  await assertSourcePermission(row);
  if (row.state !== "ready" || !row.sha256) throw new DomainError("DOCUMENT_NOT_READY", "Only a validated original can be downloaded.", 409);
  const original = await storage.read(row.pathname);
  if (original.contentType !== row.content_type || createHash("sha256").update(original.bytes).digest("hex") !== row.sha256) throw new DomainError("SOURCE_CHANGED", "This original no longer matches its validated version.", 409);
  await assertSourcePermission(await requireDocument(session, id));
  return { bytes: original.bytes, filename: documentPrivate(row).filename, contentType: row.content_type };
}
export async function importSampleReceipt(session: Session, intentId: string, variant: "original" | "rotated" | "cropped" = "original", storage: DocumentStorage = privateDocumentStorage): Promise<DocumentView> {
  await assertUploader(session, "receipt");
  const original = await readFile(path.join(process.cwd(), "public/samples/outlined/maria-receipt.svg"));
  let image = sharp(original, { density: 192 });
  if (variant === "rotated") image = image.rotate(3, { background: "#ebe7db" });
  if (variant === "cropped") image = image.extract({ left: 36, top: 36, width: 1528, height: 2008 });
  const bytes = await image.png().toBuffer();
  const draft = await createUploadDocument(session, { intentId, filename: `Sample receipt${variant === "original" ? "" : ` (${variant})`}.png`, contentType: "image/png", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), purpose: "receipt", permissionConfirmed: true }, "sample_document", variant);
  if (draft.document.state === "awaiting_upload") await storage.write(draft.pathname, bytes, "image/png");
  return finalizeDocument(session, draft.document.id, storage);
}
