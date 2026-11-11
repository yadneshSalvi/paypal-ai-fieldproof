"use client";
import { workspaceFetch } from "@/lib/community/workspace-fetch";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleHelp,
  Clock3,
  FileText,
  HeartHandshake,
  LockKeyhole,
  QrCode,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import QRCode from "qrcode";
import type { ProjectSnapshot } from "@/lib/contracts";
import type { CollectionReview } from "@/lib/server/collections";
import type { RecoveryInvoiceView } from "@/lib/server/recovery-invoices";
import type { RefundView } from "@/lib/domain/refunds";
import { formatMoney } from "@/lib/domain/money";
import { CancellationPosition } from "./cancellation-position";
import type { CancellationReview } from "@/lib/server/cancellation-review";

interface Overview extends CollectionReview {
  invoices: RecoveryInvoiceView[];
  refunds: RefundView[];
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await workspaceFetch(
    `/api/${path}`,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error ??
        "The saved record could not be checked. Refresh before continuing.",
    );
  return result;
}
const statuses: Record<string, string> = {
  ready: "Wallet approved",
  uncommitted: "Awaiting a commitment",
  awaiting_wallet: "Wallet not connected",
  wallet_pending: "PayPal approval pending",
  waiting: "Ready for collection",
  collecting: "Collection started",
  dispatching: "Confirming with PayPal",
  unknown: "Checking the original payment",
  collected: "Payment confirmed",
  declined: "Payment declined",
  definitively_declined: "Payment declined",
  review_required: "Needs a review",
  buyer_action: "PayPal approval needed",
  awaiting_payment: "Awaiting provider confirmation",
  recovery_invoice_open: "Recovery invoice open",
  excess_reconciliation: "Extra payment being returned",
  compensating: "Original refund due",
  refund_pending: "Refund pending",
  refund_review: "Refund needs a review",
  refunding: "Refund pending",
  refunded: "Refund confirmed",
  cancelled: "Closed without collection",
  unavailable: "Wallet unavailable",
};
function date(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
function InvoiceQr({ url }: { url: string }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(url, {
      width: 224,
      margin: 2,
      color: { dark: "#1e3a5f", light: "#fffdf8" },
    }).then((value) => {
      if (active) setImage(value);
    });
    return () => {
      active = false;
    };
  }, [url]);
  return (
    <div className="recovery-qr">
      {image ? (
        <img
          src={image}
          alt="QR code opening this original PayPal sandbox recovery invoice"
          width={168}
          height={168}
        />
      ) : (
        <QrCode size={70} />
      )}
      <span>Scan to open your PayPal invoice</span>
    </div>
  );
}

