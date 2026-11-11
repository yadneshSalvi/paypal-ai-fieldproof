# Purpose funding and donor decisions

The funding desk at `/funding` connects current-purpose funding to the original contribution, its donor, and its return route. A pledge records an intention. A settled contribution supplies funding. A new purpose, sponsor agreement, or next-cycle renewal always has its own recorded terms.

The complete local implementation includes general package pledges, buyer-present checkout and recovery, capped matching and grants, cancellation cases, original-route returns, explicit reallocation and rollover, expense funding from versioned credit lots, and evidence-backed recovery reviews. Actual provider qualification and deployment remain separate release gates. `FIELDPROOF_PURPOSE_CHECKOUT_ENABLED` defaults to `false` until that qualification is complete. Sample payments and returns are fictional and never call a provider.

## Donor and organizer journeys

- **Purposes:** an organizer opens the exact package version, amount, and fixed 48-hour acceptance window. A donor saves an exact pledge, then separately approves its payment. Unpaid promises, observed payments, and unresolved checkouts remain distinct.
- **My support:** the original pledge, checkout, deadline, current result, withdrawal eligibility, and contribution trail stay together. A definitive unsuccessful attempt can retry only its original operation and unchanged authority. Unknown outcomes require reconciliation.
- **Donor decisions:** cancellation freezes source versions, paid expenses and fees, pending reservations, the contribution denominator, whole-cent apportionment, deadline, and original-route default. A donor separately chooses a return, named new purpose, or explicitly renewed next cycle. Silence never gives new-purpose permission.
- **Matches and grants:** an organizer prepares a bounded agreement and a sponsor explicitly accepts it. A grant produces separate exact pledges. A match counts each newly recorded eligible donor payment once, within its global and package caps. Grants, matching payments, moved support, and the sponsor's own payments cannot earn another match. Payment remains a separate sponsor action.
- **Contribution trail:** original purpose/version, Orders or invoice provenance, current positions, decisions and returns are source-linked. Historical economic receipts and saved report datasets keep their original lineage.

## Recovering a held review

An unequal paid-source position cannot be solved by rewriting which donor's payment funded an expense. The recovery panel shows the original pro-rata shares, each source's actual remaining capacity, and the exact paid allocation and Payout/fee revisions. Missing expense evidence keeps the proposal unavailable.

When the evidence supports it, an organizer can propose source-specific remaining shares with a recorded reason. Every affected donor must explicitly accept their own exact revised amounts, including a zero remaining share. Donors can decline or withdraw an unapplied response. Current membership, the entire source/evidence snapshot, and all acceptances are checked under the funding locks before application. The result is a separate immutable case revision. Original receipts, paid allocations, the total remaining support, the original pro-rata review and the original deadline are retained. Returning or moving each agreed share is still a separate donor choice.

An outside return first excludes only that source's remaining current-purpose credit. The return inspector saves independently read capture and individual refund evidence. An organizer can record exact proven original-purpose attribution and release only the exclusion introduced by that review hold. Earlier exclusions, paid uses, other captures, and earlier decisions remain untouched. The confirmed outside return receives an immutable record, exact receipt-version deduction, and balanced journal entries; no new provider refund is sent by this reconciliation.

Incomplete provider history, pending/unknown returns, unresolved owned refund operations, uncredited-excess ambiguity, and insufficient original-source capacity remain visible blockers. For a payment that has changed purposes, the current provider adapter proves its capture but does not establish the outside refund's purpose/version or historical timing. The inspector links the contribution and saved decisions and requests the missing original-operation evidence. A reviewer cannot release that hold by typing an amount or selecting an arbitrary destination.

Verified changed facts can produce a separately reviewed residual case after started returns are resolved. Earlier completed decisions stay in their original case, and the original decision deadline remains fixed. Unchanged facts cannot renew a case.

## Accounting and authority

`projectFundingPositions` validates the complete receipt, paired assignment, deduction and expense history. `projectFundingLots` additionally replays exact purpose versions, donor consent lineage, FIFO lot splits and bounded reversals. Every committed transfer has an owned immutable donor choice. A target requires its own current policy and version; it does not inherit the cancelled source's funded flag.

Every financial mutation takes the project claims advisory lock, then deterministically sorted rounds, packages, obligations and receipts. Original unassigned `allocationReceiptDigest` values stay byte-identical. Revalidating an existing payable adds back only its own active reservation for that exact receipt and package, never another payable's reservation or a paid use. Receipt counter changes after assignment require new exact-version deduction attribution in the same transaction.

