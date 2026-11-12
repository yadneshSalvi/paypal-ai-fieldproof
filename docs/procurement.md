# Procurement and package operations

`/procurement` is the current project's coordination desk. It is separate from
funding, merchant purchasing, expense approval and qualified physical review.
Supplier information is self-declared. Recording a quote, responsibility,
progress report or operational transition sends no order, email or payment.

All three ordinary templates use their own canonical packages, capabilities and
prerequisites: makerspace, community garden and mutual-aid supply drive. The
desk reads the current project; it does not select a demonstration actor or
create a project as a side effect of viewing it.

## Ordinary entry and authority

Open an independently current project through **Saved workspaces**, then open
`/procurement`. The exact current session role drives controls:

| Current project role | Procurement scope |
| --- | --- |
| Organizer | Supplier and quote review, current-member responsibility proposals, prepared operational transitions, cancellation/reopen, existing expense links and volunteer invitations. |
| Volunteer | Their own current proposal/accepted responsibility, own supplier/quote originals, explicitly shared selected scalars and permitted work reports. No other supplier bids or another uploader's original document access. |
| Auditor | Operational package/history metadata; no private supplier bids, source documents, member labels or private reasons. |
| Donor | No private procurement desk. The independently issued donor profile retains its original support rights. |

An assignment grants no membership, financial approval or credential. A current
member must accept the exact proposed cycle; even an organizer assigning their
own profile must deliberately accept. Reassignment does not transfer an earlier
recipient's private source disclosure to the next assignee.

There is a real ordinary volunteer entry path. The current organizer opens
**Volunteer entry**, reviews an unverified label and fixed deadline, and creates
a one-use private URL at `/procurement/join#invite=…`. A different browser/actor
opens that URL, reviews the exact volunteer role, enters an explicitly
self-declared name and accepts. This creates a separate actor with exactly
`["volunteer"]`, never a union with an organizer or donor profile. The original
issuer browser/actor cannot accept its own invitation.

The fixed deadline is no later than the original issuing organizer session and
at most seven days from issuance. Acceptance rechecks that issuing session and
its exact current organizer membership version. After joining, the independent
volunteer grant lasts only until its original deadline or explicit revocation;
merely switching the issuer's view does not renew or merge it.

The recipient receives `/procurement/join#access=…`, a private possession-based
return capability. It restores only the same original actor/session and fixed
expiry, including from a fresh browser. Another active or ended workspace
credential requires a deliberate exact-context leave first. Successful entry
remembers the original session through the existing Saved workspaces library.
Neither path verifies a person, email, organization, supplier, PayPal ownership
or actual physical work. No invitation is sent externally by this feature.

## Sources, alternatives and revisions

1. Add a declared supplier with the source and limits of those details. Editing,
   archiving or restoring availability retains each immutable declaration.
   **Declaration history** opens the original versions.
2. Propose a quote against exact current package versions and supplier revision.
   Use a private validated quote document with its page/region/excerpt or an
   explicitly entered estimate. An entered estimate implies no supplier reply.
   Ready source originals keep existing uploader/organizer permissions.
3. Enter exact currency, source lines, tax, delivery, discount, original validity,
   capabilities and provenance. A blank cost remains unknown. Arithmetic
   conflicts stay visible; no currency conversion or cheapest recommendation is
   inferred. A multi-package quote needs reviewed internal shares accounting
   for its one source total; it is never counted in full for every package.
4. The organizer separately checks the original source and amounts. Any edit
   creates a new immutable revision and clears the earlier quote review.
   **Quote revision history** and **Inspect source** retain the original version,
   recorded decision, hash, time and current permission state. Retirement makes
   no false source-review attestation and does not erase the record.
5. Compare the alternatives within a package, retain every compared current
   head, and select an exact reviewed internal cost share. Sharing selected
   scalars is an explicit decision bound to the exact accepted responsibility.
   Other bids and original source identifiers remain private. Original quote
   deadlines remain visible and are never renewed by selection or reopening.

Private page previews use scoped authenticated reads, byte hashes and transient
object URLs. A fresh current-permission check follows storage I/O. Withdrawal
withholds private source-derived views and images while keeping original
versions, hashes and history. An already captured repeatable-read snapshot
cannot bypass a subsequently inserted permission-control row.

## Operational lifecycle

