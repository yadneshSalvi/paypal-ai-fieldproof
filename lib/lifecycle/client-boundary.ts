"use client";

import { z } from "zod";
import { createOrgBoundary, listenForOrganizationChanges, organizationTabIdentity } from "../organizations/client-boundary";
import { ORG_PROJECT_SCOPE_HEADER, ORG_SCOPE_HEADER, orgPortfolioFilterSchema } from "../organizations/contracts";
import * as C from "./contracts";

export class LifecycleRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); this.name = "LifecycleRequestError"; }
}
export type LifecycleDomain = "project" | "organization" | "dual" | "context";
export interface LifecycleRequestOptions { domain: LifecycleDomain; projectScope?: string; organizationScope?: string; signal?: AbortSignal; fetcher?: typeof fetch; }
const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", source = "[a-zA-Z0-9:_%-]{1,540}";
const paths = new RegExp(`^(?:context|preferences|targets|program/(?:enable|disable)|inbox(?:/${uuid}(?:/state|/sources/${source})?)?|schedules(?:/prepare|/${uuid}(?:/state)?)?|occurrences(?:/${uuid}(?:/retry|/review|/state|/attempts|/sources/${source})?)?)$`);
export function lifecycleApiPath(path: string): string {
  const route = path.split("?")[0];
  if (path.startsWith("/") || path.includes("#") || /\\|(?:^|\/)\.{1,2}(?:\/|$)|%2e|%2f|%5c/i.test(route)) throw new TypeError("Use an exact relative lifecycle path without a capability or redirect.");
  const value = new URL(`/api/lifecycle/${path}`, "https://lifecycle.invalid");
  if (!paths.test(value.pathname.slice("/api/lifecycle/".length))) throw new TypeError("This route is outside the reviewed lifecycle API.");
  if (value.pathname.includes("/sources/")) { const encoded = value.pathname.split("/sources/")[1]; let decoded: string; try { decoded = decodeURIComponent(encoded); } catch { throw new TypeError("Use the original captured scalar source identity."); } if (!/^[a-zA-Z0-9:_-]{1,180}$/.test(decoded)) throw new TypeError("Use the original captured scalar source identity."); }
  for (const name of value.searchParams.keys()) {
    if (!["before", "state", "audience", "filters"].includes(name) || value.searchParams.getAll(name).length !== 1 || value.searchParams.get(name)!.length > (name === "filters" ? 12000 : 500)) throw new TypeError("Use only one bounded reviewed lifecycle query parameter.");
  }
  if (value.searchParams.has("state")) C.lifecycleReadStateSchema.parse(value.searchParams.get("state"));
  if (value.searchParams.has("audience")) C.lifecycleAudienceSchema.parse(value.searchParams.get("audience"));
  if (value.searchParams.has("filters")) { let filters: unknown; try { filters = JSON.parse(value.searchParams.get("filters")!); } catch { throw new TypeError("Use the exact reviewed aggregate filter."); } if (!orgPortfolioFilterSchema.safeParse(filters).success) throw new TypeError("Use the exact reviewed aggregate filter."); }
  return `${value.pathname}${value.search}`;
}
export async function lifecycleRequest<T>(path: string, schema: z.ZodType<T>, body: unknown | undefined, options: LifecycleRequestOptions): Promise<T> {
  const target = lifecycleApiPath(path), headers = new Headers({ Accept: "application/json" });
  if (options.domain === "context" && (path !== "context" || body !== undefined)) throw new TypeError("Only the current lifecycle context may use an unscoped bootstrap request.");
  if (options.domain === "project" && !options.projectScope || ["organization", "dual"].includes(options.domain) && !options.organizationScope || options.domain === "dual" && !options.projectScope) throw new LifecycleRequestError("Review the exact current profile before this private request.", "LIFECYCLE_AUTH_REQUIRED", 403);
  if (options.domain === "project") headers.set(C.LIFECYCLE_PROJECT_SCOPE_HEADER, options.projectScope!);
  if (["organization", "dual"].includes(options.domain)) headers.set(ORG_SCOPE_HEADER, options.organizationScope!);
  if (options.domain === "dual") headers.set(ORG_PROJECT_SCOPE_HEADER, options.projectScope!);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  let response: Response;
  try { response = await (options.fetcher ?? fetch)(target, { method: body === undefined ? "GET" : "POST", headers, credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch (error) { if (options.signal?.aborted) throw error; throw new LifecycleRequestError("The response was interrupted. Check the same saved request before starting a new decision.", "REQUEST_UNAVAILABLE", 0); }
  let value: unknown;
  try { const text = await response.text(); if (text.length > 2_000_000) throw new Error("oversized"); value = JSON.parse(text); }
  catch { throw new LifecycleRequestError("The response could not be read. Keep the original request and check it again.", "REQUEST_UNAVAILABLE", response.status); }
  if (!response.ok) { const problem = C.lifecycleProblemSchema.safeParse(value); throw new LifecycleRequestError(problem.success ? problem.data.error : "This step did not finish. Check its exact saved request.", problem.success ? problem.data.code : "REQUEST_UNAVAILABLE", response.status); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new LifecycleRequestError("The response does not match this private lifecycle contract. Check the original request.", "REQUEST_UNAVAILABLE", 502);
  return parsed.data;
}
export function createLifecycleBoundary() {
  const core = createOrgBoundary();
  return { core, start: (domain: LifecycleDomain) => core.start(domain === "context" ? "dual" : domain), invalidate: (domain: LifecycleDomain | "all") => core.invalidate(domain === "context" ? "all" : domain), dispose: () => core.dispose() };
}
export type LifecycleBoundary = ReturnType<typeof createLifecycleBoundary>;
export function lifecycleErrorRecovery(error: unknown): "project" | "organization" | "source" | "review" | "same_request" | "stopped" {
  if (!(error instanceof LifecycleRequestError)) return "stopped";
  if (["LIFECYCLE_PROJECT_CHANGED", "ORG_PROJECT_CONTEXT_CHANGED", "ORG_PROJECT_AUTHORITY_REQUIRED", "WORKSPACE_CONTEXT_CHANGED"].includes(error.code)) return "project";
  if (["LIFECYCLE_ORGANIZATION_CHANGED", "ORG_AUTH_REQUIRED", "ORG_CONTEXT_CHANGED", "ORG_SESSION_EXPIRED", "ORG_AUTHORITY_ENDED"].includes(error.code)) return "organization";
  if (["LIFECYCLE_SOURCE_WITHDRAWN", "LIFECYCLE_SOURCE_CHANGED", "ORG_LINK_EXPIRED", "ORG_LINK_WITHDRAWN", "ORG_LINK_SUSPENDED"].includes(error.code)) return "source";
  if (["LIFECYCLE_VERSION_CHANGED", "LIFECYCLE_REVIEW_REQUIRED", "LIFECYCLE_OCCURRENCE_CHANGED"].includes(error.code)) return "review";
  if (["REQUEST_UNAVAILABLE", "LIFECYCLE_BUSY", "WORKSPACE_MAINTENANCE", "LIFECYCLE_STORAGE_UNAVAILABLE"].includes(error.code)) return "same_request";
  return "stopped";
}
export function lifecycleCommandPath(command: C.LifecycleCommand): string {
  if (command.kind === "preferences") return "preferences";
  if (command.kind === "inbox_state") return `inbox/${command.resourceId}/state`;
  if (command.kind === "program_enable") return "program/enable";
  if (command.kind === "program_disable") return "program/disable";
  if (command.kind === "schedule_enable") return "schedules";
  if (command.kind === "schedule_action") return `schedules/${command.resourceId}/state`;
  return `occurrences/${command.resourceId}/${command.kind === "occurrence_retry" ? "retry" : command.kind === "occurrence_review" ? "review" : "state"}`;
}
function commandScopes(command: C.LifecycleCommand) {
  if (["preferences", "inbox_state"].includes(command.kind)) return { domain: "project" as const, projectScope: command.input.expectedScope, organizationScope: null };
  const projectScope = command.kind === "schedule_enable" ? command.input.review.proposal.target.expectedProjectScope : "expectedProjectScope" in command.input ? command.input.expectedProjectScope : null;
  return { domain: projectScope ? "dual" as const : "organization" as const, projectScope, organizationScope: command.input.expectedScope };
}
const pendingSchema = z.object({ contractVersion: z.literal(C.LIFECYCLE_VERSION), domain: z.enum(["project", "organization", "dual"]), projectScope: z.string().regex(/^[a-f0-9]{64}$/).nullable(), organizationScope: z.string().regex(/^[a-f0-9]{64}$/).nullable(), expiresAt: z.iso.datetime(), command: C.lifecycleCommandSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type LifecyclePending = z.infer<typeof pendingSchema>;
export const LIFECYCLE_PENDING_STORAGE = "fieldproof:lifecycle:pending:v1";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  const result = JSON.stringify(value); if (result === undefined) throw new TypeError("A pending request must be exact JSON data."); return result;
}
async function fingerprint(value: unknown): Promise<string> { const bytes = new TextEncoder().encode(canonical(value)), digest = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
function scopeMatches(pending: Omit<LifecyclePending, "fingerprint">, context: C.LifecycleContext, now: string): boolean {
  const wanted = commandScopes(pending.command);
  if (!Number.isFinite(Date.parse(now)) || canonical(wanted) !== canonical({ domain: pending.domain, projectScope: pending.projectScope, organizationScope: pending.organizationScope }) || Date.parse(now) >= Date.parse(pending.expiresAt)) return false;
  let deadline = Infinity;
  if (pending.domain !== "project") { const profile = context.organization.profile; if (context.organization.state !== "active" || !profile || pending.organizationScope !== context.organization.scope) return false; deadline = Math.min(Date.parse(profile.membershipExpiresAt), Date.parse(profile.sessionExpiresAt)); }
  if (pending.domain !== "organization") { const profile = context.project.profile; if (context.project.state !== "active" || !profile || pending.projectScope !== context.project.scope || pending.domain === "dual" && profile.role !== "organizer") return false; deadline = Math.min(deadline, Date.parse(profile.expiresAt)); }
  return Date.parse(pending.expiresAt) <= deadline;
}
/** A fingerprint detects corrupted/mismatched per-tab recovery data. It is not
 * authority: the server independently checks HttpOnly credentials and scopes. */
export async function createLifecyclePending(raw: C.LifecycleCommand, context: C.LifecycleContext, expiresAt: string, now: string): Promise<LifecyclePending> {
  const command = C.lifecycleCommandSchema.parse(raw), body = { contractVersion: C.LIFECYCLE_VERSION, ...commandScopes(command), expiresAt, command };
  if (!scopeMatches(body, context, now)) throw new LifecycleRequestError("The reviewed original profile or deadline changed. Refresh before making this decision.", body.domain === "project" ? "LIFECYCLE_PROJECT_CHANGED" : "LIFECYCLE_AUTHORITY_ENDED", 409);
  return pendingSchema.parse({ ...body, fingerprint: await fingerprint(body) });
}
export async function readLifecyclePending(raw: string | null, context: C.LifecycleContext, now: string): Promise<LifecyclePending | null> {
  if (!raw) return null;
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { return null; }
  const result = pendingSchema.safeParse(parsed); if (!result.success) return null;
  const { fingerprint: recorded, ...body } = result.data;
  return scopeMatches(body, context, now) && recorded === await fingerprint(body) ? result.data : null;
}
export interface LifecycleStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void; }
export function lifecyclePendingStorageKey(value: Pick<LifecyclePending, "domain" | "organizationScope" | "projectScope">): string { return `${LIFECYCLE_PENDING_STORAGE}:${value.domain}:${value.organizationScope ?? "none"}:${value.projectScope ?? "none"}`; }
export function lifecycleCurrentStorageKeys(context: C.LifecycleContext): string[] {
  const keys: string[] = [], organization = context.organization.state === "active", project = context.project.state === "active";
  if (project) keys.push(lifecyclePendingStorageKey({ domain: "project", projectScope: context.project.scope, organizationScope: null }));
  if (organization) keys.push(lifecyclePendingStorageKey({ domain: "organization", organizationScope: context.organization.scope, projectScope: null }));
  if (organization && project) keys.push(lifecyclePendingStorageKey({ domain: "dual", organizationScope: context.organization.scope, projectScope: context.project.scope }));
  return keys;
}
/** Save before dispatch. If this tab cannot durably retain the exact request,
 * no mutation is sent; the same in-memory intent can retry saving later. */
export function saveLifecyclePending(storage: LifecycleStorage, pending: LifecyclePending): void {
  try { const key = lifecyclePendingStorageKey(pending), value = JSON.stringify(pending), existing = storage.getItem(key); if (existing && existing !== value) throw new Error("Another original request is pending"); storage.setItem(key, value); if (storage.getItem(key) !== value) throw new Error("Recovery write unavailable"); }
  catch { throw new LifecycleRequestError("This tab could not retain the pending request. Keep this original decision and retry when temporary browser storage is available.", "LIFECYCLE_STORAGE_UNAVAILABLE", 0); }
}
export function announceLifecycleChange(domain: "project" | "organization") {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(C.LIFECYCLE_CHANGE_CHANNEL); channel.postMessage({ origin: organizationTabIdentity(), domain }); channel.close();
}
export function listenForLifecycleChanges(boundary: LifecycleBoundary, callbacks: { projectChanged: () => void; organizationChanged: () => void }): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const close = listenForOrganizationChanges(boundary.core, callbacks), own = organizationTabIdentity(), channel = new BroadcastChannel(C.LIFECYCLE_CHANGE_CHANNEL);
  channel.onmessage = event => {
    const value = z.object({ origin: z.string(), domain: z.enum(["project", "organization"]) }).strict().safeParse(event.data);
    if (!value.success || value.data.origin === own) return;
    boundary.invalidate(value.data.domain); if (value.data.domain === "project") callbacks.projectChanged(); else callbacks.organizationChanged();
  };
  return () => { close(); channel.onmessage = null; channel.close(); };
}
