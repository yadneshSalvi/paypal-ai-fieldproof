import "./helpers/toolkit-deny-network.mjs";
import { after, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { AxiosStatic, InternalAxiosRequestConfig } from "axios";
import { createScopedToolkitTransport, readNativeToolkit, ToolkitTransportError, TOOLKIT_RESOURCE_MAX_BYTES, TOOLKIT_OAUTH_MAX_BYTES } from "../lib/server/studio-toolkit-transport";
import { toolkitNetworkAttempts, toolkitDeniedNetworkReceipt } from "./helpers/toolkit-deny-network.mjs";
import { qualifyToolkitTrace } from "./helpers/toolkit-trace.mjs";

const require = createRequire(import.meta.url), entry = require.resolve("@paypal/agent-toolkit/openai"), own = createRequire(entry);
const globalAxios = own("axios") as AxiosStatic, originalAdapter = globalAxios.defaults.adapter, originalGet = globalAxios.get, originalPost = globalAxios.post;
const order = "5O190127TN364715T", invoice = "INV2-TEST-ONLY-1234";
const credentials = { clientId: "synthetic-transport-client", clientSecret: "synthetic-transport-secret" };
type Options = Parameters<typeof createScopedToolkitTransport>[0];
type Scope = ReturnType<typeof createScopedToolkitTransport>;
type WireCall = { url: string; init: RequestInit };
const accepted = (id = order) => ({ id, status: "COMPLETED", metadata: { synthetic: true } });
const token = { access_token: "synthetic-access-token", token_type: "Bearer" };
function transport(responder: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: WireCall[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => { const url = String(input); calls.push({ url, init }); return responder(new URL(url), init); };
  return { calls, fetcher };
}
const request = (options: Partial<Options> = {}): Options => ({ tool: "get_order", providerId: order, ...credentials, ...options });
async function native(scope: Scope, tool = "get_order", id = order) {
  const toolkit = scope.nativeToolkit();
  const response = await toolkit.handleToolCall({ id: "controlled-native-read", type: "function", function: { name: tool, arguments: JSON.stringify(tool === "get_invoice" ? { invoice_id: id } : { id }) } });
  scope.assertComplete(); return JSON.parse(String(response.content)) as unknown;
}
after(() => {
  assert.equal(toolkitNetworkAttempts(), 0, JSON.stringify(toolkitDeniedNetworkReceipt()));
  assert.equal(globalAxios.defaults.adapter, originalAdapter); assert.equal(globalAxios.get, originalGet); assert.equal(globalAxios.post, originalPost);
});

describe("unchanged native Toolkit with an isolated Axios instance", () => {
  it("executes both exact native GET functions and separate OAuth scopes without changing global Axios", async () => {
    const wire = transport((url, init) => {
      assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit"); assert.equal(init.cache, "no-store"); assert.ok(init.signal);
      if (url.pathname === "/v1/oauth2/token") { assert.equal(init.method, "POST"); assert.equal(init.body, "grant_type=client_credentials"); return Response.json(token); }
      assert.equal(init.method, "GET"); assert.equal(init.body, undefined); assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${token.access_token}`);
      return Response.json(accepted(url.pathname.split("/").at(-1)));
    });
    assert.equal((await readNativeToolkit(request({ fetcher: wire.fetcher })) as { id: string }).id, order);
    assert.equal((await readNativeToolkit(request({ tool: "get_invoice", providerId: invoice, fetcher: wire.fetcher })) as { id: string }).id, invoice);
    assert.deepEqual(wire.calls.map(call => [call.init.method, new URL(call.url).pathname]), [
      ["POST", "/v1/oauth2/token"], ["GET", `/v2/checkout/orders/${order}`], ["POST", "/v1/oauth2/token"], ["GET", `/v2/invoicing/invoices/${invoice}`],
    ]);
    assert.equal(globalAxios.defaults.adapter, originalAdapter);
  });
  it("keeps concurrent tokens, resource identities and request counts in independent scopes", async () => {
    const calls: string[] = [], releases: (() => void)[] = [];
    const read = (id: string, clientId: string) => readNativeToolkit(request({ providerId: id, clientId, fetcher: async (input, init = {}) => {
      const url = new URL(String(input)); calls.push(`${clientId}:${init.method}:${url.pathname}`);
      if (init.method === "POST") {
        await new Promise<void>(resolve => { releases.push(resolve); if (releases.length === 2) releases.forEach(release => release()); });
        return Response.json({ access_token: `token-${clientId}` });
      }
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer token-${clientId}`);
      assert.equal(url.pathname, `/v2/checkout/orders/${id}`); return Response.json(accepted(id));
    } }));
    const [a, b] = await Promise.all([read("CONTROLLED-ORDER-A", "client-A"), read("CONTROLLED-ORDER-B", "client-B")]);
    assert.equal((a as { id: string }).id, "CONTROLLED-ORDER-A"); assert.equal((b as { id: string }).id, "CONTROLLED-ORDER-B"); assert.equal(calls.length, 4);
  });
  it("does not inherit unrelated global Axios request or response transforms", async () => {
    const beforeRequest = globalAxios.defaults.transformRequest, beforeResponse = globalAxios.defaults.transformResponse; let requests = 0, responses = 0;
    globalAxios.defaults.transformRequest = [data => { requests++; return typeof data === "string" ? `${data}&scope=unapproved` : data; }];
    globalAxios.defaults.transformResponse = [() => { responses++; return { id: order, status: "SYNTHETIC_FALSE_OBSERVATION" }; }];
    const wire = transport(url => Response.json(url.pathname === "/v1/oauth2/token" ? token : accepted()));
    try { const result = await readNativeToolkit(request({ fetcher: wire.fetcher })) as { status: string }; assert.equal(result.status, "COMPLETED"); assert.equal(requests, 0); assert.equal(responses, 0); assert.equal(wire.calls.length, 2); }
    finally { globalAxios.defaults.transformRequest = beforeRequest; globalAxios.defaults.transformResponse = beforeResponse; }
  });
  it("denies a different instance's admitted config even when credentials and owned path match", async () => {
    const wire = transport(() => Response.json(token)), a = createScopedToolkitTransport(request({ fetcher: wire.fetcher })), b = createScopedToolkitTransport(request({ fetcher: wire.fetcher }));
    b.axios.interceptors.request.use(async config => { await a.adapter(config); return config; });
    try { await assert.rejects(native(b), ToolkitTransportError); assert.throws(() => a.assertComplete(), ToolkitTransportError); assert.equal(wire.calls.length, 0); }
    finally { a.dispose(); b.dispose(); }
  });
  it("rejects unapproved native operations and unbounded/hostile identities before any transport", async () => {
    const wire = transport(() => Response.json(token));
    for (const extra of [{ tool: "create_order" }, { providerId: `${order}?foreign=1` }, { providerId: "../FOREIGN" }, { providerId: "x".repeat(1000) }, { deadlineMs: 25_001 }]) {
      await assert.rejects(readNativeToolkit(request({ ...extra, fetcher: wire.fetcher } as Partial<Options>)), ToolkitTransportError);
    }
    assert.equal(wire.calls.length, 0);
  });
});

