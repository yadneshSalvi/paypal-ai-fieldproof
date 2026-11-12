import {timingSafeEqual} from "node:crypto";
import {DomainError} from "@/lib/domain/money";
import {privateJson,routeFailure} from "@/lib/server/http";
import {withExecutionLease} from "@/lib/server/maintenance";
import {runLifecycleSchedules} from "@/lib/server/lifecycle-worker";
import {runLifecyclePersonalPage} from "@/lib/server/lifecycle-observer";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
export async function GET(request:Request) {
  try{
    const expected=Buffer.from(`Bearer ${process.env.CRON_SECRET??""}`),actual=Buffer.from(request.headers.get("authorization")??"");
    if(!process.env.CRON_SECRET||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new DomainError("FORBIDDEN","Scheduler authorization is required.",403);
    if(new URL(request.url).search)throw new DomainError("INVALID_INPUT","Scheduled work uses its retained server-side cursor, not a URL override.",400);
    return await withExecutionLease("GET bounded private lifecycle work",async()=>privateJson({personal:await runLifecyclePersonalPage(5),schedules:await runLifecycleSchedules({definitions:5,occurrences:5,slotsPerDefinition:20}),providerCalls:0,modelCalls:0,emailSends:0}));
  }catch(error){return routeFailure(error);}
}
