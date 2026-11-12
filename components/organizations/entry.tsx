"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { announceOrganizationChange } from "@/lib/organizations/client-boundary";
import { ORG_ENTRY_STORAGE, orgEntryForLocation, readOrgEntryDraft, type OrgEntryDraft } from "@/lib/organizations/entry-draft";
import * as C from "@/lib/organizations/contracts";
import { OrgAck, OrgField, OrgFormError, OrgNotice, OrgPrivateLink, OrgRequestStatus, OrganizationShell, orgDate, orgErrorText, submitOrgForm, useOrganizationApi, useOrgDeadline } from "./shared";

const entryResponse = z.object({ entry: C.orgEntryViewSchema }).strict();
export function OrganizationRecipient() {
  const [draft, setDraft] = useState<OrgEntryDraft | null>(null), draftRef = useRef<OrgEntryDraft | null>(null), operation = useRef(0), [loaded, setLoaded] = useState(false), [generation, setGeneration] = useState(0);
  const [view, setView] = useState<C.OrgEntryView | null>(null), [welcome, setWelcome] = useState<z.infer<typeof C.orgWelcomeResponseSchema> | null>(null);
  const [name, setName] = useState(""), [ack, setAck] = useState(false), [leaveAck, setLeaveAck] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [storageWarning, setStorageWarning] = useState("");
  const api = useOrganizationApi({
    organizationChanged() { operation.current++; setBusy(false); setView(null); setWelcome(null); setName(""); setAck(false); setLeaveAck(false); setGeneration(value => value + 1); },
    projectChanged() { /* Organization entry has no project authority dependency. */ },
    committed() { setView(null); setLeaveAck(false); setGeneration(value => value + 1); },
  });
  function store(next: OrgEntryDraft | null) {
    draftRef.current = next; setDraft(next);
    try { if (next) sessionStorage.setItem(ORG_ENTRY_STORAGE, JSON.stringify(next)); else sessionStorage.removeItem(ORG_ENTRY_STORAGE); }
    catch { setStorageWarning("Per-tab recovery storage is unavailable. Keep this tab open until the original request is confirmed."); }
  }
  useEffect(() => {
    function locate() {
      operation.current++; api.boundary.invalidate("entry"); setView(null); setWelcome(null); setError(null); setName(""); setAck(false); setLeaveAck(false); setBusy(false);
      let saved: OrgEntryDraft | null = null;
      try { saved = readOrgEntryDraft(sessionStorage.getItem(ORG_ENTRY_STORAGE)); } catch { setStorageWarning("Per-tab recovery storage is unavailable. Keep this tab open until the original request is confirmed."); }
      const next = orgEntryForLocation(window.location.hash, saved, () => crypto.randomUUID());
      store(next); setLoaded(true); setGeneration(value => value + 1);
      if (window.location.hash) history.replaceState(history.state, "", window.location.pathname + window.location.search);
      if (next?.acceptance) setName(next.acceptance.displayName);
    }
    locate(); window.addEventListener("hashchange", locate);
    return () => { window.removeEventListener("hashchange", locate); api.boundary.invalidate("entry"); };
  }, []);
  useEffect(() => {
    if (!loaded || !draft) return;
    let active = true; setError(null); setBusy(true);
    void api.read("entry/review", entryResponse, { domain: "entry", body: { kind: draft.kind, token: draft.token, intentId: draft.intentId } }).then(result => { if (active && result) setView(result.entry); }, caught => { if (active) setError(caught); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [loaded, draft?.kind, draft?.token, draft?.intentId, generation]);
  useOrgDeadline(view?.expiresAt, () => { api.boundary.invalidate("entry"); setView(null); setWelcome(null); setGeneration(value => value + 1); });
  async function enter() {
    const original = draftRef.current; if (!original || !view || busy) return;
    const activeOperation = ++operation.current; setError(null);
    try {
      const body = original.kind === "invite" ? original.acceptance ?? C.orgEntryAcceptSchema.parse({ token: original.token, intentId: original.intentId, expectedScope: view.scope, displayName: name, contractVersion: C.ORG_GOVERNANCE_VERSION, acknowledged: ack }) : original.restoration ?? C.orgEntryRestoreSchema.parse({ token: original.token, intentId: original.intentId, expectedScope: view.scope, acknowledged: ack });
      const next = original.kind === "invite" ? { ...original, acceptance: body as C.OrgEntryAcceptInput } : { ...original, restoration: body as C.OrgEntryRestoreInput };
      store(next); api.boundary.invalidate("entry"); setBusy(true);
      const result = await api.read(original.kind === "invite" ? "entry/accept" : "entry/restore", C.orgWelcomeResponseSchema, { scope: body.expectedScope, domain: "entry", body });
      if (result && draftRef.current?.token === original.token && draftRef.current.kind === original.kind) { setWelcome(result); try { sessionStorage.removeItem(ORG_ENTRY_STORAGE); } catch { /* The confirmed capability remains only in this mounted view. */ } announceOrganizationChange(); }
    } catch (caught) { if (operation.current === activeOperation) setError(caught); }
    finally { if (operation.current === activeOperation) setBusy(false); }
  }
  async function leave() {
    if (!view || !leaveAck) return;
    await api.command("entry/leave", { intentId: crypto.randomUUID(), expectedScope: view.scope, expectedLibraryScope: view.libraryScope, acknowledged: true }, C.orgReceiptResponseSchema, { scope: view.scope, domain: "entry" });
  }
  const savedRequest = draft?.acceptance || draft?.restoration;
  return <OrganizationShell><section className="og-entry"><p className="og-kicker">A PRIVATE ORGANIZATION INVITATION</p><h1>A shared picture.<br/><em>Your own place in it.</em></h1><p className="og-lead">Organization access is separate from every project workspace. A link proves possession of a capability; names and affiliations remain self-declared.</p>
    {storageWarning && <OrgNotice title="Keep this tab open">{storageWarning}</OrgNotice>}
    <OrgRequestStatus api={api}/>
    {!loaded && <OrgNotice title="Opening the private link…">Its fragment stays out of request URLs and referrers.</OrgNotice>}
    {loaded && !draft && <OrgNotice title="Open the complete private link">Ask the person inviting you for the complete link, including its invitation or return fragment. A malformed or mixed link cannot reuse an earlier identity.</OrgNotice>}
    {draft && !welcome && <section className="og-card" aria-busy={busy}>
      {busy && <p role="status">Checking this exact link and the current organization profile…</p>}
      <OrgFormError error={error}/>
      {!busy && !view && <button type="button" className="og-button secondary" onClick={() => setGeneration(value => value + 1)}>Check link again</button>}
      {view?.state === "ready" && <form onSubmit={event => submitOrgForm(event, () => void enter())}><p className="og-kicker">{draft.kind === "invite" ? "JOIN THIS ORGANIZATION" : "RESTORE YOUR ORIGINAL PROFILE"}</p><h2>{view.organization?.name}</h2><p><strong>{view.role ? C.orgRoleLabels[view.role] : "Organization profile"}</strong> · Fixed deadline {orgDate(view.expiresAt)}</p>{draft.kind === "invite" ? <><p>Use the name you want the owner to see. This does not verify your identity or create project membership.</p><OrgField label="Your display name"><input value={name} onChange={event => setName(event.target.value)} required minLength={2} maxLength={80} autoComplete="off" disabled={!!savedRequest || busy}/></OrgField></> : <p>This restores the exact original profile and session. It cannot extend its deadline or add project access.</p>}<OrgAck checked={ack} change={setAck} disabled={!!savedRequest || busy}>I understand this is self-declared, possession-based organization access with a fixed original deadline. Existing project workspaces stay separate.</OrgAck><button type="submit" className="og-button" disabled={busy || api.blocked || (!savedRequest && !ack)}>{savedRequest ? "Check the original request" : draft.kind === "invite" ? "Join organization" : "Restore original profile"}</button></form>}
      {view?.state === "switch_required" && <><h2>Choose the organization profile deliberately.</h2><p>{view.current ? <>This browser currently has <strong>{view.current.organizationName}</strong> open as {C.orgRoleLabels[view.current.role]}. Its deadline is {orgDate(view.current.expiresAt)}.</> : "An ended organization credential must be explicitly cleared before this link can be reviewed."}</p><p>Leaving clears only this browser’s current organization session. Independently issued project profiles remain separate.</p><OrgAck checked={leaveAck} change={setLeaveAck}>Leave or clear the current organization credential before reviewing this link.</OrgAck>{view.canLeave && <button type="button" className="og-button" disabled={!leaveAck || api.blocked || busy} onClick={() => void leave()}>Leave current organization profile</button>}</>}
      {view && !["ready", "switch_required"].includes(view.state) && <><h2>{view.state === "joined_here" ? "This original profile is already open." : view.state === "issuer" ? "The issuing profile cannot accept its own invitation." : view.state === "used" ? "This one-use invitation has been used." : view.state === "expired" ? "The original deadline has ended." : view.state === "revoked" ? "This invitation has been withdrawn." : view.state === "authority_changed" ? "The issuing authority changed." : "This private link is unavailable."}</h2><p>{view.state === "joined_here" ? "Continue into the organization, or recover the original response if it was interrupted." : "No recipient details are disclosed here. A different or ended profile cannot recover another recipient’s access."}</p></>}
      {savedRequest && view && view.state !== "ready" && <button type="button" className="og-button secondary" disabled={busy || api.blocked} onClick={() => void enter()}>Check the original saved request</button>}
      {view?.state === "joined_here" && <a className="og-button" href="/organizations">Open organization<ArrowUpRightIcon/></a>}
    </section>}
    {welcome && <section className="og-card"><p className="og-kicker">ORIGINAL PROFILE CONFIRMED</p><h2>Welcome, {welcome.welcome.profile.displayName}.</h2><p>{welcome.welcome.profile.organizationName} · {C.orgRoleLabels[welcome.welcome.profile.role]}</p><p>Fixed session deadline: {orgDate(welcome.welcome.profile.sessionExpiresAt)}. Your name remains self-declared; project membership was not granted.</p><OrgPrivateLink path={welcome.returnPath} title="Your private return key" expiresAt={welcome.welcome.profile.sessionExpiresAt}/><a className="og-button" href="/organizations">Open organization<ArrowUpRightIcon/></a></section>}
    <p className="og-fineprint">Pending self-declaration and the exact private link may be kept in this tab’s session storage for interrupted-response recovery. Authentication sessions are HttpOnly. No verified-person, legal-organization, email or PayPal ownership claim is made.</p><div className="og-actions"><a href="/organizations">Organizations</a><a href="/community?return=/organizations">Project workspaces</a></div>
  </section></OrganizationShell>;
}
function ArrowUpRightIcon() { return <span aria-hidden="true">↗</span>; }
