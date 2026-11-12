# Current operations and portability v2

This is an operator restore of an entire held namespace. It preserves original records and their authority deadlines. It does not create an account, issue a recovery grant, reconcile an uncertain payment, release a hold, run a scheduler, or authorize retention deletion.

The qualified application base is `0fdd33d5abe11fb921124b4fc085ee292619dd0f`, schema 21 on PostgreSQL 18. The existing version 1 project transfer, its 47-table contract, and its historical evidence remain separate and unchanged. A v1 bundle is not a v2 bundle.

## Coverage and lineage

The explicit registry is `lib/operations/current-registry.ts`. It admits exactly 137 tables, including empty tables. The normalized catalog hash is `54acfbd8fd9887c1fb3517912748cce1929de947b02b9248c99a07a079ada175`.

| Current family | Tables |
| --- | ---: |
| Core workspace, original financial/provider, document and transfer history | 49 |
| Runtime control, request leases and hold audit | 3 |
| Board Pack | 2 |
| Community and cross-project workspace library | 14 |
| Funding cancellation and donor choice | 5 |
| Funding reconciliation and return history | 6 |
| Funding assignments and deductions | 2 |
| Organization, project governance and portfolio | 20 |
| Planning, evidence and reviewer access | 13 |
| Proof | 3 |
| Purpose pledges and sponsors | 5 |
| Studio | 6 |
| Supporter access | 4 |
| Payment core | 5 |
| **Total** | **137** |

The contract pins columns and types, primary keys, foreign keys and deferral, checks, indexes, trigger definitions and enabled modes, function bodies, sequences, and the supported PostgreSQL major version. Physical namespace names and allocation OIDs are normalized. Namespace identity, owner/restricted-role facts and access grants are bound separately. Missing tables/keys/columns, unknown tables/views/types/functions, disabled guards, extra schema markers, and unsupported older catalogs stop the operation before domain rows are selected. Transfer never initializes or backfills a catalog.

The reviewed marker set is `1..15,17,18,19,20,21`; there is no inferred marker 16. Typed `CoverageExtension` requirements exist for lifecycle 22, procurement 23 and recognition 24. All three remain **unintegrated and unqualified in this contract**. They require an explicit complete new catalog, keys, dependency graph, private-source codecs/artifact bindings and restore receipts after integration. Merely supplying a fragment cannot enable it.

Whole-namespace scope is deliberate: organization and workspace libraries can connect multiple projects. A project filter would silently omit that lineage. Original foreign keys and application relationships are verified before target mutation, including exact organization/member/session identity and session deadline no later than its original membership deadline. Current membership state is not substituted for historical state.

Rows retain their original PostgreSQL JSON text. Bigint/numeric SQL columns are represented as decimal strings; nested JSON text is never parsed and reserialized for insertion. IDs, event sequence numbers, provider request/effect identities, original hashes, ciphertext, timestamps through microseconds, consent/invitation/access deadlines, revocation and immutable financial history are preserved. Existing payment-operation encodings are authenticated with their actual identity context. Unknown nested ciphertext has no fallback codec.

## Deliberate destination deltas

Every source row outside `fp_runtime_control` is copied exactly. 134 whole tables remain identical. The original rows in `fp_runtime_control_events` and `fp_workspace_imports` remain exact while those two tables receive the explicitly declared audits below. Thus 136 table families retain their original rows with the declared control and audit deltas.

The only deltas are:

1. The destination's `execution` row remains held, with the reviewed reason, import timestamp and a version above both original and fresh-target versions. The original source control row is retained in the encrypted bundle and v2 import audit.
2. The fresh destination's single setup-hold event remains, and one import-hold event is added. Original source control history is copied unchanged.
3. One v2 import audit is added to `fp_workspace_imports`, using an actual original project as audit anchor and an empty `handoff_ids` array. Its manifest binds the bundle, reviewed plan, original control, backup and activation review.

Outbox/webhook/provider/payment rows, resource locks, admission counters, request leases and worker leases retain their original statuses, attempts, timestamps and bodies. They are not deleted, reset, renewed or converted into a new review state. A separate activation manifest inventories the original states and hashes. Root must deliberately reconcile pending/unknown work using the existing qualified workflows before considering activation. There is no activation command in v2.

