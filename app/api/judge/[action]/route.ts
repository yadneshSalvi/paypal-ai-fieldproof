import { z } from "zod";
import { assertSameOrigin, getSession } from "@/lib/server/auth";
import { privateJson, requestJson, routeFailure } from "@/lib/server/http";
import { judgeScenario, resetJudgeScenario, startJudgeScenario } from "@/lib/server/judge";
import { guardedApi } from "@/lib/server/maintenance";
import { projectSnapshot } from "@/lib/server/repository";
import { DomainError } from "@/lib/domain/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Context = { params: Promise<{ action: string }> };

/** The visitor's own judge scenario, or null. Reads only the session in this browser's cookie. */
async function GETImplementation(_request: Request, context: Context) {
  try {
    if ((await context.params).action !== "state") throw new DomainError("NOT_FOUND", "This endpoint does not exist.", 404);
    return privateJson({ scenario: await judgeScenario(await getSession()) });
  } catch (error) { return routeFailure(error); }
}
async function POSTImplementation(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const action = (await context.params).action, body = await requestJson(request, 2048);
    if (action === "start") {
      const { intent } = z.object({ intent: z.enum(["tour", "workspace"]) }).strict().parse(body);
      const started = await startJudgeScenario(intent);
      return privateJson({ scenario: started.scenario, created: started.created, snapshot: await projectSnapshot(started.session) }, started.created ? 201 : 200);
    }
    if (action === "reset") {
      z.object({ confirm: z.literal(true) }).strict().parse(body);
      const reset = await resetJudgeScenario();
      return privateJson({ scenario: reset.scenario, revokedPrevious: reset.revokedPrevious, snapshot: await projectSnapshot(reset.session) }, 201);
    }
    throw new DomainError("NOT_FOUND", "This endpoint does not exist.", 404);
  } catch (error) { return routeFailure(error); }
}
export const GET = (...args: Parameters<typeof GETImplementation>) => guardedApi(args[0], () => GETImplementation(...args));
export const POST = (...args: Parameters<typeof POSTImplementation>) => guardedApi(args[0], () => POSTImplementation(...args));
