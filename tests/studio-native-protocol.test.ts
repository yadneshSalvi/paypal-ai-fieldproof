import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { directLlmRunner, type AgAiEvent, type AgAiRunInput, type AgAiTraceContext, type AgLlmAdapter, type AgLlmResponse } from "ag-studio";
import { nativeAdapterTrace, nativeRunIdentity } from "../lib/studio/native-protocol";

describe("installed native runner trace handoff", () => {
  it("carries each actual native child event's parent through AG's adapter without replacing the native loop", async () => {
    const started = new Map<string, AgAiTraceContext>(), sent: AgAiTraceContext[] = [];
    const adapter: AgLlmAdapter = { executeTurn(_request, options) {
      const trace = nativeAdapterTrace(options?.trace, options?.trace ? started.get(nativeRunIdentity(options.trace.runId)) : undefined);
      sent.push(trace);
      const response: AgLlmResponse = { id: `controlled-${trace.runId}`, createdAt: Date.now(), status: "completed", output: [{
        id: `answer-${trace.runId}`, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: "Controlled adapter response", annotations: [] }],
      }] };
      return { stream: { async *[Symbol.asyncIterator]() { yield { type: "TEXT_MESSAGE_CHUNK", messageId: `answer-${trace.runId}`, delta: "Controlled adapter response" } as const; } }, complete: Promise.resolve(response) };
    } };
    const execute = async (agentId: string, suffix: string) => {
      const input: AgAiRunInput = { threadId: `child-thread-${suffix}`, runId: `child-run-${suffix}`, parentRunId: `parent-${suffix}`, parentToolCallId: `delegate-call-${suffix}`,
        messages: [{ id: "task", role: "user", content: "Inspect the existing private report." }], tools: [], state: {}, context: [], forwardedProps: {} };
      const runner = directLlmRunner({ id: agentId, adapter }), events: AgAiEvent[] = [];
      for await (const event of runner.run(input, { params: undefined, instructions: () => "Controlled native runner qualification", tools: () => [], emit(event) {
        if (event.type === "run_started") started.set(event.trace.runId, { ...event.trace });
      } })) events.push(event);
      assert.ok(events.some(event => event.type === "RUN_FINISHED"));
      assert.equal(events.some(event => event.type === "RUN_ERROR"), false);
    };
    await Promise.all([execute("page", "page"), execute("widget", "widget")]);
    assert.deepEqual(sent.map(({ agentId, parentRunId, parentToolCallId }) => ({ agentId, parentRunId, parentToolCallId })).sort((a, b) => a.agentId.localeCompare(b.agentId)), [
      { agentId: "page", parentRunId: "parent-page", parentToolCallId: "delegate-call-page" },
      { agentId: "widget", parentRunId: "parent-widget", parentToolCallId: "delegate-call-widget" },
    ]);
  });
  it("fails closed for missing, mixed or incomplete native parent identity", () => {
    const trace: AgAiTraceContext = { agentId: "page", threadId: "child-thread", runId: "child-run" };
    const started = { ...trace, parentRunId: "parent-run", parentToolCallId: "actual-issued-call" };
    assert.throws(() => nativeAdapterTrace(trace, undefined), /registered trace/);
    assert.throws(() => nativeAdapterTrace({ ...trace, threadId: "other-thread" }, started), /original run/);
    assert.throws(() => nativeAdapterTrace({ ...trace, parentRunId: "other-parent" }, started), /parent call/);
    assert.throws(() => nativeAdapterTrace({ ...trace, parentToolCallId: "other-call" }, started), /parent call/);
    assert.throws(() => nativeAdapterTrace(trace, { ...trace, parentRunId: "parent-run" }), /parent call/);
    assert.throws(() => nativeAdapterTrace(trace, { ...trace, parentToolCallId: "actual-issued-call" }), /parent call/);
  });
  it("retains a genuine top-level run and normalizes only native request suffixes", () => {
    const started: AgAiTraceContext = { agentId: "fieldproof-steward", threadId: "main-thread", runId: "root-run" };
    assert.deepEqual(nativeAdapterTrace({ ...started, runId: "root-run-r5" }, started), { ...started, parentRunId: undefined, parentToolCallId: undefined });
  });
});
