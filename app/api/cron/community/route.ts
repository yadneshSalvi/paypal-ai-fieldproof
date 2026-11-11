import { timingSafeEqual } from "node:crypto";
import { guardedApi } from "@/lib/server/maintenance";
import { initializeDatabase } from "@/lib/server/db";
import { runCommunityJobs } from "@/lib/server/community-model";
import { DomainError } from "@/lib/domain/money";
import { privateJson, routeFailure } from "@/lib/server/http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
async function implementation(request:Request){try{const expected=`Bearer ${process.env.CRON_SECRET??""}`,actual=request.headers.get("authorization")??"";if(!process.env.CRON_SECRET||actual.length!==expected.length||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))throw new DomainError("FORBIDDEN","Scheduler authorization is required.",403);await initializeDatabase();return privateJson(await runCommunityJobs());}catch(error){return routeFailure(error);}}
export const GET=(request:Request)=>guardedApi(request,()=>implementation(request));
