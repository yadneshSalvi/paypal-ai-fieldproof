"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, BookOpenCheck, Check, CircleHelp, Eye, FileSearch, HandCoins, Heart, Layers3, LockKeyhole, Play, ReceiptText, RotateCcw, ShieldCheck, Sparkles, Users, X } from "lucide-react";
import type { PackageView, ProjectSnapshot } from "@/lib/contracts";
import { adoptWorkspaceContext } from "@/lib/community/workspace-fetch";
import { declineWording, type HeroReplay } from "@/lib/judge/hero-replay";
import { dollars, HERO_CAPTURED_MINOR, HERO_TARGET_MINOR, ROLE_LINKS, TOUR_SCRIPTED_MS, type JudgeRole } from "@/lib/judge/tour-script";
import { Blueprint } from "../blueprint";
import { JudgeTour, ProvenanceChip, type TourResult } from "./tour";

export interface JudgeScenarioSummary { version: number; mintedAt: string; deadline: string; sessionExpiresAt: string; collectionStartedAt: string; recoveryEndsAt: string; tourStep: number; pristine: boolean; cancellation: { title: string; deadline: string; shares: number } | null }
interface Started { scenario: JudgeScenarioSummary; created: boolean; snapshot: ProjectSnapshot }
class ApiFailure extends Error { constructor(message: string, readonly status: number, readonly code: string) { super(message); } }
async function post<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" }); }
  catch { throw new ApiFailure("Fieldproof could not be reached. Check your connection and try again.", 0, "NETWORK"); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiFailure(result.error ?? "That did not work. Please try again.", response.status, result.code ?? "UNKNOWN");
  return result as T;
}
const date = (value: string) => new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(value));
const stamp = (value: string) => new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(new Date(value));
const electronicsCollected = (snapshot: ProjectSnapshot) => snapshot.packages.find(item => item.id === "electronics")?.collectedMinor ?? HERO_CAPTURED_MINOR;

