import { get, put, BlobPreconditionFailedError } from "@vercel/blob";
import { createHash } from "node:crypto";
import { DomainError } from "../domain/money";
import { MAX_DOCUMENT_BYTES } from "../domain/evidence";
import { assertProviderAccess } from "./provider-access";

export interface StoredDocumentBytes { bytes: Buffer; contentType: string; pathname: string }
export interface DocumentStorage {
  read(pathname: string, maxBytes?: number): Promise<StoredDocumentBytes>;
  write(pathname: string, bytes: Buffer, contentType: string): Promise<void>;
}
export const privateDocumentStorage: DocumentStorage = {
  async read(pathname, maxBytes = MAX_DOCUMENT_BYTES) {
    assertProviderAccess();
    if (!/^fieldproof\/[0-9a-f-]{36}\//.test(pathname) || pathname.includes("..")) throw new DomainError("DOCUMENT_PATH", "The document location could not be verified.", 409);
    const result = await get(pathname, { access: "private", useCache: false, abortSignal: AbortSignal.timeout(20_000) });
    if (!result || result.statusCode !== 200) throw new DomainError("UPLOAD_NOT_AVAILABLE", "The file has not arrived yet. Keep this draft and try checking again.", 409);
    if (result.blob.pathname !== pathname || result.blob.size > maxBytes) { await result.stream.cancel(); throw new DomainError("DOCUMENT_SIZE", "The uploaded document exceeds its allowed size.", 413); }
    const reader = result.stream.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new DomainError("DOCUMENT_SIZE", "The uploaded document exceeds its allowed size.", 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return { bytes: Buffer.concat(chunks), contentType: result.blob.contentType.split(";")[0].trim(), pathname };
  },
  async write(pathname, bytes, contentType) {
    assertProviderAccess();
    try {
      await put(pathname, bytes, { access: "private", addRandomSuffix: false, allowOverwrite: false,
        contentType, cacheControlMaxAge: 60, abortSignal: AbortSignal.timeout(20_000) });
    } catch (error) {
      // A restarted validator may find its own immutable derivative already stored.
      // Compare the bytes; an existing pathname by itself never proves content identity.
      if (!(error instanceof BlobPreconditionFailedError) && !(error instanceof Error && /already exists/i.test(error.message))) throw error;
      const previous = await privateDocumentStorage.read(pathname, Math.max(bytes.length, MAX_DOCUMENT_BYTES));
      const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
      if (previous.contentType !== contentType || hash(previous.bytes) !== hash(bytes)) throw new DomainError("DOCUMENT_CONTENT_CHANGED", "An existing document version has different contents.", 409);
    }
  },
};
