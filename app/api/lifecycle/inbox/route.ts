import { z } from "zod";
import { DomainError } from "@/lib/domain/money";
import { lifecycleReadStateSchema } from "@/lib/lifecycle/contracts";
import { lifecycleHttp } from "@/lib/server/lifecycle-http";
import { lifecycleInbox } from "@/lib/server/lifecycle-personal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export function GET(request: Request) {
  return lifecycleHttp(request, current => {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !["state", "before"].includes(key) || params.getAll(key).length !== 1)) throw new DomainError("INVALID_INPUT", "Use only one original inbox state and saved page position.", 400);
    return lifecycleInbox(current, { state: lifecycleReadStateSchema.optional().parse(params.get("state") ?? undefined), before: z.string().max(500).optional().parse(params.get("before") ?? undefined) });
  }, { personal: true });
}
