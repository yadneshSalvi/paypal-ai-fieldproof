"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, CircleHelp, ClipboardCheck, Copy, Pause, Play, QrCode, RotateCcw, ScanLine, SkipForward, Smartphone, X } from "lucide-react";
import type { PackageView } from "@/lib/contracts";
import { declineWording, type HeroReplay } from "@/lib/judge/hero-replay";
import { activeCue, captureAt, COMPRESSED_CAPTION, cueReached, dollars, HERO_AMOUNTS, HERO_CAPTURED_MINOR, HERO_LABELS, HERO_RECOVERY_MINOR, HERO_TARGET_MINOR, lineAt, MARIA_APPROVED_MINOR, MARIA_HELD_MINOR, MARIA_RECEIPT, MARIA_TOTAL_MINOR, PROJECT_TOTAL_MINOR, receiptSubtotal, RECOVERY_LABEL, REDRAW_MS, ROLE_LINKS, TOUR_BEATS, TOUR_SCRIPTED_MS, type JudgeRole, type TourBeat } from "@/lib/judge/tour-script";
import { Blueprint, SketchRegion, type BlueprintReveal } from "../blueprint";

export interface TourScenario { version: number; collectionStartedAt: string; recoveryEndsAt: string }
export interface TourResult { totalMs: number; firstBlueprintMs: number | null; pausedMs: number }
type StepState = "idle" | "pending" | "done" | "failed";
const day = (value: string) => new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(value));
const clock = (value: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(value));
const seconds = (ms: number) => ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000));

/** Every provider-shaped step carries one of these. There is deliberately no "Live" variant in the tour. */
export function ProvenanceChip({ replay, observedAt, label }: { replay?: boolean; observedAt?: string | null; label?: string }) {
  return replay && observedAt
    ? <span className="jt-chip replay" title="A fact copied from one recorded PayPal sandbox run. Nothing was re-executed for this tour."><i />Replay · observed {day(observedAt)}</span>
    : <span className="jt-chip sample" title="Fictional data in your own Sample workspace. No provider was called."><i />{label ?? "Sample"}</span>;
}

