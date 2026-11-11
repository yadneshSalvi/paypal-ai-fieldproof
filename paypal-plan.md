# Fieldproof PayPal implementation contract

Contract version 1 · 11 November 2026 · sandbox only.

This document records the implementation boundary, not a claim that transactions occurred. The full product includes conditional commitments, payer-present collection, saved-wallet collection when qualified, recovery invoices, reviewed reimbursement, refunds, verified events and scoped reporting. The first executable slice is a payer-present Orders contribution with a durable all-rail receipt. Subsequent capabilities retain explicit proof gates below.

## Repository, toolchain and authority

- Greenfield baseline had no application, build or tests to run. Existing guidance: `AGENTS.md`; existing shared implementation exemplar: installed `@fracture/paypal-core` root API and its source. Fieldproof has no sibling runtime imports.
- Node 22.22.3; npm 10.9.8; Next.js App Router and React; TypeScript strict ESM. Checks will be `npm run typecheck`, `npm test`, `npm run build`.
- Installed `paypal` 2.29.0 from `context-plugins/paypal-typescript-sdk` commit `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`; the package resolves locally and includes `sdk-map.md`, resource maps and source. Import only from `paypal`. Core 0.1.1 is the local versioned archive, independently buildable.
- Every deployment, including Vercel production hosting, uses `https://api-m.sandbox.paypal.com` only. The SDK has one server and **no ServerEnvironment**. Explicit `serverOptions.baseUrl` is the host knob. `PAYPAL_ENVIRONMENT=sandbox` and `PAYPAL_PROJECT_ISOLATED=true` are checked independently. Missing credentials disable provider initialization with a named configuration error; no secret values are logged.
- The already-authorized full build governs implementation. Capability failures select the documented supported path and remain visible; they do not require asking the user to approve the same build again.
- Long-lived server client; `oauth2.clientId/clientSecret` from server environment, no per-request reconstruction. `retry.maxRetries=0` for mutation transport, 20-second per-attempt budget plus a bounded signal; no stacked automatic mutation retry. `logging.level=off`, no request body/header logging, no per-call logging override. `fetch` preserves the complete Request and signal.

## Operations and exact generated surface

All operations use `oauth2` and the default sandbox group. The installed map is the source of signatures and error arms. Every call takes one flat request object and optional `RequestOptions` with signal/retry/logging; it is not a header bag. Mutation calls use `.asApiResult()` before any promise chain. Optional absent fields are omitted. Malformed or incomplete success stays unknown, never domain absence.

| Operation | Signature request → result | Wire | Required fields; optional fields used |
| --- | --- | --- | --- |
| create order | `Orders.CreateOrderRequest` → `Order` | POST `/v2/checkout/orders` | `body: OrderRequest`; `payPalRequestId` header; `prefer: return=representation` header |
| capture order | `Orders.CaptureOrderRequest` → `Order` | POST `/v2/checkout/orders/{id}/capture` | path `id`; request-id; representation |
| get order | `Orders.GetOrderRequest` → `Order` | GET `/v2/checkout/orders/{id}` | path `id` |
| get capture | `Payments.GetCapturedPaymentRequest` → `CapturedPayment` | GET `/v2/payments/captures/{capture_id}` | path `captureId` |
| refund capture | `Payments.RefundCapturedPaymentRequest` → `Refund` | POST `/v2/payments/captures/{capture_id}/refund` | path `captureId`; request-id; representation; `body.amount`, `body.customId` |
| get refund | `Payments.GetRefundRequest` → `Refund` | GET `/v2/payments/refunds/{refund_id}` | path `refundId` |
| create setup token | `Vault.CreateSetupTokenRequest` → `SetupTokenResponse` | POST `/v3/vault/setup-tokens` | `body: SetupTokenRequest`; request-id |
| get setup token | `Vault.GetSetupTokenRequest` → `SetupTokenResponse` | GET `/v3/vault/setup-tokens/{id}` | path `id` |
| create payment token | `Vault.CreatePaymentTokenRequest` → `PaymentTokenResponse` | POST `/v3/vault/payment-tokens` | `body: PaymentTokenRequest`; request-id |
| get payment token | `Vault.GetPaymentTokenRequest` → `PaymentTokenResponse` | GET `/v3/vault/payment-tokens/{id}` | path `id` |
| delete payment token | `Vault.DeletePaymentTokenRequest` → `undefined` | DELETE `/v3/vault/payment-tokens/{id}` | path `id`; observe HTTP status via `.asApiResult()`, then reread |
| list payment tokens | `Vault.ListCustomerPaymentTokensRequest` → `CustomerVaultPaymentTokensResponse` | GET `/v3/vault/payment-tokens` | query `customerId` → `customer_id`; explicit bounded `page` and `pageSize`; defaults 1, 5, totalRequired=false |
| balances | `TransactionSearch.SearchBalancesRequest` → `BalancesResponse` | GET `/v1/reporting/balances` | query `currencyCode` → `currency_code`; optional `asOfTime` omitted for latest |
| transactions | `TransactionSearch.SearchTransactionsRequest` → `SearchResponse` | GET `/v1/reporting/transactions` | query `startDate/endDate` → `start_date/end_date`; bounded page/pageSize and owned resource scope |

