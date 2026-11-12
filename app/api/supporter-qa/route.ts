import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, sessionForToken, writeSessionCookie } from "@/lib/server/auth";
import { supporterQaActors } from "@/lib/server/supporter-qa";
import { supporterQaEnabled } from "@/lib/server/provider-access";
import { DomainError } from "@/lib/domain/money";
import { privateJson, PRIVATE_HEADERS, routeFailure } from "@/lib/server/http";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request){
  try{
    if(!supporterQaEnabled())return privateJson({error:"This fixture is unavailable.",code:"NOT_FOUND"},404);
    assertSameOrigin(request);
    if(Number(request.headers.get("content-length")??0)>2048)throw new DomainError("INPUT_TOO_LARGE","Choose one saved fixture actor.",413);
    const form=await request.formData(),key=z.string().regex(/^[a-z0-9-]{1,40}$/).parse(form.get("actor"));
    const actor=supporterQaActors().find(row=>row.key===key);if(!actor)throw new DomainError("NOT_FOUND","That fixture actor is unavailable.",404);
    const session=await sessionForToken(actor.token);if(!session)throw new DomainError("SESSION_REQUIRED","This original fixture session expired or its access changed. The review never renews it.",401);
    if(session.mode!=="sample")throw new DomainError("QA_PROVENANCE","The review chooser permits only clearly labelled Sample actors.",403);
    await writeSessionCookie(actor.token,session.expiresAt);
    return NextResponse.redirect(new URL("/updates",request.url),{status:303,headers:PRIVATE_HEADERS});
  }catch(error){return routeFailure(error);}
}
