"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AgStudio } from "ag-studio-react";
import { AgStudioAiModule, AgStudioLicenseManager, singleColumnLayout, studioTheme, type AgAiHarness, type AgDataSourcesDefinition, type AgPanelConfig, type AgReportHistory, type AgStudioApi } from "ag-studio";
import { ArrowDownToLine, ArrowLeft, ArrowUpRight, Check, ChevronDown, CircleHelp, Eye, FileCheck2, History, LockKeyhole, MessageCircle, PencilRuler, RefreshCw, RotateCcw, RotateCw, Save, ShieldCheck, X } from "lucide-react";
import type { StudioSnapshot } from "@/lib/studio/contracts";
import { studioDurableHistorySignature, type StudioReportRecord } from "@/lib/studio/history";
import { studioDataDefinition, studioDefaultState, studioMoney } from "@/lib/studio/native-data";
import { studioTransactions } from "@/lib/studio/transactions";
import { fieldproofWidgets, type FieldproofRegistry, type StudioDetail, type StudioWidgetContext } from "./widgets";
import { StudioRequestError, studioRequest, studioAccessFailure as accessFailure } from "./transport";
import { createFieldproofHarness } from "./ai-harness";
import { StudioAgentTrace } from "./agent-trace";
import type { StudioAgentRunView } from "@/lib/studio/agent-contracts";
const warmTheme = studioTheme.withParams({
  fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 12, textColor: "#1E3A5F", backgroundColor: "#FFFEFA", borderColor: "#DCDDD5",
  studioMinWidth: 0, studioResponsiveMinWidth: 0, studioCanvasMinWidth: 0, studioCanvasBackgroundColor: "#F4F1EA",
  studioPanelWidth: 250, studioWidgetBorder: "1px solid #D9DFDD", studioWidgetBorderRadius: 16, studioWidgetPadding: 18,
  studioWidgetTitleFontFamily: '"Space Grotesk", sans-serif', studioWidgetTitleFontSize: 20, studioWidgetTitleFontWeight: 500,
  studioWidgetTitleTextColor: "#1E3A5F", studioWidgetSubtitleTextColor: "#687980", studioAiPanelWidth: 360,
  chartPaletteFills1Color: "#4A6FA5", chartPaletteFills2Color: "#F2A93B", chartPaletteFills3Color: "#3E8E5E",
});
const composePanels: AgPanelConfig = { edit: { left: ["data"], right: ["edit"] }, view: { left: ["filters"] }, options: { data: { tables: { collapsed: true } } } };
const assistantPanels: AgPanelConfig = { edit: { right: ["ai"] }, view: { left: ["filters"] } };
interface ConfigurationWarning { at: string; type: "state" | "validation"; details: string[]; }

