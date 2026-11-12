import { assertSameOrigin, requireSession } from "@/lib/server/auth";
import { guardedApi } from "@/lib/server/maintenance";
import { PRIVATE_HEADERS, privateJson, requestJson, routeFailure } from "@/lib/server/http";
import { DomainError } from "@/lib/domain/money";
import { assertBoardPackContext, captureBoardPack, exportBoardPack, readBoardPack, readBoardPackDesk, readBoardPackImage, readBoardPackSource } from "@/lib/server/board-packs";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
type Context = { params: Promise<{ boardPath?: string[] }> };
async function get(request: Request, context: Context) {
  try {
    const session = await requireSession(); await assertBoardPackContext(session, request.headers.get("X-Fieldproof-Board-Pack-Scope"));
    const parts = (await context.params).boardPath ?? [];
    if (!parts.length) return privateJson({ desk: await readBoardPackDesk(session, new URL(request.url).searchParams.get("before") ?? undefined) });
    if (parts.length === 1) return privateJson({ view: await readBoardPack(session, parts[0]) });
    if (parts.length === 2 && parts[1] === "export") {
      const result = await exportBoardPack(session, parts[0]);
      return new Response(result.csv, { headers: { ...PRIVATE_HEADERS, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${result.filename}"` } });
    }
    if (parts.length === 3 && parts[1] === "sources") return privateJson({ detail: await readBoardPackSource(session, parts[0], parts[2]) });
    if (parts.length === 4 && parts[1] === "sources" && parts[3] === "image") return new Response(new Uint8Array(await readBoardPackImage(session, parts[0], parts[2])), { headers: { ...PRIVATE_HEADERS, "Content-Type": "image/png", "Content-Disposition": 'inline; filename="board-pack-reviewed-image.png"', "Content-Security-Policy": "default-src 'none'; sandbox" } });
    throw new DomainError("BOARD_PACK_ROUTE_UNAVAILABLE", "This Board Pack view is unavailable.", 404);
  } catch (error) { return routeFailure(error); }
}
async function post(request: Request, context: Context) {
  try {
    assertSameOrigin(request); const session = await requireSession(); await assertBoardPackContext(session, request.headers.get("X-Fieldproof-Board-Pack-Scope"));
    const parts = (await context.params).boardPath ?? [];
    if (parts.join("/") === "capture") return privateJson({ view: await captureBoardPack(session, await requestJson(request, 4096)) }, 201);
    throw new DomainError("BOARD_PACK_ACTION_UNAVAILABLE", "This Board Pack action is unavailable.", 404);
  } catch (error) { return routeFailure(error); }
}
export const GET = (request: Request, context: Context) => guardedApi(request, () => get(request, context));
export const POST = (request: Request, context: Context) => guardedApi(request, () => post(request, context));
