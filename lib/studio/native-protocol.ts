import type { AgAiConversationItem, AgAiMessage, AgAiTraceContext } from "ag-studio";

/** Convert the public native adapter vocabulary, preserving call identities and results.
 * Hidden reasoning and image/file attachments have no place in a report-only request. */
export function nativeProtocolMessages(items: AgAiConversationItem[]): AgAiMessage[] {
  const messages: AgAiMessage[] = [], explicitResults = new Set(items.filter(item => item.type === "function_call_output").map(item => item.callId));
  for (const item of items) {
    if (item.type === "reasoning") continue;
    if (item.type === "message") {
      const content = item.content.map(part => part.type === "text" ? part.text : part.type === "refusal" ? part.refusal : "").join("\n");
      if (item.role === "assistant") messages.push({ id: item.id, role: "assistant", content });
      else messages.push({ id: item.id, role: item.role, content });
    } else if (item.type === "function_call") {
      messages.push({ id: item.id, role: "assistant", toolCalls: [{ id: item.callId, type: "function", function: { name: item.name, arguments: item.arguments } }] });
      if (item.result !== undefined && !explicitResults.has(item.callId)) messages.push({ id: `${item.callId}-result`, role: "tool", toolCallId: item.callId, content: item.result });
    } else messages.push({ id: item.id ?? `${item.callId}-result`, role: "tool", toolCallId: item.callId, content: item.output });
  }
  return messages;
}
/** clientToolRunner adds a request-local suffix. The native root run identity remains
 * stable for the server lease, parent/delegate binding, and browser observations. */
export function nativeRunIdentity(roundRunId: string): string { return roundRunId.replace(/-r\d+$/, ""); }

/** AG 3.1 emits the complete native run identity before invoking its adapter, but
 * LlmTurnSource omits parent fields from executeTurn's trace. Bind to that actual
 * run_started event; never infer a parent from the latest run or conversation. */
export function nativeAdapterTrace(trace: AgAiTraceContext | undefined, started: AgAiTraceContext | undefined): AgAiTraceContext {
  if (!trace || !started) throw new Error("The native report run did not provide its registered trace identity.");
  const runId = nativeRunIdentity(trace.runId), parentRunId = started.parentRunId ? nativeRunIdentity(started.parentRunId) : undefined;
  if (runId !== nativeRunIdentity(started.runId) || trace.threadId !== started.threadId || trace.agentId !== started.agentId)
    throw new Error("The native report request does not match its original run.");
  if (!!parentRunId !== !!started.parentToolCallId || (trace.parentRunId && nativeRunIdentity(trace.parentRunId) !== parentRunId)
    || (trace.parentToolCallId && trace.parentToolCallId !== started.parentToolCallId))
    throw new Error("The native delegate's original parent call could not be verified.");
  return { ...trace, runId, parentRunId, parentToolCallId: started.parentToolCallId };
}
