# Continuing a private sandbox workspace on Vercel

This operator procedure preserves the same workspace's original provider objects, documents, review revisions, approvals and deadline. It does not create a new donor, authorize a collection, link another actor's hosted recipient, or replay financial operations.

## Preparation and manifest

1. Test and build the exact release. Set the hosted database hold using the CLI below, deploy with the existing isolated hosted environment, and visit `/api/health` for the additive schema migration. Confirm the deployed route reports `execution.held:true`; an older deployment does not implement this guard. Retain private source and destination database backups. Never copy a redacted environment pull into `.env` or Vercel; `[SENSITIVE]` is a placeholder.
2. A preliminary snapshot can be made with `node --env-file=.env --import tsx scripts/transfer-workspace.ts export --project ORIGINAL_PROJECT_ID --preview`. It is encrypted, mode 0600, under `.private/transfers/`, with a separate sanitized manifest. Final export must happen after source writers stop.
3. Verify the destination's existing merchant, Blob access and encryption lineage. The importer requires the same isolated sandbox client, private Blob configuration and encryption secret. Authenticated decryption of an existing destination ciphertext with its exact tenant/actor AAD corroborates historical key lineage. A censored environment pull alone cannot prove the current runtime key; check decryption through the deployed application before claiming hosted qualification. Do not rotate a key to make a fingerprint match.
4. Keep an operator-only target environment file with proven original DATABASE_URL, AUTH_SECRET, PAYPAL_CLIENT_ID and BLOB_READ_WRITE_TOKEN, plus `PAYPAL_ENVIRONMENT=sandbox` and `PAYPAL_PROJECT_ISOLATED=true`. APP_URL, when present, must be `https://paypal-ai-fieldproof.vercel.app`; when absent, the app's validated VERCEL fallback already selects that origin. The CLI reads these specific fields without layering them onto the local application environment.
5. In the original live workspace choose Organizer, open `/continue`, prepare the one-use link and keep the page open. It expires after at most one hour and cannot extend the original session. Its fragment is a private capability; keep it out of screenshots, logs and published artifacts.

The qualified local checkpoint has eight consents totaling 96000 minor USD, seven conditional receipts totaling 92500, a separate 100 minor test receipt, one untouched 3500 minor collection item, nine original payment commands/operations, and sixteen receipt-journal rows. Its fixed recovery deadline is **2026-11-12T23:21:52.633Z**. The original sample document has four actual AI runs (including preserved earlier failures), five attempts, and claim revisions 1/2/3 ending at 7800 minor approved with 840 minor held. There are no payables. These are one controlled participant's sandbox contributions and an automated controlled-sample review; no physical purchase or independent human review is claimed.

## Atomic import and single writer

The deployed guard is the database flag `fp_runtime_control(key='execution').held`. It is checked when API mutations, cron requests and background document/model work obtain a durable request lease. PayPal resource mutations recheck it immediately before network dispatch. Incoming webhooks receive 503 while held so they can be retried. Existing read views, health and the exact one-use continuation endpoint remain available. The flag is changed only by the operator CLI; there is no browser endpoint to release it.

Set the hosted hold before deploying this release. Once it serves the stable alias, prove that a POST mutation and a cron request return 503 while health/read views remain available. Preparing the local continuation happens before holding the local database. Then hold and stop the local application and workers. Poll both statuses until `quiescent:true`: all earlier request leases and worker/provider dispatches must drain. The final snapshot and import enforce the same condition; this is not just an operator note.

```sh
# Hosted guard: no secret or provider configuration changes.
node --env-file=.env --import tsx scripts/maintenance.ts hold \
  --target-env /private/fieldproof-hosted.env --reason "Hosted workspace cutover"
node --env-file=.env --import tsx scripts/maintenance.ts status \
  --target-env /private/fieldproof-hosted.env

# After preparing /continue in the original local workspace:
node --env-file=.env --import tsx scripts/maintenance.ts hold \
  --reason "Original writer frozen for hosted continuation"
node --env-file=.env --import tsx scripts/maintenance.ts status
```

