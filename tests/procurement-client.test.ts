import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import * as C from "../lib/procurement/contracts";
import { createProcurementBoundary, clearProcurementPending, markProcurementPendingRejected, procurementAccessChanged, procurementRetryRetained, ProcurementRequestError, ProcurementStaleResponse, readProcurementPending, saveProcurementPending, PROCUREMENT_PENDING_KEY, type ProcurementStorage } from "../lib/procurement/client-boundary";
import { clearVolunteerEntryDrafts, loadVolunteerEntryDraft, parseVolunteerFragment, prepareVolunteerAcceptance, prepareVolunteerRestore, saveVolunteerIdentity, VOLUNTEER_ENTRY_DRAFT_KEY, VOLUNTEER_ENTRY_RETAINED_KEY } from "../lib/procurement/entry-draft";
import { PR_END, PR_SCOPE, PR_TIME, prId } from "./helpers/procurement";

function storage(): ProcurementStorage { const data = new Map<string, string>(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } }; }
const token = "a".repeat(64), otherToken = "b".repeat(64), fragment = { kind: "invite" as const, token }, noIntent = (): never => assert.fail("The existing original intent must be retained.");
function input() { return { intentId: prId(40), expectedScope: PR_SCOPE, supplierId: null, expectedVersion: 0, draft: { name: "Controlled private supplier canary", description: "Self-declared test input only.", declaredLocation: null, sourceNote: "No verified merchant or actual supplier response is implied.", provenance: "sample", acknowledged: true } }; }
const simple = z.object({ version: z.number().int() }).strict();
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

