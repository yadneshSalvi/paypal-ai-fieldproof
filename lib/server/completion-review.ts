import { DomainError } from "../domain/money";

/** Isolates the reviewed local cohort and its allocated successor. It creates no actor, membership,
 * credential, role or source permission; all ordinary entry checks still apply. */
export function completionReviewEnabled(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  if (env.FIELDPROOF_COMPLETION_REVIEW !== "true") return false;
  let url: URL;
  try { url = new URL(env.DATABASE_URL ?? "postgresql://invalid/invalid"); }
  catch { throw new DomainError("COMPLETION_REVIEW_ISOLATION", "The combined local review requires its exact independent database and origin.", 503); }
  const competing = ["FIELDPROOF_LIFECYCLE_REVIEW", "FIELDPROOF_GOVERNANCE_REVIEW", "FIELDPROOF_BOARD_PACK_REVIEW", "FIELDPROOF_ONBOARDING_REVIEW", "FIELDPROOF_FUNDING_QA", "FIELDPROOF_SUPPORTER_QA", "FIELDPROOF_COMMUNITY_QA", "FIELDPROOF_STUDIO_QA", "FIELDPROOF_PLANNING_QA"];
  if (env.VERCEL || competing.some(key => env[key] === "true") || !["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1" || url.port !== "55571" || url.pathname !== "/fp_completion_stage14" || url.username !== "fp_completion_app" || !url.password || url.search || url.hash || !["http://localhost:4624", "http://localhost:4625"].includes(env.APP_URL ?? ""))
    throw new DomainError("COMPLETION_REVIEW_ISOLATION", "The combined local review requires its exact independent database and origin.", 503);
  const credentials = ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "BLOB_READ_WRITE_TOKEN", ...Object.keys(env).filter(key => /^(PAYPAL_|NEXT_PUBLIC_PAYPAL_)/.test(key) && !["PAYPAL_ENVIRONMENT", "PAYPAL_PROJECT_ISOLATED"].includes(key))];
  if (env.FIELDPROOF_PROVIDER_ACCESS !== "disabled" || env.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED !== "false" || env.PAYPAL_ENVIRONMENT !== "sandbox" || env.PAYPAL_PROJECT_ISOLATED !== "false" || credentials.some(key => !!env[key]))
    throw new DomainError("COMPLETION_REVIEW_PROVIDERS", "The combined local review requires blank external credentials and disabled providers.", 503);
  return true;
}
