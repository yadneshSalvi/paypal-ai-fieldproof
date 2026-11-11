# Planning desk: source and native review

This checkpoint implements the private planning and physical-evidence workflow. Passing source tests does not establish actual model accuracy, independent inspection, safe equipment, or completed work. Project-member sharing here is separate from a public Proof Page. Finished public redaction/QR/revocation and A4/Letter Board Packs remain subsequent work.

## Isolated local review

The original local writer is retired. Do not start its port 4102 process or use its database for development. The existing Studio review on 4202 is independent.

```sh
# Once, with the existing OS-authorized local PostgreSQL administrator:
npm run planning:qa -- --prepare --local-admin
# Preserve this separate review database and its history:
npm run planning:qa -- --resume
```

Open `http://localhost:4502/planning`. The launcher validates a loopback PostgreSQL database named `fp_planning_qa_*`, with a dedicated unprivileged login. It refuses an occupied port. The mode-0600 ignored `.local/planning-qa/runtime.json` contains its connection and encryption secrets; do not print or publish it. PayPal and Blob credentials are disabled in the server child. The private local document adapter is unavailable in production. Actual model keys remain server-side. The separate `fieldproof_planning_qa_session` cookie leaves other local sessions intact.

```sh
npm run planning:qa -- --test
npm run planning:qa -- --build
```

Tests run in a disposable outer schema, with additional suite schemas where needed. Financial/model credentials in the test child are synthetic; fixture transports do not call providers. Production compilation uses `.next-planning-build`, and the live review uses `.next-planning-qa`. Neither commandeers the Studio process's build directory.

## Source, geometry and review journey

1. Use an existing authorized organizer workspace or explicitly create a fresh Sample organizer workspace. Import the four labelled fictional sources. They are a sketch, supplier quote, alignment illustration and reviewer-scope exercise. Their private raster previews carry content hashes and current permission versions. None documents an actual room, supplier, installation or credential.
2. Select the sketch and quote. An actual model extraction requires the provider consent below. Alternatively, start a manual drawing or explicitly use the hand-authored Sample draft; those do not claim model execution. Sample quote amounts are fixed by the fictional source and cannot inherit a changed package budget.
3. Inspect the exact page and citation regions. Edit the room, zones, walls, openings, package amounts, sources, capabilities and requirements. Drag a corner or use arrow keys; Shift moves farther. A drag is one Undo step. Unsaved edits survive tab changes; scope changes close private data and a conflict preserves a downloadable private recovery draft.
4. Save an immutable revision. Every revision binds source page hashes, permission versions, current package versions and geometry/content hashes. A restored historic version becomes a new revision. Model output cannot set its own review flags. Changing a source citation invalidates dependent source reviews.
5. Resolve invalid closure, crossed edges, concave-boundary escapes, overlapping zones, missing sources, unknown costs, unsafe prerequisites and pending package reviews. An unknown physical scale is permitted and displayed honestly. A changed quote amount cannot silently replace an approved financial package budget or donor consent.
6. Approve that exact saved revision, then separately share the reviewed plan with project members. Source withdrawal, package changes or publication withdrawal make dependent views stale. An old review remains history; it cannot authorize a different hash. Auditor and donor responses omit private originals and original source identifiers.

## Scenarios and physical evidence

The scenario solver closes the full prerequisite graph, rejects cycles and unknown references, and finds up to three feasible alternatives over at most twenty packages. A bounded integer maximum-flow allocation respects every funding pool's allowed packages. Prospective budgets are explicit hypothetical inputs. Observed funding derives canonical all-rail receipts and current funded rounds; uncollected commitments and restricted money from another package are unavailable. The result is a planning comparison and never a reservation, disbursement or provider-liquidity statement.

To associate an image, choose the exact current shared plan and zone. Place three well-spaced corresponding anchors in each view. Degenerate triangles, anchors outside the zone/crop and anchors covered by masks are rejected. Three-point affine interpolation is illustrative registration: its residual does not measure physical accuracy or prove an installation.

Crop and redact before sharing. Opaque masks are burned into a normalized metadata-stripped PNG, and the saved hash identifies those exact bytes. An organizer separately reviews and explicitly permits the rendition for project-member viewing. Private originals are not embedded in the shared response. Draft, withdrawn, stale and hash-mismatched renditions are denied, with a second authorization check after storage reads. The aligned overlay and comparison slider operate on the reviewed rendition.

Scoped credentials are different from inspection evidence. A reviewer submits their own credential source, requests a bounded competence and expiry, and an independent current organizer verifies it. Actual credentials cannot be self-approved. A scoped decision then requires the exact plan version, current qualification version, separate inspection/sign-off source, observation time, statement and limitations. A photograph or receipt alone cannot satisfy acceptance. Sample-only exercises retain conspicuous disclosure and do not claim qualified real work.