describe("streamed limits before JSON parsing", () => {
  for (const stage of ["oauth", "resource"] as const) it(`cancels and aborts valid oversized ${stage} JSON before parsing`, async () => {
    const cap = stage === "oauth" ? TOOLKIT_OAUTH_MAX_BYTES : TOOLKIT_RESOURCE_MAX_BYTES;
    const payload = JSON.stringify({ ...(stage === "oauth" ? token : accepted()), padding: "x".repeat(cap + 1) });
    let cancelled = false, parsed = false, signal: AbortSignal | null = null;
    const parse = JSON.parse, spy = mock.method(JSON, "parse", (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => { if (text === payload) parsed = true; return parse(text, reviver); });
    const wire = transport((url, init) => {
      if ((stage === "oauth") === (url.pathname === "/v1/oauth2/token")) {
        signal = init.signal!;
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); }, cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } });
      }
      return Response.json(token);
    });
    try {
      await assert.rejects(readNativeToolkit(request({ fetcher: wire.fetcher })), ToolkitTransportError);
      assert.equal(cancelled, true); assert.equal(parsed, false); assert.equal((signal as AbortSignal | null)?.aborted, true); assert.equal(wire.calls.length, stage === "oauth" ? 1 : 2);
    } finally { spy.mock.restore(); }
  });
  it("refuses an oversized declared body without reading it and still cancels the source", async () => {
    let reads = 0, cancelled = false;
    const wire = transport(() => new Response(new ReadableStream<Uint8Array>({ pull() { reads++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json", "content-length": String(TOOLKIT_OAUTH_MAX_BYTES + 1) } }));
    await assert.rejects(readNativeToolkit(request({ fetcher: wire.fetcher })), ToolkitTransportError); assert.equal(reads, 0); assert.equal(cancelled, true);
  });
  it("withholds malformed/foreign response data and invalid OAuth tokens", async () => {
    for (const value of [{ access_token: "has whitespace" }, { access_token: "valid", token_type: "Basic" }, {}, []]) {
      const wire = transport(() => Response.json(value)); await assert.rejects(readNativeToolkit(request({ fetcher: wire.fetcher })), ToolkitTransportError); assert.equal(wire.calls.length, 1);
    }
    for (const response of [() => new Response("{unfinished", { headers: { "content-type": "application/json" } }), () => Response.json(accepted("FOREIGN-ORDER")), () => new Response("{}", { headers: { "content-type": "text/html" } })]) {
      const wire = transport(url => url.pathname === "/v1/oauth2/token" ? Response.json(token) : response()); await assert.rejects(readNativeToolkit(request({ fetcher: wire.fetcher })), ToolkitTransportError);
    }
  });
});

describe("real abort across the entire native read", () => {
  for (const stage of ["oauth", "resource"] as const) for (const waiting of ["fetch", "body"] as const) it(`aborts a pending ${stage} ${waiting} at the fixed deadline`, async () => {
    let aborted = false, cancelled = false;
    const wire = transport((url, init) => {
      if ((stage === "oauth") !== (url.pathname === "/v1/oauth2/token")) return Response.json(token);
      init.signal!.addEventListener("abort", () => { aborted = true; }, { once: true });
      if (waiting === "fetch") return new Promise<Response>(() => {}); // Even a hostile fetch double cannot keep the native result alive.
      return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } });
    });
    const started = Date.now(); await assert.rejects(readNativeToolkit(request({ fetcher: wire.fetcher, deadlineMs: 200 })), ToolkitTransportError);
    assert.equal(aborted, true); if (waiting === "body") assert.equal(cancelled, true); assert.ok(Date.now() - started < 2000); assert.equal(wire.calls.length, stage === "oauth" ? 1 : 2);
  });
});

