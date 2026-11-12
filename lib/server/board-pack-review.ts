import { DomainError } from "../domain/money";

/** Isolates local qualification. It never grants an actor or creates a session. */
export function boardPackReviewEnabled(): boolean {
  if (process.env.FIELDPROOF_BOARD_PACK_REVIEW !== "true") return false;
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  if (process.env.VERCEL === "1" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.port !== "55571" || url.pathname !== "/fp_boardpack_stage12" || url.username !== "fp_boardpack_app" || process.env.APP_URL !== "http://localhost:4591")
    throw new DomainError("BOARD_PACK_REVIEW_ISOLATION", "The local Board Pack review requires its exact isolated database and origin.", 503);
  const credentials = ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "BLOB_READ_WRITE_TOKEN", ...Object.keys(process.env).filter(key => /^(PAYPAL_|NEXT_PUBLIC_PAYPAL_)/.test(key) && !["PAYPAL_ENVIRONMENT", "PAYPAL_PROJECT_ISOLATED"].includes(key))];
  if (process.env.FIELDPROOF_PROVIDER_ACCESS !== "disabled" || process.env.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED === "true" || credentials.some(key => !!process.env[key]))
    throw new DomainError("BOARD_PACK_REVIEW_PROVIDERS", "The local Board Pack review requires blank external credentials and disabled providers.", 503);
  return true;
}
