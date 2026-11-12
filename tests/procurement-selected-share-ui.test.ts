import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import React, { act, createElement as h } from "react";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import * as C from "../lib/procurement/contracts";
import { procurementDetail, prId, PR_END, PR_TIME } from "./helpers/procurement";

/** Mounted presentation only, using explicitly synthetic authorized DTOs.
 * No application server, original document, database or network is eligible. */
const denied = () => { throw new Error("Selected-share UI controls permit no network or database transport."); };
const restorations: (() => void)[] = [];
function replace(object: object, key: PropertyKey, value: unknown) { const old = Object.getOwnPropertyDescriptor(object, key); Object.defineProperty(object, key, { configurable: true, writable: true, value }); restorations.push(() => { if (old) Object.defineProperty(object, key, old); else Reflect.deleteProperty(object, key); }); }
replace(globalThis, "fetch", async () => denied());
replace(net.Socket.prototype, "connect", denied); replace(tls, "connect", denied); replace(dgram, "createSocket", denied);
for (const api of [http, https]) { replace(api, "request", denied); replace(api, "get", denied); }
for (const api of new Set([dns, dns.promises, dnsPromises])) for (const key of Object.keys(api)) if (/^(?:lookup|resolve|reverse|Resolver)/.test(key)) replace(api, key, denied);
syncBuiltinESMExports();
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/procurement", pretendToBeVisual: true });
for (const name of ["window", "document", "navigator", "HTMLElement", "Node", "MutationObserver"] as const) replace(globalThis, name, name === "window" ? dom.window : name === "document" ? dom.window.document : dom.window[name]);
replace(globalThis, "self", dom.window); replace(globalThis, "React", React); replace(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { ProcurementPackageDetail } = await import("../components/procurement/detail");
const roots = new Set<Root>(), noop = () => {};
function detail(amount: number | null, organizer = false, currency = "USD"): C.ProcurementDetail {
  const value = procurementDetail();
  value.package.budgetMinor = 175000; // Deliberately different from the share.
  value.package.canManage = organizer; value.package.canReport = true;
  value.package.responsible!.own = !organizer;
  value.package.selectedQuote = C.procurementSelectionSchema.parse({ id: prId(100), version: 1, cycle: 1, quoteId: organizer ? prId(2) : null, quoteVersion: organizer ? 2 : null, quoteHash: null, supplierName: null, label: "Sample selected internal share", amountMinor: amount, currency, validUntil: PR_END, reviewedAt: PR_TIME, sourceAvailable: true, shareScalarsWithAssignee: true, reasons: [] });
  if (!organizer) value.quotes = [];
  return C.procurementDetailSchema.parse(value);
}
const element = (value: C.ProcurementDetail) => h(ProcurementPackageDetail, { detail: value, busy: false, back: noop, modal: noop, moreQuotes: noop });
async function mount(value: C.ProcurementDetail) { const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container); roots.add(root); await act(async () => root.render(element(value))); return { container, root }; }
const summary = (container: HTMLElement) => [...container.querySelectorAll("p")].find(p => p.textContent?.startsWith("Current selected internal share:"))?.textContent?.replace(/\s+/g, " ") ?? null;
afterEach(async () => { await act(async () => { for (const root of roots) root.unmount(); }); roots.clear(); document.body.innerHTML = ""; });
after(() => { dom.window.close(); for (const restore of restorations.reverse()) restore(); syncBuiltinESMExports(); });

describe("mounted selected internal quote share", () => {
  it("shows the exact assigned USD960 share without exposing the original quote or image", async () => {
    const { container } = await mount(detail(96000));
    assert.match(summary(container)!, /USD 960\.00/);
    assert.doesNotMatch(summary(container)!, /1,750\.00|quote v2/);
    assert.equal(container.querySelector("img"), null);
    assert.equal([...container.querySelectorAll("button")].some(b => b.textContent?.includes("Inspect source")), false);
    assert.ok(!container.innerHTML.includes(prId(2)));
  });
  it("shows an actual schema-valid zero instead of treating it as withheld", async () => {
    const { container } = await mount(detail(0));
    assert.match(summary(container)!, /USD 0\.00/); assert.doesNotMatch(summary(container)!, /withheld/i);
  });
  it("keeps an undisclosed amount withheld and never substitutes budget or zero", async () => {
    const { container } = await mount(detail(null));
    assert.match(summary(container)!, /amount withheld/i);
    assert.doesNotMatch(summary(container)!, /USD|1,750\.00|960\.00|0\.00/);
  });
  it("removes a previously disclosed amount when the current selection is unavailable", async () => {
    const value = detail(96000), { container, root } = await mount(value);
    value.package.selectedQuote = null;
    await act(async () => root.render(element(value)));
    assert.equal(summary(container), null);
    assert.ok(container.textContent?.includes("No current selected quote summary is disclosed"));
    assert.ok(!container.textContent?.replace(/\s+/g, " ").includes("USD 960.00"));
    assert.equal(container.querySelector("img"), null);
  });
  it("withholds a partial runtime summary without its selected currency", async () => {
    const value = detail(96000);
    // Invalid/incomplete transport data is not an alternate budget authority.
    Object.assign(value.package.selectedQuote!, { currency: null });
    const { container } = await mount(value);
    assert.match(summary(container)!, /amount withheld/i);
    assert.doesNotMatch(summary(container)!, /USD|960\.00|1,750\.00|0\.00/);
  });
  it("keeps the organizer's original quote controls and selected currency/version", async () => {
    const { container } = await mount(detail(96000, true, "EUR"));
    assert.match(summary(container)!, /EUR 960\.00/); assert.match(summary(container)!, /quote v2/);
    assert.doesNotMatch(summary(container)!, /USD 960\.00/);
    assert.equal([...container.querySelectorAll("button")].some(b => b.textContent?.includes("Inspect source")), true);
  });
});
