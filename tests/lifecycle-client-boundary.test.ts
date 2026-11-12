import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import * as C from "../lib/lifecycle/contracts";
import { ORG_PROJECT_SCOPE_HEADER, ORG_SCOPE_HEADER } from "../lib/organizations/contracts";
import { createLifecycleBoundary, createLifecyclePending, lifecycleApiPath, lifecycleCommandPath, lifecycleCurrentStorageKeys, lifecycleErrorRecovery, lifecyclePendingStorageKey, lifecycleRequest, LifecycleRequestError, readLifecyclePending, saveLifecyclePending, type LifecycleStorage } from "../lib/lifecycle/client-boundary";
import { LC_FIRST, LC_ORG_END, LC_PROJECT_END, LC_TIME, lcId, lifecycleContext, lifecyclePrepare } from "./helpers/lifecycle";

function storage(): LifecycleStorage & { values: Map<string, string> } { const values = new Map<string, string>(); return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } }; }
const preferences = (): C.LifecycleCommand => ({ kind: "preferences", input: { intentId: lcId(701), expectedScope: "b".repeat(64), expectedVersion: 0, enabled: true, categories: ["pledges"], emailPreviews: false, history: "future_only", acknowledged: true } });
const program = (): C.LifecycleCommand => ({ kind: "program_enable", input: { intentId: lcId(702), expectedScope: "a".repeat(64), expectedVersion: 0, expiresAt: LC_ORG_END, acknowledged: true } });
function schedule(): C.LifecycleCommand { return { kind: "schedule_enable", input: { intentId: lcId(703), expectedScope: "a".repeat(64), reviewHash: "c".repeat(64), review: lifecyclePrepare(), acknowledged: true } }; }

describe("private lifecycle request domains", () => {
  it("keeps personal, org-only and dual scope headers separate without coupling aggregates to a project cookie", async () => {
    const captured: RequestInit[] = [], fetcher: typeof fetch = async (_url, options) => { captured.push(options!); return Response.json({ ok: true }); }, schema = z.object({ ok: z.literal(true) }).strict();
    await lifecycleRequest("inbox", schema, undefined, { domain: "project", projectScope: "b".repeat(64), organizationScope: "a".repeat(64), fetcher });
    await lifecycleRequest("schedules", schema, undefined, { domain: "organization", organizationScope: "a".repeat(64), projectScope: "WRONG UNRELATED PROJECT", fetcher });
    await lifecycleRequest("occurrences", schema, undefined, { domain: "dual", organizationScope: "a".repeat(64), projectScope: "b".repeat(64), fetcher });
    const [personal, org, dual] = captured.map(value => new Headers(value.headers));
    assert.equal(personal.get(C.LIFECYCLE_PROJECT_SCOPE_HEADER), "b".repeat(64)); assert.equal(personal.has(ORG_SCOPE_HEADER), false); assert.equal(personal.has(ORG_PROJECT_SCOPE_HEADER), false);
    assert.equal(org.get(ORG_SCOPE_HEADER), "a".repeat(64)); assert.equal(org.has(ORG_PROJECT_SCOPE_HEADER), false); assert.equal(org.has(C.LIFECYCLE_PROJECT_SCOPE_HEADER), false);
    assert.equal(dual.get(ORG_PROJECT_SCOPE_HEADER), "b".repeat(64)); assert.equal(dual.get(ORG_SCOPE_HEADER), "a".repeat(64));
    for (const request of captured) { assert.equal(request.cache, "no-store"); assert.equal(request.credentials, "same-origin"); assert.equal(request.referrerPolicy, "no-referrer"); assert.equal(request.redirect, "error"); }
  });
  it("refuses unscoped writes, traversal, capability queries and malformed filters before any transport", async () => {
    let calls = 0; const fetcher: typeof fetch = async () => { calls++; return Response.json({ ok: true }); }, schema = z.object({ ok: z.literal(true) });
    for (const path of ["../organizations", "https://example.invalid", "inbox#access=PRIVATE", "schedules?token=PRIVATE", "targets?audience=organization_aggregate&audience=project_treasurer", "targets?filters=%7B%22actorId%22%3A%22PRIVATE%22%7D", `inbox/${lcId(1)}/sources/%252fprivate`]) assert.throws(() => lifecycleApiPath(path));
    const cursor = "controlled opaque cursor /?&", query = new URLSearchParams({ state: "archived", before: cursor }); assert.equal(new URL(lifecycleApiPath(`inbox?${query}`), "https://lifecycle.invalid").searchParams.get("before"), cursor);
    assert.throws(() => lifecycleApiPath(`inbox/${"-".repeat(36)}`)); assert.throws(() => lifecycleApiPath(`inbox/${lcId(1)}/sources/%2fprivate?before=safe`));
    await assert.rejects(lifecycleRequest("preferences", schema, {}, { domain: "context", fetcher }), TypeError); await assert.rejects(lifecycleRequest("inbox", schema, undefined, { domain: "project", fetcher }), LifecycleRequestError); assert.equal(calls, 0);
  });
  it("aborts all prior dual/private responses on the affected identity while preserving the independently current domain", () => {
    const boundary = createLifecycleBoundary(), project = boundary.start("project"), org = boundary.start("organization"), dual = boundary.start("dual");
    boundary.invalidate("project"); assert.equal(project.current(), false); assert.equal(project.signal.aborted, true); assert.equal(dual.current(), false); assert.equal(org.current(), true);
    const secondProject = boundary.start("project"); boundary.invalidate("organization"); assert.equal(org.current(), false); assert.equal(secondProject.current(), true); boundary.dispose(); assert.equal(secondProject.current(), false);
  });
  it("separates a retryable interrupted response from source withdrawal, expired identity and a stale reviewed head", async () => {
    assert.equal(lifecycleErrorRecovery(new LifecycleRequestError("lost", "REQUEST_UNAVAILABLE", 0)), "same_request");
    assert.equal(lifecycleErrorRecovery(new LifecycleRequestError("withdrawn", "LIFECYCLE_SOURCE_WITHDRAWN", 410)), "source");
    assert.equal(lifecycleErrorRecovery(new LifecycleRequestError("changed", "LIFECYCLE_PROJECT_CHANGED", 409)), "project");
    assert.equal(lifecycleErrorRecovery(new LifecycleRequestError("head", "LIFECYCLE_VERSION_CHANGED", 409)), "review");
    await assert.rejects(lifecycleRequest("context", z.object({ safe: z.literal(true) }).strict(), undefined, { domain: "context", fetcher: async () => Response.json({ rawPrivateValue: "PRIVATE RESPONSE" }) }), error => error instanceof LifecycleRequestError && error.code === "REQUEST_UNAVAILABLE" && !error.message.includes("PRIVATE RESPONSE"));
  });
});

