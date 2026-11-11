import QRCode from "qrcode";
import { z } from "zod";
import { PRIVATE_HEADERS, privateJson, routeFailure } from "@/lib/server/http";
import { DomainError } from "@/lib/domain/money";
import { publicProofImage, readPublicProof } from "@/lib/server/proof";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ slug: string; asset?: string[] }> };
export async function GET(request: Request, context: Context) {
  try {
    const { slug, asset = [] } = await context.params, value = new URL(request.url).searchParams.get("revision");
    const revision = value === null ? undefined : z.coerce.number().int().positive().max(100000).parse(value);
    if (asset[0] === "images" && asset.length === 2) return png(await publicProofImage(slug, z.uuid().parse(asset[1]), revision));
    const proof = await readPublicProof(slug, revision);
    if (asset[0] === "qr" && asset.length === 1) {
      if (proof.state !== "published") throw new DomainError("PUBLIC_PROOF_WITHDRAWN", "This publication is unavailable or withdrawn for review.", 410);
      const base = new URL(process.env.APP_URL ?? "http://localhost:4102");
      if (!["https:", "http:"].includes(base.protocol) || base.username || base.password) throw new DomainError("PUBLIC_URL_UNAVAILABLE", "The public address is not configured.", 503);
      return png(await QRCode.toBuffer(new URL(`/proof/${slug}`, base).href, { type: "png", width: 360, margin: 2, errorCorrectionLevel: "M", color: { dark: "#18354a", light: "#fffdf8" } }));
    }
    if (asset.length) throw new DomainError("NOT_FOUND", "This public record is unavailable.", 404);
    return privateJson(proof, proof.state === "published" ? 200 : proof.state === "withdrawn" ? 410 : 404);
  } catch (error) { return routeFailure(error); }
}
function png(bytes: Buffer) { return new Response(new Uint8Array(bytes), { headers: { ...PRIVATE_HEADERS, "Content-Type": "image/png", "Content-Disposition": 'inline; filename="fieldproof-public-copy.png"', "Content-Security-Policy": "default-src 'none'; sandbox" } }); }