Organizers may create a single-use expiring private reviewer link for selected competences. The link grants a separate twelve-hour volunteer session and no financial or organizer authority. Its token is hashed for lookup, encrypted at rest, shown only at creation, passed in a URL fragment and cleared after redemption. Delivery remains the organizer's choice; the app sends no message. Expiry, issuer role changes, nonce conflicts, another scope and revoked access are checked. Revocation invalidates dependent current review authority.

Physical readiness requires all current requirements and recursively accepted prerequisites. Laser use requires accepted Safety & Ventilation work, ventilation/electrical scopes and laser safety acceptance. Funding completeness is a separate fact; provider liquidity remains `not_checked`. Native Studio uses the current reviewed geometry, requirement counts and redacted evidence, and keeps its canonical money totals unchanged. Withdrawing a plan removes its current geometry/acceptance contribution instead of falling back to seed acceptance.

## Actual model boundary and consent

Layout models use server environment configuration. OpenAI defaults to `OPENAI_LAYOUT_MODEL` or `OPENAI_MODEL`; its frozen input includes `OPENAI_LAYOUT_REASONING_EFFORT` or `OPENAI_REASONING_EFFORT` (default `max`). Gemini uses its own configured layout/model name. Each run retains provider/model, prompt/schema/input hashes, source versions, original authority, actual token counts when returned, and encrypted output/attempt diagnostics. No hidden reasoning is recorded or displayed.

The OpenAI checkbox reads:

> Send these selected private pages to OpenAI to propose geometry and source links. OpenAI runs this in the background and temporarily retains the response for polling (roughly 10 minutes); long-term response storage is disabled.

The server submits Responses with `background: true`, `store: false`, no automatic SDK retries and a 45-second transport timeout. It persists the response identity encrypted before attempting continuation. Subsequent work only retrieves that identity. Each invocation has a durable lease; the application recovery deadline is twenty minutes and cannot extend the provider's own availability. Source/role/session authority is rechecked before a read and before committing usable output. A source response may complete without becoming an approved plan.

The one-minute authenticated planning cron resumes at most five known responses and dispatches at most one already-consented queued OpenAI job. Visible organizer workspaces also resume saved responses. An interrupted submission with no response identity is ambiguous and never automatically re-dispatched. Transient GET failures preserve the same identity; expired retention, revoked authority and late output remain recorded without becoming a current proposal. Gemini retains its bounded foreground transport and is separately unqualified for this new layout workflow.

A deliberate new inference after an ambiguous/failed current-contract attempt requires this separate checkbox:

> Start a new provider attempt for these sources. The earlier request may have been processed; this can incur a separate model charge.

The original foreground attempt timed out after 240,021 ms with `Request timed out.`, no HTTP status, response identity, tokens or usable output. It remains retained and indeterminate; there is no evidence it was not processed. The durable transport has a new frozen execution revision, so it cannot overwrite that attempt. One new extraction was explicitly started through the source selection/consent UI and completed in 263,226 ms, with 8,383 input and 17,995 output tokens. It made one submission and sixteen status reads of the same response. Sources navigation and full page reload preserved attempt 1; no unseen retry occurred.

OpenAI's current [background documentation](https://developers.openai.com/api/docs/guides/background) describes temporary polling retention with `store: false`. The implementation does not infer successful service execution from documentation or fixtures.

## Qualification and remaining gates

The isolated source checkpoint passed 267 tests across 40 suites, zero skipped, and an optimized production build including TypeScript. New coverage includes geometry and prerequisite invariants, immutable plan/source authority, masks and shared-image races, reviewer scope and revocation, Studio financial invariance, and durable transport loss, timeout, late output and retention expiry. The initial full-suite failure from deliberately disabled financial fixture settings is retained privately; the test-only child now uses synthetic configuration. See [the sanitized source record](evidence/planning-source-qualification.json).

The native review against source `104ddc426c3e9c00b90c8e123b198409edd16cda` passed the following checks. No runtime source correction was needed during this review:

- All four fictional sources imported; full sketch and quote previews, hashes and permission labels inspected. The actual model returned six zones, six matching amounts and nineteen citations, with valid geometry and an honestly unknown scale. All twelve zone/package decisions remained pending until explicit review.
- Keyboard corner movement and Undo/Redo restored the original coordinate. Saved/reviewed/shared revision 1 retained its exact content hash. Restoring its content created an unapproved manual draft revision 2; shared revision 1 stayed current and retained the original actual model lineage.
- A prospective $6,000 scenario returned feasible $5,660, $4,460 and $5,160 alternatives. The full $8,410 plan did not fit; the laser safety prerequisite remained.
- A mask covering an anchor was rejected by the server with a visible warning. A corrected opaque mask was inspected in the exact saved PNG, with its Sample watermark and three anchors, then explicitly reviewed for member sharing. Keyboard Home moved the comparison control to 0%.
- A labelled Sample Equipment reviewer exercise used the page marked NOT A CREDENTIAL and explicit fictional/automated limitations. It grants no claim of real qualification. No physical sign-off or external reviewer invitation was recorded.
- Donor role cleared private drafts/selections and excluded the private source tab, image composer and review note, while showing the sanitized reviewed rendition.
- Studio displayed current shared revision 1 and its six zones, unchanged Sample $2,125 collected / $8,410 budget / $4,915 committed. One of fourteen requirements came from the image association; there were zero physical sign-offs and laser prerequisites remained unresolved. Drill-through disclosed the illustrative, Sample, nonfinancial scope.
- At 390 × 844, document/client width was 390 with no horizontal overflow. The boundary dialog fit at 368 × 630.5 with scroll width 366; keyboard Enter opened it and Escape closed it. An observed asynchronous navigation subsequently reached `/planning`; no navigation defect was established.

