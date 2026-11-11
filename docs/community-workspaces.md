# Community projects, saved work and bilingual updates

This source checkpoint adds three reusable starting projects and a private, source-bound update workflow. Templates contain proposed budgets and explicitly fictional planning documents. They create no receipts, accepted work, claims, payment approvals or financial dispatches. Browser qualification, actual model observations and hosted migration are separate release evidence.

## Start the isolated review

Use Node 22 and the existing local PostgreSQL service. In a checkout with a retired original writer, keep port 4102 off. Keep the separate Planning review on 4502 and its runtime intact.

```sh
# Once only; creates a new unprivileged role and its own database:
npm run community:qa -- --prepare --local-admin
# Subsequent starts preserve this database and all saved review work:
npm run community:qa -- --resume
```

Open `http://localhost:4512/community`. The launcher refuses an occupied port. It validates PostgreSQL at `127.0.0.1:5432`, a database named `fp_community_qa_*`, and a dedicated login with the same name. It never reads the original application database. The ignored, mode-0600 `.local/community-qa/runtime.json` stores the separate connection and encryption secret; do not print or publish it.

PayPal, OpenAI, Gemini, Google and Blob credentials are blanked **before** Next loads environment files and blanked again afterwards. `FIELDPROOF_PROVIDER_ACCESS=disabled` also rejects provider adapters before dispatch. The private local document store is restricted to this validated development database. QA uses `fieldproof_community_qa_session` and its separate HttpOnly library cookie. It does not replace other localhost cookies. Actual providers cannot be qualified by enabling keys in this launcher.

```sh
npm run community:qa -- --test
npm run assets:check
npm run community:qa -- --build
```

Tests use disposable schemas inside this separate database. Stub credentials and injected fixture adapters are confined to the test child; no fixture outcome is an actual provider observation. Development output uses `.next-community-qa`; production compilation uses `.next-community-build`.

## Templates and saved work

| Starting project | Proposed budget, USD | Required prerequisites |
| --- | ---: | --- |
| Makerspace | $8,410 | Laser use requires accepted Safety & Ventilation work and scoped safety review. |
| Community garden | $4,860 | Beds require accepted soil work; seedlings require accepted beds and water-safety review. |
| Mutual aid | $5,800 | Pantry, hygiene and delivery require accepted intake work; delivery also requires accepted access work. |

Each project has six independent packages, editable planning geometry, an illustrative sketch, a fixed fictional quote, an alignment illustration and a review-scope exercise. The garden adds soil suitability and water safety; mutual aid adds food safety, distribution readiness and site access. A template cannot remove mandatory prerequisite or evidence requirements through a model proposal or edit. A source quote never silently inherits a later financial package budget.

Browsing the three cards does not change the current project. Creating a project requires a name and an explicit Sample acknowledgment. Fieldproof saves the current session before setting a new session cookie. “Saved workspaces” preserves the requested destination when returning to a project.

The library contains encrypted server-side capabilities; browser responses include only project/session labels and expiry metadata. Switching locks the library and both current and target authorities, checks current memberships and database-clock expiry, and never renews a session. Expired or revoked capabilities are cleared; historical labels can remain. A stale tab sends its expected project ID and cannot silently act on another project's cookie. Other tabs are told to return to saved workspaces.

The older Eastside tour, sample receipt and controlled conditional-payment scenario retain their own identity. They are rejected in all newly created template workspaces. New templates currently support planning, evidence review, Studio, public-proof preparation and bilingual update journeys. A separate explanatory state appears for financial scenario routes; it links to supported work rather than loading Eastside identifiers.

## Source-backed English and Spanish

`/updates` and `/my-contribution` read a current authorized projection. English and Spanish share the same server source digest, citation rows and integer values. Currency, dates, counts, package names and other protected values are rendered from named slots. Recorded contributor identities are distinct from independent people; personal contribution totals use only the current actor's owned records. A separate checkout never becomes conditional funding. Pending refunds, excess liabilities and current funding eligibility remain separate.

The default Spanish wording is an authored starting translation and is labelled as needing review. At `/update-desk`, an organizer can:

