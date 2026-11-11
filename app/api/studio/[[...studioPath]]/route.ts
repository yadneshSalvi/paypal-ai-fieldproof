import { z } from "zod";
import { assertSameOrigin, requireSession, setRole } from "@/lib/server/auth";
import { DomainError } from "@/lib/domain/money";
import { privateJson, requestJson, routeFailure } from "@/lib/server/http";
import { guardedApi } from "@/lib/server/maintenance";
import { materializeStudioDataset, readStudioSnapshot } from "@/lib/server/studio-datasets";
import { readStudioReport, saveStudioReport } from "@/lib/server/studio-reports";
import { readStudioAgentRuns, recordStudioClientFinished, recordStudioClientReceipt, runStudioTurn } from "@/lib/server/studio-agents";
import { deleteStudioChat, listStudioChats, readStudioChat, saveStudioChat } from "@/lib/server/studio-chats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Context = { params: Promise<{ studioPath?: string[] }> };

export async function GET(request: Request, context: Context) {
  try {
    const session = await requireSession(), parts = (await context.params).studioPath ?? [], path = parts.join("/");
    if (path === "snapshot") return privateJson({ snapshot: await readStudioSnapshot(session) });
    if (path === "report") return privateJson({ report: await readStudioReport(session) });
    if (path === "agents/runs") return privateJson({ runs: await readStudioAgentRuns(session) });
    if (path === "chats") return privateJson({ threads: await listStudioChats(session) });
    if (parts[0] === "chats" && parts.length === 2) return privateJson({ record: await readStudioChat(session, z.string().min(1).max(220).parse(parts[1])) });
    throw new DomainError("STUDIO_VIEW_NOT_FOUND", "This report view does not exist.", 404);
  } catch (error) { return routeFailure(error); }
}
async function post(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const session = await requireSession(), parts = (await context.params).studioPath ?? [];
    if (parts.join("/") === "agents/turn") return privateJson(await runStudioTurn(session, await requestJson(request, 1_400_000), { signal: request.signal }));
    if (parts.join("/") === "agents/client-receipt") return privateJson(await recordStudioClientReceipt(session, await requestJson(request, 3_400_000)));
    if (parts.join("/") === "agents/finished") return privateJson(await recordStudioClientFinished(session, await requestJson(request, 3_100_000)));
    if (parts.join("/") === "chats/save") {
      const body = z.object({ expectedRevision: z.number().int().nonnegative(), thread: z.unknown() }).strict().parse(await requestJson(request, 3_100_000));
      return privateJson(await saveStudioChat(session, body.expectedRevision, body.thread));
    }
    if (parts.join("/") === "chats/remove") {
      const body = z.object({ expectedRevision: z.number().int().nonnegative(), threadId: z.string().min(1).max(220) }).strict().parse(await requestJson(request));
      return privateJson(await deleteStudioChat(session, body.threadId, body.expectedRevision));
    }
    if (parts[0] === "datasets" && parts[2] === "refresh" && parts.length === 3) {
      if (parts[1] !== session.role) throw new DomainError("STUDIO_ROLE_CHANGED", "The report role changed. Reload the scoped report.", 409);
      z.object({}).strict().parse(await requestJson(request));
      return privateJson({ snapshot: await materializeStudioDataset(session) }, 201);
    }
    if (parts[0] === "report" && parts.length === 1) {
      const body = z.object({ expectedRevision: z.number().int().nonnegative(), history: z.unknown() }).strict().parse(await requestJson(request, 3_100_000));
      return privateJson({ report: await saveStudioReport(session, body.expectedRevision, body.history) });
    }
    if (parts[0] === "role" && parts.length === 1) {
      const { role } = z.object({ role: z.enum(["donor", "volunteer", "organizer", "auditor"]) }).strict().parse(await requestJson(request));
      await setRole(session, role);
      return privateJson({ role });
    }
    throw new DomainError("STUDIO_ACTION_NOT_FOUND", "This report action does not exist.", 404);
  } catch (error) { return routeFailure(error); }
}
export const POST = (request: Request, context: Context) => guardedApi(request, () => post(request, context));
