# TypeScript SDK integration record

Fieldproof uses the APIMatic-generated `paypal` package from the [context-plugins TypeScript SDK](https://github.com/context-plugins/paypal-typescript-sdk), pinned to version 2.29.0 and commit `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`. It does not substitute a different PayPal package with similarly named controllers.

The workspace's TypeScript integration, getting-started, authentication, client-initialization, calling-endpoints, models, configuration-resilience, error-handling and testing skills were read before SDK changes. Their application is recorded in [the implementation plan](../../paypal-plan.md). The private workspace skill paths are not runtime dependencies.

The immutable `@fracture/paypal-core` archive supplies the generated SDK boundary for Orders, capture/refund reads and mutations, Vault, and Reporting balances. Generated responses use the actual `.asApiResult()` contract. The client uses the sandbox environment, disabled SDK logging and no automatic financial-write retry. Fieldproof supplies durable original-operation identities, current authority and independent ownership checks.

The installed generated SDK does not expose the required Invoicing and Payout endpoints. Those use the core's separately typed sandbox REST gateway, with the same isolated merchant credentials and explicit original request identities. These calls are not described as generated SDK operations. Unknown creation is recovered through its original identity and provider-supported mechanism; invoice status and payout batch status never substitute for confirmed economic evidence.

The application injects the maintenance-aware transport through the SDK provider and commerce gateway's supported fetch parameters. It preserves each original request and abort signal and checks the database hold immediately before a PayPal resource mutation. Read-only token acquisition and signature verification remain classified separately.

Local regression tests cover original operation scope, immutable requests, current approvals, ownership and amounts, duplicate observations, unknown outcomes, repayment reservations, and maintenance holds. Actual sandbox checkout, wallet approvals, seven conditional captures and owned reconciliation reads are recorded separately in [sanitized qualification evidence](../evidence/). Receipt extraction used actual OpenAI and Gemini APIs. Reviewed reimbursement dispatch, final-slot recovery and hosted transfer each still require their own qualification; fixture tests do not claim those provider outcomes.
