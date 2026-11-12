"use client";

import { z } from "zod";
import { ORG_CHANGE_CHANNEL, ORG_IDENTITY_CHANGED_CODES, ORG_PROJECT_CHANGED_CODES, ORG_PROJECT_SCOPE_HEADER, ORG_SCOPE_HEADER } from "./contracts";
import type { OrgPortfolioView } from "./contracts";

export class OrgRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); this.name = "OrgRequestError"; }
}
export type OrgFetchOptions = {
  scope?: string; projectScope?: string; signal?: AbortSignal; accept?: "application/json" | "text/csv";
  fetcher?: typeof fetch;
};
/** Capabilities belong in POST bodies, never paths, queries or referrers. */
export function orgApiPath(path: string): string {
  if (path.startsWith("/") || path.includes("\\") || path.includes("#") || path.includes(":")) throw new TypeError("Use a relative organization API path without a fragment.");
  const url = new URL(`/api/organizations${path ? `/${path}` : ""}`, "https://organization.invalid");
  if (url.pathname !== "/api/organizations" && !url.pathname.startsWith("/api/organizations/")) throw new TypeError("The request must stay in the organization API.");
  for (const key of url.searchParams.keys()) {
    if (!["before", "version"].includes(key) || url.searchParams.getAll(key).length !== 1) throw new TypeError("Only one bounded history or version parameter may be used.");
  }
  return `${url.pathname}${url.search}`;
}
/** Deliberately does not use workspaceFetch. Org-only reads are independent of
 * the project cookie; dual/project operations opt into their exact own scope. */
