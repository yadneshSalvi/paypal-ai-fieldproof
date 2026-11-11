import { z } from "zod";
import type { AgAiEvent, AgAiMessage, AgAiToolSchema, AgLlmResponse } from "ag-studio";

export const STUDIO_AGENT_IDS = ["fieldproof-steward", "fieldproof-auditor", "page", "widget", "data", "planning"] as const;
export type StudioAgentId = typeof STUDIO_AGENT_IDS[number];
export const STUDIO_SERVER_TOOLS = ["fieldproof_snapshot", "fieldproof_evidence", "fieldproof_exceptions", "paypal_owned_read"] as const;
export const STUDIO_CLIENT_TOOLS = ["view_schema", "view_report", "view_page", "view_widget", "execute_query", "create_expression", "update_expression", "delete_expression", "add_widget", "position_widget", "remove_widget", "add_page_filter", "remove_page_filter", "add_widget_filter", "remove_widget_filter", "configure_widget", "rename_thread", "delegate_to", "create_plan", "update_plan", "view_plan", "clear_plan", "complete_task"] as const;
export const STUDIO_READ_CLIENT_TOOLS = ["view_schema", "view_report", "view_page", "view_widget", "execute_query", "complete_task"] as const;
export const STUDIO_PROMPT_VERSION = "fieldproof-native-studio-v1";
const boundedId = z.string().min(1).max(220);
const toolCall = z.object({ id: boundedId, type: z.literal("function"), function: z.object({ name: z.string().regex(/^[a-z_]{1,80}$/), arguments: z.string().max(150000) }).strict() }).strict();
const message = z.discriminatedUnion("role", [
  z.object({ id: boundedId, role: z.literal("user"), content: z.string().max(24000), name: z.string().max(100).optional() }).strict(),
  z.object({ id: boundedId, role: z.literal("assistant"), content: z.string().max(120000).optional(), name: z.string().max(100).optional(), toolCalls: z.array(toolCall).max(30).optional() }).strict(),
  z.object({ id: boundedId, role: z.literal("tool"), content: z.string().max(300000), toolCallId: boundedId, error: z.string().max(2000).optional() }).strict(),
  z.object({ id: boundedId, role: z.enum(["system", "developer"]), content: z.string().max(150000), name: z.string().max(100).optional() }).strict(),
]);
export const studioAgentRequestSchema = z.object({
  agentId: z.enum(STUDIO_AGENT_IDS), runKey: boundedId, threadId: boundedId, round: z.number().int().min(0).max(1000), datasetHandle: z.uuid(),
  messages: z.array(message).max(300), instructions: z.string().max(150000).default(""),
  tools: z.array(z.object({ name: z.string().regex(/^[a-z_]{1,80}$/), description: z.string().max(20000), parameters: z.record(z.string(), z.unknown()), kind: z.enum(["client", "server", "provided"]).optional() }).strict()).max(50),
  toolChoice: z.union([z.enum(["auto", "none", "required"]), z.object({ name: z.string().regex(/^[a-z_]{1,80}$/) }).strict()]).optional(),
  params: z.unknown().optional(), parentRunId: boundedId.optional(), parentToolCallId: boundedId.optional(),
}).strict().superRefine((value, ctx) => {
  if (JSON.stringify(value).length > 1_300_000) ctx.addIssue({ code: "custom", message: "This conversation is too large for one report request." });
});
export type StudioAgentRequest = z.infer<typeof studioAgentRequestSchema>;
export interface StudioAgentRunView {
  id: string; agentId: string; runKey: string; threadId: string; state: string; version: number; model: string; promptVersion: string;
  datasetHandle: string; cutoff: string; inputHash: string; stats: { inputTokens: number; outputTokens: number; modelTurns: number; serverTools: number; clientTools: number };
}
export interface StudioAgentResponse {
  run: StudioAgentRunView; events: AgAiEvent[]; response: AgLlmResponse;
  /** A server-only tool turn continues in a new HTTP request, retaining the same native run. */
  continue: boolean; nextRound: number;
}
export type StudioProtocolMessages = AgAiMessage[];
export type StudioToolDeclaration = AgAiToolSchema;

export const studioClientReceiptSchema = z.object({
  runKey: boundedId, agentId: z.enum(STUDIO_AGENT_IDS), threadId: boundedId, callId: boundedId,
  name: z.enum(STUDIO_CLIENT_TOOLS), ok: z.boolean(), result: z.string().max(300000),
  history: z.unknown().optional(),
}).strict();
export const studioClientFinishedSchema = z.object({
  runKey: boundedId, agentId: z.enum(STUDIO_AGENT_IDS), threadId: boundedId,
  status: z.enum(["ok", "error", "cancelled"]), history: z.unknown().optional(),
}).strict();
