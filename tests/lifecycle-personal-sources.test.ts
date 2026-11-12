import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { database, query } from "../lib/server/db";
import { lifecycleInbox, lifecycleInboxDetail, lifecyclePersonalTransaction, lifecycleSetInboxState, lifecycleSetPreferences, observeLifecyclePersonal, observeLifecyclePersonalGrant } from "../lib/server/lifecycle-personal";
import { lifecycleHash, lifecyclePrivateContext, type LifecyclePersonalGrant, type LifecyclePreferenceRow } from "../lib/server/lifecycle-core";
import { openPrivate, sealPrivate } from "../lib/server/private-values";
import { code, dbNow, pause, payoutObservation, personalActor, personalCancellation, personalConditional, personalExternalReturn, personalFingerprint, personalFixture, personalInvoice, personalPayable, personalReceipt, personalRefund, preferenceInput, purposePledge, type PersonalFixture } from "./helpers/lifecycle-personal";

const items = async (f: Pick<PersonalFixture, "request">) => (await lifecycleInbox(f.request)).inbox.items;
describe("original financial rails and retained source boundaries", () => {
  it("adapts original conditional consent and legacy package cancellation only to its donor", async () => {
    const f = await personalFixture({ mode: "live_sandbox" }), original = await personalConditional(f, true); await lifecycleSetPreferences(f.request, preferenceInput(f));
    const all = await items(f); assert.equal(all.filter(item => item.kind === "pledge_saved").length, 1); assert.equal(all.filter(item => item.kind === "purpose_cancelled").length, 1); assert.equal(all.find(item => item.kind === "purpose_cancelled")!.occurredAt, original.at);
    const detail = (await lifecycleInboxDetail(f.request, all.find(item => item.kind === "pledge_saved")!.id)).detail; assert(detail.sources.some(row => row.value.kind === "money" && row.value.minor === original.policy.amountMinor)); assert(!JSON.stringify(detail).includes(original.id));
    const other = await personalActor(f, "donor"); await lifecycleSetPreferences(other.request, preferenceInput({ ...f, ...other })); assert.deepEqual((await lifecycleInbox(other.request)).inbox.items, []);
  });
  it("requires an invoice's independently corroborated payment resource, including the original invoice-number alias", async () => {
    for (const options of [{}, { proof: true, wrongParent: true }, { proof: true }, { proof: true, aliasNumber: true }]) {
      const f = await personalFixture({ mode: "live_sandbox" }), original = await personalConditional(f), invoice = await personalInvoice(f, original, options); await lifecycleSetPreferences(f.request, preferenceInput(f));
      const completed = (await items(f)).find(item => item.kind === "contribution_collected"); assert.equal(!!completed, !!options.proof && !options.wrongParent, JSON.stringify(options));
      if (completed) { const detail = await lifecycleInboxDetail(f.request, completed.id); for (const value of [invoice.providerId, invoice.invoiceNumber, invoice.receipt.actualProviderPaymentRef]) assert(!JSON.stringify(detail).includes(value)); }
    }
  });
  it("follows the donor's original receipt into a later cancellation of its reviewed destination", async () => {
    const f = await personalFixture(), pledge = await purposePledge(f), receipt = await personalReceipt(f, pledge), moved = await personalCancellation(f, pledge, receipt), id = randomUUID(), at = (await dbNow()).toISOString();
    const next = { ...moved.value, id, packageId: "water", title: "Watering supplies", purpose: "Controlled destination cancellation", approvedAt: at, sources: moved.value.sources.map(source => ({ ...source, assignmentIds: [moved.assignmentId] })), roundIds: [moved.choice.destination!.roundId] };
    await query("INSERT INTO fp_funding_cases(id,tenant_id,project_id,package_id,package_version,state,digest,encrypted_data,deadline,created_by,membership_version,created_at) VALUES($1,$2,$3,'water',1,'choice_open',$4,$5,$6,$7,1,$8)", [id, f.tenantId, f.projectId, lifecycleHash(next), sealPrivate(next, `funding-case:${f.tenantId}:${f.projectId}:${id}`), next.deadline, f.session.actorId, at]);
    await lifecycleSetPreferences(f.request, preferenceInput(f)); const cancellations = (await items(f)).filter(item => item.kind === "purpose_cancelled"); assert.equal(cancellations.length, 2);
    const details = await Promise.all(cancellations.map(item => lifecycleInboxDetail(f.request, item.id))); assert(details.some(value => value.detail.sources.some(source => source.value.kind === "label" && source.value.value === "Watering supplies")));
  });
  it("notifies an affected unpaid pledge without exposing the cancellation's other donors", async () => {
    const f = await personalFixture(), own = await purposePledge(f), another = { ...f, ...await personalActor(f, "donor") }, paid = await purposePledge(another, { policy: own.policy }), receipt = await personalReceipt(another, paid); await personalCancellation(another, paid, receipt, { executed: false });
    await query("UPDATE fp_purpose_pledges SET state='cancelled' WHERE id=$1", [own.value.id]); await lifecycleSetPreferences(f.request, preferenceInput(f, { categories: ["choices"] }));
    const all = await items(f); assert.equal(all.length, 1); assert.equal(all[0].kind, "purpose_cancelled"); const detail = await lifecycleInboxDetail(f.request, all[0].id); for (const value of [another.session.actorId, receipt.id, paid.value.id]) assert(!JSON.stringify(detail).includes(value));
  });
  it("separates an actual pending return from a completed original-route return and verifies the parent capture", async () => {
    for (const options of [{}, { completed: true }, { completed: true, proof: true, wrongParent: true }, { completed: true, proof: true }, { completed: true, proof: true, linkedParent: true }]) {
      const f = await personalFixture({ mode: "live_sandbox" }), pledge = await purposePledge(f), receipt = await personalReceipt(f, pledge, { proof: true }), refund = await personalRefund(f, receipt, options); await lifecycleSetPreferences(f.request, preferenceInput(f));
      const all = await items(f), completed = all.find(item => item.kind === "contribution_returned"), pending = all.find(item => item.kind === "contribution_return_pending");
      assert.equal(!!pending, !options.completed); assert.equal(!!completed, !!options.completed && !!options.proof && !options.wrongParent);
      const item = completed ?? pending;
      if (item) { assert.equal(item.occurredAt, refund.at); const detail = (await lifecycleInboxDetail(f.request, item.id)).detail; assert(detail.sources.some(row => row.label === "Original event amount" && row.value.kind === "money" && row.value.minor === refund.minor)); assert(!JSON.stringify(detail).includes(refund.providerId)); }
    }
  });
  it("requires exact outside-return observation and attribution and retains its original record time", async () => {
    const f = await personalFixture({ mode: "live_sandbox" }), pledge = await purposePledge(f), receipt = await personalReceipt(f, pledge, { proof: true }), earlier = new Date((await dbNow()).getTime() - 30_000).toISOString(), outside = await personalExternalReturn(f, receipt, { observedAt: earlier }); await lifecycleSetPreferences(f.request, preferenceInput(f));
    const returned = (await items(f)).find(item => item.kind === "contribution_returned")!; assert(returned); assert.equal(returned.occurredAt, outside.at); assert.notEqual(returned.occurredAt, earlier);
    const detail = (await lifecycleInboxDetail(f.request, returned.id)).detail; assert(detail.content?.notices.some(value => value.includes("provider refund creation time is unavailable"))); assert(!JSON.stringify(detail).includes(outside.id)); assert(!JSON.stringify(detail).includes(outside.observation.id));
    const unconfirmed = await personalFixture({ mode: "live_sandbox" }), p = await purposePledge(unconfirmed), r = await personalReceipt(unconfirmed, p, { proof: true }); await personalExternalReturn(unconfirmed, r, { status: "PENDING" }); await lifecycleSetPreferences(unconfirmed.request, preferenceInput(unconfirmed)); assert(!(await items(unconfirmed)).some(item => item.kind === "contribution_returned"));
  });
  it("does not use a later outside-return observation to relabel an old recorded transition as future-only", async () => {
    const f = await personalFixture({ mode: "live_sandbox" }), old = new Date((await dbNow()).getTime() - 60_000).toISOString(), pledge = await purposePledge(f, { acceptedAt: old }), receipt = await personalReceipt(f, pledge, { proof: true, observedAt: old });
    await lifecycleSetPreferences(f.request, preferenceInput(f, { history: "future_only" })); await personalExternalReturn(f, receipt, { originalAt: old, observedAt: (await dbNow()).toISOString() });
    await observeLifecyclePersonal({ limit: 1 }); assert(!(await items(f)).some(item => item.kind === "contribution_returned"));
  });
  it("requires both the actual delivery and its later observed return, keeping the two events distinct", async () => {
    const f = await personalFixture({ mode: "live_sandbox", role: "volunteer" }), payable = await personalPayable(f, { paid: true, observation: true }); await pause(2);
    const returnedAt = (await dbNow()).toISOString(); await query("UPDATE fp_payables SET state='returned',principal_returned_at=$2 WHERE id=$1", [payable.id, returnedAt]); payable.item.status = "RETURNED"; await payoutObservation(f, payable, { observedAt: returnedAt });
    await lifecycleSetPreferences(f.request, preferenceInput(f)); const all = await items(f); assert.equal(all.filter(item => item.kind === "repayment_completed").length, 1); assert.equal(all.filter(item => item.kind === "repayment_returned").length, 1); assert.equal(all.find(item => item.kind === "repayment_returned")!.occurredAt, returnedAt);
    const missing = await personalFixture({ mode: "live_sandbox", role: "volunteer" }), flagged = await personalPayable(missing, { paid: true, returned: true, status: "RETURNED", observation: true }); assert(flagged); await lifecycleSetPreferences(missing.request, preferenceInput(missing)); assert(!(await items(missing)).some(item => item.kind === "repayment_returned"));
  });
  it("preserves an original permitted body as historical when only its project label changes", async () => {
    const f = await personalFixture(); await purposePledge(f); await lifecycleSetPreferences(f.request, preferenceInput(f)); const item = (await items(f))[0], before = await lifecycleInboxDetail(f.request, item.id);
    await query("UPDATE fp_projects SET metadata=jsonb_set(metadata,'{title}','\"Later project label\"'::jsonb),version=version+1 WHERE tenant_id=$1 AND id=$2", [f.tenantId, f.projectId]);
    const after = await lifecycleInboxDetail(f.request, item.id); assert.equal(after.detail.item.status, "historical"); assert.deepEqual(after.detail.content, before.detail.content); assert.deepEqual(after.detail.sources, before.detail.sources);
  });
  it("sees a first source withdrawal committed while a reader waits before its snapshot", async () => {
    const f = await personalFixture({ mode: "live_sandbox", role: "volunteer" }), payable = await personalPayable(f, { paid: true, observation: true }); await lifecycleSetPreferences(f.request, preferenceInput(f)); const item = (await items(f))[0];
    let release!: () => void, acquired!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { acquired = resolve; });
    const writer = database().transaction(async tx => { await tx.query("INSERT INTO fp_plan_source_controls(document_id,tenant_id,project_id,classification,permission) VALUES($1,$2,$3,'source','withdrawn')", [payable.documentId, f.tenantId, f.projectId]); acquired(); await gate; }); await ready;
    let settled = false; const reading = lifecycleInboxDetail(f.request, item.id).then(value => { settled = true; return value; });
    await pause(25); assert.equal(settled, false); release(); await writer;
    const result = await reading; assert.equal(result.detail.item.status, "withdrawn"); assert.equal(result.detail.content, null); assert.deepEqual(result.detail.sources, []); assert.equal(result.detail.emailPreview, null);
  });
  it("requires the worker's exact encrypted original grant and the bounded personal transaction", async () => {
    const f = await personalFixture(), policy = await purposePledge(f); await lifecycleSetPreferences(f.request, preferenceInput(f));
    const [preference] = await query<LifecyclePreferenceRow>("SELECT v.* FROM fp_lifecycle_preference_versions v JOIN fp_lifecycle_preference_heads h ON h.id=v.head_id WHERE h.tenant_id=$1", [f.tenantId]), grant = openPrivate<LifecyclePersonalGrant>(preference.encrypted_grant, lifecyclePrivateContext("preference", preference.id));
    await assert.rejects(database().transaction(tx => observeLifecyclePersonalGrant(tx, preference, grant)), code("INVALID_INPUT"));
    const before = await personalFingerprint(); await assert.rejects(lifecyclePersonalTransaction(tx => observeLifecyclePersonalGrant(tx, preference, { ...grant, expiresAt: new Date(Date.parse(grant.expiresAt) + 60_000).toISOString() })), code("LIFECYCLE_RESOURCE_UNAVAILABLE")); assert.deepEqual(await personalFingerprint(), before);
    await purposePledge(f, { policy: policy.policy }); const result = await lifecyclePersonalTransaction(tx => observeLifecyclePersonalGrant(tx, preference, grant)); assert.equal(result.created, 1); assert.equal((await items(f)).length, 2);
  });
  it("never lets a new session reuse an old already-read state decision", async () => {
    const f = await personalFixture(); await purposePledge(f); await lifecycleSetPreferences(f.request, preferenceInput(f)); let item = (await items(f))[0];
    await lifecycleSetInboxState(f.request, item.id, { intentId: randomUUID(), expectedScope: f.request.personalScope, expectedVersion: item.version, contentHash: item.contentHash, action: "read", acknowledged: true }); item = (await items(f))[0];
    const newer = await personalActor(f, "donor", { actorId: f.session.actorId });
    await assert.rejects(lifecycleSetInboxState(newer.request, item.id, { intentId: randomUUID(), expectedScope: newer.request.personalScope, expectedVersion: item.version, contentHash: null, action: "read", acknowledged: true }), code("LIFECYCLE_AUTHORITY_ENDED"));
  });
  it("allows read-only recovery during the execution hold and blocks every personal write/observer", async () => {
    const f = await personalFixture(); await purposePledge(f); await lifecycleSetPreferences(f.request, preferenceInput(f));
    await query("UPDATE fp_runtime_control SET held=true,version=version+1 WHERE key='execution'");
    try {
      const before = await personalFingerprint(); assert((await lifecycleInbox(f.request)).inbox.items.length > 0); assert.deepEqual(await personalFingerprint(), before);
      await assert.rejects(lifecycleSetPreferences(f.request, preferenceInput(f, { expectedVersion: 1 })), code("WORKSPACE_MAINTENANCE")); await assert.rejects(observeLifecyclePersonal({ limit: 1 }), code("WORKSPACE_MAINTENANCE")); assert.deepEqual(await personalFingerprint(), before);
    } finally { await query("UPDATE fp_runtime_control SET held=false,version=version+1 WHERE key='execution'"); }
  });
});
