"use client";
import { z } from "zod";
import { workspaceFetch } from "../community/workspace-fetch";
import * as C from "./contracts";

export class ProcurementRequestError extends Error {
  constructor(message: string, public code: string, public status = 0) { super(message); this.name = "ProcurementRequestError"; }
}
export class ProcurementStaleResponse extends Error { constructor() { super("This response belongs to an earlier project, selection or review."); this.name = "ProcurementStaleResponse"; } }
export const procurementAccessChanged = (error: unknown) => error instanceof ProcurementRequestError && ([401, 403].includes(error.status) || ["PROCUREMENT_CONTEXT_CHANGED", "PROCUREMENT_AUTHORITY_ENDED", "WORKSPACE_CONTEXT_CHANGED", "VOLUNTEER_ENTRY_CONTEXT_CHANGED"].includes(error.code));
export const procurementRetryRetained = (error: unknown) => !(error instanceof ProcurementRequestError) || error.status === 0 || error.status >= 500 || ["PROCUREMENT_BUSY", "VOLUNTEER_ENTRY_BUSY", "WORKSPACE_MAINTENANCE"].includes(error.code);
export interface ProcurementRequestOptions { body?: unknown; rawBody?: BodyInit; contentType?: string; scope?: string | null; entry?: boolean; signal?: AbortSignal; }

/** Entry and context bootstrap deliberately use their own cookie-bound scope,
 * without an old page-project header. Ordinary commands keep both boundaries.
 * This is essential when a lost response already wrote the original cookie. */
export function createProcurementBoundary(fetcher: typeof fetch = fetch, projectFetcher: typeof fetch = workspaceFetch) {
  let epoch = 0, disposed = false;
  const controllers = new Set<AbortController>();
  function invalidate() { epoch++; for (const controller of controllers) controller.abort(); controllers.clear(); }
  return {
    invalidate,
    activate() { disposed = false; invalidate(); },
    dispose() { disposed = true; invalidate(); },
    async request<T>(path: string, schema: z.ZodType<T>, options: ProcurementRequestOptions = {}): Promise<T> {
      if (disposed || path !== "" && (!/^\/(?:[A-Za-z0-9_/?=&.%:-]*)$/.test(path) || path.startsWith("//") || path.includes(".."))) throw new ProcurementStaleResponse();
      const started = epoch, controller = new AbortController(), abort = () => controller.abort(); controllers.add(controller); options.signal?.addEventListener("abort", abort, { once: true });
      const headers = new Headers({ Accept: "application/json" }); if (options.scope) headers.set(C.PROCUREMENT_SCOPE_HEADER, options.scope); if (options.body !== undefined) headers.set("Content-Type", "application/json"); else if (options.contentType) headers.set("Content-Type", options.contentType);
      try {
        const response = await (options.entry ? fetcher : projectFetcher)(`/api/procurement${path}`, { method: options.body === undefined && options.rawBody === undefined ? "GET" : "POST", headers, body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]), cache: "no-store", credentials: "same-origin", redirect: "error" });
        if (disposed || started !== epoch || controller.signal.aborted) throw new ProcurementStaleResponse();
        const raw: unknown = await response.json();
        if (disposed || started !== epoch || controller.signal.aborted) throw new ProcurementStaleResponse();
        if (!response.ok) { const problem = z.object({ error: z.string().max(1400), code: z.string().max(100) }).safeParse(raw); throw new ProcurementRequestError(problem.success ? problem.data.error : "This request could not finish. Retain the same original request and check its current result.", problem.success ? problem.data.code : "REQUEST_UNAVAILABLE", response.status); }
        const value = schema.safeParse(raw); if (!value.success) throw new ProcurementRequestError("The returned view could not be verified. Reload its current scope before using private details.", "REQUEST_UNAVAILABLE", 502);
        return value.data;
      } catch (error) {
        if (disposed || started !== epoch || controller.signal.aborted || error instanceof ProcurementStaleResponse) throw new ProcurementStaleResponse();
        if (error instanceof ProcurementRequestError) throw error;
        throw new ProcurementRequestError("The connection paused before the result was confirmed. Keep this original request; retrying it will check the same saved decision.", "REQUEST_UNAVAILABLE", 0);
      } finally { controllers.delete(controller); options.signal?.removeEventListener("abort", abort); }
    },
  };
}

