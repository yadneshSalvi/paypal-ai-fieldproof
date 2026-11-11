"use client";
import { workspaceFetch } from "@/lib/community/workspace-fetch";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, CircleAlert, Clock3, FileCheck2, LockKeyhole, RefreshCw, Send, ShieldCheck, Undo2, Wallet, X } from "lucide-react";
import type { ClaimView } from "@/lib/domain/claims";
import type { ClaimPaymentView, PayableView, PayoutReviewView } from "@/lib/domain/payouts";
import { formatMoney } from "@/lib/domain/money";

const labels: Record<PayableView["state"], string> = {
  reserved: "Approved · ready for balance check", submitting: "Sending the original request", cancelling: "Checking the cancellation",
  unknown: "Outcome needs checking", refused: "PayPal did not accept this request", not_sent: "Request was not sent",
  pending: "With PayPal", unclaimed: "Recipient action needed", held: "Held by PayPal", blocked: "Blocked by PayPal",
  succeeded: "PayPal confirmed repayment", returned: "Principal returned", failed: "Repayment was not delivered", cancelled: "Unused approval released", review_required: "Needs reconciliation",
};
const explanations: Record<string, string> = {
  BALANCE_PROVIDER_STALE: "The provider's balance snapshot is older than the three-hour reporting bound. A new fetch cannot make that snapshot current.",
  BALANCE_ALLOWANCE_UNAVAILABLE: "The provider balance cannot cover this repayment and other known reservations yet.",
  PAYOUT_ORIGINAL_BATCH_UNRESOLVED: "The first request has no confirmed batch reference yet. An organizer may deliberately retry its identical request within 30 days.",
  PAYOUT_DUPLICATE_WINDOW_EXPIRED: "The original request is beyond PayPal's 30-day duplicate window. Its funds stay reserved for reconciliation.",
  PAYOUT_FEE_UNPROVEN: "The recipient payment is confirmed. The fee allowance stays reserved until the actual item fee is established.",
  PAYOUT_FEE_EXCEEDS_ALLOWANCE: "The recipient payment is confirmed. The actual fee exceeded the allowance and has a separate accounting exception.",
  PAYOUT_RETURN_FEE_UNPROVEN: "The principal is available again. The original fee allowance remains reserved until its outcome is established.",
  PAYOUT_APPROVAL_EXPIRED: "The separate approval expired or was revoked. Review the same original repayment before another write.",
  PAYOUT_REVIEW_CHANGED: "A source, recipient or approval context changed. The original request stays intact for a fresh review.",
};
async function request<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await workspaceFetch(url, body === undefined ? { cache: "no-store", signal } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "This repayment could not be updated. Check its original status.");
  return value;
}