export function NativeStudio({ initial, report: initialReport, license = "" }: { initial: StudioSnapshot; report: StudioReportRecord; license?: string }) {
  const [snapshot, setSnapshot] = useState(initial), [report, setReport] = useState(initialReport);
  const [mode, setMode] = useState<"view" | "edit">("view"), [ready, setReady] = useState(false), [refreshing, setRefreshing] = useState(false);
  const [history, setHistory] = useState({ undo: initialReport.history?.undo.length ?? 0, redo: initialReport.history?.redo.length ?? 0 });
  const [saveState, setSaveState] = useState<"saved" | "unsaved" | "saving" | "error">("saved");
  const [notice, setNotice] = useState<string | null>(null), [closed, setClosed] = useState<string | null>(null);
  const [assistantFocused, setAssistantFocused] = useState(false), [configurationWarnings, setConfigurationWarnings] = useState<ConfigurationWarning[]>([]);
  const [showHistory, setShowHistory] = useState(false), [detail, setDetail] = useState<StudioDetail | null>(null);
  const [showTrace, setShowTrace] = useState(false), [traceVersion, setTraceVersion] = useState(0), [agentCount, setAgentCount] = useState(0), [agentRun, setAgentRun] = useState<StudioAgentRunView | null>(null);
  const apiRef = useRef<AgStudioApi<FieldproofRegistry> | null>(null), current = useRef(initial), mounted = useRef(true);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const pending = useRef<AgReportHistory | null>(null), saving = useRef<Promise<void> | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revision = useRef(initialReport.revision), lastObserved = useRef(""), saveBlocked = useRef(false), updateChain = useRef(Promise.resolve());
  const detailTrigger = useRef<HTMLElement | null>(null);
  const openDetail = useCallback((next: StudioDetail, trigger: HTMLElement) => { detailTrigger.current = trigger; setDetail(next); }, []);
  const closeDetail = useCallback(() => {
    const trigger = detailTrigger.current; detailTrigger.current = null; setDetail(null);
    // Safari does not focus pointer-clicked buttons. Restore the actual invoking
    // control after React removes the modal, rather than relying on activeElement.
    requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }, []);
  const context = useRef<StudioWidgetContext>({ snapshot: initial, openDetail });
  const agentActive = useRef(0), harnesses = useRef(new WeakMap<AgStudioApi<FieldproofRegistry>, AgAiHarness>()), currentHarness = useRef<AgAiHarness | null>(null);
  const [data] = useState(() => studioDataDefinition(initial)), [widgets] = useState(fieldproofWidgets);
  const [initialState] = useState(() => initialReport.history ?? studioDefaultState());
  const [licensed] = useState(() => { if (license) AgStudioLicenseManager.setLicenseKey(license); return Boolean(license); });
  void licensed;

  const closeAccess = useCallback((message: string) => {
    for (const thread of currentHarness.current?.threads ?? []) currentHarness.current?.getSession?.(thread.threadId)?.cancel();
    pending.current = null; saveBlocked.current = true; setDetail(null); setClosed(message);
  }, []);
  const flush = useCallback(async () => {
    if (saving.current) return saving.current;
    if (!pending.current || saveBlocked.current) return;
    const task = async () => {
      while (pending.current && !saveBlocked.current && mounted.current) {
        const next = pending.current; pending.current = null; setSaveState("saving");
        try {
          const result = await studioRequest<{ report: StudioReportRecord }>("report", { expectedRevision: revision.current, history: next });
          revision.current = result.report.revision;
          if (mounted.current) { setReport(result.report); setSaveState(pending.current ? "unsaved" : "saved"); }
        } catch (error) {
          pending.current ??= next;
          if (mounted.current) {
            if (accessFailure(error)) closeAccess("Your access changed. The private report has been closed; return to the project to choose an available role.");
            else {
              setSaveState("error"); setNotice(error instanceof Error ? error.message : "The report could not be saved. Retry Save when the connection returns.");
              saveBlocked.current = error instanceof StudioRequestError && ["STUDIO_REPORT_CONFLICT", "STUDIO_HISTORY_INVALID", "STUDIO_HISTORY_CHANGED"].includes(error.code);
            }
          }
          return; // A transient failure remains a manual, idempotent Save retry.
        }
      }
    };
    saving.current = task().finally(() => { saving.current = null; });
    return saving.current;
  }, [closeAccess]);
  const captureHistory = useCallback((api: AgStudioApi<FieldproofRegistry>, immediate = false) => {
    const full = api.getHistory() as unknown as AgReportHistory, serialized = studioDurableHistorySignature(full);
    setHistory(previous => previous.undo === full.undo.length && previous.redo === full.redo.length ? previous : { undo: full.undo.length, redo: full.redo.length });
    if (serialized !== lastObserved.current || immediate) {
      lastObserved.current = serialized;
      pending.current = structuredClone(full); setSaveState("unsaved");
      if (timer.current) clearTimeout(timer.current);
      if (immediate) void flush(); else timer.current = setTimeout(() => { void flush(); }, 750);
    }
  }, [flush]);
  const onStateUpdated = useCallback(() => {
    // A stack-only update can have no changed state keys. Compare complete
    // durable history instead of saving ephemeral panel/hydration events.
    if (apiRef.current) captureHistory(apiRef.current);
  }, [captureHistory]);

  const applySnapshot = useCallback(async (next: StudioSnapshot) => {
    const job = async () => {
      if (!mounted.current || !apiRef.current) return;
      const diff = studioTransactions(current.current, next);
      if (diff.status === "scope_changed") { closeAccess("Your report role or membership changed. Reload to open a fresh, scoped view."); return; }
      if (diff.status === "stale") return;
      const engine = apiRef.current.getDataEngine();
      if (!engine?.applyTransaction) throw new Error("The native report engine is not ready for live updates.");
      context.current.snapshot = next;
      try { if (diff.transactions.length) await engine.applyTransaction(diff.transactions); }
      catch (error) { context.current.snapshot = current.current; throw error; }
      current.current = next; setSnapshot(next);
    };
    const nextJob = updateChain.current.then(job);
    updateChain.current = nextJob.catch(() => undefined);
    return nextJob;
  }, [closeAccess]);
  const refresh = useCallback(async (visible = false, signal?: AbortSignal) => {
    if (agentActive.current) { if (visible) setNotice("The assistant is using a fixed report cutoff. Data will refresh when this run finishes."); return; }
    if (visible) setRefreshing(true);
    try {
      const { snapshot: next } = await studioRequest<{ snapshot: StudioSnapshot }>("snapshot", undefined, signal);
      await applySnapshot(next);
      if (visible) setNotice(null);
    } catch (error) {
      if (signal?.aborted || !mounted.current) return;
      if (accessFailure(error)) closeAccess("Your access changed. The private report has been closed; return to the project to choose an available role.");
      else if (visible) setNotice(error instanceof Error ? error.message : "The report could not refresh.");
    } finally { if (mounted.current && visible) setRefreshing(false); }
  }, [applySnapshot, closeAccess]);
  const harnessFor = useCallback((api: AgStudioApi<FieldproofRegistry>) => {
    const existing = harnesses.current.get(api); if (existing) return existing;
    const harness = createFieldproofHarness(api, { snapshot: () => current.current, applySnapshot,
      onActivity(count) { agentActive.current = count; if (mounted.current) { setAgentCount(count); if (!count) void refresh(); } },
      onRun(run) { if (mounted.current) setAgentRun(run); },
      onTraceChanged() { if (mounted.current) setTraceVersion(version => version + 1); },
      onError(error) { if (!mounted.current) return; if (accessFailure(error)) closeAccess("Your report access changed. Return to the project to choose an available role."); else setNotice(error instanceof Error ? error.message : "The assistant's saved trace needs attention."); },
    });
    harnesses.current.set(api, harness); currentHarness.current = harness; return harness;
  }, [applySnapshot, closeAccess, refresh]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);
  useEffect(() => {
    if (!ready || closed) return;
    const abort = new AbortController();
    const interval = setInterval(() => { if (!document.hidden) void refresh(false, abort.signal); }, 8000);
    const focus = () => { if (!document.hidden) void refresh(false, abort.signal); };
    document.addEventListener("visibilitychange", focus);
    return () => { clearInterval(interval); abort.abort(); document.removeEventListener("visibilitychange", focus); };
  }, [ready, closed, refresh]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (pending.current || saving.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const switchRole = async (role: string) => {
    if (role === snapshot.role) return;
    try {
      if (apiRef.current) captureHistory(apiRef.current);
      await flush();
      if (saveBlocked.current || pending.current) { setNotice("Save this report’s changes before switching roles."); return; }
      await studioRequest("role", { role });
      closeAccess("Opening a fresh report for your new role…");
      window.location.reload();
    } catch (error) { setNotice(error instanceof Error ? error.message : "The role could not change."); }
  };
  const clearFilters = () => {
    const api = apiRef.current; if (!api) return;
    const state = api.getState();
    api.setState({ ...state, pages: state.pages.map(page => page.id === state.selectedPageId ? { ...page, crossFilter: undefined } : page) }, { historyLabel: "Clear package selections", source: { type: "ui" } });
  };
  const saveNow = () => {
    if (!apiRef.current) return;
    if (saveBlocked.current) { setNotice("Reload the saved report before making another save; your current layout is still on this page."); return; }
    captureHistory(apiRef.current, true);
  };
  const changeMode = (next: "view" | "edit") => {
    const api = apiRef.current;
    setAssistantFocused(false); setMode(next);
    if (!api) return;
    api.updateProperties({ mode: next, panels: composePanels });
    if (next === "edit") {
      const state = api.getState();
      api.setState({ ...state, panels: { ...state.panels, data: { ...state.panels?.data, collapsed: false }, edit: { ...state.panels?.edit, collapsed: false }, ai: { ...state.panels?.ai, collapsed: true } } });
    }
  };
  const openAssistant = () => {
    const api = apiRef.current; if (!api) return;
    setAssistantFocused(true); setMode("edit");
    // AG creates mode-specific panels expanded. Create the focused panel first,
    // then apply its ephemeral state; applying state in view mode misses it.
    api.updateProperties({ mode: "edit", panels: assistantPanels });
    const state = api.getState();
    api.setState({ ...state, panels: { ...state.panels, data: { ...state.panels?.data, collapsed: true }, edit: { ...state.panels?.edit, collapsed: true }, ai: { ...state.panels?.ai, collapsed: false, width: Math.min(360, frameRef.current?.clientWidth ?? 360) } } });
    requestAnimationFrame(() => {
      if (window.matchMedia("(max-width: 760px)").matches) frameRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
      frameRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
    });
  };
  const downloadHistory = () => {
    if (!apiRef.current) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(apiRef.current.getHistory(), null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `fieldproof-private-report-${snapshot.role}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (closed) return <section className="studio-closed" role="status"><LockKeyhole size={28}/><h1>A fresh view, with the right access.</h1><p>{closed}</p><div><button className="button primary" onClick={() => window.location.reload()}>Reload report</button><Link href="/" className="button secondary">Return to the project</Link></div></section>;

  return <>
    <section className="studio-title-row"><div><span className="eyebrow">THE PROOF STUDIO / {snapshot.mode === "sample" ? "ILLUSTRATIVE WORKSPACE" : "LIVE SANDBOX RECORD"}</span><h1>See the whole picture<span>.</span></h1><p>{snapshot.projectTitle} <span>·</span> A connected record of the plan, its money, and the work behind it.</p></div><label className="studio-role-control"><span>Viewing as</span><select aria-label="Report role" value={snapshot.role} disabled={agentCount > 0} onChange={event => void switchRole(event.target.value)}><option value="donor">Contributor</option><option value="volunteer">Volunteer</option><option value="organizer">Organizer</option><option value="auditor">Auditor</option></select><ChevronDown size={13}/></label></section>
    <section className="studio-trust-strip"><span><i className={snapshot.mode === "sample" ? "sample" : ""}/>{snapshot.mode === "sample" ? "Sample data · no real work certified" : "Actual sandbox records · test funds"}</span><span><LockKeyhole size={12}/>{snapshot.role === "donor" ? "Your receipts and shared package facts" : snapshot.role === "volunteer" ? "Your private sources and shared package facts" : snapshot.role === "auditor" ? "Redacted financial and review facts" : "Workspace evidence and financial facts"}</span><span title={snapshot.asOf}>Cutoff {new Date(snapshot.asOf).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span></section>
    <div className="studio-toolbar"><div className="studio-mode-switch" role="group" aria-label="Report mode"><button className={mode === "view" ? "active" : ""} onClick={() => changeMode("view")}><Eye size={14}/>Explore</button><button className={mode === "edit" && !assistantFocused ? "active" : ""} onClick={() => changeMode("edit")}><PencilRuler size={14}/>Compose</button></div><span className="studio-toolbar-rule"/><div className="studio-history-actions"><button aria-label="Undo report edit" disabled={!ready || !history.undo} onClick={() => apiRef.current?.undo()}><RotateCcw size={16}/></button><button aria-label="Redo report edit" disabled={!ready || !history.redo} onClick={() => apiRef.current?.redo()}><RotateCw size={16}/></button></div><button className="studio-tool-button" onClick={clearFilters} disabled={!ready}>Clear selections</button><div className="studio-toolbar-spacer"/><button className="studio-tool-button" onClick={() => setShowHistory(value => !value)} aria-expanded={showHistory}><History size={14}/>History <span>{history.undo}</span></button><button className="studio-icon-control" aria-label="Refresh report data" onClick={() => void refresh(true)} disabled={!ready || refreshing}><RefreshCw size={15} className={refreshing ? "spin" : ""}/></button><button className="studio-save" onClick={saveNow} disabled={!ready || saveState === "saving"}><Save size={14}/>{saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : saveState === "error" ? "Save needs attention" : "Save report"}{saveState === "saved" && <Check size={12}/>}</button></div>
    {notice && <div className="studio-notice" role="status"><CircleHelp size={16}/><p>{notice}</p><button onClick={() => setNotice(null)} aria-label="Dismiss report message"><X size={16}/></button></div>}
    {configurationWarnings.length > 0 && <details className="studio-configuration-notices"><summary><CircleHelp size={16}/>Studio recorded a configuration warning during report changes.<span>Review details</span></summary><p>A warning can describe an intermediate edit. Check the current view before drawing conclusions; these are the original native notices from this page session.</p><ol>{configurationWarnings.map((warning, index) => <li key={`${warning.at}:${index}`}><time>{new Date(warning.at).toLocaleTimeString()}</time><strong>{warning.type === "state" ? "Report state" : "Report validation"}</strong><ul>{warning.details.map((text, item) => <li key={item}>{text}</li>)}</ul></li>)}</ol><button onClick={() => setConfigurationWarnings([])}>Dismiss recorded notices</button></details>}
    {saveState === "error" && <div className="studio-history-recovery"><p>Your current layout and full Undo history are still on this page.</p><button onClick={downloadHistory}><ArrowDownToLine size={14}/>Download private history</button></div>}
    <section className="studio-assistant-bar"><div className="studio-assistant-emblem"><MessageCircle size={19}/></div><div><strong>A little help seeing what matters.</strong><p>Ask Steward to explain or shape your report, or request an independent Auditor check. Report edits stay in Undo.</p></div><span className="studio-agent-status" aria-live="polite">{agentCount ? `${agentCount === 1 ? "Assistant" : `${agentCount} agents`} working · fixed cutoff` : agentRun ? `${agentRun.stats.modelTurns} model turns · ${agentRun.stats.serverTools} server reads` : "Private to your current role"}</span><button className="studio-tool-button" onClick={() => setShowTrace(value => !value)} aria-expanded={showTrace}>View trace</button><button className="studio-ask" onClick={openAssistant} disabled={!ready} aria-pressed={assistantFocused}><MessageCircle size={15}/>Ask the Studio</button></section>
    {showTrace && <StudioAgentTrace version={traceVersion} active={agentCount > 0} onError={error => setNotice(error instanceof Error ? error.message : "The assistant trace is unavailable.")}/>}
    {showHistory && <aside className="studio-history-drawer"><div><span className="studio-overline">YOUR REPORT, REMEMBERED</span><strong>{history.undo} undo steps · {history.redo} redo steps</strong><p>Full native history is saved with this role’s private report. Layout history describes browser edits; it does not establish a financial approval.</p></div><ol>{report.audit.slice(0, 6).map(event => <li key={event.revision}><span>v{event.revision}</span><strong>{event.label}</strong><time>{new Date(event.savedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</time></li>)}{!report.audit.length && <li>Your first saved edit will appear here.</li>}</ol></aside>}
    {assistantFocused && <div className="studio-assistant-focus-note"><span>Your report stays saved while you ask.</span><button onClick={() => changeMode("view")}><ArrowLeft size={14}/>Back to report</button></div>}
    <div ref={frameRef} className={`studio-native-frame ${mode === "edit" ? "is-composing" : ""} ${assistantFocused ? "is-asking" : ""}`} aria-label="Native Fieldproof Studio report">
      <AgStudio<FieldproofRegistry> studioId="fieldproof-proof-studio" modules={[AgStudioAiModule]} style={{ width: "100%", height: "100%" }} theme={warmTheme} loadThemeGoogleFonts={false}
        data={data as unknown as AgDataSourcesDefinition<FieldproofRegistry>} widgets={widgets} context={context.current} initialState={initialState as never} mode={mode} history={{ maxEntries: 500, onModeChange: "preserve" }}
        ai={({ api }) => harnessFor(api as AgStudioApi<FieldproofRegistry>)}
        panels={assistantFocused ? assistantPanels : composePanels}
        responsiveLayoutBreakpoints={[{ maxWidth: 760, layout: singleColumnLayout }]}
        onStudioReady={event => { const api = event.api as AgStudioApi<FieldproofRegistry>; apiRef.current = api; const harness = harnessFor(api); void harness.agents; const restored = api.getHistory(); lastObserved.current = studioDurableHistorySignature(restored); setHistory({ undo: restored.undo.length, redo: restored.redo.length }); setReady(true); }}
        onStateUpdated={onStateUpdated}
        onErrorRaised={event => { if (event.fatal) closeAccess("The saved report could not be loaded without losing information. Keep its stored version and return to the project while the report configuration is reviewed."); else setConfigurationWarnings(previous => [...previous.slice(-9), { at: new Date().toISOString(), type: event.errorType, details: [...event.errorDetails] }]); }}
      />
    </div>
    <footer className="studio-bottom-note"><span><ShieldCheck size={15}/>Every view respects your current role.</span><p>A saved report is a view of the records at its cutoff. Publication, physical signoff, and money movement each require their own review.</p><span>Projection {snapshot.projectionVersion} · {snapshot.semanticVersion}</span></footer>
    {detail && <StudioDetailDialog detail={detail} snapshot={snapshot} onClose={closeDetail}/>}
  </>;
}

function StudioDetailDialog({ detail, snapshot, onClose }: { detail: StudioDetail; snapshot: StudioSnapshot; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), [preview, setPreview] = useState(false), [previewError, setPreviewError] = useState(false);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => { if (element?.open) element.close(); }; }, []);
  const evidence = detail.kind === "evidence" ? snapshot.data.evidence.find(row => row.id === detail.id) : null;
  const allocation = detail.kind === "allocation" ? snapshot.data.allocations.find(row => row.id === detail.id) : null;
  const exception = detail.kind === "exception" ? snapshot.data.exceptions.find(row => row.id === detail.id) : null;
  const packageId = detail.kind === "package" ? detail.id : evidence?.packageId ?? allocation?.packageId ?? exception?.packageId;
  const pkg = snapshot.data.packages.find(row => row.id === packageId), packageEvidence = snapshot.data.evidence.filter(row => row.packageId === packageId);
  return <dialog ref={dialog} className="studio-detail-dialog" aria-labelledby="studio-detail-title" onCancel={event => { event.preventDefault(); onClose(); }}><div className="studio-detail-head"><span className="studio-overline">SCOPED DRILL-THROUGH / {snapshot.role.toUpperCase()}</span><button className="studio-icon-control" aria-label="Close report detail" onClick={onClose}><X size={20}/></button></div><h2 id="studio-detail-title">{evidence?.title ?? exception?.title ?? allocation?.expenseLabel ?? pkg?.title ?? "Record detail"}</h2><p className="studio-detail-cutoff">{pkg?.title ?? "Project-level record"} · {new Date(snapshot.asOf).toLocaleString()} cutoff</p>
    {evidence && <><div className="studio-detail-callout"><FileCheck2 size={22}/><div><strong>What this review establishes</strong><p>{evidence.reviewScope}</p></div></div><dl className="studio-detail-facts"><div><dt>Source class</dt><dd>{evidence.sourceClass.replaceAll("_", " ")}</dd></div><div><dt>Review state</dt><dd>{evidence.reviewState.replaceAll("_", " ")}</dd></div><div><dt>Package association</dt><dd>{evidence.amountMinor === null ? "Nonfinancial evidence" : studioMoney(evidence.amountMinor)}</dd></div><div><dt>Provenance</dt><dd>{evidence.provenance.replaceAll("_", " ")}</dd></div></dl>{evidence.sourceAvailable && evidence.documentId ? <><div className="studio-detail-actions"><button className="button primary" onClick={() => setPreview(value => !value)}><Eye size={15}/>{preview ? "Close private preview" : "View private original"}</button><a className="button secondary" href={`/api/documents/${encodeURIComponent(evidence.documentId)}/original`}><ArrowDownToLine size={15}/>Download original</a>{evidence.claimId && <Link href="/review" className="studio-detail-link">Open expense review<ArrowUpRight size={13}/></Link>}</div>{preview && (previewError ? <p className="studio-notice">The private preview is unavailable or your access changed. Return to the source record to check it.</p> : <img className="studio-private-preview" src={`/api/documents/${encodeURIComponent(evidence.documentId)}/preview?page=1`} alt="Private original document, first page" onError={() => setPreviewError(true)}/>)}</> : <p className="studio-source-restricted"><LockKeyhole size={15}/>This role receives the scoped summary. No private original or recipient details are included.</p>}</>}
    {detail.kind === "package" && pkg && <><dl className="studio-detail-facts"><div><dt>Approved budget</dt><dd>{studioMoney(pkg.budgetMinor)}</dd></div><div><dt>Net collected</dt><dd>{studioMoney(pkg.collectedMinor)}</dd></div><div><dt>Reviewed expenses</dt><dd>{studioMoney(pkg.approvedExpenseMinor)}</dd></div><div><dt>Delivered repayments</dt><dd>{studioMoney(pkg.paidExpenseMinor)}</dd></div><div><dt>Accepted work requirements</dt><dd>{pkg.reviewedItemCount} / {pkg.requiredItemCount}</dd></div><div><dt>Available for allocation</dt><dd>{studioMoney(pkg.availableAllocationMinor)}</dd></div></dl><div className="studio-detail-callout"><ShieldCheck size={22}/><p>Expense review, eligible collection, and physical acceptance are separate facts. This report does not authorize a payout or certify the space.</p></div><h3>Evidence in this package</h3><ul className="studio-detail-sources">{packageEvidence.map(row => <li key={row.id}><FileCheck2 size={16}/><span><strong>{row.title}</strong><small>{row.reviewScope}</small></span>{row.amountMinor !== null && <b>{studioMoney(row.amountMinor)}</b>}</li>)}{!packageEvidence.length && <li>No visible evidence at this cutoff.</li>}</ul></>}
    {allocation && <><dl className="studio-detail-facts"><div><dt>Revision</dt><dd>{allocation.revision} · {allocation.isCurrent ? "Current" : "Historical"}</dd></div><div><dt>Revision amount</dt><dd>{studioMoney(allocation.allocationMinor)}</dd></div><div><dt>Counts in current totals</dt><dd>{studioMoney(allocation.activeAllocationMinor)}</dd></div><div><dt>State</dt><dd>{allocation.state.replaceAll("_", " ")}</dd></div></dl><p>This link comes from a recorded allocation revision. Earlier revisions stay in the trail; an allocation alone does not prove that a repayment was delivered.</p><code className="studio-record-id">Receipt {allocation.settlementReceiptId}</code></>}
    {exception && <><div className="studio-detail-callout"><CircleHelp size={22}/><p>{exception.detail}</p></div><dl className="studio-detail-facts"><div><dt>State</dt><dd>{exception.status.replaceAll("_", " ")}</dd></div><div><dt>Affected amount</dt><dd>{studioMoney(exception.affectedMinor)}</dd></div><div><dt>Last stored observation</dt><dd>{exception.observedAt ? new Date(exception.observedAt).toLocaleString() : "No provider observation"}</dd></div><div><dt>Recorded operation</dt><dd>{exception.operationId ? "An operation exists" : "No operation exists"}</dd></div></dl><p>Exception amounts may overlap. A missing operation or an uncertain result never establishes a decline, a payment, or permission to try another collection route.</p><Link href={exception.category.includes("review") ? "/review" : "/collection"} className="button secondary">Open the recorded workflow<ArrowUpRight size={14}/></Link></>}
    <div className="studio-detail-foot"><LockKeyhole size={13}/>Private to this workspace role<button onClick={onClose}>Back to the report<ArrowLeft size={13}/></button></div>
  </dialog>;
}
