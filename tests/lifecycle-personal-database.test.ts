import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import * as C from "../lib/lifecycle/contracts";
import { database, query } from "../lib/server/db";
import { lifecycleHash, lifecyclePrivateContext } from "../lib/server/lifecycle-core";
import { lifecycleInbox, lifecycleInboxDetail, lifecyclePersonalSourceDetail, lifecycleSetInboxState, lifecycleSetPreferences, observeLifecyclePersonal } from "../lib/server/lifecycle-personal";
import { openPrivate } from "../lib/server/private-values";
import { readOrganizationProjectAuthority } from "../lib/server/organization-projects";
import { code, dbNow, pause, payoutObservation, personalActor, personalCancellation, personalFingerprint, personalFixture, personalPayable, personalReceipt, preferenceInput, purposePledge, purposePolicy, type PersonalFixture } from "./helpers/lifecycle-personal";

async function items(f: Pick<PersonalFixture, "request">) { return (await lifecycleInbox(f.request)).inbox.items; }
async function freshScope(f: Pick<PersonalFixture, "request">) {
  const result = await database().transaction(tx => readOrganizationProjectAuthority(tx, f.request)); f.request.personalScope = result.scope; return result;
}
async function originalRows(f: PersonalFixture) {
  return query<{ id: string; encrypted_data: string; source_hash: string; snapshot_hash: string; content_hash: string; captured_at: Date; occurred_at: Date; expires_at: Date; version: number; read_state: string }>("SELECT * FROM fp_lifecycle_inbox WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND role=$4 ORDER BY id", [f.tenantId, f.projectId, f.session.actorId, f.session.role]);
}
async function drainObserver() {
  let before: string | undefined, created = 0;
  for (let page = 0; page < 100; page++) {
    const result = await observeLifecyclePersonal({ limit: 20, before }); created += result.created;
    if (!result.nextCursor) return created;
    before = result.nextCursor;
  }
  throw new Error("A bounded private observer sweep did not finish.");
}

