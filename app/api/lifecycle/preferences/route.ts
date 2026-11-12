import { lifecycleHttp } from "@/lib/server/lifecycle-http";
import { lifecycleSetPreferences } from "@/lib/server/lifecycle-personal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export function POST(request: Request) {
  return lifecycleHttp(request, lifecycleSetPreferences, { personal: true });
}
