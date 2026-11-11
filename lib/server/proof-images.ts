import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ProofRegion } from "../proof/contracts";
import { DomainError } from "../domain/money";
import { validImageRegion } from "./planning-images";

/** Masks are rasterized before cropping; no original text/metadata layer survives. */
export async function renderProofImage(bytes: Buffer, crop: ProofRegion, masks: ProofRegion[], sample: boolean) {
  if (!validImageRegion(crop) || masks.some(mask => !validImageRegion(mask))) throw new DomainError("PROOF_IMAGE_REGION", "Keep every crop and mask inside the source page.", 422);
  const metadata = await sharp(bytes, { limitInputPixels: 36_000_000 }).metadata();
  const width = metadata.width!, height = metadata.height!;
  if (!width || !height) throw new DomainError("PROOF_IMAGE_INVALID", "Choose a validated raster page.", 422);
  const maskSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${masks.map(m => `<rect x="${Math.floor(m.x * width)}" y="${Math.floor(m.y * height)}" width="${Math.ceil(m.width * width) + 1}" height="${Math.ceil(m.height * height) + 1}" fill="#18354a"/>`).join("")}</svg>`);
  const masked = await sharp(bytes, { limitInputPixels: 36_000_000 }).composite(masks.length ? [{ input: maskSvg }] : []).png().toBuffer();
  const left = Math.floor(crop.x * width), top = Math.floor(crop.y * height);
  const cropped = await sharp(masked).extract({ left, top, width: Math.min(width, Math.ceil((crop.x + crop.width) * width)) - left, height: Math.min(height, Math.ceil((crop.y + crop.height) * height)) - top })
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).flatten({ background: "#fffdf7" }).png().toBuffer({ resolveWithObject: true });
  const stampHeight = 40, fontSize = Math.max(6, Math.min(13, Math.floor(cropped.info.width / 70)));
  const stamp = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cropped.info.width}" height="40"><rect width="100%" height="100%" fill="#fffdf7"/><text x="10" y="25" font-family="Arial,sans-serif" font-size="${fontSize}" fill="#18354a">${sample ? "SAMPLE EVIDENCE · FICTIONAL SOURCE · PUBLIC COPY" : "REDACTED PUBLIC COPY · SCOPE SHOWN ON PROOF PAGE"}</text></svg>`);
  const output = await sharp(cropped.data).extend({ bottom: stampHeight, background: "#fffdf7" }).composite([{ input: stamp, left: 0, top: cropped.info.height }]).png().toBuffer();
  return { bytes: output, width: cropped.info.width, height: cropped.info.height + stampHeight, sha256: createHash("sha256").update(output).digest("hex") };
}
