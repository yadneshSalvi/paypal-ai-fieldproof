import { DomainError } from "../domain/money";

/** Public links use the stable deployment, never a request host or preview URL. */
export function publicProofUrl(slug: string, env: Partial<NodeJS.ProcessEnv> = process.env): string {
  const origin = env.VERCEL ? "https://paypal-ai-fieldproof.vercel.app" : env.APP_URL ?? "http://localhost:4102";
  const allowed = ["https://paypal-ai-fieldproof.vercel.app", "http://localhost:4102"];
  if (env.NODE_ENV !== "production" && env.FIELDPROOF_PLANNING_QA === "true") allowed.push("http://localhost:4502");
  if (!allowed.includes(origin)) throw new DomainError("PROOF_ORIGIN_UNAVAILABLE", "The public proof origin is not configured for this runtime.", 503);
  return new URL(`/proof/${encodeURIComponent(slug)}`, origin).href;
}
