# Fieldproof: development handoff

## Product plan

When the local `plans/` folder is available, start with `plans/README.md`, `plans/FOUNDATION.md`, and the product document. Read the documents for the workstream being implemented before editing. Those files are deliberately ignored by Git; a fresh clone may not contain them. Public source and runnable instructions must remain self-contained at release.

The user chose an ambitious full product and explicitly removed submission deadlines and development effort as scope limits. Work in dependency-ordered, verifiable milestones; do not silently replace the plan with a small mockup. Application features described in the plans have not been implemented merely because their documentation exists.

## Collaboration

Assign explicit path ownership and shared interface contracts to parallel agents. Preserve unrelated changes. Resolve contract changes through the integration owner and validate the complete workflow after merging. Keep intended behavior, observed results, and remaining capability gates separate in reports.

## Integration rules

Use the local APIMatic integration skill before PayPal SDK implementation. Confirm the actual SDK identity, version, controller map, and upstream documentation; `paypal` from the context-plugin repository and `@paypal/paypal-server-sdk` are not assumed interchangeable.

Every external financial action uses the supported authorization flow, current application authority, a durable operation identity, and verified provider state. A saved payment method is not reserved funds. A replay, simulated failure, modeled outcome, or sample artifact must be labeled accurately. Do not fabricate merchant purchases, fulfillment, physical work, or successful transactions.

## Configuration and publication

Keep `plans/`, `.env`, and private evidence out of Git. Never print credentials, store them in screenshots, send them to model prompts, or expose them in the browser. Use `.env.example` for names and placeholders only. The copied PayPal configuration is initially shared with the parent workspace; prove account capabilities and establish project isolation before concurrent live scenarios.

Hosting is planned for Vercel, with durable work persisted outside individual request lifetimes. Use the user's existing OpenAI and Gemini keys through server-side adapters. Model names are selected and verified during implementation. Render is outside the selected scope.

## Product quality

Build complete navigation, responsive layouts, loading/error/recovery states, keyboard access, reduced motion, and source-linked evidence alongside hero flows. Preserve the project's distinct art direction. Judge-facing UI explains the product and its results; implementation diagnostics belong in deliberate evidence views. Test meaningful domain and payment invariants plus the actual user journey; report measurements rather than claiming unmeasured results.