const mutations: [string, (config: InternalAxiosRequestConfig) => void][] = [
  ["foreign origin", config => { config.url = "https://foreign.invalid/v2/checkout/orders/CONTROLLED"; }],
  ["live origin", config => { config.url = `https://api.paypal.com/v2/checkout/orders/${order}`; }],
  ["alternate port spelling", config => { config.url = `https://api.sandbox.paypal.com:443/v2/checkout/orders/${order}`; }],
  ["altered owned path", config => { config.url = `https://api.sandbox.paypal.com/v2/checkout/orders/FOREIGN-ORDER`; }],
  ["financial write", config => { config.method = "POST"; config.url = "https://api.sandbox.paypal.com/v2/payments/captures/CONTROLLED/refund"; config.data = "{}"; }],
  ["URL query", config => { config.url += "?extra=true"; }],
  ["Axios query", config => { config.params = { extra: "true" }; }],
  ["extra body", config => { config.data = "{}"; }],
  ["arbitrary header", config => { config.headers.set("X-Unapproved", "synthetic"); }],
  ["another token", config => { config.headers.set("Authorization", "Bearer another-scope"); }],
];
describe("closed request and HTTP boundary", () => {
  for (const [label, change] of mutations) it(`denies ${label} before resource dispatch`, async () => {
    const wire = transport(() => Response.json(token)), scope = createScopedToolkitTransport(request({ fetcher: wire.fetcher }));
    scope.axios.interceptors.request.use(config => { if (config.method?.toUpperCase() === "GET") change(config); return config; });
    try { await assert.rejects(native(scope), ToolkitTransportError); assert.equal(wire.calls.length, 1); assert.equal(scope.signal.aborted, true); }
    finally { scope.dispose(); }
  });
  for (const [stage, status] of [["oauth", 401], ["resource", 301], ["resource", 404], ["resource", 429], ["resource", 503]] as const) it(`retains HTTP ${status} ${stage} refusal even when native dispatch serializes it`, async () => {
    const wire = transport(url => Response.json(url.pathname === "/v1/oauth2/token" ? token : accepted(), { status: (stage === "oauth") === (url.pathname === "/v1/oauth2/token") ? status : 200, headers: { location: "https://foreign.invalid/" } }));
    const scope = createScopedToolkitTransport(request({ fetcher: wire.fetcher }));
    try { await assert.rejects(native(scope), ToolkitTransportError); assert.deepEqual(scope.failure, { reason: "http", httpStatus: status }); assert.equal(wire.calls.length, stage === "oauth" ? 1 : 2); assert.ok(wire.calls.every(call => call.init.redirect === "error")); }
    finally { scope.dispose(); }
  });
  it("fails before native dispatch when the installed official entry bytes drift", async () => {
    const original = fs.readFileSync, actual = original(entry), wire = transport(() => Response.json(token));
    const spy = mock.method(fs, "readFileSync", ((file: unknown, ...args: unknown[]) => file === entry ? Buffer.concat([actual, Buffer.from("\n// controlled byte drift")]) : Reflect.apply(original, fs, [file, ...args])) as typeof fs.readFileSync);
    syncBuiltinESMExports();
    try { await assert.rejects(readNativeToolkit(request({ fetcher: wire.fetcher })), ToolkitTransportError); assert.equal(wire.calls.length, 0); }
    finally { spy.mock.restore(); syncBuiltinESMExports(); }
    assert.deepEqual(fs.readFileSync(entry), actual);
  });
});

it("executes both native reads from the explicit production NFT closure with parent dependency fallback forbidden", { timeout: 45_000 }, async () => {
  const result = await qualifyToolkitTrace(); assert.ok(result.copiedFileCount > 7); assert.equal(result.receipt.nativeFactoryExecuted, true); assert.equal(result.receipt.publicNativeEntryInRequireCache, false);
});
