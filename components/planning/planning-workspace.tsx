"use client";
import { bindWorkspaceContext, workspaceFetch } from "@/lib/community/workspace-fetch";

import Link from "next/link";
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, BookOpen, CircleHelp, FileImage, GitBranch, History, LayoutGrid, LockKeyhole, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { PlanningWorkspace as Workspace, ProposedPlan } from "@/lib/planning/contracts";
import { draftReducer, initialDraft, type DraftState } from "./draft";
import { WorkspaceScope } from "../community/workspace-scope";
import { PlanEditor } from "./plan-editor";
import { SourceLibrary, SourcePreview } from "./source-library";
import { ScenarioWorkspace } from "./scenario-workspace";
import { ImageAlignmentWorkspace } from "./image-alignment";
import { ReviewerWorkspace } from "./reviewer-workspace";
import { PlanHistory } from "./plan-history";
import { Modal, PlanningContext, PlanningRequestError, Status, downloadPrivateJson, planningRequest, type Mutate } from "./ui";

export type PlanningSection = "sources" | "layout" | "dependencies" | "images" | "review" | "history";
const sections: { id: PlanningSection; title: string; number: string; icon: typeof LayoutGrid }[] = [
  { id: "sources", title: "Sources", number: "01", icon: BookOpen }, { id: "layout", title: "Layout", number: "02", icon: LayoutGrid },
  { id: "dependencies", title: "Possibilities", number: "03", icon: GitBranch }, { id: "images", title: "Image & place", number: "04", icon: FileImage },
  { id: "review", title: "Work review", number: "05", icon: ShieldCheck }, { id: "history", title: "Version history", number: "06", icon: History },
];
const roleLabels = { organizer: "Organizer", volunteer: "Volunteer reviewer", donor: "Donor", auditor: "Auditor · read only" };
export function PlanningWorkspace({ initial, initialSection = "layout" }: { initial: Workspace; initialSection?: PlanningSection }) {
  bindWorkspaceContext(initial.projectId);
  const [workspace, setWorkspace] = useState<Workspace | null>(initial), [busy, setBusy] = useState<string | null>(null), [message, setMessage] = useState<{ text: string; error: boolean } | null>(null), [unavailable, setUnavailable] = useState<string | null>(null);
  const latest = useRef<Workspace | null>(initial), locked = useRef(false), intents = useRef(new Map<string, string>()), pollRunning = useRef(false);
  const notify = useCallback((text: string, error = false) => setMessage({ text, error }), []);
  const apply = useCallback((value: Workspace, expectedScope: string) => {
    const previous = latest.current;
    if (!previous || previous.scope !== expectedScope) return;
    if (value.scope === previous.scope && (value.projectionVersion < previous.projectionVersion || value.headVersion < previous.headVersion || Date.parse(value.asOf) < Date.parse(previous.asOf))) return;
    latest.current = value; setWorkspace(value);
    if (value.scope !== previous.scope) { intents.current.clear(); notify("The project or role changed. Private drafts and selections were cleared for the new scope."); }
  }, [notify]);
  const handleError = useCallback((error: unknown) => {
    const text = error instanceof Error ? error.message : "This planning step could not finish. Your saved records are still retained.";
    if (error instanceof PlanningRequestError && ["SESSION_REQUIRED", "MEMBERSHIP_DENIED"].includes(error.code)) { latest.current = null; setWorkspace(null); setUnavailable(text); intents.current.clear(); }
    else notify(text, true);
  }, [notify]);
  const reload = useCallback(async () => {
    const previous = latest.current; if (!previous) throw new Error("A current project session is required.");
    try { const result = await planningRequest<{ workspace: Workspace }>(); apply(result.workspace, previous.scope); return result.workspace; }
    catch (error) { handleError(error); throw error; }
  }, [apply, handleError]);
  const mutate: Mutate = useCallback(async <T,>(path: string, raw: Record<string, unknown>, options: { intent?: boolean; label?: string } = {}): Promise<T> => {
    const current = latest.current;
    if (!current) throw new Error("A current project session is required.");
    if (locked.current) throw new Error("The current action is still finishing. Keep your draft and wait for its saved result.");
    locked.current = true; setBusy(options.label ?? "Saving the reviewed change"); setMessage(null);
    const key = `${current.scope}:${path}:${JSON.stringify(raw)}`;
    const body = { ...raw };
    if (options.intent !== false && !body.intentId) { const intent = intents.current.get(key) ?? crypto.randomUUID(); intents.current.set(key, intent); body.intentId = intent; }
    try {
      const result = await planningRequest<T>(path, body), updated = (result as { workspace?: Workspace }).workspace;
      if (updated) apply(updated, current.scope);
      intents.current.delete(key); return result;
    } catch (error) { handleError(error); throw error; }
    finally { locked.current = false; setBusy(null); }
  }, [apply, handleError]);
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== "visible" || pollRunning.current || locked.current || !latest.current) return;
      pollRunning.current = true; void reload().catch(() => undefined).finally(() => { pollRunning.current = false; });
    };
    const timer = setInterval(check, 8000); window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { clearInterval(timer); window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, [reload]);
  if (!workspace) return <main className="pl-entry"><Link href="/" className="wordmark">fieldproof<span className="brand-dot">.</span></Link><div className="pl-entry-body"><span className="pl-kicker">CURRENT ACCESS REQUIRED</span><h1>This review needs<br/>a current role.</h1><p role="alert">{unavailable}</p><Link className="pl-button primary" href="/">Return to the project <ArrowRight size={16}/></Link></div></main>;
  return <PlanningContext.Provider value={{ workspace, busy, mutate, reload, notify }}><ScopedWorkspace key={workspace.scope} workspace={workspace} busy={busy} initialSection={initialSection} onRoleChange={async role => {
    if (locked.current) return;
    locked.current = true; setBusy("Changing the authorized workspace role");
    try {
      const response = await workspaceFetch("/api/session/role", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) });
      if (!response.ok) { const error = await response.json(); throw new PlanningRequestError(error.error ?? "This role is unavailable.", error.code ?? "ROLE_DENIED", response.status); }
      await reload();
    } catch (error) { handleError(error); } finally { locked.current = false; setBusy(null); }
  }} status={message ? <div className={`pl-message ${message.error ? "error" : ""}`} role={message.error ? "alert" : "status"}><p>{message.text}</p><button className="pl-icon-button" aria-label="Dismiss planning message" onClick={() => setMessage(null)}><X size={17}/></button></div> : null}/></PlanningContext.Provider>;
}
function ScopedWorkspace({ workspace, busy, initialSection, onRoleChange, status }: { workspace: Workspace; busy: string | null; initialSection: PlanningSection; onRoleChange: (role: Workspace["role"]) => Promise<void>; status: ReactNode }) {
  const [section, setSection] = useState<PlanningSection>(initialSection === "sources" && !["organizer", "volunteer"].includes(workspace.role) ? "layout" : initialSection), [draft, dispatch] = useReducer(draftReducer, undefined, () => initialDraft(workspace.current, workspace.headVersion)), [sourceId, setSourceId] = useState<string | null>(null), [replacement, setReplacement] = useState<{ plan: ProposedPlan; origin: DraftState["origin"]; runId?: string | null } | null>(null), [roleChoice, setRoleChoice] = useState<Workspace["role"] | null>(null), [help, setHelp] = useState(false);
  const source = workspace.sources.find(s => s.id === sourceId), privateRole = ["organizer", "volunteer"].includes(workspace.role);
  const go = (next: PlanningSection) => { setSection(next); history.replaceState(null, "", `/planning?section=${next}`); };
  const loadDraft = (value: { plan: ProposedPlan; origin: DraftState["origin"]; runId?: string | null }) => { dispatch({ type: "load", plan: value.plan, version: workspace.headVersion, planId: workspace.current?.id ?? null, origin: value.origin, sourceRunId: value.runId ?? null, dirty: true }); go("layout"); };
  const replaceDraft = (plan: ProposedPlan, origin: DraftState["origin"], runId?: string | null) => { const value = { plan, origin, runId }; if (draft.dirty) setReplacement(value); else loadDraft(value); };
  useEffect(() => { if (!draft.dirty) return; const listener = (event: BeforeUnloadEvent) => { event.preventDefault(); }; window.addEventListener("beforeunload", listener); return () => window.removeEventListener("beforeunload", listener); }, [draft.dirty]);
  return <div className="pl-shell"><WorkspaceScope projectId={workspace.projectId}/><a href="#planning-main" className="skip-link">Skip to planning workspace</a><header className="pl-header"><Link className="wordmark" href="/" aria-label="Fieldproof home"><span className="brand-mark"><i/><i/><i/><i/></span>fieldproof<span className="brand-dot">.</span></Link><nav aria-label="Project workspace"><Link href="/community?return=/planning">Saved workspaces</Link><Link href="/update-desk">Update desk</Link><Link href="/organizer">Project workspace</Link><Link href="/studio">Proof studio <ArrowRight size={13}/></Link></nav><label className="pl-role-select"><span>Viewing as</span><select value={workspace.role} disabled={!!busy} onChange={event => { const role = event.target.value as Workspace["role"]; if (draft.dirty) setRoleChoice(role); else void onRoleChange(role); }}>{workspace.allowedRoles.map(role => <option key={role} value={role}>{roleLabels[role]}</option>)}</select></label></header>
    <div className="pl-context"><div><Link href="/packages">{workspace.projectTitle}</Link><span>/</span><span>The planning desk</span></div><div><Status state={workspace.mode === "sample" ? "warm" : "muted"}>{workspace.mode === "sample" ? "Sample project" : "Live sandbox project"}</Status><Status><LockKeyhole size={11}/> Private workspace</Status></div></div>
    <div className="pl-desk-heading"><div><span className="pl-kicker">FROM A ROUGH SKETCH TO REVIEWED PROOF</span><h1>A place for<br/>every possibility<span>.</span></h1><p>Give each work package a shape, a source, and a clear next step.</p></div><div className="pl-desk-stamp"><span className="pl-stamp-cross" aria-hidden="true">+</span><strong>{workspace.published?.state === "current" ? `R${String(workspace.published.revision).padStart(2, "0")}` : "DRAFT"}</strong><span>{workspace.published?.state === "current" ? "REVIEWED SHARED PLAN" : "A PLAN IN PROGRESS"}</span><i>Sources. Scope. Human review.</i></div></div>
    <nav className="pl-tabs" aria-label="Planning steps">{sections.filter(item => item.id !== "sources" || privateRole).map(item => <button type="button" key={item.id} className={section === item.id ? "active" : ""} aria-current={section === item.id ? "page" : undefined} onClick={() => go(item.id)}><span>{item.number}</span><item.icon size={16}/>{item.title}{item.id === "layout" && draft.dirty && <i className="pl-unsaved-dot" aria-label="Unsaved draft"/>}</button>)}<button className="pl-help-button" aria-label="Explain review boundaries" onClick={() => setHelp(true)}><CircleHelp size={19}/></button></nav>
    {status}<div className="pl-operation-status" role="status" aria-live="polite">{busy && <><span className="pl-spinner"/>{busy}…</>}</div>
    <main id="planning-main"><fieldset className="pl-workspace-fields" disabled={!!busy}><section hidden={section !== "sources"} aria-label="Private source library"><SourceLibrary onOpen={s => setSourceId(s.id)}/></section><section hidden={section !== "layout"} aria-label="Source plan editor"><PlanEditor draft={draft} dispatch={dispatch} onSources={() => go("sources")} replaceDraft={replaceDraft}/></section><section hidden={section !== "dependencies"} aria-label="Prerequisites and scenario comparison"><ScenarioWorkspace draft={draft} edit={(update, checkpoint = true) => dispatch({ type: "edit", update, checkpoint })} onLayout={() => go("layout")}/></section><section hidden={section !== "images"} aria-label="Reviewed image comparison"><ImageAlignmentWorkspace onSources={() => go("sources")} onLayout={() => go("layout")}/></section><section hidden={section !== "review"} aria-label="Physical work review"><ReviewerWorkspace onSources={() => go("sources")} onImages={() => go("images")} onSource={setSourceId}/></section><section hidden={section !== "history"} aria-label="Plan version history"><PlanHistory onRestore={plan => replaceDraft(plan, "manual")}/></section></fieldset></main>
    <footer className="pl-footer"><Link href="/organizer"><ArrowLeft size={14}/>Back to project workspace</Link><p>Funding, geometry and physical acceptance are separate records.<br/>Every shared plan starts with a source and ends with a person.</p><span>fieldproof.</span></footer>
    {source && <SourcePreview key={`${source.id}:${source.controlVersion}`} source={source} onClose={() => setSourceId(null)}/>}
    {replacement && <Modal title="Keep this draft before switching" onClose={() => setReplacement(null)}><p>Your current drawing has unsaved edits. Download a private copy, then open the selected contents as a new draft.</p><div className="pl-actions"><button className="pl-button primary" onClick={() => { if (draft.plan) downloadPrivateJson({ privateDraft: true, baseVersion: draft.baseVersion, plan: draft.plan }, "fieldproof-private-draft-before-switch.json"); loadDraft(replacement); setReplacement(null); }}>Keep a copy & open new draft</button><button className="pl-button secondary" onClick={() => setReplacement(null)}>Keep editing</button></div></Modal>}
    {roleChoice && <Modal title="Keep your private draft before changing role" onClose={() => setRoleChoice(null)}><p>Changing role clears private planning contents from the screen. Keep a copy of unsaved edits first.</p><div className="pl-actions"><button className="pl-button primary" onClick={() => { if (draft.plan) downloadPrivateJson({ privateDraft: true, plan: draft.plan }, "fieldproof-private-draft-before-role-change.json"); const next = roleChoice; setRoleChoice(null); void onRoleChange(next); }}>Keep a copy & change role</button><button className="pl-button secondary" onClick={() => setRoleChoice(null)}>Keep this role</button></div></Modal>}
    {help && <Modal title="Four separate kinds of confidence" onClose={() => setHelp(false)}><ol className="pl-help-list"><li><strong>Source integrity.</strong> Hashes and versions show which original was used. They do not establish that its claims are true.</li><li><strong>Plan review.</strong> An organizer checks geometry, source boxes, quote totals and prerequisites before sharing an exact revision.</li><li><strong>Image association.</strong> Three anchors produce an illustrative overlay. A separate cropped-image review controls sharing.</li><li><strong>Physical acceptance.</strong> A verified, scoped reviewer records an inspection against current sources and plan versions. Funding and spending approval are checked separately.</li></ol><p className="pl-muted">Sample records remain explicitly labelled. A model can propose, but it cannot approve any of these reviews or move money.</p></Modal>}
  </div>;
}