Every result above is wrapped in `ApiPromise<Result, Resource.OperationError>`. The SDK additionally generates `Idempotency-Key` per non-GET call; Fieldproof never substitutes that for its durable `PayPal-Request-Id`. `Prefer` defaults to `return=minimal` where exposed, so representation is expressly needed for resource reconciliation. Generated maps were read in full for Vault/Transaction Search and scoped to these Orders/Payments operations.

### Request models actually set

- `OrderRequest.intent` required `CheckoutPaymentIntent.Capture = CAPTURE`; `purchaseUnits` required array. One `PurchaseUnitRequest` with required `amount {currencyCode:string,value:string}` and optional `customId` required by lineage. USD is stored as safe integer cents and serialized exactly. No caller-supplied payee or card data.
- Orders approval experience and saved-wallet source are added only through a new versioned shared-core action. Do not smuggle fields through the current `create_order` action.
- `SetupTokenRequest.paymentSource` required, with `paypal` using `usageType: PayPalPaymentTokenUsageType.Merchant = MERCHANT`, `customerType: PayPalPaymentTokenCustomerType.Consumer = CONSUMER`, description tied to consent, and `experienceContext.returnUrl/cancelUrl` required for the wallet contingency. Merchant customer ID binds the session donor. Other optional wallet/body fields omitted. Schema default `permitMultiplePaymentTokens=false`; experience defaults GET_FROM_FILE/CONTINUE unless the contract explicitly requires an override.
- `PaymentTokenRequest.paymentSource.token` has required `id` (our approved, owned setup token) and `type: VaultTokenRequestType.SetupToken = SETUP_TOKEN`.
- Setup responses have optional `id/status/links/customer`; require ID, acceptable state and an allowlisted HTTPS PayPal approval URL before presenting approval. States are CREATED, PAYER_ACTION_REQUIRED, APPROVED, VAULTED, TOKENIZED. Token response ID is optional in schema but required by our adapter.
- Refund body `amount` is optional to provider but required by our exact approved partial-refund operation; `customId` binds operation. `invoiceId`, `noteToPayer`, `paymentInstruction` omitted.
- Balances response `balances/accountId/asOfTime/lastRefreshTime` are optional in generated model; check each required policy field. `BalanceInformation.currency` and `totalBalance` are required, `availableBalance` optional. No available balance or stale provider snapshot fails closed.
- Generated enums are open; unknown observed states are not terminal success. SDK model `Error` is aliased `SdkError` if imported. Sensitive SDK models are mapped to our allowlisted DTOs, never JSON-serialized blindly.

### Per-operation API error arms

Names are schema-derived and meaningful only beside the operation, never a shared status switch.

| Operation | Typed arms (all also include undeclared raw bytes) |
| --- | --- |
| createOrder | error 400; error2 401; error3 422; error4 default |
| captureOrder | error 400; error2 401; error3 403; error4 404; error5 422; error6 500; error7 default |
| getOrder | error 401; error2 404; error3 default |
| getCapturedPayment / getRefund | error 401; error2 403; error3 404; error500 500 with no body; error4 default |
| refundCapturedPayment | error 400; error2 401; error3 403; error4 404; error5 409; error6 422; error500 500 with no body; error7 default |
| createSetupToken | error 400; error2 403; error3 422; error4 500 |
| createPaymentToken | error 400; error2 403; error3 404; error4 422; error5 500 |
| getSetupToken / getPaymentToken | error 403; error2 404; error3 422; error4 500 |
| deletePaymentToken | error 400; error2 403; error3 500 |
| listCustomerPaymentTokens | error 400; error2 403; error3 500 |
| searchBalances | defaultError 400; defaultError2 403; defaultError3 500; defaultError4 default |
| searchTransactions | searchError default |

### OPTIONAL FIELDS

| Field | What requires it | Set it? |
| --- | --- | --- |
| payPalRequestId | Durable operation identity below | Yes, stored once |
| prefer | Complete resource proof and reconciliation | representation on supported operations |
| customId / merchantCustomerId | Tenant-owned business lineage | Server-derived opaque reference |
| returnUrl / cancelUrl | Genuine approval return and recovery | Fixed configured origin + bound state |
| usageType / customerType | Direct merchant consumer pledge policy | MERCHANT / CONSUMER |
| description on setup token | Payer-readable exact conditional consent | Approved policy wording only |
| list page/pageSize and reporting dates | Bounded scope, complete result detection | Yes, owned scope and measured cutoff |
| fields / balanceAffectingRecordsOnly | No change needed for first reporting read | Keep SDK defaults transaction_info / Y |
| mock responses, partner attribution, metadata ID, auth assertion, payer overrides, shipping, line items, billing plan, locale override | Nothing in the current provider contract requires them | Omit |

## DURABLE WRITES

### DUPLICATE CLAIMS

| Write | Where claim is stored | What rejects second call | Catch / implementation |
| --- | --- | --- | --- |
| Orders create/capture | Shared SqlPaymentStore before dispatch; domain command/obligation authority | scope + semantic businessKey unique, immutable payload and provider request IDs; current domain version | Core conflict returns canonical operation; Fieldproof `lib/server/payments.ts` planned integration |
| capture refund | Shared SqlPaymentStore + current domain refund allowance | capture budget lock including uncertain/pending reservations; receipt refund bounds | Same core gate; Fieldproof cancellation choice service |
| Vault setup/exchange/delete | Domain external_operations before SDK call | tenant + obligation + purpose unique, request hash immutable | Domain adapter catches PostgreSQL 23505 and reads winning operation; no new request ID |
| invoice create/send/cancel | Domain external_operations and obligation row lock | Exactly one active original or recovery channel | Typed REST adapter, only after operation-specific contract proof |
| payout | Domain external_operations, payable allowance and current approval | payable ID/version unique; stable sender_batch_id and sender_item_id | Typed REST adapter, exact approved recipient version |