describe("procurement's exact original request boundary", () => {
  it("loads the root desk and separates cookie-bound entry from ordinary project-scoped requests", async () => {
    const calls: { transport: string; url: string; headers: Headers; init?: RequestInit }[] = [];
    const transport = (kind: string): typeof fetch => async (url, init) => { calls.push({ transport: kind, url: String(url), headers: new Headers(init?.headers), init }); return Response.json({ version: 1 }); };
    const boundary = createProcurementBoundary(transport("entry"), transport("project"));
    assert.deepEqual(await boundary.request("", simple, { scope: PR_SCOPE }), { version: 1 });
    await boundary.request("/entry/review", simple, { entry: true, body: { kind: "invite", token } });
    assert.deepEqual(calls.map(call => call.transport), ["project", "entry"]);
    assert.equal(calls[0].headers.get(C.PROCUREMENT_SCOPE_HEADER), PR_SCOPE); assert.equal(calls[1].headers.has("X-Fieldproof-Project"), false);
    for (const call of calls) { assert.equal(call.init?.cache, "no-store"); assert.equal(call.init?.redirect, "error"); assert.equal(call.init?.credentials, "same-origin"); }
    await assert.rejects(boundary.request("//other-origin", simple), ProcurementStaleResponse); assert.equal(calls.length, 2);
  });
  it("invalidates responses even when transport ignores abort or JSON decoding finishes after a new selection", async () => {
    const response = deferred<Response>(), json = deferred<unknown>(), boundary = createProcurementBoundary(undefined, async () => response.promise);
    const old = boundary.request("/quotes", simple, { scope: PR_SCOPE }); old.catch(() => {}); boundary.invalidate(); response.resolve(Response.json({ version: 1 })); await assert.rejects(old, ProcurementStaleResponse);
    const decoding = createProcurementBoundary(undefined, async () => ({ ok: true, json: () => json.promise } as Response)), late = decoding.request("/quotes", simple); late.catch(() => {}); await Promise.resolve(); decoding.invalidate(); json.resolve({ version: 2 }); await assert.rejects(late, ProcurementStaleResponse);
  });
  it("survives React StrictMode's cleanup/re-setup without reviving a previous request", async () => {
    const pending = deferred<Response>(); let reads = 0; const boundary = createProcurementBoundary(undefined, async () => ++reads === 1 ? pending.promise : Response.json({ version: 2 }));
    const original = boundary.request("", simple); original.catch(() => {}); boundary.dispose(); boundary.activate(); pending.resolve(Response.json({ version: 1 })); await assert.rejects(original, ProcurementStaleResponse); assert.deepEqual(await boundary.request("", simple), { version: 2 });
  });
  it("withholds malformed views and retains unknown outcomes but distinguishes atomic conflicts from current-authority loss", async () => {
    const bad = createProcurementBoundary(undefined, async () => Response.json({ version: 1, privateCanary: "must never become a view" }));
    await assert.rejects(bad.request("", simple), error => error instanceof ProcurementRequestError && error.status === 502 && procurementRetryRetained(error));
    const network = createProcurementBoundary(undefined, async () => { throw new Error("lost response"); }); await assert.rejects(network.request("/suppliers", simple, { body: input() }), error => error instanceof ProcurementRequestError && error.status === 0 && procurementRetryRetained(error));
    assert.equal(procurementRetryRetained(new ProcurementRequestError("Changed head", "PROCUREMENT_VERSION_CHANGED", 409)), false);
    assert.equal(procurementRetryRetained(new ProcurementRequestError("Retry same request", "PROCUREMENT_BUSY", 409)), true);
    assert.equal(procurementAccessChanged(new ProcurementRequestError("Ended", "PROCUREMENT_AUTHORITY_ENDED", 409)), true);
    assert.equal(procurementAccessChanged(new ProcurementRequestError("Source withdrawn", "PROCUREMENT_SOURCE_WITHDRAWN", 410)), false);
  });
  it("persists before dispatch, refuses overwriting unknown input and exposes no cross-profile or expired private fields", () => {
    const tab = storage(), original = saveProcurementPending(tab, "/suppliers", input(), PR_END, PR_TIME);
    assert.deepEqual(readProcurementPending(tab, PR_SCOPE, Date.parse(PR_TIME)), { state: "pending", pending: original });
    assert.throws(() => saveProcurementPending(tab, "/suppliers", { ...input(), intentId: prId(41) }, PR_END, PR_TIME), /previous tab request/);
    assert.deepEqual(readProcurementPending(tab, "f".repeat(64), Date.parse(PR_TIME)), { state: "other_profile", pending: null });
    assert.deepEqual(readProcurementPending(tab, PR_SCOPE, Date.parse(PR_END)), { state: "expired", pending: null });
    assert.ok(tab.getItem(PROCUREMENT_PENDING_KEY)?.includes("Controlled private supplier canary"));
    clearProcurementPending(tab, { intentId: prId(41), scope: PR_SCOPE }); assert.ok(tab.getItem(PROCUREMENT_PENDING_KEY));
    markProcurementPendingRejected(tab, original); assert.equal(readProcurementPending(tab, PR_SCOPE, Date.parse(PR_TIME)).state, "rejected"); clearProcurementPending(tab, original); assert.equal(tab.getItem(PROCUREMENT_PENDING_KEY), null);
  });
  it("does not replace a damaged request or accept stored scope/intent mismatches as a replay", () => {
    const tab = storage(), original = saveProcurementPending(tab, "/suppliers", input(), PR_END, PR_TIME);
    tab.setItem(PROCUREMENT_PENDING_KEY, JSON.stringify({ ...original, intentId: prId(41) })); assert.deepEqual(readProcurementPending(tab, PR_SCOPE, Date.parse(PR_TIME)), { state: "invalid", pending: null });
    assert.throws(() => saveProcurementPending(tab, "/suppliers", input(), PR_END, PR_TIME));
    tab.setItem(PROCUREMENT_PENDING_KEY, "{malformed"); clearProcurementPending(tab, original); assert.equal(tab.getItem(PROCUREMENT_PENDING_KEY), "{malformed");
    assert.throws(() => saveProcurementPending({ ...storage(), setItem: () => { throw new Error("Storage denied"); } }, "/suppliers", input(), PR_END, PR_TIME), /Storage denied/);
  });
});