export function RepaymentPanel({ claim, organizer, onChanged }: { claim: ClaimView; organizer: boolean; onChanged: () => Promise<void> }) {
  const [view, setView] = useState<ClaimPaymentView | null>(null), [selected, setSelected] = useState<string[]>([]), [review, setReview] = useState<PayoutReviewView | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [checked, setChecked] = useState(false), [feeChecked, setFeeChecked] = useState(false), [sampleChecked, setSampleChecked] = useState(false);
  const intent = useRef<string | null>(null);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const value = await request<ClaimPaymentView>(`/api/claims/${claim.id}/payments`, undefined, signal);
    setView(value); return value;
  }, [claim.id]);
  useEffect(() => {
    const controller = new AbortController(); setError(null); setReview(null); setSelected([]);
    refresh(controller.signal).then(value => setSelected(value.lines.filter(line => line.availableMinor > 0 && line.fundingReady).map(line => line.id)))
      .catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [refresh, claim.version, organizer]);
  const working = view?.payables.some(payable => ["submitting", "cancelling", "pending"].includes(payable.state));
  useEffect(() => {
    if (!working) return;
    const controller = new AbortController(), timer = setInterval(() => { void refresh(controller.signal).catch(() => undefined); }, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [working, refresh]);
  async function act(work: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await work(); await refresh(); await onChanged(); }
    catch (error) { setError(error instanceof Error ? error.message : "The original repayment needs a check."); await refresh().catch(() => undefined); }
    finally { setBusy(false); }
  }
  async function prepare(payable?: PayableView) {
    const response = await request<{ review: PayoutReviewView }>(`/api/claims/${claim.id}/payment-review`, { expectedVersion: claim.version, lineIds: payable?.lineIds ?? selected, ...(payable ? { payableId: payable.id } : {}) });
    setReview(response.review); setChecked(false); setFeeChecked(false); setSampleChecked(false); intent.current = crypto.randomUUID();
  }
  async function approve() {
    if (!review) return;
    intent.current ??= crypto.randomUUID();
    await request(`/api/claims/${claim.id}/payment-approval`, { reviewId: review.id, reviewDigest: review.digest, intentId: intent.current,
      amountMinor: review.amountMinor, currency: review.currency, recipientAndAmountChecked: checked, feeAllowanceAcknowledged: feeChecked, sampleAcknowledged: sampleChecked });
    setReview(null); intent.current = null;
  }
  const selectedAmount = view?.lines.filter(line => selected.includes(line.id)).reduce((sum, line) => sum + line.availableMinor, 0) ?? 0;
  const paid = view?.lines.reduce((sum, line) => sum + line.paidMinor, 0) ?? 0;
  if (!claim.review) return null;
  return <section className="repayment-panel" aria-labelledby="repayment-heading">
    <header className="repayment-heading"><div><p className="eyebrow">THE REVIEW IS ONLY THE BEGINNING</p><h2 id="repayment-heading">Make the volunteer whole.</h2><p>Every repayment follows the reviewed lines to the account its owner verified.</p></div><div className="repayment-counter"><small>Confirmed to recipient</small><strong>{formatMoney(paid)}</strong><span>of {formatMoney(claim.approvedMinor)} reviewed</span></div></header>
    {error && <div className="expense-alert" role="alert"><CircleAlert size={19}/><p>{error}</p></div>}
    {!view ? <p className="expense-loading" role="status">Loading the original repayment records…</p> : <>
      <div className={`repayment-recipient ${view.recipient?.usable ? "verified" : ""}`}><ShieldCheck size={25}/><div><strong>{view.recipient?.label ?? "The claimant's PayPal account is not linked yet"}</strong><span>{view.recipient ? `Ownership verified ${new Date(view.recipient.verifiedAt).toLocaleString()} · version ${view.recipient.version}` : "Choose the Volunteer view to connect the account through PayPal."}</span>{view.recipient && !view.recipient.usable && <span>A fresh account connection is needed before repayment.</span>}</div><span className="status-pill">{view.recipient?.usable ? "PayPal verified" : "Connection needed"}</span></div>
      {organizer && <div className="repayment-selection"><div><h3>Which reviewed lines are ready?</h3><p>Each package must have its full eligible collection. Other payments and refund reservations reduce what can be used.</p></div><div className="repayment-lines">{view.lines.filter(line => line.approvedMinor > 0).map(line => {
        const source = claim.lines.find(source => source.id === line.id)!;
        return <label className={`repayment-line ${line.fundingReady && line.availableMinor > 0 ? "" : "waiting"}`} key={line.id}><input type="checkbox" checked={selected.includes(line.id)} disabled={busy || line.availableMinor <= 0 || !line.fundingReady} onChange={event => setSelected(previous => event.target.checked ? [...previous, line.id] : previous.filter(id => id !== line.id))}/><span><strong>{source.description}</strong><small>{line.paidMinor > 0 ? "PayPal confirmed this line" : line.reservedMinor > 0 ? "Reserved in an original repayment below" : !line.fundingReady ? "Waiting for the package's complete collection" : "Reviewed · funding available for exact preflight"}</small></span><b>{formatMoney(line.approvedMinor)}</b></label>;
      })}</div><button className="button primary" disabled={busy || !selected.length || !view.recipient?.usable} onClick={() => void act(() => prepare())}>Review {formatMoney(selectedAmount)} repayment<ArrowRight size={17}/></button><small>Reviewing this payment does not send it.</small></div>}
      {review && <article className="repayment-cheque" aria-label="Exact repayment approval"><header><span className="eyebrow">{review.payableId ? "REVIEW THE SAME ORIGINAL REPAYMENT" : "SEPARATE PAYMENT REVIEW"}</span><button className="icon-button" aria-label="Close payment review" disabled={busy} onClick={() => setReview(null)}><X size={19}/></button></header><div className="cheque-top"><div className="cheque-payee"><small>PAY TO THE VERIFIED ACCOUNT OF</small><strong>{review.recipient.label}</strong><span>{review.title} · claim version {review.claimVersion}</span></div><div className="cheque-amount"><span>USD</span><strong>{formatMoney(review.amountMinor)}</strong></div></div><div className="cheque-body"><img src={claim.document.pages[0]?.previewUrl} alt="Private source receipt for this reviewed expense"/><div>{review.lines.map(line => <div className="cheque-line" key={line.id}><span>{line.description}<small>{line.packageTitle}</small></span><b>{formatMoney(line.amountMinor)}</b></div>)}</div></div><div className="cheque-funding"><Wallet size={20}/><div><strong>{formatMoney(review.feeAllowanceMinor)} reserved separately for provider fees</strong><p>This is an internal allowance, not a PayPal fee quote. The actual item fee is recorded after confirmation; unused allowance is released.</p>{review.funding.map(fund => <small key={fund.packageId}>{fund.packageTitle}: {formatMoney(fund.amountMinor)} expense + {formatMoney(fund.feeAllowanceMinor)} allowance from {fund.receiptCount} original contribution {fund.receiptCount === 1 ? "receipt" : "receipts"}.</small>)}</div></div><div className="cheque-checks"><label className="expense-check"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)}/><span>I checked the selected lines, exact USD amount and this verified recipient.</span></label><label className="expense-check"><input type="checkbox" checked={feeChecked} onChange={event => setFeeChecked(event.target.checked)}/><span>I approve the separate fee allowance from these same package funds.</span></label>{review.sourceClass === "sample_document" && <label className="expense-check"><input type="checkbox" checked={sampleChecked} onChange={event => setSampleChecked(event.target.checked)}/><span>This source is fictional. This is an actual sandbox payment test, with no merchant purchase claimed.</span></label>}</div><footer><div><small>Approval expires {new Date(review.expiresAt).toLocaleTimeString()}</small><code title={review.digest}>{review.digest.slice(0, 24)}</code></div><button className="button primary" disabled={busy || !checked || !feeChecked || review.sourceClass === "sample_document" && !sampleChecked} onClick={() => void act(approve)}><FileCheck2 size={17}/>{review.payableId ? "Renew this exact approval" : "Approve this exact repayment"}</button></footer></article>}
      <div className="payable-history">{view.payables.map(payable => <article className={`payable-record ${payable.state === "succeeded" ? "confirmed" : ""}`} key={payable.id}><header><div className="payable-state-icon">{payable.state === "succeeded" ? <Check size={25}/> : payable.state === "returned" ? <Undo2 size={24}/> : <Clock3 size={24}/>}</div><div><p className="eyebrow">{labels[payable.state]}</p><h3>{formatMoney(payable.amountMinor)} to {payable.recipientLabel}</h3><p>{payable.state === "succeeded" ? "The exact provider item confirms recipient payment." : payable.state === "reserved" ? "Your reviewed sources are reserved. Sending first checks current authority and provider liquidity." : payable.state === "returned" ? "The original principal has returned; another payment requires a new review." : "A request or an accepted batch is not proof that the volunteer was repaid."}</p></div></header>{payable.code && <p className="payable-explanation"><CircleAlert size={16}/>{explanations[payable.code] ?? payable.code.replaceAll("_", " ").toLowerCase()}</p>}<div className="payable-facts"><div><span>Item status</span><strong>{payable.providerStatus ?? "No confirmed item yet"}</strong></div><div><span>Provider fee</span><strong>{payable.actualFeeMinor === null ? `${formatMoney(payable.feeAllowanceMinor)} allowance · ${payable.feeState.replaceAll("_", " ")}` : `${formatMoney(payable.actualFeeMinor)} · ${payable.feeState.replaceAll("_", " ")}`}</strong></div><div><span>Current approval</span><strong>{new Date(payable.approvalExpiresAt).getTime() > Date.now() ? `Until ${new Date(payable.approvalExpiresAt).toLocaleTimeString()}` : "Needs a fresh review"}</strong></div></div>{payable.balance && <details className="payable-balance"><summary><Clock3 size={14}/>Balance observation clocks</summary><p>Fetched {new Date(payable.balance.observedAt).toLocaleString()}.</p><p>Provider as of: {payable.balance.asOfTime ? new Date(payable.balance.asOfTime).toLocaleString() : "Unavailable"}. Last refresh: {payable.balance.lastRefreshTime ? new Date(payable.balance.lastRefreshTime).toLocaleString() : "Unavailable"}.</p><small>The fetch must be within 60 seconds before dispatch. Both provider clocks must be within three hours. Reporting does not reserve funds.</small></details>}<div className="payable-actions">{payable.canSend && <button className="button primary" disabled={busy} onClick={() => void act(async () => { await request(`/api/payouts/${payable.id}/send`, { acknowledged: true }); })}><Send size={16}/>Send exactly {formatMoney(payable.amountMinor)}</button>}{payable.canCheck && <button className="button secondary" disabled={busy} onClick={() => void act(async () => { await request(`/api/payouts/${payable.id}/check`, {}); })}><RefreshCw size={16}/>Check original status</button>}{payable.canRetryOriginal && <button className="button secondary" disabled={busy} onClick={() => void act(async () => { await request(`/api/payouts/${payable.id}/retry-original`, { acknowledged: true }); })}>Retry identical original request</button>}{organizer && payable.requiresNewApproval && <button className="button secondary" disabled={busy} onClick={() => void act(() => prepare(payable))}>Review original approval</button>}{payable.canCancelUnclaimed && <button className="button secondary" disabled={busy} onClick={() => void act(async () => { await request(`/api/payouts/${payable.id}/cancel-unclaimed`, { acknowledged: true }); })}><Undo2 size={16}/>Cancel this unclaimed item</button>}{payable.canRelease && <button className="text-button" disabled={busy} onClick={() => void act(async () => { await request(`/api/payouts/${payable.id}/release`, { acknowledged: true }); })}>Release unused approval</button>}</div><details className="payable-reference"><summary><LockKeyhole size={13}/>Private payment references</summary><dl><div><dt>Original repayment</dt><dd>{payable.id}</dd></div><div><dt>Provider item</dt><dd>{payable.providerItemReference ?? "Not established"}</dd></div><div><dt>Approval digest</dt><dd>{payable.approvalDigest}</dd></div><div><dt>Latest confirmed read</dt><dd>{payable.observedAt ? new Date(payable.observedAt).toLocaleString() : "None"}</dd></div></dl></details></article>)}</div>
      {!organizer && !view.payables.length && <div className="soft-note"><Clock3 size={22}/><p>Your source review is saved. The organizer still needs fully collected package funding, your current PayPal connection and a separate exact payment approval.</p></div>}
    </>}
  </section>;
}
