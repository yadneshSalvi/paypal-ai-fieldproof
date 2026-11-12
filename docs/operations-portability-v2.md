# Current operations and portability v2

This operator workflow restores one entire held PostgreSQL namespace into an explicitly fresh restricted destination. It preserves original IDs, private bytes, immutable history, credential hashes and deadlines. Planning, apply and verification never activate execution, create a replacement account, renew access, reconcile an uncertain financial operation, send a message or authorize retention deletion.

## Versioned coverage and historical evidence

The current profile is schema 24, PostgreSQL 18, based on joined application input `ddadae2c259ce874ab760b1f9f133cf653021e85`. Its explicit registry contains **177 tables, 28 stored functions and one original event sequence**, including empty tables. The full normalized catalog hash is:

```text
aa7168ab4953d862c9ddc790e6db5616c2bec0281089b603ea1a1502bca2b0da
```

The marker set is `1..15,17,18,19,20,21,22,23,24`; marker16 is not inferred. `lib/operations/current-registry.ts` admits exact names, primary keys, private columns and the complete catalog. It checks FK dependencies, constraints, indexes, functions and original user/internal trigger modes. Unknown, missing, duplicate, older or later families refuse before domain-row capture. Plan/apply do not initialize an older namespace or manufacture backfills.

| Profile input | Coverage | Preserved qualification |
| --- | --- | --- |
| Historical v1 transfer | Original 47 tables / 276 original rows | Existing `lib/server/workspace-transfer.ts`, its source CLI, tests and historical cutover evidence remain unchanged. This was a particular cutover, not general current portability. |
| Frozen schema 21 v2, application `0fdd33d5abe11fb921124b4fc085ee292619dd0f`, implementation `dbafefabb00e22e371d0af89393584010f164b78` | 137 tables | 41 focused controls, original private evidence and source remain frozen. Catalog `54acfbd8fd9887c1fb3517912748cce1929de947b02b9248c99a07a079ada175`. |
| Current joined schema 24 v2 | 177 tables |One separate catalog control and 18 new-family restore controls. The frozen41 were reused, not rerun. |

The schema 24 binary refuses schema 21 bundles. The frozen schema 21 implementation remains the qualified reader for its exact original catalog; any real migration or cutover remains separately reviewed by the root operator. A bundle's format, schema version, application input commit and complete catalog hash bind its compatibility. Merely adding a table or registering a marker cannot enable another profile.

The 40 explicitly admitted extensions are in `lib/operations/extensions.ts`:

| Family | Tables | Exact qualified fragment / source SHA-256 |
| --- | --- | --- |
| Lifecycle22 |17 |`8bfeada4a1bf0aabf5232b2c3d0d3e0932270d7b`; `33e87485d4287ea94ef95dd7c0504e0b2ffd01be50147376955756402bc8a5d0` |
| Procurement23 |19 |`5613284a23cb9435433c224a82a2fae4140ab856`; `7b8c0ffeeb76e56734b506c29bfd32b7f55ced665b7e29e0dbc69d59c723ad39` |
| Recognition24 |4 |`a75d65696326b3dd2a1fff026409de8e72d1b2fa`; `a71c73a6a4fd7df98f22898da9445db62f7d17cd8c0a122166b254f8a2545c67` |

A future `CoverageExtension` must declare every table/key, dependency, private codec, artifact binding, exact catalog and source/test/restore receipts. The current pending list is empty because22/23/24 are integrated and qualified here. No future family is admitted by prefix, wildcard or inferred compatibility.

## Original lineage and restore order

Catalog and rows are read in bounded batches under one coherent repeatable-read transaction. All table locks precede its first MVCC query. Source plans acquire SHARE locks; apply acquires every target table ACCESS EXCLUSIVE. PostgreSQL JSON row text is retained verbatim, with bigint/numeric columns encoded as decimal strings. Nested payment/history JSON is not reserialized for insertion. Bounds are250,000 rows and 128MiB of original row text; exceeding a bound refuses the operation instead of omitting rows.

