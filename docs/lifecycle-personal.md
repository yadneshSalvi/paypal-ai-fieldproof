# Personal lifecycle records

The personal backend persists an independently current donor or volunteer's explicit preference decision and deterministic, source-linked private records. Preferences begin disabled. Donors can select pledges, contributions and choices; volunteers can select repayments. An organizer or organization role cannot opt another recipient in.

Every decision binds the exact project scope header, original session, recipient, current role, membership version and session deadline. The encrypted grant retains the original project credential. A reload, observer sweep, changed preference or lost-response retry cannot renew that deadline. New sessions receive metadata for earlier owned rows; they do not acquire the older grant or body. An explicit new opt-in creates a new immutable preference version and leaves earlier event identities intact.

## HTTP contract

All routes use the shared `lifecycleHttp` helper with `{ personal: true }`. The helper owns original cookies, `X-Fieldproof-Lifecycle-Project-Scope`, private response headers, bounded JSON, same-origin decisions and the execution lease. Personal requests require no organization browser nonce.

| Route | Exact response |
| --- | --- |
| `GET /api/lifecycle/inbox?state=&before=` | `{ inbox }` |
| `GET /api/lifecycle/inbox/:itemId` | `{ detail }` |
| `GET /api/lifecycle/inbox/:itemId/sources/:sourceId` | `{ detail }` |
| `POST /api/lifecycle/preferences` | `{ receipt }` |
| `POST /api/lifecycle/inbox/:itemId/state` | `{ receipt }` |

GETs authorize and serialize existing data only. They never opt in, observe a provider, capture a record, mark it read or refresh its source. Read/archive/unarchive commands persist their version and intent receipt atomically. Changed-payload retries conflict; the identical original request recovers its original minimal receipt.

## Bounded observation

`observeLifecyclePersonal({ limit?, before? })` owns its database transactions and returns `{ checked, created, skipped, nextCursor }`. Each call examines at most 20 current enabled grants and 100 original source candidates per grant. `checked` counts grants; `skipped` includes ineligible grants and source candidates. Continue `nextCursor` to finish a sweep, including a long single-recipient history, then start a new sweep for later transitions. Dropping a continuation can leave older candidates unexamined.

An explicit `current_records` preference decision can capture its first bounded source page immediately. `future_only` compares each verified original transition time with the original opt-in time. A recently inserted or observed older event cannot become a new event through observation time. Every saved snapshot retains `lifecycleCutoff(tx)` and its original source and content hashes. Final authority and expiry checks use a separate fresh database clock after waits.

`lifecyclePersonalTransaction(work)` takes the source-control table's SHARE lock before the first repeatable-read snapshot query. This prevents a first source withdrawal from being hidden behind the earlier default permission. It creates no source controls. `observeLifecyclePersonalGrant(tx, preferenceVersion, originalGrant, options)` shares that transaction, verifies its isolation and lock, and verifies the supplied grant against the actual encrypted current preference version. The ordinary integration entry point is the self-owning bounded observer. `runLifecyclePersonalPage` persists its encrypted cursor and original bounded lease; the authenticated lifecycle cron resumes that cursor after each committed page. See [Private lifecycle drafts](lifecycle-drafts.md) for scheduler limits and authority.

Cursor comparisons and ordering use the same explicit millisecond precision and stable IDs. Original stored timestamps remain unchanged. Immutable event keys include recipient, project, role, resource and logical transition; polling, read/archive changes and preference re-enabling cannot create a duplicate original event.

## Source evidence

| Original source | Event evidence |
| --- | --- |
| Named-purpose pledge | Authenticated original contract; original acceptance/deadline; saved withdrawal command |
| Original conditional consent | Exact original policy digest, amount, version and acknowledgement/withdrawal/deadline |
| Collected payment | Canonical original receipt and own original purpose; live completion also requires retained matching provider capture evidence |
| Invoice payment | Retained corroborated payment resource and its original invoice identity or invoice-number alias; a paid invoice label alone cannot establish collection |
| Original-route return | Own original receipt, exact refund command and retained matching completed refund resource, including its original capture parent |
| Outside return | Exact retained individual return observation and applied attribution; the original application attribution time is retained and unavailable provider creation time stays explicit |
| Donor choice | Own donor-authorized committed assignment and exact destination; approval, case default and accepted-but-unexecuted choice cannot become a completed move |
| Cancellation | Own original contribution, reviewed destination assignment or affected cancelled unpaid pledge; legacy original-round cancellations retain their recorded time |
| Volunteer repayment | Own original claim, source document and approved request identity; completion needs the retained independently matching payout item and original principal transition |

A repayment batch, approval or dispatch cannot establish delivery. Uncertain outcomes remain uncertain. A returned-after-delivery record also needs retained delivery evidence; a release before delivery cannot become that event. Sample and Replay provenance remain explicit. The test fixtures exercise these retained-record contracts without contacting a provider or establishing an actual transfer.

The event amount, original gross, originally credited support, retained support across recorded purposes, completed attributed returns and pending return reserves remain separate facts. These counters establish no merchant liquidity, available expense balance or current purpose allocation. Missing source amounts are unavailable, never an invented zero or denominator.

Source DTOs contain allowlisted scalar values and opaque citation IDs. Original recipient/source IDs, provider references, merchant data, destinations, document paths and provider URLs remain in encrypted server sidecars. Current original authority and exact document/source-control pins are checked for every private body and source detail. A withdrawal or permission-version change withholds earlier wording, sources and preview while retaining scoped metadata. An older body remains encrypted and immutable in storage.

Email output has `destination: null`, `sent: false` and `mode: "preview_only"`. No email address, sending permission, model inference or new provider request is accepted or dispatched by these services. Spanish wording is authored and unreviewed.

## Focused private-schema regression runner

The owned runner is `tests/helpers/lifecycle-personal-runner.ts`; its two suites are `tests/lifecycle-personal-database.test.ts` and `tests/lifecycle-personal-sources.test.ts`. Run it only from its explicitly configured independent clone with that absolute working directory. It requires the separately approved ignored test configuration, owner-only file/directory permissions, exact owned loopback PostgreSQL and 4612 review configuration, blank external credentials and no application DB cache. It blocks HTTP/TLS/UDP and every socket except the owned PostgreSQL port.

Before importing application DB modules it creates a fresh `lifecycle_personal_test_<UUID>` schema, establishes and checks its sole search path, initializes the base schema there, then manually applies the shared lifecycle schema. Cleanup drops only the exact created private schema. The runner never changes public fixtures, original runtime data, actors or deadlines. Its concurrent and financial controls are private database regression evidence; HTTP/native/deployed qualification and the shared schema migration remain integration work.