describe("exact per-tab pending request and independent profile recovery", () => {
  it("retains the original payload, intent and fixed deadline across reload without creating another request", async () => {
    const context = lifecycleContext("donor"), command = preferences(), pending = await createLifecyclePending(command, context, LC_PROJECT_END, LC_TIME), saved = storage(); saveLifecyclePending(saved, pending);
    const restored = await readLifecyclePending(saved.getItem(lifecyclePendingStorageKey(pending)), context, LC_FIRST);
    assert.deepEqual(restored, pending); assert.equal(restored!.command.input.intentId, command.input.intentId); assert.equal(restored!.expiresAt, LC_PROJECT_END); assert.equal(lifecycleCommandPath(command), "preferences");
  });
  it("detects changed stored values, foreign contexts and original expiry without accepting a renewed deadline", async () => {
    const context = lifecycleContext("donor"), pending = await createLifecyclePending(preferences(), context, LC_PROJECT_END, LC_TIME), changed = structuredClone(pending);
    if (changed.command.kind === "preferences") changed.command.input.categories = ["contributions"];
    assert.equal(await readLifecyclePending(JSON.stringify(changed), context, LC_FIRST), null); assert.equal(await readLifecyclePending(JSON.stringify(pending), context, LC_PROJECT_END), null);
    const other = lifecycleContext("donor"); other.project.scope = "e".repeat(64); assert.equal(await readLifecyclePending(JSON.stringify(pending), other, LC_FIRST), null);
    await assert.rejects(createLifecyclePending(preferences(), context, LC_ORG_END, LC_TIME), LifecycleRequestError);
  });
  it("keeps independent profile journals separate and does not erase an earlier original request when another cookie context is selected", async () => {
    const saved = storage(), firstContext = lifecycleContext("donor"), first = await createLifecyclePending(preferences(), firstContext, LC_PROJECT_END, LC_TIME), org = await createLifecyclePending(program(), firstContext, LC_ORG_END, LC_TIME);
    saveLifecyclePending(saved, first); saveLifecyclePending(saved, org); assert.notEqual(lifecyclePendingStorageKey(first), lifecyclePendingStorageKey(org)); assert.equal(saved.values.size, 2);
    const other = lifecycleContext("donor"); other.project.scope = "e".repeat(64); assert.equal(lifecycleCurrentStorageKeys(other).includes(lifecyclePendingStorageKey(first)), false); assert.equal(lifecycleCurrentStorageKeys(other).includes(lifecyclePendingStorageKey(org)), true);
    assert.deepEqual(await readLifecyclePending(saved.getItem(lifecyclePendingStorageKey(first)), firstContext, LC_FIRST), first);
  });
  it("binds private schedule retry data to both original scopes without depending on project context for aggregate program changes", async () => {
    const context = lifecycleContext(), pending = await createLifecyclePending(schedule(), context, LC_PROJECT_END, LC_TIME); assert.equal(pending.domain, "dual");
    const other = lifecycleContext(); other.project.scope = "e".repeat(64); assert.equal(await readLifecyclePending(JSON.stringify(pending), other, LC_FIRST), null);
    const organizationOnly = await createLifecyclePending(program(), context, LC_ORG_END, LC_TIME); assert.deepEqual(await readLifecyclePending(JSON.stringify(organizationOnly), other, LC_FIRST), organizationOnly);
  });
  it("fails before dispatch when storage cannot retain the exact request and refuses overwriting another unresolved intent", async () => {
    const context = lifecycleContext("donor"), pending = await createLifecyclePending(preferences(), context, LC_PROJECT_END, LC_TIME), saved = storage();
    assert.throws(() => saveLifecyclePending({ ...saved, setItem() { throw new Error("quota"); } }, pending), error => error instanceof LifecycleRequestError && error.code === "LIFECYCLE_STORAGE_UNAVAILABLE");
    saveLifecyclePending(saved, pending); const another = preferences(); another.input.intentId = lcId(999); const next = await createLifecyclePending(another, context, LC_PROJECT_END, LC_TIME); assert.throws(() => saveLifecyclePending(saved, next), LifecycleRequestError); assert.equal(saved.getItem(lifecyclePendingStorageKey(pending)), JSON.stringify(pending));
  });
});