describe("private personal lifecycle persistence and original authority", () => {
  it("requires the private test schema and performs no GET writes or implicit opt-in", async () => {
    const [{ own, paths }] = await query<{ own: string; paths: string[] }>("SELECT current_schema() own,current_schemas(false)::text[] paths");
    assert.match(own, /^lifecycle_personal_test_[a-f0-9]{32}$/); assert.deepEqual(paths, [own]);
    const f = await personalFixture(); await purposePledge(f);
    const before = await personalFingerprint(), one = await lifecycleInbox(f.request), two = await lifecycleInbox(f.request);
    C.lifecycleInboxSchema.parse(one.inbox); assert.equal(one.inbox.preferences.version, 0); assert.equal(one.inbox.preferences.enabled, false); assert.equal(one.inbox.preferences.emailPreviews, false); assert.deepEqual(one.inbox.items, []); assert.deepEqual(two.inbox.items, []);
    assert.deepEqual(one.inbox.preferences.categories, ["pledges", "contributions", "choices"]);
    await assert.rejects(lifecycleInboxDetail(f.request, randomUUID()), code("LIFECYCLE_RESOURCE_UNAVAILABLE"));
    assert.deepEqual(await personalFingerprint(), before);
    await assert.rejects(fetch("http://localhost:4612/api/lifecycle/inbox"), /permit no HTTP/);
  });
  it("stores an encrypted exact grant, materializes explicit current records, and keeps GETs read-only", async () => {
    const f = await personalFixture(), pledge = await purposePledge(f), input = preferenceInput(f), result = await lifecycleSetPreferences(f.request, input);
    C.lifecycleReceiptSchema.parse(result.receipt); assert.equal(result.receipt.kind, "preferences"); assert.equal(result.receipt.resourceVersion, 1);
    const [row] = await query<{ id: string; encrypted_grant: string; content_hash: string; expires_at: Date; session_id: string; membership_version: number }>("SELECT v.* FROM fp_lifecycle_preference_versions v JOIN fp_lifecycle_preference_heads h ON h.id=v.head_id WHERE h.tenant_id=$1", [f.tenantId]);
    assert(!row.encrypted_grant.includes(f.token)); const grant = openPrivate<{ projectToken: string; sessionId: string; scope: string; expiresAt: string }>(row.encrypted_grant, lifecyclePrivateContext("preference", row.id));
    assert.equal(grant.projectToken, f.token); assert.equal(grant.sessionId, f.session.id); assert.equal(grant.scope, f.request.personalScope); assert.equal(grant.expiresAt, f.session.expiresAt); assert.equal(row.expires_at.toISOString(), f.session.expiresAt); assert.equal(row.membership_version, 1);
    const before = await personalFingerprint(), inbox = await lifecycleInbox(f.request); assert.equal(inbox.inbox.items.length, 1); const item = inbox.inbox.items[0];
    assert.equal(item.kind, "pledge_saved"); assert.equal(item.readState, "unread"); assert.equal(item.occurredAt, pledge.value.acceptedAt);
    const detail = await lifecycleInboxDetail(f.request, item.id); C.lifecycleInboxDetailSchema.parse(detail.detail);
    assert(detail.detail.content); assert.equal(detail.detail.emailPreview?.destination, null); assert.equal(detail.detail.emailPreview?.sent, false); assert.equal(detail.detail.emailPreview?.mode, "preview_only");
    const source = await lifecyclePersonalSourceDetail(f.request, item.id, detail.detail.sources[0].id); C.lifecycleSourceDetailSchema.parse(source.detail);
    const serialized = JSON.stringify({ inbox, detail, source }); for (const value of [f.token, f.session.id, f.session.actorId, pledge.value.id, pledge.value.obligationId]) assert(!serialized.includes(value), `A private original identifier escaped: ${value}`);
    assert.deepEqual(await personalFingerprint(), before);
  });
  it("recovers a lost response with its original payload without capturing a later source or renewing a deadline", async () => {
    const f = await personalFixture(), policy = await purposePolicy(f); await purposePledge(f, { policy });
    const input = preferenceInput(f), first = await lifecycleSetPreferences(f.request, input), rows = await originalRows(f);
    await purposePledge(f, { policy }); const again = await lifecycleSetPreferences(f.request, structuredClone(input)); assert.deepEqual(again, first); assert.deepEqual(await originalRows(f), rows);
    await assert.rejects(lifecycleSetPreferences(f.request, { ...input, emailPreviews: false }), code("LIFECYCLE_INTENT_CHANGED"));
    assert.equal((await items(f)).length, 1); await drainObserver(); assert.equal((await items(f)).length, 2);
    const retained = (await originalRows(f)).find(row => row.id === rows[0].id)!; assert.equal(retained.encrypted_data, rows[0].encrypted_data); assert.equal(retained.content_hash, rows[0].content_hash); assert.equal(retained.snapshot_hash, rows[0].snapshot_hash); assert.deepEqual(retained.captured_at, rows[0].captured_at); assert.equal(retained.expires_at.toISOString(), f.session.expiresAt);
  });
  it("serializes identical concurrent preference intents into one version and one event", async () => {
    const f = await personalFixture(); await purposePledge(f); const input = preferenceInput(f);
    const [first, second] = await Promise.all([lifecycleSetPreferences(f.request, input), lifecycleSetPreferences(f.request, structuredClone(input))]); assert.deepEqual(first, second);
    const [counts] = await query<{ versions: string; commands: string; inbox: string }>("SELECT (SELECT count(*) FROM fp_lifecycle_preference_versions v JOIN fp_lifecycle_preference_heads h ON h.id=v.head_id WHERE h.tenant_id=$1) versions,(SELECT count(*) FROM fp_lifecycle_commands WHERE result->>'resourceId'=$2) commands,(SELECT count(*) FROM fp_lifecycle_inbox WHERE tenant_id=$1) inbox", [f.tenantId, first.receipt.resourceId]);
    assert.deepEqual(counts, { versions: "1", commands: "1", inbox: "1" });
  });
  it("enforces role-specific categories and rejects organizer opt-in, forged roles and missing scope headers", async () => {
    const donor = await personalFixture(), volunteer = await personalFixture({ role: "volunteer" }), organizer = await personalFixture({ role: "organizer" });
    await assert.rejects(lifecycleSetPreferences(donor.request, preferenceInput(donor, { categories: ["repayments"] })), code("INVALID_INPUT"));
    await assert.rejects(lifecycleSetPreferences(volunteer.request, preferenceInput(volunteer, { categories: ["pledges"] })), code("INVALID_INPUT"));
    await assert.rejects(lifecycleSetPreferences(organizer.request, preferenceInput(organizer)), error => code("LIFECYCLE_AUTH_REQUIRED")(error) && (error as { status: number }).status === 403);
    await assert.rejects(lifecycleSetPreferences(donor.request, { ...preferenceInput(donor), actorId: "another actor", role: "volunteer" }));
    await assert.rejects(lifecycleSetPreferences({ ...donor.request, personalScope: undefined }, preferenceInput(donor)), code("LIFECYCLE_PROJECT_CHANGED"));
    assert.deepEqual((await lifecycleInbox(volunteer.request)).inbox.preferences.categories, ["repayments"]);
  });
  it("never exposes another recipient, project or role through item/source IDs or a state command", async () => {
    const f = await personalFixture({ roles: ["donor", "volunteer"] }); await purposePledge(f); await lifecycleSetPreferences(f.request, preferenceInput(f)); const own = (await items(f))[0];
    const other = await personalActor(f, "donor"), volunteer = await personalActor(f, "volunteer", { actorId: f.session.actorId }), project = await personalFixture();
    for (const request of [other.request, volunteer.request, project.request]) {
      assert.deepEqual((await lifecycleInbox(request)).inbox.items, []);
      await assert.rejects(lifecycleInboxDetail(request, own.id), code("LIFECYCLE_RESOURCE_UNAVAILABLE"));
      await assert.rejects(lifecyclePersonalSourceDetail(request, own.id, "event:unknown"), code("LIFECYCLE_RESOURCE_UNAVAILABLE"));
      await assert.rejects(lifecycleSetInboxState(request, own.id, { intentId: randomUUID(), expectedScope: request.personalScope, expectedVersion: own.version, contentHash: own.contentHash, action: "archive", acknowledged: true }), code("LIFECYCLE_RESOURCE_UNAVAILABLE"));
    }
    await assert.rejects(lifecycleInbox({ ...other.request, personalScope: f.request.personalScope }), code("LIFECYCLE_PROJECT_CHANGED"));
  });
  it("does not transfer an old preference grant or private body to a new session for the same member", async () => {
    const f = await personalFixture(); await purposePledge(f); await lifecycleSetPreferences(f.request, preferenceInput(f)); const old = (await items(f))[0], original = await originalRows(f);
    const next = await personalActor(f, "donor", { actorId: f.session.actorId }), view = await lifecycleInbox(next.request);
    assert.equal(view.inbox.preferences.status, "authority_changed"); assert.equal(view.inbox.preferences.enabled, false); assert.equal(view.inbox.items[0].status, "unavailable"); assert.equal(view.inbox.items[0].title, null);
    const detail = (await lifecycleInboxDetail(next.request, old.id)).detail; assert.equal(detail.content, null); assert.deepEqual(detail.sources, []); assert.equal(detail.emailPreview, null);
    await assert.rejects(lifecycleSetInboxState(next.request, old.id, { intentId: randomUUID(), expectedScope: next.request.personalScope, expectedVersion: old.version, contentHash: null, action: "read", acknowledged: true }), code("LIFECYCLE_AUTHORITY_ENDED"));
    await lifecycleSetPreferences(next.request, preferenceInput({ ...f, ...next }, { expectedVersion: 1 })); assert.deepEqual(await originalRows(f), original); assert.equal((await lifecycleInbox(next.request)).inbox.items[0].contentHash, null);
  });
  it("invalidates old grants and bodies after a member version or current role changes", async () => {
    const f = await personalFixture({ roles: ["donor", "volunteer"] }); await purposePledge(f); await lifecycleSetPreferences(f.request, preferenceInput(f)); const original = (await items(f))[0];
    await query("UPDATE fp_memberships SET version=version+1 WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [f.tenantId, f.projectId, f.session.actorId]);
    await assert.rejects(lifecycleInbox(f.request), code("LIFECYCLE_PROJECT_CHANGED")); await freshScope(f);
    const changed = await lifecycleInbox(f.request); assert.equal(changed.inbox.preferences.status, "authority_changed"); assert.equal((await lifecycleInboxDetail(f.request, original.id)).detail.content, null);
    await drainObserver(); assert.equal((await originalRows(f)).length, 1);
    await query("UPDATE fp_sessions SET role='volunteer' WHERE id=$1", [f.session.id]); await freshScope(f);
    assert.deepEqual((await lifecycleInbox(f.request)).inbox.items, []); assert.equal((await lifecycleInbox(f.request)).inbox.preferences.enabled, false);
    await assert.rejects(lifecycleInboxDetail(f.request, original.id), code("LIFECYCLE_RESOURCE_UNAVAILABLE"));
  });
  it("keeps original event times for future-only opt-in and never uses later observation time as a transition", async () => {
    const f = await personalFixture(), policy = await purposePolicy(f), oldAt = new Date((await dbNow()).getTime() - 60_000).toISOString();
    const input = preferenceInput(f, { history: "future_only" }); await lifecycleSetPreferences(f.request, input);
    await purposePledge(f, { policy, acceptedAt: oldAt, createdAt: (await dbNow()).toISOString() });
    await drainObserver(); assert.equal((await items(f)).length, 0);
    const current = await purposePledge(f, { policy }); await drainObserver(); const captured = await items(f); assert.equal(captured.length, 1); assert.equal(captured[0].occurredAt, current.value.acceptedAt);
    const future = new Date((await dbNow()).getTime() + 60_000).toISOString(); await purposePledge(f, { policy, acceptedAt: future, createdAt: (await dbNow()).toISOString() }); await drainObserver(); assert.equal((await items(f)).length, 1);
    const [row] = await query<{ opted_in_at: Date; expires_at: Date }>("SELECT v.* FROM fp_lifecycle_preference_versions v JOIN fp_lifecycle_preference_heads h ON h.id=v.head_id WHERE h.tenant_id=$1", [f.tenantId]); assert(row.opted_in_at.getTime() < Date.parse(current.value.acceptedAt)); assert.equal(row.expires_at.toISOString(), f.session.expiresAt);
  });
  it("preserves earlier private history on opt-out and never duplicates an original transition on re-enable", async () => {
    const f = await personalFixture(), policy = await purposePolicy(f); await purposePledge(f, { policy }); await lifecycleSetPreferences(f.request, preferenceInput(f));
    const first = (await items(f))[0], original = (await originalRows(f))[0];
    await lifecycleSetPreferences(f.request, preferenceInput(f, { expectedVersion: 1, enabled: false, emailPreviews: false }));
    await purposePledge(f, { policy }); await drainObserver(); assert.equal((await items(f)).length, 1); assert.equal((await lifecycleInboxDetail(f.request, first.id)).detail.item.status, "historical");
    await lifecycleSetPreferences(f.request, preferenceInput(f, { expectedVersion: 2 })); assert.equal((await items(f)).length, 2); await drainObserver(); assert.equal((await items(f)).length, 2);
    assert.equal((await originalRows(f)).find(row => row.id === first.id)!.encrypted_data, original.encrypted_data);
  });
  it("persists versioned read/archive decisions and original-intent receipts without rewriting content", async () => {
    const f = await personalFixture(); await purposePledge(f); await lifecycleSetPreferences(f.request, preferenceInput(f)); const item = (await items(f))[0], original = (await originalRows(f))[0];
    const read = { intentId: randomUUID(), expectedScope: f.request.personalScope!, expectedVersion: item.version, contentHash: item.contentHash, action: "read" as const, acknowledged: true as const };
    const receipt = await lifecycleSetInboxState(f.request, item.id, read); assert.equal(receipt.receipt.resourceVersion, 2); assert.deepEqual(await lifecycleSetInboxState(f.request, item.id, read), receipt);
    await assert.rejects(lifecycleSetInboxState(f.request, item.id, { ...read, action: "archive" }), code("LIFECYCLE_INTENT_CHANGED"));
    await assert.rejects(lifecycleSetInboxState(f.request, item.id, { ...read, intentId: randomUUID() }), code("LIFECYCLE_VERSION_CHANGED"));
    const archived = await lifecycleSetInboxState(f.request, item.id, { ...read, intentId: randomUUID(), expectedVersion: 2, action: "archive" }); assert.equal(archived.receipt.resourceVersion, 3);
    const activePage = (await lifecycleInbox(f.request)).inbox, archivedPage = (await lifecycleInbox(f.request, { state: "archived" })).inbox;
    assert.equal(activePage.filter, null); assert.equal(activePage.items.length, 0); assert.equal(activePage.nextCursor, null); assert.deepEqual(activePage.counts, { unread: 0, read: 0, archived: 1 });
    assert.deepEqual(archivedPage.items.map(row => row.id), [item.id]); assert.equal(archivedPage.items[0].readState, "archived");
    const restored = await lifecycleSetInboxState(f.request, item.id, { ...read, intentId: randomUUID(), expectedVersion: 3, action: "unarchive" }); assert.equal(restored.receipt.resourceVersion, 4); assert.equal((await items(f))[0].readState, "read");
    assert.equal((await lifecycleInbox(f.request, { state: "archived" })).inbox.items.length, 0);
    const [events] = await query<{ count: string }>("SELECT count(*) count FROM fp_lifecycle_inbox_events WHERE inbox_id=$1", [item.id]); assert.equal(events.count, "3");
    const row = (await originalRows(f))[0]; assert.equal(row.encrypted_data, original.encrypted_data); assert.equal(row.source_hash, original.source_hash); assert.equal(row.snapshot_hash, original.snapshot_hash); assert.equal(row.content_hash, original.content_hash); assert.deepEqual(row.captured_at, original.captured_at);
  });
  it("restores an unread archived item as unread and binds pagination to the exact profile and filter", async () => {
    const f = await personalFixture(), policy = await purposePolicy(f); for (let i = 0; i < 25; i++) await purposePledge(f, { policy }); await lifecycleSetPreferences(f.request, preferenceInput(f));
    const first = (await lifecycleInbox(f.request)).inbox; assert.equal(first.items.length, 20); assert(first.nextCursor); assert.equal(first.counts.unread, 25);
    const second = (await lifecycleInbox(f.request, { before: first.nextCursor })).inbox; assert.equal(second.items.length, 5); assert.equal(second.nextCursor, null); assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 25);
    assert.deepEqual((await lifecycleInbox(f.request, { before: first.nextCursor })).inbox.items, second.items);
    await assert.rejects(lifecycleInbox(f.request, { state: "archived", before: first.nextCursor }), code("INVALID_INPUT"));
    const other = await personalFixture(); await assert.rejects(lifecycleInbox(other.request, { before: first.nextCursor }), code("INVALID_INPUT"));
    const item = first.items[0], base = { expectedScope: f.request.personalScope!, contentHash: item.contentHash, acknowledged: true as const };
    await lifecycleSetInboxState(f.request, item.id, { ...base, intentId: randomUUID(), expectedVersion: 1, action: "archive" }); await lifecycleSetInboxState(f.request, item.id, { ...base, intentId: randomUUID(), expectedVersion: 2, action: "unarchive" });
    assert.equal((await lifecycleInboxDetail(f.request, item.id)).detail.item.readState, "unread");
  });
  it("resumes bounded observer source pages without starving a long original history", async () => {
    const f = await personalFixture(), policy = await purposePolicy(f), [{ at }] = await query<{ at: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') at");
    for (let i = 0; i < 135; i++) await purposePledge(f, { policy, createdAt: at });
    await lifecycleSetPreferences(f.request, preferenceInput(f)); assert.equal((await originalRows(f)).length, 100);
    const first = await observeLifecyclePersonal({ limit: 1 }); assert.equal(first.checked, 1); assert.equal(first.created, 0); assert(first.nextCursor);
    const second = await observeLifecyclePersonal({ limit: 1, before: first.nextCursor }); assert.equal(second.checked, 1); assert.equal(second.created, 35); assert.equal((await originalRows(f)).length, 135);
    await drainObserver(); assert.equal((await originalRows(f)).length, 135);
    await assert.rejects(observeLifecyclePersonal({ limit: 21 }));
  });
  it("honors natural original expiry and does not write a renewal after a lock wait crosses the deadline", async () => {
    const f = await personalFixture({ expiresMs: 700 }); await lifecycleSetPreferences(f.request, preferenceInput(f, { history: "future_only" }));
    const [head] = await query<{ id: string }>("SELECT id FROM fp_lifecycle_preference_heads WHERE tenant_id=$1", [f.tenantId]);
    let release!: () => void, acquired!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { acquired = resolve; });
    const lock = database().transaction(async tx => { await tx.query("SELECT id FROM fp_lifecycle_preference_heads WHERE id=$1 FOR UPDATE", [head.id]); acquired(); await gate; }); await ready;
    const waiting = assert.rejects(lifecycleSetPreferences(f.request, preferenceInput(f, { expectedVersion: 1, history: "future_only", emailPreviews: false })), error => code("LIFECYCLE_AUTHORITY_ENDED")(error) && (error as { status: number }).status === 410);
    await pause(Math.max(1, Date.parse(f.session.expiresAt) - (await dbNow()).getTime() + 40)); release(); await lock; await waiting;
    const [counts] = await query<{ version: number; versions: string; expires_at: Date }>("SELECT h.version,v.expires_at,(SELECT count(*) FROM fp_lifecycle_preference_versions p WHERE p.head_id=h.id) versions FROM fp_lifecycle_preference_heads h JOIN fp_lifecycle_preference_versions v ON v.id=h.current_version_id WHERE h.id=$1", [head.id]); assert.equal(counts.version, 1); assert.equal(counts.versions, "1"); assert.equal(counts.expires_at.toISOString(), f.session.expiresAt);
    await assert.rejects(lifecycleInbox(f.request), code("LIFECYCLE_AUTHORITY_ENDED")); await drainObserver();
  });
});