Actual native receipts and hashes are in [the qualification record](evidence/planning-native-qualification.json). This is targeted native qualification with fictional inputs, not a held-out model benchmark, full accessibility audit or independent physical inspection. Browser automation cannot stand in for a named independent human's real credentials or physical work.

## Hosted handoff

Root owns this deployment and every original provider action. The qualified runtime is source `104ddc426c3e9c00b90c8e123b198409edd16cda`, code/config/test/vendor fingerprint `45035efd3602fde44ef37179ccff473e1effbb91871136985de05bf117b12a14`. A subsequent documentation-only commit may contain these native receipts without changing that runtime. Preserve the exact archived source or verify the same fingerprint before promotion.

1. Keep the retired local writer off and the original deadline/obligations unchanged. Use the established held-deployment and backup procedure in [the cutover guide](workspace-cutover.md). Do not import the local QA workspace or its secrets. Legacy transfer tooling describes the original transfer contract; it is not a general transfer of later Studio/Planning histories.
2. Retain the hosted database, encryption secret, private Blob and isolated provider configuration. Production must use private Blob storage; local QA flags and runtime files do not belong there. The observed layout configuration was `gpt-6.1-sol` with `max` reasoning. Layout-specific environment names may override the existing model names; keys remain server-only.
3. Use the new release's normal cold initialization or `initializeDatabaseAt` against the explicitly selected hosted connection. Schema 11 is additive: thirteen Planning tables and model checkpoint columns, with no change to original package versions or financial rows. Verify version 11, `fp_plan_provider_observations`, the three checkpoint columns on `fp_plan_runs`, and retained original/Studio histories before resuming. Busy migration returns a bounded retryable 503; do not bypass it or replay the old workspace import.
4. Qualify normal authenticated Planning reads, denied unauthenticated/cross-role/private-original access, current original claim/obligation totals and sole-writer state. A fresh controlled Sample session may exercise the new page while preserving the original claimant's browser identity. Verify production private-source upload/raster/preview and the reviewed masked rendition; native local storage checks do not establish hosted Blob behavior.
5. Verify the new `/api/cron/planning` schedule and existing `CRON_SECRET` authentication. The schedule is every minute; unauthorized requests must fail. It polls at most five already-known response identities and submits at most one previously consented queued OpenAI run. With no Planning jobs queued/running, expect zero resumed/submitted/expired. `/api/cron/evidence` retains receipt work and also handles queued plan work; leases prevent duplicate claiming. Both honor maintenance holds. A known response status read never authorizes another inference.
6. An actual hosted model request, if chosen by root, still uses explicit native source consent and retains its own receipt. Do not claim hosted durable polling or browser-close continuation from the local run alone. Preserve the first failure, exact hashes, current authority, fixed retention/recovery bounds and all original provider states through the check.

For a controlled HTTP Sample check, use a fresh private cookie jar and the matching Origin. Create `POST /api/session {mode:"sample"}`, then `/api/session/role {role:"organizer"}`. Import `/api/planning/sources/sample` with `{intentId,sampleAcknowledged:true}`. It returns `{workspace}` with bound source IDs and current package versions. The pure `samplePlan(sketch.id,quote.id,workspace.packages)` in `lib/planning/templates.ts` builds the explicitly hand-authored fixture; after checking its source amounts, mark its zone/package reviews for this disclosed automated exercise. Save with `{intentId,expectedVersion:workspace.headVersion,plan,origin:"sample",sourceRunId:null}` to `/api/planning/save`. Each write returns a refreshed workspace: use its current `headVersion`, `current.id` and `current.contentHash` for `/review`, and its returned `current.review.id` for `/publish`. Exact strict request fields are in `lib/planning/contracts.ts`. Do not import the database-writing test helper into hosted qualification. This check creates no model request or financial action.

Hosted schema/Blob/cron/model qualification is a separate root-owned gate. The local source lead made no hosted database change, deployment, financial request or outreach.

Full Fieldproof remains active: original same-obligation recovery and all-rail funding/repayment/refund evidence; general funding and donor cancellation/reallocation/rollover; capped matching, grants, membership/portfolio; actual owned Toolkit reads and dependency hardening; reviewed public Proof Pages/QR/revocation and real A4/Letter Board Packs; garden/mutual-aid templates; source-bound English/Spanish and fluent review; held-out/adversarial evaluations; broader accessibility/performance; authorized participant research or clear disclosure of its absence; measured rehearsals, film and final controlled deployment.
