import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { platform, release } from "node:os";
import { compileFunction } from "node:vm";
import type { PayPalAgentToolkit as NativeToolkit } from "@paypal/agent-toolkit/openai";
import type { AxiosAdapter, AxiosInstance, AxiosStatic, InternalAxiosRequestConfig } from "axios";

export const TOOLKIT_OPENAI_SHA256 = "4bc5b11ffeeed7241e18431551c80ed0719fe18809192c7c0d2d5f217927e532";
export const TOOLKIT_RESOURCE_MAX_BYTES = 1024 * 1024;
export const TOOLKIT_OAUTH_MAX_BYTES = 16 * 1024;
export const TOOLKIT_DEADLINE_MS = 25_000;
const origin = "https://api.sandbox.paypal.com";
const nativeRequire = createRequire(import.meta.url);
const allowedRequires = new Set(["axios", "zod", "mathjs", "lodash", "debug", "@paypal/paypal-server-sdk", "buffer", "os"]);
type Tool = "get_order" | "get_invoice";
type Failure = { reason: "request" | "http" | "body" | "deadline" | "transport" | "native"; httpStatus: number | null };
type Factory = (exports: object, require: (name: string) => unknown, module: { exports: unknown }, filename: string, directory: string) => void;
let compiled: { entry: string; factory: Factory } | undefined;

export class ToolkitTransportError extends Error {
  readonly code = "TOOLKIT_READ_UNAVAILABLE";
  constructor() { super("The exact PayPal read could not complete. No financial record was changed."); }
}
export interface ToolkitTransportOptions {
  tool: Tool;
  providerId: string;
  clientId: string;
  clientSecret: string;
  fetcher?: typeof fetch;
  /** Internal callers may shorten, never extend, the fixed production budget. */
  deadlineMs?: number;
}

function nativeSource() {
  const entry = nativeRequire.resolve("@paypal/agent-toolkit/openai"), stat = statSync(entry);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new ToolkitTransportError();
  const bytes = readFileSync(entry);
  if (createHash("sha256").update(bytes).digest("hex") !== TOOLKIT_OPENAI_SHA256) throw new ToolkitTransportError();
  if (!compiled || compiled.entry !== entry) {
    // The unchanged official CJS bundle has no per-instance transport option.
    // A private module binds its two Axios imports to this instance. This is
    // not a sandbox for untrusted code and does not edit require.cache.
    compiled = { entry, factory: compileFunction(bytes.toString("utf8"), ["exports", "require", "module", "__filename", "__dirname"], { filename: entry }) as Factory };
  }
  return { entry, factory: compiled.factory, require: createRequire(entry) };
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ToolkitTransportError());
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(new ToolkitTransportError()); };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    work.then(value => { cleanup(); resolve(value); }, () => { cleanup(); reject(new ToolkitTransportError()); });
  });
}

/** Runtime adapter seam. Axios, token, failure latch, admission identities and
 * AbortController are never shared with another native read. */