describe("one-use volunteer fragment and lost-cookie-response recovery", () => {
  it("refuses duplicate, mixed, unknown and malformed fragment credentials", () => {
    assert.deepEqual(parseVolunteerFragment(""), { state: "empty", value: null }); assert.deepEqual(parseVolunteerFragment(`#invite=${token}`), { state: "valid", value: fragment });
    for (const value of [`?invite=${token}`, `#invite=${token}&invite=${token}`, `#invite=${token}&access=${otherToken}`, `#invite=${token}&role=organizer`, `#access=${token.slice(1)}`, "#invite=%zz", "#role=volunteer", `#invite=${token}%0a`]) assert.equal(parseVolunteerFragment(value).state, "invalid", value);
  });
  it("retains the exact trimmed identity and intent after acceptance while refusing field changes", () => {
    const tab = storage(), draft = saveVolunteerIdentity(tab, loadVolunteerEntryDraft(tab, fragment, () => prId(42), PR_TIME), "  Controlled unverified recipient  "), submitted = prepareVolunteerAcceptance(tab, draft, PR_SCOPE);
    assert.equal(submitted.displayName, "Controlled unverified recipient"); assert.equal(submitted.acceptance?.displayName, submitted.displayName);
    const restored = loadVolunteerEntryDraft(tab, fragment, noIntent); assert.deepEqual(restored, submitted); assert.deepEqual(prepareVolunteerAcceptance(tab, restored, "f".repeat(64)), submitted);
    assert.throws(() => saveVolunteerIdentity(tab, restored, "Changed actor"), /original submitted/); assert.equal(restored.acceptance?.role, "volunteer");
  });
  it("retains an original restore request after the server wrote a different cookie-bound review scope", () => {
    const tab = storage(), original = prepareVolunteerRestore(tab, loadVolunteerEntryDraft(tab, { kind: "access", token }, () => prId(43), PR_TIME), PR_SCOPE), recovered = loadVolunteerEntryDraft(tab, { kind: "access", token }, noIntent);
    assert.deepEqual(prepareVolunteerRestore(tab, recovered, "f".repeat(64)), original); assert.equal(original.restore?.intentId, prId(43)); assert.equal(original.restore?.expectedScope, PR_SCOPE);
  });
  it("starts a clean visible identity for a new token while retaining an unknown original attempt for that original link", () => {
    const tab = storage(), first = prepareVolunteerAcceptance(tab, saveVolunteerIdentity(tab, loadVolunteerEntryDraft(tab, fragment, () => prId(44), PR_TIME), "Private first identity"), PR_SCOPE), next = loadVolunteerEntryDraft(tab, { kind: "invite", token: otherToken }, () => prId(45), PR_TIME);
    assert.equal(next.displayName, ""); assert.equal(next.acceptance, null); assert.notEqual(next.intentId, first.intentId);
    assert.deepEqual(loadVolunteerEntryDraft(tab, fragment, noIntent), first); assert.ok(tab.getItem(VOLUNTEER_ENTRY_RETAINED_KEY)?.includes(first.intentId));
    clearVolunteerEntryDrafts(tab); assert.equal(tab.getItem(VOLUNTEER_ENTRY_DRAFT_KEY), null); assert.equal(tab.getItem(VOLUNTEER_ENTRY_RETAINED_KEY), null);
  });
  it("refuses a stored acceptance whose token or intent no longer matches instead of replacing an unknown request", () => {
    const tab = storage(), original = prepareVolunteerAcceptance(tab, saveVolunteerIdentity(tab, loadVolunteerEntryDraft(tab, fragment, () => prId(46), PR_TIME), "Original recipient"), PR_SCOPE);
    tab.setItem(VOLUNTEER_ENTRY_DRAFT_KEY, JSON.stringify({ ...original, acceptance: { ...original.acceptance, token: otherToken } }));
    assert.throws(() => loadVolunteerEntryDraft(tab, fragment, () => prId(47), PR_TIME), /cannot be verified|clear/i);
    assert.ok(tab.getItem(VOLUNTEER_ENTRY_DRAFT_KEY)?.includes(prId(46)), "The damaged original remains available for an explicit local decision.");
  });
  it("does not silently evict old unknown entry attempts when the bounded recovery journal is full", () => {
    const tab = storage();
    for (let index = 0; index <= 12; index++) loadVolunteerEntryDraft(tab, { kind: "invite", token: String.fromCharCode(65 + index).repeat(64) }, () => prId(50 + index), PR_TIME);
    assert.throws(() => loadVolunteerEntryDraft(tab, { kind: "invite", token: "z".repeat(64) }, () => prId(70), PR_TIME), /retained private entry attempts/);
    assert.equal(loadVolunteerEntryDraft(tab, { kind: "invite", token: "M".repeat(64) }, noIntent).intentId, prId(62));
  });
});
