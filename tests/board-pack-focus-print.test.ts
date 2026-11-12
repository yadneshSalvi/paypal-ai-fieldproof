import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import React, { act, createElement, useState } from "react";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { BoardPackDesk, BoardPackReport, BoardPackSourceDetail, BoardPackView } from "../lib/reports/board-pack-contracts";
import { BOARD_PACK_VERSION } from "../lib/reports/board-pack-contracts";
import { STUDIO_POSITION_VERSION, STUDIO_SEMANTIC_VERSION } from "../lib/studio/contracts";

/** Real DOM/component tests. jsdom has no native modal, Tab navigation or image
 * decoder: only those platform primitives are supplied; product focus handlers,
 * asynchronous state, access checks and readiness transitions run unchanged. */
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:4595/board-pack", pretendToBeVisual: true });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
function expose(key: string, value: unknown) {
  if (!savedGlobals.has(key)) savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLDialogElement", "HTMLImageElement", "Node", "MutationObserver"] as const) expose(key, key === "window" ? dom.window : key === "document" ? dom.window.document : dom.window[key]);
expose("self", dom.window);
expose("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
expose("requestAnimationFrame", dom.window.requestAnimationFrame.bind(dom.window));
expose("cancelAnimationFrame", dom.window.cancelAnimationFrame.bind(dom.window));
expose("IS_REACT_ACT_ENVIRONMENT", true);
expose("React", React);

class LocalChannel {
  static channels = new Set<LocalChannel>();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) { LocalChannel.channels.add(this); }
  close() { LocalChannel.channels.delete(this); }
  postMessage(data: unknown) { for (const channel of LocalChannel.channels) if (channel !== this && channel.name === this.name) channel.onmessage?.({ data }); }
  static changeWorkspace() { for (const channel of LocalChannel.channels) if (channel.name === "fieldproof-workspace-changed") channel.onmessage?.({ data: { origin: "another-controlled-test-tab" } }); }
}
expose("BroadcastChannel", LocalChannel);
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
let decodeCalls = 0, decodeImage: () => Promise<void> = async () => {};
dom.window.HTMLImageElement.prototype.decode = async function () {
  decodeCalls++;
  await decodeImage();
  Object.defineProperties(this, { complete: { configurable: true, value: true }, naturalWidth: { configurable: true, value: 1 }, naturalHeight: { configurable: true, value: 1 } });
};
const styles = registerHooks({ load(url, context, nextLoad) { return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : nextLoad(url, context); } });
const { createRoot } = await import("react-dom/client");
const { BoardPackDialog } = await import("../components/board-pack/shared");
const { BoardPackWorkspace, SourcePanel } = await import("../components/board-pack/workspace");
styles.deregister();

const REPORT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", HASH = "f".repeat(64), SCOPE = "a".repeat(64), AS_OF = "2026-11-12T01:00:00.000Z";
const SOURCE_ID = "evidence:synthetic-print-image";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bPAAAAAASUVORK5CYII=", "base64");
const IMAGE_HASH = createHash("sha256").update(PNG).digest("hex");
const noAction = () => {};
function fixtureView(): BoardPackView {
  const source = { id: SOURCE_ID, kind: "evidence" as const, label: "Synthetic reviewed illustration", packageIds: ["printing"], provenance: "sample", observedAt: AS_OF, reviewerLabel: "Synthetic image reviewer", reviewedAt: AS_OF, scope: "Illustrative image only; no physical work accepted.", available: true };
  const report: BoardPackReport = {
    schemaVersion: BOARD_PACK_VERSION, id: REPORT_ID, label: "Synthetic immutable edition", contentHash: HASH,
    project: { id: "synthetic-focus-print-project", title: "Synthetic prepared-print project", templateId: "makerspace", currency: "USD", mode: "sample" },
    audience: { role: "organizer", label: "Organizer project report", detail: "Synthetic component test, not a real project or provider result.", receiptScope: "project", expenseScope: "project_private" },
    asOf: AS_OF, projectionVersion: 12, eventCursor: 21, semanticVersion: STUDIO_SEMANTIC_VERSION, datasetVersions: { funding_positions: STUDIO_POSITION_VERSION },
    data: { packages: [{ id: "printing", packageId: "printing", title: "Synthetic Printing", shortTitle: "Printing", budgetMinor: 96000, pledgedMinor: 0, collectedMinor: 0, fundingEligibleMinor: 0, shortfallMinor: 96000, pendingRefundMinor: 0, completedRefundMinor: 0, excessLiabilityMinor: 0, allocationReservedMinor: 0, availableAllocationMinor: 0, approvedExpenseMinor: 0, paidExpenseMinor: 0, reviewedItemCount: 1, requiredItemCount: 2, reviewedExpenseLineCount: 0, fundingState: "open", workState: "planned", geometryRef: "printing", provenance: "sample" }], settlements: [], funding_positions: [], allocations: [], evidence: [{ id: "synthetic-print-image", packageId: "printing", evidenceId: "synthetic-print-image", title: source.label, sourceClass: "reviewed_photo", reviewState: "accepted_within_scope", itemCount: 1, reviewedAt: AS_OF, sourceAvailable: true, documentId: null, claimId: null, provenance: "sample", reviewScope: source.scope, amountMinor: null }], exceptions: [] },
    packages: [{ packageId: "printing", version: 1, title: "Synthetic Printing", lifecycleState: "active", originalCommitmentRecordMinor: 0, unpaidCommitmentMinor: 0, acceptedSponsorUnpaidMinor: 0, currentCase: null, requirements: [{ id: "photo", label: "Reviewed illustrative image", satisfied: true, detail: source.scope, scope: null }, { id: "installation", label: "Physical review", satisfied: false, detail: "No physical work accepted.", scope: "equipment_setup" }], blockers: [], sourceId: "package:printing" }],
    geometry: { printing: { packageId: "printing", points: [{ x: .1, y: .1 }, { x: .9, y: .1 }, { x: .9, y: .9 }, { x: .1, y: .9 }, { x: .1, y: .1 }], label: { x: .5, y: .5 } } }, geometrySource: null,
    totals: { project: { budgetMinor: 96000, currentCollectedMinor: 0, eligibleMinor: 0, unpaidCommitmentMinor: 0, acceptedSponsorUnpaidMinor: 0, returnedMinor: 0, pendingReturnMinor: 0, reservedMinor: 0, paidMinor: 0, availableMinor: 0, approvedExpenseMinor: 0, deliveredPrincipalMinor: 0, paidFeeMinor: 0, reservedFeeMinor: 0, acceptedWorkItems: 1, requiredWorkItems: 2, acceptedPackages: 0, packageCount: 1 }, receipts: { scope: "project", count: 0, grossMinor: 0, creditedMinor: 0, returnedMinor: 0, pendingReturnMinor: 0, excludedMinor: 0, excessLiabilityMinor: 0, ordersGrossMinor: 0, invoiceGrossMinor: 0, testGrossMinor: 0 }, positions: { scope: "project", count: 0, assignedMinor: 0, collectedMinor: 0, eligibleMinor: 0, returnedMinor: 0, pendingReturnMinor: 0, excludedMinor: 0, reservedMinor: 0, paidMinor: 0, availableMinor: 0 } },
    assignments: [], expenses: [], reviewedImages: [{ sourceId: SOURCE_ID, width: 1, height: 1, alt: "Synthetic reviewed illustration, not completed work", contentHash: IMAGE_HASH }],
    balance: { state: "not_recorded", observedAt: null, asOf: null, refreshedAt: null, availableMinor: null, code: null, sourceId: null, limitation: "No provider liquidity observation." },
    sources: [{ ...source, id: "package:printing", kind: "package", label: "Synthetic Printing" }, source], notices: ["Fictional DOM test; no human or financial result is claimed."],
  };
  return { summary: { id: report.id, label: report.label, asOf: report.asOf, contentHash: report.contentHash, role: report.audience.role, projectionVersion: report.projectionVersion, eventCursor: report.eventCursor, packageCount: 1 }, status: "current", checkedAt: AS_OF, currentProjectionVersion: 12, currentEventCursor: 21, reasons: [], report, canPrint: true, canExport: true };
}
function detailFixture(view = fixtureView()): BoardPackSourceDetail {
  return { reportId: REPORT_ID, contentHash: HASH, asOf: AS_OF, source: view.report!.sources[1], fields: [{ label: "Purpose", value: "Synthetic print regression" }], image: { url: "/api/board-packs/" + REPORT_ID + "/sources/" + encodeURIComponent(SOURCE_ID) + "/image", width: 1, height: 1, alt: "Synthetic reviewed illustration, not completed work", contentHash: IMAGE_HASH }, relatedSourceIds: ["package:printing"], limitations: ["Illustration only."] };
}
function deskFixture(view = fixtureView()): BoardPackDesk {
  return { scope: SCOPE, projectId: view.report!.project.id, projectTitle: view.report!.project.title, audience: view.report!.audience, sessionExpiresAt: "2099-11-12T01:00:00.000Z", projectionVersion: 12, eventCursor: 21, history: [view.summary], nextCursor: null, selected: view, canCapture: true };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const roots = new Set<Root>();
let reportReads = 0, printCalls = 0;
let calls: { path: string; method: string; headers: Headers }[] = [];
let reportResponse: (read: number) => Promise<BoardPackView> = async () => fixtureView();
let reportStatus: (read: number) => number = () => 200;
async function mount(element: React.ReactElement) {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container); roots.add(root);
  try { await act(async () => { root.render(element); }); }
  catch (error) {
    if (error instanceof AggregateError) throw new AggregateError(error.errors, error.errors.map((item: unknown) => item instanceof Error ? item.stack : String(item)).join("\n"));
    throw error;
  }
  return { root, container };
}
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 5)); });
  }
  assert.ok(check(), message);
}
function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.includes(text));
  assert.ok(found, "Missing ordinary action: " + text);
  return found;
}
async function click(node: HTMLElement) { await act(async () => { node.focus(); node.click(); }); }
function tab(node: HTMLElement, shiftKey = false) {
  const event = new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
  node.dispatchEvent(event);
  return event;
}
function isReady() { return document.querySelector(".bp-print-container")?.getAttribute("data-print-ready") === "true"; }
async function openWorkspace(view = fixtureView(), desk = deskFixture(view)) {
  await mount(createElement(BoardPackWorkspace, { initial: desk }));
  await until(() => !!document.querySelector("img[data-bp-reviewed-image]"), "Reviewed image should load through its real scoped source and byte checks.");
}
function DialogHarness() {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [preview, setPreview] = useState<string | null>(null), [source, setSource] = useState(SOURCE_ID);
  return createElement(React.Fragment, null,
    createElement("button", { id: "source-opener", onClick: () => setOpen(true) }, "Open synthetic source"),
    createElement("button", { id: "outside-action" }, "Outside action"),
    open && createElement(BoardPackDialog, { title: "Synthetic source", focusKey: source, close: () => setOpen(false), children: createElement(React.Fragment, null,
      createElement("button", { hidden: true }, "Hidden control"),
      createElement("button", { disabled: true }, "Disabled control"),
      createElement(SourcePanel, { detail: detailFixture(), loading: false, error: null, preview, previewBusy: busy, previewError: null,
        onPreview: () => { setBusy(true); }, onImageError: noAction, onRelated: id => { setSource(id); setBusy(false); setPreview(null); }, close: () => setOpen(false) }),
    ) }),
  );
}
async function openDialog() {
  await mount(createElement(DialogHarness));
  await click(button("Open synthetic source"));
  const dialog = document.querySelector<HTMLDialogElement>("dialog"); assert.ok(dialog?.open);
  return dialog;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.removeAttribute("tabindex");
  calls = []; reportReads = 0; printCalls = 0; decodeCalls = 0; decodeImage = async () => {};
  reportResponse = async () => fixtureView();
  reportStatus = () => 200;
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
  dom.window.print = () => { printCalls++; };
  expose("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin), method = init?.method ?? "GET", headers = new Headers(init?.headers);
    calls.push({ path: url.pathname, method, headers });
    assert.equal(method, "GET", "Focus/preview must never create a report or other resource.");
    assert.equal(headers.get("X-Fieldproof-Board-Pack-Scope"), SCOPE);
    if (url.pathname === "/api/board-packs/" + REPORT_ID) {
      const read = ++reportReads, status = reportStatus(read);
      return status === 200 ? Response.json({ view: await reportResponse(read) }) : Response.json({ error: "Synthetic current report access ended.", code: "MEMBERSHIP_DENIED" }, { status });
    }
    if (url.pathname === "/api/board-packs/" + REPORT_ID + "/sources/" + encodeURIComponent(SOURCE_ID)) return Response.json({ detail: detailFixture() });
    if (url.pathname.endsWith("/image")) return new Response(new Uint8Array(PNG), { headers: { "Content-Type": "image/png" } });
    if (url.pathname === "/api/board-packs") return Response.json({ desk: deskFixture() });
    assert.fail("Unexpected request in isolated component test: " + url.pathname);
  });
});
afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.clear();
  assert.equal(LocalChannel.channels.size, 0, "Every workspace listener must be removed.");
  document.body.innerHTML = "";
});
after(() => {
  dom.window.close();
  for (const [key, descriptor] of savedGlobals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
});

describe("real Board Pack source-dialog focus", () => {
  it("starts inside the named dialog and returns to the exact opener after Escape", async () => {
    const dialog = await openDialog();
    assert.equal(document.activeElement === dialog.querySelector("h2"), true);
    const cancel = new dom.window.Event("cancel", { cancelable: true });
    await act(async () => { dialog.dispatchEvent(cancel); });
    assert.equal(cancel.defaultPrevented, true);
    assert.equal(document.querySelector("dialog") === null, true);
    assert.equal(document.activeElement?.id, "source-opener");
  });
  it("wraps Tab from the last real source button to the first enabled dialog action", async () => {
    const dialog = await openDialog(), last = button("package:printing", dialog);
    last.focus();
    const event = tab(last);
    assert.equal(event.defaultPrevented, true, "The dialog must own its forward Tab boundary.");
    assert.equal(document.activeElement === dialog.querySelector('[aria-label="Close source details"]'), true);
  });
  it("wraps Shift+Tab from the first action and the initially focused heading to the last action", async () => {
    const dialog = await openDialog(), last = button("package:printing", dialog), first = dialog.querySelector<HTMLButtonElement>('[aria-label="Close source details"]')!;
    first.focus(); assert.equal(tab(first, true).defaultPrevented, true); assert.equal(document.activeElement === last, true);
    const heading = dialog.querySelector<HTMLElement>("h2")!; heading.focus();
    assert.equal(tab(heading, true).defaultPrevented, true); assert.equal(document.activeElement === last, true);
  });
  it("keeps the image trigger focusable while access is checked and recovers an escaped BODY focus", async () => {
    const dialog = await openDialog(), inspect = button("Inspect source image", dialog);
    await click(inspect);
    assert.equal(button("Checking image access", dialog) === inspect, true, "The exact trigger should be retained across its asynchronous state.");
    assert.equal(inspect.disabled, false, "Disabling the active native button drops focus in the retained native failure.");
    assert.equal(inspect.getAttribute("aria-disabled"), "true");
    assert.equal(document.activeElement === inspect, true);
    document.body.tabIndex = -1; document.body.focus();
    assert.equal(document.activeElement === inspect, true, "An open modal must recover escaped focus to its last connected control.");
  });
  it("recovers focusin on BODY to the last connected source control", async () => {
    const dialog = await openDialog(), inspect = button("Inspect source image", dialog);
    inspect.focus();
    document.body.tabIndex = -1; document.body.focus();
    assert.equal(document.activeElement === inspect, true, "Escaped BODY focus cannot leave the open source dialog without a focused control.");
  });
  it("leaves an ordinary interior Tab to the browser", async () => {
    const dialog = await openDialog(), inspect = button("Inspect source image", dialog);
    inspect.focus(); assert.equal(tab(inspect).defaultPrevented, false);
    assert.equal(document.activeElement === inspect, true, "jsdom does not synthesize native Tab movement; the handler must not steal it.");
  });
  it("moves to the source heading when following a different source without closing the dialog", async () => {
    const dialog = await openDialog(); await click(button("package:printing", dialog));
    assert.equal(document.querySelector("dialog") === dialog, true);
    assert.equal(document.activeElement === dialog.querySelector("h2"), true);
  });
});

describe("real same-edition prepared-print action", () => {
  it("waits for fonts and DOM image decoding, then prepares the same checked edition without opening OS print", async () => {
    const fonts = deferred<void>(), decoded = deferred<void>();
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: fonts.promise } });
    decodeImage = () => decoded.promise;
    await openWorkspace(); await click(button("Prepare print preview"));
    assert.equal(isReady(), false); assert.equal(printCalls, 0); assert.equal(reportReads, 1);
    await act(async () => { fonts.resolve(); });
    await until(() => decodeCalls > 0, "The actual report images must be decoded.");
    assert.equal(isReady(), false); assert.equal(printCalls, 0);
    await act(async () => { decoded.resolve(); });
    await until(isReady, "The ordinary preparation action should produce the checked print state.");
    assert.equal(reportReads, 2, "Use the initial edition read and final current-access revalidation; no capture.");
    assert.equal(printCalls, 0, "Prepared preview must not enter the OS print sheet.");
    const status = document.querySelector('[aria-label="Prepared print preview"]'); assert.ok(status);
    assert.match(status.textContent!, new RegExp(REPORT_ID)); assert.match(status.textContent!, new RegExp(HASH));
    assert.equal(document.activeElement === status.querySelector("h2"), true, "The completed preview should receive deliberate heading focus.");
    assert.match(status.textContent!, /A4/); assert.match(document.querySelector(".bp-report")!.textContent!, /Synthetic immutable edition/);
    assert.ok(calls.every(call => call.method === "GET" && !call.path.endsWith("/capture")));
  });
  it("keeps the existing actual print action behind the same readiness path", async () => {
    await openWorkspace(); await click(button("Print / save PDF"));
    await until(() => printCalls === 1, "The existing actual print action should still invoke window.print once.");
    assert.equal(reportReads, 2); assert.equal(isReady(), false);
  });
  it("refuses preparation when final revalidation withdraws the source after image decode", async () => {
    reportResponse = async read => read === 1 ? fixtureView() : { ...fixtureView(), status: "withdrawn", report: null, canPrint: false, canExport: false, reasons: ["Synthetic source permission withdrawn."] };
    await openWorkspace(); await click(button("Prepare print preview"));
    await until(() => reportReads >= 2 && !!document.querySelector(".bp-action-message.is-error"), "The final permission check should refuse the preparation.");
    assert.equal(isReady(), false); assert.equal(printCalls, 0); assert.equal(document.querySelector(".bp-report") === null, true);
  });
  it("refuses a different content hash for the same report ID", async () => {
    reportResponse = async read => {
      const view = fixtureView();
      return read === 1 ? view : { ...view, summary: { ...view.summary, contentHash: "b".repeat(64) }, report: { ...view.report!, contentHash: "b".repeat(64) } };
    };
    await openWorkspace(); await click(button("Prepare print preview"));
    await until(() => reportReads >= 2 && !!document.querySelector(".bp-action-message.is-error"), "A substituted edition must not become ready.");
    assert.equal(isReady(), false); assert.equal(printCalls, 0);
    assert.equal(document.querySelector(".bp-report") === null, true, "Changed content is paused rather than silently relabelled.");
  });
  it("invalidates a prepared preview on paper/filter changes and leaves the unchecked-print warning available", async () => {
    await openWorkspace(); await click(button("Prepare print preview")); await until(isReady, "First preview should be ready.");
    const paper = document.querySelector<HTMLSelectElement>(".bp-toolbar select")!;
    await act(async () => { paper.value = "Letter"; paper.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.equal(isReady(), false); assert.equal(document.querySelector('[aria-label="Prepared print preview"]') === null, true);
    assert.ok(document.querySelector(".bp-print-warning")?.textContent?.includes("Recheck"));
    await click(button("Prepare print preview")); await until(isReady, "Letter preview should be revalidated.");
    assert.match(document.querySelector('[aria-label="Prepared print preview"]')!.textContent!, /Letter/);
    const filter = document.querySelector<HTMLSelectElement>(".bp-filter select")!;
    await act(async () => { filter.value = "printing"; filter.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.equal(isReady(), false); assert.equal(printCalls, 0);
  });
  it("cannot restore late prepared content after a workspace/actor boundary change", async () => {
    const last = deferred<BoardPackView>();
    reportResponse = async read => read === 1 ? fixtureView() : last.promise;
    await openWorkspace(); await click(button("Prepare print preview"));
    await until(() => reportReads >= 2, "Preparation should reach its final authorized read.");
    await act(async () => { LocalChannel.changeWorkspace(); });
    await act(async () => { last.resolve(fixtureView()); });
    assert.equal(isReady(), false); assert.equal(printCalls, 0);
    assert.equal(document.querySelector(".bp-report") === null, true);
    assert.match(document.body.textContent!, /active workspace changed/i);
  });
  it("clears pending preparation when rendered images are replaced during final validation", async () => {
    const final = deferred<BoardPackView>(); reportResponse = async read => read === 1 ? fixtureView() : final.promise;
    await openWorkspace(); await click(button("Prepare print preview"));
    await until(() => reportReads >= 2, "Preparation should reach its final current-access check.");
    const image = document.querySelector<HTMLImageElement>("img[data-bp-reviewed-image]")!;
    image.replaceWith(image.cloneNode(true));
    await act(async () => { final.resolve(fixtureView()); });
    await until(() => /report view changed/.test(document.querySelector(".bp-action-message")?.textContent ?? ""), "A changed rendered view should require explicit preparation again.");
    await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 20)); });
    assert.equal(isReady(), false); assert.equal(printCalls, 0); assert.equal(reportReads, 2, "A stale decode phase must not restart validation automatically.");
  });
  it("clears readiness and its ready label after an ordinary quiet access recheck", async () => {
    await openWorkspace(); await click(button("Prepare print preview")); await until(isReady, "Preview should be prepared.");
    await act(async () => { window.dispatchEvent(new dom.window.Event("focus")); });
    await until(() => !isReady() && reportReads >= 3, "The normal quiet recheck should clear the prepared state.");
    assert.equal(document.querySelector('[aria-label="Prepared print preview"]') === null, true);
    assert.match(document.querySelector(".bp-action-message")!.textContent!, /Prepare the print preview again/);
    assert.equal(printCalls, 0);
  });
  it("clears private content when final current membership authorization is denied", async () => {
    reportStatus = read => read === 1 ? 200 : 403;
    await openWorkspace(); await click(button("Prepare print preview"));
    await until(() => reportReads >= 2 && document.querySelector(".bp-report") === null, "The current authority denial must clear private report content.");
    assert.equal(isReady(), false); assert.equal(printCalls, 0);
    assert.match(document.body.textContent!, /needs current access/i);
    assert.equal(document.querySelector("img[data-bp-reviewed-image]") === null, true);
  });
  it("does not finish preparation after the original fixed session deadline", async () => {
    const fonts = deferred<void>(), view = fixtureView(), desk = deskFixture(view);
    desk.sessionExpiresAt = new Date(Date.now() + 500).toISOString();
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: fonts.promise } });
    await openWorkspace(view, desk); await click(button("Prepare print preview"));
    await until(() => document.querySelector(".bp-report") === null && /session has ended/.test(document.body.textContent!), "The original fixed deadline must end preparation.");
    await act(async () => { fonts.resolve(); });
    assert.equal(isReady(), false); assert.equal(printCalls, 0); assert.equal(reportReads, 1);
    assert.equal(document.querySelector("img[data-bp-reviewed-image]") === null, true);
  });
  it("never prepares an edition when a reviewed image cannot decode", async () => {
    decodeImage = async () => { throw new Error("Controlled decoder failure."); };
    await openWorkspace(); await click(button("Prepare print preview"));
    await until(() => !!document.querySelector(".bp-action-message.is-error"), "Image decoding failure should be visible.");
    assert.equal(isReady(), false); assert.equal(printCalls, 0);
    assert.match(document.querySelector(".bp-action-message")!.textContent!, /image|decod/i);
  });
});
