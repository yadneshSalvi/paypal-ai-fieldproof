import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { Response, ResponseInputContent } from "openai/resources/responses/responses";
import { defaultRequirements, proposedPlanSchema } from "../planning/contracts";
import { DomainError } from "../domain/money";
import type { PlanBackgroundObservation, PlanModelInput } from "./planning-extraction";

export const PLAN_EXECUTION_REVISION = "durable-plan-v2";
export const PLAN_BACKGROUND_DEADLINE_MS = 20 * 60_000;
const client = () => {
  if (!process.env.OPENAI_API_KEY) throw new DomainError("MODEL_UNCONFIGURED", "OpenAI plan extraction is unavailable.", 503);
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 45_000, maxRetries: 0 });
};
function observation(response: Response): PlanBackgroundObservation {
  if (!["queued", "in_progress", "completed", "failed", "cancelled", "incomplete"].includes(response.status ?? "")) throw new DomainError("PLAN_PROVIDER_STATUS_INVALID", "The provider did not return a recognized response state.", 502);
  const status = response.status as PlanBackgroundObservation["status"];
  const text = response.output.filter(item => item.type === "message").flatMap(item => item.content.filter(part => part.type === "output_text").map(part => part.text)).join("");
  let proposal: unknown = null;
  if (status === "completed") {
    try { proposal = JSON.parse(text); }
    catch { proposal = { invalidStructuredText: text }; } // Retained encrypted; the authoritative schema rejects it.
  }
  return { responseId: response.id, status, ...(status === "completed" ? { result: { proposal, responseId: response.id, inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null } } : {}),
    privateDiagnostic: status === "failed" || status === "incomplete" || status === "cancelled" ? JSON.stringify({ status, error: response.error, incomplete: response.incomplete_details, output: response.output }).slice(0, 1_000_000) : null };
}
/** Submission returns an identity promptly. Polling this identity never starts another inference. */
export async function beginOpenAIPlan(input: PlanModelInput, instructions: string): Promise<PlanBackgroundObservation> {
  const content: ResponseInputContent[] = [{ type: "input_text", text: `Sketch document: ${input.sketchId}. Current package reference and mandatory requirements: ${JSON.stringify(input.packages.map(p => ({ ...p, requirements: defaultRequirements(p.packageId) })))}. Read actual quote amounts; the current budgets are references, not extracted facts.` }];
  for (const page of input.pages) content.push({ type: "input_text", text: `Document ${page.documentId}, page ${page.page}, purpose ${page.purpose}, source ${page.provenance}.` }, { type: "input_image", image_url: `data:image/png;base64,${page.bytes.toString("base64")}`, detail: "original" });
  return observation(await client().responses.create({ model: input.model, instructions, input: [{ role: "user", content }],
    background: true, store: false, reasoning: { effort: input.reasoningEffort }, max_output_tokens: 32768,
    text: { format: zodTextFormat(proposedPlanSchema, "fieldproof_plan_proposal") } }));
}
export async function pollOpenAIPlan(responseId: string): Promise<PlanBackgroundObservation> {
  if (!/^resp_[A-Za-z0-9_-]{1,240}$/.test(responseId)) throw new DomainError("PLAN_RESPONSE_ID_INVALID", "The saved response identity is invalid.", 409);
  return observation(await client().responses.retrieve(responseId));
}
