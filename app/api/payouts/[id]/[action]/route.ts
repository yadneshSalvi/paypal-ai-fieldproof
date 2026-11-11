import { guardedApi } from "@/lib/server/maintenance";
import { z } from "zod";
import { assertSameOrigin, requireSession } from "@/lib/server/auth";
import { cancelUnclaimedPayout, checkPayout, releasePayout, sendPayout } from "@/lib/server/payouts";
import { privateJson, requestJson, routeFailure } from "@/lib/server/http";
import { DomainError } from "@/lib/domain/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
async function POSTImplementation(request: Request, context: { params: Promise<{ id: string; action: string }> }) {
  try {
    assertSameOrigin(request);
    const { id: rawId, action } = await context.params, id = z.uuid().parse(rawId), body = await requestJson(request);
    if (action === "check") {
      z.object({}).strict().parse(body);
      return privateJson({ payable: await checkPayout(await requireSession(["volunteer", "organizer"]), id) });
    }
    z.object({ acknowledged: z.literal(true) }).strict().parse(body);
    const session = await requireSession(["organizer"]);
    if (action === "send" || action === "retry-original") return privateJson({ payable: await sendPayout(session, id, action === "retry-original") });
    if (action === "release") return privateJson({ payable: await releasePayout(session, id) });
    if (action === "cancel-unclaimed") return privateJson({ payable: await cancelUnclaimedPayout(session, id) });
    throw new DomainError("NOT_FOUND", "This repayment action does not exist.", 404);
  } catch (error) { return routeFailure(error); }
}

export const POST = (...args: Parameters<typeof POSTImplementation>) => guardedApi(args[0], () => POSTImplementation(...args));
