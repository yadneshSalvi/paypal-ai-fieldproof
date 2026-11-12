import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import React, { act, createElement, useState } from "react";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import * as C from "../lib/organizations/contracts";
import { ORG_ENTRY_STORAGE } from "../lib/organizations/entry-draft";
import { ORG_UI_AS_OF, ORG_UI_END, ORG_UI_HASH, ORG_UI_PROJECT_SCOPE, ORG_UI_SCOPE, orgUiBootstrap, orgUiDesk, orgUiId, orgUiParticipation, orgUiPortfolioDesk, orgUiProfile, orgUiView } from "./helpers/organization-ui";

/** Real product components and real React DOM state/focus handlers. jsdom has no
 * native modal, Tab engine or OS print sheet; only those platform primitives
 * and fetch are controlled. No browser, DB or provider is used by this file. */
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:4592/organizations", pretendToBeVisual: true }), descriptors = new Map<string, PropertyDescriptor | undefined>();
function expose(key: string, value: unknown) { if (!descriptors.has(key)) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLDialogElement", "HTMLInputElement", "HTMLSelectElement", "Node", "MutationObserver", "sessionStorage", "history"] as const) expose(key, key === "window" ? dom.window : key === "document" ? dom.window.document : dom.window[key]);
expose("self", dom.window); expose("React", React); expose("IS_REACT_ACT_ENVIRONMENT", true); expose("requestAnimationFrame", dom.window.requestAnimationFrame.bind(dom.window)); expose("cancelAnimationFrame", dom.window.cancelAnimationFrame.bind(dom.window));
class Channel {
  static all = new Set<Channel>(); onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly name: string) { Channel.all.add(this); }
  close() { Channel.all.delete(this); }
  postMessage(data: unknown) { for (const channel of Channel.all) if (channel !== this && channel.name === this.name) channel.onmessage?.(new MessageEvent("message", { data })); }
  static send(name: string) { for (const channel of Channel.all) if (channel.name === name) channel.onmessage?.(new MessageEvent("message", { data: { origin: "another-synthetic-tab" } })); }
}
expose("BroadcastChannel", Channel);
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
const { createRoot } = await import("react-dom/client");
const { OrgDialog, OrgRequestStatus, OrgPrivateLink, useOrganizationApi } = await import("../components/organizations/shared");
const { OrganizationRecipient } = await import("../components/organizations/entry");
const { OrganizationMembers } = await import("../components/organizations/members");
const { OrganizationProjects } = await import("../components/organizations/projects");
const { OrganizationPortfolio } = await import("../components/organizations/portfolio");
const { OrganizationWorkspace } = await import("../components/organizations/desk");
const { OrgAmountInput, OrgPolicyEditor, newOrgPolicy } = await import("../components/organizations/policy-editor");
type Call = { path: string; method: string; headers: Headers; body: Record<string, unknown> | null };
const roots = new Set<Root>(); let calls: Call[] = [], printCalls = 0;
let responseFor: (call: Call) => Promise<Response>;
function receipt(kind: C.OrgCommandReceipt["kind"], body: Record<string, unknown> | null, resourceId: string | null = null) { return { intentId: body?.intentId ?? orgUiId(99), kind, outcome: "committed", committedAt: ORG_UI_AS_OF, resourceId, resourceVersion: 1, message: "Synthetic original command confirmed." }; }
function readyEntry(kind: "invite" | "access" = "invite"): C.OrgEntryView { return C.orgEntryViewSchema.parse({ kind, state: "ready", scope: ORG_UI_SCOPE, organization: { name: "Synthetic civic group", identityProvenance: "self_declared" }, role: "auditor", expiresAt: ORG_UI_END, current: null, recipient: null, canLeave: false, canAccept: kind === "invite", canRestore: kind === "access", libraryScope: "d".repeat(64) }); }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function mount(element: React.ReactElement) { const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container); roots.add(root); await act(async () => root.render(element)); return { root, container }; }
async function until(condition: () => boolean, message: string) { const end = Date.now() + 1800; while (Date.now() < end) { if (condition()) return; await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); } assert.ok(condition(), message); }
function button(label: string, scope: ParentNode = document): HTMLButtonElement { const node = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent?.includes(label) || value.getAttribute("aria-label") === label); assert.ok(node, `Missing ordinary button: ${label}`); return node; }
async function click(node: HTMLElement) { await act(async () => { node.focus(); node.click(); }); }
async function fill(node: HTMLInputElement | HTMLTextAreaElement, value: string) { await act(async () => { const prototype = node instanceof dom.window.HTMLInputElement ? dom.window.HTMLInputElement.prototype : dom.window.HTMLTextAreaElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value); node.dispatchEvent(new dom.window.Event("input", { bubbles: true })); }); }
function tab(node: HTMLElement, shiftKey = false) { const event = new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }); node.dispatchEvent(event); return event; }
function isPrepared() { return document.querySelector(".og-paper")?.getAttribute("data-print-ready") === "true"; }
function PortfolioHarness() { const api = useOrganizationApi({ organizationChanged() {}, projectChanged() {}, committed() {} }); return createElement(OrganizationPortfolio, { desk: orgUiDesk(), api }); }
function MembersHarness() { const [link, setLink] = useState<string | null>(null), api = useOrganizationApi({ organizationChanged() {}, projectChanged() {}, committed(value) { const result = C.orgInviteResponseSchema.safeParse(value); if (result.success) setLink(result.data.invitation.path); } }); return createElement(React.Fragment, null, createElement(OrgRequestStatus, { api }), createElement(OrganizationMembers, { desk: orgUiDesk(), api }), link && createElement(OrgPrivateLink, { path: link, title: "Recovered original invitation" })); }
function ProjectHarness() { const api = useOrganizationApi({ organizationChanged() {}, projectChanged() {}, committed() {} }); return createElement(OrganizationProjects, { desk: null, participation: orgUiParticipation(), api }); }
beforeEach(() => {
  calls = []; printCalls = 0; sessionStorage.clear(); history.replaceState(null, "", "/organizations");
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } }); dom.window.print = () => { printCalls++; };
  responseFor = async call => {
    if (call.path === "/api/organizations/context") return Response.json(orgUiBootstrap());
    if (call.path === "/api/organizations") return Response.json({ desk: orgUiDesk() });
    if (call.path.startsWith("/api/organizations/project-context")) return Response.json({ participation: orgUiParticipation() });
    if (call.path.startsWith("/api/organizations/portfolio/reports/")) return Response.json({ view: orgUiView() });
    if (call.path === "/api/organizations/portfolio") return Response.json({ portfolio: orgUiPortfolioDesk() });
    if (call.path === "/api/organizations/entry/review") return Response.json({ entry: readyEntry(call.body?.kind as "invite" | "access") });
    throw new Error(`Unexpected synthetic request ${call.method} ${call.path}`);
  };
  expose("fetch", (async (input, init) => { const call = { path: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null }; calls.push(call); return responseFor(call); }) as typeof fetch);
});