### UNKNOWN OUTCOMES

| Write | Authoritative reread | Search reference | Required behavior / test |
| --- | --- | --- | --- |
| create order | getOrder only if order ID known | returned resource ID | No invented lookup by request ID; unknown stays unknown and worker owns reconciliation; lost-create test |
| capture order | getOrder + getCapturedPayment | owned order/capture ID | One observed capture; response-loss test and no second mutation |
| refund capture | getRefund, owning order refund correlation | refund ID or exact customId | Reserve persists until exact attributable refund; response-loss test |
| setup token | getSetupToken if ID known | owned setup ID | Lost ID stays unknown; no blind second setup |
| payment token | getPaymentToken, bounded owned-customer token listing | known token or proven setup/customer correlation | Uncorrelated token is excluded; unknown cannot authorize a charge |
| delete token | getPaymentToken | same token | Verified absence revokes future use only; it never reverses collected receipts |
| recovery invoice | get invoice, search owned external invoice reference | invoice ID + immutable external number | Paid label alone is not payment identity; unknown original blocks invoice |
| payout | batch/item read; provider duplicate-batch link where available | same sender_batch_id, batch/item ID | Pending is not successful repayment; no fresh batch on retry |

Auth/encode errors known before dispatch are not_sent and do not trigger a misleading status reread. Connection/timeout or unreadable success is unknown; reread immediately where possible and enqueue durable reconciliation. An abort after dispatch is also potentially unknown.

## CROSS-OPERATION INVARIANTS

| Invariant | Legal set | Enforcement / meaningful test |
| --- | --- | --- |
| resource, payer, recipient ownership | Server session tenant + stored obligation/approval/resource relations | Before claim and again before dispatch; cross-tenant forged ID calls no provider |
| threshold and exact 48-hour authority | Published package version + valid consent snapshot | Lock round and obligations, persist freeze/recovery times before dispatch; withdrawal/freeze race |
| exclusive recovery channel | Same donor obligation across Orders/invoice | Unknown original prohibits invoice; invoice settlement suppresses original retry |
| unified credited receipts | Proven economic payment aliases per app/merchant | Seven capture receipts 92500 + invoice 3500 = 96000; duplicate aliases create no second credit |
| excess settlement | Obligation maximum and already credited amount | Extra actual receipt enters suspense/refund liability, not package funding |
| refunds | Credited receipt lineage + actual refundable resource | Reserve before dispatch; cumulative refund bound including pending; no invoice bookkeeping as money movement |
| reimbursement | Reviewed claim/recipient/amount/currency/policy/version/expiry hash | Changed recipient, claim, membership or stale balance blocks dispatch; concurrent allowance test |
| Auditor | Explicit read-only role | Forged direct financial command returns server denial |

## WHEN THE API SAYS NO

Applies to every in-scope operation using caller-owned data. Shared core supplies the normalized provider boundary; direct adapters must match it.

| Provider outcome | HTTP/app outcome | User copy / test |
| --- | --- | --- |
| Caller 4xx except 401/403/429 | Same 4xx | Allowlisted issue and safe specific remedy; never raw payload or full SDK URL |
| 401/403 or AuthError | 502 / not_sent for credential acquisition | Provider connection unavailable; no customer-auth blame |
| 429 | 503 | Provider temporarily busy; retain operation |
| 5xx / no response on read | 502 | Couldn't check PayPal; retry read |
| no response or unreadable success on write | accepted pending reconciliation | Checking the original payment; no new mutation |
| unknown non-SDK bug/ConfigurationError/direct SchemaError/caller abort | Rethrow to own typed boundary | Never swallowed as a provider refusal |

## Capability experiments and explicit limits

- 11 Nov read-only real SDK probe: balances 200, available balance exists, provider asOfTime/lastRefreshTime `2026-11-10T17:59:59Z`; this does **not** pass a 60-second provider-freshness policy. Reporting 200, totalItems 0, complete empty page. No money moved by these probes.
- Real Orders approval/capture/refund, Vault consent/MIT, exact token event, Payout item/recipient proof, invoice payment/refund and webhook delivery remain runtime qualification gates. Reads of nonexistent resources cannot prove entitlement to those lifecycles.
- US merchant/app isolation and credentials are provisioned by portfolio owner. Browser callbacks use port 4102 and the stable Fieldproof Vercel domain. No 3102 callback is used.
- Registered recipient callback is `/api/auth/paypal/callback`. Authorization uses `openid email https://uri.paypal.com/services/paypalattributes`; state is unpredictable, single-use, session-bound, expiring. Store payer ID encrypted, show masked email and actual verification state, never infer account ownership from an app-only email check.
- Invoicing/Payouts/Identity/webhook verification are absent from this generated SDK. They use separately tested typed REST adapters, with their exact source contract added before adapter enablement. No fabricated controller. Official Invoicing record-refund is bookkeeping and is never the financial refund route.
- The current shared-core release cannot express Orders experience or saved-wallet source; portfolio owner supplies a versioned extension. Current buyer-present JS SDK create/capture works through its existing actions.
- Sample tour uses synthetic documents and simulated outcomes with Sample badges. Replay is available only after real evidence exists. No invented physical completion or research result.

