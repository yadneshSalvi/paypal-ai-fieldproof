"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown, Clock3, Heart, LockKeyhole, RefreshCw, ShieldCheck, Wallet, Zap } from "lucide-react";
import type { ProjectSnapshot } from "@/lib/contracts";
import type { ConsentView } from "@/lib/domain/consent";
import { formatMoney } from "@/lib/domain/money";

interface Overview {
  commitments: ConsentView[];
  slots: { index: number; amountMinor: number; available: boolean }[];
  eligibleMinor: number; targetMinor: number; expiresAt: string;
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "This commitment could not be checked. Your saved request remains available.");
  return result as T;
}
const labels: Record<ConsentView["status"], string> = {
  awaiting_wallet: "Your consent is saved", wallet_pending: "PayPal approval pending", ready: "Ready if the target is met",
  review_required: "Provider status needs a check", unavailable: "Wallet connection unavailable", withdrawn: "Commitment withdrawn",
  collecting: "Collection in progress", collected: "Payment collected",
  refunding: "Refund being confirmed", refunded: "Payment refunded",
  cancelled: "Collection cancelled",
};

export function ConditionalCommitment({ snapshot, onStart, onRefresh }: { snapshot: ProjectSnapshot; onStart: () => Promise<void>; onRefresh: () => Promise<void> }) {
  const [overview, setOverview] = useState<Overview | null>(null), [selected, setSelected] = useState(7);
  const [accepted, setAccepted] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null);
  const returnChecked = useRef<string | null>(null);
  const live = snapshot.mode === "live_sandbox" && !!snapshot.session;
  const donor = snapshot.session?.role === "donor";
  const version = snapshot.packages.find(item => item.id === "electronics")?.version ?? 1;
  const load = useCallback(async () => { const next = await request<Overview>("commitments"); setOverview(next); return next; }, []);
  useEffect(() => {
    if (!live) { setLoading(false); return; }
    let active = true;
    setLoading(true);
    void request<Overview>("commitments").then(next => { if (active) setOverview(next); }).catch(issue => { if (active) setError(issue.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [live, snapshot.id]);
  useEffect(() => {
    if (!live || !donor) return;
    const params = new URLSearchParams(window.location.search), id = params.get("consent"), returned = params.get("wallet");
    if (!id || !returned || returnChecked.current === id) return;
    returnChecked.current = id;
    if (returned === "cancelled") { setMessage("You left PayPal approval. No contribution was charged. Your commitment stays pending until you continue or withdraw it."); return; }
    if (returned !== "returned") return;
    setBusy(true);
    void request<ConsentView>("commitments/check", { consentId: id }).then(async value => {
      await load(); await onRefresh();
      setMessage(value.status === "ready" ? "PayPal confirmed your saved wallet. Your contribution will be collected only if the package reaches its target." : "Your PayPal return is recorded. Check the commitment below for its current provider status.");
    }).catch(issue => setError(issue.message)).finally(() => setBusy(false));
  }, [live, donor, load, onRefresh]);
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(null); setMessage(null); try { await work(); } catch (issue) { setError(issue instanceof Error ? issue.message : "This action could not finish."); } finally { setBusy(false); } };
  const chosen = overview?.slots.find(slot => slot.index === selected);
  const save = () => run(async () => {
    if (!accepted || !chosen?.available) return;
    const key = `fieldproof:consent:${snapshot.id}:${selected}`;
    let intentId = localStorage.getItem(key);
    if (!intentId) { intentId = crypto.randomUUID(); localStorage.setItem(key, intentId); }
    const consent = await request<ConsentView>("commitments", { slotIndex: selected, expectedVersion: version, intentId, accepted: true, policyVersion: 1 });
    const connected = await request<ConsentView>("commitments/wallet", { consentId: consent.id });
    await load(); await onRefresh(); setAccepted(false);
    if (connected.approvalUrl) window.location.assign(connected.approvalUrl);
    else setMessage("Your commitment is saved. The wallet's current status is shown below; no contribution has been charged.");
  });
  const check = (consent: ConsentView) => run(async () => {
    const next = await request<ConsentView>(consent.status === "awaiting_wallet" || (consent.status === "unavailable" && consent.lastCode === "INVALID_REQUEST") ? "commitments/wallet" : "commitments/check", { consentId: consent.id });
    await load(); await onRefresh();
    if (next.approvalUrl) window.location.assign(next.approvalUrl);
  });
  const withdraw = (consent: ConsentView) => run(async () => {
    await request<ConsentView>("commitments/withdraw", { consentId: consent.id });
    localStorage.removeItem(`fieldproof:consent:${snapshot.id}:${consent.slotIndex}`);
    await load(); await onRefresh();
    setMessage("Your commitment was withdrawn. Fieldproof no longer has authority to collect it.");
  });

  return <div className="commitment-page">
    <header className="commitment-heading"><div><p className="eyebrow">A PROMISE WITH A CLEAR PURPOSE</p><h1>A little spark.<br /><span>A shared beginning.</span></h1><p>Back the electronics benches. Connect your PayPal wallet now, and contribute only when the whole package is ready to collect.</p></div><div className="commitment-drawing" aria-hidden="true"><Zap size={66} strokeWidth={1.1} /><i /><span>ONE PIECE OF<br />SOMETHING BIGGER.</span></div></header>
    <div className="commitment-status" aria-live="polite">{error && <p className="inline-error" role="alert">{error}</p>}{message && <div className="soft-note"><ShieldCheck size={20} /><p>{message}</p></div>}</div>
    {!live ? <section className="paper-panel commitment-entry"><span className="provenance live">Live PayPal sandbox</span><h2>A real approval. Test funds only.</h2><p>Start your private sandbox workspace to record an exact conditional commitment and approve saving your own sandbox PayPal wallet. Saving it does not charge it.</p><button className="button primary" disabled={busy} onClick={() => void run(onStart)}>{busy ? "Opening your workspace…" : "Open my sandbox workspace"}<ArrowUpRight size={18} /></button><Link href="/" className="text-button">Explore the sample project<ArrowRight size={16} /></Link></section> : <div className="commitment-columns">
      <section className="paper-panel commitment-form" aria-busy={loading || busy}>
        <div className="commitment-package"><span className="commitment-package-icon"><Zap size={26} /></span><div><p className="eyebrow">ELECTRONICS BENCHES / PLAN V{version}</p><h2>Six places for a first idea.</h2></div><span className="provenance live">Test funds</span></div>
        <div className="commitment-progress"><div><strong>{formatMoney(overview?.eligibleMinor ?? 0, true)}</strong><span>of $960 in eligible commitments</span></div><div className="progress-track"><span className="pledged-track" style={{ width: `${Math.min(100, (overview?.eligibleMinor ?? 0) / 96000 * 100)}%` }} /></div><p>Approved wallets are commitments. Collected payments appear separately in the receipt ledger.</p></div>
        {loading ? <p className="empty-inline">Loading your current commitments…</p> : <form onSubmit={event => { event.preventDefault(); void save(); }}>
          <fieldset className="commitment-amounts"><legend>Choose your piece of the $960 plan</legend><div>{overview?.slots.map(slot => <label key={slot.index} className={`${selected === slot.index ? "selected" : ""} ${!slot.available ? "unavailable" : ""}`}><input type="radio" name="contribution-slot" value={slot.index} checked={selected === slot.index} disabled={!slot.available || busy || !donor} onChange={() => { setSelected(slot.index); setAccepted(false); }} /><strong>{formatMoney(slot.amountMinor, true)}</strong><span>{slot.available ? `Contribution ${slot.index + 1}` : "Already committed"}</span>{selected === slot.index && slot.available && <Check size={16} />}</label>)}</div></fieldset>
          <div className="consent-box"><ShieldCheck size={25} /><div><strong>You're charged only if Electronics Benches reaches $960 in pledges by 31 December.</strong><p>If one payment fails, we have 48 hours to collect it. If we can't, your payment is refunded.</p></div></div>
          <details className="commitment-details"><summary>Read the full collection policy<ChevronDown size={16} /></summary><p>Your exact {formatMoney(chosen?.amountMinor ?? 3500)} commitment applies to Electronics Benches, plan version {version}, through 31 December 2026 (UTC). It does not authorize unrelated purchases.</p><p>Each contribution is a separate payment. The 48-hour window begins when the organizer freezes the complete collection round. An uncertain payment is checked before a recovery invoice can open for the same obligation. Incomplete collection cannot be spent.</p><p>You can withdraw before collection starts. Any extension or changed plan needs renewed consent. Fieldproof saves provider references privately; PayPal handles your password and funding source.</p></details>
          <label className="checkbox-label"><input type="checkbox" checked={accepted} disabled={!donor || busy || !chosen?.available} onChange={event => setAccepted(event.target.checked)} required /><span>I approve saving my sandbox PayPal wallet and this exact <strong>{formatMoney(chosen?.amountMinor ?? 3500)}</strong> conditional contribution under the policy above.</span></label>
          <button className="button primary full" disabled={busy || !accepted || !chosen?.available || !donor}>{busy ? "Saving your exact commitment…" : "Approve wallet with PayPal"}<ArrowUpRight size={18} /></button>
          {!donor && <p className="inline-error">Choose your donor view to manage your own commitment.</p>}
          <p className="fine-print"><LockKeyhole size={13} />No contribution is charged when you save the wallet.</p>
        </form>}
      </section>
      <aside className="commitment-aside"><section className="commitment-note"><span className="eyebrow">GOOD INTENTIONS, CLEAR CONDITIONS.</span><h2>Know what<br />happens next.</h2><ol><li><span>01</span><div><strong>Make your promise.</strong><p>Choose an exact amount and review the package and deadline.</p></div></li><li><span>02</span><div><strong>Approve your wallet.</strong><p>PayPal records your approval. No contribution moves yet.</p></div></li><li><span>03</span><div><strong>Reach the full target.</strong><p>A frozen collection round starts the shared 48-hour clock.</p></div></li><li><span>04</span><div><strong>Follow every payment.</strong><p>Confirmed payments, recovery and refunds stay linked to your original commitment.</p></div></li></ol><div className="commitment-note-foot"><Heart size={19} /><p>A completed collection is still separate from proof of completed work.</p></div></section><Link href="/collection" className="text-button">Open the collection record<ArrowRight size={17} /></Link><Link href="/my-contribution" className="text-button">Follow my receipt trail<ArrowRight size={17} /></Link><Link href="/sandbox" className="text-button">Try the separate $1 checkout<ArrowUpRight size={17} /></Link></aside>
    </div>}
    {!!overview?.commitments.length && <section className="commitment-list" aria-labelledby="saved-commitments"><div className="panel-heading"><div><p className="eyebrow">YOUR RECORD, THROUGH EVERY STEP</p><h2 id="saved-commitments">The promises you've made.</h2></div><button className="text-button" disabled={busy} onClick={() => void run(async () => { await load(); })}><RefreshCw size={15} />Refresh</button></div>{overview.commitments.map(consent => <article key={consent.id} className={`saved-commitment ${consent.status === "withdrawn" ? "withdrawn" : ""}`}><div className="saved-commitment-symbol">{consent.status === "ready" ? <CheckCheck size={25} /> : consent.status === "withdrawn" ? <Heart size={25} /> : <Wallet size={25} />}</div><div className="saved-commitment-main"><span className="eyebrow">ELECTRONICS BENCHES / CONTRIBUTION {consent.slotIndex + 1}</span><h3>{formatMoney(consent.amountMinor)} <span>{labels[consent.status]}</span></h3><p>{consent.walletLabel ?? "No confirmed wallet yet"} · Consent v{consent.version} · Plan v{consent.packageVersion}</p>{consent.lastCode && <p className="commitment-provider-note">{consent.lastCode === "BUYER_APPROVAL_PENDING" ? "PayPal approval is still pending. Continue the same approval or check it after returning." : consent.status === "unavailable" ? `PayPal returned ${consent.lastCode}. No contribution was charged; the saved operation will not be repeated automatically.` : `Status check: ${consent.lastCode}. An uncertain outcome does not count as a saved wallet or a payment.`}</p>}<small><Clock3 size={12} />{consent.status === "withdrawn" ? "Collection authority revoked" : "Valid through 31 December 2026 · fixed 48-hour collection policy"}</small></div><div className="saved-commitment-actions">{consent.approvalUrl && donor && <a className="button secondary small" href={consent.approvalUrl}>Continue PayPal approval<ArrowUpRight size={15} /></a>}{!["withdrawn", "collecting", "collected", "refunding", "refunded", "cancelled"].includes(consent.status) && donor && <button className="text-button" disabled={busy} onClick={() => void check(consent)}><RefreshCw size={14} />{consent.status === "unavailable" && consent.lastCode === "INVALID_REQUEST" ? "Continue wallet setup" : "Check wallet status"}</button>}{consent.canWithdraw && donor && <button className="text-button withdraw-button" disabled={busy} onClick={() => void withdraw(consent)}>Withdraw commitment</button>}</div></article>)}</section>}
  </div>;
}