The exact frozen 137-table base is restored first in its immediate FK and self-reference order. The 40 new tables then follow their explicit FK order. This phase boundary also preserves application-encoded dependencies: the lifecycle preference-head scope guard needs the original project membership even though its actor join is not a SQL FK. Deferred head/current-version cycles stay deferred until all originals are present, then all constraints are made immediate before final comparison.

Within the new families:

- Personal heads precede immutable preference versions, captured inbox items and read/archive events. Programs precede schedule definitions and their exact due occurrences; attempts, snapshots, content and reviews retain each occurrence's original frozen cutoff and hashes.
- Suppliers precede every supplier version and quote/version. Final package-operation heads precede **all** historical operation events. Invitations precede original independent volunteer access. Responsibilities, selected quotes, progress, exceptions/resolutions and exact claim revisions retain their original project/package/cycle and private bindings.
- Recognition heads/consents use their original deferred cycle, followed by commands and audits. Complete command receipts cover consent, withdrawal, a later separate consent and suppression; consent version numbers are not incorrectly required to be consecutive across withdrawal/suppression decisions.

Independent validators authenticate the original AAD encryption contexts and immutable content/source/input hashes, complete version/attempt histories, source-document scope and private artifact lineage. Preference grants retain exact original recipient/session/role/member version/token/deadline. Scheduled grants retain original organization/project credentials, reviewed definition, cadence, immutable disclosure revision and expiry. Historical recognition retains its exact original session token, independent entry, proof edition, acknowledged label, command and suppression handle.

A later mutable session role, membership role/version/state, source withdrawal or proof-head replacement does not invalidate the existence of legitimate historical records. Recorded role/version is checked against preserved original encrypted payload and lineage; it is not replaced with current eligibility. Application reads still apply current original authority and source permission. Restoring a private captured body does not make it readable, exportable or public after withdrawal/expiry.

## Narrow fresh-target historical exceptions

`lib/operations/restore-guards.ts` has an exact 21-trigger allowlist. It may open only inside the import transaction after the actual target is verified fresh, restricted and held, with all 177 exclusive locks and the same namespace/role. Every original mode is pinned as `O`:

- `fp_org_session_retained`: original expired/revoked organization sessions retain exact membership identity and deadline.
- `fp_lifecycle_inbox_scope`: an original immutable inbox role may differ from a later mutable session role; its original encrypted preference/recipient/session/deadline is independently verified.
- The 17 procurement `<table>_scope` guards, excluding responsibilities and exceptions: current issuance/current-head assumptions cannot reconstruct historical final heads and every old event.
- `fp_recognition_consent_lineage` and `fp_recognition_command_lineage`: current participant authority/current publication cannot reconstruct older acknowledged decisions.

**All FK, check, deferred head/current-version/history, retention, update and transition guards stay enabled.** No source guard is suspended. The exact original trigger modes are restored before final catalog/row comparison and commit. SQL failure or a crash rolls back both insertion and transactional trigger metadata. Ordinary issuance after restore still rejects expired/revoked original authority. There is no application issuance bypass or request endpoint for this operator window.