Cases, choices, policies, sponsor agreements, matching events, reconciliation evidence, responses and external-return records have immutable encrypted contracts and checked row/document digests. Schema 18 adds these contracts and their readiness/repair guards. New Sample origins and fictional paid-use evidence record their known versions at creation; historical Live versions are never guessed from today's package.

Server authority is current on every action. Donors see only their own contribution sources. Organizers inspect the workspace position; Auditors inspect without financial actions. Volunteer views omit donor records. Same-origin checks, bounded strict request bodies, stale workspace binding, expiry, revocation, immutable operation identities and provider provenance apply at the API as well as in the UI. Focus, workspace changes and explicit refresh clear open confirmations.

## Interfaces and operation

`GET /api/funding` reads the current desk. Scoped reads include `cancellation-review`, `receipts/:id`, `cases/:id/recovery`, and `receipts/:id/recovery`.

Explicit POST actions cover `policies`, `windows`, `cases`, `defaults`, `choices`, `choices/revoke`, `choices/execute`, `pledges`, `pledges/withdraw`, `pledges/sample-settle`, `pledges/checkout`, `sponsors`, `sponsors/accept`, `sponsors/withdraw`, `sponsors/review`, `returns/check`, `returns/observe`, `returns/reconcile`, `adjustments`, `adjustments/respond`, `adjustments/revoke`, `adjustments/apply`, `adjustments/withdraw`, and `cases/reconcile`. An acknowledgement is bound to the exact version and body; repeated intent identities cannot change their meaning.

The generalized checkout uses the pinned APIMatic `paypal` SDK through the existing `@fracture/paypal-core` 0.2.7 adapter. It never treats a saved wallet or unpaid sponsor promise as cash. The deployment flag is checked again immediately before dispatch. Missing core claims recover the unchanged saved command; ambiguous results do not create another order or capture.

Studio keeps its original settlement dataset and adds a separately versioned `fieldproof-funding-positions-v1` dataset. Older saved reports without this dataset retain their saved history. New snapshots, planning availability, community facts and public-proof drafts consume current canonical positions; existing public editions and reports are not rewritten.

## Verification and retained scope

The isolated PostgreSQL regression passed **432 tests across 64 suites, zero skips**, with actual network access denied and only injected transports. Tests include independent Payout/item/fee evidence, unchanged original approvals and paid uses, all-donor adjustment consent, revocation/application races, transfers/reservations/cancellations, original-route Orders and invoice returns, partial and outside returns, immutable evidence guards, stale versions, cross-workspace privacy, source conservation, sponsor caps, buyer-present checkout recovery, and production QA isolation. Strict nonincremental TypeScript also passed.

An independent production build and **25 HTTP journey checks** passed with blank provider credentials. The Sample journey preserved $590 of original and newly recorded contributions as $240 returned, $20 of paid expense history and $330 available for current purposes, with no pending or excluded balance and balanced journals. All six provider command, approval, attempt and order tables remained empty. The separate native fixture, actor expiry and original decision deadlines stayed unchanged. See [the local qualification record](evidence/funding-lifecycle-local-qualification.json). Native browser review, actual providers and hosted release remain separate gates.

The isolated native reviewer at `/funding-qa` requires an explicit local-only flag, its own restricted database and cookie, blank credentials, disabled providers, and localhost port 4535. It selects only fixed-expiry Sample actors. It is unavailable on a hosted origin or an ordinary production workspace.

The frozen review copy has separate source, dependencies and compiled output. Its local-only Next configuration pins the build and tracing root to that copy; the main Next configuration retains its previous content. The existing Planning and Community development processes share the main checkout, so their watchers could observe implementation edits. They were not rebuilt, installed or manually restarted during this unit; their runtime source is not claimed to be immutable. Original and hosted storage checks remain separately coordinated.

The full product remains active. Outstanding qualification includes root's native mobile/keyboard/zoom/stale-tab matrix, actual generalized checkout and sponsor payments, supported same-obligation invoice recovery and its financial return route, controlled partial-spend return/transfer cases, migration/no-mutation proof and hosted release. Later full-plan gates retain the complete personalized share-of-package/evidence/reviewer/date presentation, current cutoff reconciliation and Board Pack qualification, wider model/translation/geometry evaluations, authorized physical evidence and safety review, real-user research or an explicit report of its absence, measured accessibility/performance, recorded rehearsals, film, gallery and release. Existing planning, community, proof and Studio milestones remain separate evidence, not claims that those final gates are complete.