## Sources

Installed `node_modules/paypal/sdk-map.md`; `map/operations/orders.md`, `payments.md`, `vault.md`, `transaction-search.md`; corresponding type-source files; `api-reference.md`; versioned core README/provenance.

[Save without purchase](https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal) · [Login scope attributes](https://developer.paypal.com/log-in/references) · [Login authorization button](https://developer.paypal.com/log-in/build-button/) · [Payout creation](https://developer.paypal.com/api/payments.payouts-batch/v1/payouts-post) · [Invoices](https://developer.paypal.com/api/invoicing/v2/) · [JS SDK](https://developer.paypal.com/sdk/js/reference/).

## REQUIRED READING

MUST load `typescript-integrate-paypal`, `typescript-getting-started`, `typescript-error-handling`, `typescript-client-initialization`, `typescript-authentication`, `typescript-calling-endpoints`, `typescript-models`, `typescript-configuration-resilience`, `typescript-testing`. These were read for this contract; generic environment examples are superseded by the installed single-server map. Exact signatures are never supplied from memory.

## Implemented extension contract — 11 November

Core 0.2.1 replaces 0.1.1. It adds the typed checkout experience and saved-wallet/current-consent grant and fixes the observed HTTP 415 by sending supported empty JSON bodies on Orders authorize/capture. Root verified 60 conformance cases and its own sandbox lifecycle; Fieldproof's own lifecycle is a separate qualification.

Identity is absent from this SDK. The typed REST adapter follows [current Login integration](https://developer.paypal.com/log-in/build) and [profile endpoint](https://developer.paypal.com/api/identity/v1/userinfo-get): POST `/v1/oauth2/token`, Basic client credentials, URL-encoded `grant_type=authorization_code` and the received `code`; no alternate tokenservice endpoint. GET `/v1/identity/openidconnect/userinfo?schema=openid`, Bearer user access token. OAuth state is session-bound, random, stored as a hash, expires in ten minutes and is consumed transactionally before exchange. The token is kept only in this request, never returned or logged. No automatic token exchange retry.

Recipient verification requires an actual nonempty payer ID and `verified_account === true`; an email or generic subject identifier is not sufficient. The attributes scope promises payer ID, but the generic userinfo schema omits it. Therefore a missing `payer_id` is an explicit qualification failure; do not infer it from `user_id` or invent a mapping. Store the actual destination with AES-256-GCM, fresh IV and tenant/actor authenticated context, derived from server `AUTH_SECRET`. Only masked label and verification state reach the UI. Replacing the destination increments its version and invalidates outstanding approvals. No Payout is enabled merely by linking identity.

### Root identity scope correction — 11 November 2026

The hosted authorization UI returned `invalid scope` when the application requested `email`, which is not enabled in its configured attributes and is not needed for repayment identity. Request only `openid https://uri.paypal.com/services/paypalattributes`, with `fullPage=true`. Official scope reference maps both account verification and payer ID to paypalattributes: https://developer.paypal.com/log-in/references ; same-tab parameter: https://developer.paypal.com/log-in/build-button/ . Existing profile validation still requires actual verified_account=true and actual payer_id; optional email is not authority. This is the uncovered Identity REST flow, not a generated SDK operation. No permission expansion is made.

### Observed identity response — 11 November 2026

Actual hosted authorization returned `payer_id`, `sub`, `user_id`, and `verified_account`. The verification field was the exact string `"true"`, while the official generic example uses boolean `true`. The strict domain parser accepts only those two explicit affirmative forms, requires the real payer ID, and rejects false, missing, numeric, padded, and differently cased values. Three contract tests cover these boundaries. The actual hosted flow then persisted the encrypted recipient and showed its masked label. No Payout occurred. See `docs/evidence/paypal-identity-qualification.json`.

### Owned webhook reconciliation contract — root, 11 November

This extension uses existing shared-core `read('order'|'capture',id,AbortSignal)` wrappers of the already-resolved typed orders.getOrder and payments.getCapturedPayment. It adds no SDK operation, request field, host or write. Returned normalized links are data only: accept an exact GET up link on configured sandbox API origins ending /v2/checkout/orders/<bounded-alphanumeric-id>, never fetch the supplied URL. Resolve that ID against fp_provider_orders and its exact tenant/project/obligation command before rereading the known order. Independently read capture and require its presence/state/amount in the owned order response. All current observations must be live_sandbox. Notification amounts/custom IDs never supply authority. Persist leased jobs, fresh read hashes and redacted resources separately from mutation receipts. Shared settle reducer receives only exact owner and current authoritative resources, with canonical economic alias uniqueness. Terminal settled credit cannot regress on old notifications. Unsupported refund/reversal/invoice/Vault events remain explicit review, never a claimed financial projection. No open generated-SDK lookups: wrapper contracts were read from installed0.2.1 source and this document's existing operation tables. Local fake-provider tests are labeled fixture qualification, actual hosted processing is separate.
# Contract extension — conditional consent and Vault, 11 November 2026

This extension authorizes implementation, not a claim of live qualification. The installed APIMatic package remains `paypal@2.29.0` at the pinned Git revision. Shared payment transport upgrades only to the checked-in immutable `vendor/fracture-paypal-core-0.2.3.tgz`; its provenance and 84 conformance tests are transport evidence, not Fieldproof buyer consent.

## Durable domain ownership

`lib/domain/consent.ts`, `lib/server/commitments.ts`, `lib/server/vault.ts`, and `lib/server/provider-operations.ts` own conditional consent, Vault authority and provider-operation claims. Consent binds tenant/project/actor, one obligation, exact USD cents, approved package version, the exact policy digest, and expiry `2027-01-01T00:00:00.000Z` (through 31 December 2026 UTC). The initial live qualification is limited to the eight explicit Electronics Benches amounts `[20000,20000,17500,15000,10000,5000,5000,3500]` and total 96000 cents. The existing one-dollar checkout contract and records remain separate. A consent is not cash or authority for unrelated purchases. A package round must freeze eligible consent identities before any merchant-initiated charge; its fixed recovery end is exactly 48 hours later.

Before every Vault mutation, persist a unique semantic business key, stable PayPal request ID, immutable payload hash, current authority, dispatch claim and outcome. Concurrent/repeated calls return the existing operation; no blind repeat after timeout, unknown transport outcome or malformed success. Sensitive setup/token/customer identities are encrypted at rest with tenant/actor/consent AAD. Public projections expose only state and masked labels. A cancelled browser return never means provider revocation. Withdrawal before round freeze revokes application collection authority immediately; provider-token deletion is separately reconciled.

## Exact Vault shapes re-read from installed map and model source

The existing operation matrix remains authoritative: `client.vault.createSetupToken({body, payPalRequestId}, {signal})`, `getSetupToken({id}, options)`, `createPaymentToken({body, payPalRequestId}, options)`, and `getPaymentToken({id}, options)`. Use `.asApiResult()` before awaiting. The isolated sandbox client uses `serverOptions.baseUrl`, memoized OAuth, disabled logging and `retry.maxRetries=0`; a bounded AbortSignal covers the call. No SDK-invented environment enum or deep import.

Setup body: `customer.merchantCustomerId` is an opaque, stable consent correlation; `paymentSource.paypal` has `description` containing the exact amount/package condition, `usageType: MERCHANT`, `customerType: CONSUMER`, `usagePattern: UNSCHEDULED_PREPAID`, and `experienceContext` with owned `returnUrl`, `cancelUrl`, `brandName: Fieldproof`, `shippingPreference: NO_SHIPPING`. Leave `permitMultiplePaymentTokens` at its documented false default; `userAction` remains its CONTINUE default. Sources: `setup-token-request.ts`, `customer.ts`, `vault-pay-pal-wallet-request.ts`, `vault-experience-context.ts`, `usage-pattern.ts`. These optional fields are intentionally selected because they bind the buyer experience to the conditional contribution and avoid shipping collection.

Setup response may omit `id`, `status`, `customer` or `links`; require a valid returned ID and recognized state before saving a usable approval. Only HTTPS `www.sandbox.paypal.com` or `sandbox.paypal.com`, no credentials or nondefault port, is allowed for an approval link. Status is open-enum: only `APPROVED` permits exchange; CREATED/PAYER_ACTION_REQUIRED remain pending, and unknown values require review. A callback's `token` value is not proof: fetch the exact encrypted owned setup ID, require matching response ID, and use that observation. Do not trust callback-supplied resource IDs.

Token exchange body is exactly `paymentSource.token: {id: ownedSetupId, type: SETUP_TOKEN}`. A usable response needs an actual payment-token ID plus a PayPal source. `PaymentTokenResponse.customer.id` is optional; retain it encrypted when present. `PayPalPaymentToken.payerId`, `emailAddress`, `usageType`, `usagePattern` are optional, not proof of a verified payout recipient. Source files followed from imported model declarations: `payment-token-request-payment-source.ts`, `vault-token-request.ts`, `payment-token-response-payment-source.ts`, `pay-pal-payment-token.ts`, `customer-response.ts`. Confirm the token by a fresh owned `getPaymentToken` before marking the wallet ready; reject mismatching token/customer identity. A missing customer/usage echo is not invented. A lost token-exchange response without an exact provable identity remains unknown; listing cannot arbitrarily select a token.

Merchant collection uses core 0.2.3 `savedWallet` with `paymentInitiator: MERCHANT`, `usagePattern: UNSCHEDULED_PREPAID`, and `usage: DERIVED` for the first domain-bound use. Subsequent usage requires an actual successful prior use. Authority must exactly match `savedWalletConsent`, expiry, vault resource and fixed amount. The core may receive an immediately completed order/capture; ingest those resources without a second capture. Actual Fieldproof setup/exchange/merchant collection and unsupported capability outcomes are recorded separately from fixtures.

Failure classification follows the existing matrix: OAuth/encode failures are not sent, 4xx provider rejection is refused with a sanitized diagnostic, 5xx/connection/timeout/decode/abort-after-dispatch are uncertain. Non-SDK defects are not relabeled provider declines. Unknown operations hold their channel until current owned reads or authenticated webhook plus reads resolve them. No artificial failure may be represented as a native PayPal decline.

## Frozen collection execution extension

The domain freezes all eight exact consent/obligation/version/digest identities atomically before any collection write, persists the start and exact 48-hour end, and records the organizer's current authority. A saved-wallet read must be current before command creation and before dispatch. A stale/unknown/revoked token cannot create a payment. The exact original consent is durable; an expired browser session does not silently alter its terms. Collection authorization additionally requires the current active project membership of both the consenting actor and the approving organizer. View selection is not a membership grant. Revocation or changed package/consent/round/amount blocks dispatch.

Only the existing, resolved Orders create/get/capture and Payments get-capture contracts are used here. `PaymentCore.execute` receives a consent-bound `savedWallet` action and exact immutable request identity. The first live qualification has a global ceiling of 96000 cents across conditional original create commands; sandbox-test commands remain separately bounded by their existing contract. Capture of an owned approved original order is a continuation of the same charge, not a second budget entry. Immediately completed create resources are ingested once without capture. CREATED or PAYER_ACTION_REQUIRED is not settled money. Generic application refusal, missing token, authentication failure, rate limit and timeout are not a native payment decline. Only current explicit capture DENIED/DECLINED (or an actual normalized INSTRUMENT_DECLINED/PAYMENT_DENIED/CARD_EXPIRED provider rejection with no settled resource) enables same-obligation recovery. A known order is reread before deciding its next action.

Scheduled collection dispatch is permitted only for already frozen, exact human-approved rounds and current authority. Leases and one immutable command per obligation/action prevent concurrent jobs from issuing duplicates. Signed webhook workers remain observation-only. Scope-specific receipt totals use only the frozen obligations; earlier one-dollar connectivity receipts cannot fill a conditional contribution or a recovery shortfall. Refunds and excess remain in the canonical receipt ledger. The UI reports outstanding, uncertain, declined, buyer-action and settled states separately.

# Actual setup-request correction — provider description limit

The first actual Fieldproof setup attempt returned HTTP400 `INVALID_REQUEST`, with no setup ID or approval URL. The original consent/obligation and refused operation remain intact. The current official schema at `https://developer.paypal.com/api/payment-tokens/v3/setup-tokens-create` limits `payment_source.paypal.description` to128characters; the initial $35 description was148characters. `customer.merchant_customer_id` allows64characters, so its39character correlation is valid. The corrected description is114characters for$35 and115for$200; full accepted policy text and digest remain unchanged.

An explicit corrected setup request may use a new immutable request revision for the same consent and obligation only when the earlier exact known oversized-description payload was definitively refused with HTTP400 INVALID_REQUEST, has no owned setup ID, and is not pending/unknown. Do not overwrite the previous hash or reuse its request ID for changed bytes. Preserve this diagnostic distinction in the audit. The UI's explicit continuation invokes the corrected revision; page loading never resends. All new and corrected bodies validate the128character provider limit before dispatch.

Error diagnostics retain only bounded uppercase error/issue identifiers, validated JSON field paths, HTTPstatus and provider debugID. Never store or display free-text descriptions, rejected field values, raw request/response bodies, account data or credentials. The published evidence distinguishes this schema-supported diagnosis from a captured provider field diagnostic; the first adapter retained only the top-level error code.
# Core 0.2.4 storage and transport upgrade

Install only the immutable checked-in `vendor/fracture-paypal-core-0.2.4.tgz`, SHA256 `5c03e848a603c91f98f213c9bfee2e5e4ccb00fd54946ae349945c55f53c3f0f`. Root reports131PostgreSQL/SQLite/SDK/REST conformance tests. This is transport evidence, not Fieldproof invoice payment or reimbursement proof.

All application `SqlPaymentStore` instances use `{operationDocumentCodec:{encode(plaintext,context),decode(ciphertext,context)}}`, with AES-GCM associated data `paycore-operation:<tenantId>:<projectId>:<operationId>` derived from independent SQL row context. Existing plaintext operations remain readable without replacing their history; every new/transitioned operation is encrypted. Missing/wrong keys or changed scope fail closed. The separate `fp_payment_commands.command.action.savedWallet.vaultId` is also encrypted with operation/scope AAD; decode only within the trusted server policy/ingestion path. The store still performs its original immutable hash, identity, uniqueness, reservation and dispatch checks.

The new `SandboxCommerceRestGateway` is a separate typed-REST endpoint boundary for SDK-absent Invoicing/Payouts. Its README was read before use; domain orchestration remains to resolve exact request/response shapes before calling it. No notification, manual paid marker, or record-refund write is introduced by upgrading the package. Provider qualification of another merchant is not Fieldproof qualification.

## Existing owned wallet binding — observed customer reuse

The second actual approval returned an exact owned setup in VAULTED state and the same payer as the first wallet, but a different temporary setup customer. Its token exchange returned HTTP200 and was held as TOKEN_IDENTITY_UNPROVEN; the initial adapter failed to retain that candidate identity. A read-only list for that exact setup customer returned404 CUSTOMER_ID_NOT_FOUND. Neither that response nor VAULTED alone proves the exchange's token. The original exchange therefore remains unproven, with its original status and diagnostics intact.

Setup-customer identity and confirmed payment-token customer identity are distinct encrypted fields. Every future token response retains the candidate ID, customer correlation and observation hash encrypted before validation. Direct exchange binding still requires matching identity, and readiness always requires a fresh GET of the exact saved token. An HTTP200 response is never assumed to mean reuse.

An explicitly recorded existing-owned-wallet binding may authorize the same exact consent without claiming to recover an uncertain exchange. It requires the fresh owned setup's exact ID, VAULTED state, original merchant customer correlation, exact amount/condition description, MERCHANT usage, UNSCHEDULED_PREPAID usage and a real payer ID. The candidate must be a single distinct token already verified for this same tenant/project/actor through an earlier consent; withdrawn, unverified, cross-actor, cross-payer or multiple distinct candidates fail closed. A fresh GET must match that existing token/customer/merchant correlation and the setup payer. The immutable current consent and package version are checked again transactionally before storing the new binding and its read hashes. No exchange is resent, no consent or obligation is replaced, and no charge occurs during binding. The record identifies its source consent and method; prior refusals and unproven exchange observations remain separate.

This uses only the existing mapped GET setup and GET payment-token contracts. The bounded diagnostic list uses the already mapped listCustomerPaymentTokens and is not a token-selection authority. Installed `vault-response-customer.ts` describes merchantCustomerId as a merchant's customer mapping; it is not intrinsically a per-consent payment-token identifier. Existing setup requests and their request IDs remain immutable.

## Same-obligation recovery invoices

The pinned SDK has no Invoicing controller. The app uses only core0.2.4 `SandboxCommerceRestGateway` methods `createInvoice(DraftInvoice)`, `getInvoice(id)`, `findInvoices({invoiceNumber,reference})`, `sendInvoice(OwnedInvoice)` and `cancelInvoice(OwnedInvoice)`. The exact packaged TypeScript source and README were read. Draft shape: unique immutable invoiceNumber (at most25characters), reference (at most120), configured isolated merchantEmail, recipientEmail from the exact freshly verified owned wallet, one itemName and exact USD MinorMoney. Partial payments and tips are disabled. The transport uses current sandbox Invoicing v2, no notifications on share/cancel, and rejects a future issue date. Unknown creation searches the original identity; no new invoice number or original payment retry is permitted.

Domain authority requires an exact frozen consent/obligation, current membership, current package version, its remaining fixed window, a definitive original decline and zero settled credit. The same original obligation is locked and moves to an exclusive recovery channel before dispatch. One durable invoice record per obligation and one claimed provider operation per action bind the immutable encrypted request and observation. The acknowledged v1 UI policy already includes a recovery invoice for the same obligation. Creating or sharing an invoice is never a payment, and a browser return is never settlement evidence. The public owned projection supplies only the approved amount, current state, masked recipient, deadline, and allowlisted payer URL/QR.

Invoice payment transactions must have type PAYPAL, an actual payment ID and USD amount. EXTERNAL/manual records do not create credit. Independently corroborate the exact transaction through `client.payments.getCapturedPayment({captureId},{signal}).asApiResult()` (existing mapped GET `/v2/payments/captures/{capture_id}`), using pinned `CapturedPayment` fields id/status/amount/invoiceId/payee/supplementaryData/links. Followed imports `payee-base.ts`, `payment-supplementary-data.ts`, `related-identifiers.ts`. Require exact ID, COMPLETED, matching amount, and reject any contradictory invoice or merchant correlation. A missing/unsupported capture read remains payment evidence pending; do not manufacture a capture ID or infer a legacy-sale adapter. Canonical invoice-payment and capture aliases share one receipt and balanced journal. Refund attribution requires an independently proven parent resource; Invoicing's bookkeeping refund endpoint is never called.

Official references checked: [invoice details](https://developer.paypal.com/api/invoicing/v2/invoices-get), [invoice schema](https://developer.paypal.com/api/invoicing/v2/schema.json), [share semantics](https://developer.paypal.com/api/invoicing/v2/invoices-send). The recovery/cancellation worker rereads the original invoice after any uncertain result and at window expiry. A cancellation does not replace a final settlement check. Late double settlement stays an excess liability with the known Orders capture preferred for an actual refund.

## Core0.2.5 canonical commerce events

Upgrade to immutable `vendor/fracture-paypal-core-0.2.5.tgz`, SHA256 `53175e3b8abefe8d4683b8915c293a1b7b51acbde9880c9c6c9f57c09abdcd4b`, root commit f9c7034 and135 reported conformance tests. Operation encryption from0.2.4 is unchanged. The extension admits official invoice, payout-item and payout-batch events with coherent resource identity extraction. Conflicting identifiers remain dead letters. Intake remains observation-only; neither invoicePAID nor batchSUCCESS grants monetary credit or a recipient payout result. The app's workers must resolve the encrypted owned resource and perform current provider reads before changing accounting.

## Original-rail refunds and compensation

Use only the previously resolved shared-core `refund_capture` action and SDK GET capture/order/refund operations. Refund request fields are exact owned captureId, USD cents, optional proven sourceOrderId, stable business/request identities, and customId set by core to the immutable operationId. Core first reads the capture, uses the supported generated `refundCapturedPayment` request, and never retries an uncertain write. Domain approval is separate from transport.

Refund authority binds an existing canonical receipt, its immutable economic identity, an exact unallocated amount, and either a current deliberate owner/organizer approval or the already acknowledged incomplete-round/excess compensation rule. Reservations separate previously credited value from uncredited excess. Pending refunds reduce eligible funds; completed refunds reduce credited collections. Returning excess never reduces legitimate credit a second time. One operation and one journal result per exact refund prevent repeated callbacks from changing money twice.

Before dispatch, read the exact capture and its proven owning order when available; independently read every reported refund and corroborate capture parentage through exact allowlisted API paths. A partially refunded capture without sufficient proven history is blocked. Resource budget includes confirmed/pending external refunds plus all unmatched durable local reservations. Report a real provider refund ID and COMPLETED only when amount, currency and parent match the original request. A cancelled invoice, a refund request, an accepted provider request and a completed financial refund remain separate states. Unqualified invoice refund rails stay explicit remediation; no invoice record-refund call is introduced.

The SDK's normalized order resource does not echo purchase-unit amount/customId. Domain ownership therefore comes from the immutable create command and owned order mapping; when an optional normalized echo exists it must agree. The core capture preflight independently reads and validates the actual purchase-unit amount. Domain tests use this actual nullable normalized shape, not invented order-level echoes.

Core0.2.6 is the immutable metadata correction to0.2.5: `vendor/fracture-paypal-core-0.2.6.tgz`, SHA256 `099c2097279f90a706abdabb548e08874ef47d3abb4e91d52b3376df7f93cad9`, root commit4fc1d4c. It corrects the runtime version constant and adds a manifest/version consistency regression (136reported tests). Financial and event contracts are unchanged; old archives/evidence are preserved.

## Reviewed reimbursement and balance preflight

Use the already installed root-import `paypal` 2.29.0 SDK map `client.transactionSearch.searchBalances({currencyCode:'USD'},{signal}).asApiResult()` for GET `/v1/reporting/balances`. Read `BalancesResponse`, `BalanceInformation`, and `Money` definitions before implementation: `accountId`, `asOfTime`, `lastRefreshTime`, `balances[].currency`, `availableBalance`, `totalBalance`, and `withheldBalance` are the actual camelCase SDK fields. There is no invented balance reservation or account controller. The long-lived sandbox client has SDK retries/logging disabled. Missing/duplicate currency records, invalid timestamps/currency/amounts, 403, malformed responses, and transport errors do not produce usable liquidity.

The current official endpoint documentation states that reporting balances can take up to three hours to appear: https://developer.paypal.com/api/transaction-search/v1/balances-get/ . The application policy therefore checks both clocks: fetch within60seconds before dispatch, and both as-of/last-refresh timestamps no older than3hours, with no timestamp from the future. This bound is a disclosed conservative reporting policy, not a promise of instantaneous provider balances. Persist the actual timestamps and body hash. A new HTTP200 cannot refresh an old provider snapshot. Root's earlier stale snapshot remains historical evidence; it is not relabeled usable. A transactionally locked merchant allowance subtracts other held Payout reservations and known outflows not yet reflected by the snapshot, including refunds. Provider acceptance remains authoritative. Merchant-wide balance amounts remain private; a claim view reports only its exact preflight result and the clocks.

Payouts use the separately qualified core `SandboxCommerceRestGateway`, because the pinned SDK has no Payouts controller. Persist exact `CreatePayout {senderBatchId,requestId,items:[{senderItemId,recipientType:'PAYPAL_ID',receiver,money:{currency:'USD',minor}}]}` encrypted before dispatch. Bind the receiver to the claimant's current verified PayPal payer ID and verification version; never take a destination from an AI response or reviewer form. The separate approval includes claim/source/review versions, selected approved lines, package versions/restrictions, the shared receipt budget, current organizer membership, exact USD amount, destination version, expiry and immutable request hash. Source allocations lock canonical settlement receipts from funded rounds only; shortfall, refund reservations, excess and unqualified money cannot fund a claim. A disclosed internal20USD fee allowance is a liquidity/reservation policy, not a provider quote. Actual item fees are accounted separately and any unproved difference remains a reconciliation exception.

Create acceptance and batchSUCCESS are not repayment. Fresh exact complete-batch and item reads must match batch, sender IDs, receiver, currency and amount; only itemSUCCESS records a confirmed repayment and balanced allocation journals. UNCLAIMED, HELD/BLOCKED, PENDING, refused/unknown, returned and refunded states are distinct. Signed events are hints for owned fresh reads and never write Payouts. A lost creation can be deliberately recovered only with its byte-identical persisted batch/request identities within the documented30day duplicate window. There is no GET-by-sender-batch endpoint. Expired unknown creation keeps its reservations for remediation. Recipient/claim changes or expired authority cannot silently authorize another write. Cancel only an exact currently owned UNCLAIMED item and confirm its authoritative return; an unproved fee outcome remains separate.

## Exact recovery boundary (core 0.2.7)

Adopt the immutable `vendor/fracture-paypal-core-0.2.7.tgz` archive, SHA256 `a2ccc98af5da871e3c057bcdc142c303d0d1d2f2fa9a9a42324d566177fa1061`, with the reported 148 shared conformance tests. The prior archives remain intact. The added `recoverOperation(scope, operationId, signal?)` reconciles only the original, owned operation. Fieldproof selects its own bounded recovery candidates and never uses a broad recovery pass to cross a domain policy or initiate an untouched collection slot. This is an immutable package upgrade; no sibling runtime import or SDK identity change is introduced.

## Cutover maintenance boundary

The application adds a database-backed execution hold and leased API mutations before hosted migration. Read views, health and the one-use continuation remain available. Current transport injection is the installed `SandboxPayPalProvider(config, fetchImpl)` seam; the original Request, headers, credentials and AbortSignal are forwarded unchanged. Mutating PayPal resources recheck the hold immediately before network dispatch. OAuth token acquisition and signature verification may support reads; neither grants payment authority. The typed REST gateway uses its actual constructor seam after inspecting its declaration. No shared-core source is changed. Requests already in progress and durable worker leases must drain before snapshot/import; the fixed collection deadline and original operation identities are unchanged.
