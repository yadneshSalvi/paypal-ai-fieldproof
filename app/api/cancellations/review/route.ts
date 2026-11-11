import { z } from "zod";
import { requireSession } from "@/lib/server/auth";
import { readCancellationReview } from "@/lib/server/cancellation-review";
import { privateJson, routeFailure } from "@/lib/server/http";
import { guardedApi } from "@/lib/server/maintenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return guardedApi(request, async () => {
    try {
      const roundId = z.uuid().parse(new URL(request.url).searchParams.get("roundId"));
      return privateJson(await readCancellationReview(await requireSession(["organizer", "auditor"]), roundId));
    } catch (error) { return routeFailure(error); }
  });
}