export function JudgeLanding({ initialScenario, packages, replay, checkoutConfigured, autoStart }: { initialScenario: JudgeScenarioSummary | null; packages: PackageView[]; replay: HeroReplay | null; checkoutConfigured: boolean; autoStart: boolean }) {
  const [scenario, setScenario] = useState(initialScenario), [plan, setPlan] = useState(packages), [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [selected, setSelected] = useState("electronics");
  const [tour, setTour] = useState<{ key: number; startedAt: number; live: boolean; collected: number } | null>(null), [measured, setMeasured] = useState<TourResult | null>(null);
  const [confirmReset, setConfirmReset] = useState(false), [record, setRecord] = useState(false);
  const autoStarted = useRef(false), tourButton = useRef<HTMLButtonElement>(null);

  const adopt = useCallback((started: Started) => { setScenario(started.scenario); setPlan(started.snapshot.packages); adoptWorkspaceContext(started.snapshot.id); }, []);
  const startTour = useCallback(async () => {
    const startedAt = performance.now();
    setBusy("tour"); setError(null); setNotice(null); setMeasured(null);
    try {
      const started = await post<Started>("/api/judge/start", { intent: "tour" });
      adopt(started);
      setTour({ key: Date.now(), startedAt, live: true, collected: electronicsCollected(started.snapshot) });
    } catch (failure) {
      // Workspace creation is rate-limited and can be paused for maintenance. The story still plays, clearly marked read-only.
      if (failure instanceof ApiFailure && [0, 429, 503].includes(failure.status)) { setNotice(`${failure.message} Showing the read-only preview instead.`); setTour({ key: Date.now(), startedAt, live: false, collected: HERO_CAPTURED_MINOR }); }
      else setError(failure instanceof Error ? failure.message : "The tour could not start.");
    } finally { setBusy(null); }
  }, [adopt]);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    window.history.replaceState(null, "", "/judge");
    void startTour();
  }, [autoStart, startTour]);

  const go = async (label: string, role: JudgeRole | null, href: string) => {
    setBusy(label); setError(null);
    try {
      const started = await post<Started>("/api/judge/start", { intent: "workspace" });
      adopt(started);
      if (role) await post("/api/session/role", { role });
      window.location.assign(href);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Your workspace could not be opened."); setBusy(null); }
  };
  const startOver = async () => {
    setBusy("reset"); setError(null);
    try {
      const reset = await post<Started & { revokedPrevious: boolean }>("/api/judge/reset", { confirm: true });
      adopt(reset); setTour(null); setMeasured(null); setConfirmReset(false);
      setNotice(`Scenario ${reset.scenario.version} is ready in a new private workspace. ${reset.revokedPrevious ? "Your earlier workspace was closed in this browser; nothing in it was deleted." : "Nothing was deleted."}`);
      tourButton.current?.focus();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "A fresh scenario could not be created."); setConfirmReset(false); }
    finally { setBusy(null); }
  };
  const step = useCallback(async (value: 1 | 2 | 3) => {
    if (!tour?.live) return value >= 2 ? HERO_TARGET_MINOR : HERO_CAPTURED_MINOR;
    return electronicsCollected(await post<ProjectSnapshot>("/api/tour", { step: value }));
  }, [tour?.live]);
  const finished = useCallback((result: TourResult) => { setMeasured(result); setScenario(current => current ? { ...current, pristine: false, tourStep: 3 } : current); }, []);

  return <div className="judge-page">
    <a href="#judge-main" className="skip-link">Skip to content</a>
    <header className="judge-header"><Link className="wordmark" href="/" aria-label="Fieldproof home"><span className="brand-mark"><i /><i /><i /><i /></span>fieldproof<span className="brand-dot">.</span></Link>
      <nav aria-label="Judge page"><a href="#people">The people</a><a href="#roles">Explore by role</a><a href="#paypal">AI &amp; PayPal</a><a href="#live">Live sandbox</a><Link href="/">The project<ArrowUpRight size={13} /></Link></nav></header>
    <main id="judge-main">
      {(error || notice) && <div className={`page-notice judge-notice ${error ? "error" : ""}`} role={error ? "alert" : "status"}><span>{error ?? notice}</span><button className="icon-button" onClick={() => { setError(null); setNotice(null); }} aria-label="Dismiss message"><X size={16} /></button></div>}
      <section className="judge-hero">
        <div className="judge-hero-copy">
          <p className="judge-kicker"><span aria-hidden="true">✳</span>For hackathon judges · no signup · about a minute</p>
          <h1>Every community dollar, <span className="possibility">linked to proof<span className="drawn-underline" /></span><span className="period">.</span></h1>
          <p className="judge-lede">Fieldproof turns a volunteer project&apos;s rough plan into budgeted work packages, collects each pledge through PayPal, and repays the people who buy supplies. AI drafts the plan and reads the receipts; a person approves every payment, and every dollar stays linked to its evidence.</p>
          <div className="judge-actions">
            <button ref={tourButton} className="button primary judge-start" onClick={() => void startTour()} disabled={!!busy} data-testid="start-tour"><span className="play-circle"><Play size={12} fill="currentColor" /></span>{busy === "tour" ? "Creating your workspace…" : "Start the 60-second tour"}</button>
            <button className="button secondary" onClick={() => void go("workspace", null, "/")} disabled={!!busy} data-testid="open-workspace">{busy === "workspace" ? "Opening…" : "Open my own workspace"}<ArrowRight size={17} /></button>
          </div>
          <p className="judge-private"><LockKeyhole size={14} />Both buttons create your own private Sample workspace. No account, no email, nothing to install. It lasts twelve hours and you can start over at any time.</p>
          {scenario && <div className="judge-scenario" data-testid="scenario-strip" data-scenario-version={scenario.version}>
            <div><span className="eyebrow">Your workspace · scenario {scenario.version}</span><p>{scenario.pristine ? "Ready and untouched." : scenario.tourStep >= 2 ? "The tour has run here: Collected is $960." : "You have explored this workspace."} Minted {stamp(scenario.mintedAt)} · project deadline {date(scenario.deadline)}.</p>{measured && <p className="judge-last-run" data-testid="last-run">Last tour took {Math.round(measured.totalMs / 1000)} s on this device.</p>}</div>
            <button className="text-button" onClick={() => setConfirmReset(true)} disabled={!!busy} data-testid="start-over"><RotateCcw size={14} />Start over</button>
          </div>}
        </div>
        <div className="judge-hero-plan"><Blueprint packages={plan} selected={selected} onSelect={setSelected} /><div className="plan-caption"><span className="caption-number">01—06</span><span>Six work packages · {dollars(plan.reduce((sum, item) => sum + item.budgetMinor, 0))}</span><span className="caption-arrow">↗</span></div><div className="drawing-stamp"><span>FICTIONAL</span><strong>Sample.</strong><span>EASTSIDE MAKERSPACE</span></div></div>
      </section>

      <section className="judge-section" id="people" aria-labelledby="people-title">
        <header><p className="eyebrow">One classroom, three people</p><h2 id="people-title">The story you are about to see.</h2></header>
        <div className="judge-people">
          <article><span className="avatar warm">MO</span><h3>Ms. Okafor <small>organizer</small></h3><p>Has an empty classroom and a rough sketch. She needs a plan people can fund piece by piece, and a record her school board can trust.</p><span className="judge-beat"><Layers3 size={14} />Beat 1 · the sketch becomes a blueprint</span></article>
          <article><span className="avatar">S</span><h3>A supporter <small>that&apos;s you</small></h3><p>Pledged $50 to the Electronics benches. Eight pledges make $960; seven collect, one is declined and is recovered by invoice.</p><span className="judge-beat"><Heart size={14} />Beat 2 · collection and recovery</span></article>
          <article><span className="avatar">M</span><h3>Maria <small>volunteer</small></h3><p>Paid $86.40 for supplies out of pocket. Her receipt is split across two packages, checked for a duplicate, approved and repaid.</p><span className="judge-beat"><ReceiptText size={14} />Beat 3 · receipt to repayment</span></article>
        </div>
      </section>

      <section className="judge-section judge-truth" id="labels" aria-labelledby="labels-title">
        <header><p className="eyebrow">What is real here</p><h2 id="labels-title">Every payment on screen says where it came from.</h2></header>
        <div className="judge-labels">
          <article><ProvenanceChip /><p><strong>Fictional data in your workspace.</strong> Eastside Middle School, its supporters, Maria&apos;s receipt and every amount in the tour are invented. No provider is called and no money moves.</p></article>
          <article>{replay ? <ProvenanceChip replay observedAt={replay.recordedAt} /> : <span className="jt-chip none"><i />Replay · not available yet</span>}<p><strong>Facts observed from PayPal&apos;s sandbox.</strong> {replay ? `One real sandbox run of the same round was recorded (${replay.label}). The tour shows its observed states and identifier endings without running anything again.` : "When one real sandbox run of this round has been recorded, the tour will show its observed states here. Until then nothing in the tour is presented as provider-observed."}</p>{replay && <button className="text-button" onClick={() => setRecord(true)} data-testid="provider-record"><FileSearch size={14} />Open the provider record</button>}</article>
          <article><span className="jt-chip live"><i />Live sandbox</span><p><strong>Only what you do yourself.</strong> A live sandbox payment exists only after you approve it in PayPal with your own sandbox buyer account. The tour never shows this label. <a href="#live">How to try it</a></p></article>
        </div>
      </section>

      <section className="judge-section" id="roles" aria-labelledby="roles-title">
        <header><p className="eyebrow">Explore by role</p><h2 id="roles-title">Four seats at the same table.</h2><p>Each link opens your own workspace in that role, on the page where that person starts. You can switch roles at any time; the server checks every action.</p></header>
        <div className="judge-roles">{ROLE_LINKS.map(link => <button key={link.role} className="judge-role" onClick={() => void go(link.role, link.role, link.href)} disabled={!!busy} data-testid={`role-${link.role}`}>
          <span className="judge-role-icon">{link.role === "donor" ? <Heart size={20} /> : link.role === "volunteer" ? <ReceiptText size={20} /> : link.role === "organizer" ? <Users size={20} /> : <Eye size={20} />}</span>
          <span className="eyebrow">{link.person}</span><strong>{busy === link.role ? "Opening…" : link.title}</strong><span className="judge-role-text">{link.text}</span><span className="judge-role-go">Open as {link.role}<ArrowRight size={15} /></span></button>)}</div>
        {scenario?.cancellation && <p className="judge-aside"><CircleHelp size={15} />Also in your workspace: the {scenario.cancellation.title} is postponed (Sample). Its {scenario.cancellation.shares} supporters, all paid by Orders capture, each choose a return or another purpose by {date(scenario.cancellation.deadline)}. One of those shares is yours.</p>}
      </section>

      <section className="judge-section" id="paypal" aria-labelledby="paypal-title">
        <header><p className="eyebrow">How AI uses PayPal</p><h2 id="paypal-title">AI proposes. PayPal moves money. A person decides.</h2><p>No model ever calls a PayPal write. Models read, draft and explain; fixed code and a named person&apos;s approval are the only way money moves.</p></header>
        <div className="judge-map" role="table" aria-label="How AI, PayPal and people share each step">
          <div role="row" className="judge-map-head"><span role="columnheader">Step</span><span role="columnheader"><Sparkles size={13} />AI does</span><span role="columnheader"><HandCoins size={13} />PayPal does</span><span role="columnheader"><ShieldCheck size={13} />A person decides</span></div>
          {[
            ["Plan", "Reads a sketch and supplier quotes into zones, budgets and proof requirements.", "Nothing yet. Each package budget later becomes the exact amount of its orders.", "The organizer reviews every zone before the plan is published."],
            ["Collect", "Nothing. Collection is fixed code, not a model.", "Saved-wallet consent, then one Orders capture per pledge when the goal is reached.", "Each supporter approves their own exact amount in PayPal."],
            ["Recover", "Nothing. A decline is never retried by a model.", "One Invoicing invoice with a QR code for the same obligation, inside a 48-hour window.", "The supporter pays the invoice, or the round is refunded."],
            ["Repay", "Reads a receipt into lines, proposes a package for each, flags unclear lines and possible duplicates.", "A Payout to the volunteer's verified PayPal account (Log in with PayPal).", "The organizer approves the exact amount, then separately sends it."],
            ["Return", "Nothing. Shares are computed, not guessed.", "A refund of the original capture when a package is cancelled.", "Each supporter chooses a return or another purpose."],
            ["Explain", "Proof Studio's Steward and Auditor answer questions and build reports from the record.", "Read-only Agent Toolkit calls: one owned order or one owned invoice.", "The Auditor role is read-only; a payment request from it is refused."],
          ].map(row => <div role="row" key={row[0]}>{row.map((cell, index) => <span role={index ? "cell" : "rowheader"} key={index} data-label={["", "AI does", "PayPal does", "A person decides"][index]}>{cell}</span>)}</div>)}
        </div>
      </section>

      <section className="judge-section judge-live" id="live" aria-labelledby="live-title">
        <header><p className="eyebrow">Live sandbox · optional</p><h2 id="live-title">Bring your own PayPal sandbox buyer.</h2><p>If you have a PayPal developer account you can make a real sandbox payment with test funds. This runs in a separate live-sandbox workspace, never in the Sample story, and nothing happens until you approve it inside PayPal&apos;s own window.</p></header>
        {!checkoutConfigured && <p className="judge-aside warn" role="status"><CircleHelp size={15} />Live sandbox checkout is not switched on for this deployment right now. The Sample tour and every desk still work.</p>}
        <ol className="judge-steps">
          <li><strong>Have a sandbox Personal account ready.</strong><span>In the PayPal Developer Dashboard open Testing Tools → Sandbox Accounts and use (or create) a <em>Personal</em> account. That is your test buyer. Fieldproof never asks for its password; you type it only into PayPal.</span></li>
          <li><strong>Make one $1.00 test payment.</strong><span>Open the sandbox checkout, choose <em>Open your own sandbox workspace</em>, stay in the Donor role, tick the single approval box and pay with your sandbox buyer. Fieldproof records the payment only after PayPal confirms the capture.</span><Link className="text-button" href="/sandbox">Open the sandbox checkout<ArrowUpRight size={14} /></Link></li>
          <li><strong>Or save a wallet for a conditional pledge.</strong><span>Choose an exact share of the $960 Electronics benches goal and approve saving your sandbox wallet in PayPal. Saving it charges nothing. Collection only begins once all eight shares are committed and the organizer freezes the round.</span><Link className="text-button" href="/commitment">Open conditional commitments<ArrowUpRight size={14} /></Link></li>
          <li><strong>Follow it into the record.</strong><span>A confirmed payment appears in that workspace as a Live sandbox receipt, never as Sample. Your Sample workspace stays available under Saved workspaces.</span></li>
        </ol>
        <p className="judge-private"><BookOpenCheck size={14} />Use only your own sandbox account. No sandbox login is published here, and no real currency moves anywhere in this demonstration.</p>
      </section>
    </main>
    <footer className="site-footer judge-footer"><div><Link href="/" className="wordmark">fieldproof<span className="brand-dot">.</span></Link><p>Every community dollar, linked to proof.</p></div><div className="footer-note"><span>MADE FOR PEOPLE MAKING THINGS BETTER.</span><p>Fictional project · Sample records · PayPal sandbox only</p></div><nav aria-label="Footer"><Link href="/">The project</Link><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></nav></footer>

    {tour && <JudgeTour key={tour.key} packages={plan} scenario={tour.live ? scenario : null} replay={replay} live={tour.live} startedAt={tour.startedAt} startCollectedMinor={tour.collected} busy={!!busy}
      onStep={step} onResult={finished} onClose={() => { setTour(null); tourButton.current?.focus(); }} onOpenWorkspace={() => void go("workspace", null, "/")} onOpenRole={(role, href) => void go(role, role, href)}
      onWatchAgain={() => { setTour(null); void startTour(); }} onStartOver={() => setConfirmReset(true)} />}
    {confirmReset && <ResetDialog busy={busy === "reset"} hasWorkspace={!!scenario} onCancel={() => setConfirmReset(false)} onConfirm={() => void startOver()} />}
    {record && replay && <ProviderRecord replay={replay} onClose={() => setRecord(false)} />}
  </div>;
}