export function JudgeTour({ packages, scenario, replay, live, startedAt, startCollectedMinor, onStep, onClose, onResult, onOpenWorkspace, onOpenRole, onWatchAgain, onStartOver, busy }: {
  packages: PackageView[]; scenario: TourScenario | null; replay: HeroReplay | null; live: boolean; startedAt: number; startCollectedMinor: number;
  /** Records a tour step in the visitor's own tenant and resolves with the Electronics collected total afterwards. */
  onStep: (step: 1 | 2 | 3) => Promise<number>;
  onClose: () => void; onResult: (result: TourResult) => void; onOpenWorkspace: () => void; onOpenRole: (role: JudgeRole, href: string) => void; onWatchAgain: () => void; onStartOver: () => void; busy: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null), pauseButton = useRef<HTMLButtonElement>(null);
  const [index, setIndex] = useState(0), [elapsed, setElapsed] = useState(0), [playing, setPlaying] = useState(true);
  const [steps, setSteps] = useState<Record<number, StepState>>({ 1: "idle", 2: "idle", 3: "idle" }), [collected, setCollected] = useState(startCollectedMinor);
  const [result, setResult] = useState<TourResult | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve()), requested = useRef(new Set<number>()), firstBlueprint = useRef<number | null>(null), paused = useRef(0), pausedSince = useRef<number | null>(null);
  const beat: TourBeat | undefined = TOUR_BEATS[index], ended = index >= TOUR_BEATS.length;

  useEffect(() => { const node = dialog.current; if (node && !node.open) node.showModal(); pauseButton.current?.focus(); return () => { if (node?.open) node.close(); }; }, []);

  const ensureStep = useCallback((step: 1 | 2 | 3) => {
    for (const each of [1, 2, 3] as const) {
      if (each > step || requested.current.has(each)) continue;
      requested.current.add(each);
      setSteps(current => ({ ...current, [each]: "pending" }));
      chain.current = chain.current.then(() => onStep(each)).then(total => { setCollected(total); setSteps(current => ({ ...current, [each]: "done" })); },
        () => { setSteps(current => ({ ...current, [each]: "failed" })); });
    }
  }, [onStep]);
  const retryStep = (step: 1 | 2 | 3) => { requested.current.delete(step); ensureStep(step); };

  // The script clock only runs while playing; wall-clock time is measured separately and honestly.
  useEffect(() => {
    if (!playing || ended) return;
    let last = performance.now();
    const timer = window.setInterval(() => { const now = performance.now(), delta = Math.min(1000, now - last); last = now; setElapsed(value => value + delta); }, 80);
    return () => window.clearInterval(timer);
  }, [playing, ended, index]);
  useEffect(() => {
    if (playing) { if (pausedSince.current !== null) { paused.current += performance.now() - pausedSince.current; pausedSince.current = null; } }
    else if (pausedSince.current === null) pausedSince.current = performance.now();
  }, [playing]);

  const settledOnServer = collected >= HERO_TARGET_MINOR;
  const goTo = useCallback((next: number) => {
    if (next > 1) ensureStep(2);
    setIndex(next); setElapsed(0);
  }, [ensureStep]);
  useEffect(() => {
    if (!beat) return;
    ensureStep(beat.step === 2 ? 1 : beat.step);
    if (beat.id === "collection" && cueReached(beat, "settling", elapsed)) ensureStep(2);
    if (beat.id === "sketch" && firstBlueprint.current === null && elapsed >= beat.cues[2].at) firstBlueprint.current = performance.now() - startedAt;
    // The collection beat never moves on while the workspace is still recording the invoice receipt.
    if (elapsed >= beat.durationMs && !(beat.id === "collection" && steps[2] === "pending")) goTo(index + 1);
  }, [beat, elapsed, ensureStep, goTo, index, startedAt, steps]);
  useEffect(() => {
    if (!ended || result) return;
    if (pausedSince.current !== null) { paused.current += performance.now() - pausedSince.current; pausedSince.current = null; }
    const measured = { totalMs: performance.now() - startedAt, firstBlueprintMs: firstBlueprint.current, pausedMs: paused.current };
    setResult(measured); onResult(measured);
  }, [ended, onResult, result, startedAt]);

  const next = () => { if (!ended) { setPlaying(true); goTo(index + 1); } };
  const keys = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement, onControl = !!target.closest("button,a,summary,input,select");
    if ((event.key === " " || event.key.toLowerCase() === "k") && !onControl && !ended) { event.preventDefault(); setPlaying(value => !value); }
    else if ((event.key === "ArrowRight" || event.key.toLowerCase() === "n") && !ended) { event.preventDefault(); next(); }
  };
  const cue = beat ? activeCue(beat, elapsed) : null, firstMs = result ? result.firstBlueprintMs : firstBlueprint.current;
  const state = ended ? "end" : `beat-${index + 1}`;
  return <dialog ref={dialog} className="jt-dialog" aria-labelledby="jt-title" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={keys}
    data-tour-state={state} data-tour-cue={cue?.id ?? "end"} data-tour-live={live ? "true" : "false"} data-first-blueprint-ms={firstMs === null ? "" : Math.round(firstMs)} data-total-ms={result ? Math.round(result.totalMs) : ""}>
    <header className="jt-bar">
      <div className="jt-bar-title"><span className="eyebrow">60-second tour{scenario ? ` · scenario ${scenario.version}` : ""}</span><strong id="jt-title">{ended ? "The whole loop, start to finish." : beat!.title}</strong></div>
      <ol className="jt-progress" aria-label="Tour progress">{TOUR_BEATS.map((item, position) => <li key={item.id} className={position < index ? "done" : position === index ? "current" : ""} aria-current={position === index ? "step" : undefined}><span className="jt-progress-label">{position + 1}<span> · {item.id === "sketch" ? "Plan" : item.id === "collection" ? "Collect" : "Repay"}</span></span><i><b style={{ width: `${position < index ? 100 : position === index ? Math.min(100, elapsed / item.durationMs * 100) : 0}%` }} /></i></li>)}</ol>
      <div className="jt-controls">
        {!ended && <button ref={pauseButton} className="icon-button" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause tour" : "Play tour"} aria-pressed={!playing}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>}
        {!ended && <button className="button small jt-next" onClick={next}>{index === TOUR_BEATS.length - 1 ? "Finish" : "Next"}<SkipForward size={15} /></button>}
        <button className="icon-button" onClick={onClose} aria-label="Close tour"><X size={19} /></button>
      </div>
    </header>
    {!live && !ended && <p className="jt-readonly" role="status"><CircleHelp size={15} />Read-only preview. A private workspace could not be created just now, so nothing is recorded; the story and its numbers are the same.</p>}
    {beat && <section className={`jt-stage jt-${beat.id}`} aria-label={`Beat ${index + 1} of 3`}>
      <div className="jt-visual">
        {beat.id === "sketch" && <SketchBeat beat={beat} elapsed={elapsed} packages={packages} />}
        {beat.id === "collection" && <CollectionBeat beat={beat} elapsed={elapsed} scenario={scenario} replay={replay} live={live} settledOnServer={settledOnServer} step={steps[2]} onRetry={() => retryStep(2)} />}
        {beat.id === "receipt" && <ReceiptBeat beat={beat} elapsed={elapsed} replay={replay} />}
      </div>
      <aside className="jt-story">
        <span className="eyebrow">Beat {index + 1} of 3 · {beat.kicker}</span>
        <p className="jt-say" aria-live="polite" aria-atomic="true">{cue!.say}</p>
        <ul className="jt-cues" aria-hidden="true">{beat.cues.map(item => <li key={item.id} className={elapsed >= item.at ? "reached" : ""} />)}</ul>
        {beat.id === "sketch" && <p className="jt-foot"><ProvenanceChip />The plan in your workspace is seeded Sample data. In the Planning desk the same step reads a real upload with AI, and nothing is published until a person reviews it.</p>}
        {beat.id === "collection" && <p className="jt-foot">{replay ? <ProvenanceChip replay observedAt={replay.invoice.settledAt} /> : <ProvenanceChip />}{replay ? `Amounts and states come from one recorded sandbox run (${replay.label}). They are replayed, not re-executed.` : "No PayPal call is made in this tour. A recorded provider replay is not available yet, so every payment here is fictional Sample data."}</p>}
        {beat.id === "receipt" && <p className="jt-foot"><ProvenanceChip />Illustrated with Sample data. In your workspace Maria&apos;s receipt still waits for your review, and no repayment has been sent.</p>}
        <p className="jt-keys">Space pauses · → next · Esc closes</p>
      </aside>
    </section>}
    {ended && <EndCard result={result} replay={replay} live={live} busy={busy} failed={Object.values(steps).includes("failed")} onOpenWorkspace={onOpenWorkspace} onOpenRole={onOpenRole} onWatchAgain={onWatchAgain} onStartOver={onStartOver} onClose={onClose} />}
  </dialog>;
}

