"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, CircleUserRound, Clock3, HeartHandshake, KeyRound, Leaf, LockKeyhole, ShieldCheck, Users } from "lucide-react";
import { adoptWorkspaceContext } from "@/lib/community/workspace-fetch";
import { SUPPORTER_ACCESS_VERSION, supporterAcceptSchema, type SupporterEntryView, type SupporterWelcome } from "@/lib/supporters/contracts";
import { SUPPORTER_ENTRY_STORAGE, entryDraftForLocation, readEntryDraft, type SupporterEntryDraft } from "@/lib/supporters/entry-draft";
import { PrivateLink, SupporterNotice, SupporterRequestError, SupporterShell, accessDate, supporterRequest, useEntryBoundary } from "./shared";

type EntryReply = { entry: SupporterEntryView };
type WelcomeReply = { welcome: SupporterWelcome; returnPath: string };
const endedStates = new Set(["used", "expired", "revoked", "authority_changed", "unavailable"]);
const unavailableCopy = {
  used: ["This invitation has been used.", "A private invitation welcomes one supporter. If you already joined, use the private return link you saved when you accepted."],
  expired: ["This invitation’s time has ended.", "Its original deadline has passed. Ask the project’s organizer for a new invitation if you would like to join again."],
  revoked: ["This access was withdrawn.", "The organizer withdrew this invitation and any access it opened. Contributions and decisions already recorded stay in the project history."],
  authority_changed: ["A fresh welcome is needed.", "The inviting organizer’s authority has changed. Ask a current organizer to share a new invitation."],
  unavailable: ["This link cannot open access.", "Check that you have the complete private link. If access has ended or changed, ask a current project organizer for a new invitation."],
} as const;

