# Bounded native Toolkit reads

Fieldproof uses the official `@paypal/agent-toolkit@1.11.0` OpenAI adapter for
two exact owned reads. This is separate from Fieldproof's APIMatic `paypal`
client and financial core. Neither financial adapter is changed. Qualification
uses controlled synthetic transport; it establishes no real provider execution
or audit-clean dependency tree.

## Exact admission and native execution

The existing server resolves an app receipt to its stored provider identity
after current role, scoped report inventory, original receipt provenance,
payment rail and ownership checks. Only `get_order` and `get_invoice` are
admitted. The caller cannot supply a provider ID, URL, native arguments, schema,
header or query. After the native read, the existing current-authority,
returned-identity and merchant checks remain in place; only the existing
redacted observation leaves `readOwnedToolkitResource`.

Toolkit 1.11.0 closes both selected functions and OAuth over module-level Axios
imports. Its public client has no transport injection option. The
instance boundary evaluates the unchanged, hash-pinned public CJS OpenAI bundle
in a private module factory, substituting only that module's `require("axios")`
with an isolated Axios instance. All other fixed imports resolve relative to
the original public entry. Native construction, static tool inventory,
`handleToolCall`, argument parsing and selected native functions still execute.
No native source rewriting, private client-field access, global Axios mutation,
global interceptor or `require.cache` replacement is permitted. The accepted
OpenAI bundle SHA-256 is
`4bc5b11ffeeed7241e18431551c80ed0719fe18809192c7c0d2d5f217927e532`;
different installed bytes fail closed until separately qualified.

## One instance, one exact observation

Each short-lived read has one tool, one owned provider ID, one credential pair,
one deadline and one independent failure latch. Its native Axios adapter admits:

1. One POST to `https://api.sandbox.paypal.com/v1/oauth2/token`, with exactly
   `grant_type=client_credentials` and the original synthetic-or-configured
   credential pair in Basic authorization.
2. One GET to the selected exact `/v2/checkout/orders/{storedId}` or
   `/v2/invoicing/invoices/{storedId}`, using the token returned by that same
   instance's bounded OAuth response.

Another origin, port spelling, path, method, body, query, header, repeated
request or foreign instance token is refused before dispatch. Native Axios
defaults do not authorize extra headers or redirects; the private instance also
sets its own identity transforms and signal so unrelated global defaults
cannot replace the request or provider observation. There is no transport
retry. A new scope does not reuse another scope's cached access token.

The transport uses `redirect: "error"` and a real AbortController deadline of
at most 25 seconds spanning OAuth, the resource fetch and streamed body reads.
OAuth is capped at 16 KiB; a resource is capped at 1 MiB. These are byte caps
checked while reading and before JSON parsing. Oversize, failed HTTP, invalid
JSON, timeout, cancellation or native request drift cancels/aborts outstanding
work and withholds the observation. A native error serialized by the Toolkit
cannot clear the independent transport failure latch or become successful data.

## Qualified scope and evidence

Only controlled synthetic transport tests are authorized for this unit. All
raw network, DNS, HTTP and real fetch paths are denied; no application runtime,
database, provider/model/email credential or endpoint is accessed. A test-only
module boundary supplies exact controlled database/report records for the six
existing owned-read behavioral tests. It does not claim PostgreSQL transaction
or financial-provider qualification.

The 36 focused controls execute both real native GET functions and exercise
oversized OAuth/resource cancellation, hostile origin/path/write/query/header,
redirect/error statuses, deadline abort, concurrent independent scopes and
closed native dispatch. The owned-read controls retain current role/source
checks, exact rail/receipt ownership, merchant mismatch, post-read revocation,
sub-millisecond cutoff inclusion and the metadata-only public result. Original
receipt/financial fixture values remain unchanged on failed reads. Full
nonincremental TypeScript qualification also passes. The retained legacy red
control accepted a valid response larger than 1 MiB; the corrected native path
cancels and rejects that same controlled response. A second retained red
control proves why inherited global Axios transforms must be excluded.

Run from the checkout root with Node 22.22.3 and the exact locked installation:

```sh
node --import tsx --test --test-concurrency=1 tests/studio-toolkit.test.ts tests/studio-toolkit-transport.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

The tests install their explicit network guard before loading application/native
modules. Loading it before the test framework itself also blocks tsx's own local
Unix IPC startup; that retained diagnostic is distinct from provider traffic.
The qualified commands permit no raw socket, DNS, HTTP or real fetch attempt.

## Required production file trace

Next's installed file tracer silently omits the native CJS closure when given
only the dynamically resolving transport module. An explicit native entry root
produces 1,578 required `node_modules` files. The release therefore also requires
the integration-owned `config/toolkit-runtime-trace.json` and `next.config.ts`
validation/inclusion for `/api/studio/**`. The committed list must match the
exact package-lock hash and official SDK byte pin, contain only unique explicit
paths inside real `node_modules`, and refuse missing/escaping paths. Including
only the native entry as an asset does not prove recursive dependency inclusion.

The focused closure control transpiles this real runtime module to ordinary
production JavaScript, copies exactly the explicit NFT closure, and executes
both native reads from that copy. Node filesystem permissions forbid access to
the parent dependency installation; all 1,510 normal CJS dependency-cache files
come from the copied closure. The official source itself executes in the private
factory outside `require.cache`, recorded separately from those normal imports.
The integration owner must also inspect the final real Studio route's production
NFT file for every explicit list item after the joined build. This narrow unit
does not start or qualify an application runtime or deployment.

Remaining package-level advisories and observed module loads belong to the
separate dependency exposure review. Bounded execution limits this read path;
it does not patch an installed vulnerable package or qualify other adapters,
arbitrary native dispatch, tracing, model processing or financial writes.
