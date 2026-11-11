import { z } from "zod";
import { PaymentError } from "@fracture/paypal-core";
import { assertSameOrigin, requireSession } from "@/lib/server/auth";
import { guardedApi } from "@/lib/server/maintenance";
import { privateJson, requestJson, routeFailure } from "@/lib/server/http";
import { DomainError } from "@/lib/domain/money";
import { applyCancellationDefaults, cancellationCaseReview, choiceActionSchema, createFundingPolicy, executeFundingChoice, fundingChoiceSchema, fundingDesk, fundingPolicySchema, openCancellationCase, openCaseSchema, recordFundingChoice, revokeFundingChoice } from "@/lib/server/funding-lifecycle";
import { createPurposePledge, purposePledgeActionSchema, purposePledgeSchema, purposeWindowSchema, reviewPurposeWindow, settleSamplePurposePledge, withdrawPurposePledge } from "@/lib/server/purpose-pledges";
import { acceptSponsorOffer, createSponsorOffer, refreshSponsorAgreements, sponsorActionSchema, sponsorOfferSchema, withdrawSponsorOffer } from "@/lib/server/sponsors";
import { purposeCheckout, purposeCheckoutSchema } from "@/lib/server/purpose-checkout";
import { fundingReceiptTrail } from "@/lib/server/funding-trail";
import { checkRefund } from "@/lib/server/refunds";
import { adjustmentActionSchema, adjustmentConsentSchema, adjustmentProposalSchema, applyAllocationAdjustment, caseRecoveryReview, proposeAllocationAdjustment, refreshResidualCase, residualCaseSchema, respondAllocationAdjustment, revokeAdjustmentResponse, withdrawAllocationAdjustment } from "@/lib/server/funding-adjustments";
import { observeOriginalReturns, observeReturnsSchema, reconcileOriginalReturns, reconcileReturnsSchema, returnRecoveryReview } from "@/lib/server/funding-return-reconciliation";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
type Context={params:Promise<{fundingPath?:string[]}>};
const fundingFailure=(error:unknown)=>error instanceof PaymentError?privateJson({error:error.message,code:error.code},error.httpStatus):routeFailure(error);
async function GETImplementation(request:Request,context:Context){
  try{
    const session=await requireSession(),parts=(await context.params).fundingPath??[];
    if(!parts.length)return privateJson({desk:await fundingDesk(session)});
    if(parts.length===1&&parts[0]==="cancellation-review"){
      const packageId=z.string().min(1).max(160).parse(new URL(request.url).searchParams.get("packageId"));return privateJson({review:await cancellationCaseReview(session,packageId)});
    }
    if(parts.length===2&&parts[0]==="receipts")return privateJson({trail:await fundingReceiptTrail(session,z.string().min(1).max(200).parse(parts[1]))});
    if(parts.length===3&&parts[0]==="cases"&&parts[2]==="recovery")return privateJson({review:await caseRecoveryReview(session,z.string().min(1).max(180).parse(parts[1]))});
    if(parts.length===3&&parts[0]==="receipts"&&parts[2]==="recovery")return privateJson({review:await returnRecoveryReview(session,z.string().min(1).max(180).parse(parts[1]))});
    throw new DomainError("NOT_FOUND","This funding view is unavailable.",404);
  }catch(error){return fundingFailure(error);}
}
async function POSTImplementation(request:Request,context:Context){
  try{
    assertSameOrigin(request);const session=await requireSession(),path=((await context.params).fundingPath??[]).join("/"),body=await requestJson(request,48*1024);
    let result:unknown;
    if(path==="policies")result=await createFundingPolicy(session,fundingPolicySchema.parse(body));
    else if(path==="windows")result=await reviewPurposeWindow(session,purposeWindowSchema.parse(body));
    else if(path==="cases")result=await openCancellationCase(session,openCaseSchema.parse(body));
    else if(path==="defaults"){const input=z.object({caseId:z.string().min(1).max(160),acknowledged:z.literal(true)}).strict().parse(body);result=await applyCancellationDefaults(session,input.caseId);}
    else if(path==="choices")result=await recordFundingChoice(session,fundingChoiceSchema.parse(body));
    else if(path==="choices/revoke")result=await revokeFundingChoice(session,choiceActionSchema.parse(body));
    else if(path==="choices/execute")result=await executeFundingChoice(session,choiceActionSchema.parse(body));
    else if(path==="pledges")result=await createPurposePledge(session,purposePledgeSchema.parse(body));
    else if(path==="pledges/withdraw")result=await withdrawPurposePledge(session,purposePledgeActionSchema.parse(body));
    else if(path==="pledges/sample-settle")result=await settleSamplePurposePledge(session,purposePledgeActionSchema.parse(body));
    else if(path==="pledges/checkout")result=await purposeCheckout(session,purposeCheckoutSchema.parse(body));
    else if(path==="sponsors")result=await createSponsorOffer(session,sponsorOfferSchema.parse(body));
    else if(path==="sponsors/accept")result=await acceptSponsorOffer(session,sponsorActionSchema.parse(body));
    else if(path==="sponsors/withdraw")result=await withdrawSponsorOffer(session,sponsorActionSchema.parse(body));
    else if(path==="sponsors/review"){z.object({}).strict().parse(body);await refreshSponsorAgreements(session);result={reviewed:true};}
    else if(path==="returns/check"){const input=z.object({refundId:z.string().min(1).max(160),retry:z.boolean(),acknowledged:z.literal(true)}).strict().parse(body);result=await checkRefund(session,input.refundId,input.retry);}
    else if(path==="returns/observe")result=await observeOriginalReturns(session,observeReturnsSchema.parse(body));
    else if(path==="returns/reconcile")result=await reconcileOriginalReturns(session,reconcileReturnsSchema.parse(body));
    else if(path==="adjustments")result=await proposeAllocationAdjustment(session,adjustmentProposalSchema.parse(body));
    else if(path==="adjustments/respond")result=await respondAllocationAdjustment(session,adjustmentConsentSchema.parse(body));
    else if(path==="adjustments/revoke")result=await revokeAdjustmentResponse(session,adjustmentActionSchema.parse(body));
    else if(path==="adjustments/apply")result=await applyAllocationAdjustment(session,adjustmentActionSchema.parse(body));
    else if(path==="adjustments/withdraw")result=await withdrawAllocationAdjustment(session,adjustmentActionSchema.parse(body));
    else if(path==="cases/reconcile")result=await refreshResidualCase(session,residualCaseSchema.parse(body));
    else throw new DomainError("NOT_FOUND","This funding action is unavailable.",404);
    return privateJson({result,desk:await fundingDesk(session)});
  }catch(error){return fundingFailure(error);}
}
export const GET=(...args:Parameters<typeof GETImplementation>)=>guardedApi(args[0],()=>GETImplementation(...args));
export const POST=(...args:Parameters<typeof POSTImplementation>)=>guardedApi(args[0],()=>POSTImplementation(...args));
