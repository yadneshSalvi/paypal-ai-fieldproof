import type { AgAiThread } from "ag-studio";
import { z } from "zod";
import { STUDIO_AGENT_IDS } from "./agent-contracts";

const id = z.string().min(1).max(220);
const part = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(300000) }).strict(),
  z.object({ type: z.literal("error"), message: z.string().max(4000) }).strict(),
  z.object({ type: z.literal("tool_call"), toolCall: z.object({ toolCallId: id, name: z.string().regex(/^[a-z_]{1,80}$/),
    status: z.enum(["streaming", "ready", "awaiting_approval", "executing", "complete", "error", "cancelled"]),
    args: z.record(z.string(), z.unknown()), result: z.unknown().optional(), childThreadId: id.optional() }).strict() }).strict(),
]);
export const studioThreadSummarySchema = z.object({ threadId: id, agentId: z.enum(STUDIO_AGENT_IDS), parentThreadId: id.optional(), title: z.string().max(300).optional(),
  model: z.object({ id: z.string().max(100), effort: z.string().max(20).optional() }).strict().optional(), updatedAt: z.number().finite().nonnegative() }).strict();
const thread = z.object({ summary: studioThreadSummarySchema, messages: z.array(z.object({ id, role: z.enum(["user", "assistant", "system"]),
  parts: z.array(part).max(500), createdAt: z.number().finite().nonnegative() }).strict()).max(1000),
  artifacts: z.array(z.object({ id, type: z.string().max(100), data: z.unknown() }).strict()).max(100).optional(), sharedState: z.unknown().optional(),
}).strict();
function safeJson(value: unknown, depth = 0): void {
  if (depth > 45) throw new Error("The conversation is too deeply nested.");
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(item => safeJson(item, depth + 1)); return; }
  if (typeof value !== "object") throw new Error("A conversation must contain only JSON values.");
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Invalid conversation property.");
    safeJson(item, depth + 1);
  }
}
/** Stored chats are display-only client observations, never input authority for a
 * server tool. Provider reasoning is deliberately omitted from this history. */
export function validateStudioThread(value: unknown): AgAiThread {
  safeJson(value);
  if (JSON.stringify(value).length > 3_000_000) throw new Error("This conversation is too large to save in one thread.");
  const copy = structuredClone(value) as { messages?: { parts?: { type: string }[] }[] };
  for (const message of copy?.messages ?? []) if (Array.isArray(message.parts)) message.parts = message.parts.filter(item => item?.type !== "reasoning");
  return thread.parse(copy) as AgAiThread;
}
