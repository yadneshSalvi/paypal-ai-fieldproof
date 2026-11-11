import OpenAI from "openai";
import { createHash } from "node:crypto";
import type { ResponseInput } from "openai/resources/responses/responses";
import type { AgAiEvent, AgAiOutputItem, AgLlmResponse } from "ag-studio";
import { z } from "zod";
import { DomainError } from "../domain/money";
import type { StudioAgentRequest, StudioToolDeclaration } from "../studio/agent-contracts";

/** Only visible text, exact calls, and allowlisted tool results cross this boundary.
 * Provider reasoning items are neither persisted nor returned to the browser. */
export type StudioModelItem =
  | { role: "user" | "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };
export interface StudioModelRequest { model: string; instructions: string; input: StudioModelItem[]; tools: StudioToolDeclaration[]; toolChoice?: StudioAgentRequest["toolChoice"]; signal?: AbortSignal; }
export interface StudioModel { respond(request: StudioModelRequest): Promise<AgLlmResponse>; }

export interface StudioFailureDiagnostic {
  errorClass: string; status: number | null; providerCode: string | null; providerType: string | null;
  requestId: string | null; retryAfterSeconds: number | null; errorHash: string;
  /** Encrypted operator diagnostic only. Never return this field to a browser or model. */
  privateMessage: string;
}
export function studioFailureDiagnostic(error: unknown): StudioFailureDiagnostic {
  const sensitive = Object.entries(process.env).filter(([key, value]) => /SECRET|TOKEN|KEY|PASS|DATABASE_URL/i.test(key) && value && value.length >= 8).map(([, value]) => value!);
  const token = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(value) && !sensitive.some(secret => value.includes(secret)) ? value : null;
  const api = error instanceof OpenAI.APIError ? error : null;
  const raw = error instanceof Error ? error.message : "An unexpected non-error value was thrown.";
  let privateMessage = raw;
  for (const secret of sensitive) privateMessage = privateMessage.replaceAll(secret, "[redacted]");
  privateMessage = privateMessage.replace(/\b(?:sk|pk|rk)(?:-proj|-svcacct)?-[\w*.-]{8,}/gi, "[redacted]").replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted authorization]").slice(0, 4000);
  const retry = api?.headers?.get("retry-after"), seconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : null;
  return { errorClass: token(error instanceof Error ? error.constructor.name : null) ?? "UnknownError",
    status: typeof api?.status === "number" ? api.status : null, providerCode: token(api?.code), providerType: token(api?.type), requestId: token(api?.requestID),
    retryAfterSeconds: seconds !== null && seconds >= 0 && seconds <= 86400 ? Math.ceil(seconds) : null,
    errorHash: createHash("sha256").update(raw).digest("hex"), privateMessage };
}
export class StudioModelProviderError extends DomainError {
  readonly diagnostic: StudioFailureDiagnostic;
  constructor(code: string, message: string, cause: unknown, status = 502) {
    super(code, message, status); this.diagnostic = studioFailureDiagnostic(cause);
  }
}
export function studioProviderFailure(error: unknown): unknown {
  if (!(error instanceof OpenAI.APIError)) return error;
  const kind = error.status === 429 ? ["STUDIO_MODEL_RATE_LIMITED", "The model provider asked this report run to wait. Its completed reads and saved edits are retained; start a new question after the provider limit clears.", 503] as const
    : error.status === 401 || error.status === 403 ? ["STUDIO_MODEL_AUTH_UNAVAILABLE", "The report model connection could not be authorized. Its earlier reads and saved edits are retained.", 502] as const
      : error.status === 400 || error.status === 422 ? ["STUDIO_MODEL_REQUEST_REJECTED", "The model provider rejected this report request. Its diagnostic reference and earlier reads are retained for review.", 502] as const
        : error.status === 404 ? ["STUDIO_MODEL_NOT_AVAILABLE", "The configured report model is unavailable. Its earlier reads and saved edits are retained.", 502] as const
          : error instanceof OpenAI.APIConnectionTimeoutError ? ["STUDIO_MODEL_TIMEOUT", "The model provider did not return within this turn's timeout. Its earlier reads and saved edits are retained; no automatic retry was sent.", 504] as const
            : error instanceof OpenAI.APIConnectionError ? ["STUDIO_MODEL_CONNECTION_FAILED", "The report model connection ended without a response. Its earlier reads and saved edits are retained; no automatic retry was sent.", 502] as const
              : ["STUDIO_MODEL_SERVICE_UNAVAILABLE", "The model provider could not complete this report request. Its diagnostic reference and earlier reads are retained.", 502] as const;
  return new StudioModelProviderError(kind[0], kind[1], error, kind[2]);
}

