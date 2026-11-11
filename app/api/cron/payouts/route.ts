import { guardedApi } from "@/lib/server/maintenance";
import { timingSafeEqual } from "node:crypto";
import { initializeDatabase } from "@/lib/server/db";
import { reconcilePayouts } from "@/lib/server/payouts";
import { privateJson, routeFailure } from "@/lib/server/http";
import { DomainError } from "@/lib/domain/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
async function GETImplementation(request: Request) {
  try {
    const supplied = Buffer.from(request.headers.get("authorization") ?? ""), expected = Buffer.from(`Bearer ${process.env.CRON_SECRET ?? ""}`);
    if (!process.env.CRON_SECRET || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new DomainError("FORBIDDEN", "Scheduler authorization is required.", 403);
    await initializeDatabase();
    return privateJson(await reconcilePayouts());
  } catch (error) { return routeFailure(error); }
}

export const GET = (...args: Parameters<typeof GETImplementation>) => guardedApi(args[0], () => GETImplementation(...args));
