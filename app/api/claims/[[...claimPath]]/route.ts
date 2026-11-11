import { guardedApi } from "@/lib/server/maintenance";
import { z } from "zod";
import { assertSameOrigin, requireSession } from "@/lib/server/auth";
import { claimView, claimsView, createClaim, reviewClaim, saveClaimDraft } from "@/lib/server/claims";
import { receiptComparisons } from "@/lib/server/receipt-comparison";
import { privateJson, requestJson, routeFailure } from "@/lib/server/http";
import { draftClaimSchema, reviewClaimSchema } from "@/lib/domain/claims";
import { DomainError } from "@/lib/domain/money";
import { approvePayout, claimPaymentView, preparePayoutReview } from "@/lib/server/payouts";
import { payoutApprovalSchema, payoutSelectionSchema } from "@/lib/domain/payouts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Context = { params: Promise<{ claimPath?: string[] }> };
async function GETImplementation(_request: Request, context: Context) {
  try {
    const session = await requireSession(["volunteer", "organizer"]), parts = (await context.params).claimPath ?? [];
    if (!parts.length) return privateJson({ claims: await claimsView(session) });
    if (parts.length === 2 && parts[1] === "payments") return privateJson(await claimPaymentView(session, z.uuid().parse(parts[0])));
    if (parts.length !== 1) throw new DomainError("NOT_FOUND", "This claim view does not exist.", 404);
    const claim = await claimView(session, z.uuid().parse(parts[0]));
    return privateJson({ claim, comparisons: await receiptComparisons(session, claim.document.id) });
  } catch (error) { return routeFailure(error); }
}
async function POSTImplementation(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const parts = (await context.params).claimPath ?? [], body = await requestJson(request);
    if (!parts.length) {
      const input = z.object({ documentId: z.uuid(), runId: z.uuid().nullable(), intentId: z.uuid() }).strict().parse(body);
      return privateJson({ claim: await createClaim(await requireSession(["volunteer"]), input) }, 201);
    }
    const id = z.uuid().parse(parts[0]);
    if (parts.length !== 2) throw new DomainError("NOT_FOUND", "This claim action does not exist.", 404);
    if (parts[1] === "draft" || parts[1] === "submit") return privateJson({ claim: await saveClaimDraft(await requireSession(["volunteer"]), id, draftClaimSchema.parse(body), parts[1] === "submit") });
    if (parts[1] === "review") return privateJson({ claim: await reviewClaim(await requireSession(["organizer"]), id, reviewClaimSchema.parse(body)) });
    if (parts[1] === "payment-review") return privateJson({ review: await preparePayoutReview(await requireSession(["organizer"]), id, payoutSelectionSchema.parse(body)) });
    if (parts[1] === "payment-approval") return privateJson({ payable: await approvePayout(await requireSession(["organizer"]), id, payoutApprovalSchema.parse(body)) });
    throw new DomainError("NOT_FOUND", "This claim action does not exist.", 404);
  } catch (error) { return routeFailure(error); }
}

export const GET = (...args: Parameters<typeof GETImplementation>) => guardedApi(args[0], () => GETImplementation(...args));

export const POST = (...args: Parameters<typeof POSTImplementation>) => guardedApi(args[0], () => POSTImplementation(...args));
