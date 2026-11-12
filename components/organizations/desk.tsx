"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, BookOpen, Building2, Clock3, FolderKanban, History, LockKeyhole, RefreshCw, Users } from "lucide-react";
import { z } from "zod";
import * as C from "@/lib/organizations/contracts";
import { OrgAck, OrgDialog, OrgEmpty, OrgField, OrgFormError, OrgList, OrgNotice, OrgPrivateLink, OrgRequestStatus, OrganizationShell, orgDate, orgLabel, submitOrgForm, useOrganizationApi, useOrgDeadline, type OrgApi } from "./shared";
import { OrganizationMembers } from "./members";
import { OrganizationProjects } from "./projects";
import { OrganizationPolicies } from "./policies";
import { OrganizationPortfolio } from "./portfolio";

const deskResponse = z.object({ desk: C.orgDeskSchema }).strict(), participationResponse = z.object({ participation: C.orgProjectParticipationSchema }).strict();
const tabs = [{ id: "portfolio", label: "Portfolio", icon: FolderKanban }, { id: "projects", label: "Projects & rules", icon: Building2 }, { id: "members", label: "Members", icon: Users }, { id: "policies", label: "Policy library", icon: BookOpen }, { id: "history", label: "History", icon: History }] as const;
type Tab = typeof tabs[number]["id"];
export function OrganizationWorkspace({ initial, initialDesk, initialParticipation }: { initial?: C.OrgBootstrap; initialDesk?: C.OrgDesk; initialParticipation?: C.OrgProjectParticipation }) {
  const [bootstrap, setBootstrap] = useState<C.OrgBootstrap | null>(initial ?? null), [desk, setDesk] = useState<C.OrgDesk | null>(initialDesk ?? null), [participation, setParticipation] = useState<C.OrgProjectParticipation | null>(initialParticipation ?? null);
  const [orgGeneration, setOrgGeneration] = useState(0), [projectGeneration, setProjectGeneration] = useState(0), [loading, setLoading] = useState(!initial), [loadError, setLoadError] = useState<unknown>(null), [projectError, setProjectError] = useState<unknown>(null), [tab, setTab] = useState<Tab>("portfolio"), [libraryOpen, setLibraryOpen] = useState(false), [detailsOpen, setDetailsOpen] = useState(false);
  const [privateResult, setPrivateResult] = useState<{ path: string; title: string; expiresAt: string } | null>(null), bootstrapRef = useRef(bootstrap), createdMembership = useRef<string | null>(null); bootstrapRef.current = bootstrap;
  const api = useOrganizationApi({
    organizationChanged() { setDesk(null); setBootstrap(null); setPrivateResult(null); setOrgGeneration(value => value + 1); },
    projectChanged() { setParticipation(null); setProjectError(null); setProjectGeneration(value => value + 1); },
    committed(value, path) {
      const welcome = C.orgWelcomeResponseSchema.safeParse(value), invite = C.orgInviteResponseSchema.safeParse(value);
      if (welcome.success) { createdMembership.current = welcome.data.welcome.profile.membershipId; setPrivateResult({ path: welcome.data.returnPath, title: "Your private organization return key", expiresAt: welcome.data.welcome.profile.sessionExpiresAt }); }
      if (invite.success) setPrivateResult({ path: invite.data.invitation.path, title: "Private member invitation", expiresAt: invite.data.invitation.expiresAt });
      if (["create", "library/open", "library/clear-ended", "session/leave", "entry/leave"].includes(path) || !!desk && path.startsWith(`members/${desk.profile.membershipId}/`)) { setDesk(null); setBootstrap(null); setDetailsOpen(false); setLibraryOpen(false); }
      setOrgGeneration(current => current + 1);
      if (path.startsWith("projects/" ) || path === "projects") setProjectGeneration(current => current + 1);
    },
  });
  useEffect(() => {
    let active = true; setLoading(true); setLoadError(null);
    void api.read("context", C.orgBootstrapSchema, { domain: "organization" }).then(async value => {
      if (!active || !value) return;
      if (bootstrapRef.current?.context.scope !== value.context.scope) { setDesk(null); if (!createdMembership.current || createdMembership.current !== value.context.profile?.membershipId) setPrivateResult(null); }
      createdMembership.current = null;
      bootstrapRef.current = value; setBootstrap(value);
      if (value.context.state !== "active") { setDesk(null); return; }
      const result = await api.read("", deskResponse, { scope: value.context.scope });
      if (active && result) setDesk(result.desk);
    }).catch(error => { if (active) { setDesk(null); setLoadError(error); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [orgGeneration]);
  useEffect(() => {
    let active = true; setProjectError(null);
    void api.read("project-context", participationResponse, { domain: "project" }).then(value => { if (active && value) setParticipation(value.participation); }, error => { if (active) { setParticipation(null); setProjectError(error); } });
    return () => { active = false; };
  }, [projectGeneration]);
  useEffect(() => {
    const proposed = new URLSearchParams(window.location.search).get("tab"); if (tabs.some(item => item.id === proposed)) setTab(proposed as Tab);
    const timer = setInterval(() => setOrgGeneration(value => value + 1), 30_000);
    const check = () => { if (document.visibilityState !== "hidden") { setOrgGeneration(value => value + 1); setProjectGeneration(value => value + 1); } };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { clearInterval(timer); window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, []);
  const orgDeadline = desk ? new Date(Math.min(Date.parse(desk.profile.sessionExpiresAt), Date.parse(desk.profile.membershipExpiresAt))).toISOString() : null;
  useOrgDeadline(orgDeadline, () => { api.boundary.invalidate("organization"); setDesk(null); setPrivateResult(null); setBootstrap(null); setOrgGeneration(value => value + 1); });
  useOrgDeadline(participation?.projectContext.expiresAt, () => { api.boundary.invalidate("project"); setParticipation(null); setProjectGeneration(value => value + 1); });
  function selectTab(next: Tab) { setTab(next); const url = new URL(window.location.href); url.searchParams.set("tab", next); history.replaceState(history.state, "", url.pathname + url.search); }
  return <OrganizationShell name={desk?.organization.name}><div className="og-workspace" data-template={participation?.projectContext.project?.templateId ?? "makerspace"}>
    <OrgRequestStatus api={api}/>
    {!!loadError && <OrgNotice title="Organization access could not be checked" error><OrgFormError error={loadError}/><button type="button" className="og-button secondary" onClick={() => setOrgGeneration(value => value + 1)}>Check current organization</button></OrgNotice>}
    {!bootstrap && loading && <OrgNotice title="Checking your organization profile…">Project workspaces and organization profiles have separate access.</OrgNotice>}
    {bootstrap && !desk && !loading && <OrganizationStart bootstrap={bootstrap} api={api} openLibrary={() => setLibraryOpen(true)}/>}
    {privateResult && <section className="og-card"><OrgPrivateLink {...privateResult}/><button type="button" className="og-button secondary" onClick={() => setPrivateResult(null)}>Close private link</button></section>}
    {desk && <>
      <section className="og-desk-heading"><div><p className="og-kicker">THE ORGANIZATION REGISTER</p><h1>{desk.organization.name}</h1><p className="og-lead">{desk.organization.description || "A shared view of independently governed projects."}</p><p className="og-fineprint">Self-declared organization · Membership never grants project access or moves money between projects.</p></div><div className="og-heading-actions"><button type="button" className="og-button secondary" onClick={() => setLibraryOpen(true)}><Building2 size={16}/>Organization profiles</button>{desk.profile.role === "owner" && desk.capabilities.canEditOrganization && <button type="button" className="og-text-button" disabled={api.blocked} onClick={() => setDetailsOpen(true)}>Edit organization details</button>}</div></section>
      <section className="og-identity" aria-label="Current organization profile"><span className="og-avatar" aria-hidden="true">{desk.profile.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{desk.profile.displayName}</strong><span>{C.orgRoleLabels[desk.profile.role]} · Self-declared</span></div><span className="og-badge">{desk.profile.authenticationOrigin === "creation_capability" ? "Creation capability" : "Invitation possession"}</span><span className="og-deadline"><Clock3 size={15}/>Fixed deadline {orgDate(orgDeadline)}</span><button type="button" className="og-icon-button" aria-label="Refresh current organization" disabled={loading || api.busy} onClick={() => { setOrgGeneration(value => value + 1); setProjectGeneration(value => value + 1); }}><RefreshCw size={18}/></button></section>
      <div className="og-tablist" role="tablist" aria-label="Organization sections">{tabs.map((item, index) => <button key={item.id} id={`og-tab-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} aria-controls={`og-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => selectTab(item.id)} onKeyDown={event => { const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : null; const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : offset === null ? null : (index + offset + tabs.length) % tabs.length; if (next !== null) { event.preventDefault(); selectTab(tabs[next].id); document.getElementById(`og-tab-${tabs[next].id}`)?.focus(); } }}><item.icon size={17}/>{item.id === "members" && !desk.capabilities.canReadRoster ? "My membership" : item.label}</button>)}</div>
      <section className="og-tabpanel" id={`og-panel-${tab}`} role="tabpanel" aria-labelledby={`og-tab-${tab}`} tabIndex={-1}>
        {tab === "portfolio" && <OrganizationPortfolio desk={desk} api={api}/>}
        {tab === "projects" && <OrganizationProjects desk={desk} participation={participation} api={api} projectError={projectError}/>}
        {tab === "members" && <OrganizationMembers desk={desk} api={api}/>}
        {tab === "policies" && <OrganizationPolicies desk={desk} participation={participation} api={api}/>}
        {tab === "history" && <OrganizationHistory desk={desk} api={api}/>}
      </section>
    </>}
    {!desk && participation && <section className="og-project-independent"><OrganizationProjects desk={null} participation={participation} api={api} projectError={projectError}/></section>}
    {libraryOpen && bootstrap && <OrganizationLibrary bootstrap={bootstrap} api={api} close={() => setLibraryOpen(false)}/>}
    {detailsOpen && desk && <OrganizationDetails desk={desk} api={api} close={() => setDetailsOpen(false)}/>}
  </div></OrganizationShell>;
}

function OrganizationStart({ bootstrap, api, openLibrary }: { bootstrap: C.OrgBootstrap; api: OrgApi; openLibrary: () => void }) {
  const [name, setName] = useState(""), [description, setDescription] = useState(""), [displayName, setDisplayName] = useState(""), [hours, setHours] = useState(168), [ack, setAck] = useState(false), [clearAck, setClearAck] = useState(false), [error, setError] = useState<unknown>(null);
  async function create() { try { const body = C.orgCreateSchema.parse({ intentId: crypto.randomUUID(), expectedScope: bootstrap.context.scope, expectedLibraryScope: bootstrap.library.scope, organizationName: name, description, displayName, expiresHours: hours, contractVersion: C.ORG_GOVERNANCE_VERSION, acknowledged: ack }); await api.command("create", body, C.orgWelcomeResponseSchema, { scope: bootstrap.context.scope }); } catch (caught) { setError(caught); } }
  return <section className="og-entry"><p className="og-kicker">MANY PROJECTS. SHARED CARE.</p><h1>Keep the whole<br/><em>picture in view.</em></h1><p className="og-lead">Bring explicitly shared project aggregates into a portfolio. Invite organization members and reuse reviewed policies without merging project identities.</p><div className="og-actions"><button type="button" className="og-button secondary" onClick={openLibrary}>Open saved organization profiles<ArrowUpRight size={16}/></button><a href="/organizations/join">Have a private invitation?</a></div>
    {bootstrap.context.state === "ended" && <section className="og-card"><h2>The original organization deadline or authority has ended.</h2><p>Clear this ended credential deliberately before creating or restoring another organization profile. This does not revoke independently issued project access.</p><OrgAck checked={clearAck} change={setClearAck}>Clear only the ended organization credential in this browser.</OrgAck><button type="button" className="og-button" disabled={!clearAck || !bootstrap.context.canClearEnded || api.blocked} onClick={() => void api.command("library/clear-ended", { intentId: crypto.randomUUID(), expectedScope: bootstrap.context.scope, expectedLibraryScope: bootstrap.library.scope, acknowledged: true }, C.orgReceiptResponseSchema, { scope: bootstrap.context.scope })}>Clear ended organization profile</button></section>}
    {bootstrap.context.canCreate && <form className="og-card" onSubmit={event => submitOrgForm(event, () => void create())}><div className="og-section-heading"><div><p className="og-kicker">START AN ORGANIZATION SPACE</p><h2>A place for shared oversight.</h2></div><Building2 size={28} strokeWidth={1.2}/></div><div className="og-form-grid"><OrgField label="Organization name"><input value={name} onChange={event => setName(event.target.value)} minLength={3} maxLength={100} required autoComplete="off"/></OrgField><OrgField label="Your display name"><input value={displayName} onChange={event => setDisplayName(event.target.value)} minLength={2} maxLength={80} required autoComplete="off"/></OrgField><OrgField label="What this space is for"><textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={600} rows={3}/></OrgField><OrgField label="Original access duration (hours)" hint="Maximum 168 hours (7 days). Creation starts a fixed deadline; restoration cannot extend it."><input type="number" min={1} max={168} value={hours} onChange={event => setHours(Number(event.target.value))} required/></OrgField></div><OrgAck checked={ack} change={setAck}>I understand this self-declared owner profile authenticates by creation capability. It does not verify a legal organization, person, email address or PayPal account, or grant any project access.</OrgAck><OrgFormError error={error}/><button type="submit" className="og-button" disabled={!ack || api.blocked}>Create organization space<ArrowUpRight size={16}/></button></form>}
  </section>;
}
function OrganizationLibrary({ bootstrap, api, close }: { bootstrap: C.OrgBootstrap; api: OrgApi; close: () => void }) {
  const [choice, setChoice] = useState<string | null>(null), [openAck, setOpenAck] = useState(false), [profileAck, setProfileAck] = useState(false);
  async function act(path: string, entryId?: string) { const result = await api.command(path, { intentId: crypto.randomUUID(), expectedScope: bootstrap.context.scope, expectedLibraryScope: bootstrap.library.scope, ...(entryId ? { entryId } : {}), acknowledged: true }, C.orgReceiptResponseSchema, { scope: bootstrap.context.scope }); if (result) close(); }
  return <OrgDialog api={api} title="Saved organization profiles" close={close}><p>These browser capabilities restore separate original profiles with their original deadlines. Matching names never merge identities. Project workspaces stay separate.</p>{bootstrap.library.expiresAt && <p className="og-fineprint">Browser library deadline: {orgDate(bootstrap.library.expiresAt)}</p>}{bootstrap.library.entries.length ? <ul className="og-profile-list">{bootstrap.library.entries.map(entry => <li key={entry.id}><div><strong>{entry.organizationName}</strong><span>{entry.profileLabel} · {C.orgRoleLabels[entry.role]}</span><small>{orgDate(entry.expiresAt)} · {entry.authenticationOrigin === "creation_capability" ? "Creation capability" : "Invitation possession"}</small>{entry.unavailableReason && <small>{entry.unavailableReason}</small>}</div>{entry.current ? <span className="og-badge">Current</span> : <button type="button" className="og-button secondary" disabled={!entry.available || bootstrap.context.state === "ended" || api.blocked} onClick={() => { setChoice(entry.id); setOpenAck(false); }}>Review opening</button>}</li>)}</ul> : <OrgEmpty title="No saved organization profiles">Keep a private return key or remember the current profile in this browser.</OrgEmpty>}
    {choice && <section className="og-card"><h3>Open this original organization profile?</h3><p>The current organization cookie will change. Independent project cookies remain untouched; no original expiry will renew.</p><OrgAck checked={openAck} change={setOpenAck}>Deliberately open this saved organization profile.</OrgAck><button type="button" className="og-button" disabled={!openAck || api.blocked} onClick={() => void act("library/open", choice)}>Open original profile</button></section>}
    {bootstrap.context.state === "active" && <><OrgAck checked={profileAck} change={setProfileAck}>I understand this keeps or leaves only the current organization capability in this browser. Independently issued project access stays separate.</OrgAck><div className="og-actions"><button type="button" className="og-button" disabled={!profileAck || api.blocked} onClick={() => void act("library/remember")}>Remember current profile</button><button type="button" className="og-button secondary" disabled={!profileAck || api.blocked} onClick={() => void act("session/leave")}>Leave current organization</button></div></>}
    {bootstrap.context.state === "ended" && <OrgNotice title="Clear the ended organization credential first">Close this dialog and use the explicit clear action. Saved profiles cannot silently replace it.</OrgNotice>}<OrgFormError error={api.error}/></OrgDialog>;
}
function OrganizationDetails({ desk, api, close }: { desk: C.OrgDesk; api: OrgApi; close: () => void }) {
  const [name, setName] = useState(desk.organization.name), [description, setDescription] = useState(desk.organization.description), [ack, setAck] = useState(false), [error, setError] = useState<unknown>(null);
  async function save() { try { const body = C.orgUpdateSchema.parse({ intentId: crypto.randomUUID(), expectedScope: desk.scope, expectedVersion: desk.organization.version, organizationName: name, description, acknowledged: ack }); if (await api.command("update", body, C.orgReceiptResponseSchema, { scope: desk.scope })) close(); } catch (caught) { setError(caught); } }
  return <OrgDialog api={api} title="Organization details" close={close}><form onSubmit={event => submitOrgForm(event, () => void save())}><OrgField label="Organization name"><input value={name} onChange={event => setName(event.target.value)} minLength={3} maxLength={100} required/></OrgField><OrgField label="Description"><textarea rows={4} maxLength={600} value={description} onChange={event => setDescription(event.target.value)}/></OrgField><OrgAck checked={ack} change={setAck}>These remain self-declared details. This does not transfer legal or project ownership.</OrgAck><OrgFormError error={error || api.error}/><button type="submit" className="og-button" disabled={!ack || api.blocked}>Save reviewed details</button></form></OrgDialog>;
}
function OrganizationHistory({ desk, api }: { desk: C.OrgDesk; api: OrgApi }) {
  const [events, setEvents] = useState(desk.events), [cursor, setCursor] = useState(desk.nextEventCursor), [error, setError] = useState<unknown>(null), [busy, setBusy] = useState(false);
  useEffect(() => { setEvents(desk.events); setCursor(desk.nextEventCursor); }, [desk.events, desk.nextEventCursor]);
  async function more() { if (!cursor) return; setBusy(true); setError(null); try { const result = await api.read(`events?before=${encodeURIComponent(cursor)}`, z.object({ events: z.array(C.orgEventSchema), nextCursor: z.string().nullable() }).strict(), { scope: desk.scope }); if (result) { setEvents(previous => Array.from(new Map([...previous, ...result.events].map(value => [value.id, value])).values())); setCursor(result.nextCursor); } } catch (caught) { setError(caught); } finally { setBusy(false); } }
  return <><div className="og-section-heading"><div><p className="og-kicker">GOVERNANCE HISTORY</p><h2>Decisions with their own dates.</h2></div><LockKeyhole size={22}/></div><p>Organization events use the permitted authority labels. Historical definitions and project approvals remain bound to their original versions.</p>{events.length ? <ol className="og-timeline">{events.map(event => <li key={event.id}><time dateTime={event.occurredAt}>{orgDate(event.occurredAt)}</time><h3>{event.title}</h3><p>{event.detail}</p><small>{event.authorityLabel} · {orgLabel(event.kind)}</small></li>)}</ol> : <OrgEmpty title="The register is new">Governance decisions will appear here as they are made.</OrgEmpty>}<OrgFormError error={error}/>{cursor && <button type="button" className="og-button secondary" disabled={busy} onClick={() => void more()}>{busy ? "Loading earlier decisions…" : "Earlier decisions"}</button>}</>;
}