describe("real organization recipient lifecycle DOM", () => {
  it("bootstraps a direct invitation before any review and retains the original per-tab intent after cookie isolation", async () => {
    const context = deferred<Response>(), token = "q".repeat(64), intentId = orgUiId(98);
    sessionStorage.setItem(ORG_ENTRY_STORAGE, JSON.stringify({ version: 1, kind: "invite", token, intentId }));
    history.replaceState(null, "", "/organizations/join");
    let browserReady = false; const original = responseFor;
    responseFor = async call => {
      if (call.path === "/api/organizations/context") return context.promise;
      if (call.path === "/api/organizations/entry/review" && !browserReady) return Response.json({ error: "Synthetic missing browser context", code: "ORG_RATE_LIMIT" }, { status: 429 });
      return original(call);
    };
    await mount(createElement(OrganizationRecipient));
    await until(() => calls.some(call => call.path === "/api/organizations/context"), "Direct entry must initialize its browser context.");
    assert.equal(calls.filter(call => call.path.endsWith("/entry/review")).length, 0, "A link review cannot race the context cookie response.");
    await act(async () => { browserReady = true; context.resolve(Response.json(orgUiBootstrap())); });
    await until(() => !!document.querySelector('form input:not([type])'), "The same retained invitation should become reviewable.");
    const review = calls.filter(call => call.path.endsWith("/entry/review"));
    assert.equal(review.length, 1); assert.deepEqual(review[0].body, { kind: "invite", token, intentId });
    assert.deepEqual(calls.map(call => [call.method, call.path]), [["GET", "/api/organizations/context"], ["POST", "/api/organizations/entry/review"]]);
    assert.equal(calls.some(call => call.path.endsWith("/entry/accept")), false);
  });
  it("stops an identity-error review at one request and requires an explicit same-link retry", async () => {
    history.replaceState(null, "", "/organizations/join#invite=" + "q".repeat(64));
    const original = responseFor; let reviews = 0;
    responseFor = async call => {
      if (call.path === "/api/organizations/entry/review") {
        reviews++;
        // Bound the negative control too: the former automatic retry loop must
        // fail the assertion without producing an unbounded synthetic run.
        return Response.json({ error: reviews <= 3 ? "Synthetic browser context changed; check this link again." : "Synthetic runaway review guard", code: reviews <= 3 ? "ORG_BROWSER_CONTEXT_CHANGED" : "ORG_RATE_LIMIT" }, { status: reviews <= 3 ? 409 : 429 });
      }
      return original(call);
    };
    await mount(createElement(OrganizationRecipient));
    await until(() => !!document.querySelector('[role="alert"]') && !document.querySelector('[aria-busy="true"]'), "Identity failure must settle into visible recovery.");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    assert.equal(reviews, 1, "One failed review must not automatically trigger another request.");
    assert.equal(calls.filter(call => call.path.endsWith("/context")).length, 1);
    assert.match(document.body.textContent ?? "", /Synthetic browser context changed/);
    const retained = sessionStorage.getItem(ORG_ENTRY_STORAGE);
    await click(button("Check link again"));
    await until(() => reviews === 2 && !document.querySelector('[aria-busy="true"]'), "Only an explicit retry may check the same link again.");
    assert.equal(calls.filter(call => call.path.endsWith("/context")).length, 2);
    assert.equal(sessionStorage.getItem(ORG_ENTRY_STORAGE), retained);
    const originalReview = { kind: "invite", token: "q".repeat(64), intentId: JSON.parse(retained!).intentId };
    assert.deepEqual(calls.filter(call => call.path.endsWith("/entry/review")).map(call => call.body), [originalReview, originalReview]);
    assert.equal(calls.some(call => call.path.endsWith("/entry/accept")), false);
  });
  it("does not dispatch a link review after a failed browser bootstrap or automatically retry it", async () => {
    history.replaceState(null, "", "/organizations/join#access=" + "r".repeat(64));
    let attempts = 0;
    responseFor = async call => {
      assert.equal(call.path, "/api/organizations/context", "A failed bootstrap must prevent every entry POST.");
      attempts++;
      return Response.json({ error: "Synthetic bootstrap unavailable", code: attempts <= 3 ? "ORG_BROWSER_CONTEXT_CHANGED" : "ORG_RATE_LIMIT" }, { status: 409 });
    };
    await mount(createElement(OrganizationRecipient));
    await until(() => !!document.querySelector('[role="alert"]') && !document.querySelector('[aria-busy="true"]'), "Bootstrap failure must become a bounded manual state.");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    assert.equal(attempts, 1); assert.match(document.body.textContent ?? "", /Synthetic bootstrap unavailable/);
    assert.equal(calls.every(call => call.method === "GET"), true); assert.equal(button("Check link again").disabled, false);
  });
  it("keeps an original saved acceptance and clears the view after its browser identity is rejected without rebinding or retrying", async () => {
    const token = "q".repeat(64), intentId = orgUiId(98), acceptance = C.orgEntryAcceptSchema.parse({ token, intentId, expectedScope: ORG_UI_SCOPE, displayName: "Synthetic original recipient", contractVersion: C.ORG_GOVERNANCE_VERSION, acknowledged: true });
    const saved = JSON.stringify({ version: 1, kind: "invite", token, intentId, acceptance }); sessionStorage.setItem(ORG_ENTRY_STORAGE, saved);
    history.replaceState(null, "", "/organizations/join");
    const original = responseFor;
    responseFor = async call => {
      if (call.path === "/api/organizations/entry/review") return Response.json({ entry: { ...readyEntry(), scope: "e".repeat(64) } });
      if (call.path === "/api/organizations/entry/accept") return Response.json({ error: "Synthetic original browser is required for this saved acceptance.", code: "ORG_BROWSER_CONTEXT_CHANGED" }, { status: 409 });
      return original(call);
    };
    await mount(createElement(OrganizationRecipient)); await until(() => !!document.querySelector('form input:not([type])'), "Saved acceptance should retain its original values.");
    assert.equal(document.querySelector<HTMLInputElement>('form input:not([type])')?.disabled, true);
    await click(button("Check the original request"));
    await until(() => !!document.querySelector('[role="alert"]') && !document.querySelector('[aria-busy="true"]'), "An identity rejection must stop and explain original-context recovery.");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    const accepted = calls.filter(call => call.path.endsWith("/entry/accept"));
    assert.equal(accepted.length, 1); assert.deepEqual(accepted[0].body, acceptance); assert.equal(accepted[0].headers.get(C.ORG_SCOPE_HEADER), ORG_UI_SCOPE);
    assert.equal(calls.filter(call => call.path.endsWith("/entry/review")).length, 1);
    assert.deepEqual(JSON.parse(sessionStorage.getItem(ORG_ENTRY_STORAGE)!), JSON.parse(saved)); assert.equal(document.querySelector("form"), null);
    assert.doesNotMatch(document.body.textContent ?? "", /Synthetic civic group|Your private return key/);
    assert.match(document.body.textContent ?? "", /original browser is required/);
  });
  it("recovers the original acceptance after a lost response wrote the cookie and the next review has a new scope", async () => {
    const token = "q".repeat(64); history.replaceState(null, "", `/organizations/join#invite=${token}`);
    let accepted = false, posts = 0; const original = responseFor;
    responseFor = async call => {
      if (call.path === "/api/organizations/entry/review") return Response.json({ entry: accepted ? { ...readyEntry(), scope: "e".repeat(64), state: "joined_here", canAccept: false, recipient: { displayName: "Synthetic original recipient", identityProvenance: "self_declared" } } : readyEntry() });
      if (call.path === "/api/organizations/entry/accept") { posts++; if (posts === 1) { accepted = true; throw new TypeError("Synthetic lost acceptance response after cookie write"); } return Response.json({ receipt: receipt("accept_invitation", call.body, orgUiId(4)), welcome: { profile: { ...orgUiProfile("auditor"), displayName: "Synthetic original recipient" }, identityProvenance: "self_declared" }, returnPath: "/organizations/join#access=" + "r".repeat(64) }); }
      return original(call);
    };
    const first = await mount(createElement(OrganizationRecipient)); await until(() => !!document.querySelector('form input:not([type])'), "Ready invitation form must load.");
    await fill(document.querySelector('form input:not([type])')!, "Synthetic original recipient"); await click(document.querySelector('form input[type="checkbox"]')!); await click(button("Join organization"));
    await until(() => !!sessionStorage.getItem(ORG_ENTRY_STORAGE)?.includes("acceptance"), "Original identity and intent must be persisted before network continuation.");
    await until(() => document.body.textContent?.includes("response was interrupted") ?? false, "Interrupted acceptance should have an honest unresolved state.");
    await act(async () => first.root.unmount()); roots.delete(first.root); first.container.remove();
    await mount(createElement(OrganizationRecipient)); await until(() => document.body.textContent?.includes("This original profile is already open") ?? false, "Recovery review should recognize the exact entered profile.");
    await click(button("Check the original saved request")); await until(() => document.body.textContent?.includes("Your private return key") ?? false, "Recover only the original accepted session and fixed deadline.");
    const acceptedCalls = calls.filter(call => call.path.endsWith("/entry/accept")); assert.equal(acceptedCalls.length, 2); assert.deepEqual(acceptedCalls[0].body, acceptedCalls[1].body); assert.equal(acceptedCalls[1].body?.expectedScope, ORG_UI_SCOPE); assert.equal(acceptedCalls[1].body?.displayName, "Synthetic original recipient"); assert.equal(acceptedCalls[1].headers.has("X-Fieldproof-Project"), false); assert.equal(acceptedCalls[1].headers.has(C.ORG_PROJECT_SCOPE_HEADER), false);
    assert.equal(document.querySelectorAll("select").length, 0); assert.match(document.body.textContent ?? "", /Fixed session deadline/); assert.equal(sessionStorage.getItem(ORG_ENTRY_STORAGE), null);
  });
  it("does not let an old hash review overwrite a different same-document invitation or preserve its name/acknowledgment", async () => {
    const old = deferred<Response>(), firstToken = "q".repeat(64), secondToken = "r".repeat(64); history.replaceState(null, "", `/organizations/join#invite=${firstToken}`);
    const original = responseFor;
    responseFor = async call => call.path === "/api/organizations/context" ? original(call) : call.body?.token === firstToken ? old.promise : Response.json({ entry: { ...readyEntry(), organization: { name: "Synthetic second organization", identityProvenance: "self_declared" } } });
    await mount(createElement(OrganizationRecipient)); await until(() => calls.some(call => call.body?.token === firstToken), "First review should be pending.");
    await act(async () => { history.replaceState(null, "", `/organizations/join#invite=${secondToken}`); window.dispatchEvent(new dom.window.HashChangeEvent("hashchange")); });
    await until(() => document.body.textContent?.includes("Synthetic second organization") ?? false, "New link should own the visible entry view.");
    await act(async () => old.resolve(Response.json({ entry: { ...readyEntry(), organization: { name: "PRIVATE_OLD_ORGANIZATION_CANARY", identityProvenance: "self_declared" } } })));
    assert.doesNotMatch(document.body.textContent ?? "", /PRIVATE_OLD_ORGANIZATION_CANARY/); assert.equal(document.querySelector<HTMLInputElement>('form input:not([type])')?.value, ""); assert.equal(document.querySelector<HTMLInputElement>('form input[type="checkbox"]')?.checked, false);
    assert.equal(window.location.hash, "");
  });
});