export function ConditionalCollection({
  snapshot,
  onRefresh,
}: {
  snapshot: ProjectSnapshot;
  onRefresh: () => Promise<void>;
}) {
  const [overview, setOverview] = useState<Overview | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [accepted, setAccepted] = useState(false);
  const [cancelReview, setCancelReview] = useState(false),
    [cancelAccepted, setCancelAccepted] = useState(false),
    [recoveryReview, setRecoveryReview] = useState<string | null>(null);
  const [cancellationPosition, setCancellationPosition] = useState<CancellationReview | null>(null);
  const handleCancellationReview = useCallback((value: CancellationReview | null) => {
    setCancellationPosition(value);
    setCancelAccepted(false);
  }, []);
  const live = snapshot.mode === "live_sandbox" && !!snapshot.session,
    role = snapshot.session?.role,
    organizer = role === "organizer";
  const round = overview?.round,
    active =
      round &&
      ["collecting", "recovering"].includes(round.state) &&
      Date.parse(round.recoveryEndsAt) > Date.now();
  const load = useCallback(async () => {
    const value = await request<Overview>("collection");
    setOverview(value);
    return value;
  }, []);
  useEffect(() => {
    if (!live) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    void request<Overview>("collection")
      .then((value) => {
        if (alive) setOverview(value);
      })
      .catch((issue) => {
        if (alive) setError(issue.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [live, snapshot.id, role]);
  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await work();
      await load();
      await onRefresh();
    } catch (issue) {
      setError(
        issue instanceof Error
          ? issue.message
          : "This action could not finish. Check the original record before continuing.",
      );
    } finally {
      setBusy(null);
    }
  };
  const start = () =>
    run("start", async () => {
      const key = `fieldproof:collection:${snapshot.id}:electronics`;
      let intentId = localStorage.getItem(key);
      if (!intentId) {
        intentId = crypto.randomUUID();
        localStorage.setItem(key, intentId);
      }
      await request("collection/start", {
        expectedVersion: overview!.packageVersion,
        intentId,
        acknowledged: true,
        automatic: false,
      });
      setAccepted(false);
      setNotice(
        "The exact round is saved. Its 48-hour clock has started. Review and collect each original contribution below.",
      );
    });
  const act = (path: string, body: unknown, message?: string) =>
    run(path, async () => {
      await request(path, body);
      if (message) setNotice(message);
    });
  if (!live)
    return (
      <section className="paper-panel collection-entry">
        <HeartHandshake size={38} strokeWidth={1.3} />
        <p className="eyebrow">FROM A PROMISE TO A PAYMENT</p>
        <h1>
          A complete round,
          <br />
          with a clear record.
        </h1>
        <p>
          Collection begins with eight exact, separately approved commitments.
          Open your sandbox commitment workspace to take part, or follow the
          labelled sample story.
        </p>
        <Link className="button primary" href="/commitment">
          Open conditional commitments
          <ArrowUpRight size={17} />
        </Link>
        <Link className="text-button" href="/progress">
          Explore the sample collection
          <ArrowRight size={16} />
        </Link>
      </section>
    );
  return (
    <div className="round-page">
      <header className="round-heading">
        <div>
          <p className="eyebrow">ELECTRONICS BENCHES / THE COLLECTION RECORD</p>
          <h1>
            Every promise.
            <br />
            <span>One clear record.</span>
          </h1>
          <p>
            Eight contributions, one $960 purpose. Follow each payment from its
            original consent through confirmation, recovery, or refund.
          </p>
        </div>
        <div className="round-seal" aria-hidden="true">
          <HeartHandshake size={41} strokeWidth={1.2} />
          <span>
            GOOD INTENTIONS.
            <br />
            ACCOUNTED FOR.
          </span>
        </div>
      </header>
      <div aria-live="polite" className="round-messages">
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {notice && (
          <div className="soft-note">
            <ShieldCheck size={20} />
            <p>{notice}</p>
          </div>
        )}
      </div>
      {loading ? (
        <div className="paper-panel empty-message" aria-busy="true">
          <Clock3 size={26} />
          <p>Reading the saved contribution and receipt records…</p>
        </div>
      ) : (
        overview && (
          <>
            <div className="round-provenance">
              <span className="provenance live">Live · PayPal sandbox</span>
              <span>
                {
                  overview.slots.filter((slot) => slot.state !== "uncommitted")
                    .length
                }{" "}
                contribution slots · {overview.participantCount} participant
                account{overview.participantCount === 1 ? "" : "s"}
              </span>
              <button
                className="text-button"
                disabled={!!busy}
                onClick={() => void run("refresh", async () => {})}
              >
                <RefreshCw size={14} />
                Refresh record
              </button>
            </div>
            {overview.participantCount === 1 && (
              <p className="round-qualification-note">
                This controlled qualification uses one participant account for
                separately approved contribution slots. It does not represent
                eight independently recruited donors.
              </p>
            )}
            <div className="round-top-grid">
              <section className="round-total">
                <p className="eyebrow">
                  {round ? "CONFIRMED COLLECTION" : "ELIGIBLE COMMITMENTS"}
                </p>
                <div className="round-amount">
                  {formatMoney(
                    round?.collectedMinor ?? overview.eligibleCommitmentsMinor,
                    true,
                  )}
                  <span>/ $960</span>
                </div>
                <div
                  className="round-bar"
                  role="progressbar"
                  aria-label={
                    round ? "Confirmed collection" : "Eligible commitments"
                  }
                  aria-valuenow={
                    round?.collectedMinor ?? overview.eligibleCommitmentsMinor
                  }
                  aria-valuemin={0}
                  aria-valuemax={96000}
                >
                  <span
                    style={{
                      width: `${Math.min(100, ((round?.collectedMinor ?? overview.eligibleCommitmentsMinor) / 96000) * 100)}%`,
                    }}
                  />
                </div>
                <p>
                  {round
                    ? `${formatMoney(round.eligibleMinor)} remains eligible under the collection policy.`
                    : "Wallet approval is permission to collect under the exact policy. No money has moved into this round yet."}
                </p>
                {round && (
                  <div className="round-total-detail">
                    <span>
                      Shortfall{" "}
                      <strong>{formatMoney(round.shortfallMinor)}</strong>
                    </span>
                    <span>
                      Extra payment liability{" "}
                      <strong>{formatMoney(round.excessLiabilityMinor)}</strong>
                    </span>
                  </div>
                )}
                <small>
                  The separate $1 checkout is outside this package total.
                  Collection alone does not approve spending.
                </small>
              </section>
              <section className="round-clock">
                <Clock3 size={27} strokeWidth={1.4} />
                <p className="eyebrow">ONE FIXED COLLECTION WINDOW</p>
                <h2>
                  {(!round
                    ? ["48 hours.", "One shared promise."]
                    : round.state === "funded"
                      ? ["The full target", "is collected."]
                      : round.state === "cancelled"
                        ? ["Returned.", "Reconciled. Closed."]
                        : round.state === "compensating"
                          ? ["Collection stopped.", "Refunds in progress."]
                          : ["The clock", "belongs to this round."]
                  ).map((line, index) => <span key={line}>{index > 0 && <br />}{line}</span>)}
                </h2>
                {round ? (
                  <dl>
                    <div>
                      <dt>Started</dt>
                      <dd>{date(round.startedAt)}</dd>
                    </div>
                    <div>
                      <dt>Recovery ends</dt>
                      <dd>{date(round.recoveryEndsAt)}</dd>
                    </div>
                  </dl>
                ) : (
                  <p>
                    The deadline starts when the organizer freezes the exact
                    round. It never resets when a payment needs recovery.
                  </p>
                )}
                <div className="round-policy">
                  <ShieldCheck size={18} />
                  <p>
                    If the round cannot finish within 48 hours, received
                    payments are returned through their original payment routes.
                  </p>
                </div>
              </section>
            </div>
            {!round && (
              <section className="paper-panel round-review">
                <div>
                  <p className="eyebrow">REVIEW BEFORE THE CLOCK STARTS</p>
                  <h2>A complete set of promises.</h2>
                  <p>
                    Plan v{overview.packageVersion} · {overview.readyCount} of 8
                    wallets confirmed · consent through 31 December 2026.
                  </p>
                </div>
                <div className="round-slot-grid">
                  {overview.slots.map((slot) => (
                    <div
                      key={slot.index}
                      className={slot.state === "ready" ? "ready" : ""}
                    >
                      <span>0{slot.index + 1}</span>
                      <strong>{formatMoney(slot.amountMinor, true)}</strong>
                      <small>{statuses[slot.state] ?? "Needs a check"}</small>
                      {slot.state === "ready" && <Check size={15} />}
                    </div>
                  ))}
                </div>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={accepted}
                    disabled={!organizer || !!busy || overview.readyCount !== 8}
                    onChange={(event) => setAccepted(event.target.checked)}
                  />
                  <span>
                    I reviewed these eight exact commitments totaling{" "}
                    <strong>$960</strong>. Start the fixed 48-hour collection
                    round for Electronics Benches, plan v
                    {overview.packageVersion}. I will collect each original
                    contribution from this record.
                  </span>
                </label>
                <div className="round-review-actions">
                  <button
                    className="button primary"
                    disabled={
                      !organizer ||
                      !accepted ||
                      !!busy ||
                      overview.eligibleCommitmentsMinor !== 96000
                    }
                    onClick={() => void start()}
                  >
                    {busy === "start"
                      ? "Saving the exact round…"
                      : "Start the 48-hour round"}
                    <ArrowRight size={17} />
                  </button>
                  <Link href="/commitment" className="text-button">
                    Review my original consents
                    <ArrowUpRight size={15} />
                  </Link>
                </div>
                {!organizer && (
                  <p className="fine-print">
                    Choose the Organizer view above to review and start
                    collection.
                  </p>
                )}
              </section>
            )}
            {round && (
              <section
                className="round-ledger"
                aria-labelledby="round-contributions"
              >
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">
                      EACH ORIGINAL OBLIGATION, THROUGH EVERY STEP
                    </p>
                    <h2 id="round-contributions">The contribution ledger.</h2>
                  </div>
                  <button
                    className="text-button"
                    disabled={!!busy}
                    onClick={() =>
                      void act("collection/check", { roundId: round.id })
                    }
                  >
                    <RefreshCw size={15} />
                    Check provider records
                  </button>
                </div>
                <div className="round-rows">
                  {round.items.map((item) => {
                    const invoice = overview.invoices.find(
                      (record) => record.obligationId === item.obligationId,
                    );
                    return (
                      <article
                        className={`round-row ${["collected", "refunded"].includes(item.state) ? "confirmed" : ""}`}
                        key={item.consentId}
                      >
                        <span className="round-row-number">
                          0{item.slotIndex + 1}
                        </span>
                        <div className="round-row-main">
                          <strong>
                            {formatMoney(item.amountMinor)}
                            <span>
                              {statuses[item.state] ?? "Awaiting confirmation"}
                            </span>
                          </strong>
                          <p>
                            Original contribution {item.slotIndex + 1} ·{" "}
                            {item.own
                              ? "Your approved slot"
                              : "Project participant"}
                          </p>
                          {item.lastCode && (
                            <details className="round-source">
                              <summary>Provider observation</summary>
                              <code>{item.lastCode}</code>
                              <p>
                                An uncertain outcome stays separate from a
                                confirmed payment or definitive decline.
                              </p>
                            </details>
                          )}
                        </div>
                        <div className="round-row-confirmed">
                          <span>Confirmed</span>
                          <strong>{formatMoney(item.collectedMinor)}</strong>
                        </div>
                        <div className="round-row-actions">
                          {organizer &&
                            active &&
                            ![
                              "collected",
                              "declined",
                              "recovery_invoice_open",
                              "excess_reconciliation",
                              "refunded",
                              "cancelled",
                            ].includes(item.state) && (
                              <button
                                className="button secondary small"
                                disabled={!!busy}
                                onClick={() =>
                                  void act("collection/advance", {
                                    roundId: round.id,
                                    consentId: item.consentId,
                                  })
                                }
                              >
                                {item.state === "waiting"
                                  ? `Collect ${formatMoney(item.amountMinor, true)}`
                                  : "Continue original payment"}
                                <ArrowRight size={15} />
                              </button>
                            )}
                          {item.approvalUrl && item.own && (
                            <a
                              className="button primary small"
                              href={item.approvalUrl}
                            >
                              Open PayPal approval
                              <ArrowUpRight size={15} />
                            </a>
                          )}
                          {item.state === "declined" &&
                            active &&
                            !invoice &&
                            (organizer || (item.own && role === "donor")) && (
                              <button
                                className="button secondary small"
                                disabled={!!busy}
                                onClick={() =>
                                  setRecoveryReview(item.consentId)
                                }
                              >
                                Review recovery invoice
                                <FileText size={15} />
                              </button>
                            )}
                          {invoice && (
                            <a
                              className="text-button"
                              href={`#invoice-${invoice.id}`}
                            >
                              Open recovery record
                              <ArrowRight size={15} />
                            </a>
                          )}
                        </div>
                        {recoveryReview === item.consentId && (
                          <div className="round-inline-review">
                            <button
                              className="icon-button"
                              aria-label="Close invoice review"
                              onClick={() => setRecoveryReview(null)}
                            >
                              <X size={18} />
                            </button>
                            <h3>
                              The same {formatMoney(item.amountMinor)}{" "}
                              contribution.
                            </h3>
                            <p>
                              The original payment must be definitively
                              declined. This invoice keeps the same obligation,
                              approved participant, amount, and{" "}
                              {date(round.recoveryEndsAt)} deadline. It creates
                              a PayPal draft; sharing its link is a separate
                              action.
                            </p>
                            <button
                              className="button primary"
                              disabled={!!busy}
                              onClick={() =>
                                void run("recovery/create", async () => {
                                  await request("recovery/create", {
                                    consentId: item.consentId,
                                    expectedVersion: 1,
                                    acknowledged: true,
                                  });
                                  setRecoveryReview(null);
                                })
                              }
                            >
                              Create exact recovery draft
                              <ArrowRight size={16} />
                            </button>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
                <p className="round-ledger-note">
                  <LockKeyhole size={14} />
                  This round uses a separate review for each original
                  collection. Background checks reconcile saved requests; they
                  do not open another payment channel for an uncertain charge.
                </p>
              </section>
            )}
            {!!overview.invoices.length && (
              <section className="round-recoveries">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">
                      A SECOND PATH FOR THE SAME PROMISE
                    </p>
                    <h2>The recovery record.</h2>
                  </div>
                </div>
                {overview.invoices.map((invoice) => (
                  <article
                    className="paper-panel recovery-card"
                    id={`invoice-${invoice.id}`}
                    key={invoice.id}
                  >
                    <div>
                      <span className="provenance live">
                        PayPal sandbox invoice
                      </span>
                      <h3>
                        {formatMoney(invoice.amountMinor)} ·{" "}
                        {invoice.state === "paid"
                          ? "Payment confirmed"
                          : invoice.state === "draft"
                            ? "Draft ready to review"
                            : invoice.state === "cancelled"
                              ? "Invoice cancelled"
                              : invoice.state === "open"
                                ? "Ready for payment"
                                : "Payment evidence being checked"}
                      </h3>
                      <p>
                        {invoice.recipientLabel} · Original deadline:{" "}
                        {date(invoice.recoveryEndsAt)}
                      </p>
                      <p className="recovery-explanation">
                        A provider “paid” label is checked against the actual
                        transaction before it adds contribution credit.
                        Cancelling an invoice does not refund a settled payment.
                      </p>
                      <div className="round-review-actions">
                        {invoice.canShare && (
                          <button
                            className="button primary"
                            disabled={!!busy}
                            onClick={() =>
                              void act(
                                "recovery/share",
                                { invoiceId: invoice.id },
                                "The original PayPal share link is ready. No email notification was requested.",
                              )
                            }
                          >
                            Make the PayPal link available
                            <ArrowRight size={16} />
                          </button>
                        )}
                        {invoice.payerUrl && (
                          <a className="button primary" href={invoice.payerUrl}>
                            Pay the original invoice
                            <ArrowUpRight size={16} />
                          </a>
                        )}
                        <button
                          className="text-button"
                          disabled={!!busy}
                          onClick={() =>
                            void act("recovery/check", {
                              invoiceId: invoice.id,
                            })
                          }
                        >
                          <RefreshCw size={14} />
                          Check original invoice
                        </button>
                        {invoice.canCancel && (
                          <button
                            className="text-button"
                            disabled={!!busy}
                            onClick={() =>
                              void act("recovery/cancel", {
                                invoiceId: invoice.id,
                              })
                            }
                          >
                            Cancel unpaid invoice
                          </button>
                        )}
                      </div>
                      {invoice.lastCode && (
                        <p className="fine-print">
                          Current check: {invoice.lastCode}
                        </p>
                      )}
                    </div>
                    {invoice.payerUrl && <InvoiceQr url={invoice.payerUrl} />}
                  </article>
                ))}
              </section>
            )}
            {!!overview.refunds.length && (
              <section className="paper-panel round-refunds">
                <p className="eyebrow">
                  BACK THROUGH THE ORIGINAL PAYMENT ROUTE
                </p>
                <h2>Refunds with a record.</h2>
                {overview.refunds.map((refund) => (
                  <div className="round-refund-row" key={refund.id}>
                    <RotateCcw size={20} />
                    <div>
                      <strong>
                        {formatMoney(refund.amountMinor)} ·{" "}
                        {refund.state === "completed"
                          ? "PayPal confirmed the refund"
                          : refund.state === "refused"
                            ? "Provider refused this request"
                            : "Confirmation pending"}
                      </strong>
                      <p>
                        {refund.reason === "excess_return"
                          ? "Return of uncredited extra payment"
                          : refund.reason === "incomplete_round"
                            ? "The original 48-hour collection policy"
                            : "Reviewed package cancellation"}{" "}
                        · requested {date(refund.createdAt)}
                      </p>
                      {refund.completedAt && (
                        <small>Confirmed {date(refund.completedAt)}</small>
                      )}
                    </div>
                    {refund.state !== "completed" && (
                      <button
                        className="text-button"
                        disabled={!!busy}
                        onClick={() =>
                          void act("refunds/check", { refundId: refund.id })
                        }
                      >
                        <RefreshCw size={14} />
                        Check refund
                      </button>
                    )}
                    {refund.canRetry && organizer && (
                      <button
                        className="button secondary small"
                        disabled={!!busy}
                        onClick={() =>
                          void act("refunds/retry", {
                            refundId: refund.id,
                            acknowledged: true,
                          })
                        }
                      >
                        Retry the same {formatMoney(refund.amountMinor)} refund
                      </button>
                    )}
                  </div>
                ))}
              </section>
            )}
            {round && round.state !== "cancelled" && organizer && (
              <section className="round-cancellation">
                <div>
                  <p className="eyebrow">WHEN THE PLAN NEEDS TO STOP</p>
                  <h2>
                    {round.state === "compensating"
                      ? "Every received payment is still owed back."
                      : "An unspent package can be cancelled."}
                  </h2>
                  <p>
                    {round.state === "compensating"
                      ? "Provider checks and original-route refunds continue until each obligation is resolved. An unknown or pending result keeps the round open for reconciliation."
                      : "Cancellation stops new collection and excludes received money from spending. Any reviewed or paid expense must be resolved before an unspent-package cancellation can proceed."}
                  </p>
                </div>
                {round.state === "compensating" ? (
                  <button
                    className="button secondary"
                    disabled={!!busy}
                    onClick={() =>
                      void act("collection/compensate", { roundId: round.id })
                    }
                  >
                    Continue original refunds
                    <RotateCcw size={16} />
                  </button>
                ) : (
                  <button
                    className="text-button"
                    disabled={!!busy}
                    onClick={() => setCancelReview(!cancelReview)}
                  >
                    Review cancellation
                    <ArrowRight size={15} />
                  </button>
                )}
                {cancelReview && round.state !== "compensating" && (
                  <div className="round-inline-review">
                    <CancellationPosition roundId={round.id} projectId={snapshot.id} onReviewed={handleCancellationReview}/>
                    {cancellationPosition?.canCancelUnspent && <>
                    <h3>Return this round's unspent contributions.</h3>
                    <p>
                      All {formatMoney(round.collectedMinor)} of confirmed
                      collection and any extra payment remain linked to their
                      original receipts. Pending payments will be checked,
                      unpaid recovery invoices will be closed, and confirmed
                      funds will be returned. Refund requests stay pending until
                      the provider confirms them.
                    </p>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={cancelAccepted}
                        onChange={(event) =>
                          setCancelAccepted(event.target.checked)
                        }
                      />
                      <span>
                        I approve cancelling this unspent Electronics Benches
                        round and returning its received funds through their
                        original payment routes.
                      </span>
                    </label>
                    <button
                      className="button primary"
                      disabled={!cancelAccepted || !!busy}
                      onClick={() =>
                        void run("collection/cancel", async () => {
                          await request("collection/cancel", {
                            roundId: round.id,
                            expectedVersion: round.packageVersion,
                            acknowledged: true,
                          });
                          setCancelReview(false);
                          setCancelAccepted(false);
                        })
                      }
                    >
                      Cancel collection and begin returns
                      <RotateCcw size={16} />
                    </button>
                    </>}
                  </div>
                )}
              </section>
            )}
            <div className="round-bottom-note">
              <CircleHelp size={20} />
              <p>
                Every balance here comes from the contribution ledger. Provider
                fees, holds, cash availability, reviewed expenses, and physical
                evidence each have their own checks before a reimbursement can
                be approved.
              </p>
              <Link href="/board-pack" className="text-button">
                Open the current Board Pack
                <ArrowUpRight size={16} />
              </Link>
            </div>
          </>
        )
      )}
    </div>
  );
}