export function orgFetch(path: string, body?: unknown, options: OrgFetchOptions = {}): Promise<Response> {
  const headers = new Headers({ Accept: options.accept ?? "application/json" });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (options.scope) headers.set(ORG_SCOPE_HEADER, options.scope);
  if (options.projectScope) headers.set(ORG_PROJECT_SCOPE_HEADER, options.projectScope);
  return (options.fetcher ?? fetch)(orgApiPath(path), {
    method: body === undefined ? "GET" : "POST", headers,
    credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
export async function orgRequest<T>(path: string, schema: z.ZodType<T>, body?: unknown, options: OrgFetchOptions = {}): Promise<T> {
  let response: Response;
  try { response = await orgFetch(path, body, options); }
  catch (error) {
    if (options.signal?.aborted || error instanceof TypeError && /organization API|relative organization|bounded history/.test(error.message)) throw error;
    throw new OrgRequestError("The response was interrupted. Keep this exact request and check it again before starting a new decision.", "REQUEST_UNAVAILABLE", 0);
  }
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new OrgRequestError("The response could not be read. Check the same saved request before starting another one.", "REQUEST_UNAVAILABLE", response.status); }
  if (!response.ok) {
    const problem = z.object({ error: z.string().max(1400), code: z.string().max(100) }).safeParse(value);
    throw new OrgRequestError(problem.success ? problem.data.error : "This step could not finish. Check its saved status before trying again.", problem.success ? problem.data.code : "REQUEST_UNAVAILABLE", response.status);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new OrgRequestError("This response does not match the current organization contract. Check the same saved request before starting another decision.", "REQUEST_UNAVAILABLE", 502);
  return parsed.data;
}
export function orgRecoveryForError(error: unknown): "identity" | "project" | "review" | "same_attempt" | "stopped" {
  if (!(error instanceof OrgRequestError)) return "stopped";
  if (ORG_IDENTITY_CHANGED_CODES.some(code => code === error.code)) return "identity";
  if (ORG_PROJECT_CHANGED_CODES.some(code => code === error.code)) return "project";
  if (["REQUEST_UNAVAILABLE", "ORG_COMMAND_BUSY"].includes(error.code)) return "same_attempt";
  if (["ORG_VERSION_CHANGED", "ORG_POLICY_VERSION_CHANGED", "ORG_ADOPTION_CHANGED", "ORG_POLICY_REVIEW_REQUIRED", "ORG_PACKAGE_REVISION_REQUIRED", "ORG_PLAN_REVIEW_REQUIRED", "ORG_REPORT_CHANGED"].includes(error.code)) return "review";
  return "stopped";
}

export type OrgRequestDomain = "organization" | "project" | "dual" | "entry";
export type OrgRequestTicket = { signal: AbortSignal; current: () => boolean; finish: () => void };
/** A stale response must never repopulate a newly selected identity or a new
 * review. No epoch or scope is an authorization credential. */
export function createOrgBoundary() {
  let organization = 0, project = 0, entry = 0, disposed = false;
  const pending = new Map<AbortController, OrgRequestDomain>();
  function invalidate(domain: OrgRequestDomain | "all") {
    if (domain === "all" || domain === "organization" || domain === "dual") organization++;
    if (domain === "all" || domain === "project" || domain === "dual") project++;
    if (domain === "all" || domain === "entry" || domain === "organization" || domain === "dual") entry++;
    for (const [controller, requestDomain] of pending) {
      const matches = domain === "all" || domain === requestDomain ||
        domain === "organization" && ["dual", "entry"].includes(requestDomain) ||
        domain === "project" && requestDomain === "dual" ||
        domain === "dual" && ["organization", "project", "entry"].includes(requestDomain);
      if (matches) { controller.abort(); pending.delete(controller); }
    }
  }
  return {
    invalidate,
    start(domain: OrgRequestDomain = "organization"): OrgRequestTicket {
      if (disposed) throw new Error("The organization view has closed.");
      const controller = new AbortController(), observed = { organization, project, entry };
      pending.set(controller, domain);
      return {
        signal: controller.signal,
        current: () => !disposed && !controller.signal.aborted &&
          (domain === "project" || observed.organization === organization) &&
          (!["project", "dual"].includes(domain) || observed.project === project) &&
          (domain !== "entry" || observed.entry === entry),
        finish: () => { pending.delete(controller); },
      };
    },
    dispose() { disposed = true; invalidate("all"); },
  };
}
export type OrgBoundary = ReturnType<typeof createOrgBoundary>;

type ChangeMessage = { origin: string };
export type OrgChannel = {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(value: ChangeMessage): void;
  close(): void;
};
type ChannelFactory = (name: string) => OrgChannel;
let tabId: string | undefined;
export function organizationTabIdentity(): string { return tabId ??= crypto.randomUUID(); }
const nativeChannel: ChannelFactory = name => new BroadcastChannel(name);
export function announceOrganizationChange(channelFactory: ChannelFactory = nativeChannel) {
  const channel = channelFactory(ORG_CHANGE_CHANNEL);
  channel.postMessage({ origin: organizationTabIdentity() });
  channel.close();
}
export function listenForOrganizationChanges(boundary: OrgBoundary, callbacks: {
  organizationChanged: () => void; projectChanged: () => void;
}, channelFactory: ChannelFactory = nativeChannel): () => void {
  const own = organizationTabIdentity(), organization = channelFactory(ORG_CHANGE_CHANNEL), project = channelFactory("fieldproof-workspace-changed");
  let active = true;
  organization.onmessage = event => {
    if (!active || typeof event.data === "object" && event.data !== null && "origin" in event.data && event.data.origin === own) return;
    boundary.invalidate("organization"); callbacks.organizationChanged();
  };
  project.onmessage = () => { if (active) { boundary.invalidate("project"); callbacks.projectChanged(); } };
  return () => { active = false; organization.onmessage = null; project.onmessage = null; organization.close(); project.close(); };
}

/** This is the real readiness controller used by the portfolio. No caller may
 * mark a prepared preview before fonts and the final current-access read. */
export async function prepareOrganizationPortfolio(options: {
  id: string; contentHash: string; current: () => boolean;
  check: () => Promise<OrgPortfolioView | null>; fontsReady: () => Promise<void>;
  observed: (view: OrgPortfolioView) => void;
}): Promise<OrgPortfolioView | null> {
  function inspect(view: OrgPortfolioView | null) {
    if (!options.current() || !view) return null;
    if (view.summary.id !== options.id || view.summary.contentHash !== options.contentHash) throw new OrgRequestError("The checked edition does not match the selected immutable portfolio.", "ORG_REPORT_CHANGED", 409);
    options.observed(view);
    if (!view.report || view.status === "withdrawn" || !view.canPrint) throw new OrgRequestError("This edition no longer has current permission for printing. Its private content is withheld.", "ORG_REPORT_WITHDRAWN", 410);
    return view;
  }
  if (!options.current() || !inspect(await options.check())) return null;
  await options.fontsReady();
  if (!options.current()) return null;
  return inspect(await options.check());
}
