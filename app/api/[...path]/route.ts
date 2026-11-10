import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { PaymentError, SqlPaymentStore } from "@fracture/paypal-core";
import { z, ZodError } from "zod";
import { assertSameOrigin, getSession, requireSession, setRole, startSession } from "@/lib/server/auth";
import { projectSnapshot, addSamplePledge, advanceTour } from "@/lib/server/repository";
import { applicationOrigin, captureCheckout, checkCheckoutIntent, createCheckout, ingestPaymentOperation, ownedPayment, paymentCore } from "@/lib/server/payments";
import { completeIdentity, identityStart, recipientView } from "@/lib/server/identity";
import { DomainError } from "@/lib/domain/money";
import { database, initializeDatabase, query } from "@/lib/server/db";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
type Context={params:Promise<{path:string[]}>};
const roleSchema=z.enum(["donor","volunteer","organizer","auditor"]);
function json(value:unknown,status=200){return NextResponse.json(value,{status,headers:{"Cache-Control":"no-store"}});}
function failure(error:unknown){
  if(error instanceof DomainError) return json({error:error.message,code:error.code},error.status);
  if(error instanceof PaymentError) return json({error:error.message,code:error.code},error.httpStatus);
  if(error instanceof ZodError || error instanceof SyntaxError) return json({error:"Check the submitted fields and try again.",code:"INVALID_INPUT"},400);
  const requestId=randomUUID();
  console.error(JSON.stringify({event:"request.failed",requestId,errorType:error instanceof Error?error.name:"unknown"}));
  return json({error:"This action could not finish. Your existing payment has not been retried. Refresh to check its status.",code:"INTERNAL_ERROR",requestId},500);
}
async function input(request:Request){
  const text=await request.text();
  if(text.length>20000) throw new DomainError("INPUT_TOO_LARGE","This request is too large.",413);
  return JSON.parse(text||"{}");
}
export async function GET(request:Request,context:Context){
  const path=(await context.params).path.join("/");
  try{
    if(path==="snapshot") return json(await projectSnapshot(await getSession()));
    if(path==="health") {await initializeDatabase();await query("SELECT 1");return json({status:"ok",storage:"postgresql",project:"fieldproof",environment:"sandbox"});}
    if(path==="paypal/config") {await requireSession(["donor"]);return json({clientId:process.env.PAYPAL_CLIENT_ID??null,currency:"USD",environment:"sandbox"});}
    if(path==="recipient") return json({recipient:await recipientView(await requireSession())});
    if(path==="auth/paypal"){
      if(request.headers.get("sec-fetch-site")==="cross-site") throw new DomainError("ORIGIN_DENIED","Start account linking from Fieldproof.",403);
      return NextResponse.redirect(await identityStart(await requireSession(["donor","volunteer"])));
    }
    if(path==="auth/paypal/callback"){
      const url=new URL(request.url);
      if(url.searchParams.has("error")) return NextResponse.redirect(new URL("/my-expenses?identity=cancelled",applicationOrigin()));
      const data=z.object({state:z.string().min(16).max(512),code:z.string().min(1).max(4096)}).parse({state:url.searchParams.get("state"),code:url.searchParams.get("code")});
      try{await completeIdentity(await requireSession(["donor","volunteer"]),data.state,data.code);return NextResponse.redirect(new URL("/my-expenses?identity=linked",applicationOrigin()));}
      catch(error){const reason=error instanceof DomainError?error.code:"IDENTITY_UNAVAILABLE";return NextResponse.redirect(new URL(`/my-expenses?identity=${encodeURIComponent(reason)}`,applicationOrigin()));}
    }
    if(path.startsWith("payments/"))return json(await ownedPayment(await requireSession(),path.slice("payments/".length)));
    if(path==="cron/reconcile"){
      const supplied=request.headers.get("authorization")??"",expected=`Bearer ${process.env.CRON_SECRET??""}`;
      if(!process.env.CRON_SECRET || supplied.length!==expected.length || !timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))) throw new DomainError("FORBIDDEN","Scheduler authorization is required.",403);
      await initializeDatabase();
      const scopes=await query<{tenant_id:string;project_id:string}>("SELECT DISTINCT tenant_id,project_id FROM fp_payment_commands WHERE created_at>now()-interval '7 days' LIMIT 20");
      let observed=0;
      for(const scope of scopes){
        const ownedScope={tenantId:scope.tenant_id,projectId:scope.project_id};
        await paymentCore().recover(ownedScope);
        // Reapply persisted completed receipts too: the request may have died between provider persistence and domain projection.
        for(const operation of await new SqlPaymentStore(database()).list(ownedScope)){await ingestPaymentOperation(operation);observed++;}
      }
      return json({scopes:scopes.length,observed});
    }
    throw new DomainError("NOT_FOUND","This endpoint does not exist.",404);
  }catch(error){return failure(error);}
}
export async function POST(request:Request,context:Context){
  try{
    assertSameOrigin(request);
    const path=(await context.params).path.join("/"),body=await input(request);
    if(path==="session"){
      const {mode}=z.object({mode:z.enum(["sample","live_sandbox"]).default("sample")}).strict().parse(body);
      return json(await projectSnapshot(await startSession(mode)),201);
    }
    if(path==="session/role"){
      const {role}=z.object({role:roleSchema}).strict().parse(body),session=await requireSession();
      await setRole(session,role);return json(await projectSnapshot({...session,role}));
    }
    if(path==="pledges"){
      const data=z.object({amountMinor:z.number().int().min(100).max(100000),packageId:z.string().min(1).max(64),expectedVersion:z.number().int().positive(),intentId:z.uuid()}).strict().parse(body),session=await requireSession(["donor"]);
      await addSamplePledge(session,data);return json(await projectSnapshot(session),201);
    }
    if(path==="tour"){
      const {step}=z.object({step:z.number().int().min(1).max(3)}).strict().parse(body),session=await requireSession();
      await advanceTour(session,step);return json(await projectSnapshot(session));
    }
    if(path==="checkout/create"){
      const data=z.object({intentId:z.uuid()}).strict().parse(body);return json(await createCheckout(await requireSession(["donor"]),data.intentId));
    }
    if(path==="checkout/capture"){
      const data=z.object({intentId:z.uuid(),orderId:z.string().regex(/^[A-Z0-9]{8,32}$/)}).strict().parse(body);return json(await captureCheckout(await requireSession(["donor"]),data.intentId,data.orderId));
    }
    if(path==="checkout/reconcile"){
      const data=z.object({operationId:z.uuid()}).strict().parse(body);return json(await ownedPayment(await requireSession(),data.operationId,true));
    }
    if(path==="checkout/check-intent"){
      const data=z.object({intentId:z.uuid()}).strict().parse(body);return json(await checkCheckoutIntent(await requireSession(),data.intentId));
    }
    throw new DomainError("NOT_FOUND","This endpoint does not exist.",404);
  }catch(error){return failure(error);}
}