function ResetDialog({ busy, hasWorkspace, onCancel, onConfirm }: { busy: boolean; hasWorkspace: boolean; onCancel: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = ref.current; if (node && !node.open) node.showModal(); return () => { if (node?.open) node.close(); }; }, []);
  return <dialog ref={ref} className="modal judge-reset" aria-labelledby="reset-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }} data-testid="reset-dialog">
    <span className="eyebrow">Start over</span><h2 id="reset-title">Begin again with a fresh scenario?</h2>
    <p>You get a brand-new private workspace with the story back at its beginning: $925 collected and one $35 payment to recover.</p>
    <ul className="check-list"><li><Check size={16} />Only your own workspace is affected.</li><li><Check size={16} />{hasWorkspace ? "Your current workspace is closed in this browser. Nothing in it is deleted." : "Nothing is deleted."}</li><li><Check size={16} />No PayPal record is touched, and no payment is repeated.</li></ul>
    <div className="judge-reset-actions"><button className="button secondary" onClick={onCancel} disabled={busy}>Keep this one</button><button className="button primary" onClick={onConfirm} disabled={busy} data-testid="confirm-reset">{busy ? "Creating…" : "Start over"}<RotateCcw size={15} /></button></div>
  </dialog>;
}

function ProviderRecord({ replay, onClose }: { replay: HeroReplay; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = ref.current; if (node && !node.open) node.showModal(); return () => { if (node?.open) node.close(); }; }, []);
  return <dialog ref={ref} className="judge-drawer" aria-labelledby="record-title" onCancel={event => { event.preventDefault(); onClose(); }} data-testid="provider-record-drawer">
    <header><div><span className="eyebrow">Provider record · PayPal sandbox</span><h2 id="record-title">{replay.label}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close provider record"><X size={20} /></button></header>
    <p>These are sanitized facts observed from PayPal during one real sandbox run, recorded {stamp(replay.recordedAt)}. Identifiers are shortened to their last characters. Opening this page does not call PayPal.</p>
    <div className="table-scroll"><table><thead><tr><th>Pledge</th><th>Route</th><th>PayPal id</th><th>Observed state</th><th>Observed</th></tr></thead><tbody>{[...replay.obligations].sort((a, b) => a.slot - b.slot).map(item => <tr key={item.slot}><th>{dollars(item.amountMinor)}</th><td>{item.rail === "orders_capture" ? "Orders capture" : "Invoice payment"}</td><td className="mono">…{item.providerIdSuffix}</td><td>{item.observedStatus}</td><td><ProvenanceChip replay observedAt={item.observedAt} /></td></tr>)}</tbody></table></div>
    <dl className="judge-record-facts">
      <div><dt>The declined payment</dt><dd>{dollars(replay.decline.amountMinor)} · {declineWording(replay)} · {replay.decline.observedReason}{replay.decline.providerIdSuffix ? ` · order …${replay.decline.providerIdSuffix}` : ""}<ProvenanceChip replay observedAt={replay.decline.observedAt} /></dd></div>
      <div><dt>The recovery invoice</dt><dd>Invoice …{replay.invoice.idSuffix} · {replay.invoice.observedStatus} · QR code {replay.invoice.qrPresent ? "returned by PayPal" : "not returned"} · settled {Math.round(replay.invoice.elapsedSecondsFromDecline)} s after the decline<ProvenanceChip replay observedAt={replay.invoice.settledAt} /></dd></div>
      <div><dt>The repayment</dt><dd>{replay.payout ? <>Payout item …{replay.payout.itemSuffix} · {dollars(replay.payout.amountMinor, true)} · {replay.payout.observedStatus}<ProvenanceChip replay observedAt={replay.payout.observedAt} /></> : "No payout was part of the recorded run."}</dd></div>
      <div><dt>Refunds</dt><dd>{replay.refunds.length ? replay.refunds.map(refund => <span key={refund.idSuffix} className="judge-record-line">Refund …{refund.idSuffix} · {dollars(refund.amountMinor, true)} · {refund.observedStatus}<ProvenanceChip replay observedAt={refund.observedAt} /></span>) : "No refund was part of the recorded run."}</dd></div>
    </dl>
    <p className="fine-print">A replay shows what was already observed. It is never re-executed, and it is not a payment in your workspace.</p>
  </dialog>;
}
export const judgeTourSeconds = Math.round(TOUR_SCRIPTED_MS / 1000);
