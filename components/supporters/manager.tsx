"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, CircleUserRound, Clock3, HeartHandshake, Leaf, Link2, Plus, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { supporterInviteSchema, type SupporterDesk, type SupporterInviteView, type SupporterPurpose } from "@/lib/supporters/contracts";
import { AccessDialog, PrivateLink, SupporterNotice, SupporterRequestError, SupporterShell, accessDate, supporterRequest, useEntryBoundary } from "./shared";

type Creation = ReturnType<typeof supporterInviteSchema.parse>;
type LinkResult = { invitation: { id: string; path: string; expiresAt: string } };
const states: Record<SupporterInviteView["state"], string> = { invited: "Ready to share", joined: "Joined", expired: "Access ended", revoked: "Withdrawn", authority_changed: "Needs a new invitation" };

export function SupporterManager({ initial }: { initial: SupporterDesk }) {
  const [desk, setDesk] = useState<SupporterDesk | null>(initial), [label, setLabel] = useState(""), [purpose, setPurpose] = useState<SupporterPurpose>("donor"), [hours, setHours] = useState(72), [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState<Creation | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const [link, setLink] = useState<LinkResult["invitation"] | null>(null), [withdraw, setWithdraw] = useState<{ invitation: SupporterInviteView; intentId: string } | null>(null), [withdrawAcknowledged, setWithdrawAcknowledged] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), dialogNotice = useRef<HTMLHeadingElement>(null), trigger = useRef<HTMLElement | null>(null), busyRef = useRef(false), currentDesk = useRef(desk), sequence = useRef(0); currentDesk.current = desk;
  const draftKey = `fieldproof-supporter-invitation-v1:${initial.scope}`;
  const boundary = useEntryBoundary(() => { setDesk(null); setLink(null); setWithdraw(null); setPending(null); setLabel(""); setMessage(""); setBusy(false); busyRef.current = false; setError("This browser’s active workspace changed. Reload to manage invitations in your current organizer session."); });
  useEffect(() => {
    try { const saved = sessionStorage.getItem(draftKey); if (saved) { const parsed = supporterInviteSchema.safeParse(JSON.parse(saved)); if (parsed.success && parsed.data.expectedScope === initial.scope) { setPending(parsed.data); setLabel(parsed.data.label); setPurpose(parsed.data.purpose); setHours(parsed.data.expiresHours); setAcknowledged(true); } } } catch { /* The in-memory request still retains its original intent. */ }
  }, [draftKey, initial.scope]);
  useEffect(() => { if (!trigger.current || (!message && !error)) return; const origin = trigger.current; trigger.current = null; if (document.activeElement === origin || document.activeElement === document.body) (withdraw && error ? dialogNotice : heading).current?.focus(); }, [message, error, withdraw]);
  function begin() { sequence.current++; busyRef.current = true; setBusy(true); setMessage(""); setError(""); }
  function end() { busyRef.current = false; setBusy(false); }
  function failure(failure: unknown) {
    if (failure instanceof DOMException && failure.name === "AbortError") return;
    setError(failure instanceof Error ? failure.message : "This step could not finish. Retry the same request to check its saved result.");
    if (failure instanceof SupporterRequestError && ([401, 403].includes(failure.status) || ["SUPPORTER_CONTEXT_CHANGED", "WORKSPACE_CONTEXT_CHANGED"].includes(failure.code))) { setDesk(null); setLink(null); setWithdraw(null); setPending(null); setLabel(""); }
  }
  async function refresh(scope: string, signal?: AbortSignal) {
    const result = await supporterRequest<{ desk: SupporterDesk }>("", undefined, { scope, signal });
    if (result.desk.scope !== scope) throw new SupporterRequestError("Your organizer session changed. Reload before continuing.", "SUPPORTER_CONTEXT_CHANGED", 409);
    return result.desk;
  }
  async function checkNow(notify = true) {
    if (!currentDesk.current || busyRef.current) return;
    const request = boundary.start(), scope = currentDesk.current.scope;
    if (notify) begin();
    const order = ++sequence.current;
    try { const next = await refresh(scope, request.signal); if (request.current() && sequence.current === order) { setDesk(next); setLink(current => current && next.invitations.some(item => item.id === current.id && item.canShare) ? current : null); if (notify) setMessage("Invitation status is up to date."); } }
    catch (error) { if (request.current() && sequence.current === order) failure(error); }
    finally { request.finish(); if (request.current() && sequence.current === order && notify) end(); }
  }
  useEffect(() => { const timer = setInterval(() => { if (document.visibilityState === "visible") void checkNow(false); }, 20_000); return () => clearInterval(timer); });
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!desk || busyRef.current) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const input: Creation = pending ?? { intentId: crypto.randomUUID(), expectedScope: desk.scope, label: label.trim(), purpose, expiresHours: hours, acknowledged: true };
    if (!pending && (!acknowledged || !supporterInviteSchema.safeParse(input).success)) { setError("Give this invitation a name and confirm how you will share it."); return; }
    setPending(input); try { sessionStorage.setItem(draftKey, JSON.stringify(input)); } catch { /* Same-page retries retain the exact command. */ }
    const request = boundary.start(); begin();
    try {
      const result = await supporterRequest<LinkResult>("invitations", input, { signal: request.signal });
      if (!request.current()) return;
      setLink(result.invitation); setPending(null); setLabel(""); setAcknowledged(false); try { sessionStorage.removeItem(draftKey); } catch { /* No credential is persisted here. */ }
      setMessage("Your private invitation is ready to share.");
      const next = await refresh(desk.scope, request.signal); if (request.current()) setDesk(next);
    } catch (error) { if (request.current()) failure(error); }
    finally { request.finish(); if (request.current()) end(); }
  }
  async function showLink(invitation: SupporterInviteView, opener: HTMLElement) {
    if (!desk || busyRef.current) return; trigger.current = opener; const request = boundary.start(); begin();
    try { const result = await supporterRequest<LinkResult>(`invitations/${invitation.id}/link`, { expectedScope: desk.scope, expectedVersion: invitation.version }, { signal: request.signal }); if (request.current()) { setLink(result.invitation); setMessage("The original private link is ready. Its deadline is unchanged."); } }
    catch (error) { if (request.current()) failure(error); }
    finally { request.finish(); if (request.current()) end(); }
  }
  async function revoke() {
    if (!desk || !withdraw || !withdrawAcknowledged || busyRef.current) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const request = boundary.start(), chosen = withdraw; begin();
    try {
      await supporterRequest(`invitations/${chosen.invitation.id}/revoke`, { intentId: chosen.intentId, expectedScope: desk.scope, expectedVersion: chosen.invitation.version, acknowledged: true }, { signal: request.signal });
      if (!request.current()) return;
      setWithdraw(null); setLink(current => current?.id === chosen.invitation.id ? null : current); setMessage("Access was withdrawn. The person’s existing contribution history stays saved.");
      const next = await refresh(desk.scope, request.signal); if (request.current()) setDesk(next);
    } catch (error) { if (request.current()) { failure(error); if (error instanceof SupporterRequestError && error.code === "SUPPORTER_INVITE_CHANGED") { setWithdraw(null); const next = await refresh(desk.scope, request.signal).catch(() => null); if (next && request.current()) setDesk(next); } } }
    finally { request.finish(); if (request.current()) end(); }
  }
  return <SupporterShell organizer>{!desk ? <><p className="sp-eyebrow">YOUR CURRENT PROJECT</p><h1 className="sp-entry-title">One workspace at a time.</h1><SupporterNotice title={error || "Open your current organizer session."} error headingRef={heading}/><Link className="button primary" href="/supporters">Reload current access <ArrowRight size={16}/></Link></> : <>
    <section className="sp-hero"><div><p className="sp-eyebrow"><Users size={15}/> PEOPLE & PURPOSE</p><h1>Good projects<br/>start with people.</h1><p>Invite a donor or sponsor into <strong>{desk.projectTitle}</strong>. They choose their own support, follow their own contributions, and keep a private way back.</p></div><div className="sp-project-stamp"><HeartHandshake size={30}/><div><strong>{desk.projectTitle}</strong><span className="sp-mode">{desk.mode === "sample" ? "Sample project" : "Live sandbox project"}</span></div></div></section>
    {(message || error) && !withdraw && <SupporterNotice title={error || message} error={!!error} headingRef={heading}>{error && pending ? "The original invitation request is kept below. Retrying checks that same request." : undefined}</SupporterNotice>}
    {link && <PrivateLink path={link.path} note={`Share only with the intended supporter. The invitation and their access both end ${accessDate(link.expiresAt)}.`}/>}
    <div className="sp-columns"><section className="sp-card"><h2>A place in the project.</h2><p>One private invitation. One separate supporter profile.</p><form className="sp-form" onSubmit={event => void create(event)} aria-busy={busy}>
      <fieldset className="sp-role-choice" disabled={busy || !!pending}><legend>Who are you inviting?</legend><label><input type="radio" name="supporter-purpose" value="donor" checked={purpose === "donor"} onChange={() => setPurpose("donor")}/><Leaf size={24}/><strong>A donor</strong><small>Choose a purpose and follow their own support.</small></label><label><input type="radio" name="supporter-purpose" value="sponsor" checked={purpose === "sponsor"} onChange={() => setPurpose("sponsor")}/><HeartHandshake size={24}/><strong>A sponsor</strong><small>Review a match or grant and make their own choices.</small></label></fieldset>
      <label className="sp-field">A name for this invitation<input value={label} onChange={event => setLabel(event.target.value)} minLength={2} maxLength={80} required disabled={busy || !!pending} placeholder="For example, Alex · neighborhood group" autoComplete="off"/><span>Private to the organizers. The recipient enters their own name.</span></label>
      <label className="sp-field">Invitation and access last<select value={hours} onChange={event => setHours(Number(event.target.value))} disabled={busy || !!pending}><option value={24}>24 hours</option><option value={72}>3 days</option><option value={168}>7 days</option></select><span>The deadline starts when you create the link. Joining or returning does not move it.</span></label>
      <label className="sp-ack"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} required disabled={busy || !!pending}/>I will share this link with one intended supporter. Joining does not approve a pledge, sponsor agreement or payment.</label>
      {pending && <p className="sp-saved-name">This exact invitation request is saved for recovery. Retry it to learn whether it was created.</p>}
      <button className="button primary" type="submit" disabled={busy || !acknowledged}>{busy ? "Checking the saved invitation…" : pending ? "Retry the same invitation" : "Create private invitation"}{!busy && <Plus size={16}/>}</button>
    </form><p className="sp-smallprint"><ShieldCheck size={14}/> Both invitations grant only donor access. Recipients see their own contributions and cannot organize the project or approve someone else’s choices.</p></section>
    <section aria-labelledby="supporter-list-title"><div className="sp-count-heading"><div><h2 id="supporter-list-title">Your invitations <span aria-label={`${desk.invitations.length} shown`}>({desk.invitations.length})</span></h2><p>Current access and recent invitation history.</p></div><button className="sp-refresh" disabled={busy} onClick={event => { trigger.current = event.currentTarget; void checkNow(); }}><RefreshCw size={15}/>Refresh</button></div>
      {!desk.invitations.length ? <div className="sp-empty"><Users size={38}/><h3>There’s room at the table.</h3><p>Create the first invitation, then share it yourself with the person you’d like to welcome.</p></div> : <div className="sp-list">{desk.invitations.map(invitation => <article className="sp-invitation" key={invitation.id}><div className="sp-invitation-top"><div><p className="sp-eyebrow">{invitation.purpose === "sponsor" ? <HeartHandshake size={13}/> : <CircleUserRound size={13}/>} {invitation.purpose === "sponsor" ? "SPONSOR INVITATION" : "DONOR INVITATION"}</p><h3>{invitation.label}</h3></div><span className={`sp-status ${invitation.state}`}>{states[invitation.state]}</span></div>
        {invitation.recipient && <><p><strong>{invitation.recipient.displayName}</strong> joined {invitation.joinedAt ? accessDate(invitation.joinedAt) : "this project"}.</p><p className="sp-identity-note">Name supplied by the recipient · identity not independently verified</p></>}
        <p><Clock3 size={12}/> Access ends {accessDate(invitation.expiresAt)}</p>
        <div className="sp-invitation-actions">{invitation.canShare && <button className="text-button" disabled={busy} onClick={event => void showLink(invitation, event.currentTarget)}><Link2 size={15}/>Show private link</button>}{invitation.canRevoke && <button className="text-button sp-withdraw" disabled={busy} onClick={() => { setError(""); setWithdraw({ invitation, intentId: crypto.randomUUID() }); setWithdrawAcknowledged(false); }}>{invitation.joinedAt ? "Withdraw project access" : "Withdraw invitation"}</button>}</div>
        <details><summary>Access details</summary><p>Donor role in this project only. Access is authenticated by possession of the private link; names, email ownership and PayPal ownership are not independently verified. Payment approval is always separate.</p><p>Created {accessDate(invitation.createdAt)}.{invitation.revokedAt && ` Withdrawn ${accessDate(invitation.revokedAt)}.`} The original expiry is retained.</p></details>
      </article>)}</div>}
    </section></div>
    {withdraw && <AccessDialog title={withdraw.invitation.joinedAt ? "Withdraw this access?" : "Withdraw this invitation?"} close={() => { if (!busy) setWithdraw(null); }}>{error && <SupporterNotice title="Withdrawal needs another check." error headingRef={dialogNotice}>{error} Retrying keeps this same withdrawal request.</SupporterNotice>}<p><strong>{withdraw.invitation.label}</strong> will no longer open this project. Any private return link will stop working, too.</p><p>Existing contributions and decisions stay saved. Withdrawing access does not refund or move money.</p><label className="sp-ack"><input type="checkbox" checked={withdrawAcknowledged} onChange={event => setWithdrawAcknowledged(event.target.checked)} disabled={busy}/>I reviewed this specific invitation and want to withdraw its access.</label><div className="sp-dialog-actions"><button className="button secondary" disabled={busy} onClick={() => setWithdraw(null)}>Keep access</button><button className="button primary" disabled={busy || !withdrawAcknowledged} onClick={() => void revoke()}>{busy ? "Withdrawing…" : "Withdraw access"}</button></div></AccessDialog>}
  </>}</SupporterShell>;
}