Sequence restoration uses transactional `ALTER SEQUENCE ... RESTART` and the original `is_called` behavior. It avoids nontransactional `setval`. [PostgreSQL sequence documentation](https://www.postgresql.org/docs/18/sql-altersequence.html).

## Execution control, private files and permitted deltas

Every source row, including outbox, webhook, payment/provider attempts, pending/unknown outcomes, leases, admission counters, lifecycle retries/running attempts, observer cursor/lease and original access/recognition state, is copied unchanged. No lease is deleted/renewed, no pending status is changed to review, and no uncertain work is replayed.

The source execution-control row remains in the private audit manifest. The destination retains its own explicit execution hold. Exactly three table families may differ:

1. `fp_runtime_control`: the target's held row receives the reviewed reason and `max(original,target version)+1`.
2. `fp_runtime_control_events`: exact original history plus the target's original setup-hold event and one import-hold event.
3. `fp_workspace_imports`: exact original import history plus this immutable v2 audit/receipt.

The receipt reports176 original-row families and174 identical whole tables, not an all 177-tables-unchanged claim. A separate activation-review manifest identifies retained pending financial, provider, webhook, upload, worker and new lifecycle/access records. Root must deliberately reconcile and choose one destination before any execution is released. Keep the source held while that review remains incomplete.

Source and destination explicitly bind the same original application encryption key and merchant identity. Fingerprints and actual ciphertext authentication prove compatibility; the tool never copies an environment file or reseals originals under a replacement key. Private artifacts retain exact original bytes, path, content type, size, hashes and document/page bindings. The destination adapter must actually serve the original locations. A source upload may be absent only when the original draft still awaited upload and its unchanged upload grant has ended, with explicit absence recorded.

The qualified CLI adapter uses symlink-free existing private-files roots, directories 0700 and files 0600. Staging uses exclusive creation or exact-byte reuse and a bundle-bound recovery journal. It refuses conflicts, unbound original bytes, omitted pages, unrelated orphan files and another bundle's partial stage. Hosted private-store readers remain a separate typed integration gate; no successful local filesystem restore proves a hosted reader or physical backup recovery. Private bundles/plans/receipts are encrypted and purpose-bound. Operator logs show bounded hashes/counts/status, not original IDs, provider URLs, tokens or private body text.

## Operator procedure

These are concrete operator steps, not authorization to execute a production cutover. Root owns production/hosted operations and activation.

1. Select the exact qualified source and fresh destination schema/catalog. Do not point the tool at an unknown, older or nonempty namespace. Only explicit guard/setup creates a fresh destination; plan/apply never create one.
2. Hold source execution. Drain original request/worker/provider leases and outstanding upload grants. Keep pending/unknown financial records intact for separate reconciliation.
3. Preserve and privately verify the source backup. A backup review binds exact source identity, catalog, row and sequence hashes, actual backup byte hash/length and reviewed recovery evidence. Synthetic test backups are labelled `synthetic-qualification`; they do not establish actual physical/hosted recovery.
4. Initialize the separate fresh restricted destination through the separately approved setup, then apply its single explicit operator hold. It must contain only qualified markers, its held version2 execution row and one matching setup event. No consumed sequence, existing actor, import or conflicting artifact is eligible.
5. Create the private 0700 operator directory and private 0600 configuration below. Supply compatible original encryption/merchant/artifact bindings explicitly. Never use an environment pull, shell-sourced file or redacted placeholder as actual configuration.
6. Run basis/export/plan. Review the exact plan hash, original coverage/private artifacts, destination restrictions, backup provenance, permitted deltas and activation manifest. Planning is read-only.
7. Run apply once with that exact reviewed hash. On a lost response, inspect/retry the same original bundle and plan. An exact committed retry returns its original receipt without another insert, exception window, renewal or restaging.
8. Run verify. Keep both namespaces held. Root separately reviews actual provider outcomes, pending work, hosted readers, backup recovery and one-destination activation/repair-forward policy.

Example configuration shape (all values are explicit operator inputs; no environment secrets are copied):

```json
{
  "format": "fieldproof-workspace-operator/v2",
  "source": {
    "databaseUrl": "postgresql://restricted-role:PRIVATE-PASSWORD@127.0.0.1:5432/source-db",
    "schema": "explicit_source",
    "label": "reviewed original",
    "authSecret": "ORIGINAL-PRIVATE-ENCRYPTION-KEY",
    "merchantClientId": "ORIGINAL-MERCHANT-BINDING",
    "artifacts": { "kind": "private-files", "directory": "/absolute/private-source-artifacts", "namespace": "original-private-artifact-namespace" }
  },
  "destination": {
    "databaseUrl": "postgresql://restricted-role:PRIVATE-PASSWORD@127.0.0.1:5432/destination-db",
    "schema": "explicit_fresh_target",
    "label": "reviewed fresh target",
    "authSecret": "SAME-ORIGINAL-PRIVATE-ENCRYPTION-KEY",
    "merchantClientId": "SAME-ORIGINAL-MERCHANT-BINDING",
    "artifacts": { "kind": "private-files", "directory": "/absolute/private-target-artifacts", "namespace": "original-private-artifact-namespace" }
  }
}
```

Each URL has a sole explicit schema search_path. Remote connections require `sslmode=verify-full`. The destination role/schema must have no elevated role flags, PUBLIC namespace access or other-role namespace grants. Full configuration keys are closed and versioned; arbitrary connection/environment options are refused.

Run each command from the explicit absolute checkout directory, with Node 22 and dependencies already installed without install scripts:

```sh
node --import tsx scripts/workspace-transfer-v2.ts coverage
node --import tsx scripts/workspace-transfer-v2.ts basis --config /absolute/private-cutover/operator.json --out /absolute/private-cutover/basis.json
node --import tsx scripts/workspace-transfer-v2.ts export --config /absolute/private-cutover/operator.json --backup /absolute/private-cutover/backup.private --backup-review /absolute/private-cutover/backup-review.json --out /absolute/private-cutover/bundle.sealed.json
node --import tsx scripts/workspace-transfer-v2.ts plan --config /absolute/private-cutover/operator.json --bundle /absolute/private-cutover/bundle.sealed.json --reason "Restore reviewed originals and retain execution hold" --out /absolute/private-cutover/plan.sealed.json
node --import tsx scripts/workspace-transfer-v2.ts apply --config /absolute/private-cutover/operator.json --bundle /absolute/private-cutover/bundle.sealed.json --plan /absolute/private-cutover/plan.sealed.json --review-hash EXACT-REVIEWED-PLAN-HASH --out /absolute/private-cutover/receipt.sealed.json
node --import tsx scripts/workspace-transfer-v2.ts verify --config /absolute/private-cutover/operator.json --bundle /absolute/private-cutover/bundle.sealed.json --plan /absolute/private-cutover/plan.sealed.json --receipt /absolute/private-cutover/receipt.sealed.json
```

## Observed schema 24 qualification

The transport-denying runner `tests/helpers/operations-v2-complete-runner.ts` pins joined initializer/schema bytes before DB use, refuses existing global DB caches and accepts only owned focused suites. It admits only the already owned local PostgreSQL role/database, creates two new UUID namespaces and proves their sole search_paths before application import. HTTP, TLS, UDP, DNS and other raw sockets are denied. All suites register under one awaited `describe` parent; its cleanup drops only the exact two created namespaces. It never reads frozen public fixture rows or changes an existing runtime/schema marker.

The first catalog-only run observed two equal 177-table / 28-function catalogs. Removing only the 40 new tables, 16 new functions and their incoming RI trigger edges reproduced the frozen 137-table catalog hash exactly. That receipt is distinct from actual restore evidence.

The final focused run passed **18/18** new controls in 14.46 seconds. It populated all40 new tables, restored180 original rows across176 original-row families, compared174 whole tables and the original sequence exactly, preserved the source's 181-row/catalog/sequence hash, restored every trigger to original `O`, and left the target held. Real FK failure and a crash after all originals inserted each restored the original empty target/control/catalog/sequence. Historical role/member/proof/source changes, original fixed expiry, complete histories, closed coverage, private hashes/bytes, read-only withheld views, stable retry and refused ordinary issuance were exercised. No provider, model, email, runtime request or production transfer ran.

The first fixture used a free-text suppression reason instead of its declared enum and failed before export/restore; that evidence remains retained. A later 13-pass / 5-failure run exposed an application-encoded restore-order edge: preference heads were eligible before membership rows. The explicit frozen-base-before-new-family phase fixes that dependency while preserving every guard. Both failures and their scoped repairs remain private evidence. No original timestamp was edited; new synthetic deadlines were derived in transaction-local UTC and allowed to expire under the real database clock.

The frozen schema 21 suite's 41 controls remain its historical proof. They were not replayed for this additive qualification. Physical backup recovery, hosted private artifact reading and an actual local/hosted workspace cutover are root-owned external operations, not claimed by the synthetic proof.

## Dated dependency and license inventory

`operations-review-v2` defaults to an offline lock/provenance/license/retention inventory. Explicit `--security official-registry` adds bounded read-only official npm Bulk Advisory and GitHub Advisory API queries for the exact lock. It saves request/response/lock hashes, excluded nonregistry distributions, precise affected instances/ranges and every upstream confirmation. It never runs install scripts, changes a package or treats unavailable upstream data as zero findings. [npm audit data and interpretation](https://docs.npmjs.com/cli/v11/commands/npm-audit/).

```sh
node --import tsx scripts/operations-review-v2.ts --out /absolute/private-review/operations.json
node --import tsx scripts/operations-review-v2.ts --out /absolute/private-review/current-security.json --security official-registry
```

The 12 November 2026 baseline lock at `ddadae2` (`0729b7577e923f0395e9af96f9ea546b28bb65d0f806cefc29e3d0f14aff048e`) has 489 locked instances, 9 affected instances across 8 names and 12 distinct advisory records. A fresh-process probe executed the official OpenAI Toolkit and Fieldproof's actual `get_order`/`get_invoice` reader through synthetic transport. Toolkit Zod 3 and mathjs loaded; the exact core/LangSmith/uuid/AI 4/provider-utils2/jsondiffpatch instances were absent from that selected path. The unchanged official CJS entry hash is `4bc5b11ffeeed7241e18431551c80ed0719fe18809192c7c0d2d5f217927e532`. A module-load observation does not make installed affected packages patched.

Lead-owned remediation input `8aebb608b46fbecb2ee5db7f793478ef54024a2d` retains official Toolkit 1.11.0 and pins its core 0.3.80 / mathjs 15.2.0 plus core's LangSmith 0.6.0. Exact lock hash: `f0d2287a3732b88d07521ebbde3fda34116cc3855be34202a2bd8b202f4f1f33`. The independently queried exact lock has **488 locked instances;6 affected instances across5 names;6 distinct advisory records;7 instance/advisory matches**, with every GitHub confirmation complete. These are underlying advisory/instance counts, not npm's propagated package-finding count or a security clearance.

| Remediation | Original advisory / version | Exact bounded decision |
| --- | --- | --- |
| Core serialization |Core 0.3.6, [GHSA-r399-636x-v7f6](https://github.com/advisories/GHSA-r399-636x-v7f6) |Core 0.3.80 fixes the 0.3-family advisory, overriding Toolkit's exact 0.3.6 pin. |
| LangSmith history |0.1.68, [prototype pollution](https://github.com/advisories/GHSA-fw9q-39r9-c252), [streaming redaction](https://github.com/advisories/GHSA-rr7j-v2q5-chgv), [prompt deserialization](https://github.com/advisories/GHSA-3644-q5cj-c5c7) |0.6.0 removes those matched IDs. It is outside core 0.3.80's declared `^0.3.67`; local focused qualification is required. A core-only 0.3.87 resolution was rejected and retained as failed evidence. |
| mathjs |14.9.1, [GHSA-29qv-4j9f-fjw5](https://github.com/advisories/GHSA-29qv-4j9f-fjw5), [GHSA-jvff-x2qm-6286](https://github.com/advisories/GHSA-jvff-x2qm-6286) |15.2.0 removes both matched IDs. It is outside Toolkit's `^14.0.1`. The selected reads do not invoke the bundle's create-order `round` path; local compatibility still needs qualification. |

The official registry still identifies Toolkit 1.11.0 as latest on the review date; no newer patched Toolkit release was inferred. [Official Toolkit adapter documentation](https://github.com/paypal/agent-toolkit/blob/main/typescript/README.md).

| Retained package / current locked version | Affected range and first patched release | Current exposure/compatibility boundary |
| --- | --- | --- |
| Zod 3.25.76, two nested copies |`<4.6.6`; [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), patched4.6.6 |Toolkit's copy loads for fixed static schemas/conversion. Latest Zod 3 is 3.25.76; forcing Zod 4 violates parent contracts. Fieldproof's external strict bounded scalar schemas use root 4.6.7. |
| `@ai-sdk/provider-utils`2.2.8 |`<3.0.28`; [GHSA-866g-f22w-33x8](https://github.com/advisories/GHSA-866g-f22w-33x8), patched3.0.28 |Latest 2.x remains 2.2.8. The selected OpenAI read path does not import this adapter; a future provider-family migration requires qualification. |
| `ai`4.3.19 |`<5.0.52`; [GHSA-rwvc-j5jr-mgvh](https://github.com/advisories/GHSA-rwvc-j5jr-mgvh), patched5.0.52 |Latest 4.x remains 4.3.19. The selected reads import no AI 4 adapter or filetype/upload path. |
| `jsondiffpatch`0.6.0 |`<0.7.2` [HTML formatter XSS](https://github.com/advisories/GHSA-33vc-wfww-vjfv); `<0.7.6` [patch prototype pollution](https://github.com/advisories/GHSA-j4fx-xxwh-2485) |AI 4 pins 0.6.0 exactly. No unsupported 0.7 substitution is claimed. Its formatter/patch APIs were absent from the selected read-path load receipt. |
| uuid10.0.0 |`<11.1.1`; [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), patched11.1.1 |Core declares `^10.0.0`; no blanket major override. The affected buffer-taking v3/v5/v6 APIs are not exposed by Fieldproof's bounded read input. |

The original Fieldproof transport bounded content only after Axios buffered it and used a 25-second Promise race without aborting the request. The separately owned Toolkit transport successor supplies the exact native factory/scoped transport, redirect/abort/stream bounds and focused tests. Its final patched-tree execution/module receipt is a separate integration artifact; the transfer proof does not claim those unintegrated checks. An exact-byte private factory executes outside `require.cache`; its execution/source-hash receipt must be recorded separately from normal dependency-cache entries.

Registry-name security coverage explicitly excludes vendored `@fracture/paypal-core`0.2.7 and the distinct Git-pinned APIMatic `paypal`2.29.0 at `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`. Their source/provenance review cannot be replaced by a same-name registry query. The Toolkit, its PayPal server SDK dependency and that APIMatic package are distinct integrations.

The patched 488-instance lock declares four Commercial packages: `ag-charts-enterprise`14.3.0, `ag-grid-enterprise`36.3.0, `ag-studio`3.1.0 and `ag-studio-react`3.1.0. It also declares 14 LGPL-containing optional Sharp/libvips platform entries, three OFL fonts and one CC-BY caniuse dataset, with zero undeclared licenses. These are declarations, not entitlements or legal clearance. No license key or contract value was read. AG Studio's official license description distinguishes its included Grid/Charts from standalone Enterprise use outside Studio. [AG Studio licensing](https://www.ag-grid.com/studio/javascript/enterprise-licence/), [official EULA](https://www.ag-grid.com/studio/licenses/ag-studio/LICENSE.html).

## Retention and remaining operator gates

Retain original financial/provider attempts, source facts, private artifacts, actor/session/access/invitation/consent deadlines, immutable version histories/hashes, withdrawal controls, runtime/admission/cron history, backup evidence and import receipts under an explicitly chosen operator retention policy. Expiry/withdrawal changes access, not historical truth. No cleanup, lease pruning, source-body deletion, credential renewal or financial rewrite is authorized here.

The finite 22/23/24 portability extension is now qualified for its exact joined catalog. Any subsequent schema, private codec, artifact location or source-guard change requires a new explicit profile/restore qualification. Actual hosted artifact-reader compatibility, physical backup recovery, production cutover, one-destination activation, final patched Toolkit transport evidence and commercial license entitlements remain separately owned integration/operator gates. None is implied by successful synthetic restore or a lockfile inventory.