describe("real same-edition portfolio prepared-print DOM", () => {
  async function openOriginal() { await mount(createElement(PortfolioHarness)); await until(() => !!document.querySelector(".og-paper"), "Live aggregate paper should load."); await click(button("Open same edition")); await until(() => !![...document.querySelectorAll("button")].find(node => node.textContent?.includes("Prepare print preview")), "Original saved edition must load through its ordinary history action."); }
  it("keeps readiness false through fonts and final current-access response, then prepares the same edition without invoking OS print or capture", async () => {
    const fonts = deferred<void>(), final = deferred<Response>(), original = responseFor; let reportReads = 0;
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: fonts.promise } });
    responseFor = async call => { if (call.path.includes("/portfolio/reports/")) { reportReads++; return reportReads === 3 ? final.promise : Response.json({ view: orgUiView() }); } return original(call); };
    await openOriginal(); await click(button("Prepare print preview")); assert.equal(isPrepared(), false); assert.equal(reportReads, 2);
    await act(async () => fonts.resolve()); await until(() => reportReads === 3, "Fonts must finish before the final authority read."); assert.equal(isPrepared(), false);
    await act(async () => final.resolve(Response.json({ view: orgUiView() }))); await until(isPrepared, "Readiness should become true only after final authority.");
    assert.equal(printCalls, 0); assert.equal(calls.some(call => call.path.endsWith("/capture")), false); assert.equal(document.querySelector(".og-paper")?.textContent?.includes(ORG_UI_HASH), true);
    await act(async () => { const select = document.querySelector<HTMLSelectElement>('.og-print-controls select')!; select.value = "letter"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.equal(isPrepared(), false); assert.match(document.querySelector(".og-print-status")?.textContent ?? "", /fresh current-access check/);
    await click(button("Prepare print preview")); await until(isPrepared, "Letter preview needs its own completed revalidation."); assert.ok(document.querySelector(".og-paper-letter")); assert.equal(printCalls, 0);
  });
  it("withholds the report and never marks readiness if permission is withdrawn during font preparation", async () => {
    const fonts = deferred<void>(), original = responseFor; let reportReads = 0;
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: fonts.promise } });
    responseFor = async call => { if (call.path.includes("/portfolio/reports/")) { reportReads++; const view = orgUiView(); return Response.json({ view: reportReads >= 3 ? { ...view, status: "withdrawn", report: null, canPrint: false, canExport: false, reasons: ["Synthetic disclosure withdrawal during preparation"] } : view }); } return original(call); };
    await openOriginal(); await click(button("Prepare print preview")); assert.equal(isPrepared(), false); await act(async () => fonts.resolve());
    await until(() => document.body.textContent?.includes("Edition content withheld") ?? false, "Final current permission must withhold private aggregate body."); assert.equal(isPrepared(), false); assert.equal(document.querySelector(".og-paper"), null); assert.equal(printCalls, 0); assert.equal(calls.some(call => call.path.endsWith("/capture")), false);
  });
  it("does not call final authority or print after a failed font readiness step", async () => {
    const fonts = deferred<void>(), original = responseFor; let reportReads = 0;
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: fonts.promise } }); responseFor = async call => { if (call.path.includes("/portfolio/reports/")) { reportReads++; return Response.json({ view: orgUiView() }); } return original(call); };
    await openOriginal(); await click(button("Prepare print preview")); await act(async () => fonts.reject(new Error("Synthetic font readiness failure")));
    await until(() => document.body.textContent?.includes("Synthetic font readiness failure") ?? false, "Font failure must remain an unready user-visible state."); assert.equal(reportReads, 2); assert.equal(isPrepared(), false); assert.equal(printCalls, 0);
  });
  it("clears a prepared flag and accurate ready text on the next quiet access check", async () => {
    await openOriginal(); await click(button("Prepare print preview")); await until(isPrepared, "Initial preview should prepare.");
    await act(async () => window.dispatchEvent(new dom.window.Event("focus"))); await until(() => !isPrepared(), "Quiet current-access checks must invalidate readiness.");
    assert.match(document.querySelector(".og-print-status")?.textContent ?? "", /fresh current-access check/); assert.equal(printCalls, 0);
  });
  it("retains the ordinary actual-print action and clears readiness after the print lifecycle", async () => {
    await openOriginal(); await click(button("Print / save PDF")); await until(() => printCalls === 1, "The real print action should invoke its checked edition exactly once.");
    assert.equal(isPrepared(), true); await act(async () => window.dispatchEvent(new dom.window.Event("afterprint"))); assert.equal(isPrepared(), false); assert.match(document.querySelector(".og-print-status")?.textContent ?? "", /fresh current-access check/);
  });
  it("does not download CSV when disclosure ends after bytes arrive but before final current authorization", async () => {
    const original = responseFor, priorClick = dom.window.HTMLAnchorElement.prototype.click; let reports = 0, downloads = 0;
    dom.window.HTMLAnchorElement.prototype.click = function () { downloads++; };
    responseFor = async call => {
      if (call.path.endsWith("/export")) return new Response("metric,amount\ncurrentCollectedMinor,300\n", { headers: { "Content-Type": "text/csv;charset=utf-8" } });
      if (call.path.includes("/portfolio/reports/")) { reports++; const view = orgUiView(); return Response.json({ view: reports >= 3 ? { ...view, status: "withdrawn", report: null, canPrint: false, canExport: false, reasons: ["Synthetic withdrawal after CSV serialization"] } : view }); }
      return original(call);
    };
    try { await openOriginal(); await click(button("Export exact-edition CSV")); await until(() => document.body.textContent?.includes("Edition content withheld") ?? false, "CSV disclosure must be checked after bytes finish."); assert.equal(downloads, 0); assert.equal(document.querySelector(".og-paper"), null); }
    finally { dom.window.HTMLAnchorElement.prototype.click = priorClick; }
  });
  it("downloads only the selected original edition after both current checks and never captures a replacement", async () => {
    const original = responseFor, priorClick = dom.window.HTMLAnchorElement.prototype.click, downloads: { name: string; href: string }[] = [];
    dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push({ name: this.download, href: this.href }); };
    responseFor = async call => call.path.endsWith("/export") ? new Response("metric,amount\ncurrentCollectedMinor,300\n", { headers: { "Content-Type": "text/csv;charset=utf-8" } }) : original(call);
    try { await openOriginal(); await click(button("Export exact-edition CSV")); await until(() => downloads.length === 1, "A checked original CSV should be offered for download."); assert.match(downloads[0].name, /fieldproof-portfolio-/); assert.match(downloads[0].href, /^blob:/); const request = calls.find(call => call.path.endsWith("/export"))!; assert.equal(request.headers.get(C.ORG_SCOPE_HEADER), ORG_UI_SCOPE); assert.equal(request.headers.has(C.ORG_PROJECT_SCOPE_HEADER), false); assert.equal(calls.some(call => call.path.endsWith("/capture")), false); }
    finally { dom.window.HTMLAnchorElement.prototype.click = priorClick; }
  });
});