1. Capture a fixed supporter or private treasurer source snapshot. The snapshot retains row hashes, observation cutoff, audience and current membership version.
2. Select supported sentences and save an immutable English draft. Each factual sentence resolves to exact rows of that snapshot. Open its citation to inspect the saved record and follow the relevant project view.
3. Edit Spanish while preserving every `{{protected_value}}` exactly once. Numbers, currency literals, links, markup, omitted paragraphs and foreign paragraph IDs are rejected. Save a new revision instead of overwriting history.
4. Save an independent back-translation of that exact Spanish revision, or explicitly request one from the actual model adapter when configured. A model result is a proposal and does not establish fluent human review.
5. Compare the English, Spanish and back-translation. A fluent-review record requires the current organizer's explicit fluency attestation and a review note. A separate **Sample exercise** is available only for sample projects and is labelled as such; it never grants fluent status. Automated qualification must use that disclosed Sample path.
6. Save a labelled supporter-page preview. A Spanish preview requires a current review of the exact revision and back-translation. A treasurer draft cannot be previewed to supporters. No message is sent, and scheduled digests remain disabled.

Current source, membership or translation-head changes invalidate current review/preview eligibility while retaining historical revisions. Approval expiry and source withdrawal change the server source digest. Treasurer snapshots expose whitelisted claim, reservation, approval and stored balance facts; they do not refresh a provider, disclose recipients or authorize liquidity/payment.

The sentence compiler constrains model-written English drafts to selecting and ordering supported statement IDs and their exact citation IDs. It rejects unsupported facts, cross-snapshot citations and tool-shaped output. Copied source text is untrusted input. Spanish prose still needs semantic review: protected amounts cannot establish the correctness of freely translated language.

## Durable model requests

Actual model calls use server-only `OPENAI_API_KEY` and optional `OPENAI_COMMUNITY_MODEL` (falling back to `OPENAI_MODEL`). The adapter requests `max` reasoning, a strict structured result, background execution and `store:false`; it declares no tools. Qualification must record the actual configured model, response observation and source/output hashes. The disabled QA process is not evidence of actual provider success.

One explicit request has one durable dispatch identity. Repeated clicks and competing workers cannot submit it twice. The request, source hashes, current session/member versions, observations and results are encrypted or hashed in PostgreSQL before adoption. A known response ID is checkpointed encrypted and polled through the same identity. A lost submission response without an ID stays unknown and is never automatically resubmitted. A late known identity is preserved even after its original worker lease expires.

The recovery window is nine minutes, bounded below the provider's temporary background retention. Failed polls can retry a known ID within that window. Changed source, revoked membership, expired original session, changed translation head, changed response identity, incomplete output and invalid citations prevent result adoption. The actual observation remains recorded; it does not become an accepted draft or review.

`/api/cron/community` requires the existing constant-time-checked cron secret and honors maintenance holds. It handles only already consented queued requests or saved responses. The UI's continuation reads also poll saved identities. Neither path sends notifications or creates a new inference for an unknown request. Deployment of the cron schedule is part of hosted qualification.

## Hosted release ownership

Schema **13** is additive. It introduces the workspace library and creation/switch history, encrypted community snapshots/drafts/translation history, exact back-translations/reviews, durable model runs/observations, idempotent actions and supporter previews. It changes no existing financial record. The original encryption secret must remain stable. No local QA database or runtime file belongs in a hosted import.

The release owner must back up the hosted database, apply normal bounded initialization, verify schema 13 and preserved original histories, qualify the exact source commit on the hosted platform, and register/check the new cron route. Keep the sole-writer and retired-process rules in [the workspace cutover guide](workspace-cutover.md). New workspace access must not renew an old original session or payment approval.

The remaining full-product scope includes real cancellation/refund/reallocation and recovery-invoice evidence; capped matching, grants, organization, membership and portfolio workflows; held-out evaluations, broader accessibility/performance, authorized participant research or disclosed absence, recordings and final release qualification. A passing community milestone does not complete those obligations.
