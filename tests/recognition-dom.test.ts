import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import { recognitionJournalKey, writeRecognitionJournal } from "../lib/recognition/client";
import { RECOGNITION_VERSION, type RecognitionCommand, type RecognitionDesk } from "../lib/recognition/contracts";
import { REC_UI_ACCESS, REC_UI_REVIEW, REC_UI_SLUG, recUiDesk, recUiPage, recUiReceipt, recUiReview, recUiTime } from "./helpers/recognition-ui";

/** Actual mounted React components. Only network responses and unsupported
 * jsdom modal platform primitives are controlled; no browser/DB/provider. */
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:4612/recognition", pretendToBeVisual: true });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
function expose(key: string, value: unknown) { if (!descriptors.has(key)) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); }
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLDialogElement", "HTMLInputElement", "HTMLSelectElement", "HTMLFormElement", "Node", "MutationObserver", "sessionStorage", "history", "FormData"] as const)
  expose(key, key === "window" ? dom.window : key === "document" ? dom.window.document : dom.window[key]);
expose("self", dom.window); expose("React", React); expose("IS_REACT_ACT_ENVIRONMENT", true);
expose("requestAnimationFrame", dom.window.requestAnimationFrame.bind(dom.window)); expose("cancelAnimationFrame", dom.window.cancelAnimationFrame.bind(dom.window));
class Channel {
  static all = new Set<Channel>(); onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly name: string) { Channel.all.add(this); } close() { Channel.all.delete(this); } postMessage() {}
  static changed() { for (const channel of Channel.all) channel.onmessage?.(new MessageEvent("message", { data: { origin: "controlled-foreign-tab" } })); }
}
expose("BroadcastChannel", Channel);
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
const { createRoot } = await import("react-dom/client");
const { RecognitionDesk: Desk } = await import("../components/recognition/recognition-desk");
const { PublicRecognitionWall } = await import("../components/recognition/public-wall");
type Call = { path: string; method: string; input: RecognitionCommand | null; options: RequestInit | undefined };
const roots = new Set<Root>(); let calls: Call[] = [], responseFor: (call: Call) => Promise<Response>, heldDesk: RecognitionDesk;
const ok = (data: unknown) => Response.json({ data });
const failure = (code: string, status: number) => Response.json({ error: { code, message: "Controlled current permission refusal", recoverable: [404, 409, 503].includes(status) } }, { status });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function mount(element: React.ReactElement) { const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container); roots.add(root); await act(async () => root.render(element)); return { root, container }; }
async function until(condition: () => boolean, message: string) { const end = Date.now() + 1_800; while (Date.now() < end) { if (condition()) return; await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); } assert.ok(condition(), message); }
function button(text: string, owner: ParentNode = document) { const result = [...owner.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.includes(text) || node.getAttribute("aria-label") === text); assert.ok(result, `Missing ordinary button ${text}`); return result; }
async function click(node: HTMLElement) { await act(async () => { node.focus(); node.click(); }); }
async function fill(value: string) { const input = document.querySelector<HTMLInputElement>("#recognition-label")!; await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); }); }
async function reviewName(value = "Explicit typed initials") { await until(() => !!document.querySelector("#recognition-label"), "ordinary blank form"); await fill(value); for (const node of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) if (!node.checked) await click(node); await click(button("Review my public label")); await until(() => !!document.querySelector("dialog[open]"), "exact current preview"); }
function originalInput(): Extract<RecognitionCommand, { action: "consent" }> { return { schema: RECOGNITION_VERSION, action: "consent", intentId: crypto.randomUUID(), accessId: heldDesk.access.accessId,
  sessionExpiresAt: heldDesk.access.sessionExpiresAt, expectedVersion: 0, slug: REC_UI_SLUG, reviewKey: REC_UI_REVIEW, label: "Original pending initials", publicVisibilityAcknowledged: true, selfDeclaredAcknowledged: true }; }