export const PROCUREMENT_PENDING_KEY = "fieldproof.procurement.pending.v1";
const scope = z.string().regex(/^[a-f0-9]{64}$/), id = z.uuid();
const pendingSchema = z.object({ version: z.literal(1), path: z.string().max(200), scope, intentId: id, expiresAt: z.iso.datetime(), savedAt: z.iso.datetime(), outcome: z.enum(["pending", "rejected"]), input: z.unknown() }).strict();
export type ProcurementPending = z.infer<typeof pendingSchema>;
export interface ProcurementStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void; }
export function procurementCommandInput(path: string, raw: unknown) {
  if (path === "/suppliers") return C.supplierSaveSchema.parse(raw);
  if (/^\/suppliers\/[a-f0-9-]{36}\/state$/.test(path)) return C.supplierStateSchema.parse(raw);
  if (path === "/quotes") return C.quoteSaveSchema.parse(raw);
  if (/^\/quotes\/[a-f0-9-]{36}\/review$/.test(path)) return C.quoteReviewSchema.parse(raw);
  if (path === "/quotes/select") return C.quoteSelectionInputSchema.parse(raw);
  if (path === "/responsibilities") return C.responsibilityProposeSchema.parse(raw);
  if (/^\/responsibilities\/[a-f0-9-]{36}\/state$/.test(path)) return C.responsibilityActionSchema.parse(raw);
  if (path === "/transitions/commit") return C.procurementTransitionCommitSchema.parse(raw);
  if (path === "/progress") return C.procurementProgressInputSchema.parse(raw);
  if (path === "/exceptions") return C.procurementExceptionInputSchema.parse(raw);
  if (/^\/exceptions\/[a-f0-9-]{36}\/resolve$/.test(path)) return C.procurementExceptionResolveSchema.parse(raw);
  if (path === "/expenses") return C.procurementExpenseLinkInputSchema.parse(raw);
  throw new Error("This path is not a retained procurement command.");
}
export function saveProcurementPending(storage: ProcurementStorage, path: string, input: unknown, expiresAt: string, now = new Date().toISOString()): ProcurementPending {
  const parsed = procurementCommandInput(path, input), value = pendingSchema.parse({ version: 1, path, scope: parsed.expectedScope, intentId: parsed.intentId, expiresAt, savedAt: now, outcome: "pending", input: parsed });
  // Storage must succeed before dispatch, or there is no safe lost-response
  // identity. Never overwrite an unresolved command from another profile.
  if (storage.getItem(PROCUREMENT_PENDING_KEY) !== null) throw new Error("A previous tab request needs its original result or an explicit local discard first.");
  storage.setItem(PROCUREMENT_PENDING_KEY, JSON.stringify(value)); return value;
}
export function readProcurementPending(storage: ProcurementStorage, currentScope: string, now = Date.now()): { state: "empty" | "invalid" | "other_profile" | "expired"; pending: null } | { state: "pending" | "rejected"; pending: ProcurementPending } {
  const raw = storage.getItem(PROCUREMENT_PENDING_KEY); if (raw === null) return { state: "empty", pending: null };
  try { const saved = pendingSchema.parse(JSON.parse(raw)), input = procurementCommandInput(saved.path, saved.input); if (saved.scope !== input.expectedScope || saved.intentId !== input.intentId) throw new Error("mismatch"); if (saved.scope !== currentScope) return { state: "other_profile", pending: null }; if (Date.parse(saved.expiresAt) <= now) return { state: "expired", pending: null }; return { state: saved.outcome, pending: { ...saved, input } }; } catch { return { state: "invalid", pending: null }; }
}
export function markProcurementPendingRejected(storage: ProcurementStorage, expected: ProcurementPending) { const saved = pendingSchema.parse(JSON.parse(storage.getItem(PROCUREMENT_PENDING_KEY) ?? "null")); if (saved.intentId !== expected.intentId || saved.scope !== expected.scope) throw new Error("The retained command changed."); storage.setItem(PROCUREMENT_PENDING_KEY, JSON.stringify({ ...saved, outcome: "rejected" })); }
export function clearProcurementPending(storage: ProcurementStorage, expected?: Pick<ProcurementPending, "intentId" | "scope">) { if (expected) { try { const value = pendingSchema.safeParse(JSON.parse(storage.getItem(PROCUREMENT_PENDING_KEY) ?? "null")); if (!value.success || value.data.scope !== expected.scope || value.data.intentId !== expected.intentId) return; } catch { return; } } storage.removeItem(PROCUREMENT_PENDING_KEY); }
