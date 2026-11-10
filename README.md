# Fieldproof

**Every community dollar, linked to proof.**

Fieldproof connects a community project plan to conditional commitments, confirmed payments, reviewed expenses, and source evidence. Its visual language is a warm civic blueprint: a room gradually becoming something people can use.

The Eastside makerspace is a fictional sample project. Its Electronics Benches package has an exact $960 target and eight sample obligations. The walkthrough illustrates seven capture receipts totalling $925 and one $35 invoice-payment receipt. Sample records are never presented as real PayPal payments or physical work.

## Current implementation checkpoint

This repository is an active build, not a finished submission. The first checkpoint includes:

- A responsive interactive blueprint and project, package, progress, proof-preview, donor, expense, organizer, sandbox checkout and printable Board Pack views.
- Isolated durable PostgreSQL workspaces, expiring server sessions, explicit roles, current payment approvals, immutable operation identities, version checks, audit events and receipt projections.
- A canonical receipt model for Orders captures and invoice payments, separate pledged/collected/eligible totals, refund reservations, excess-payment liability and exact integer-cent arithmetic.
- A three-stage Sample tour and the seven-line $86.40 sample receipt. Its ambiguous $8.40 line remains unresolved. No repayment or physical acceptance is fabricated.
- Actual PayPal JavaScript checkout backed by the pinned APIMatic-generated TypeScript SDK through the independently packaged payment core. A buyer must explicitly approve each $1.00 sandbox checkout. Session and application test ceilings are enforced transactionally.
- Login with PayPal routes with single-use, expiring, session-bound OAuth state. A repayment destination is accepted only when PayPal actually returns both a verified account and payer ID; it is encrypted at rest and masked in the UI.
- A browser-printable current ledger and CSV export. These are draft projections, not a completed reconciliation certificate or tax receipt.

The full build still includes reviewed model extraction and geometry editing, private evidence uploads/OCR/duplicate review, actual saved-wallet consent and conditional collection, real recovery invoices, reviewed Payouts, cancellation/refund/reallocation, native AG Studio widgets and agent delegation, versioned public Proof Pages, Spanish views, garden/mutual-aid templates, organization-scale workflows, browser qualification and deployment. Installed packages do not mean these features are implemented.

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

Use these exact registered identity callbacks:

- Local: `http://localhost:4102/api/auth/paypal/callback`
- Hosted: `https://paypal-ai-fieldproof.vercel.app/api/auth/paypal/callback`

Set `APP_URL` to the matching origin. `/privacy` and `/terms` describe this sandbox demonstration. Production hosting still uses PayPal sandbox.

## Validation

```sh
npm run typecheck
npm test
npm run build
node scripts/http-smoke.mjs
```

The test suite uses the configured PostgreSQL database, creates uniquely named test tenants and removes only those fixtures. It tests duplicate concurrent claims, tenant/amount/request forgery, current-role denial before dispatch, changed resource versions, order ownership and transactionally bounded test spending, in addition to receipt and recovery invariants. It does not contact PayPal or fabricate a successful provider lifecycle.

For an explicitly authorized **sandbox-only order-creation** probe while the app is running:

```sh
node scripts/http-smoke.mjs --qualify-create
```

This creates a $1.00 order awaiting actual buyer approval, repeats the same application intent to prove stable identity, verifies that no settlement credit was created and checks Auditor capture denial. It does not approve a buyer or move funds. The app-wide test ceiling counts claimed checkout intentions conservatively; creating a new session does not reset it.

On 11 November 2026 the first checkpoint passed 28 tests, TypeScript and a production build. Its real isolated PayPal SDK Orders-create probe succeeded, with a repeated request returning the same operation/order and zero collection credit. Actual browser approval/capture and recipient-login qualification remain separate checks.

## Boundaries and integrations

The generated `paypal` SDK is pinned to version 2.29.0 at Git commit `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`. Repository-local APIMatic TypeScript integration, authentication, model, endpoint, resilience, error and testing guidance informed the implementation. Exact operations and failure handling are documented in [paypal-plan.md](paypal-plan.md).

`@fracture/paypal-core` is an independently installed immutable archive in `vendor/`, with provenance. Version 0.2.1 supplies SDK transport, durable claims, current-authority gates, request identities and outcome reconciliation. Fieldproof owns its domain approval, session, obligation, recipient and canonical receipt authority. There are no sibling runtime imports.

An uncertain financial write remains unknown until reconciled. It is never treated as a decline or permission to open another collection channel. The authenticated `/api/cron/reconcile` route recovers core operations and reapplies persisted provider receipts after a request interruption. A deployed durable scheduler, webhook registration/processing and broader collection jobs are subsequent qualification work.

PayPal Invoice status and bookkeeping refund endpoints do not prove money movement. Payout submission does not prove successful repayment. A saved wallet is not reserved funds. AI proposals have no financial authority. The Auditor cannot dispatch financial commands.

AG Studio 3.1.0, direct OpenAI and Gemini, and private Vercel Blob are provisioned for subsequent work; none is claimed as a finished runtime integration in this checkpoint. Real physical evidence and real user research require authorized sources and participants. Clearly disclosed Sample alternatives are used where those do not exist.

## Layout

`app/` contains routes and page states; `components/` the product UI; `lib/domain/` pure money/recovery rules; `lib/server/` PostgreSQL, sessions, provider authority, receipt ingestion and identity; `lib/contracts.ts` the shared DTOs; `tests/` meaningful invariants; `public/samples/` clearly labelled fictional source documents. Private planning files and environment values are ignored by Git. This README and the checked-in source are sufficient to run the checkpoint without those planning files.

MIT licensed. See [LICENSE](LICENSE).
