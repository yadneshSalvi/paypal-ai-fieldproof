"use client";
import { useEffect, useRef, useState } from "react";
import { Check, CircleHelp, FileSearch, LockKeyhole, Waypoints } from "lucide-react";
import { studioRequest } from "./transport";

interface Run {
  id: string; agentId: string; state: string; model: string; promptVersion: string; inputHash: string; datasetHandle: string; code: string | null;
  createdAt: string; parentRunId: string | null; parentToolCallId: string | null;
  diagnostic?: { stage: string; diagnostic: { errorClass?: string; status?: number | null; requestId?: string | null; retryAfterSeconds?: number | null } } | null;
  stats: { inputTokens: number; outputTokens: number; modelTurns: number; serverTools: number; clientTools: number };
  turns: { providerId: string; model: string; at: number; inputHash: string; outputHash: string }[];
  receipts: { callId: string; name: string; transport: string; status: string; inputHash: string; outputHash: string; at: string }[];
}
const names: Record<string, string> = { "fieldproof-steward": "Steward", "fieldproof-auditor": "Auditor", page: "Native Page", widget: "Native Widget", data: "Native Data", planning: "Native Planning" };
export function StudioAgentTrace({ version, active, onError }: { version: number; active: boolean; onError(error: unknown): void }) {
  const [runs, setRuns] = useState<Run[]>([]), [loaded, setLoaded] = useState(false), errorHandler = useRef(onError);
  errorHandler.current = onError;
  useEffect(() => {
    const abort = new AbortController();
    const load = async () => { try { const data = await studioRequest<{ runs: Run[] }>("agents/runs", undefined, abort.signal); setRuns(data.runs); setLoaded(true); } catch (error) { if (!abort.signal.aborted) errorHandler.current(error); } };
    void load(); const interval = active ? setInterval(() => { void load(); }, 8000) : null;
    return () => { abort.abort(); if (interval) clearInterval(interval); };
  }, [version, active]);
  return <aside className="studio-agent-trace"><div className="studio-trace-intro"><span className="studio-overline">WHAT ACTUALLY RAN</span><h2>A record you can follow.</h2><p>Server reads and browser report edits have separate receipts. A trace records what ran; it grants no financial approval.</p><span><LockKeyhole size={13}/>Encrypted and scoped to this actor and role</span></div><div className="studio-trace-runs">
    {!runs.length && <div className="studio-trace-empty"><FileSearch size={24}/><strong>{loaded ? "No assistant run in this role yet." : "Opening the private run record…"}</strong><p>Your first question will record its model, source cutoff, actual tools, and saved report observations here.</p></div>}
    {runs.map(run => <details key={run.id} className="studio-trace-run"><summary><Waypoints size={15}/><strong>{names[run.agentId] ?? run.agentId}</strong>{run.parentRunId && <small>Delegate</small>}<span>{run.state.replaceAll("_", " ")}</span><time>{new Date(run.createdAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</time></summary><div className="studio-trace-body"><p>{run.model} · {run.stats.modelTurns} model turns · {run.stats.inputTokens.toLocaleString()} input / {run.stats.outputTokens.toLocaleString()} output tokens</p>{run.code && <p className="studio-trace-error"><CircleHelp size={14}/>{run.code.replaceAll("_", " ")}</p>}{run.diagnostic && <p>Stage: {run.diagnostic.stage.replaceAll("_", " ")} · {run.diagnostic.diagnostic.errorClass}{run.diagnostic.diagnostic.status ? ` · Provider HTTP ${run.diagnostic.diagnostic.status}` : ""}{run.diagnostic.diagnostic.retryAfterSeconds != null ? ` · Provider retry-after ${run.diagnostic.diagnostic.retryAfterSeconds}s` : ""}{run.diagnostic.diagnostic.requestId && <code className="studio-diagnostic-reference">Provider reference {run.diagnostic.diagnostic.requestId}</code>}</p>}<dl><div><dt>Prompt contract</dt><dd>{run.promptVersion}</dd></div><div><dt>Scoped dataset</dt><dd>{run.datasetHandle}</dd></div><div><dt>Original input hash</dt><dd>{run.inputHash}</dd></div>{run.parentToolCallId && <div><dt>Parent native delegation</dt><dd>{run.parentToolCallId}</dd></div>}</dl><ol>{run.receipts.map(receipt => <li key={receipt.callId}>{receipt.status === "succeeded" ? <Check size={14}/> : <CircleHelp size={14}/>}<span><strong>{receipt.name.replaceAll("_", " ")}</strong><small>{receipt.transport === "native_server_tool" ? "Executed on the server" : "Observed in the native browser report"} · {receipt.status}</small><code title={receipt.outputHash}>Output {receipt.outputHash.slice(0, 20)}…</code></span></li>)}</ol>{!run.receipts.length && <p>No completed tool receipt is recorded for this run.</p>}<details className="studio-model-receipts"><summary>Model response receipts ({run.turns.length})</summary>{run.turns.map(turn => <p key={turn.providerId}><strong>{turn.model}</strong><code>{turn.providerId}</code><code>Input {turn.inputHash}</code><code>Output {turn.outputHash}</code></p>)}</details></div></details>)}
  </div></aside>;
}