```sh
node --env-file=.env --import tsx scripts/transfer-workspace.ts export \
  --project ORIGINAL_PROJECT_ID --writers-stopped

node --env-file=.env --import tsx scripts/transfer-workspace.ts plan \
  --bundle .private/transfers/BUNDLE_ID.json --target-env /private/fieldproof-hosted.env

node --env-file=.env --import tsx scripts/transfer-workspace.ts apply \
  --bundle .private/transfers/BUNDLE_ID.json --target-env /private/fieldproof-hosted.env \
  --writers-stopped
```

Review the final manifest before applying it. `plan` exercises all SQL constraints in a transaction and rolls it back, using temporary negative event cursors so it consumes no destination sequence values. Both plan and import reject changed existing records and incompatible schema/configuration. Apply commits once or rolls back in full. Repeating a completed bundle returns its import record and cannot overwrite later work. Database locks time out rather than waiting indefinitely for active writers.

Existing hosted history remains intact. Domain/provider IDs, encrypted bodies, request identities, timestamps and deadlines are unchanged. Event IDs and source order are preserved; destination cursor sequences are allocated locally, with the original sequence map retained in the import audit. Owned historical webhook observations go into an encrypted source archive, not into a new canonical-delivery queue. The destination's signature-verification and deduplication history remains its own history.

## Hosted continuation and qualification

Follow the prepared link after verifying the import. The hosted page removes its fragment from the URL and keeps the capability in memory. Continue explicitly. The transaction checks the imported grant, exact origins, current actor/session/role, membership version and original expiry; it rotates the existing session cookie and consumes the grant once. Concurrent redemption has one winner. The HttpOnly, SameSite cookie is scoped to the hosted origin.

Check the original source preview, successful v2 proposals, preserved v1 failures, all seven source amounts and 7800 minor reviewed total. Reload to verify persistence. Confirm 92500 minor collected, one untouched 3500 minor item, the same deadline, and no payable. Keep the local writer held/stopped. Resume only the hosted writer:

```sh
node --env-file=.env --import tsx scripts/maintenance.ts resume \
  --target-env /private/fieldproof-hosted.env \
  --reason "Verified hosted continuation is the sole writer" --confirm-single-writer
```

Choose Volunteer and perform **fresh** Login with PayPal for this original claimant using the registered hosted callback. An old hosted account's recipient is not copied to this actor. Verify encrypted destination access through the deployed runtime and display only its masked label. OAuth starts/callbacks and role changes are mutations and are blocked while held; do them after releasing the designated hosted writer.

Releasing the hosted hold also permits scheduled work. Review-each collection cannot dispatch an untouched item through cron. Incomplete package funding must still block repayment. If the original deadline has elapsed, retain it and follow the recorded compensation policy and current authority; import never grants an extension.

## Rollback and failures

- A failed/conflicting import rolls back completely. Keep the source frozen, inspect the safe error and manifest, and resolve the actual conflict. Do not use overwrite mode or new provider identities.
- Before import commits, the existing hosted deployment/database stay authoritative for their records. A failed deployment can return to the prior release; additive tables do not require deleting history.
- After import, retain the cloud copy and audit. Pause workers and fix or roll back compatible application code if needed. The original local writer remains stopped.
- After hosted identity, payment, refund, webhook or review activity begins, do not restore an older database or resume the old source snapshot. Repair forward from the single current ledger. A database restoration requires proof that no intervening provider/application effects would be lost.
- Expired links, changed membership and unregistered callbacks remain blocked. OAuth state, origin and session checks are not weakened. No replacement consent or automatic final-slot collection is introduced.

Transfer tests use two isolated PostgreSQL schemas. A separate rehearsal imports actual source records into a disposable local schema, validates encrypted operations and unchanged source rows, then removes only that schema. Neither substitutes for hosted migration or browser-login qualification. Actual results are recorded separately under `docs/evidence/`.
