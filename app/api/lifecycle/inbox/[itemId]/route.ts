import { z } from "zod";
import { DomainError } from "@/lib/domain/money";
import { lifecycleHttp } from "@/lib/server/lifecycle-http";
import { lifecycleInboxDetail } from "@/lib/server/lifecycle-personal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
type Context = { params: Promise<{ itemId: string }> };

export function GET(request: Request, context: Context) {
  return lifecycleHttp(request, async current => {
    if (new URL(request.url).search) throw new DomainError("INVALID_INPUT", "Open this original private item without additional URL fields.", 400);
    return lifecycleInboxDetail(current, z.uuid().parse((await context.params).itemId));
  }, { personal: true });
}
