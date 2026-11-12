"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Bell, CalendarClock, History, LockKeyhole } from "lucide-react";
import { z } from "zod";
import * as C from "@/lib/lifecycle/contracts";
import { LifecycleInbox } from "./inbox";
import { LifecycleSchedules } from "./schedules";
import { LifecycleHistory } from "./history";
import { useLifecycleApi, useLifecycleDeadline } from "./use-api";
import { LifecycleRequestStatus, LifecycleShell, Notice, Reasons, ResourceState, lcDate, lcOrganizationDeadline } from "./shared";

const tabs = [{ id: "inbox", title: "My lifecycle inbox", icon: Bell }, { id: "schedules", title: "Scheduled drafts", icon: CalendarClock }, { id: "history", title: "Draft history", icon: History }] as const;
type Tab = typeof tabs[number]["id"];
/** An ordinary entry, never a fixture or actor chooser. No private facts are
 * embedded in anonymous HTML or persisted outside exact pending commands. */
export function LifecycleWorkspace({ initialContext = null }: { initialContext?: C.LifecycleContext | null }) {
  const [context, setContext] = useState(initialContext), [tab, setTab] = useState<Tab>("inbox"), [projectRevision, setProjectRevision] = useState(0), [organizationRevision, setOrganizationRevision] = useState(0), [checking, setChecking] = useState(!initialContext), [error, setError] = useState<unknown>(null), [changeMessage, setChangeMessage] = useState("");
  const sequence = useRef(0), bootstrapRef = useRef<() => void>(() => undefined);
  const changed = useCallback((domain: "project" | "organization" | "dual") => {
    setChangeMessage(domain === "project" ? "Project context changed. Its private inbox and treasurer content are withheld while the current profile is checked." : "Organization context changed. Its private schedules and drafts are withheld while the current profile is checked.");
    if (domain !== "organization") { setProjectRevision(value => value + 1); setContext(previous => previous ? { ...previous, project: { ...previous.project, state: "ended", profile: null, canReadInbox: false, canChangePreferences: false, canPrepareTreasurer: false, reasons: ["The project profile needs a current check."] } } : null); }
    if (domain !== "project") { setOrganizationRevision(value => value + 1); setContext(previous => previous ? { ...previous, organization: { ...previous.organization, state: "ended", profile: null, canCreate: false, canLeave: false }, canManageProgram: false, canPrepareAggregate: false } : null); }
    bootstrapRef.current();
  }, []);
  const api = useLifecycleApi(context, { changed, committed(domain) { if (domain !== "organization") setProjectRevision(value => value + 1); if (domain !== "project") setOrganizationRevision(value => value + 1); } });
  const bootstrap = useCallback(async (refreshViews = false) => {
    const epoch = ++sequence.current; setChecking(true); setError(null);
    if (refreshViews) { api.boundary.invalidate("all"); setProjectRevision(value => value + 1); setOrganizationRevision(value => value + 1); }
    try {
      const result = await api.read("context", z.object({ context: C.lifecycleContextSchema }).strict(), "context");
      if (epoch !== sequence.current || !result) return;
      setContext(result.context); setChangeMessage("");
    } catch (caught) { if (epoch === sequence.current) { setError(caught); setContext(null); } }
    finally { if (epoch === sequence.current) setChecking(false); }
  }, [api.boundary, api.read]);
  bootstrapRef.current = () => { void bootstrap(); };
  useEffect(() => {
    const requested = new URL(window.location.href).searchParams.get("tab"); if (tabs.some(value => value.id === requested)) setTab(requested as Tab);
    if (!initialContext) void bootstrap();
    const refresh = () => { if (document.visibilityState !== "hidden") void bootstrap(true); };
    const interval = setInterval(refresh, 30_000); window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { sequence.current++; clearInterval(interval); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [bootstrap, initialContext]);
  useLifecycleDeadline(context?.project.profile?.expiresAt, () => { api.boundary.invalidate("project"); changed("project"); });
  useLifecycleDeadline(context ? lcOrganizationDeadline(context) : null, () => { api.boundary.invalidate("organization"); changed("organization"); });
  function choose(value: Tab) { setTab(value); history.replaceState(null, "", `/lifecycle${value === "inbox" ? "" : `?tab=${value}`}`); }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : null;
    if (next === null) return; event.preventDefault(); choose(tabs[next].id); document.getElementById(`lifecycle-tab-${tabs[next].id}`)?.focus();
  }
  return <LifecycleShell><section className="lc-hero"><div><span className="lc-kicker"><LockKeyhole size={14}/>Your private continuity desk</span><h1>Good updates.<br/><em>Clear boundaries.</em></h1><p>Your project events and deliberately scheduled factual drafts, with the source and timing kept in view.</p></div><aside><span className="lc-hero-number">01 / 03</span><p>A saved record is useful.<br/>A clear record is trustworthy.</p><span>Private records · explicit opt-in · no external sending</span></aside></section>{changeMessage ? <Notice title="Checking a changed profile">{changeMessage}</Notice> : null}<ResourceState busy={checking && !context} error={error} retry={() => void bootstrap(true)}/>{context ? <><div className="lc-context-grid"><section><span className="lc-kicker">Independent project profile</span>{context.project.profile ? <><strong>{context.project.profile.project.title}</strong><p>{context.project.profile.label} · {context.project.profile.role}</p><small>Fixed deadline: {lcDate(context.project.profile.expiresAt)}</small></> : <><strong>No current project profile</strong><Reasons values={context.project.reasons}/><a href="/community?return=/lifecycle">Open Saved project workspaces ↗</a></>}</section><section><span className="lc-kicker">Separate organization profile</span>{context.organization.profile ? <><strong>{context.organization.profile.organizationName}</strong><p>{context.organization.profile.displayName} · {context.organization.profile.role}</p><small>Fixed deadline: {lcDate(lcOrganizationDeadline(context))}</small></> : <><strong>No current organization profile</strong><a href="/organizations">Open Organizations ↗</a></>}</section></div><p className="lc-fineprint lc-identity-note">Profile names are self-declared. Possession-based entry does not verify a person, organization, email or PayPal account. An organization profile never grants a project role.</p><LifecycleRequestStatus api={api}/><div className="lc-tabs" role="tablist" aria-label="Lifecycle views">{tabs.map(({ id, title, icon: Icon }, index) => <button type="button" key={id} role="tab" id={`lifecycle-tab-${id}`} aria-controls={`lifecycle-panel-${id}`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} onClick={() => choose(id)} onKeyDown={event => tabKey(event, index)}><Icon size={18}/>{title}</button>)}</div><section role="tabpanel" aria-labelledby={`lifecycle-tab-${tab}`} id={`lifecycle-panel-${tab}`} tabIndex={0} className="lc-tab-panel">{tab === "inbox" ? <LifecycleInbox key={`${context.project.state}:${context.project.scope}`} context={context} api={api} revision={projectRevision}/> : tab === "schedules" ? <LifecycleSchedules key={`${context.organization.state}:${context.organization.scope}`} context={context} api={api} revision={organizationRevision} projectRevision={projectRevision}/> : <LifecycleHistory key={`${context.organization.state}:${context.organization.scope}`} context={context} api={api} revision={organizationRevision} projectRevision={projectRevision}/>}</section><p className="lc-fineprint lc-cutoff">Current profiles checked {lcDate(context.checkedAt)}{checking ? " · Rechecking current authority…" : ""}. Every private detail still requires its own current source permission.</p></> : !checking ? <Notice title="Open the intended current profile"><p>Use <a href="/community?return=/lifecycle">Saved project workspaces</a> for your personal lifecycle inbox, or <a href="/organizations">Organizations</a> for private scheduled drafts. Each profile has an independent fixed deadline.</p></Notice> : null}</LifecycleShell>;
}