| Saved step | Meaning |
| --- | --- |
| Operational draft | Editable coordination; missing progress/cost remains unknown. |
| Plan for procurement reviewed | The exact current plan/package/rule basis was reviewed for coordination. |
| Ready for procurement review | Current accepted responsibility, source-supported complete cost, original quote deadline, prerequisites and canonical application credit were reviewed. No merchant purchase or spending approval occurs. |
| Work reported in progress | An authorized current profile reports work starting; no physical outcome is established. |
| Awaiting current work review | Work is reported ready for an actual current evidence review. |
| Operational acceptance recorded | The organizer reviewed every current required association/qualified physical decision for this cycle and its prerequisites. Financial outcomes remain independent. |
| Work blocked | An explicit reason retains the exact prior step. Clearing a block cannot skip approval/readiness. |
| Operations cancelled | Coordination stops; original donor choices, contributions, claim approvals, payables, sources and physical decisions remain unchanged. |
| New cycle reopened | An explicit new cycle resets responsibility, selection and progress. It extends no grant, quote or source permission and does not revive a canceled funding purpose. |

Each transition first prepares a server-retained review with exact source,
package, membership, operational, financial and physical-evidence hashes and a
fixed deadline of at most ten minutes/original session expiry. Commit requires
that unchanged review and an explicit acknowledgment. A changed basis or
authority after a lock wait rolls back the entire uncommitted step. A block,
cancellation or reopen keeps the original historical facts.

Reported progress is nullable and self-reported. **100% never supplies physical
acceptance**. Illustrative image association is distinct from physical work.
Reopened cycles and their dependent packages require fresh qualified physical
decisions after the new cycle cutoff. Copied project policies are checked
prospectively; a materialized editable draft is not an applied publication, and
procurement creates no policy-consumer binding or rewritten old approval.

Reported operational issues have explicit open/resolved reasons and immutable
history. Resolving one cannot click away a derived funding/source/evidence gate.
An expense link refers to the exact already existing claim version through its
original guarded workflow. It creates no claim, approval, payable or repayment.
Use **My expenses** as the original volunteer or **Review** as organizer for
those independent actions.

Money tables distinguish original contribution gross and returns from current
restricted credit. Current credit follows the assignment journal. Unpaid
commitments subtract original collections, never current post-transfer credit;
accepted sponsor unpaid is an included subset. Paid expenses/fees, reservations
and available application credit stay distinct. Provider liquidity is explicitly
unchecked. Reconciliation failures produce unknown readiness, not zero funds.

## Request and API boundary

Contracts are in `lib/procurement/contracts.ts`, `access-contracts.ts` and
`uploads.ts`. All regular requests require `X-Fieldproof-Procurement-Scope`, bound
to the exact current tenant/project/actor/session/role/membership version/original
expiry, in addition to the ordinary project tab context. Commands bind that
header to `expectedScope`, use same-origin checks and strict bounded input.
Responses are private/no-store. Context and entry bootstrap deliberately omit
an old page's project header so a response that already wrote the original
cookie can recover safely.

| Endpoint family under `/api/procurement` | Function |
| --- | --- |
| `GET /context`, `GET /` | Current context and permitted desk. |
| `GET /{suppliers,quotes,sources,candidates}?before=…` | Signed scope/filter-bound pages of at most 20. |
| `POST /suppliers`, `POST /suppliers/:id/state` | Immutable supplier revisions/availability. |
| `POST /quotes`, `POST /quotes/:id/review`, `POST /quotes/select` | Exact source proposals, reviews and selections. |
| `GET /{suppliers,quotes}/:id/versions?before=…` | Retained version history. |
| `GET /quotes/:id/{source,preview}?version=…` | Reauthorized exact original source/page. |
| `GET /packages/:id`, `GET /packages/:id/{history,expenses}` | Permitted current detail, operational history and existing expense candidates. |
| `GET /history/:id` | Immutable original caller-scoped edition or withdrawn metadata. |
| `POST /responsibilities`, `POST /responsibilities/:id/state` | Current-member proposal and exact recipient response. |
| `POST /transitions/{prepare,commit}` | Current reviewed transition and exact immutable command identity. |
| `POST /progress`, `POST /exceptions`, `POST /exceptions/:id/resolve`, `POST /expenses` | Declared progress, reported issues and original claim links. |
| `/sources/uploads`, `/sources/uploads/:id/{renew,content,finalize}`, `/upload` | Existing canonical private-document ingestion; local binary path only for an explicitly isolated review profile. |
| `/invitations`, `/invitations/:id/{link,revoke}`, `/entry/{review,accept,restore,leave}` | Ordinary one-use volunteer entry, exact original return and explicit cookie leave. |

