"use client";

import { clientToolRunner, createAiHarness, directLlmRunner,
  type AgAiAgentDefinition, type AgAiAgentRun, type AgAiHarness, type AgAiHistoryStore, type AgAiHistoryStoreEventListener,
  type AgAiThread, type AgAiThreadSummary, type AgAiTool, type AgAiTraceContext, type AgLlmAdapter, type AgStudioApi,
} from "ag-studio";
import type { StudioSnapshot } from "@/lib/studio/contracts";
import { STUDIO_CLIENT_TOOLS, type StudioAgentId, type StudioAgentRequest, type StudioAgentResponse, type StudioAgentRunView } from "@/lib/studio/agent-contracts";
import { nativeAdapterTrace, nativeProtocolMessages, nativeRunIdentity } from "@/lib/studio/native-protocol";
import { studioServerToolSchemas } from "@/lib/studio/server-tools";
import type { FieldproofRegistry } from "./widgets";
import { studioRequest } from "./transport";

interface HarnessHooks {
  snapshot(): StudioSnapshot;
  applySnapshot(snapshot: StudioSnapshot): Promise<void>;
  onActivity(count: number): void;
  onRun(run: StudioAgentRunView): void;
  onTraceChanged(): void;
  onError(error: unknown): void;
}
interface RunState { cutoff: Promise<StudioSnapshot>; nextRound: number; }

function chatHistory(scope: string, onError: HarnessHooks["onError"]): AgAiHistoryStore {
  const revisions = new Map<string, number>(), queues = new Map<string, Promise<void>>(), blocked = new Set<string>();
  const listeners = new Set<AgAiHistoryStoreEventListener>();
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`fieldproof-studio-chats:${scope}`);
  channel?.addEventListener("message", () => { for (const listener of listeners) listener({ type: "changed" }); });
  const enqueue = (id: string, task: () => Promise<void>) => {
    const job = (queues.get(id) ?? Promise.resolve()).then(task).catch(error => { blocked.add(id); onError(error); throw error; });
    // Retain a settled queue while returning the rejecting promise to the native store host.
    queues.set(id, job.catch(() => undefined)); return job;
  };
  return {
    async listThreads() {
      const { threads } = await studioRequest<{ threads: { summary: AgAiThreadSummary; revision: number }[] }>("chats");
      for (const row of threads) if (!queues.has(row.summary.threadId)) revisions.set(row.summary.threadId, row.revision);
      return threads.map(row => row.summary);
    },
    async loadThread(threadId) {
      const { record } = await studioRequest<{ record: { thread: AgAiThread; revision: number } | null }>(`chats/${encodeURIComponent(threadId)}`);
      if (!record) return undefined;
      revisions.set(threadId, record.revision); blocked.delete(threadId);
      return record.thread;
    },
    async saveThread(thread) {
      const copy = structuredClone(thread), id = copy.summary.threadId;
      return enqueue(id, async () => {
        if (blocked.has(id)) throw new Error("This conversation's saved history needs a reload. Its applied report edits remain in Undo.");
        const result = await studioRequest<{ revision: number }>("chats/save", { expectedRevision: revisions.get(id) ?? 0, thread: copy });
        revisions.set(id, result.revision); channel?.postMessage("changed");
      });
    },
    async deleteThread(threadId) {
      return enqueue(threadId, async () => {
        await studioRequest("chats/remove", { threadId, expectedRevision: revisions.get(threadId) ?? 0 });
        revisions.delete(threadId); channel?.postMessage("changed");
      });
    },
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); if (!listeners.size) channel?.close(); },
  };
}

