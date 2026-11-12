import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import React, { act, createElement as h, StrictMode, useState } from "react";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import * as C from "../lib/procurement/contracts";
import * as A from "../lib/procurement/access-contracts";
import { PROCUREMENT_PENDING_KEY, createProcurementBoundary } from "../lib/procurement/client-boundary";
import { VOLUNTEER_ENTRY_DRAFT_KEY } from "../lib/procurement/entry-draft";
import { procurementContext, procurementDesk, procurementDetail, procurementEntry, procurementQuote, PR_HASH, PR_SCOPE, PR_TIME, prId } from "./helpers/procurement";
import { communityTemplate, TEMPLATE_IDS } from "../lib/community/templates";

/** The real components and request controllers run unchanged. jsdom has no
 * native modal/Tab driver: only those platform primitives are supplied. All
 * responses are explicitly synthetic; no browser, DB or external call occurs. */
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:4611/procurement", pretendToBeVisual: true }), globals = new Map<string, PropertyDescriptor | undefined>();
function expose(name: string, value: unknown) { if (!globals.has(name)) globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); }
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLDialogElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Node", "MutationObserver"] as const) expose(key, key === "window" ? dom.window : key === "document" ? dom.window.document : dom.window[key]);
expose("self", dom.window); expose("getComputedStyle", dom.window.getComputedStyle.bind(dom.window)); expose("requestAnimationFrame", dom.window.requestAnimationFrame.bind(dom.window)); expose("cancelAnimationFrame", dom.window.cancelAnimationFrame.bind(dom.window)); expose("sessionStorage", dom.window.sessionStorage); expose("IS_REACT_ACT_ENVIRONMENT", true); expose("React", React);
class TestChannel { static all = new Set<TestChannel>(); onmessage: ((event: { data: unknown }) => void) | null = null; constructor(readonly name: string) { TestChannel.all.add(this); } close() { TestChannel.all.delete(this); } postMessage(data: unknown) { for (const channel of TestChannel.all) if (channel !== this && channel.name === this.name) channel.onmessage?.({ data }); } }
expose("BroadcastChannel", TestChannel); dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
const { createRoot } = await import("react-dom/client");
const { ProcurementDialog } = await import("../components/procurement/shared");
const { ProcurementWorkspace } = await import("../components/procurement/workspace");
const { ProcurementRecipient } = await import("../components/procurement/recipient");
const { ProcurementRevisionPanel } = await import("../components/procurement/revisions");
const { ProcurementQuoteForm, utcInput, utcValue } = await import("../components/procurement/forms");
const { adoptWorkspaceContext } = await import("../lib/community/workspace-fetch");
const roots = new Set<Root>(), nowEnd = () => new Date(Date.now() + 60_000).toISOString(), noop = () => {};
type RequestCall = { path: string; method: string; headers: Headers; body: unknown };
let calls: RequestCall[] = [], respond: (call: RequestCall) => Promise<Response>;
function context(role: C.ProcurementRole = "organizer") { const value = procurementContext(role); value.profile!.expiresAt = nowEnd(); return value; }
async function mount(element: React.ReactElement) { const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container); roots.add(root); await act(async () => root.render(element)); return { root, container }; }
async function click(node: HTMLElement) { await act(async () => { node.focus(); node.click(); }); }
function button(text: string, parent: ParentNode = document) { const node = [...parent.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent?.includes(text) || value.getAttribute("aria-label") === text); assert.ok(node, `Missing ordinary action: ${text}`); return node; }
function input(label: string, parent: ParentNode = document) { const node = [...parent.querySelectorAll<HTMLLabelElement>("label")].find(value => value.textContent?.startsWith(label))?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select"); assert.ok(node, `Missing labeled field: ${label}`); return node; }
async function change(node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) { const prototype = node instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : node instanceof dom.window.HTMLSelectElement ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value); node.dispatchEvent(new dom.window.Event(node instanceof dom.window.HTMLSelectElement ? "change" : "input", { bubbles: true })); }); }
async function until(check: () => boolean, message: string) { const deadline = Date.now() + 2000; while (Date.now() < deadline && !check()) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); assert.ok(check(), message); }
function tab(node: HTMLElement, shiftKey = false) { const event = new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }); node.dispatchEvent(event); return event; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