The import locks the target before taking its repeatable-read snapshot. PostgreSQL requires that ordering to see changes that committed while waiting for a lock. [PostgreSQL 18 locking documentation](https://www.postgresql.org/docs/18/sql-lock.html).

Only the exact `fp_org_session_retained` trigger is temporarily suspended, inside the verified fresh-target import transaction, while inserting manifest-bound original sessions. Its original enabled mode is pinned as `O`. Independent SQL and manifest checks enforce exact organization/member identity and the original membership deadline. All foreign keys and other guards remain enabled. The trigger is re-enabled before final catalog/row comparison and commit. An exception rolls back both its mode and every insertion; ordinary issuance after restore still rejects expired/revoked membership authority.

Sequence restoration uses transactional `ALTER SEQUENCE ... RESTART`, followed by the original `is_called` behavior. It avoids nontransactional `setval`. A failure after restart restores the target's original sequence. [PostgreSQL sequence documentation](https://www.postgresql.org/docs/18/sql-altersequence.html).

## Private keys and artifact bytes

Source and destination must explicitly provide the same original encryption and merchant bindings. Their fingerprints are reviewed, and actual ciphertext is authenticated with the original standard, recipient, payment-operation and nested-source contexts. Ciphertext is copied unchanged, never re-encrypted under a replacement application key. The qualification also reads restored data through the existing application private-value and payment-store codecs.

Every original document, validated page, planning alignment image and proof derivative has a complete original key/hash/content-type binding. Required bytes are included in the encrypted bundle and verified again at the destination. Only an original `awaiting_upload` draft may record an explicit absent object; its original expected hash, declared size and upload expiry remain. Still-valid upload grants or worker/request leases block export. An absent upload that arrives after review forces a new review, not an invented successful upload.

Withdrawn sources retain their original withdrawal controls. Operator-private encrypted backup bytes do not grant application readers access to withdrawn source bodies or exports.

The shipped CLI adapter is **private-files**. It uses existing absolute 0700 roots, original relative keys, 0600 files and immutable private metadata. Staging creates a new file exclusively or verifies exact existing bytes; it never overwrites an unrelated artifact. Its manifest-bound temporary journal lets only the original import finish a partial stage. A database rollback can leave private staged files, but no new application grant or released hold. Retry the exact original bundle/plan; do not erase history to force a retry.

This filesystem proof does not establish that a hosted Blob account can read the files. `ArtifactStore` has a typed `existing-private-store` integration seam. Root must supply and qualify the actual application's private reader/store namespace, exact original keys, bytes/content types and storage credentials before a hosted cutover. Environment files and secret values are never copied into a bundle.

The bounded implementation refuses more than 250,000 rows, 128 MiB of row JSON or 128 MiB of artifact bytes; it never truncates a transfer. The private-file adapter bounds an individual artifact at 25 MiB and CLI input files at 256 MiB. Larger workspaces require a separately qualified streaming extension.

## Operator prerequisites

Root alone runs a real local/hosted cutover. Before creating a plan:

1. Establish an execution hold on the source and drain in-flight requests, worker/provider leases and outstanding upload grants. Preserve unknown financial outcomes for reconciliation. The source stays held throughout backup, export, restore and activation review.
2. Create a separate fresh restricted destination through an explicitly reviewed setup. Initialize the exact schema 21 catalog there once, using its sole namespace search path, then create its single setup hold using the existing runtime-control operation. Do not point an initializer at an older or occupied catalog. The destination role must own its private namespace and lack superuser, role/database creation, replication and bypass-RLS privileges; no public or other-role namespace access is accepted.
3. Keep a private source database backup and the corresponding private artifact backup. Review actual recovery against the pinned source identity/catalog/rows/sequences. A checksum alone does not prove physical recovery; the backup-review attestation is an operator prerequisite, not an automated production recovery claim.
4. Stage an operator JSON file 0600 inside a symlink-free 0700 directory. Specify only the selected original values; do not load or copy an entire `.env`. Source and destination connections always use one explicit namespace, before any database read. Remote URLs require `sslmode=verify-full`.

Example structure, using placeholders only:

```json
{
  "format": "fieldproof-workspace-operator/v2",
  "source": {
    "databaseUrl": "postgresql://restricted_role:SOURCE_PASSWORD@localhost:5432/source_database",
    "schema": "fieldproof_original",
    "label": "original-held-workspace",
    "authSecret": "ORIGINAL_AUTH_SECRET_SELECTED_PRIVATELY_AT_LEAST_32_CHARACTERS",
    "merchantClientId": "ORIGINAL_MERCHANT_CLIENT_ID",
    "artifacts": {
      "kind": "private-files",
      "directory": "/absolute/private-cutover/source-artifacts",
      "namespace": "original-private-artifact-namespace"
    }
  },
  "destination": {
    "databaseUrl": "postgresql://restricted_role:TARGET_PASSWORD@localhost:5432/target_database",
    "schema": "fieldproof_fresh_destination",
    "label": "fresh-held-destination",
    "authSecret": "SAME_ORIGINAL_AUTH_SECRET_SELECTED_PRIVATELY_AT_LEAST_32_CHARACTERS",
    "merchantClientId": "SAME_ORIGINAL_MERCHANT_CLIENT_ID",
    "artifacts": {
      "kind": "private-files",
      "directory": "/absolute/private-cutover/destination-artifacts",
      "namespace": "original-private-artifact-namespace"
    }
  }
}
```

## Reviewed workflow

Run from the explicit absolute checkout directory. Every private input/output below is an absolute path in an existing 0700 directory. The CLI uses structured arguments and never a shell/env-file loader. There is no HTTP endpoint or automatic scheduler.

```sh
node --import tsx scripts/workspace-transfer-v2.ts coverage
node --import tsx scripts/workspace-transfer-v2.ts basis --config /absolute/private-cutover/operator.json --out /absolute/private-cutover/basis.json
```

`basis` is read-only and records exact source identity, catalog, row and sequence hashes. After root verifies the actual private backup and its recovery, create a 0600 backup-review JSON with exactly these fields:

```json
{
  "kind": "operator-verified-private-backup",
  "sourceIdentityHash": "EXACT_BASIS_SOURCE_IDENTITY_HASH",
  "catalogHash": "EXACT_BASIS_CATALOG_HASH",
  "rowsHash": "EXACT_BASIS_ROWS_HASH",
  "sequenceHash": "EXACT_BASIS_SEQUENCE_HASH",
  "bytesHash": "SHA256_OF_THE_ACTUAL_PRIVATE_BACKUP_FILE",
  "byteLength": 1,
  "verifiedAt": "UTC_RECOVERY_REVIEW_TIMESTAMP",
  "verification": "operator-recovery-reviewed",
  "provenance": "operator-cutover"
}
```

`byteLength` must be the actual positive byte count. The review timestamp must be an original UTC instant at or before export. `synthetic-qualification` is reserved for disposable fixtures and does not qualify a real backup.

```sh
node --import tsx scripts/workspace-transfer-v2.ts export --config /absolute/private-cutover/operator.json --backup /absolute/private-cutover/source.backup --backup-review /absolute/private-cutover/backup-review.json --out /absolute/private-cutover/bundle.sealed.json
node --import tsx scripts/workspace-transfer-v2.ts plan --config /absolute/private-cutover/operator.json --bundle /absolute/private-cutover/bundle.sealed.json --reason "Restore reviewed originals and retain execution hold" --out /absolute/private-cutover/plan.sealed.json
```

Export and plan are read-only. They require the same held/drained source and exact backup binding. Plan also verifies the fresh target and original artifact availability/conflicts. Root reviews the full private manifest, backup, destination identity, complete coverage, artifact/key bindings, declared deltas and activation inventory, then records the returned `reviewHash`. The hash binds the exact plan, original payload and reason.

```sh
node --import tsx scripts/workspace-transfer-v2.ts apply --config /absolute/private-cutover/operator.json --bundle /absolute/private-cutover/bundle.sealed.json --plan /absolute/private-cutover/plan.sealed.json --review-hash EXACT_REVIEW_HASH --out /absolute/private-cutover/receipt.sealed.json
node --import tsx scripts/workspace-transfer-v2.ts verify --config /absolute/private-cutover/operator.json --bundle /absolute/private-cutover/bundle.sealed.json --plan /absolute/private-cutover/plan.sealed.json --receipt /absolute/private-cutover/receipt.sealed.json
```

Apply rechecks exact source/target/backup/configuration lineage and commits original rows plus only the declared control/import deltas atomically. A nonempty/conflicting target refuses. Row selection and catalog reads are batched; ordered inserts run in one database block with all constraints enabled except the approved session issuance window. Final comparison checks complete original rows, sequence state, guard modes and actual private artifact bytes before commit.

After a lost response, repeat **the same apply command and original reviewed files**. It returns the immutable original receipt and does not renew authority, reset attempts, rewrite records or dispatch work. Existing sealed output files are reused only when their exact original payload matches; they are not overwritten. If the source/target changed, preserve both held namespaces and private evidence for a new deliberate review. Do not edit a manifest or clear a target to make it pass.

Verification is read-only and reports 136 original-row families, 134 identical whole tables and a held destination. It does not activate execution. Root must review actual provider outcomes, pending jobs, endpoint/store configuration, backup recovery and rollback/activation responsibilities separately. Keep the source held until one destination is deliberately selected; avoid two active copies of the same original authority and provider operations.

## Retention and finite remaining gates

Retain original financial/provider attempts, source facts, actor/session/access/invitation/consent records, immutable versions, original hashes, private artifacts, withdrawal controls, runtime history, backup evidence and import receipts according to an explicitly chosen operator retention policy. Expiry or withdrawal changes authority/access, not historical truth. No cleanup, source-body deletion, lease pruning, consent renewal or financial rewrite is authorized by this unit. `scripts/operations-review-v2.ts` produces an offline private coverage/lock/license/configuration report and performs no deletion or provider calls.

Observed qualification: 41 focused controls pass together in one awaited parent suite against the guarded pair of synthetic schemas on the existing owned 55571 PostgreSQL role, including the catalog and four-clock controls. The tests deny HTTP/TLS/UDP/DNS and every raw socket except the exact owned PostgreSQL transport; configuration keys are closed, external credentials blank, both sole search paths are established before application import, and only the exact created UUID schemas are dropped. The source catalog, synthetic financial/provider provenance, encrypted originals, crossed identities, original deadlines, missing artifacts, unknown coverage, failed-import rollback, expired/revoked sessions, ordinary issuance denial, lost commit response and CLI flow are covered. No frozen public data, application browser request, production transfer, provider/model/email operation or deployment was used.

The initially failing expiry fixture mislabeled Asia/Kolkata local time as `Z`, shifting its newly constructed deadline by about 19,800 seconds. A four-clock comparison across separately committed connections proved normal clock advancement and zero namespace clock overrides. The corrected fresh fixture sets UTC before ordinary issuance, then waits for actual database expiry. No previously issued deadline, source trigger or server clock was edited. The failed evidence and diagnosis remain private.

The offline lock review observes 489 locked packages, no undeclared licenses and the vendored payment-core provenance hash. It flags four Commercial declarations (`ag-charts-enterprise`, `ag-grid-enterprise`, `ag-studio`, `ag-studio-react`), fourteen LGPL-containing declarations and four font/attribution declarations for operator review; declarations do not prove entitlements or legal clearance. Installation reported 12 advisories (1 moderate, 11 high); the later offline audit returned zero from its available cache, which is not a fresh security clearance. No package or lockfile was upgraded. Current upstream advisory triage remains an external release review.

Remaining qualification is finite: integrate and explicitly qualify the 22/23/24 fragments; verify the actual hosted private store/key and application reader; perform root-owned real backup recovery and the chosen real cutover/activation review; review the current dependency advisories. SQLite, another PostgreSQL major, larger streaming bundles and an unreviewed artifact adapter are unsupported rather than silently accepted.