export function createScopedToolkitTransport(options: ToolkitTransportOptions) {
  const { tool, providerId, clientId, clientSecret } = options, budget = options.deadlineMs ?? TOOLKIT_DEADLINE_MS;
  if ((tool !== "get_order" && tool !== "get_invoice") || !/^[A-Z0-9-]{8,60}$/.test(providerId)
    || ![clientId, clientSecret].every(value => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\r\n]/.test(value))
    || !Number.isInteger(budget) || budget < 1 || budget > TOOLKIT_DEADLINE_MS) throw new ToolkitTransportError();
  const source = nativeSource(), axios = source.require("axios") as AxiosStatic;
  const controller = new AbortController(), deadline = Date.now() + budget, admitted = new WeakSet<object>();
  const fetcher = options.fetcher ?? globalThis.fetch;
  const expectedResource = `${origin}${tool === "get_order" ? "/v2/checkout/orders/" : "/v2/invoicing/invoices/"}${providerId}`;
  const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  const userAgent = `PayPal Agent Toolkit Typescript: OPENAI, Version: 1.11.0, on OS: ${platform()} ${release()}`;
  let phase: "oauth" | "oauth_pending" | "resource" | "resource_pending" | "complete" = "oauth";
  let failure: Failure | null = null, token: string | null = null, closed = false;
  const fail = (reason: Failure["reason"], httpStatus: number | null = null) => {
    failure ??= { reason, httpStatus };
    if (!controller.signal.aborted) controller.abort(new ToolkitTransportError());
    return new ToolkitTransportError();
  };
  const timer = setTimeout(() => fail("deadline"), budget);
  const current = () => {
    if (Date.now() >= deadline && !failure) fail("deadline");
    if (failure || closed || controller.signal.aborted) throw new ToolkitTransportError();
  };
  async function boundedJson(response: Response, cap: number): Promise<unknown> {
    if (!response.body) throw fail("body");
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > cap)) throw fail("body");
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw fail("body");
      for (;;) {
        current(); const { done, value } = await abortable(reader.read(), controller.signal); current();
        if (done) break;
        size += value.byteLength;
        if (size > cap) throw fail("body");
        chunks.push(value);
      }
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown; }
      catch { throw fail("body"); }
    } finally { controller.signal.removeEventListener("abort", cancel); cancel(); }
  }
  const adapter: AxiosAdapter = async config => {
    try {
      current();
      // B's config cannot use A's adapter even if its URL/credentials match.
      if (!admitted.delete(config)) throw fail("request");
      const oauth = phase === "oauth", method = (config.method ?? "").toUpperCase(), url = config.url;
      if ((!oauth && phase !== "resource") || url !== (oauth ? `${origin}/v1/oauth2/token` : expectedResource)
        || method !== (oauth ? "POST" : "GET") || config.baseURL !== undefined || config.params !== undefined
        || config.paramsSerializer !== undefined || config.auth !== undefined
        || (oauth ? config.data !== "grant_type=client_credentials" : config.data !== undefined)) throw fail("request");
      const headers = config.headers.toJSON(), expected = {
        accept: "application/json, text/plain, */*", "content-type": oauth ? "application/x-www-form-urlencoded" : "application/json",
        authorization: oauth ? basic : `Bearer ${token}`, "user-agent": userAgent,
      };
      if (Object.keys(headers).length !== Object.keys(expected).length || Object.entries(headers).some(([key, value]) =>
        typeof value !== "string" || !Object.hasOwn(expected, key.toLowerCase()) || value !== expected[key.toLowerCase() as keyof typeof expected])) throw fail("request");
      phase = oauth ? "oauth_pending" : "resource_pending";
      const wireHeaders = new Headers(); for (const [key, value] of Object.entries(expected)) wireHeaders.set(key, value);
      const response = await abortable(fetcher(url!, { method, headers: wireHeaders, ...(oauth ? { body: "grant_type=client_credentials" } : {}),
        signal: controller.signal, redirect: "error", credentials: "omit", cache: "no-store" }), controller.signal);
      current();
      if (response.redirected || response.url && response.url !== url) { void response.body?.cancel().catch(() => undefined); throw fail("request"); }
      if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw fail("http", response.status); }
      const body = await boundedJson(response, oauth ? TOOLKIT_OAUTH_MAX_BYTES : TOOLKIT_RESOURCE_MAX_BYTES); current();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw fail("body");
      if (oauth) {
        const data = body as Record<string, unknown>;
        if (typeof data.access_token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(data.access_token)
          || data.token_type !== undefined && data.token_type !== "Bearer") throw fail("body");
        token = data.access_token; phase = "resource";
      } else phase = "complete";
      return { data: body, status: response.status, statusText: "OK", headers: { "content-type": "application/json" }, config };
    } catch (error) { if (!failure) fail("transport"); throw error instanceof ToolkitTransportError ? error : new ToolkitTransportError(); }
  };
  // Native requests already contain the exact form string. Unrelated global
  // transforms must not rewrite it or replace the provider observation.
  const instance = axios.create({ adapter, signal: controller.signal, proxy: false, maxRedirects: 0, timeout: budget, maxContentLength: TOOLKIT_RESOURCE_MAX_BYTES,
    maxBodyLength: TOOLKIT_OAUTH_MAX_BYTES, transformRequest: [data => data], transformResponse: [data => data] });
  instance.interceptors.request.use((config: InternalAxiosRequestConfig) => { admitted.add(config); return config; });
  // Native code receives only its used Axios surface. Tests may exercise the
  // actual isolated instance, never another application's Axios singleton.
  const facade = Object.freeze({ get: instance.get.bind(instance), post: instance.post.bind(instance), isAxiosError: axios.isAxiosError });
  return {
    axios: instance as AxiosInstance,
    adapter,
    signal: controller.signal,
    get failure(): Readonly<Failure> | null { return failure ? { ...failure } : null; },
    nativeToolkit(): NativeToolkit {
      current(); const module = { exports: {} as unknown };
      source.factory(module.exports as object, name => {
        if (!allowedRequires.has(name)) throw fail("native");
        return name === "axios" ? facade : source.require(name);
      }, module, source.entry, dirname(source.entry));
      const Constructor = (module.exports as { PayPalAgentToolkit?: typeof NativeToolkit }).PayPalAgentToolkit;
      if (typeof Constructor !== "function") throw fail("native");
      const toolkit = new Constructor({ clientId, clientSecret, configuration: { actions: { orders: { get: true }, invoices: { get: true } }, context: { sandbox: true, debug: false } } });
      if (JSON.stringify(toolkit.getTools().map(item => item.type === "function" ? item.function.name : "").sort()) !== '["get_invoice","get_order"]') throw fail("native");
      return toolkit;
    },
    assertComplete() { current(); if (phase !== "complete") throw fail("native"); },
    dispose() { closed = true; token = null; clearTimeout(timer); if (phase !== "complete" && !controller.signal.aborted) controller.abort(new ToolkitTransportError()); },
  };
}

/** Preserve native dispatch; only server-constructed scalar arguments reach it. */
export async function readNativeToolkit(options: ToolkitTransportOptions): Promise<unknown> {
  const scope = createScopedToolkitTransport(options);
  try {
    const toolkit = scope.nativeToolkit(), parameters = options.tool === "get_order" ? { id: options.providerId } : { invoice_id: options.providerId };
    const response = await abortable(toolkit.handleToolCall({ id: randomUUID(), type: "function", function: { name: options.tool, arguments: JSON.stringify(parameters) } }), scope.signal);
    scope.assertComplete();
    if (typeof response.content !== "string" || response.content.length > TOOLKIT_RESOURCE_MAX_BYTES) throw new ToolkitTransportError();
    const value: unknown = JSON.parse(response.content);
    if (!value || typeof value !== "object" || "error" in value || !("id" in value) || value.id !== options.providerId) throw new ToolkitTransportError();
    return value;
  } catch { throw new ToolkitTransportError(); }
  finally { scope.dispose(); }
}
