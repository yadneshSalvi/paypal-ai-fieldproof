import { z } from "zod";
import { DomainError } from "@/lib/domain/money";
import { lifecycleHttp } from "@/lib/server/lifecycle-http";
import { lifecyclePersonalSourceDetail } from "@/lib/server/lifecycle-personal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
type Context = { params: Promise<{ itemId: string; sourceId: string }> };

export function GET(request: Request, context: Context) {
  return lifecycleHttp(request, async current => {
    if (new URL(request.url).search) throw new DomainError("INVALID_INPUT", "Open this exact private source without additional URL fields.", 400);
    const params = await context.params;
    return lifecyclePersonalSourceDetail(current, z.uuid().parse(params.itemId), z.string().regex(/^[a-zA-Z0-9:_-]{1,180}$/).parse(params.sourceId));
  }, { personal: true });
}
