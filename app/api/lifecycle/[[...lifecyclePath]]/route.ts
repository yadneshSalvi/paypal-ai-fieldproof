import {z} from "zod";
import * as C from "@/lib/lifecycle/contracts";
import {orgPortfolioFilterSchema} from "@/lib/organizations/contracts";
import {DomainError} from "@/lib/domain/money";
import {lifecycleHttp} from "@/lib/server/lifecycle-http";
import {lifecycleContext} from "@/lib/server/lifecycle-core";
import {lifecycleTargets} from "@/lib/server/lifecycle-sources";
import {changeLifecycleProgram} from "@/lib/server/lifecycle-program";
import {changeLifecycleSchedule,enableLifecycleSchedule,lifecycleScheduleDetail,lifecycleSchedules,prepareLifecycleSchedule} from "@/lib/server/lifecycle-schedules";
import {changeLifecycleOccurrence,lifecycleOccurrenceAttempts,lifecycleOccurrenceDetail,lifecycleOccurrenceSource,lifecycleOccurrences,retryLifecycleOccurrence,reviewLifecycleOccurrence} from "@/lib/server/lifecycle-occurrences";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
type Context={params:Promise<{lifecyclePath?:string[]}>};
const unavailable=()=>new DomainError("LIFECYCLE_RESOURCE_UNAVAILABLE","This lifecycle route is unavailable.",404);
function queryParams(request:Request,allowed:string[]) {
  const params=new URL(request.url).searchParams;
  if([...params.keys()].some(key=>!allowed.includes(key)||params.getAll(key).length!==1))throw new DomainError("INVALID_INPUT","Keep one exact audience/filter or saved page position for this lifecycle read.",400);
  return params;
}
export async function GET(request:Request,context:Context) {
  const parts=(await context.params).lifecyclePath??[],route=parts.join("/");
  return lifecycleHttp(request,current=>{
    if(route==="context"){queryParams(request,[]);return lifecycleContext(current);}
    if(route==="schedules"||route==="occurrences"){
      const params=queryParams(request,["before"]),before=z.string().max(500).optional().parse(params.get("before")??undefined);
      return route==="schedules"?lifecycleSchedules(current,before):lifecycleOccurrences(current,before);
    }
    if(route==="targets"){
      const params=queryParams(request,["audience","filters"]),audience=C.lifecycleAudienceSchema.parse(params.get("audience"));
      let filters:unknown;try{filters=params.has("filters")?JSON.parse(params.get("filters")!):undefined;}catch{throw new DomainError("INVALID_INPUT","Use a valid exact aggregate filter.",400);}
      if(audience==="project_treasurer"&&filters!==undefined)throw new DomainError("INVALID_INPUT","A private project target has no aggregate filter.",400);
      return lifecycleTargets(current,audience,orgPortfolioFilterSchema.optional().parse(filters));
    }
    if(parts[0]==="schedules"&&parts.length===2){queryParams(request,[]);return lifecycleScheduleDetail(current,z.uuid().parse(parts[1]));}
    if(parts[0]==="occurrences") {
      const id=z.uuid().parse(parts[1]);
      if(parts.length===2){queryParams(request,[]);return lifecycleOccurrenceDetail(current,id);}
      if(parts.length===3&&parts[2]==="attempts")return lifecycleOccurrenceAttempts(current,id,z.string().max(500).optional().parse(queryParams(request,["before"]).get("before")??undefined));
      if(parts.length===4&&parts[2]==="sources"){queryParams(request,[]);return lifecycleOccurrenceSource(current,id,z.string().regex(/^[A-Za-z0-9:_-]{1,180}$/).parse(parts[3]));}
    }
    throw unavailable();
  },{bootstrap:route==="context"});
}
export async function POST(request:Request,context:Context) {
  const parts=(await context.params).lifecyclePath??[],route=parts.join("/");
  return lifecycleHttp(request,(current,raw)=>{
    if(route==="program/enable"||route==="program/disable")return changeLifecycleProgram(current,parts[1] as "enable"|"disable",raw);
    if(route==="schedules/prepare")return prepareLifecycleSchedule(current,raw);
    if(route==="schedules")return enableLifecycleSchedule(current,raw);
    if(parts[0]==="schedules"&&parts.length===3&&parts[2]==="state")return changeLifecycleSchedule(current,z.uuid().parse(parts[1]),raw);
    if(parts[0]==="occurrences"&&parts.length===3){
      const id=z.uuid().parse(parts[1]);
      if(parts[2]==="retry")return retryLifecycleOccurrence(current,id,raw);
      if(parts[2]==="review")return reviewLifecycleOccurrence(current,id,raw);
      if(parts[2]==="state")return changeLifecycleOccurrence(current,id,raw);
    }
    throw unavailable();
  });
}