export function studioModelName(): string {
  const name = process.env.OPENAI_MODEL;
  if (!name || !/^[a-zA-Z0-9._-]{3,100}$/.test(name)) throw new DomainError("STUDIO_MODEL_UNCONFIGURED", "The report assistant is not configured yet. The report and its manual editing tools are available.", 503);
  return name;
}
export const liveStudioModel: StudioModel = {
  async respond(request) {
    if (!process.env.OPENAI_API_KEY) throw new DomainError("STUDIO_MODEL_UNCONFIGURED", "The report assistant is not configured yet.", 503);
    const effort = z.enum(["low", "medium", "high", "xhigh", "max"]).parse(process.env.OPENAI_REASONING_EFFORT ?? "max");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 240_000 });
    const response = await client.responses.create({ model: request.model, store: false, reasoning: { effort }, max_output_tokens: 32768,
      instructions: request.instructions, input: request.input as ResponseInput,
      tools: request.tools.map(tool => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })),
      tool_choice: typeof request.toolChoice === "object" ? { type: "function", name: request.toolChoice.name } : request.toolChoice ?? "auto",
      parallel_tool_calls: false,
    }, { signal: request.signal }).catch(error => { throw studioProviderFailure(error); });
    if (response.status !== "completed") throw new DomainError("STUDIO_MODEL_INCOMPLETE", "The assistant did not finish this turn. Its earlier applied report edits remain in Undo and its trace; no payment was attempted.", 502);
    const output: AgAiOutputItem[] = [];
    for (const item of response.output) {
      if (item.type === "message") output.push({ kind: "output", type: "message", id: item.id, role: "assistant", status: "completed",
        content: item.content.flatMap(part => part.type === "output_text" ? [{ type: "text" as const, text: part.text, annotations: [] }] : part.type === "refusal" ? [{ type: "text" as const, text: part.refusal, annotations: [] }] : []) });
      if (item.type === "function_call") output.push({ kind: "output", type: "function_call", id: item.id ?? item.call_id, callId: item.call_id, name: item.name, arguments: item.arguments, status: "completed" });
    }
    return { id: response.id, createdAt: response.created_at * 1000, status: "completed", output, model: response.model,
      usage: { inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0, totalTokens: response.usage?.total_tokens ?? 0 } };
  },
};

export function visibleModelOutput(response: AgLlmResponse): AgLlmResponse {
  const output = response.output.filter(item => item.type !== "reasoning");
  if (JSON.stringify(output).length > 600_000 || output.length > 40 || response.status !== "completed") throw new DomainError("STUDIO_MODEL_INCOMPLETE", "The assistant returned an incomplete or oversized turn. No financial action was attempted.", 502);
  const calls = output.filter(item => item.type === "function_call");
  if (new Set(calls.map(call => call.callId)).size !== calls.length || calls.some(call => !call.callId || call.callId.length > 220 || call.arguments.length > 150000))
    throw new DomainError("STUDIO_MODEL_CALL_INVALID", "The assistant returned an invalid tool identity. This turn was stopped.", 502);
  return { id: response.id, createdAt: response.createdAt, status: "completed", output, ...(response.model ? { model: response.model } : {}), ...(response.usage ? { usage: response.usage } : {}) };
}
export function modelInputItems(response: AgLlmResponse): StudioModelItem[] {
  return response.output.flatMap<StudioModelItem>(item => item.type === "function_call" ? [{ type: "function_call", call_id: item.callId, name: item.name, arguments: item.arguments }]
    : item.type === "message" ? [{ role: "assistant", content: item.content.map(part => part.type === "text" ? part.text : part.refusal).join("") }] : []);
}
export function modelEvents(response: AgLlmResponse): AgAiEvent[] {
  return response.output.flatMap<AgAiEvent>(item => item.type === "function_call" ? [
    { type: "TOOL_CALL_START", toolCallId: item.callId, toolCallName: item.name },
    { type: "TOOL_CALL_ARGS", toolCallId: item.callId, delta: item.arguments }, { type: "TOOL_CALL_END", toolCallId: item.callId },
  ] : item.type === "message" ? [
    { type: "TEXT_MESSAGE_START", messageId: item.id, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: item.id, delta: item.content.map(part => part.type === "text" ? part.text : part.refusal).join("") },
    { type: "TEXT_MESSAGE_END", messageId: item.id },
  ] : []);
}
