import { DomainError } from "../domain/money";

export function onboardingReviewProfile() {
  const profile = process.env.FIELDPROOF_ONBOARDING_REVIEW_PROFILE ?? "native-stage11";
  if (profile === "native-stage11") return { origin: "http://localhost:4563", cookie: "fieldproof_supporter_onboarding_session" } as const;
  if (profile === "contrast-stage11b") return { origin: "http://localhost:4573", cookie: "fieldproof_supporter_onboarding_contrast_session" } as const;
  // Root-owned correction deliberately continues the exact existing local
  // browser library. Localhost cookies span ports; no session is renewed.
  if (profile === "role-stage11c") return { origin: "http://localhost:4581", cookie: "fieldproof_supporter_onboarding_contrast_session" } as const;
  throw new DomainError("ONBOARDING_REVIEW_ISOLATION", "That isolated onboarding review profile is unavailable.", 503);
}

/** Runtime isolation only. The invitation and acceptance endpoints remain the
 * ordinary product flow; this profile has no actor chooser or seeded identity endpoint. */
export function onboardingReviewEnabled(): boolean {
  if (process.env.FIELDPROOF_ONBOARDING_REVIEW !== "true") return false;
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid"), profile = onboardingReviewProfile();
  if (process.env.VERCEL === "1" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.port !== "55563" || url.pathname !== "/fp_onboarding_stage11" || url.username !== "fp_onboarding_app" || process.env.APP_URL !== profile.origin)
    throw new DomainError("ONBOARDING_REVIEW_ISOLATION", "The local onboarding review requires its own database and exact origin.", 503);
  const credentials = ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "BLOB_READ_WRITE_TOKEN", ...Object.keys(process.env).filter(key => /^(PAYPAL_|NEXT_PUBLIC_PAYPAL_)/.test(key) && !["PAYPAL_ENVIRONMENT", "PAYPAL_PROJECT_ISOLATED"].includes(key))];
  if (process.env.FIELDPROOF_PROVIDER_ACCESS !== "disabled" || process.env.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED === "true" || credentials.some(key => !!process.env[key]))
    throw new DomainError("ONBOARDING_REVIEW_PROVIDERS", "The local onboarding review requires blank external credentials and disabled providers.", 503);
  return true;
}
