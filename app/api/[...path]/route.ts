import { guardedApi } from "@/lib/server/maintenance";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { PaymentError } from "@fracture/paypal-core";
import { z, ZodError } from "zod";
import { assertSameOrigin, getSession, requireSession, setRole, startSession } from "@/lib/server/auth";
import { projectSnapshot, addSamplePledge, advanceTour } from "@/lib/server/repository";
import { applicationOrigin, captureCheckout, checkCheckoutIntent, createCheckout, ownedPayment, reconcilePaymentCommands } from "@/lib/server/payments";
import { completeIdentity, identityConnectionCapability, identityStart, recipientView } from "@/lib/server/identity";
import { DomainError } from "@/lib/domain/money";
import { database, initializeDatabase, query } from "@/lib/server/db";
import { runtimeControl } from "@/lib/server/runtime-control";
import { beginWalletApproval, commitmentOverview, commitmentView, completeWalletApproval, createCommitment, withdrawCommitment } from "@/lib/server/commitments";
import { advanceCollection, collectionReview, collectionView, freezeCollection, runCollectionJobs } from "@/lib/server/collections";
import { cancelRecoveryInvoice, checkRecoveryInvoice, createRecoveryInvoice, recoveryInvoiceViews, reconcileRecoveryInvoices, shareRecoveryInvoice } from "@/lib/server/recovery-invoices";
import { checkRefund, reconcileRefunds, refundViews, requestRefund } from "@/lib/server/refunds";
import { cancelUnspentCollection, processCompensation, reconcileCollectionPayments, runCompensationJobs } from "@/lib/server/compensation";

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
async function GETImplementation(request:Request,context:Context){
  const path=(await context.params).path.join("/");
  try{
    if(path==="snapshot") return json(await projectSnapshot(await getSession()));
    if(path==="health") {await initializeDatabase();await query("SELECT 1");return json({status:"ok",storage:"postgresql",project:"fieldproof",environment:"sandbox",execution:await runtimeControl(database())});}
    if(path==="paypal/config") {await requireSession(["donor"]);return json({clientId:process.env.PAYPAL_CLIENT_ID??null,currency:"USD",environment:"sandbox"});}
    if(path==="recipient") return json({recipient:await recipientView(await requireSession()),connection:identityConnectionCapability()});
    if(path==="commitments") return json(await commitmentOverview(await requireSession()));
    if(path==="collection") {
      const session=await requireSession(),review=await collectionReview(session);
      const [invoices,refunds]=await Promise.all([recoveryInvoiceViews(session),refundViews(session)]);
      return json({...review,invoices,refunds});
    }
    if(path.startsWith("commitments/")) return json(await commitmentView(await requireSession(),z.uuid().parse(path.slice("commitments/".length))));
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
    if(["cron/collection","cron/compensation","cron/invoices","cron/refunds"].includes(path)) {
      const supplied=request.headers.get("authorization")??"",expected=`Bearer ${process.env.CRON_SECRET??""}`;
      if(!process.env.CRON_SECRET||supplied.length!==expected.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))throw new DomainError("FORBIDDEN","Scheduler authorization is required.",403);
      await initializeDatabase();
      if(path==="cron/collection")return json(await runCollectionJobs(1));
      if(path==="cron/compensation")return json(await runCompensationJobs(1));
      if(path==="cron/invoices")return json({observed:await reconcileRecoveryInvoices(1)});
      return json({observed:await reconcileRefunds(1)});
    }
    if(path==="cron/reconcile"){
      const supplied=request.headers.get("authorization")??"",expected=`Bearer ${process.env.CRON_SECRET??""}`;
      if(!process.env.CRON_SECRET || supplied.length!==expected.length || !timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))) throw new DomainError("FORBIDDEN","Scheduler authorization is required.",403);
      await initializeDatabase();
      return json(await reconcilePaymentCommands());
    }
    throw new DomainError("NOT_FOUND","This endpoint does not exist.",404);
  }catch(error){return failure(error);}
}
async function POSTImplementation(request:Request,context:Context){
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
    if(path==="commitments"){
      const data=z.object({slotIndex:z.number().int().min(0).max(7),expectedVersion:z.number().int().positive(),intentId:z.uuid(),accepted:z.literal(true),policyVersion:z.literal(1)}).strict().parse(body);
      return json(await createCommitment(await requireSession(["donor"]),data),201);
    }
    if(path==="collection/start") {
      const data=z.object({expectedVersion:z.number().int().positive(),intentId:z.uuid(),acknowledged:z.literal(true),automatic:z.boolean().default(false)}).strict().parse(body);
      return json(await freezeCollection(await requireSession(["organizer"]),data),201);
    }
    if(path==="collection/advance") {
      const data=z.object({roundId:z.uuid(),consentId:z.uuid()}).strict().parse(body);
      return json(await advanceCollection(await requireSession(["organizer"]),data.roundId,data.consentId));
    }
    if(path==="collection/check") {
      const {roundId}=z.object({roundId:z.uuid()}).strict().parse(body),session=await requireSession(["organizer","auditor","donor"]);
      await collectionView(session,roundId);
      await reconcileCollectionPayments(session,roundId);
      return json(await collectionView(session,roundId));
    }
    if(path==="collection/cancel") {
      const data=z.object({roundId:z.uuid(),expectedVersion:z.number().int().positive(),acknowledged:z.literal(true)}).strict().parse(body);
      return json(await cancelUnspentCollection(await requireSession(["organizer"]),data));
    }
    if(path==="collection/compensate") {
      const {roundId}=z.object({roundId:z.uuid()}).strict().parse(body),session=await requireSession(["organizer"]);
      await collectionView(session,roundId);
      return json(await processCompensation(session,roundId));
    }
    if(path==="recovery/create") {
      const data=z.object({consentId:z.uuid(),expectedVersion:z.number().int().positive(),acknowledged:z.literal(true)}).strict().parse(body);
      return json(await createRecoveryInvoice(await requireSession(["organizer","donor"]),data),201);
    }
    if(["recovery/share","recovery/check","recovery/cancel"].includes(path)) {
      const {invoiceId}=z.object({invoiceId:z.uuid()}).strict().parse(body),session=await requireSession(path==="recovery/check"?["organizer","donor","auditor"]:["organizer","donor"]);
      return json(path==="recovery/share"?await shareRecoveryInvoice(session,invoiceId):path==="recovery/check"?await checkRecoveryInvoice(session,invoiceId):await cancelRecoveryInvoice(session,invoiceId));
    }
    if(path==="refunds/request") {
      const data=z.object({receiptId:z.uuid(),intentId:z.uuid(),amountMinor:z.number().int().min(1).max(96000),acknowledged:z.literal(true)}).strict().parse(body);
      return json(await requestRefund(await requireSession(["organizer","donor"]),data),201);
    }
    if(path==="refunds/check"||path==="refunds/retry") {
      const data=(path==="refunds/retry"?z.object({refundId:z.uuid(),acknowledged:z.literal(true)}):z.object({refundId:z.uuid()})).strict().parse(body);
      return json(await checkRefund(await requireSession(path==="refunds/retry"?["organizer","donor"]:["organizer","donor","auditor"]),data.refundId,path==="refunds/retry"));
    }
    if(["commitments/wallet","commitments/check","commitments/withdraw"].includes(path)){
      const {consentId}=z.object({consentId:z.uuid()}).strict().parse(body),session=await requireSession(["donor"]);
      return json(path==="commitments/wallet"?await beginWalletApproval(session,consentId):path==="commitments/check"?await completeWalletApproval(session,consentId):await withdrawCommitment(session,consentId));
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

export const GET = (...args: Parameters<typeof GETImplementation>) => guardedApi(args[0], () => GETImplementation(...args));

export const POST = (...args: Parameters<typeof POSTImplementation>) => guardedApi(args[0], () => POSTImplementation(...args));
