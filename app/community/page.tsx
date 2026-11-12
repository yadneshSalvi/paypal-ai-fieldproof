import { cookies } from "next/headers";
import { sessionCookieName } from "@/lib/server/auth";
import { readWorkspaceLibrary, workspaceLibraryCookieName } from "@/lib/server/community-workspaces";
import { TemplateLibrary } from "@/components/community/template-library";
import { withExecutionLease } from "@/lib/server/maintenance";
import { DomainError } from "@/lib/domain/money";
export const dynamic="force-dynamic";
export default async function Page({searchParams}:{searchParams:Promise<{return?:string}>}){
  const jar=await cookies(),params=await searchParams;
  const returnPath=["/","/planning","/studio","/update-desk","/updates","/my-contribution","/organizer","/proof-desk","/funding","/board-pack","/organizations","/lifecycle"].includes(params.return??"")?params.return!:"/";
  const libraryToken=jar.get(workspaceLibraryCookieName())?.value??null,activeToken=jar.get(sessionCookieName())?.value??null;
  let initial;
  try { initial=await withExecutionLease("community.workspace-library",()=>readWorkspaceLibrary(libraryToken,activeToken)); }
  catch(error) { if(!(error instanceof DomainError)||error.code!=="WORKSPACE_MAINTENANCE")throw error; initial=await readWorkspaceLibrary(libraryToken,activeToken,false); }
  return <TemplateLibrary initial={initial} returnPath={returnPath}/>;
}
