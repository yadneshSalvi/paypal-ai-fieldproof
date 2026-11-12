import { DomainError } from "../domain/money";

/** Runtime isolation only. The invitation and acceptance endpoints remain the
 * ordinary product flow; this profile has no actor chooser or seeded identity endpoint. */
export function onboardingReviewEnabled(): boolean {
  if (process.env.FIELDPROOF_ONBOARDING_REVIEW !== "true") return false;
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  if (process.env.VERCEL === "1" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.port !== "55563" || url.pathname !== "/fp_onboarding_stage11" || url.username !== "fp_onboarding_app" || process.env.APP_URL !== "http://localhost:4563")
    throw new DomainError("ONBOARDING_REVIEW_ISOLATION", "The local onboarding review requires its own database and exact origin.", 503);
  const credentials = ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "BLOB_READ_WRITE_TOKEN", ...Object.keys(process.env).filter(key => /^(PAYPAL_|NEXT_PUBLIC_PAYPAL_)/.test(key) && !["PAYPAL_ENVIRONMENT", "PAYPAL_PROJECT_ISOLATED"].includes(key))];
  if (process.env.FIELDPROOF_PROVIDER_ACCESS !== "disabled" || process.env.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED === "true" || credentials.some(key => !!process.env[key]))
    throw new DomainError("ONBOARDING_REVIEW_PROVIDERS", "The local onboarding review requires blank external credentials and disabled providers.", 503);
  return true;
}