Per-tab pending command/entry/upload declarations are versioned and stored before
dispatch; source bytes and image URLs are not. Unknown outcomes retain the exact
intent and unchanged input. Same-intent replay returns only the original minimal
receipt under current authority. A changed payload, damaged stored request or
other profile cannot silently become a new attempt. New fragment links reset
visible identity while retaining older unknown attempts in a bounded journal.
Explicitly clearing local references sends no action and deletes no server
history. Org/supplier/contact identities are never inferred from these cookies.

All paged timestamp queries compare and order `date_trunc('milliseconds', time)`
plus stable ID, matching JS ISO cursors without altering original timestamps.

## Integration and qualification boundary

`lib/server/procurement-schema.ts` exports additive `PROCUREMENT_SCHEMA`,
`PROCUREMENT_TABLES` and `PROCUREMENT_GUARDS`. It does not initialize a project or
advance the shared schema marker. The integration owner must install the
additive schema after the scheduler schema and coordinate marker 23/readiness,
navigation and `/procurement` return allowlists. Existing financial/auth/evidence
writers require no mutation hook: procurement reads their canonical state and
keeps its own operations history separate. A home/read-model adapter must label
`fp_package_operations.state/version/cycle` as the **recorded operational** step;
it must not map that value into funding or qualified physical acceptance.

Review-profile local source storage must explicitly include the newly allocated
origin using existing planning storage guards. Blank-provider environments must
not enable Blob or other provider calls. No runtime, port, public fixture or
global migration is created by this unit.

The focused tests are `tests/procurement*.test.ts`. Pure/client/DOM controls run
with Node 22.22.3, locked dependencies and `node --import tsx --test
--test-concurrency=1 …`. Database tests deliberately refuse general/public
initialization: the controlled operator profile must identify restricted
`fp_governance_app` on loopback port 55571/database `fp_governance_stage13`, set
`FIELDPROOF_PROCUREMENT_TEST_ONLY=true`, disable providers and establish the
approved private runner environment. Each helper creates a new
`procurement_test_<UUID>` sole search path **before any server import**, initializes
only that schema and drops only that owned schema afterward. No public/frozen
fixture is borrowed. Synthetic Sample funding, supplier, source, credential and
physical decisions in these tests are expressly labeled controls, not actual
human participation, purchases or work.

The component suite exercises actual activeElement/Tab/Shift+Tab/Escape/error
focus and real request recovery, with only absent DOM platform primitives
supplied. It verifies all template layouts and cross-time-zone HTML equality.
Stylesheet measurements cover text/controls; mobile layout, zoom and real native
interaction remain browser qualification responsibilities.

## Minimum native journey after integration

1. Create an ordinary fresh **Sample makerspace** in the UI and retain its exact
   project, original organizer session and fixed deadline. Open Procurement,
   issue one real volunteer invitation, accept it in a separate context, and
   return to the original organizer through Saved workspaces. No role/actor
   chooser, replacement project or renewed session substitutes for this entry.
2. Propose Electronics responsibility to that exact joined profile. As the
   original volunteer, accept. Propose an explicitly fictional supplier and
   source estimate/original. Return to organizer; inspect declaration/quote
   revisions, compare sources, review the exact quote and select it, explicitly
   sharing only the permitted selected summary when desired.
3. Review the operational plan and procurement readiness. An ordinary empty
   Sample has no collected funding or accepted physical evidence; those gates
   must remain blocked. Any richer qualification setup needs separate root
   authorization, exact project binding, original-auth preservation and a
   one-shot clearly fictional evidence/funding journal. No public setup or
   fixture is included or authorized by this source unit.
4. Once actual scoped prerequisites/current canonical credit are established by
   their original authorized flows, the original volunteer reports work starting,
   records self-reported progress and requests work review. Verify that 100%
   alone leaves acceptance blocked. Use Planning's actual source association,
   qualification and scoped physical-decision flows for the required current
   cycle. Sample exercises establish no actual work or independent professional.
5. The original organizer reviews and commits operational acceptance. Inspect
   its exact immutable edition. Cancel/reopen with reasons and verify original
   funding/claim/physical rows remain unchanged while the new cycle requires
   responsibility and fresh physical decisions. Verify current-role/expiry,
   source-withdrawal, keyboard/mobile and lost-response states on the allocated
   frozen successor; service/DOM results alone are not a native pass.