beforeEach(() => { document.body.innerHTML = ""; sessionStorage.clear(); calls = []; dom.window.history.replaceState(null, "", "/procurement"); adoptWorkspaceContext(null); respond = async call => { if (call.path === "/api/procurement") return Response.json({ desk: procurementDesk() }); throw new Error(`Unexpected controlled request: ${call.path}`); }; expose("fetch", async (value: RequestInfo | URL, init?: RequestInit) => { const url = new URL(value instanceof Request ? value.url : String(value), window.location.origin), call = { path: url.pathname + url.search, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) as unknown : null }; calls.push(call); return respond(call); }); });
afterEach(async () => { await act(async () => { for (const root of roots) root.unmount(); }); roots.clear(); assert.equal(TestChannel.all.size, 0); });
after(() => { dom.window.close(); for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

function DialogHarness() { const [open, setOpen] = useState(false), [error, setError] = useState<string | null>(null); return h(React.Fragment, null, h("button", { id: "opener", onClick: () => setOpen(true) }, "Open controlled dialog"), h("button", { id: "outside" }, "Outside action"), open && h(ProcurementDialog, { title: "Controlled original source", close: () => setOpen(false), error, children: h(React.Fragment, null, h("input", { hidden: true }), h("button", { disabled: true }, "Disabled action"), h("button", { id: "first", onClick: () => setError("A retained source changed; keep the original request.") }, "Show current error"), h("button", { id: "last" }, "Last visible button"), h("details", null, h("summary", { id: "summary" }, "Closed provenance details"), h("button", { id: "closed-child" }, "Hidden inside closed details"))) })); }

describe("actual procurement dialog focus lifecycle", () => {
  it("enters the heading, contains both keyboard edges and excludes closed-details controls", async () => {
    await mount(h(DialogHarness)); await click(button("Open controlled dialog")); const dialog = document.querySelector<HTMLDialogElement>("dialog")!, heading = dialog.querySelector("h2")!, close = button("Close dialog", dialog), summary = document.getElementById("summary")!;
    assert.equal(document.activeElement?.id, heading.id); close.focus(); assert.equal(tab(close, true).defaultPrevented, true); assert.equal(document.activeElement?.id, summary.id);
    summary.focus(); assert.equal(tab(summary).defaultPrevented, true); assert.equal(document.activeElement?.getAttribute("aria-label"), "Close dialog");
    document.getElementById("outside")!.focus(); assert.equal(dialog.contains(document.activeElement), true);
    await act(async () => { dialog.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); }); assert.equal(document.querySelector("dialog"), null); assert.equal(document.activeElement?.id, "opener");
  });
  it("focuses an in-dialog error and returns the exact opener when the modal closes", async () => {
    await mount(h(DialogHarness)); await click(button("Open controlled dialog")); await click(button("Show current error")); assert.equal(document.activeElement?.getAttribute("role"), "alert"); assert.equal(document.activeElement?.closest("dialog")?.open, true); await click(button("Close dialog")); assert.equal(document.activeElement?.id, "opener");
  });
  it("keeps revision/source navigation in the same modal and focuses each new view", async () => {
    const quote = procurementQuote(); respond = async call => call.path.endsWith("/versions") ? Response.json({ page: { scope: PR_SCOPE, quoteId: quote.id, items: [{ current: false, quote }], nextCursor: null } }) : Response.json({ detail: { scope: PR_SCOPE, quoteId: quote.id, quoteVersion: quote.version, contentHash: quote.contentHash, status: "historical", provenance: "sample", excerpt: "Exact controlled source wording", observedAt: PR_TIME, originalDocumentAccess: false, preview: null, notices: [] } });
    const boundary = createProcurementBoundary(); await mount(h(ProcurementDialog, { title: "Quote revisions", close: noop, children: h(ProcurementRevisionPanel, { resourceKind: "quote", id: quote.id, scope: PR_SCOPE, request: boundary.request, fail: message => assert.fail(message) }) }));
    await until(() => !!document.querySelector(".pr-revision-list"), "The actual revision request should render."); await click(button("Inspect this exact original source")); assert.match(document.activeElement?.textContent ?? "", /Exact original source/); await until(() => document.body.textContent!.includes("Exact controlled source wording"), "The original source should be fetched under its exact version."); assert.equal(document.querySelectorAll("dialog").length, 1); await click(button("Back to original revisions")); assert.equal(document.activeElement?.textContent, "Retained original revisions");
  });
});

describe("actual current-role desk and unchanged-request recovery", () => {
  for (const templateId of TEMPLATE_IDS) it(`renders the real ${templateId} package titles, entry and revision navigation`, async () => {
    const desk = procurementDesk("organizer", templateId), ctx = procurementContext("organizer", templateId); ctx.profile!.expiresAt = nowEnd(); await mount(h(StrictMode, null, h(ProcurementWorkspace, { initialContext: ctx, initialDesk: desk })));
    assert.ok(document.querySelector(`.pr-template-${templateId}`)); for (const pkg of communityTemplate(templateId).packages) assert.ok(document.body.textContent?.includes(pkg.title)); assert.ok(button("Volunteer entry"));
    await click(button("Declared suppliers")); assert.ok(button("Declaration history")); await click(button("Quote proposals")); if (templateId === "makerspace") assert.ok(button("Quote revision history")); assert.equal(document.querySelector("select[aria-label*=role]"), null);
  });
  it("withholds catalog/member actions for the auditor and the entire private desk for a donor", async () => {
    const auditor = await mount(h(ProcurementWorkspace, { initialContext: context("auditor"), initialDesk: procurementDesk("auditor") })); assert.equal(document.querySelector(".pr-tabs")?.textContent, "Package operations"); assert.equal(document.querySelector("button[aria-label*=role]"), null); assert.ok(!document.body.textContent?.includes("Sample Workshop Supply")); await act(async () => auditor.root.unmount()); roots.delete(auditor.root);
    await mount(h(ProcurementWorkspace, { initialContext: context("donor"), initialDesk: null })); assert.equal(document.querySelector(".pr-tabs"), null); assert.ok(document.body.textContent?.includes("donor profile has no private procurement")); assert.equal(calls.length, 0);
  });
  it("recovers an initial transient desk error through the same current scope without creating a replacement project", async () => {
    await mount(h(ProcurementWorkspace, { initialContext: context(), initialDesk: null, initialError: "Controlled source read paused." })); await click(button("Retry current desk")); await until(() => !!document.querySelector(".pr-package-grid"), "An authorized initial error needs ordinary same-profile recovery."); assert.equal(calls.length, 1); assert.equal(calls[0].method, "GET"); assert.equal(calls[0].headers.get(C.PROCUREMENT_SCOPE_HEADER), PR_SCOPE); assert.ok(!document.body.textContent?.includes("Controlled source read paused."));
  });
  it("stores the actual form request before dispatch and retries its original body after a lost response", async () => {
    let writes = 0; const sent: unknown[] = [];
    respond = async call => { if (call.method === "GET") return Response.json({ desk: procurementDesk() }); const pending = JSON.parse(sessionStorage.getItem(PROCUREMENT_PENDING_KEY)!); assert.deepEqual(pending.input, call.body); sent.push(call.body); if (++writes === 1) throw new TypeError("Controlled response lost after unknown server outcome."); return Response.json({ receipt: { intentId: pending.intentId, kind: "supplier_save", resourceId: prId(1), resourceVersion: 2, recordedAt: PR_TIME, message: "The same original supplier revision is confirmed." } }); };
    await mount(h(ProcurementWorkspace, { initialContext: context(), initialDesk: procurementDesk() })); await click(button("Declared suppliers")); await click(button("Edit a new revision")); await click(input("I understand these are declared")); await click(button("Save a new supplier revision"));
    await until(() => writes === 1 && !!document.querySelector("dialog [role=alert]"), "The ambiguous result remains inside the original dialog."); const original = sessionStorage.getItem(PROCUREMENT_PENDING_KEY); assert.ok(original); await click(button("Close dialog")); await click(button("Check same original request")); await until(() => writes === 2 && sessionStorage.getItem(PROCUREMENT_PENDING_KEY) === null, "The original result should clear only after matching confirmation."); assert.deepEqual(sent[0], sent[1]); assert.ok(document.body.textContent?.includes("same original supplier revision is confirmed"));
  });
  it("removes the full private desk at the original deadline and does not renew it on reload", async () => {
    const ctx = context(); ctx.profile!.expiresAt = new Date(Date.now() + 80).toISOString(); await mount(h(ProcurementWorkspace, { initialContext: ctx, initialDesk: procurementDesk() })); await until(() => !document.querySelector(".pr-package-grid"), "Original expiry must remove current private controls."); assert.equal(document.querySelector(".pr-tabs"), null); assert.ok(document.body.textContent?.includes("original fixed project session deadline ended")); assert.equal(calls.length, 0);
  });
  it("preserves unknown line amounts when the actual quote editor saves a proposal", async () => {
    const quote = procurementQuote(); quote.draft!.lines[0].quantity = null; quote.draft!.lines[0].unitMinor = null; quote.draft!.lines[0].lineMinor = null; let saved: Record<string, unknown> | null = null; const failures: string[] = [];
    await mount(h(ProcurementQuoteForm, { existing: quote, desk: procurementDesk(), selectedPackage: "electronics", capabilities: procurementDetail().capabilities, busy: false, run: async (_path, body) => { saved = body; }, close: noop, fail: message => failures.push(message), moreSources: noop, moreSuppliers: noop }));
    await change(input("Reason for this new source revision"), "Preserve original unknown components; no complete price inferred."); await click(input("I reviewed the current supplier declaration")); await click(button("Save quote proposal for review")); assert.deepEqual(failures, []); assert.ok(saved); const draft = C.quoteDraftSchema.parse((saved as Record<string, unknown>).draft); assert.equal(draft.lines[0].quantity, null); assert.equal(draft.lines[0].unitMinor, null); assert.equal(draft.lines[0].lineMinor, null); assert.ok(document.body.textContent?.includes("Complete cost unknown"));
  });
});

describe("actual fragment entry and same-cookie restore retry", () => {
  const token = "a".repeat(64), next = "b".repeat(64);
  it("does not send an old page project header during bootstrap and refuses late responses after a fragment changes", async () => {
    adoptWorkspaceContext("unrelated-stale-page-project"); dom.window.history.replaceState(null, "", `/procurement/join#invite=${token}`); const first = deferred<Response>(); respond = async call => (call.body as { token: string }).token === token ? first.promise : Response.json({ entry: { ...procurementEntry(), scope: "b".repeat(64), project: { ...procurementDesk().project, title: "Fresh second invitation project" }, expiresAt: nowEnd() } });
    await mount(h(ProcurementRecipient)); await until(() => calls.length === 1, "The first link should be reviewed."); await act(async () => { dom.window.history.replaceState(null, "", `/procurement/join#invite=${next}`); dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange")); }); await until(() => document.body.textContent!.includes("Fresh second invitation project"), "The new link should reset and load."); await act(async () => first.resolve(Response.json({ entry: { ...procurementEntry(), project: { ...procurementDesk().project, title: "STALE FIRST PRIVATE PROJECT CANARY" }, expiresAt: nowEnd() } }))); assert.ok(!document.body.textContent?.includes("STALE FIRST PRIVATE PROJECT CANARY")); assert.ok(calls.every(call => !call.headers.has("X-Fieldproof-Project"))); assert.equal((input("Your self-declared display name") as HTMLInputElement).value, "");
  });
  it("retains the original restore intent/scope when a lost response has already changed the cookie context", async () => {
    dom.window.history.replaceState(null, "", `/procurement/join#access=${token}`); let writes = 0; const requests: A.VolunteerAccept[] = [], expiresAt = nowEnd();
    respond = async call => { if (call.path.endsWith("/review")) return Response.json({ entry: { ...procurementEntry("access"), scope: writes ? "c".repeat(64) : PR_SCOPE, expiresAt } }); const raw = call.body as A.VolunteerAccept; requests.push(raw); if (++writes === 1) throw new TypeError("Controlled cookie written, response lost."); return Response.json({ receipt: { intentId: raw.intentId, kind: "restore", resourceId: prId(90), version: 2, recordedAt: PR_TIME, message: "The original profile was restored." }, welcome: { project: procurementDesk().project, displayName: "Controlled original recipient", role: "volunteer", expiresAt, identityProvenance: "self_declared", authentication: "invitation_possession", currentContract: C.PROCUREMENT_VERSION }, returnPath: `/procurement/join#access=${token}` }); };
    const view = await mount(h(ProcurementRecipient)); await until(() => !!document.querySelector("form"), "The original return link should be reviewed."); await click(input("I understand the exact volunteer role")); await click(button("Restore this exact original profile")); await until(() => writes === 1 && !!document.querySelector("[role=alert]"), "The lost response should retain its original attempt."); const stored = sessionStorage.getItem(VOLUNTEER_ENTRY_DRAFT_KEY); await act(async () => view.root.unmount()); roots.delete(view.root); await mount(h(ProcurementRecipient)); await until(() => document.body.textContent!.includes("Check this same original request"), "The original intent must remain available after remount/current cookie change."); assert.equal(sessionStorage.getItem(VOLUNTEER_ENTRY_DRAFT_KEY), stored); await click(button("Check this same original request")); await until(() => document.body.textContent!.includes("A clear role. Your original deadline."), "The exact original restore should recover."); assert.deepEqual(requests[0], requests[1]); assert.equal(requests[1].expectedScope, PR_SCOPE); assert.ok(calls.every(call => !call.headers.has("X-Fieldproof-Project"))); assert.ok(document.body.textContent?.includes("Return never creates another actor"));
  });
  it("never queries or renders recipient details for duplicate fragment credentials", async () => {
    dom.window.history.replaceState(null, "", `/procurement/join#invite=${token}&access=${next}`); await mount(h(ProcurementRecipient)); assert.ok(document.body.textContent?.includes("malformed or ambiguous")); assert.equal(calls.length, 0); assert.equal(document.querySelector("form"), null);
  });
});

describe("server/client date and all-template render stability", () => {
  it("renders the actual desk identically across server/client time zones with visible UTC labels", () => {
    const cwd = fileURLToPath(new URL("../", import.meta.url)), script = `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {ProcurementWorkspace} from './components/procurement/workspace.tsx'; import {procurementContext,procurementDesk} from './tests/helpers/procurement.ts'; globalThis.React=React; for(const template of ['makerspace','community-garden','mutual-aid']) process.stdout.write(renderToStaticMarkup(React.createElement(ProcurementWorkspace,{initialContext:procurementContext('organizer',template),initialDesk:procurementDesk('organizer',template)})));`;
    const render = (TZ: string) => { const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd, env: { ...process.env, TZ }, encoding: "utf8", timeout: 15_000 }); assert.equal(child.status, 0, child.stderr); return child.stdout; };
    const server = render("UTC"), client = render("Asia/Kolkata"); assert.equal(server, client); assert.ok(server.includes("UTC")); assert.ok(server.includes("pr-template-community-garden"));
    assert.equal(utcInput("2030-05-01T10:12:13.456Z"), "2030-05-01T10:12:13.456"); assert.equal(utcValue("2030-05-01T10:12:13.456"), "2030-05-01T10:12:13.456Z");
  });
});
