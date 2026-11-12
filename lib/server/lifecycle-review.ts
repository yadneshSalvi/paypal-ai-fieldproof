import {DomainError} from "../domain/money";

/** Local runtime isolation only. All entry, roles and fixed deadlines still
 * use the ordinary product contract; this grants no actor or capability. */
export function lifecycleReviewEnabled():boolean {
  if(process.env.FIELDPROOF_LIFECYCLE_REVIEW!=="true")return false;
  const url=new URL(process.env.DATABASE_URL??"postgresql://invalid/invalid");
  const competing=["FIELDPROOF_GOVERNANCE_REVIEW","FIELDPROOF_BOARD_PACK_REVIEW","FIELDPROOF_ONBOARDING_REVIEW","FIELDPROOF_FUNDING_QA","FIELDPROOF_SUPPORTER_QA","FIELDPROOF_COMMUNITY_QA","FIELDPROOF_STUDIO_QA","FIELDPROOF_PLANNING_QA"];
  if(process.env.VERCEL==="1"||competing.some(key=>process.env[key]==="true")||url.hostname!=="127.0.0.1"||url.port!=="55571"||url.pathname!=="/fp_lifecycle_stage14"||url.username!=="fp_lifecycle_app"||process.env.APP_URL!=="http://localhost:4620")
    throw new DomainError("LIFECYCLE_REVIEW_ISOLATION","The local lifecycle review requires its exact independent database and origin.",503);
  const credentials=["OPENAI_API_KEY","GEMINI_API_KEY","GOOGLE_API_KEY","BLOB_READ_WRITE_TOKEN",...Object.keys(process.env).filter(key=>/^(PAYPAL_|NEXT_PUBLIC_PAYPAL_)/.test(key)&&!["PAYPAL_ENVIRONMENT","PAYPAL_PROJECT_ISOLATED"].includes(key))];
  if(process.env.FIELDPROOF_PROVIDER_ACCESS!=="disabled"||process.env.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED==="true"||credentials.some(key=>!!process.env[key]))
    throw new DomainError("LIFECYCLE_REVIEW_PROVIDERS","The local lifecycle review requires blank external credentials and disabled providers.",503);
  return true;
}
