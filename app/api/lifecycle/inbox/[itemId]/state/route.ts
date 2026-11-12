import { z } from "zod";
import { lifecycleHttp } from "@/lib/server/lifecycle-http";
import { lifecycleSetInboxState } from "@/lib/server/lifecycle-personal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
type Context = { params: Promise<{ itemId: string }> };

export function POST(request: Request, context: Context) {
  return lifecycleHttp(request, async (current, raw) => lifecycleSetInboxState(current, z.uuid().parse((await context.params).itemId), raw), { personal: true });
}