export function SupporterRecipient() {
  const [draft, setDraft] = useState<SupporterEntryDraft | null>(null), [entry, setEntry] = useState<SupporterEntryView | null>(null), [welcome, setWelcome] = useState<WelcomeReply | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [name, setName] = useState(""), [acknowledged, setAcknowledged] = useState(false), [error, setError] = useState(""), [changed, setChanged] = useState(false), [durable, setDurable] = useState(true);
  const saved = useRef<SupporterEntryDraft | null>(null), busyRef = useRef(false), heading = useRef<HTMLHeadingElement>(null), trigger = useRef<HTMLElement | null>(null), sequence = useRef(0);
  const boundary = useEntryBoundary(() => { sequence.current++; setEntry(null); setWelcome(null); setName(""); setAcknowledged(false); setError(""); setChanged(true); setLoading(false); setBusy(false); busyRef.current = false; });

  function remember(next: SupporterEntryDraft) {
    saved.current = next; setDraft(next);
    try { sessionStorage.setItem(SUPPORTER_ENTRY_STORAGE, JSON.stringify(next)); setDurable(true); window.history.replaceState(null, "", "/join"); }
    catch { setDurable(false); try { window.history.replaceState(null, "", `/join#${next.kind}=${next.token}`); } catch { /* The in-memory request still permits an exact retry. */ } }
  }
  function startAction() { trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; busyRef.current = true; setBusy(true); setError(""); }
  function finishAction() { busyRef.current = false; setBusy(false); }
  function fail(failure: unknown) {
    if (failure instanceof DOMException && failure.name === "AbortError") return;
    setError(failure instanceof Error ? failure.message : "This step could not finish. Retry the saved request to check its original result.");
    if (failure instanceof SupporterRequestError && ([401, 403].includes(failure.status) || ["SUPPORTER_CONTEXT_CHANGED", "WORKSPACE_CONTEXT_CHANGED", "SESSION_EXPIRED", "UNAUTHORIZED", "SESSION_REQUIRED"].includes(failure.code))) { setEntry(null); setWelcome(null); setChanged(true); setName(""); setAcknowledged(false); }
  }
  async function review(next = saved.current, quiet = false) {
    if (!next || busyRef.current) return;
    const request = boundary.start(), order = ++sequence.current;
    if (!quiet) { setLoading(true); setError(""); }
    try {
      const result = await supporterRequest<EntryReply>("entry/review", { kind: next.kind, token: next.token, intentId: next.intentId }, { signal: request.signal });
      if (!request.current() || sequence.current !== order || saved.current?.token !== next.token) return;
      setEntry(result.entry); setChanged(false);
      if (result.entry.state !== "joined_here") setWelcome(null);
      if (endedStates.has(result.entry.state) || result.entry.state === "switch_required" || result.entry.state === "issuer") { setName(""); setAcknowledged(false); }
    } catch (error) { if (request.current() && sequence.current === order) fail(error); }
    finally { request.finish(); if (request.current() && sequence.current === order) setLoading(false); }
  }
  useEffect(() => {
    function openLink() {
      let previous = saved.current;
      try { previous ??= readEntryDraft(sessionStorage.getItem(SUPPORTER_ENTRY_STORAGE)); } catch { setDurable(false); }
      const next = entryDraftForLocation(window.location.hash, previous, () => crypto.randomUUID());
      boundary.invalidate(); sequence.current++; busyRef.current = false; setBusy(false); setEntry(null); setWelcome(null); setName(""); setAcknowledged(false); setChanged(false); setError("");
      if (next) { remember(next); if (next.acceptance) { setName(next.acceptance.displayName); setAcknowledged(true); } void review(next); }
      else { saved.current = null; setDraft(null); try { sessionStorage.removeItem(SUPPORTER_ENTRY_STORAGE); window.history.replaceState(null, "", "/join"); } catch { /* An invalid link never falls back to saved access. */ } setLoading(false); }
    }
    openLink(); window.addEventListener("hashchange", openLink);
    return () => window.removeEventListener("hashchange", openLink);
    // Same-document links receive the same identity boundary as a new page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { const interval = setInterval(() => { if (document.visibilityState === "visible" && !changed && !busyRef.current) void review(undefined, true); }, 20_000); return () => clearInterval(interval); });
  useEffect(() => { if (!trigger.current || busy || loading) return; const origin = trigger.current; trigger.current = null; if (document.activeElement === origin || document.activeElement === document.body) heading.current?.focus(); }, [busy, loading, error, welcome, entry]);

  function received(reply: WelcomeReply) {
    const next = entryDraftForLocation(reply.returnPath.slice(reply.returnPath.indexOf("#")), null, () => crypto.randomUUID());
    if (!next || next.kind !== "access") throw new Error("Access was saved, but its private return link could not be read. Retry the original request.");
    remember(next); setWelcome(reply); setEntry(null); setName(""); setAcknowledged(false); setChanged(false); adoptWorkspaceContext(reply.welcome.projectId);
  }
  async function accept(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault(); const current = saved.current;
    if (!current || current.kind !== "invite" || !entry || busyRef.current) return;
    const input = current.acceptance ?? { token: current.token, intentId: current.intentId, expectedScope: entry.scope, displayName: name.trim(), contractVersion: SUPPORTER_ACCESS_VERSION, acknowledged: true as const };
    if (!current.acceptance && (!acknowledged || !supporterAcceptSchema.safeParse(input).success)) { setError("Enter your name and confirm the invitation’s access terms."); return; }
    remember({ ...current, acceptance: input }); sequence.current++; const request = boundary.start(); startAction();
    try { const reply = await supporterRequest<WelcomeReply>("entry/accept", input, { signal: request.signal }); if (request.current()) received(reply); }
    catch (error) { if (request.current()) fail(error); }
    finally { request.finish(); if (request.current()) finishAction(); }
  }
  async function restore() {
    const current = saved.current; if (!current || current.kind !== "access" || !entry || !acknowledged || busyRef.current) return;
    const input = current.restoration ?? { token: current.token, intentId: current.intentId, expectedScope: entry.scope, acknowledged: true as const };
    remember({ ...current, restoration: input }); sequence.current++; const request = boundary.start(); startAction();
    try { const reply = await supporterRequest<WelcomeReply>("entry/restore", input, { signal: request.signal }); if (request.current()) received(reply); }
    catch (error) { if (request.current()) fail(error); }
    finally { request.finish(); if (request.current()) finishAction(); }
  }
  async function leave() {
    if (!entry?.canLeave || !acknowledged || busyRef.current) return;
    sequence.current++; const request = boundary.start(), scope = entry.scope; startAction();
    try {
      await supporterRequest("entry/leave", { expectedScope: scope, acknowledged: true }, { signal: request.signal });
      if (!request.current()) return;
      adoptWorkspaceContext(null); setEntry(null); setWelcome(null); setAcknowledged(false);
      if (saved.current?.kind === "access" && saved.current.restoration) remember({ version: 1, kind: "access", token: saved.current.token, intentId: crypto.randomUUID() });
      finishAction(); await review();
    } catch (error) { if (request.current()) fail(error); }
    finally { request.finish(); if (request.current()) finishAction(); }
  }

  const problem = entry && endedStates.has(entry.state) ? unavailableCopy[entry.state as keyof typeof unavailableCopy] : null;
  return <SupporterShell><div className="sp-entry"><section className="sp-entry-intro"><div className="sp-entry-art"><HeartHandshake size={39}/></div><p className="sp-eyebrow">A PERSONAL INVITATION</p><h1 className="sp-entry-title">A little support.<br/>A shared purpose.</h1><p>A community project grows through people who choose to be part of it. This private link is your place to begin.</p><div className="sp-entry-note"><LockKeyhole size={18}/><span>Your invitation opens one supporter profile in one project. Choosing a contribution and approving any payment are separate steps.</span></div></section>
    <section className="sp-card sp-entry-card" aria-busy={busy || loading} aria-labelledby="supporter-entry-heading">
      {error && <SupporterNotice title="This step needs another look." error>{error}</SupporterNotice>}
      {loading ? <><p className="sp-eyebrow">CHECKING YOUR INVITATION</p><h2 id="supporter-entry-heading" ref={heading} tabIndex={-1}>A moment to get settled.</h2><p role="status">Checking the link, its deadline and this browser’s current access…</p></> : changed ? <><p className="sp-eyebrow">WORKSPACE CHANGED</p><h2 id="supporter-entry-heading" ref={heading} tabIndex={-1}>Review the current access.</h2><p>Another tab changed this browser’s workspace. Review the link again before joining or returning.</p><button className="button primary" disabled={busy} onClick={() => { trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; void review(); }}>Review current access <ArrowRight size={16}/></button></> : welcome ? <>
        <div className="sp-success-mark"><CheckCircle2 size={17}/> YOUR ACCESS IS READY</div><h2 id="supporter-entry-heading" ref={heading} tabIndex={-1}>Welcome, {welcome.welcome.displayName}.</h2><p>You have donor access to <strong>{welcome.welcome.projectTitle}</strong>{welcome.welcome.purpose === "sponsor" ? ", including your own sponsor choices" : ""}.</p><p className="sp-identity-note">Name supplied by you · identity not independently verified</p><div className="sp-deadline"><span>Your original access deadline</span><strong>{accessDate(welcome.welcome.expiresAt)}</strong></div>
        <PrivateLink path={welcome.returnPath} label="Your private return link" note="Save this for yourself. Anyone holding it can return as your supporter profile until access ends. The organizer’s invitation cannot welcome a second person."/>
        <Link className="button primary" href="/funding">Explore the project’s purposes <ArrowRight size={16}/></Link><p className="sp-entry-help"><Link href="/my-contribution">View my contributions</Link> · No pledge or payment was made by joining.</p>
      </> : !draft ? <><p className="sp-eyebrow">YOUR PRIVATE WAY IN</p><h2 id="supporter-entry-heading" ref={heading} tabIndex={-1}>Start with your invitation.</h2><p>Open the complete private link shared by the project’s organizer. If you have already joined, use the return link you saved for yourself.</p><p className="sp-entry-help">The link stays private to your browser; it is not an email address or a public project listing.</p><Link className="button secondary" href="/community">Open saved workspaces <ArrowRight size={16}/></Link></> : problem ? <><p className="sp-eyebrow">INVITATION STATUS</p><h2 id="supporter-entry-heading" ref={heading} tabIndex={-1}>{problem[0]}</h2><p>{problem[1]}</p>{entry?.expiresAt && <div className="sp-deadline"><span>Original deadline</span><strong>{accessDate(entry.expiresAt)}</strong></div>}<Link className="button secondary" href="/community">Open saved workspaces</Link></> : entry?.state === "issuer" ? <><p className="sp-eyebrow">FOR YOUR SUPPORTER</p><h2 id="supporter-entry-heading" ref={heading} tabIndex={-1}>This welcome is for someone else.</h2><p>The inviting organizer cannot accept their own invitation in this browser. Share it privately with the intended donor or sponsor so they can enter their own profile.</p><Link className="button primary" href="/supporters">Manage project invitations <ArrowRight size={16}/></Link></> : entry?.state === "switch_required" ? <><p className="sp-eyebrow">ONE PROFILE AT A TIME</p><h2 id="supporter-entry-heading" ref={heading} tabIndex={-1}>{entry.current ? "Set this workspace aside?" : "Clear the access that ended?"}</h2><p>{entry.current ? <>This browser is using <strong>{entry.current.title}</strong> as {entry.current.role}. Save it to your workspace library before reviewing a separate supporter profile.</> : "This browser still has an earlier access cookie. Clear it explicitly before reviewing this invitation."}</p><p>The invitation’s project and recipient stay private until this step is complete.</p><label className="sp-ack"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={busy}/>I want to {entry.current ? "set this workspace aside and review a separate profile" : "clear the ended access and review this link"}.</label><button className="button primary sp-reload-button" disabled={busy || !acknowledged} onClick={() => void leave()}>{busy ? "Updating this browser…" : entry.current ? "Save and set workspace aside" : "Clear ended access"}<ArrowRight size={16}/></button></> : entry && (entry.state === "ready" || entry.state === "joined_here") ? <>
        <p className="sp-eyebrow">{entry.purpose === "sponsor" ? <HeartHandshake size={14}/> : <Leaf size={14}/>} {entry.state === "ready" ? `${entry.purpose === "sponsor" ? "SPONSOR" : "DONOR"} INVITATION` : "YOUR SAVED SUPPORTER ACCESS"}</p><h2 id="supporter-entry-heading" ref={heading} tabIndex={-1}>{entry.project?.title}</h2><span className="sp-mode">{entry.project?.mode === "sample" ? "Sample project" : "Live sandbox project"}</span>
        <ul className="sp-entry-terms"><li><CircleUserRound size={17}/><span>Your own donor profile in this project{entry.purpose === "sponsor" ? ", with access to your sponsor choices" : ""}.</span></li><li><ShieldCheck size={17}/><span>You choose your support. Joining does not approve a pledge, agreement or payment.</span></li><li><Clock3 size={17}/><span>One fixed deadline. Returning or reloading never extends your access.</span></li></ul>{entry.expiresAt && <div className="sp-deadline"><span>Invitation and access end</span><strong>{accessDate(entry.expiresAt)}</strong></div>}
        {entry.state === "ready" ? <form className="sp-form" onSubmit={event => void accept(event)}><label className="sp-field">Your name<input name="supporter-name" value={draft.acceptance?.displayName ?? name} onChange={event => setName(event.target.value)} minLength={2} maxLength={80} required autoComplete="name" disabled={busy || !!draft.acceptance}/><span>This name is supplied by you. It does not verify your identity, email address or PayPal account.</span></label><label className="sp-ack"><input type="checkbox" checked={!!draft.acceptance || acknowledged} onChange={event => setAcknowledged(event.target.checked)} required disabled={busy || !!draft.acceptance}/>I am the intended supporter. I understand the project, donor access and original deadline shown above.</label>{draft.acceptance && <p className="sp-saved-name">Your original acceptance is saved. Retrying checks that same request and keeps the same profile.</p>}<button className="button primary" type="submit" disabled={busy || (!draft.acceptance && !acknowledged)}>{busy ? "Checking your access…" : draft.acceptance ? "Retry my saved acceptance" : "Accept my invitation"}<ArrowRight size={16}/></button></form> : draft.kind === "invite" && draft.acceptance ? <><p><strong>{entry.recipient?.displayName}</strong>, your original acceptance was saved. Recover its private return link and continue with the same profile.</p><button className="button primary" disabled={busy} onClick={() => void accept()}>{busy ? "Recovering saved access…" : "Recover my accepted invitation"}<KeyRound size={16}/></button></> : draft.kind === "access" ? <><p>Return as <strong>{entry.recipient?.displayName}</strong>. This opens the original profile and keeps its existing deadline.</p><p className="sp-identity-note">Name supplied by the recipient · identity not independently verified</p><label className="sp-ack"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={busy}/>This is my private return link. I want to open this supporter profile.</label><button className="button primary sp-reload-button" disabled={busy || !acknowledged} onClick={() => void restore()}>{busy ? "Opening saved access…" : "Return to my supporter profile"}<KeyRound size={16}/></button></> : <p>Use the private return link you saved when you accepted this invitation.</p>}
        <p className="sp-entry-help">Link access is based on possession. Keep the invitation and your private return link with the intended person.</p>
      </> : <><h2 id="supporter-entry-heading" ref={heading} tabIndex={-1}>Check this invitation again.</h2><p>A response has not arrived yet. Your original request is retained so you can safely check it.</p><button className="button primary" disabled={busy} onClick={() => void review()}>Check invitation</button></>}
      {!durable && draft && <p className="sp-entry-help" role="status"><KeyRound size={13}/> This browser cannot save a recovery request for reload. Keep this page open until the step finishes, then save your private return link.</p>}
      {!loading && entry && !changed && <p className="sp-entry-help">Status can change. <button disabled={busy} onClick={() => { trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; void review(); }}>Check again</button></p>}
    </section></div><p className="sp-smallprint"><Users size={14}/> The organizer and each supporter have separate project access. Fieldproof does not independently verify who holds a private link.</p></SupporterShell>;
}
