# Fieldproof

**Every community dollar, linked to proof.**

Fieldproof connects a community project plan to conditional commitments, confirmed payments, reviewed expenses, and source evidence. Its visual language is a warm civic blueprint: a room gradually becoming something people can use.

The Eastside makerspace is a fictional sample project. Its Electronics Benches package has an exact $960 target and eight sample obligations. The walkthrough illustrates seven capture receipts totalling $925 and one $35 invoice-payment receipt. Sample records are never presented as real PayPal payments or physical work.

## Current implementation checkpoint

This repository is an active build, not a finished submission. The current checkpoint includes:

- A responsive interactive blueprint and project, package, progress, proof-preview, donor, expense, organizer, sandbox checkout and printable Board Pack views.
- Isolated durable PostgreSQL workspaces, expiring server sessions, explicit roles, current payment approvals, immutable operation identities, version checks, audit events and receipt projections.
- A canonical receipt model for Orders captures and invoice payments, separate pledged/collected/eligible totals, refund reservations, excess-payment liability and exact integer-cent arithmetic.
- A three-stage Sample tour and the seven-line $86.40 sample receipt. Its ambiguous $8.40 line remains unresolved. No repayment or physical acceptance is fabricated.
- Actual PayPal JavaScript checkout backed by the pinned APIMatic-generated TypeScript SDK through the independently packaged payment core. A buyer must explicitly approve each $1.00 sandbox checkout. Session and application test ceilings are enforced transactionally.
- Login with PayPal routes with single-use, expiring, session-bound OAuth state. A repayment destination is accepted only when PayPal actually returns both a verified account and payer ID; it is encrypted at rest and masked in the UI.
- A browser-printable current ledger and CSV export. These are draft projections, not a completed reconciliation certificate or tax receipt.
- Exact conditional commitments at `/commitment`, durable encrypted PayPal wallet approval, and an organizer collection review at `/collection`. The eight approved slots are $200, $200, $175, $150, $100, $50, $50 and $35. One immutable round starts a fixed 48-hour clock; the qualification flow reviews each original collection separately.
- Same-obligation recovery invoices after a definitive original decline, private recipient details, share links and QR codes, independent payment-resource corroboration, and canonical all-rail receipts. Unknown original payments cannot open an invoice.
- Exact original-route refund reservations, unspent-package cancellation, incomplete-round compensation, current-role/receipt/budget checks, balanced refund journals and separate pending/completed states. Confirmed extra payments remain refund liabilities rather than additional contribution credit.
- Leased collection/compensation workers and signature-verified webhook intake. Invoice, refund and payout events trigger fresh owned reads; event payloads cannot add money or dispatch a financial operation.
- Private image/PDF uploads with exact file binding, normalized source previews, actual direct OpenAI and Gemini extraction, preserved model attempts, duplicate comparisons, and versioned line-by-line claim review. A proposal cannot approve or pay an expense.
- Reviewed reimbursement previews and separate exact approvals, current verified recipients, canonical package funding allocations, balance preflight with disclosed reporting delay, immutable Payout identities, individual-item reconciliation and original-batch recovery.
- An encrypted, conflict-rejecting workspace transfer and single-use hosted continuation that preserve original provider identities and review history. See [the cutover and rollback procedure](docs/workspace-cutover.md).

The full build still includes reviewed geometry and photo alignment, actual recovery-invoice settlement and reimbursement qualification, cancellation/reallocation and rollover, native AG Studio widgets and agent delegation, versioned public Proof Pages, Spanish views, garden/mutual-aid templates, match and grant/membership workflows, complete browser qualification and deployment. These remain implementation and evidence obligations. Installed packages do not mean those features are implemented.

## Run locally

Use Node **22.22.3 or later** and npm. Provide a dedicated PostgreSQL database that this app may create tables in. No in-memory persistence fallback is used.

```sh
npm ci
cp .env.example .env
# Fill server environment values for your isolated sandbox app and database.
npm run db:seed
npm run dev
```

