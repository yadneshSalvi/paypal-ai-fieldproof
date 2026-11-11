import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";
import { createCanvas } from "@napi-rs/canvas";
import { DomainError } from "../domain/money";
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_PAGES } from "../domain/evidence";

export const DOCUMENT_PROCESSOR_VERSION = "raster-v1";
const MAX_INPUT_PIXELS = 32_000_000;
const MAX_EDGE = 1800;
export interface RasterPage { number: number; width: number; height: number; bytes: Buffer; sha256: string }
export interface ProcessedDocument { sha256: string; perceptualHash: string; pages: RasterPage[] }
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function matchesDocumentType(bytes: Uint8Array, contentType: string): boolean {
  const b = Buffer.from(bytes.subarray(0, 16));
  if (contentType === "application/pdf") return b.subarray(0, 5).toString("ascii") === "%PDF-";
  if (contentType === "image/png") return b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === "image/jpeg") return b[0] === 255 && b[1] === 216 && b[2] === 255;
  return contentType === "image/webp" && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP";
}
async function raster(bytes: Buffer, number: number): Promise<RasterPage> {
  const source = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "warning", animated: false });
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new DomainError("IMAGE_UNSUPPORTED", "Use a single still image or a PDF.", 422);
  // Re-encoding removes EXIF/GPS and active content; originals never become an inline preview.
  const result = await source.rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }).png().toBuffer({ resolveWithObject: true });
  return { number, bytes: result.data, width: result.info.width, height: result.info.height, sha256: hash(result.data) };
}
async function differenceHash(bytes: Buffer): Promise<string> {
  const pixels = await sharp(bytes).resize(9, 8, { fit: "fill" }).greyscale().raw().toBuffer();
  let bits = 0n;
  for (let row = 0; row < 8; row++) for (let column = 0; column < 8; column++)
    bits = (bits << 1n) | (pixels[row * 9 + column] > pixels[row * 9 + column + 1] ? 1n : 0n);
  return bits.toString(16).padStart(16, "0");
}
export async function processDocumentBytes(bytes: Buffer, contentType: string): Promise<ProcessedDocument> {
  if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) throw new DomainError("DOCUMENT_SIZE", "The document must be no larger than 8 MB.", 413);
  if (!matchesDocumentType(bytes, contentType)) throw new DomainError("DOCUMENT_TYPE_MISMATCH", "The file contents do not match its image or PDF type.", 422);
  const sourceHash = hash(bytes);
  const pages: RasterPage[] = [];
  if (contentType !== "application/pdf") pages.push(await raster(bytes, 1));
  else {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const require = createRequire(import.meta.url);
    const pdfRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, stopAtErrors: true,
      maxImageSize: MAX_INPUT_PIXELS, disableFontFace: true, enableXfa: false,
      useWorkerFetch: false, useWasm: false, useSystemFonts: false,
      standardFontDataUrl: path.join(pdfRoot, "standard_fonts/"), cMapUrl: path.join(pdfRoot, "cmaps/"),
      disableAutoFetch: true, disableRange: true, disableStream: true });
    const abort = setTimeout(() => { void task.destroy(); }, 40_000);
    try {
      const document = await task.promise;
      if (document.numPages > MAX_DOCUMENT_PAGES) throw new DomainError("DOCUMENT_PAGE_LIMIT", "Upload a document of 12 pages or fewer.", 422);
      const [actions, attachments] = await Promise.all([document.hasJSActions(), document.getAttachments()]);
      if (actions || attachments?.size || document.isPureXfa) throw new DomainError("ACTIVE_PDF_REJECTED", "Export this document as a flat PDF or image before uploading it.", 422);
      for (let index = 1; index <= document.numPages; index++) {
        const page = await document.getPage(index);
        if ((await page.getJSActions())?.size) throw new DomainError("ACTIVE_PDF_REJECTED", "Export this document as a flat PDF or image before uploading it.", 422);
        const unit = page.getViewport({ scale: 1 });
        if (![unit.width, unit.height].every(value => Number.isFinite(value) && value > 0)) throw new DomainError("PDF_GEOMETRY", "A page could not be rendered safely.", 422);
        const viewport = page.getViewport({ scale: Math.min(2, MAX_EDGE / Math.max(unit.width, unit.height)) });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE, background: "#ffffff" }).promise;
        pages.push(await raster(canvas.toBuffer("image/png"), index));
        page.cleanup();
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("PDF_UNREADABLE", "This PDF could not be read. Export a flat, unencrypted PDF or upload a photograph.", 422);
    } finally { clearTimeout(abort); await task.destroy(); }
  }
  return { sha256: sourceHash, perceptualHash: await differenceHash(pages[0].bytes), pages };
}
