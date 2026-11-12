import { recognitionGet, recognitionPost } from "@/lib/server/recognition-http";
import { guardedApi } from "@/lib/server/maintenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ recognitionPath?: string[] }> };
export const GET = (request: Request, context: Context) => guardedApi(request, async () => recognitionGet(request, (await context.params).recognitionPath ?? []));
export const POST = (request: Request, context: Context) => guardedApi(request, async () => recognitionPost(request, (await context.params).recognitionPath ?? []));
