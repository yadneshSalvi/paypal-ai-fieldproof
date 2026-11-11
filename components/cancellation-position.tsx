"use client";
import { useEffect, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import type { CancellationReview } from "@/lib/server/cancellation-review";
import { workspaceFetch } from "@/lib/community/workspace-fetch";
import { formatMoney } from "@/lib/domain/money";

export function CancellationPosition({ roundId, projectId, onReviewed }: {
  roundId: string; projectId: string; onReviewed: (review: CancellationReview | null) => void;
}) {
  const [review, setReview] = useState<CancellationReview | null>(null), [error, setError] = useState<string | null>(null), [generation, setGeneration] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setReview(null); setError(null); onReviewed(null);
    void workspaceFetch(`/api/cancellations/review?roundId=${encodeURIComponent(roundId)}`, { signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "The contribution position could not be read.");
      if (active) { setReview(body); onReviewed(body); }
    }).catch(issue => { if (active) setError(issue instanceof Error ? issue.message : "Refresh this contribution review."); });
    return () => { active = false; controller.abort(); };
  }, [roundId, projectId, generation, onReviewed]);
  return <section className="cancellation-position" aria-label="Contribution position before cancellation">
    <div className="cancellation-position-heading"><div><p className="eyebrow">BEFORE ANY MONEY MOVES</p><h3>What can still be returned?</h3></div><ShieldCheck size={24}/></div>
    {error ? <p role="alert">{error}</p> : !review ? <p role="status">Reading the saved contributions and their committed uses…</p> : <>
      <div className="cancellation-position-totals">
        <div><span>Original contributions</span><strong>{formatMoney(review.creditedMinor)}</strong></div>
        <div><span>Paid expenses and fees</span><strong>{formatMoney(review.paidMinor)}</strong></div>
        <div><span>Reserved for expenses</span><strong>{formatMoney(review.reservedMinor)}</strong></div>
        <div><span>Not yet committed</span><strong>{formatMoney(review.uncommittedMinor)}</strong></div>
      </div>
      {review.hasCommittedUses ? <p className="cancellation-position-notice" role="status">This package has committed money. The full-return option is unavailable. A separate plan for the remaining funds and each donor’s choices is still required; no expense allocation or original payment will be rewritten here.</p> : <p>These saved receipts have no committed expense uses. Cancellation still checks the current records, closes unpaid recovery paths and confirms each original-route refund with PayPal.</p>}
      {review.limitation === "package_changed" && <p role="status">The package changed after this round. Review the original consent and current package before any cancellation.</p>}
      {review.unqualifiedRouteCount > 0 && <p role="status">{review.unqualifiedRouteCount} payment {review.unqualifiedRouteCount === 1 ? "route still needs" : "routes still need"} a proven refund mechanism. Cancellation cannot be described as complete while a return remains unresolved.</p>}
      <details><summary>{review.sources.length} original payment records</summary><div className="table-scroll" tabIndex={0} role="region" aria-label="Cancellation source amounts"><table><thead><tr><th>Payment source</th><th>Credited</th><th>Returned</th><th>Return pending</th><th>Committed</th><th>Uncommitted</th></tr></thead><tbody>{review.sources.map((source, index) => <tr key={source.receiptId}><th>{source.sourceKind === "orders_capture" ? "Orders payment" : "Invoice payment"} {index + 1}<small>Saved version {source.receiptVersion}</small></th><td>{formatMoney(source.creditedMinor)}</td><td>{formatMoney(source.refundedMinor)}</td><td>{formatMoney(source.pendingRefundMinor)}</td><td>{formatMoney(source.paidMinor + source.reservedMinor)}</td><td>{formatMoney(source.uncommittedMinor)}</td></tr>)}</tbody></table></div></details>
      <p className="fine-print">Read {new Date(review.observedAt).toLocaleString()}. Uncommitted money may include {formatMoney(review.excludedMinor)} excluded from spending. This is the saved application position, not a fresh provider refund quote.</p>
    </>}
    <button className="text-button" type="button" onClick={() => setGeneration(value => value + 1)}><RefreshCw size={14}/>Refresh contribution position</button>
  </section>;
}