beforeEach(() => {
  calls = []; heldDesk = recUiDesk(); sessionStorage.clear(); history.replaceState(null, "", "/recognition");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  responseFor = async call => {
    if (call.path.startsWith("/api/recognition?") || call.path === "/api/recognition") return ok({ ...heldDesk, observedAt: recUiTime() });
    if (call.path === "/api/recognition/review") return ok(recUiReview(call.input!));
    if (call.path === "/api/recognition/commands") return ok(recUiReceipt(call.input!));
    if (call.path.startsWith("/api/public-recognition/")) return ok(recUiPage());
    throw Error("Unexpected controlled component request");
  };
  expose("fetch", (async (input, options) => { const call = { path: String(input), method: options?.method ?? "GET", input: options?.body ? JSON.parse(String(options.body)) as RecognitionCommand : null, options }; calls.push(call); return responseFor(call); }) as typeof fetch);
});
afterEach(async () => { await act(async () => { for (const root of roots) root.unmount(); }); roots.clear(); document.body.replaceChildren(); });
after(() => { dom.window.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

describe("recognition actual mounted privacy and recovery", () => {
  it("loads the ordinary private form empty with explicit unchecked acknowledgments", async () => {
    const wait = deferred<Response>(); responseFor = () => wait.promise;
    await mount(createElement(Desk)); assert(document.body.textContent?.includes("Checking your original project access"));
    assert.equal(document.querySelector("#recognition-label"), null);
    await act(async () => wait.resolve(ok(heldDesk))); await until(() => !!document.querySelector("#recognition-label"), "blank form arrived");
    assert.equal(document.querySelector<HTMLInputElement>("#recognition-label")!.value, "");
    for (const node of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) assert.equal(node.checked, false);
    assert.equal(calls.filter(call => call.method === "POST").length, 0);
  });
  it("exact preview is separate from dispatch and Escape restores the ordinary opener", async () => {
    await mount(createElement(Desk)); await reviewName();
    assert(document.querySelector("dialog")!.textContent?.includes("Explicit typed initials"));
    assert.equal(calls.filter(call => call.path === "/api/recognition/commands").length, 0);
    assert.equal(document.activeElement, document.querySelector("#recognition-dialog-title"));
    await act(async () => document.querySelector("dialog")!.dispatchEvent(new dom.window.Event("cancel", { cancelable: true })));
    assert.equal(document.querySelector("dialog[open]"), null); assert.equal(document.activeElement, button("Review my public label"));
  });
  it("persists original exact request before dispatch and recovers a lost accepted response with one GET", async () => {
    let accepted: RecognitionCommand | null = null;
    const base = responseFor; responseFor = async call => {
      if (call.path === "/api/recognition/commands") { assert.equal(JSON.parse(sessionStorage.getItem(recognitionJournalKey(REC_UI_ACCESS))!).input.intentId, call.input!.intentId);
        accepted = call.input; heldDesk = { ...heldDesk, own: { state: "listed", version: 1, label: "Explicit typed initials", expiresAt: heldDesk.access.validUntil } }; throw new TypeError("Controlled missing response"); }
      if (call.path.startsWith("/api/recognition/commands/")) return ok(recUiReceipt(accepted!));
      return base(call);
    };
    await mount(createElement(Desk)); await reviewName(); await click(button("Publish this exact name"));
    await until(() => document.body.textContent!.includes("original decision has a saved receipt"), "GET-first original recovery");
    assert.equal(calls.filter(call => call.path === "/api/recognition/commands").length, 1);
    assert.equal(calls.filter(call => call.path.startsWith("/api/recognition/commands/")).length, 1);
    assert.equal(sessionStorage.getItem(recognitionJournalKey(REC_UI_ACCESS)), null);
  });
  it("remount checks an unresolved request, never posts on 404, and requires exact review before retry", async () => {
    const input = originalInput(); writeRecognitionJournal(sessionStorage, { accessId: input.accessId, input, state: "unresolved" });
    const base = responseFor; responseFor = call => call.path.startsWith("/api/recognition/commands/") ? Promise.resolve(failure("RECOGNITION_COMMAND_NOT_FOUND", 404)) : base(call);
    await mount(createElement(Desk)); await until(() => !!document.body.textContent?.includes("no accepted receipt"), "404 belongs to original scope");
    assert.equal(calls.filter(call => call.method === "POST").length, 0);
    await until(() => !button("Review exact retry").disabled, "original read completed"); await click(button("Review exact retry")); await until(() => !!document.querySelector("dialog[open]"), "same exact pending preview");
    assert.equal(calls.find(call => call.path === "/api/recognition/review")!.input?.intentId, input.intentId);
    assert.equal(calls.filter(call => call.path === "/api/recognition/commands").length, 0);
    await click(button("Publish this exact name")); await until(() => sessionStorage.getItem(recognitionJournalKey(REC_UI_ACCESS)) === null, "explicit original retry was accepted");
    assert.deepEqual(calls.find(call => call.path === "/api/recognition/commands")!.input, input);
  });
  it("cross-tab profile change clears visible names, typed draft and review without reading the new scope automatically", async () => {
    heldDesk = { ...heldDesk, own: { state: "listed", version: 1, label: "Original private view canary", expiresAt: heldDesk.access.validUntil } };
    await mount(createElement(Desk)); await reviewName("Unsaved draft canary"); const before = calls.length;
    await act(async () => Channel.changed());
    assert.equal(document.body.textContent?.includes("Original private view canary"), false); assert.equal(document.body.textContent?.includes("Unsaved draft canary"), false);
    assert.equal(document.querySelector("dialog"), null); assert.equal(document.querySelector("#recognition-label"), null); assert.equal(calls.length, before);
  });
  it("fences a stale original private response after a foreign-scope reload", async () => {
    const original = deferred<Response>(); let count = 0;
    responseFor = async () => ++count === 1 ? original.promise : ok({ ...recUiDesk(), access: { ...heldDesk.access, accessId: "f".repeat(64) } });
    await mount(createElement(Desk)); await act(async () => Channel.changed()); await click(button("Reload current profile"));
    await until(() => !!document.querySelector("#recognition-label"), "fresh separately selected scope");
    await act(async () => original.resolve(ok({ ...heldDesk, own: { state: "listed", version: 1, label: "STALE RESPONSE CANARY", expiresAt: heldDesk.access.validUntil } })));
    assert.equal(document.body.textContent?.includes("STALE RESPONSE CANARY"), false); assert.equal(document.querySelector<HTMLInputElement>("#recognition-label")!.value, "");
  });
  it("public fixed freshness deadline removes names even with no successful next response", async () => {
    responseFor = async () => ok(recUiPage({ validUntil: recUiTime(90) }));
    await mount(createElement(PublicRecognitionWall, { slug: REC_UI_SLUG })); await until(() => !!document.body.textContent?.includes("Controlled public initials"), "current public label");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 140)); });
    assert.equal(document.body.textContent?.includes("Controlled public initials"), false);
  });
  it("a public denied read clears names and never renders an invalid private DTO", async () => {
    responseFor = async () => ok({ ...recUiPage(), privateActor: "PRIVATE CANARY" });
    await mount(createElement(PublicRecognitionWall, { slug: REC_UI_SLUG })); await until(() => !!document.querySelector('[role="alert"]'), "closed DTO validation");
    assert.equal(document.body.textContent?.includes("PRIVATE CANARY"), false); assert.equal(document.body.textContent?.includes("Controlled public initials"), false);
    responseFor = async () => failure("RECOGNITION_ACCESS_ENDED", 410); await click(button("Check current wall")); await until(() => !!document.body.textContent?.includes("Controlled current permission refusal"), "denied current read");
    assert.equal(document.body.textContent?.includes("Controlled public initials"), false);
  });
  it("never displays a label in a contradictory withdrawn private response", async () => {
    responseFor = async () => ok({ ...heldDesk, own: { state: "withdrawn", version: 2, label: "WITHDRAWN RESPONSE CANARY", expiresAt: heldDesk.access.validUntil } });
    await mount(createElement(Desk));
    await until(() => !document.body.textContent?.includes("Checking your original project access"), "current response settled");
    assert.equal(document.body.textContent?.includes("WITHDRAWN RESPONSE CANARY"), false);
  });
  it("never displays names in a contradictory unavailable public response", async () => {
    responseFor = async () => ok({ ...recUiPage(), state: "unavailable" });
    await mount(createElement(PublicRecognitionWall, { slug: REC_UI_SLUG }));
    await until(() => !document.body.textContent?.includes("Checking the current public page"), "public response settled");
    assert.equal(document.body.textContent?.includes("Controlled public initials"), false);
  });
  it("a different current profile never reads or replays another profile's retained journal", async () => {
    const input = originalInput(); writeRecognitionJournal(sessionStorage, { accessId: input.accessId, input, state: "unresolved" });
    heldDesk = { ...heldDesk, access: { ...heldDesk.access, accessId: "d".repeat(64) } };
    await mount(createElement(Desk)); await until(() => !!document.querySelector("#recognition-label"), "new independent scope");
    assert.equal(calls.filter(call => call.path.includes("/commands")).length, 0); assert.equal(document.body.textContent?.includes(input.label), false);
    assert.equal(document.querySelector<HTMLInputElement>("#recognition-label")!.value, "");
  });
  it("a storage-write failure prevents mutation dispatch", async () => {
    await mount(createElement(Desk)); await reviewName();
    const set = dom.window.Storage.prototype.setItem;
    try {
      dom.window.Storage.prototype.setItem = () => { throw Error("Controlled storage denied"); };
      await click(button("Publish this exact name")); await until(() => !!document.body.textContent?.includes("No decision was sent"), "pre-dispatch storage refusal");
      assert.equal(calls.filter(call => call.path === "/api/recognition/commands").length, 0);
    } finally { dom.window.Storage.prototype.setItem = set; }
  });
  it("denied original recovery never becomes an exact404 retry", async () => {
    const input = originalInput(); writeRecognitionJournal(sessionStorage, { accessId: input.accessId, input, state: "unresolved" });
    const base = responseFor; responseFor = call => call.path.startsWith("/api/recognition/commands/") ? Promise.resolve(failure("RECOGNITION_ACCESS_ENDED", 410)) : base(call);
    await mount(createElement(Desk)); await until(() => !!document.body.textContent?.includes("Controlled current permission refusal"), "original scope denied");
    assert.equal(document.querySelector("#recognition-label"), null); assert.equal(document.body.textContent?.includes("Review exact retry"), false);
    assert.equal(calls.filter(call => call.method === "POST").length, 0);
  });
  it("private fixed expiry clears the original name without waiting for a next response", async () => {
    const end = recUiTime(150); heldDesk = { ...heldDesk, access: { ...heldDesk.access, sessionExpiresAt: end, validUntil: end }, own: { version: 1, state: "listed", label: "EXPIRING PRIVATE CANARY", expiresAt: end } };
    await mount(createElement(Desk)); await until(() => !!document.body.textContent?.includes("EXPIRING PRIVATE CANARY"), "current original name");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 210)); });
    assert.equal(document.body.textContent?.includes("EXPIRING PRIVATE CANARY"), false); assert.equal(document.querySelector("#recognition-label"), null);
  });
  it("real React StrictMode remount keeps the ordinary current read usable without dispatch", async () => {
    await mount(createElement(React.StrictMode, null, createElement(Desk)));
    await until(() => !!document.querySelector("#recognition-label"), "StrictMode's second effect performed a fresh read");
    assert.equal(button("Review my public label").disabled, false); assert.equal(calls.filter(call => call.method === "POST").length, 0);
  });
  it("an outstanding current read disables review and a denied response clears the private draft", async () => {
    await mount(createElement(Desk)); await until(() => !!document.querySelector("#recognition-label"), "initial current form"); await fill("DRAFT CLEARED CANARY");
    const wait = deferred<Response>(); responseFor = () => wait.promise;
    await click(button("Refresh choices")); assert.equal(button("Review my public label").disabled, true);
    await click(button("Review my public label")); assert.equal(calls.filter(call => call.method === "POST").length, 0);
    await act(async () => wait.resolve(failure("RECOGNITION_ACCESS_ENDED", 410)));
    await until(() => document.querySelector("#recognition-label") === null, "ended read clears private form");
    assert.equal(document.body.textContent?.includes("DRAFT CLEARED CANARY"), false);
  });
  it("public page changes fence old labels while a new current page is still loading", async () => {
    const next = deferred<Response>(); responseFor = call => call.path.includes("cursor=") ? next.promise : Promise.resolve(ok(recUiPage({ nextCursor: "controlled-opaque-cursor" })));
    await mount(createElement(PublicRecognitionWall, { slug: REC_UI_SLUG })); await until(() => !!document.body.textContent?.includes("Controlled public initials"), "first page verified");
    await click(button("Next")); assert.equal(document.body.textContent?.includes("Controlled public initials"), false);
    await act(async () => next.resolve(ok(recUiPage({ entries: [{ label: "Next page initials", provenance: "self_declared" }] }))));
    await until(() => !!document.body.textContent?.includes("Next page initials"), "next page verified"); assert.equal(document.body.textContent?.includes("Controlled public initials"), false);
  });
  it("proof-unavailable empty state cannot create a new opt-in or prefill an identity", async () => {
    heldDesk = { ...heldDesk, selectedSlug: null, targets: [], own: null };
    await mount(createElement(Desk)); await until(() => !!document.querySelector("#recognition-label"), "private empty view");
    assert.equal(document.querySelector<HTMLInputElement>("#recognition-label")!.value, ""); assert.equal(button("Review my public label").disabled, true);
    assert(document.body.textContent?.includes("No currently published, permitted public Proof Page")); assert.equal(calls.filter(call => call.method === "POST").length, 0);
  });
  it("clipboard denial selects only the credential-free public address for ordinary copy", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw Error("Controlled clipboard denied"); } } });
    await mount(createElement(PublicRecognitionWall, { slug: REC_UI_SLUG })); await click(button("Copy link"));
    const field = document.querySelector<HTMLInputElement>("#recognition-public-link")!;
    assert.equal(document.activeElement, field); assert.equal(field.value, `http://localhost:4612/recognition/${REC_UI_SLUG}`); assert.equal(field.selectionStart, 0); assert.equal(field.selectionEnd, field.value.length);
  });
});
