# Native Studio review procedure

This is a review of implemented source, with browser and provider outcomes recorded separately. A source test is not a substitute for observing the native interaction. The six domain widgets and their harness are AG Studio 3.1.0 components; all financial mutations remain outside the report.

The [recorded Sample qualification](evidence/studio-native-qualification.json) preserves ten actual native/model runs, the initial failures, the corrected parent-bound delegation, full-history checks, automatic data update and targeted role/mobile review. Remaining provider, dependency and broader accessibility gates are explicit in that record.

## Start an isolated review

Use a new local database, never a transferred source workspace. From the project folder:

```sh
npm run typecheck
npm test
npm run build
npm run studio:qa -- --prepare
npm run studio:qa -- --resume
```

The preparation command requires database-creation authority on the configured local PostgreSQL service. When that role intentionally lacks it, the explicit alternative is `npm run studio:qa -- --prepare --local-admin`: this uses the current OS user's existing local PostgreSQL authority on port 5432 to create a new database and a new unprivileged role. It does not grant privileges to the existing app role. Preparation refuses an existing review runtime; resume retains the same reports and chat history. The child binds only `127.0.0.1:4202` and uses a separate `fieldproof_studio_qa_session` cookie. Payment and private Blob configuration is disabled in that child; model configuration stays server-side. The ignored runtime file contains private connection and encryption material and must never be published or printed.

Open `http://localhost:4202/organizer`. Choose **Organizer** in **View as**, then **Proof Studio**. This creates an actor's persisted Sample workspace if none exists. Starting the automatic Sample tour instead can advance the fictional settlement, so close or pause it before comparing baseline totals.

The initial Organizer view contains six packages, eight Sample settlements, zero allocation revisions, five evidence/package associations and one reconciliation exception. Electronics has $925 collected toward $960 with zero available to allocate. Printing has $1,200 collected and eligible. Total package budgets are $8,410; reviewed expenses, delivered repayments and accepted work are zero. These are Sample facts, not provider qualification. Donor/Contributor sees shared package facts and only their own receipts; the seeded Sample participants are different actors, so the newly created actor owns none of those receipts.

## Native report behavior

1. Confirm all six widgets load: **A room for possibility**, **Commitment, collection, proof**, **Every package, clearly**, **The evidence shelf**, **Follow the contribution**, and **What needs a human**. Verify dollars are divided from cents exactly once. The allocation widget should show an honest empty state.
2. Select Electronics in the room plan. The native package relationship should filter rings, matrix, evidence and exceptions. Budget becomes $960, eligible collection $925, accepted work 0/3. Clear selections restores the complete report. Repeat using the matrix package name and keyboard Enter/Space on the plan.
3. Open an evidence card and a package proof count. The dialog states exactly what review establishes. Sample summaries do not masquerade as private originals. Close with Escape and verify focus returns to the invoking control.
4. In **Compose**, move or resize a widget and change a title using native controls. Wait for **Saved**, inspect **History**, Undo and Redo. Reload the page, confirm the changed report and both retained stacks, then Undo again. Report saves use optimistic revisions; a stale second tab must not overwrite a newer report.
5. While the report is open, make an authorized change to the same disposable Sample project from another application view or an explicitly isolated QA fixture. Confirm the next refresh updates existing widget data via native `applyTransaction`, without a report rebuild or lost layout/history. Report data pauses at a fixed cutoff while an assistant run is active.

## Actual assistant and retained delegates

Open **Ask the Studio**. The app enables native editing with only the assistant panel visible; **Compose** exposes the separate Data and configuration panels. On mobile the native assistant uses the full width, with **Back to report** returning to Explore. Neither action removes Undo history. The model is selected by server configuration. No browser key or alternate model is used.

Start with **What still needs proof?**. The actual server trace must contain `fieldproof_snapshot`, `fieldproof_evidence` and `fieldproof_exceptions` when used, real model response receipts, and the same materialized cutoff. The answer must separate Sample collections, expense review, empty allocations and unaccepted physical work. **View trace** distinguishes server receipts from browser-observed edits.

For a concrete composition task, use:

> Use the native Page agent to swap the two top-row widgets: funding rings on the left, room blueprint on the right, retaining their current sizes and all six widgets. Then use native Widget to rename the evidence shelf to “Evidence for our next review”. Preserve stable field/package mappings, read back both changes, and state only what actually applied.

The trace must show real `delegate_to` calls and native Page/Widget child runs bound to the parent's exact dataset and cutoff. Verify applied layout/title in the report, not just the answer. Undo should reverse real changes. AG 3.1 emits parent identity in its original native `run_started` event but omits it in the direct adapter's options; Fieldproof validates the original event and forwards that identity. Do not qualify delegation merely because its title appears in the chat. A native `complete_task` receipt is followed by a separately labelled browser completion observation; it cannot establish financial authority.

Swapping occupied positions can cause AG to repair an intermediate overlap before the delegate finishes. Native readback must verify the final bounds, sizes, overlap state and widget mappings. The app retains nonfatal `errorDetails` in an expandable configuration notice for the current page session. An earlier warning does not itself establish that the final report is invalid, and a successful answer does not establish that all warnings were resolved.

Use the **Independent Auditor check** native starter, or ask Steward to delegate an independent check to **Auditor**. AG's standard roster exposes the primary agent; this harness keeps Auditor as a real delegate rather than promising an absent agent selector. Ask whether the visible collection is spendable and whether any work has been certified. Auditor has only read tools. An instruction to capture, refund, pay or approve cannot dispatch a financial tool. Direct financial endpoints also enforce the actual workspace role; test a forged request with a valid shape under the Auditor role and require 403 before any provider call.

Reload and reopen the saved conversation, then ask a factual follow-up. Saved visible native messages, artifacts and state must load from encrypted scoped chat storage. A prior browser copy cannot invent or alter a server receipt. Hidden model reasoning is neither stored nor returned.

## Roles, availability and accessibility

Switch to Contributor, Volunteer and Auditor, then back to Organizer. Each role has its own report and chat history, and each snapshot is redacted before it reaches the browser. A role or membership change in another tab closes the existing private report. Account destinations, wallet identities, raw provider IDs and forbidden originals must never appear in report tables or model input.

Test at 360 and 390 pixels, 200% zoom, keyboard-only navigation and reduced motion. The widgets use a native single-column responsive layout below 760 pixels. The package table has a named, focusable scroll region and each proof button identifies its package. Verify labels, table scrolling, dialog focus, assistant opening and all report controls without clipping. Inspect real errors rather than dismissing them as expected AG behavior.

## Provider qualification remains separate

The isolated process cannot perform a real PayPal read or money operation. A later authorized provider check must use an actual owned sandbox receipt, current actor/role, immutable cutoff and the same installed Toolkit. The closed switch permits only `get_order` and `get_invoice`; the SDK's configuration alone does not enforce that boundary. A current provider observation is recorded separately and does not update money state. No aggregate merchant insights, arbitrary provider ID, mutating Toolkit tool or financial authorization is available to the assistant.

Private originals also need a separately permitted environment and genuine source. Do not manufacture a ready upload or evidence acceptance to make the review look complete.

The pinned Toolkit's dependency graph reports 12 inherited npm advisories. The `/openai` import does not load its LangChain or AI SDK integrations, and the closed two-read adapter does not accept MathJS expressions. This is not a clean audit or a substitute for dependency hardening. Repeat transport, domain and actual-provider qualification after any graph change; do not silently downgrade the Toolkit to satisfy the audit command.