function SketchBeat({ beat, elapsed, packages }: { beat: TourBeat; elapsed: number; packages: PackageView[] }) {
  const redrawAt = beat.cues[1].at, reveal: BlueprintReveal = elapsed < redrawAt ? "sketch" : elapsed < redrawAt + REDRAW_MS ? "redraw" : "drawn";
  const source = cueReached(beat, "source", elapsed), review = cueReached(beat, "review", elapsed);
  const [selected, setSelected] = useState("electronics"), electronics = packages.find(item => item.id === (source ? selected : "electronics")) ?? packages[0];
  return <div className="jt-sketch-wrap">
    <div className="jt-plan"><Blueprint packages={packages} selected={source ? selected : ""} onSelect={setSelected} reveal={reveal} />
      <span className={`jt-plan-tag ${reveal === "sketch" ? "" : "drawn"}`}>{reveal === "sketch" ? "Rough sketch · not reviewed" : `Six work packages · ${dollars(PROJECT_TOTAL_MINOR)}`}</span>
    </div>
    <div className={`jt-source ${source ? "shown" : ""}`} aria-hidden={!source}>
      <SketchRegion packages={packages} highlight={electronics.id} label={`The region of the sketch that became ${electronics.title}.`} />
      <div><span className="eyebrow">Source region</span><strong>{electronics.title}</strong><span>{dollars(electronics.budgetMinor)} budget · drawn from this part of the sketch</span></div>
    </div>
    <div className={`jt-review-note ${review ? "shown" : ""}`} aria-hidden={!review}><ClipboardCheck size={18} /><div><strong>Review before publishing</strong><span>An organizer checks every zone and budget. Supporters only ever see a reviewed plan.</span></div></div>
  </div>;
}

