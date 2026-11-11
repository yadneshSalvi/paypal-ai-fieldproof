import { after } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { assertSameOrigin, getSession, requireSession, sessionCookieName, writeSessionCookie } from "@/lib/server/auth";
import { guardedApi } from "@/lib/server/maintenance";
import { privateJson, requestJson, routeFailure } from "@/lib/server/http";
import { DomainError } from "@/lib/domain/money";
import { switchWorkspaceSchema } from "@/lib/community/contracts";
import { createCommunityWorkspace, readWorkspaceLibrary, rememberWorkspaceCookie, switchCommunityWorkspace, workspaceLibraryCookieName } from "@/lib/server/community-workspaces";
import { captureCommunitySnapshot, previewCommunityUpdate, readCommunityDesk, readSupporterStory, reviewCommunityTranslation, saveCommunityBackTranslation, saveCommunityDraft, saveCommunityTranslation } from "@/lib/server/community";
import { communityContinuations, resumeCommunityRun, runCommunityModel, startCommunityRun } from "@/lib/server/community-model";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
type Context={params:Promise<{communityPath?:string[]}>};
async function library(){const jar=await cookies();return readWorkspaceLibrary(jar.get(workspaceLibraryCookieName())?.value??null,jar.get(sessionCookieName())?.value??null);}
async function GETImplementation(_request:Request,context:Context){
  try{
    const path=(await context.params).communityPath?.join("/")??"";
    if(path==="workspaces")return privateJson({library:await library()});
    const session=await requireSession();
    if(path==="supporter")return privateJson({story:await readSupporterStory(session)});
    if(!path){const desk=await readCommunityDesk(session);if(session.role==="organizer")for(const id of await communityContinuations(session))after(()=>runCommunityModel(id));return privateJson({desk});}
    throw new DomainError("NOT_FOUND","This community workspace view is unavailable.",404);
  }catch(error){return routeFailure(error);}
}
async function POSTImplementation(request:Request,context:Context){
  try{
    assertSameOrigin(request);const parts=(await context.params).communityPath??[],path=parts.join("/"),body=await requestJson(request,128*1024);
    if(path==="workspaces/remember"){z.object({}).strict().parse(body);await rememberWorkspaceCookie();return privateJson({library:await library()});}
    if(path==="workspaces/create"||path==="workspaces/switch"){
      const jar=await cookies(),libraryToken=jar.get(workspaceLibraryCookieName())?.value,activeToken=jar.get(sessionCookieName())?.value??null;
      if(!libraryToken)throw new DomainError("WORKSPACE_LIBRARY_REQUIRED","Save the current workspace before creating or switching projects.",409);
      let result;
      if(path.endsWith("create"))result=await createCommunityWorkspace(libraryToken,activeToken,body);
      else{const input=switchWorkspaceSchema.parse(body);result=await switchCommunityWorkspace(libraryToken,activeToken,input.sessionId,input.expectedProjectId);}
      await writeSessionCookie(result.token,result.session.expiresAt);
      return privateJson({projectId:result.session.projectId,expiresAt:result.session.expiresAt,role:result.session.role});
    }
    const session=await requireSession(["organizer"]);
    let result:{id:string};
    if(path==="snapshots")result=await captureCommunitySnapshot(session,body);
    else if(path==="drafts")result=await saveCommunityDraft(session,body);
    else if(path==="translations")result=await saveCommunityTranslation(session,body);
    else if(path==="backtranslations")result=await saveCommunityBackTranslation(session,body);
    else if(path==="reviews")result=await reviewCommunityTranslation(session,body);
    else if(path==="previews")result=await previewCommunityUpdate(session,body);
    else if(path==="runs"){result=await startCommunityRun(session,body);after(()=>runCommunityModel(result.id));}
    else if(parts[0]==="runs"&&parts.length===3&&parts[2]==="resume"){z.object({}).strict().parse(body);const id=z.uuid().parse(parts[1]);await resumeCommunityRun(session,id);after(()=>runCommunityModel(id));result={id};}
    else throw new DomainError("NOT_FOUND","This community workspace action is unavailable.",404);
    return privateJson({...result,desk:await readCommunityDesk(session)});
  }catch(error){return routeFailure(error);}
}
export const GET=(...args:Parameters<typeof GETImplementation>)=>guardedApi(args[0],()=>GETImplementation(...args));
export const POST=(...args:Parameters<typeof POSTImplementation>)=>guardedApi(args[0],()=>POSTImplementation(...args));