export function createFieldproofHarness(api: AgStudioApi<FieldproofRegistry>, hooks: HarnessHooks): AgAiHarness {
  const runs = new Map<string, RunState>(), active = new Set<string>(), nativeTraces = new Map<string, AgAiTraceContext>();
  let receiptQueue = Promise.resolve();
  const prepare = async (runKey: string, parentRunId?: string, signal?: AbortSignal): Promise<RunState> => {
    const existing = runs.get(runKey); if (existing) return existing;
    const parent = parentRunId ? runs.get(nativeRunIdentity(parentRunId)) : undefined;
    if (parentRunId && !parent) throw new Error("The delegate's parent report cutoff is unavailable. Start a fresh question.");
    const cutoff = parent ? parent.cutoff : studioRequest<{ snapshot: StudioSnapshot }>(`datasets/${hooks.snapshot().role}/refresh`, {}, signal).then(async ({ snapshot }) => {
      await hooks.applySnapshot(snapshot); return snapshot;
    });
    const state = { cutoff, nextRound: 0 }; runs.set(runKey, state);
    return state;
  };
  const send = async (input: Omit<StudioAgentRequest, "round" | "datasetHandle">, signal?: AbortSignal) => {
    const state = await prepare(input.runKey, input.parentRunId, signal), cutoff = await state.cutoff;
    // Point-in-time browser observations are captured synchronously in the observer below.
    // Flush them before the next provider turn so complete_task and layout receipts survive.
    await receiptQueue;
    const result = await studioRequest<StudioAgentResponse>("agents/turn", { ...input, round: state.nextRound, datasetHandle: cutoff.datasetHandle }, signal);
    state.nextRound = result.nextRound; hooks.onRun(result.run); return result;
  };
  const adapter: AgLlmAdapter = {
    executeTurn(request, options) {
      const perform = async () => {
        const trace = nativeAdapterTrace(options?.trace, options?.trace ? nativeTraces.get(nativeRunIdentity(options.trace.runId)) : undefined);
        return send({ agentId: trace.agentId as StudioAgentId, runKey: trace.runId, threadId: trace.threadId,
          messages: nativeProtocolMessages(request.input), instructions: request.instructions ?? "", tools: request.tools ?? [],
          ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
          ...(trace.parentRunId ? { parentRunId: trace.parentRunId } : {}), ...(trace.parentToolCallId ? { parentToolCallId: trace.parentToolCallId } : {}) }, options?.signal);
      };
      const result = perform();
      return { stream: { async *[Symbol.asyncIterator]() { const response = await result; for (const event of response.events) yield event; } }, complete: result.then(response => response.response) };
    },
  };
  const run: (agentId: "fieldproof-steward" | "fieldproof-auditor") => AgAiAgentRun = agentId => async function* (input, context) {
    const trace = nativeAdapterTrace({ agentId, runId: input.runId, threadId: input.threadId, parentRunId: input.parentRunId, parentToolCallId: input.parentToolCallId }, nativeTraces.get(nativeRunIdentity(input.runId)));
    const request = { agentId, runKey: trace.runId, threadId: trace.threadId, messages: input.messages,
      instructions: context.instructions() ?? "", tools: input.tools, params: context.params,
      ...(trace.parentRunId ? { parentRunId: trace.parentRunId } : {}), ...(trace.parentToolCallId ? { parentToolCallId: trace.parentToolCallId } : {}) };
    while (!context.signal?.aborted) {
      const response = await send(request, context.signal);
      for (const event of response.events) yield event;
      if (!response.continue) return;
    }
  };
  const description = (name: string) => studioServerToolSchemas.find(tool => tool.name === name)!.description;
  const serverTools: AgAiTool[] = [
    api.defineAiTool({ name: "fieldproof_snapshot", kind: "server", description: description("fieldproof_snapshot"), params: s => s.object({ packageId: s.string().optional() }) }),
    api.defineAiTool({ name: "fieldproof_evidence", kind: "server", description: description("fieldproof_evidence"), params: s => s.object({ packageId: s.string().optional(), evidenceId: s.string().optional() }) }),
    api.defineAiTool({ name: "fieldproof_exceptions", kind: "server", description: description("fieldproof_exceptions"), params: s => s.object({ packageId: s.string().optional() }) }),
    api.defineAiTool({ name: "paypal_owned_read", kind: "server", description: description("paypal_owned_read"), params: s => s.object({ tool: s.enum(["get_order", "get_invoice"]), receiptId: s.string() }) }),
  ];
  // AG 3.1's harness factory fixes the default registry in its signature. Its runtime
  // API is identical for the React registry; custom widget definitions stay on this api.
  const harness = createAiHarness(api as unknown as AgStudioApi, ({ builtIn }) => {
    const steward: AgAiAgentDefinition = { ...builtIn.lead, id: "fieldproof-steward", name: "Steward", description: "Read the project record, explain what is ready, and shape this report with native Page and Widget delegates.",
      tools: ({ studio, tools }) => [...serverTools, studio.viewSchema(), studio.viewReport(), studio.viewPage(), studio.viewWidget(), studio.executeQuery(),
        tools.plan.view(), tools.plan.update(), tools.plan.clear(), tools.renameThread(), tools.delegateTo(["page", "widget", "data", "planning", "fieldproof-auditor"])],
      defaultToolCalls: () => [{ tool: "view_report" }, { tool: "view_schema" }],
      instructions: (ctx, params) => `${builtIn.lead.instructions?.(ctx, params) ?? ""}\nYou are Fieldproof Steward. Use the fixed server tools for financial and evidence facts. Native delegates edit only this private report. Do not move money or treat a reviewed expense as accepted physical work. Amounts are USD cents. Read the server snapshot before numerical conclusions, and verify an applied report change through a native read before claiming it. You can ask fieldproof-auditor to check facts independently.`,
    };
    const auditor: AgAiAgentDefinition = { id: "fieldproof-auditor", name: "Auditor", description: "Independently inspect redacted evidence, payment lineage, and unresolved exceptions. Read only.",
      schema: s => s.undefined(), instructions: () => "You are Fieldproof Auditor, a strictly read-only evidence and money-lineage reviewer. Use the scoped server snapshot and exact owned Toolkit reads where relevant. Distinguish money, expense review and physical work; name the cutoff and missing proof. Do not alter a report or financial record.",
      tools: ({ studio }) => [...serverTools, studio.viewSchema(), studio.viewReport(), studio.viewPage(), studio.viewWidget(), studio.executeQuery()],
      defaultToolCalls: () => [{ tool: "view_report" }],
    };
    return { primary: "fieldproof-steward", agents: [clientToolRunner({ ...steward, run: run("fieldproof-steward") }), clientToolRunner({ ...auditor, run: run("fieldproof-auditor") }),
      ...(["page", "widget", "data", "planning"] as const).map(id => directLlmRunner({ ...builtIn[id], adapter }))],
      history: chatHistory(hooks.snapshot().scope, hooks.onError),
      promptStarters: [
        { label: "What still needs proof?", prompt: "Read the scoped snapshot, evidence and exceptions. Explain what is collected, what expense review establishes, and what physical work still needs proof. Name the cutoff and do not treat a shortfall as spendable." },
        { label: "Independent Auditor check", prompt: "Delegate an independent, read-only check to fieldproof-auditor. Have it read the scoped snapshot, evidence and exceptions, explain which funds are available for allocation and whether any work is accepted, and make no report edits. Keep the same report cutoff and state its limitations." },
        { label: "Shape this report", prompt: "Use the native Page and Widget delegates to put the Funding & evidence rings beside the Project blueprint, then give the Evidence gallery more space beneath them. Preserve all six Fieldproof widgets, their row identities, package cross-filters and honest data semantics. Verify the applied changes." },
        { label: "Trace a contribution", prompt: "Find a receipt that my role can see and explain its recorded source, funding eligibility, and any actual allocation history. If it is an owned sandbox receipt, read the exact PayPal resource through the Toolkit. If no owned receipt or allocation exists, say so clearly." },
      ],
      observers: [{ onEvent(event) {
        if (event.type === "run_started") {
          nativeTraces.set(nativeRunIdentity(event.trace.runId), { ...event.trace });
          active.add(event.trace.runId); hooks.onActivity(active.size);
        }
        if (event.type === "run_finished") {
          active.delete(event.trace.runId); hooks.onActivity(active.size);
          if (runs.get(event.trace.runId)?.nextRound) {
            const observedHistory = structuredClone(api.getHistory());
            receiptQueue = receiptQueue.then(async () => { await studioRequest("agents/finished", { runKey: event.trace.runId, agentId: event.trace.agentId, threadId: event.trace.threadId, status: event.status, history: observedHistory }); }).catch(hooks.onError);
          }
          void receiptQueue.then(hooks.onTraceChanged);
        }
        if (event.type !== "tool_execution_finished" || event.kind !== "client" || !(STUDIO_CLIENT_TOOLS as readonly string[]).includes(event.name)) return;
        // Default native context calls run before a provider turn has issued any calls.
        // They are sent as browser context, not misrepresented as server-issued receipts.
        const state = runs.get(event.trace.runId); if (!state || state.nextRound === 0) return;
        const mutation = !["view_schema", "view_report", "view_page", "view_widget", "execute_query", "complete_task", "rename_thread", "delegate_to", "create_plan", "update_plan", "view_plan", "clear_plan"].includes(event.name);
        const observedHistory = mutation ? structuredClone(api.getHistory()) : undefined;
        const result = event.result ?? JSON.stringify(event.ok ? { success: true, response: "The native tool completed." } : { success: false, issues: event.issues ?? [{ message: "The native tool failed." }] });
        const trace: AgAiTraceContext = event.trace;
        receiptQueue = receiptQueue.then(async () => {
          await studioRequest("agents/client-receipt", { runKey: trace.runId, agentId: trace.agentId, threadId: trace.threadId,
            callId: event.toolCallId, name: event.name, ok: event.ok, result, ...(observedHistory ? { history: observedHistory } : {}) });
        }).catch(hooks.onError);
      } }],
    };
  });
  return harness;
}