describe("real organization desk identity changes", () => {
  it("allows a delayed org-only read to complete across an unrelated project switch", async () => {
    const delayed = deferred<Response>(), original = responseFor; let switched = false;
    responseFor = async call => {
      if (call.path === "/api/organizations") return delayed.promise;
      if (call.path.startsWith("/api/organizations/project-context") && switched) { const participation = orgUiParticipation(); return Response.json({ participation: { projectContext: { ...participation.projectContext, state: "none", project: null, role: null, profileLabel: null, expiresAt: null, basis: null, maxLinkExpiresAt: null, packages: [], sources: [], currentPlan: null, canLink: false, canAdopt: false, canMaterialize: false, canReviseEmptyPackages: false }, links: [], adoptions: [], nextAdoptionCursor: null } }); }
      return original(call);
    };
    await mount(createElement(OrganizationWorkspace)); await until(() => calls.some(call => call.path === "/api/organizations"), "Organization read should be waiting.");
    await act(async () => { switched = true; Channel.send("fieldproof-workspace-changed"); });
    await act(async () => delayed.resolve(Response.json({ desk: orgUiDesk() }))); await until(() => !!document.querySelector('[role="tablist"]'), "The independent organization desk should still open.");
    const request = calls.find(call => call.path === "/api/organizations")!; assert.equal(request.headers.has(C.ORG_PROJECT_SCOPE_HEADER), false); assert.equal(request.headers.has("X-Fieldproof-Project"), false); assert.match(document.body.textContent ?? "", /Synthetic civic group/);
  });
  it("never lets an old organization response repopulate a new organization identity", async () => {
    const old = deferred<Response>(), original = responseFor; let switched = false;
    const nextDesk = orgUiDesk("auditor"); nextDesk.scope = "e".repeat(64); nextDesk.organization.id = orgUiId(101); nextDesk.organization.name = "Synthetic second organization"; nextDesk.profile.organizationId = nextDesk.organization.id; nextDesk.profile.organizationName = nextDesk.organization.name;
    const nextBootstrap = orgUiBootstrap("auditor"); nextBootstrap.context.scope = nextDesk.scope; nextBootstrap.context.profile = nextDesk.profile;
    responseFor = async call => { if (call.path === "/api/organizations/context" && switched) return Response.json(nextBootstrap); if (call.path === "/api/organizations") return switched ? Response.json({ desk: nextDesk }) : old.promise; return original(call); };
    await mount(createElement(OrganizationWorkspace)); await until(() => calls.some(call => call.path === "/api/organizations"), "Old private organization read should start.");
    await act(async () => { switched = true; Channel.send(C.ORG_CHANGE_CHANNEL); }); await until(() => document.body.textContent?.includes("Synthetic second organization") ?? false, "New organization should own the current desk.");
    const oldDesk = orgUiDesk(); oldDesk.organization.name = "PRIVATE_OLD_ORGANIZATION_CANARY";
    await act(async () => old.resolve(Response.json({ desk: oldDesk })));
    assert.doesNotMatch(document.body.textContent ?? "", /PRIVATE_OLD_ORGANIZATION_CANARY|Edit organization details/); assert.match(document.body.textContent ?? "", /My membership/);
  });
  it("keeps the creation return key through the first newly written organization scope without renewing its deadline", async () => {
    const original = responseFor; let created = false;
    responseFor = async call => {
      if (call.path === "/api/organizations/context") return Response.json(created ? { ...orgUiBootstrap(), context: { ...orgUiBootstrap().context, scope: "e".repeat(64) } } : { context: { scope: ORG_UI_SCOPE, state: "none", profile: null, canCreate: true, canLeave: false, canClearEnded: false }, library: { scope: "d".repeat(64), ready: false, expiresAt: null, entries: [] } });
      if (call.path === "/api/organizations/create") { created = true; return Response.json({ receipt: receipt("create", call.body, orgUiId(1)), welcome: { profile: orgUiProfile(), identityProvenance: "self_declared" }, returnPath: "/organizations/join#access=" + "k".repeat(64) }); }
      if (call.path === "/api/organizations" && created) return Response.json({ desk: { ...orgUiDesk(), scope: "e".repeat(64) } });
      return original(call);
    };
    await mount(createElement(OrganizationWorkspace)); await until(() => document.body.textContent?.includes("A place for shared oversight") ?? false, "Ordinary creation form should open only in an empty org context.");
    const form = [...document.querySelectorAll("form")].find(node => node.textContent?.includes("A place for shared oversight"))!, inputs = [...form.querySelectorAll<HTMLInputElement>("input:not([type])")];
    await fill(inputs[0], "Synthetic civic group"); await fill(inputs[1], "Synthetic owner"); await click(form.querySelector('input[type="checkbox"]')!); await click(button("Create organization space", form));
    await until(() => !!document.querySelector('[role="tablist"]') && (document.body.textContent?.includes("Your private organization return key") ?? false), "Original creation return capability must remain reviewable after its scope changes.");
    assert.match(document.body.textContent ?? "", /Creation capability/); const request = calls.find(call => call.path.endsWith("/create"))!; assert.equal(request.body?.expiresHours, 168); assert.equal(request.headers.has(C.ORG_PROJECT_SCOPE_HEADER), false); assert.equal(request.body?.expectedScope, ORG_UI_SCOPE);
  });
  it("removes old owner controls immediately after a successful self-role change while the fresh context is still waiting", async () => {
    const original = responseFor, refreshed = deferred<Response>(), owner = orgUiDesk(), auditor = orgUiDesk("auditor"); let changed = false;
    owner.roster!.members.push({ ...owner.ownMembership, id: orgUiId(109), isOwn: false, displayName: "Synthetic second current owner", canEnd: true });
    auditor.scope = "e".repeat(64); auditor.profile = { ...owner.profile, role: "auditor", membershipVersion: 3 }; auditor.ownMembership = { ...owner.ownMembership, role: "auditor", version: 3, canEnd: false, canChangeRole: false };
    responseFor = async call => { if (call.path === "/api/organizations/context" && changed) return refreshed.promise; if (call.path === "/api/organizations") return Response.json({ desk: changed ? auditor : owner }); if (call.path.endsWith(`/members/${owner.profile.membershipId}/role`)) { changed = true; return Response.json({ receipt: receipt("change_member_role", call.body, owner.profile.membershipId) }); } return original(call); };
    await mount(createElement(OrganizationWorkspace)); await until(() => !!document.querySelector('[role="tablist"]'), "Initial owner desk should load."); await click(button("Members")); await click(button("Review role change"));
    const dialog = document.querySelector("dialog")!, select = dialog.querySelector<HTMLSelectElement>("select")!; await act(async () => { select.value = "auditor"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); }); await fill(dialog.querySelector("textarea")!, "Synthetic self-role reduction with another owner"); await click(dialog.querySelector('input[type="checkbox"]')!); await click(button("Confirm role change", dialog));
    await until(() => changed && !document.querySelector('[role="tablist"]'), "Committed role reduction must immediately clear old privileged controls."); assert.doesNotMatch(document.body.textContent ?? "", /Create one-use invitation|Edit organization details/);
    await act(async () => refreshed.resolve(Response.json({ ...orgUiBootstrap(), context: { ...orgUiBootstrap().context, scope: auditor.scope, profile: auditor.profile } })));
    await until(() => document.body.textContent?.includes("My membership") ?? false, "The current membership role should return with only its own controls."); assert.doesNotMatch(document.body.textContent ?? "", /Create one-use invitation|Review role change/); assert.equal(auditor.profile.sessionExpiresAt, owner.profile.sessionExpiresAt);
  });
  it("does not turn malformed or unsafe money input into an unlimited prospective cap", async () => {
    let saves = 0, amount: number | null = 3050;
    function MoneyHarness() { const [value, setValue] = useState<number | null>(3050); return createElement("form", { onSubmit(event) { event.preventDefault(); amount = value; saves++; } }, createElement(OrgAmountInput, { value, change: setValue, label: "Synthetic prospective expense cap" }), createElement("button", { type: "submit" }, "Review cap")); }
    await mount(createElement(MoneyHarness)); const input = document.querySelector<HTMLInputElement>("input")!;
    for (const invalid of ["12.999", "900719925474099.91", "-1"]) { await fill(input, invalid); assert.equal(input.validity.customError, true); await click(button("Review cap")); assert.equal(saves, 0); }
    await fill(input, "12.34"); await click(button("Review cap")); assert.equal(saves, 1); assert.equal(amount, 1234);
  });
  it("edits a real evidence requirement with its exact competence scope and does not copy a physical signoff", async () => {
    let saved: C.OrgPolicyDefinition | null = null;
    function EditorHarness() { const [value, setValue] = useState<C.OrgPolicyDefinition>({ ...newOrgPolicy("evidence_policy", "community-garden"), title: "Synthetic garden evidence policy" }); return createElement("form", { onSubmit(event) { event.preventDefault(); saved = C.orgPolicyDefinitionSchema.parse(value); } }, createElement(OrgPolicyEditor, { value, change: setValue }), createElement("button", { type: "submit" }, "Review synthetic definition")); }
    await mount(createElement(EditorHarness)); const select = [...document.querySelectorAll<HTMLSelectElement>("select")].find(node => [...node.options].some(option => option.value === "site_review"))!;
    await act(async () => { select.value = "site_review"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); }); await click(button("Add evidence requirement")); await click(button("Review synthetic definition"));
    assert.ok(saved); const definition = saved as C.OrgPolicyDefinition; assert.equal(definition.kind, "evidence_policy"); if (definition.kind !== "evidence_policy") assert.fail("Exact evidence-policy family expected.");
    assert.equal(definition.packages[0].requirements[0].scope, "soil_suitability"); assert.equal(definition.packages[0].requirements.length, 2); assert.notEqual(definition.packages[0].requirements[0].id, definition.packages[0].requirements[1].id); assert.deepEqual(definition.templateIds, ["community-garden"]);
    assert.doesNotMatch(document.body.textContent ?? "", /physical work accepted|Verified person/);
  });
});
afterEach(async () => { for (const root of roots) await act(async () => root.unmount()); roots.clear(); document.body.replaceChildren(); for (const channel of Channel.all) channel.close(); });
after(() => { dom.window.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

describe("real organization dialog and role command DOM", () => {
  it("focuses the real dialog heading, contains Tab/Shift+Tab and programmatic focus, then returns to its connected opener", async () => {
    function Harness() { const [open, setOpen] = useState(false); return createElement(React.Fragment, null, createElement("button", { id: "opener", onClick: () => setOpen(true) }, "Open review"), createElement("button", { id: "outside" }, "Outside"), open && createElement(OrgDialog, { title: "Synthetic exact review", close: () => setOpen(false), children: createElement(React.Fragment, null, createElement("button", { hidden: true }, "Hidden"), createElement("button", { disabled: true }, "Disabled"), createElement("button", { id: "last" }, "Last action")) })); }
    await mount(createElement(Harness)); await click(button("Open review")); const dialog = document.querySelector<HTMLDialogElement>("dialog")!;
    assert.equal(dialog.open, true); assert.equal(document.activeElement?.tagName, "H2");
    const first = button("Close dialog", dialog), last = button("Last action", dialog);
    await act(async () => { last.focus(); assert.equal(tab(last).defaultPrevented, true); }); assert.equal(document.activeElement === first, true);
    await act(async () => { first.focus(); assert.equal(tab(first, true).defaultPrevented, true); }); assert.equal(document.activeElement === last, true);
    await act(async () => document.getElementById("outside")!.focus()); assert.equal(document.activeElement === last, true);
    await act(async () => dialog.dispatchEvent(new dom.window.Event("cancel", { cancelable: true }))); assert.equal(document.querySelector("dialog"), null); assert.equal(document.activeElement?.id, "opener");
  });
  it("does not mutate on a role selector change and shows a rejected role decision inside the real review dialog", async () => {
    const original = responseFor; responseFor = async call => call.path.includes("/members/") ? Response.json({ error: "Synthetic current version changed", code: "ORG_VERSION_CHANGED" }, { status: 409 }) : original(call);
    await mount(createElement(MembersHarness)); await click([...document.querySelectorAll<HTMLButtonElement>("button")].filter(value => value.textContent === "Review role change")[1]);
    const dialog = document.querySelector<HTMLDialogElement>("dialog")!, select = dialog.querySelector<HTMLSelectElement>("select")!;
    await act(async () => { select.value = "auditor"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.equal(calls.filter(call => call.path.includes("/members/")).length, 0);
    await fill(dialog.querySelector("textarea")!, "Synthetic role review reason"); await click(dialog.querySelector('input[type="checkbox"]')!); await click(button("Confirm role change", dialog));
    await until(() => !!dialog.querySelector('[role="alert"]'), "Rejection must remain in the review dialog.");
    assert.match(dialog.textContent ?? "", /Synthetic current version changed/); const request = calls.find(call => call.path.includes("/members/"))!;
    assert.equal(request.body?.role, "auditor"); assert.equal(request.body?.expectedScope, ORG_UI_SCOPE); assert.equal(request.headers.get(C.ORG_SCOPE_HEADER), ORG_UI_SCOPE); assert.equal(request.headers.has(C.ORG_PROJECT_SCOPE_HEADER), false);
    const recovery = button("Check the same request", dialog); assert.equal(recovery.disabled, false); assert.equal(recovery.closest("fieldset[disabled]"), null);
  });
  it("keeps an interrupted invitation request and retries the exact original intent/body after reload", async () => {
    let attempts = 0; const original = responseFor; responseFor = async call => { if (call.path !== "/api/organizations/invitations") return original(call); attempts++; if (attempts === 1) throw new TypeError("Synthetic lost response"); return Response.json({ receipt: receipt("invite", call.body, orgUiId(6)), invitation: { id: orgUiId(6), path: "/organizations/join#invite=" + "i".repeat(64), expiresAt: ORG_UI_END } }); };
    const first = await mount(createElement(MembersHarness)); const form = [...document.querySelectorAll("form")].find(value => value.textContent?.includes("Invite an organization member"))!;
    await fill(form.querySelector('input[type="text"],input:not([type])')!, "Synthetic original auditor invite"); await click(form.querySelector('input[type="checkbox"]')!); await click(button("Create one-use invitation", form));
    await until(() => document.body.textContent?.includes("A member invitation is saved") ?? false, "Original command must remain retained after a lost response.");
    await act(async () => first.root.unmount()); roots.delete(first.root); first.container.remove(); await mount(createElement(MembersHarness));
    await click(button("Check the same request")); await until(() => document.body.textContent?.includes("Recovered original invitation") ?? false, "Exact recovery should surface only the original successful invitation.");
    const posts = calls.filter(call => call.path === "/api/organizations/invitations"); assert.equal(posts.length, 2); assert.deepEqual(posts[0].body, posts[1].body); assert.equal(posts[0].body?.label, "Synthetic original auditor invite"); assert.equal(posts[1].body?.expiresHours, 24);
  });
  it("sends a project-only unilateral withdrawal without any org scope or project role chooser", async () => {
    const original = responseFor; responseFor = async call => call.path.endsWith("/withdraw") ? Response.json({ receipt: receipt("withdraw_project", call.body, orgUiId(10)) }) : original(call);
    await mount(createElement(ProjectHarness)); await click(button("Withdraw as project organizer")); const dialog = document.querySelector("dialog")!;
    await fill(dialog.querySelector("textarea")!, "Synthetic project-only withdrawal"); await click(dialog.querySelector('input[type="checkbox"]')!); await click(button("Withdraw this disclosure", dialog));
    await until(() => calls.some(call => call.path.endsWith("/withdraw")), "Project authority should issue its own withdrawal branch.");
    const request = calls.find(call => call.path.endsWith("/withdraw"))!; assert.equal(request.body?.authority, "project"); assert.equal(request.body?.expectedProjectScope, ORG_UI_PROJECT_SCOPE); assert.equal("expectedScope" in request.body!, false); assert.equal(request.headers.has(C.ORG_SCOPE_HEADER), false); assert.equal(request.headers.get(C.ORG_PROJECT_SCOPE_HEADER), ORG_UI_PROJECT_SCOPE); assert.equal(document.querySelectorAll("select").length, 0);
  });
});