Open [localhost:4102](http://localhost:4102). The public sample can be explored without a login. “See it in 60 seconds” creates a separate persisted sample workspace. “Try the sandbox” opens a separate empty live sandbox workspace. A fresh workspace never erases PayPal history.

The checkout requires an actual PayPal sandbox buyer. Card details and buyer passwords stay with PayPal. The app never switches to PayPal's real-money host. Do not put server keys in `NEXT_PUBLIC_*` variables. The browser receives only the public client ID needed by PayPal's official JS SDK.

The exact intended identity callbacks are:

- Local: `http://localhost:4102/api/auth/paypal/callback`
- Hosted: `https://paypal-ai-fieldproof.vercel.app/api/auth/paypal/callback`

The hosted callback is registered and separately qualified. PayPal refused the local callback settings save; the local preview therefore blocks account connection until `PAYPAL_LOCAL_IDENTITY_CALLBACK_VERIFIED=true` is justified by actual registration. Set `APP_URL` to the matching origin, or use the validated local/Vercel fallback. `/privacy` and `/terms` describe this sandbox demonstration. Production hosting still uses PayPal sandbox.

## Validation

```sh
npm run typecheck
npm test
npm run build
node scripts/http-smoke.mjs
```

The test suite uses the configured PostgreSQL database. New collection/invoice/refund suites create an isolated schema and drop only that schema; earlier suites create and remove uniquely named fixture tenants. Tests cover concurrent claims, current authority, exact consent/round identity, unknown writes, same-obligation invoice recovery, canonical aliases, cancellation races, pending/unknown refunds, provider budgets and balanced journals. Injected providers are labelled fixtures; passing these tests is not an actual PayPal lifecycle.

The current maintenance-release checkpoint passed **157 tests across 20 suites**, TypeScript and the production build. Sixteen transfer, continuation and maintenance cases cover conflict rollback, exact encrypted operation ownership, single-use handoff, request draining, blocked API/cron/provider mutations and permitted reads. Three cold-initialization cases cover bounded migration waits and avoiding repeated schema writes during import. The full regression ran in a separate temporary schema while the original workspace remained frozen. Hosted cutover results are recorded separately from local rehearsal evidence.

For an explicitly authorized **sandbox-only order-creation** probe while the app is running:

```sh
node scripts/http-smoke.mjs --qualify-create
```

This creates a $1.00 order awaiting actual buyer approval, repeats the same application intent to prove stable identity, verifies that no settlement credit was created and checks Auditor capture denial. It does not approve a buyer or move funds. The app-wide test ceiling counts claimed checkout intentions conservatively; creating a new session does not reset it.

Actual sandbox evidence records the separate $1 checkout, hosted recipient login and signed webhook replay, all eight wallet approvals totalling $960, and seven original conditional captures totalling $925. The final $35 obligation remains untouched. Those approvals came from **one controlled participant account**, not eight independently recruited donors. Both actual AI providers read the fictional $86.40 receipt. Browser-driven automated review preserved $78 approved and $8.40 held; incomplete package funding correctly blocked repayment. This is a controlled sample, with no physical purchase or independent human review claimed. No actual recovery-invoice settlement or Fieldproof reimbursement is claimed yet. Sanitized evidence is in [`docs/evidence/`](docs/evidence/).

## Boundaries and integrations

The generated `paypal` SDK is pinned to version 2.29.0 at Git commit `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`. Workspace-local APIMatic TypeScript integration, authentication, model, endpoint, resilience, error and testing guidance informed the implementation. The [SDK integration record](docs/apimatic/typescript-integration.md) and [paypal-plan.md](paypal-plan.md) document the actual boundaries and failure handling.

`@fracture/paypal-core` is an independently installed immutable archive in `vendor/`, with provenance. Version **0.2.7** supplies SDK transport, encrypted operation documents, durable claims, current-authority gates, typed Invoicing/Payout endpoint boundaries, canonical event intake and exact-operation outcome reconciliation. Fieldproof owns its domain approval, session, obligation, recipient and canonical receipt authority. There are no sibling runtime imports.

An uncertain financial write remains unknown until reconciled. It is never treated as a decline or permission to open another collection channel. Authenticated `/api/cron/reconcile`, `/api/cron/webhooks`, `/api/cron/collection`, `/api/cron/compensation`, `/api/cron/invoices`, `/api/cron/refunds`, `/api/cron/evidence` and `/api/cron/payouts` persist and reconcile their work. Payment recovery selects bounded original commands; Payout reconciliation only reads known provider resources. Schedules are declared in `vercel.json`; newly added hosted jobs require deployment and provider registration qualification. In review-each collection mode, a background worker cannot initiate an untouched slot.

For the controlled collection qualification, keep the existing participant workspace, choose Organizer, open `/collection`, review the complete eight-slot set and explicitly start the round. Use each slot's Collect action. A failed request remains attached to its original record; use its check or recovery action instead of starting another workspace. The first conditional-collection allowance is exactly $960 across original collection commands and is separate from the $1 checkout ceiling. Cancelling a reviewed unspent round stops new collection and begins compensation; it never silently deletes provider history.

PayPal Invoice status and bookkeeping refund endpoints do not prove money movement. Payout submission does not prove successful repayment. A saved wallet is not reserved funds. AI proposals have no financial authority. The Auditor cannot dispatch financial commands.

Direct OpenAI and Gemini calls and private Vercel Blob storage are qualified for the receipt workflow, with run versions, source/output hashes and measured latency recorded. AG Studio 3.1.0 is installed; its native widgets and agent delegation remain in progress. Real physical evidence and real user research require authorized sources and participants. Clearly disclosed Sample alternatives are used where those do not exist.

The receipt pipeline validates files before model use, retains private originals and immutable model output, checks currency/arithmetic/source regions, and requires an organizer decision for every line. Payouts can use only reviewed, currently funded package allocations; a balance read is bounded to a 60-second fetch age and a disclosed three-hour provider reporting age. Batch acceptance is not item success. Unknown creation retains its reservations and exact original request identity. These gates have local fixture coverage; actual repayment requires separate provider qualification.

## Layout

`app/` contains routes and page states; `components/` the product UI; `lib/domain/` pure money/recovery rules; `lib/server/` PostgreSQL, sessions, provider authority, receipt ingestion and identity; `lib/contracts.ts` the shared DTOs; `tests/` meaningful invariants; `public/samples/` clearly labelled fictional source documents. Private planning files and environment values are ignored by Git. This README and the checked-in source are sufficient to run the checkpoint without those planning files.

MIT licensed. See [LICENSE](LICENSE).
