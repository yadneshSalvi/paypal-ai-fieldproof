import { createHash } from "node:crypto";
import sharp from "sharp";
import type { AlignmentView, PlanSourceBinding } from "../planning/contracts";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { query } from "./db";
import { documentPrivate, type DocumentRow } from "./documents";
import type { DocumentStorage } from "./document-storage";

export interface SharedAlignmentImage { pathname: string; sha256: string; width: number; height: number; }
type Region = AlignmentView["displayCrop"];
export function validImageRegion(region: Region): boolean { return [region.x, region.y, region.width, region.height].every(Number.isFinite) && region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 && region.x + region.width <= 1.000000001 && region.y + region.height <= 1.000000001; }
export async function redactPlanningImage(bytes: Buffer, crop: Region, redactions: Region[], sample: boolean): Promise<{ bytes: Buffer; width: number; height: number }> {
  if (!validImageRegion(crop) || redactions.some(region => !validImageRegion(region))) throw new DomainError("IMAGE_REGION_INVALID", "Keep the crop and redaction boxes inside the source image.", 422);
  const metadata = await sharp(bytes, { limitInputPixels: 36_000_000 }).metadata(), width = metadata.width ?? 0, height = metadata.height ?? 0;
  if (width < 1 || height < 1) throw new DomainError("PHOTO_IMAGE_INVALID", "This photo page has no valid dimensions.", 422);
  const left = Math.floor(crop.x * width), top = Math.floor(crop.y * height), right = Math.min(width, Math.ceil((crop.x + crop.width) * width)), bottom = Math.min(height, Math.ceil((crop.y + crop.height) * height));
  if (right - left < 64 || bottom - top < 64) throw new DomainError("IMAGE_CROP_TOO_SMALL", "Choose a crop at least 64 pixels wide and high so the reviewed image remains legible.", 422);
  // Numeric rectangles are rasterized as opaque pixels before extraction. No source
  // metadata, hidden layers, original URL, or redacted text is copied to the rendition.
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${redactions.map(r => `<rect x="${Math.floor(r.x * width)}" y="${Math.floor(r.y * height)}" width="${Math.ceil(r.width * width) + 1}" height="${Math.ceil(r.height * height) + 1}" fill="#182c40"/>`).join("")}</svg>`);
  const masked = await sharp(bytes, { limitInputPixels: 36_000_000 }).composite(redactions.length ? [{ input: mask }] : []).png().toBuffer();
  const result = await sharp(masked).extract({ left, top, width: right - left, height: bottom - top }).resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
  const stampHeight = Math.min(58, Math.max(18, Math.floor(result.info.height * .14))), fontSize = Math.max(6, Math.min(15, Math.floor(result.info.width / 66)));
  const label = sample ? "SAMPLE ILLUSTRATION · NOT A SITE PHOTOGRAPH" : "REVIEWED IMAGE ASSOCIATION · NO SAFETY OR COMPLETION CERTIFICATION";
  const stamp = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${result.info.width}" height="${stampHeight}"><rect width="100%" height="100%" fill="#fffdf7"/><text x="10" y="${Math.floor(stampHeight / 2 + fontSize / 3)}" font-family="Arial,sans-serif" font-size="${fontSize}" fill="#1e3a5f">${label}</text></svg>`);
  const output = await sharp(result.data).composite([{ input: stamp, left: 0, top: result.info.height - stampHeight }]).png().toBuffer();
  return { bytes: output, width: result.info.width, height: result.info.height };
}
export async function prepareAlignmentImage(scope: Pick<Session, "tenantId" | "projectId">, id: string, source: PlanSourceBinding, pageNumber: number, crop: Region, redactions: Region[], storage: DocumentStorage): Promise<SharedAlignmentImage> {
  const [document] = await query<DocumentRow>("SELECT * FROM fp_documents WHERE id=$1 AND tenant_id=$2 AND project_id=$3", [source.documentId, scope.tenantId, scope.projectId]);
  const page = document && documentPrivate(document).pages.find(p => p.number === pageNumber);
  if (!page || !source.pageHashes.includes(page.sha256)) throw new DomainError("PHOTO_SOURCE_CHANGED", "Choose a validated source page for this association.", 409);
  const original = await storage.read(page.pathname, 20 * 1024 * 1024);
  if (original.contentType !== "image/png" || createHash("sha256").update(original.bytes).digest("hex") !== page.sha256) throw new DomainError("PHOTO_SOURCE_CHANGED", "The source page no longer matches its validated bytes.", 409);
  const rendered = await redactPlanningImage(original.bytes, crop, redactions, source.provenance === "sample_document");
  const pathname = `fieldproof/${source.documentId}/planning-alignment/${id}/reviewed-image.png`, sha256 = createHash("sha256").update(rendered.bytes).digest("hex");
  await storage.write(pathname, rendered.bytes, "image/png");
  return { pathname, sha256, width: rendered.width, height: rendered.height };
}