describe("truthful original personal source adapters", () => {
  it("separates original gross, current retained support, returns and a donor-owned committed move", async () => {
    const f = await personalFixture(), pledge = await purposePledge(f), receipt = await personalReceipt(f, pledge, { returnedMinor: 200 }); await personalCancellation(f, pledge, receipt, { minor: 300 }); await lifecycleSetPreferences(f.request, preferenceInput(f));
    const all = await items(f); assert(all.some(item => item.kind === "purpose_cancelled")); const collected = all.find(item => item.kind === "contribution_collected")!, moved = all.find(item => item.kind === "contribution_moved")!; assert(collected && moved);
    const detail = (await lifecycleInboxDetail(f.request, collected.id)).detail, money = (label: string) => detail.sources.find(row => row.label === label)?.value;
    assert.deepEqual(money("Original gross payment"), { kind: "money", currency: "USD", minor: 500 }); assert.deepEqual(money("Retained support across its recorded purposes"), { kind: "money", currency: "USD", minor: 300 }); assert.deepEqual(money("Completed attributed returns"), { kind: "money", currency: "USD", minor: 200 });
    const movement = (await lifecycleInboxDetail(f.request, moved.id)).detail; assert(movement.sources.some(row => row.value.kind === "label" && row.value.value === "Watering supplies")); assert(movement.sources.some(row => row.label === "Original event amount" && row.value.kind === "money" && row.value.minor === 300));
    assert(detail.content?.notices.some(value => value.includes("does not establish an available balance"))); assert.equal(detail.item.provenance, "sample");
    const serialized = JSON.stringify({ detail, movement }); for (const value of [receipt.id, receipt.actualProviderPaymentRef, receipt.sourceOrderId!, pledge.value.id]) assert(!serialized.includes(value));
  });
  it("does not treat a case default or a merely accepted choice as the donor's completed move", async () => {
    for (const options of [{ authority: "case_default" as const }, { executed: false }]) {
      const f = await personalFixture(), pledge = await purposePledge(f), receipt = await personalReceipt(f, pledge); await personalCancellation(f, pledge, receipt, options); await lifecycleSetPreferences(f.request, preferenceInput(f)); assert(!(await items(f)).some(item => item.kind === "contribution_moved"));
    }
  });
  it("requires retained matching provider evidence for live COMPLETED contribution facts", async () => {
    const unproved = await personalFixture({ mode: "live_sandbox" }), pledge = await purposePledge(unproved); await personalReceipt(unproved, pledge); await lifecycleSetPreferences(unproved.request, preferenceInput(unproved)); assert(!(await items(unproved)).some(item => item.kind === "contribution_collected"));
    const proved = await personalFixture({ mode: "live_sandbox" }), original = await purposePledge(proved); const receipt = await personalReceipt(proved, original, { proof: true }); await lifecycleSetPreferences(proved.request, preferenceInput(proved));
    const completed = (await items(proved)).find(item => item.kind === "contribution_collected")!; assert(completed); assert.equal(completed.provenance, "live_sandbox"); const detail = await lifecycleInboxDetail(proved.request, completed.id); assert(!JSON.stringify(detail).includes(receipt.actualProviderPaymentRef)); assert(!JSON.stringify(detail).includes("PRIVATE-PROVIDER")); assert(!JSON.stringify(detail).includes("PRIVATE-TOKEN"));
  });
  it("labels replay records explicitly and rejects incomplete amounts instead of inventing zero", async () => {
    const replay = await personalFixture(), pledge = await purposePledge(replay); await personalReceipt(replay, pledge, { provenance: "replay" }); await lifecycleSetPreferences(replay.request, preferenceInput(replay));
    const item = (await items(replay)).find(item => item.kind === "contribution_collected")!; assert.equal(item.provenance, "replay"); const detail = (await lifecycleInboxDetail(replay.request, item.id)).detail; assert(detail.content?.notices.some(value => value.startsWith("Replay")));
    const missing = await personalFixture(), p = await purposePledge(missing), receipt = await personalReceipt(missing, p); await query("UPDATE fp_settlement_receipts SET data=data-'grossSettledMinor' WHERE id=$1", [receipt.id]); await lifecycleSetPreferences(missing.request, preferenceInput(missing)); assert(!(await items(missing)).some(value => value.kind === "contribution_collected"));
  });
  it("uses saved withdrawal actions and original expiry timestamps rather than poll time", async () => {
    const f = await personalFixture(), old = new Date((await dbNow()).getTime() - 60_000).toISOString(), deadline = new Date(Date.parse(old) + 30_000).toISOString(), expired = await purposePledge(f, { acceptedAt: old, expiresAt: deadline, state: "expired" }), withdrawn = await purposePledge(f, { policy: expired.policy, state: "withdrawn" });
    const withdrawalAt = (await dbNow()).toISOString(); await query("INSERT INTO fp_funding_actions(tenant_id,project_id,actor_id,intent_id,kind,input_hash,result,created_at) VALUES($1,$2,$3,$4,'withdraw_pledge',$5,$6::jsonb,$7)", [f.tenantId, f.projectId, f.session.actorId, randomUUID(), "a".repeat(64), JSON.stringify({ id: withdrawn.value.id }), withdrawalAt]);
    await lifecycleSetPreferences(f.request, preferenceInput(f)); const all = await items(f); assert.equal(all.find(item => item.kind === "pledge_expired")?.occurredAt, deadline); assert.equal(all.find(item => item.kind === "pledge_withdrawn")?.occurredAt, withdrawalAt);
    const before = await originalRows(f); await drainObserver(); assert.deepEqual(await originalRows(f), before);
  });
  it("does not turn an approval, dispatch, batch label or unsupported item into a completed repayment", async () => {
    const approval = await personalFixture({ mode: "live_sandbox", role: "volunteer" }); await personalPayable(approval, { dispatched: false, state: "succeeded", paid: false }); await lifecycleSetPreferences(approval.request, preferenceInput(approval)); assert.equal((await items(approval)).length, 0);
    const flag = await personalFixture({ mode: "live_sandbox", role: "volunteer" }); await personalPayable(flag, { paid: true, state: "succeeded" }); await lifecycleSetPreferences(flag.request, preferenceInput(flag)); assert.equal((await items(flag)).length, 0);
    const wrong = await personalFixture({ mode: "live_sandbox", role: "volunteer" }), payable = await personalPayable(wrong, { paid: true }); await payoutObservation(wrong, payable, { receiver: "CROSSED-RECIPIENT", minor: 499 }); await payoutObservation(wrong, payable, { kind: "batch_read", status: "SUCCESS" }); await lifecycleSetPreferences(wrong.request, preferenceInput(wrong)); assert(!(await items(wrong)).some(item => item.kind === "repayment_completed"));
  });
  it("keeps uncertain repayment results separate from definite failure and deduplicates repeated polls", async () => {
    const f = await personalFixture({ mode: "live_sandbox", role: "volunteer" }), payable = await personalPayable(f, { state: "unknown" }); await payoutObservation(f, payable, { kind: "create", outcome: "unknown" }); await lifecycleSetPreferences(f.request, preferenceInput(f));
    assert((await items(f)).some(item => item.kind === "repayment_unknown")); assert(!(await items(f)).some(item => item.kind === "repayment_failed"));
    const count = (await originalRows(f)).length; await payoutObservation(f, payable, { kind: "create", outcome: "unknown" }); await drainObserver(); assert.equal((await originalRows(f)).length, count);
    const failed = await personalFixture({ mode: "live_sandbox", role: "volunteer" }), original = await personalPayable(failed, { state: "refused" }); await payoutObservation(failed, original, { kind: "create", outcome: "refused" }); await lifecycleSetPreferences(failed.request, preferenceInput(failed)); assert((await items(failed)).some(item => item.kind === "repayment_failed")); assert(!(await items(failed)).some(item => item.kind === "repayment_completed"));
  });
  it("exposes only the claimant's actual matching repayment item and a private unsent preview", async () => {
    const f = await personalFixture({ mode: "live_sandbox", role: "volunteer" }), payable = await personalPayable(f, { paid: true, observation: true }); await lifecycleSetPreferences(f.request, preferenceInput(f));
    const all = await items(f); assert.equal(all.length, 1); assert.equal(all[0].kind, "repayment_completed"); const detail = (await lifecycleInboxDetail(f.request, all[0].id)).detail; assert.equal(detail.item.occurredAt, payable.originalAt); assert(detail.content); assert.equal(detail.emailPreview?.sent, false); assert.equal(detail.emailPreview?.destination, null);
    const serialized = JSON.stringify(detail); for (const value of [payable.id, payable.documentId, payable.claimId, payable.item.batchId, payable.item.id, payable.item.receiver, "PRIVATE-CLAIM-CANARY", "PRIVATE-RECEIPT-CANARY", "PRIVATE-OBSERVATION-DEBUG", "PRIVATE-STORAGE"]) assert(!serialized.includes(value));
    const organizer = await personalActor(f, "organizer"); await assert.rejects(lifecycleInboxDetail(organizer.request, all[0].id), code("LIFECYCLE_AUTH_REQUIRED"));
    const another = await personalActor(f, "volunteer"); await assert.rejects(lifecycleInboxDetail(another.request, all[0].id), code("LIFECYCLE_RESOURCE_UNAVAILABLE"));
  });
  it("withholds captured body, sources and email preview after source withdrawal while retaining scoped metadata", async () => {
    const f = await personalFixture({ mode: "live_sandbox", role: "volunteer" }), payable = await personalPayable(f, { paid: true, observation: true }); await lifecycleSetPreferences(f.request, preferenceInput(f)); const item = (await items(f))[0], original = await lifecycleInboxDetail(f.request, item.id), sourceId = original.detail.sources[0].id;
    await query("INSERT INTO fp_plan_source_controls(document_id,tenant_id,project_id,classification,permission) VALUES($1,$2,$3,'source','withdrawn')", [payable.documentId, f.tenantId, f.projectId]);
    const before = await personalFingerprint(), hidden = (await lifecycleInboxDetail(f.request, item.id)).detail; assert.equal(hidden.item.status, "withdrawn"); assert.equal(hidden.item.kind, null); assert.equal(hidden.item.title, null); assert.equal(hidden.item.contentHash, null); assert.equal(hidden.content, null); assert.deepEqual(hidden.sources, []); assert.equal(hidden.emailPreview, null);
    await assert.rejects(lifecyclePersonalSourceDetail(f.request, item.id, sourceId), error => code("LIFECYCLE_SOURCE_WITHDRAWN")(error) && (error as { status: number }).status === 410); assert.deepEqual(await personalFingerprint(), before);
    await query("UPDATE fp_plan_source_controls SET permission='allowed',version=version+1 WHERE document_id=$1", [payable.documentId]); assert.equal((await lifecycleInboxDetail(f.request, item.id)).detail.content, null);
    const row = (await originalRows(f))[0]; assert.equal(row.content_hash, item.contentHash); assert.equal(row.version, 1);
  });
  it("retains a prior pending item as immutable historical content after an actual later outcome", async () => {
    const f = await personalFixture({ mode: "live_sandbox", role: "volunteer" }), payable = await personalPayable(f, { state: "pending" }); await lifecycleSetPreferences(f.request, preferenceInput(f)); const pending = (await items(f)).find(item => item.kind === "repayment_pending")!, original = (await originalRows(f)).find(row => row.id === pending.id)!;
    const now = (await dbNow()).toISOString(); await query("UPDATE fp_payables SET state='succeeded',principal_paid_at=$2 WHERE id=$1", [payable.id, now]); payable.item.status = "SUCCESS"; payable.item.transactionId = "PRIVATE-LATER-TRANSACTION"; await payoutObservation(f, payable, { observedAt: now }); await drainObserver();
    const detail = (await lifecycleInboxDetail(f.request, pending.id)).detail; assert.equal(detail.item.status, "historical"); assert.equal(detail.content?.contentHash, original.content_hash); assert.equal((await originalRows(f)).find(row => row.id === pending.id)!.encrypted_data, original.encrypted_data); assert((await items(f)).some(item => item.kind === "repayment_completed"));
  });
});