function CollectionBeat({ beat, elapsed, scenario, replay, live, settledOnServer, step, onRetry }: { beat: TourBeat; elapsed: number; scenario: TourScenario | null; replay: HeroReplay | null; live: boolean; settledOnServer: boolean; step: StepState; onRetry: () => void }) {
  const declined = cueReached(beat, "declined", elapsed), invoice = cueReached(beat, "invoice", elapsed), settling = cueReached(beat, "settling", elapsed);
  // Collected only moves to $960 once the visitor's own workspace has recorded the invoice receipt.
  const settled = cueReached(beat, "settled", elapsed) && (live ? settledOnServer : true);
  const chipState = (position: number) => {
    if (position < 7) return elapsed >= captureAt(position) ? "captured" : elapsed >= captureAt(position) - 520 ? "capturing" : "pledged";
    return settled ? "recovered" : invoice ? "recovering" : declined ? "declined" : elapsed >= captureAt(7) - 520 ? "capturing" : "pledged";
  };
  const captured = HERO_AMOUNTS.reduce((sum, amount, position) => sum + (position < 7 && chipState(position) === "captured" ? amount : 0), 0);
  const target = captured + (settled ? HERO_RECOVERY_MINOR : 0), shown = useCountTo(target);
  const reason = replay ? `${declineWording(replay)} · ${replay.decline.observedReason}` : "Declined · the payer's payment method was refused";
  return <div className="jt-collect">
    <div className="jt-collect-head">
      <div><span className="eyebrow">Electronics benches · collection round</span><strong className="jt-total" aria-live="off"><span>Collected</span>{dollars(shown)}<small>of {dollars(HERO_TARGET_MINOR)}</small></strong></div>
      <div className="jt-meter" role="img" aria-label={`${dollars(target)} of ${dollars(HERO_TARGET_MINOR)} collected`}><b className="orders" style={{ width: `${captured / HERO_TARGET_MINOR * 100}%` }} /><b className="invoice" style={{ width: `${settled ? HERO_RECOVERY_MINOR / HERO_TARGET_MINOR * 100 : 0}%` }} /></div>
      <p className={`jt-split ${settled ? "shown" : ""}`}>{settled ? RECOVERY_LABEL : captured >= HERO_CAPTURED_MINOR ? "$925 Orders captures · $35 still to recover" : "Collecting each pledge as its own PayPal order…"}</p>
    </div>
    <ol className="jt-chips">{HERO_AMOUNTS.map((amount, position) => { const status = chipState(position), observed = replay?.obligations.find(item => item.slot === position + 1);
      return <li key={position} className={`jt-donor ${status}`}>
        <span className="jt-donor-mark" aria-hidden="true">{status === "captured" || status === "recovered" ? <Check size={14} /> : status === "declined" ? <X size={14} /> : status === "recovering" ? <QrCode size={13} /> : null}</span>
        <strong>{dollars(amount)}</strong><span className="jt-donor-who">{HERO_LABELS[position]}</span>
        <small>{status === "captured" ? "Orders capture" : status === "recovered" ? "Invoice payment" : status === "declined" ? "Declined" : status === "recovering" ? "Invoice open" : status === "capturing" ? "Collecting…" : "Pledged"}{observed && (status === "captured" || status === "recovered") ? ` …${observed.providerIdSuffix}` : ""}</small>
      </li>; })}</ol>
    <p className={`jt-decline ${declined && !settled ? "shown" : ""}`} role="status" aria-hidden={!declined || settled}><X size={15} /><span><strong>$35 · {reason}.</strong> Nothing is retried blindly; the original payment is checked first.</span>{replay ? <ProvenanceChip replay observedAt={replay.decline.observedAt} /> : <ProvenanceChip />}</p>
    <div className={`jt-recovery ${invoice ? "shown" : ""} ${settled ? "paid" : ""}`} aria-hidden={!invoice}>
      <div className="jt-qr" role="img" aria-label={replay?.invoice.qrPresent ? "PayPal returned a QR code for this invoice in the recorded run. The image is not kept." : "Illustration of an invoice QR code. This Sample code cannot be scanned."}><QrGlyph /><span>{replay ? "Replay" : "Sample"}</span></div>
      <div className="jt-recovery-text">
        <span className="eyebrow">Recovery invoice · same $35 obligation</span>
        <strong>{settled ? "Paid from a phone. Settlement observed." : settling ? "Checking the invoice payment…" : "One invoice, with a QR code to pay from a phone."}</strong>
        <ol className="jt-recovery-steps"><li className="on"><ScanLine size={14} />Invoice sent</li><li className={settling ? "on" : ""}><Smartphone size={14} />Paid on a phone</li><li className={settled ? "on" : ""}><Check size={14} />Settlement observed</li></ol>
        <p className="jt-compressed">{COMPRESSED_CAPTION}{scenario ? ` In your workspace the round froze ${clock(scenario.collectionStartedAt)} and recovery stays open until ${clock(scenario.recoveryEndsAt)}.` : ""}{replay ? ` In the recorded run the invoice settled ${Math.round(replay.invoice.elapsedSecondsFromDecline)} s after the decline (invoice …${replay.invoice.idSuffix}).` : ""}</p>
        {step === "failed" && <p className="jt-step-error" role="alert">Your workspace could not record this step, so Collected stays at $925. <button className="text-button" onClick={onRetry}>Try again<RotateCcw size={13} /></button></p>}
      </div>
    </div>
  </div>;
}
function QrGlyph() {
  // A fixed illustrative pattern, not an encoded payload: it must never scan as a real payment link.
  const cells = useMemo(() => { const out: [number, number][] = []; let state = 9173; for (let y = 0; y < 13; y++) for (let x = 0; x < 13; x++) { state = (state * 1103515245 + 12345) % 2147483648; const finder = (x < 4 && y < 4) || (x > 8 && y < 4) || (x < 4 && y > 8); if (!finder && state % 100 < 46) out.push([x, y]); } return out; }, []);
  return <svg viewBox="0 0 13 13" aria-hidden="true">{[[0, 0], [9, 0], [0, 9]].map(([x, y]) => <g key={`${x}-${y}`}><rect x={x} y={y} width="4" height="4" fill="#1e3a5f" /><rect x={x + 1} y={y + 1} width="2" height="2" fill="#fffdf8" /><rect x={x + 1.5} y={y + 1.5} width="1" height="1" fill="#1e3a5f" /></g>)}{cells.map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#1e3a5f" />)}</svg>;
}
function useCountTo(target: number): number {
  const [value, setValue] = useState(target), from = useRef(target);
  useEffect(() => {
    if (typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches || from.current === target) { from.current = target; setValue(target); return; }
    const start = from.current, began = performance.now(), duration = 520; let frame = 0;
    const tick = (now: number) => { const progress = Math.min(1, (now - began) / duration), current = Math.round((start + (target - start) * (1 - Math.pow(1 - progress, 3))) / 100) * 100; from.current = current; setValue(progress === 1 ? target : current); if (progress < 1) frame = requestAnimationFrame(tick); else from.current = target; };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return value;
}

function ReceiptBeat({ beat, elapsed, replay }: { beat: TourBeat; elapsed: number; replay: HeroReplay | null }) {
  const moved = (position: number) => elapsed >= lineAt(position), duplicate = cueReached(beat, "duplicate", elapsed) && !cueReached(beat, "approval", elapsed), approved = cueReached(beat, "approval", elapsed), repayment = cueReached(beat, "repayment", elapsed);
  const bins = [{ id: "electronics" as const, title: "Electronics benches" }, { id: "materials" as const, title: "Student materials" }];
  const payout = replay?.payout ?? null;
  return <div className="jt-receipt-wrap">
    <div className="jt-paper" aria-label="Maria's Sample receipt">
      <span className="jt-paper-store">EASTSIDE SUPPLY CO.</span><span className="jt-paper-sub">Fictional vendor · Sample document</span>
      <ul>{MARIA_RECEIPT.map((line, position) => <li key={line.id} className={`${moved(position) ? "moved" : ""} ${line.target}`}><span>{line.label} ({line.quantity})</span><b>{dollars(line.amountMinor, true)}</b></li>)}</ul>
      <div className="jt-paper-total"><span>TOTAL</span><b>{dollars(MARIA_TOTAL_MINOR, true)}</b></div>
    </div>
    <div className="jt-bins">
      {bins.map(bin => { const lines = MARIA_RECEIPT.map((line, position) => ({ line, position })).filter(item => item.line.target === bin.id), sum = lines.reduce((total, item) => total + (moved(item.position) ? item.line.amountMinor : 0), 0);
        return <section key={bin.id} className={`jt-bin ${bin.id} ${approved ? "approved" : ""}`}><header><strong>{bin.title}</strong><b>{dollars(sum, true)}</b></header>
          <ul>{lines.map(item => <li key={item.line.id} className={moved(item.position) ? "in" : ""}><span>{item.line.label}</span><b>{dollars(item.line.amountMinor, true)}</b></li>)}</ul>
          {approved && <span className="jt-stamp"><Check size={13} />Approved {dollars(receiptSubtotal(bin.id), true)}</span>}</section>; })}
      <section className={`jt-bin review ${moved(6) ? "flagged" : ""}`}><header><strong>Needs a person</strong><b>{dollars(moved(6) ? MARIA_HELD_MINOR : 0, true)}</b></header>
        <ul><li className={moved(6) ? "in" : ""}><span>&ldquo;Parts&rdquo; · purpose unclear</span><b>{dollars(MARIA_HELD_MINOR, true)}</b></li></ul>
        {approved && <span className="jt-stamp hold"><CircleHelp size={13} />Held {dollars(MARIA_HELD_MINOR, true)}</span>}</section>
    </div>
    <div className={`jt-duplicate ${duplicate ? "shown" : ""}`} aria-hidden={!duplicate}>
      <header><Copy size={16} /><strong>Possible duplicate</strong><span>Same vendor, receipt number and total. A person compares them side by side.</span></header>
      <div className="jt-duplicate-pair">{["Maria's first upload", "Second upload · cropped photo"].map((title, position) => <figure key={title} className={position ? "cropped" : ""}><div className="jt-mini-paper"><span>EASTSIDE SUPPLY CO.</span><i /><i /><i /><i /><i /><b>TOTAL {dollars(MARIA_TOTAL_MINOR, true)}</b></div><figcaption>{title}</figcaption></figure>)}</div>
    </div>
    <div className={`jt-outcome ${approved ? "shown" : ""}`} aria-hidden={!approved}>
      <p><strong>Ms. Okafor approves {dollars(MARIA_APPROVED_MINOR, true)}.</strong> {dollars(MARIA_HELD_MINOR, true)} stays on hold and the duplicate is set aside. An approval is a separate decision from sending money.</p>
      <ol className={`jt-repay ${repayment ? "shown" : ""}`} aria-label="Maria's repayment status"><li className="on"><Check size={13} />Approved</li><li className={payout ? "on" : ""}>Payout sent</li><li className={payout?.observedStatus === "SUCCESS" ? "on" : ""}>{payout && payout.observedStatus !== "SUCCESS" ? `PayPal status: ${payout.observedStatus}` : "Received by Maria"}</li></ol>
      <p className={`jt-repay-note ${repayment ? "shown" : ""}`}>{payout ? <><ProvenanceChip replay observedAt={payout.observedAt} />Payout item …{payout.itemSuffix} for {dollars(payout.amountMinor, true)} was observed as {payout.observedStatus} in the recorded run.</> : <><ProvenanceChip />This is what Maria follows. No payout was sent: a Sample workspace never moves money.</>}</p>
    </div>
  </div>;
}

function EndCard({ result, replay, live, busy, failed, onOpenWorkspace, onOpenRole, onWatchAgain, onStartOver, onClose }: { result: TourResult | null; replay: HeroReplay | null; live: boolean; busy: boolean; failed: boolean; onOpenWorkspace: () => void; onOpenRole: (role: JudgeRole, href: string) => void; onWatchAgain: () => void; onStartOver: () => void; onClose: () => void }) {
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => { primary.current?.focus(); }, []);
  return <section className="jt-end" aria-label="Tour finished">
    <div className="jt-end-main">
      <span className="eyebrow">A plan · a collection · a repayment</span>
      <h2>That&apos;s the whole loop.</h2>
      <p className="jt-measured" role="status" data-testid="tour-measured">{result ? <>Tour took <strong>{seconds(result.totalMs)} s</strong> on this device.</> : "Measuring…"}</p>
      {result && <p className="jt-measured-detail">{result.firstBlueprintMs === null ? "The sketch redraw was skipped." : `First blueprint ${seconds(result.firstBlueprintMs)} s after you pressed start.`} Scripted pace {Math.round(TOUR_SCRIPTED_MS / 1000)} s{result.pausedMs > 500 ? ` · ${seconds(result.pausedMs)} s paused` : ""}. Measured in your browser from the click to this card.</p>}
      <ul className="jt-recap">
        <li><ProvenanceChip />The plan, the eight pledges and Maria&apos;s receipt are fictional Sample data in {live ? "your own private workspace" : "the shared preview"}.</li>
        <li>{replay ? <><ProvenanceChip replay observedAt={replay.recordedAt} />Payment states were replayed from one recorded PayPal sandbox run ({replay.label}).</> : <><span className="jt-chip none"><i />Replay not available</span>No recorded PayPal sandbox run is attached yet, so nothing here was shown as provider-observed.</>}</li>
        {failed && <li className="warn">One step could not be recorded in your workspace. Start over for a clean scenario.</li>}
      </ul>
      <div className="jt-end-actions"><button ref={primary} className="button primary" disabled={busy} onClick={onOpenWorkspace}>Open my workspace<ArrowRight size={17} /></button><button className="button secondary" disabled={busy} onClick={onWatchAgain}><RotateCcw size={15} />Watch again</button><button className="text-button" disabled={busy} onClick={onStartOver}>Start over with a fresh scenario</button></div>
    </div>
    <div className="jt-end-roles"><span className="eyebrow">Now try it as…</span>{ROLE_LINKS.map(link => <button key={link.role} className="jt-role-row" disabled={busy} onClick={() => onOpenRole(link.role, link.href)}><span><strong>{link.person}</strong><small>{link.title}</small></span><ArrowRight size={16} /></button>)}<button className="text-button" onClick={onClose}>Back to the judge page</button></div>
  </section>;
}
