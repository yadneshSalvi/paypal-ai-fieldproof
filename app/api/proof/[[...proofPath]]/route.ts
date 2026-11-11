import { z } from "zod";
import { assertSameOrigin, requireSession } from "@/lib/server/auth";
import { guardedApi } from "@/lib/server/maintenance";
import { PRIVATE_HEADERS, privateJson, requestJson, routeFailure } from "@/lib/server/http";
import { DomainError } from "@/lib/domain/money";
import { proofDecisionInput, proofDerivativeInput, proofDerivativeReview, proofDraftInput, proofWithdrawInput } from "@/lib/proof/contracts";
import { createProofDerivative, createProofDraft, decideProofSnapshot, privateProofImage, privateProofSource, readProofDesk, reviewProofDerivative, revokeProofDerivative, withdrawProof } from "@/lib/server/proof";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Context = { params: Promise<{ proofPath?: string[] }> };
const image = (bytes: Buffer) => new Response(new Uint8Array(bytes), { headers: { ...PRIVATE_HEADERS, "Content-Type": "image/png", "Content-Disposition": 'inline; filename="private-proof-review.png"', "Content-Security-Policy": "default-src 'none'; sandbox" } });
export async function GET(request: Request, context: Context) {
  return guardedApi(request, async () => {
    try {
      const session = await requireSession(["organizer"]), parts = (await context.params).proofPath ?? [];
      if (!parts.length) return privateJson(await readProofDesk(session));
      if (parts[0] === "images" && parts.length === 2) return image(await privateProofImage(session, z.uuid().parse(parts[1])));
      if (parts[0] === "sources" && parts.length === 2) return image(await privateProofSource(session, z.uuid().parse(parts[1]), z.coerce.number().int().min(1).max(25).parse(new URL(request.url).searchParams.get("page") ?? 1)));
      throw new DomainError("NOT_FOUND", "This proof view is unavailable.", 404);
    } catch (error) { return routeFailure(error); }
  });
}
export async function POST(request: Request, context: Context) {
  return guardedApi(request, async () => {
    try {
      assertSameOrigin(request);
      const session = await requireSession(["organizer"]), parts = (await context.params).proofPath ?? [], raw = await requestJson(request, 24 * 1024);
      if (parts.join("/") === "images") return privateJson(await createProofDerivative(session, proofDerivativeInput.parse(raw)));
      if (parts[0] === "images" && parts[2] === "review" && parts.length === 3) return privateJson(await reviewProofDerivative(session, z.uuid().parse(parts[1]), proofDerivativeReview.parse(raw)));
      if (parts[0] === "images" && parts[2] === "withdraw" && parts.length === 3) {
        const input = z.object({ intentId: z.uuid(), acknowledged: z.literal(true) }).strict().parse(raw);
        return privateJson(await revokeProofDerivative(session, z.uuid().parse(parts[1]), input.intentId));
      }
      if (parts.join("/") === "drafts") return privateJson(await createProofDraft(session, proofDraftInput.parse(raw)));
      if (parts.length === 1 && ["review", "publish"].includes(parts[0])) return privateJson(await decideProofSnapshot(session, parts[0] as "review" | "publish", proofDecisionInput.parse(raw)));
      if (parts[0] === "withdraw" && parts.length === 2) return privateJson(await withdrawProof(session, z.string().max(80).parse(parts[1]), proofWithdrawInput.parse(raw)));
      throw new DomainError("NOT_FOUND", "This proof action is unavailable.", 404);
    } catch (error) { return routeFailure(error); }
  });
}
