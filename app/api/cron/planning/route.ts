import { timingSafeEqual } from "node:crypto";
import { guardedApi } from "@/lib/server/maintenance";
import { initializeDatabase, query } from "@/lib/server/db";
import { expirePlanExtractions, nextPlanContinuations, runPlanExtraction } from "@/lib/server/planning-extraction";
import { DomainError } from "@/lib/domain/money";
import { privateJson, routeFailure } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
async function GETImplementation(request: Request) {
  try {
    const supplied = request.headers.get("authorization") ?? "", expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
    if (!process.env.CRON_SECRET || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new DomainError("FORBIDDEN", "Scheduler authorization is required.", 403);
    await initializeDatabase();
    const expired = await expirePlanExtractions(), ids = await nextPlanContinuations(undefined, 5);
    // These independent GET polls observe each original response within its recovery window.
    await Promise.all(ids.map(id => runPlanExtraction(id)));
    const [queued] = await query<{ id: string }>("SELECT id FROM fp_plan_runs WHERE state='queued' AND provider='openai' ORDER BY created_at LIMIT 1");
    if (queued) await runPlanExtraction(queued.id);
    return privateJson({ resumed: ids.length, submitted: queued ? 1 : 0, expired });
  } catch (error) { return routeFailure(error); }
}
export const GET = (...args: Parameters<typeof GETImplementation>) => guardedApi(args[0], () => GETImplementation(...args));
