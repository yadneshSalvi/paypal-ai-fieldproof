import { before, after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { canonicalJson, PostgresDatabase, sha256 } from "@fracture/paypal-core";
import { database, initializeDatabase, initializeDatabaseAt, query } from "../lib/server/db";
import { tokenHash, type Session } from "../lib/server/auth";
import { createProject, sampleReceipt } from "../lib/server/seed";
import { importSampleReceipt } from "../lib/server/documents";
import type { DocumentStorage } from "../lib/server/document-storage";
import { createClaim, reviewClaim, saveClaimDraft } from "../lib/server/claims";
import { prepareWorkspaceHandoff, redeemWorkspaceHandoff, HOSTED_ORIGIN, LOCAL_ORIGIN } from "../lib/server/workspace-handoff";
import { exportWorkspace, importWorkspace, openTransfer, sealTransfer, transferConfiguration } from "../lib/server/workspace-transfer";
import { beginExecutionLease, finishExecutionLease, setRuntimeHold } from "../lib/server/runtime-control";
import { executionQuiescence } from "../lib/server/runtime-control";
import { guardedApi, guardedProviderTransport } from "../lib/server/maintenance";
import { runReceiptExtraction, startReceiptExtraction } from "../lib/server/receipt-extraction";
import { commandFor, ownedPayment, paymentStore } from "../lib/server/payments";
import { originalWorkspaceCookie, prepareWorkspaceRecovery, recoveryRequestDiagnostics, RECOVERY_REFERRER_POLICY, reissueImportedWorkspaceHandoff, validateRecoveryRequest } from "../lib/server/workspace-recovery";

const originalUrl = process.env.DATABASE_URL!, sourceSchema = `fp_transfer_source_${randomUUID().replaceAll("-", "")}`, targetSchema = `fp_transfer_target_${randomUUID().replaceAll("-", "")}`;
const admin = new PostgresDatabase(originalUrl);
let target: PostgresDatabase;
function schemaUrl(name: string) { const url = new URL(originalUrl); url.searchParams.set("options", `-c search_path=${name}`); return url.href; }
before(async () => {
  await admin.query(`CREATE SCHEMA "${sourceSchema}"`); await admin.query(`CREATE SCHEMA "${targetSchema}"`);
  process.env.DATABASE_URL = schemaUrl(sourceSchema); await initializeDatabase();
  target = new PostgresDatabase(schemaUrl(targetSchema)); await initializeDatabaseAt(target);
});
afterEach(async () => {
  for (const [connection, schema] of [[database(), sourceSchema], [target, targetSchema]] as const) {
    const names = await query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename<>'fp_schema_versions'", [schema], connection);
    await connection.query(`TRUNCATE ${names.map(row => `"${schema}"."${row.tablename}"`).join(",")} RESTART IDENTITY CASCADE`);
  }
});
after(async () => {
  await database().close(); await target.close(); await admin.query(`DROP SCHEMA "${sourceSchema}" CASCADE`); await admin.query(`DROP SCHEMA "${targetSchema}" CASCADE`); await admin.close(); process.env.DATABASE_URL = originalUrl;
});
async function fixture() {
  const oldToken = randomBytes(32).toString("base64url");
  const session: Session = { id: randomUUID(), tenantId: randomUUID(), projectId: randomUUID(), actorId: randomUUID(), role: "volunteer", mode: "live_sandbox", expiresAt: new Date(Date.now() + 40 * 60_000).toISOString() };
  await database().transaction(async tx => {
    await createProject(tx, session.tenantId, session.projectId, `transfer-source-${randomUUID()}`, "live_sandbox");
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'volunteer',$6)", [session.id, tokenHash(oldToken), session.tenantId, session.projectId, session.actorId, session.expiresAt]);
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,$4::jsonb)", [session.tenantId, session.projectId, session.actorId, JSON.stringify(["volunteer", "organizer", "donor", "auditor"])]);
  });
  const files = new Map<string, { bytes: Buffer; contentType: string }>();
  const storage: DocumentStorage = { async write(pathname, bytes, contentType) { files.set(pathname, { bytes, contentType }); }, async read(pathname) { const file = files.get(pathname); assert.ok(file); return { ...file, pathname }; } };
  const document = await importSampleReceipt(session, randomUUID(), "original", storage);
  let claim = await createClaim(session, { documentId: document.id, runId: null, intentId: randomUUID() });
  claim = await saveClaimDraft(session, claim.id, { expectedVersion: 1, title: "Transfer fixture expense", note: "Controlled sample only", currency: "USD", totalMinor: 8640, lines: [{ id: "line-1", description: "Solder wire", requestedMinor: 1800, packageId: "electronics" }] }, true);
  session.role = "organizer"; await query("UPDATE fp_sessions SET role='organizer' WHERE id=$1", [session.id]);
  claim = await reviewClaim(session, claim.id, { expectedVersion: claim.version, sourceTotalMinor: 8640, currency: "USD", note: "Controlled fixture review; no purchase or real reviewer claimed", sourceChecked: true, sampleAcknowledged: true, receiptSplit: false, duplicateResolutions: [], lines: [{ id: "line-1", description: "Solder wire", receiptLineKey: "1", sourceMinor: 1800, approvedMinor: 1800, decision: "approved", packageId: "electronics", reviewNote: "Controlled sample line only", uncertaintyResolved: true }] });
  const obligation = randomUUID(), receipt = sampleReceipt(session.tenantId, session.projectId, obligation, "electronics", 100, randomUUID());
  await database().transaction(async tx => {
    await tx.query("INSERT INTO fp_obligations(id,tenant_id,project_id,package_id,actor_id,amount_minor,channel,purpose,data) VALUES($1,$2,$3,'electronics',$4,100,'collected','sandbox_test','{}')", [obligation, session.tenantId, session.projectId, session.actorId]);
    await tx.query("INSERT INTO fp_settlement_receipts(id,tenant_id,project_id,obligation_id,package_id,provider_ref,provenance,data) VALUES($1,$2,$3,$4,'electronics',$5,'sample',$6::jsonb)", [receipt.id, session.tenantId, session.projectId, obligation, receipt.actualProviderPaymentRef, canonicalJson(receipt)]);
    for (const side of ["debit", "credit"]) await tx.query("INSERT INTO fp_journal(id,tenant_id,project_id,receipt_id,account,side,amount_minor,currency) VALUES($1,$2,$3,$4,'fixture',$5,100,'USD')", [randomUUID(), session.tenantId, session.projectId, receipt.id, side]);
    // Fixture-only normalized webhook history; import must archive, never replay it.
    await tx.query("INSERT INTO fp_webhook_jobs(inbox_id,event_id,event_type,resource_id,status,owner_tenant_id,owner_project_id) VALUES('fixture-inbox','fixture-event','PAYMENT.CAPTURE.COMPLETED','fixture-capture','processed',$1,$2)", [session.tenantId, session.projectId]);
    await tx.query("INSERT INTO paycore_webhook_events(tenant_id,project_id,event_id,body_hash,status,document) VALUES('fixture-inbox','fixture-inbox','fixture-event','fixture-hash','queued','{}')");
    await tx.query("INSERT INTO paycore_webhook_deliveries(id,tenant_id,project_id,event_id,verified,document) VALUES('fixture-delivery','fixture-inbox','fixture-inbox','fixture-event',1,'{}')");
  });
  const handoff = await prepareWorkspaceHandoff(session), token = new URLSearchParams(new URL(handoff.url).hash.slice(1)).get("handoff")!;
  const scope = { tenantId: session.tenantId, projectId: session.projectId };
  await setRuntimeHold(database(), true, "Fixture source writer stopped");
  await setRuntimeHold(target, true, "Fixture destination writer stopped");
  const bundle = await exportWorkspace(database(), scope);
  return { session, claim, document, receipt, scope, bundle, token, oldToken };
}
async function existingHostedProject() {
  const tenant = randomUUID(), project = randomUUID();
  await target.transaction(async tx => {
    await createProject(tx, tenant, project, `existing-hosted-${randomUUID()}`, "live_sandbox");
    await tx.query("INSERT INTO fp_events(id,tenant_id,project_id,type,data) VALUES($1,$2,$3,'fixture.hosted','{}')", [randomUUID(), tenant, project]);
  });
  return { tenant, project };
}
const count = async (connection: PostgresDatabase, table: string) => Number((await query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`, [], connection))[0].count);
describe("original-browser continuation recovery", () => {
  it("limits refusal diagnostics to bounded navigation metadata without private request material", () => {
    const privateValue = randomBytes(32).toString("base64url");
    const request = new Request(`${LOCAL_ORIGIN}/continue/recover?handoff=${privateValue}`, { method: "POST", headers: { host: "localhost:4102", origin: LOCAL_ORIGIN, cookie: `fieldproof_session=${privateValue}`, authorization: `Bearer ${privateValue}`, "content-type": "x".repeat(500), "x-private": privateValue }, body: `nonce=${privateValue}` });
    const diagnostic = recoveryRequestDiagnostics(request);
    assert.deepEqual(Object.keys(diagnostic.headers), ["host", "origin", "content-type", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest"]);
    assert.equal(diagnostic.path, "/continue/recover");
    assert.equal(diagnostic.headers["content-type"]?.length, 160);
    assert.equal(diagnostic.headers["sec-fetch-user"], null);
    assert.ok(!JSON.stringify(diagnostic).includes(privateValue));
  });
  async function recoveryFixture() {
    const f = await fixture();
    await importWorkspace(target, f.bundle, transferConfiguration(), false);
    return { ...f, recovery: await prepareWorkspaceRecovery(database(), target, f.bundle) };
  }
  it("requires one original private cookie, exact origin/host, a fresh nonce and explicit form navigation", async () => {
    const token = randomBytes(32).toString("base64url"), nonce = randomBytes(32).toString("base64url");
    const headers = { host: "localhost:4102", origin: LOCAL_ORIGIN, cookie: `fieldproof_session=${token}`, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-user": "?1" };
    const request = (changes: Record<string, string> = {}, body = `nonce=${nonce}`) => new Request(`${LOCAL_ORIGIN}/continue/recover`, { method: "POST", headers: { ...headers, ...changes }, body });
    assert.equal(RECOVERY_REFERRER_POLICY, "same-origin", "retain local navigation origin; omit cross-origin redirect referrer");
    assert.equal(await validateRecoveryRequest(request(), nonce), token);
    for (const changes of [{ origin: "null" }, { origin: "" }, { origin: "https://foreign.invalid" }, { host: "foreign.invalid" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-mode": "cors" }, { "sec-fetch-user": "" }] as Record<string, string>[])
      await assert.rejects(validateRecoveryRequest(request(changes), nonce), { code: "HANDOFF_RECOVERY_ORIGIN_DENIED" });
    await assert.rejects(validateRecoveryRequest(request({ cookie: "" }), nonce), { code: "HANDOFF_RECOVERY_UNAVAILABLE" });
    await assert.rejects(validateRecoveryRequest(request({}, `nonce=${nonce}&actorId=override`), nonce), { code: "HANDOFF_RECOVERY_UNAVAILABLE" });
    await assert.rejects(validateRecoveryRequest(request({}, `nonce=${randomBytes(32).toString("base64url")}`), nonce), { code: "HANDOFF_RECOVERY_UNAVAILABLE" });
    assert.throws(() => originalWorkspaceCookie(`fieldproof_session=${token}; fieldproof_session=${token}`));
  });
  it("reissues the same imported grant, preserves every bound and leaves all source rows unchanged", async () => {
    const f = await recoveryFixture();
    const before = (await target.query("SELECT * FROM fp_workspace_handoffs WHERE id=$1", [f.recovery.bindings[0].grantId])).rows[0];
    const result = await reissueImportedWorkspaceHandoff(database(), target, f.recovery, f.oldToken);
    const after = (await target.query("SELECT * FROM fp_workspace_handoffs WHERE id=$1", [result.grantId])).rows[0];
    const { token_hash: oldHash, ...oldBound } = before, { token_hash: newHash, ...newBound } = after;
    assert.deepEqual(newBound, oldBound); assert.notEqual(newHash, oldHash);
    assert.equal(result.expiresAt, (before.expires_at as Date).toISOString());
    assert.deepEqual((await exportWorkspace(database(), f.scope)).tables, f.bundle.tables);
    assert.equal((await target.query("SELECT count(*)::int AS count FROM fp_events WHERE type='workspace.handoff_link_reissued'")).rows[0].count, 1);
    assert.equal((await target.query("SELECT token_hash FROM fp_sessions WHERE id=$1", [f.session.id])).rows[0].token_hash, tokenHash(f.oldToken));
    await assert.rejects(redeemWorkspaceHandoff(f.token, HOSTED_ORIGIN, target), { code: "HANDOFF_UNAVAILABLE" });
    const restored = await redeemWorkspaceHandoff(new URLSearchParams(new URL(result.url).hash.slice(1)).get("handoff")!, HOSTED_ORIGIN, target);
    assert.equal(restored.session.id, f.session.id); assert.equal(restored.session.actorId, f.session.actorId); assert.equal(restored.session.expiresAt, f.session.expiresAt);
  });
  it("refuses a different valid actor cookie without changing any grant", async () => {
    const f = await recoveryFixture(), other = randomBytes(32).toString("base64url");
    await target.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'organizer',$6)", [randomUUID(), tokenHash(other), f.session.tenantId, f.session.projectId, randomUUID(), f.session.expiresAt]);
    await assert.rejects(reissueImportedWorkspaceHandoff(database(), target, f.recovery, other), { code: "HANDOFF_RECOVERY_UNAVAILABLE" });
    assert.equal((await target.query("SELECT count(*)::int AS count FROM fp_events WHERE type='workspace.handoff_link_reissued'")).rows[0].count, 0);
  });
  it("refuses an expired original grant without extending it", async () => {
    const f = await recoveryFixture(), originalNow = Date.now;
    const original = (await target.query("SELECT expires_at FROM fp_workspace_handoffs WHERE id=$1", [f.recovery.bindings[0].grantId])).rows[0].expires_at as Date;
    Date.now = () => original.getTime() + 1;
    try { await assert.rejects(reissueImportedWorkspaceHandoff(database(), target, f.recovery, f.oldToken), { code: "HANDOFF_RECOVERY_UNAVAILABLE" }); }
    finally { Date.now = originalNow; }
    assert.deepEqual((await target.query("SELECT expires_at FROM fp_workspace_handoffs WHERE id=$1", [f.recovery.bindings[0].grantId])).rows[0].expires_at, original);
  });
  it("refuses an already consumed grant and the rotated old browser cookie", async () => {
    const f = await recoveryFixture();
    await redeemWorkspaceHandoff(f.token, HOSTED_ORIGIN, target);
    await assert.rejects(reissueImportedWorkspaceHandoff(database(), target, f.recovery, f.oldToken), { code: "HANDOFF_RECOVERY_UNAVAILABLE" });
  });
  it("rechecks the original membership version and current session role", async () => {
    const f = await recoveryFixture();
    await target.query("UPDATE fp_memberships SET version=version+1 WHERE project_id=$1 AND actor_id=$2", [f.session.projectId, f.session.actorId]);
    await assert.rejects(reissueImportedWorkspaceHandoff(database(), target, f.recovery, f.oldToken), { code: "HANDOFF_MEMBERSHIP_CHANGED" });
    await target.query("UPDATE fp_sessions SET role='auditor' WHERE id=$1", [f.session.id]);
    await assert.rejects(reissueImportedWorkspaceHandoff(database(), target, f.recovery, f.oldToken), { code: "HANDOFF_RECOVERY_UNAVAILABLE" });
  });
  it("requires a current destination hold and the unchanged source hold version", async () => {
    const f = await recoveryFixture();
    await setRuntimeHold(target, false, "Fixture destination resumed");
    await assert.rejects(reissueImportedWorkspaceHandoff(database(), target, f.recovery, f.oldToken), { code: "HANDOFF_TARGET_NOT_HELD" });
    await setRuntimeHold(target, true, "Fixture destination held again");
    await setRuntimeHold(database(), true, "Fixture source hold version changed");
    await assert.rejects(reissueImportedWorkspaceHandoff(database(), target, f.recovery, f.oldToken), { code: "HANDOFF_SOURCE_HOLD_CHANGED" });
  });
  it("allows only one reissue against the same bootstrapped grant hash", async () => {
    const f = await recoveryFixture();
    const results = await Promise.allSettled([reissueImportedWorkspaceHandoff(database(), target, f.recovery, f.oldToken), reissueImportedWorkspaceHandoff(database(), target, f.recovery, f.oldToken)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal((await target.query("SELECT count(*)::int AS count FROM fp_events WHERE type='workspace.handoff_link_reissued'")).rows[0].count, 1);
    assert.deepEqual((await exportWorkspace(database(), f.scope)).tables, f.bundle.tables);
  });
});
describe("private scoped workspace transfer", () => {
  it("retains encrypted claims, immutable IDs and hosted records; dry-run rolls back including cursor allocation", async () => {
    const f = await fixture(), hosted = await existingHostedProject();
    const envelope = sealTransfer(f.bundle);
    assert.equal(JSON.stringify(envelope).includes(f.session.projectId), false);
    const bundle = openTransfer(envelope);
    const beforeSequence = await target.query("SELECT last_value FROM fp_events_sequence_seq");
    const planned = await importWorkspace(target, bundle, transferConfiguration(), true);
    assert.equal(planned.mode, "dry_run"); assert.equal(planned.providerWrites, 0); assert.equal(planned.claims.revisions, 3);
    assert.equal(await count(target, "fp_claims"), 0); assert.equal(await count(target, "fp_tenants"), 1);
    assert.deepEqual((await target.query("SELECT last_value FROM fp_events_sequence_seq")).rows, beforeSequence.rows);
    const applied = await importWorkspace(target, bundle, transferConfiguration(), false);
    assert.equal(applied.mode, "applied"); assert.equal(await count(target, "fp_claim_revisions"), 3); assert.equal(await count(target, "fp_journal"), 2);
    assert.equal((await target.query("SELECT count(*)::int AS count FROM fp_projects WHERE id=$1", [hosted.project])).rows[0].count, 1);
    const source = (await query<{ encrypted_data: string }>("SELECT encrypted_data FROM fp_claims WHERE id=$1", [f.claim.id]))[0];
    const copy = (await query<{ encrypted_data: string }>("SELECT encrypted_data FROM fp_claims WHERE id=$1", [f.claim.id], target))[0];
    assert.equal(copy.encrypted_data, source.encrypted_data);
    assert.equal(await count(target, "fp_transfer_webhook_archive"), 3);
    assert.equal(await count(target, "paycore_webhook_events"), 0); assert.equal(await count(target, "fp_webhook_jobs"), 0);
    const sourceEvents = f.bundle.sourceEventSequence.map(event => event.eventId);
    assert.deepEqual((await target.query("SELECT id FROM fp_events WHERE project_id=$1 ORDER BY sequence", [f.session.projectId])).rows.map(row => row.id), sourceEvents);
    assert.equal((await importWorkspace(target, bundle, transferConfiguration(), false)).mode, "already_applied");
    assert.equal(await count(target, "fp_journal"), 2);
  });
  it("rejects mismatched encryption, merchant and private storage before any import", async () => {
    const f = await fixture();
    for (const key of ["authSecret", "clientId", "blobToken"] as const) await assert.rejects(importWorkspace(target, f.bundle, { ...transferConfiguration(), [key]: "different-config-with-at-least-thirty-two-characters" }, false), { code: "TRANSFER_CONFIGURATION_MISMATCH" });
    assert.equal(await count(target, "fp_tenants"), 0);
    const envelope = sealTransfer(f.bundle); envelope.ciphertext = envelope.ciphertext.slice(0,-8) + "ABCDEFGH";
    assert.throws(() => openTransfer(envelope));
  });
  it("rolls back the complete import on a secondary unique conflict and retains existing hosted history", async () => {
    const f = await fixture(), hosted = await existingHostedProject();
    const [source] = await query<{ slug: string }>("SELECT slug FROM fp_projects WHERE id=$1", [f.scope.projectId]);
    await target.query("UPDATE fp_projects SET slug=$2 WHERE id=$1", [hosted.project, source.slug]);
    await assert.rejects(importWorkspace(target, f.bundle, transferConfiguration(), false), { code: "TRANSFER_DATABASE_CONFLICT" });
    assert.equal(await count(target, "fp_tenants"), 1); assert.equal(await count(target, "fp_events"), 1); assert.equal(await count(target, "fp_workspace_imports"), 0);
  });
  it("rejects changed destination records instead of overwriting later work", async () => {
    const f = await fixture(); await importWorkspace(target, f.bundle, transferConfiguration(), false);
    await target.query("UPDATE fp_claims SET state='needs_review' WHERE id=$1", [f.claim.id]);
    await query("INSERT INTO fp_events(id,tenant_id,project_id,type,data) VALUES($1,$2,$3,'fixture.after_snapshot','{}')", [randomUUID(), f.scope.tenantId, f.scope.projectId]);
    const next = await exportWorkspace(database(), f.scope), beforeEvents = await count(target, "fp_events");
    await assert.rejects(importWorkspace(target, next, transferConfiguration(), false), { code: "TRANSFER_RECORD_CONFLICT" });
    assert.equal(await count(target, "fp_events"), beforeEvents);
    assert.equal((await target.query("SELECT state FROM fp_claims WHERE id=$1", [f.claim.id])).rows[0].state, "needs_review");
    assert.equal(await count(target, "fp_workspace_imports"), 1);
  });
  it("exports only the selected scope and refuses an active evidence lease", async () => {
    const f = await fixture(), otherTenant = randomUUID(), otherProject = randomUUID();
    await database().transaction(tx => createProject(tx, otherTenant, otherProject, `unrelated-${randomUUID()}`, "live_sandbox"));
    const bundle = await exportWorkspace(database(), f.scope);
    assert.equal(canonicalJson(bundle).includes(otherTenant), false); assert.equal(canonicalJson(bundle).includes(otherProject), false);
    await query("UPDATE fp_documents SET lease_until=now()+interval '1 minute' WHERE id=$1", [f.document.id]);
    await assert.rejects(exportWorkspace(database(), f.scope), { code: "TRANSFER_ACTIVE_LEASE" });
  });
});
describe("single-use hosted continuation", () => {
  it("requires an imported grant and the exact destination origin", async () => {
    const f = await fixture();
    await assert.rejects(redeemWorkspaceHandoff(f.token, LOCAL_ORIGIN), { code: "HANDOFF_INVALID" });
    await assert.rejects(redeemWorkspaceHandoff(f.token, HOSTED_ORIGIN), { code: "HANDOFF_NOT_IMPORTED" });
    await assert.rejects(redeemWorkspaceHandoff(f.token, "https://attacker.invalid"), { code: "HANDOFF_INVALID" });
    assert.equal((await query<{ consumed_at: Date | null }>("SELECT consumed_at FROM fp_workspace_handoffs WHERE token_hash=$1", [tokenHash(f.token)]))[0].consumed_at, null);
  });
  it("rotates the original session once, preserving actor, role, expiry, review and money", async () => {
    const f = await fixture(); await importWorkspace(target, f.bundle, transferConfiguration(), false);
    const results = await Promise.allSettled([redeemWorkspaceHandoff(f.token, HOSTED_ORIGIN, target), redeemWorkspaceHandoff(f.token, HOSTED_ORIGIN, target)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const success = results.find(result => result.status === "fulfilled")! as PromiseFulfilledResult<Awaited<ReturnType<typeof redeemWorkspaceHandoff>>>;
    assert.deepEqual(success.value.session, f.session);
    const [row] = await query<{ token_hash: string }>("SELECT token_hash FROM fp_sessions WHERE id=$1", [f.session.id], target);
    assert.equal(row.token_hash, tokenHash(success.value.token)); assert.notEqual(row.token_hash, tokenHash(f.oldToken));
    assert.equal(await count(target, "fp_journal"), 2); assert.equal(await count(target, "fp_claim_revisions"), 3); assert.equal(await count(target, "fp_payables"), 0);
    await assert.rejects(redeemWorkspaceHandoff(f.token, HOSTED_ORIGIN, target), { code: "HANDOFF_UNAVAILABLE" });
  });
  it("rejects changed membership without consuming the original grant", async () => {
    const f = await fixture(); await importWorkspace(target, f.bundle, transferConfiguration(), false);
    await target.query("UPDATE fp_memberships SET version=version+1 WHERE project_id=$1", [f.scope.projectId]);
    await assert.rejects(redeemWorkspaceHandoff(f.token, HOSTED_ORIGIN, target), { code: "HANDOFF_MEMBERSHIP_CHANGED" });
    assert.equal((await query<{ consumed_at: Date | null }>("SELECT consumed_at FROM fp_workspace_handoffs WHERE token_hash=$1", [tokenHash(f.token)], target))[0].consumed_at, null);
  });
  it("does not revive an expired original session or extend the handoff deadline", async () => {
    const f = await fixture(); await importWorkspace(target, f.bundle, transferConfiguration(), false);
    await target.query("UPDATE fp_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [f.session.id]);
    await assert.rejects(redeemWorkspaceHandoff(f.token, HOSTED_ORIGIN, target), { code: "HANDOFF_AUTHORITY_CHANGED" });
    const [row] = await query<{ expires_at: Date }>("SELECT expires_at FROM fp_sessions WHERE id=$1", [f.session.id], target);
    assert.ok(row.expires_at.getTime() < Date.now());
  });
});
describe("server-side execution hold", () => {
  it("blocks mutation, webhook, OAuth and cron requests while preserving health, reads and continuation", async () => {
    await fixture();
    let called = 0;
    const work = async () => { called++; return Response.json({ observed: true }); };
    for (const [method, path] of [["POST", "/api/claims"], ["POST", "/api/paypal/webhook"], ["GET", "/api/auth/paypal"], ["GET", "/api/auth/paypal/callback"], ["GET", "/api/cron/payouts"], ["HEAD", "/api/cron/reconcile"], ["GET", "/api/%63ron/evidence"]]) {
      const result = await guardedApi(new Request(`http://localhost:4102${path}`, { method }), work);
      assert.equal(result.status, 503); assert.equal(result.headers.get("Retry-After"), "30");
    }
    assert.equal(called, 0);
    for (const [method, path] of [["GET", "/api/health"], ["GET", "/api/claims"], ["GET", "/api/payments/original"], ["POST", "/api/workspace/continue"]]) assert.equal((await guardedApi(new Request(`http://localhost:4102${path}`, { method }), work)).status, 200);
    assert.equal(called, 4); assert.equal((await executionQuiescence(database())).activeRequests, 0);
  });
  it("serializes a hold against new leases and rejects a snapshot taken while work is still active", async () => {
    const f = await fixture(); await setRuntimeHold(database(), false, "Fixture begins one existing request");
    const lease = await beginExecutionLease(database(), "POST /api/claims");
    await setRuntimeHold(database(), true, "Fixture freezes new request admission");
    assert.equal((await executionQuiescence(database())).quiescent, false);
    await assert.rejects(beginExecutionLease(database(), "POST /api/payouts"), { code: "WORKSPACE_MAINTENANCE" });
    const during = await exportWorkspace(database(), f.scope);
    await assert.rejects(importWorkspace(target, during, transferConfiguration(), false), { code: "TRANSFER_SOURCE_NOT_QUIESCENT" });
    await finishExecutionLease(database(), lease);
    assert.equal((await executionQuiescence(database())).quiescent, true);
    assert.equal((await importWorkspace(target, await exportWorkspace(database(), f.scope), transferConfiguration(), true)).mode, "dry_run");
  });
  it("requires the destination to be held and drained before importing any source row", async () => {
    const f = await fixture(); await setRuntimeHold(target, false, "Fixture destination is still serving");
    await assert.rejects(importWorkspace(target, f.bundle, transferConfiguration(), false), { code: "TRANSFER_TARGET_NOT_QUIESCENT" });
    const lease = await beginExecutionLease(target, "GET /api/cron/reconcile");
    await setRuntimeHold(target, true, "Fixture pauses the hosted writer");
    await assert.rejects(importWorkspace(target, f.bundle, transferConfiguration(), false), { code: "TRANSFER_TARGET_NOT_QUIESCENT" });
    assert.equal(await count(target, "fp_claims"), 0);
    await finishExecutionLease(target, lease);
    assert.equal((await importWorkspace(target, f.bundle, transferConfiguration(), false)).mode, "applied");
  });
  it("rechecks PayPal mutations before dispatch and preserves the original Request and signal for allowed reads", async () => {
    await fixture();
    const observed: { input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] }[] = [];
    const transport: typeof fetch = async (input, init) => { observed.push({ input, init }); return new Response("fixture"); };
    const guarded = guardedProviderTransport(transport), controller = new AbortController();
    const request = new Request("https://api-m.sandbox.paypal.com/v2/checkout/orders", { method: "POST", body: "{}", headers: { Authorization: "Bearer fixture-only" }, signal: controller.signal });
    await assert.rejects(guarded(request), { code: "WORKSPACE_MAINTENANCE" });
    assert.equal(observed.length, 0);
    const read = new Request("https://api-m.sandbox.paypal.com/v2/checkout/orders/FIXTUREORDER", { signal: controller.signal });
    const options = { cache: "no-store" as const, signal: controller.signal };
    await guarded(read, options); assert.equal(observed[0].input, read); assert.equal(observed[0].init, options);
    await guarded(new Request("https://api-m.sandbox.paypal.com/v1/oauth2/token", { method: "POST", body: "grant_type=client_credentials" }));
    await guarded(new Request("https://api-m.sandbox.paypal.com/v2/invoicing/search-invoices", { method: "POST", body: "{}" }));
    await setRuntimeHold(database(), false, "Fixture resumes the designated writer");
    await guarded(request); assert.equal(observed[3].input, request);
  });
  it("keeps queued extraction untouched when an after-response worker encounters the hold", async () => {
    const f = await fixture();
    const run = await startReceiptExtraction(f.session, f.document.id);
    let calls = 0;
    await runReceiptExtraction(run.id, { async extract() { calls++; throw new Error("The held worker must not call a model."); } });
    const [row] = await query<{ status: string; attempt: number }>("SELECT status,attempt FROM fp_ai_runs WHERE id=$1", [run.id]);
    assert.equal(calls, 0); assert.equal(row.status, "queued"); assert.equal(row.attempt, 0);
  });
  it("finishes a request lease even if its handler fails, without authorizing another write", async () => {
    await fixture(); await setRuntimeHold(database(), false, "Fixture permits one failing handler");
    const result = await guardedApi(new Request("http://localhost:4102/api/claims", { method: "POST" }), async () => { throw new Error("Fixture handler failure"); });
    assert.equal(result.status, 500); assert.equal((await executionQuiescence(database())).activeRequests, 0);
    await setRuntimeHold(database(), true, "Fixture ends with writer held");
  });
  it("reads the original encrypted operation by independent owned scope and rejects another project", async () => {
    const f = await fixture(); f.session.role = "donor"; await query("UPDATE fp_sessions SET role='donor' WHERE id=$1", [f.session.id]);
    const command = await commandFor(f.session, randomUUID(), "create");
    await paymentStore().claim(command);
    const view = await ownedPayment(f.session, command.operationId);
    assert.equal(view.amountMinor, 100);
    await assert.rejects(ownedPayment({ ...f.session, projectId: randomUUID() }, command.operationId), { code: "PAYMENT_NOT_FOUND" });
    const [row] = await query<{ document: string }>("SELECT document FROM paycore_operations WHERE id=$1", [command.operationId]);
    assert.equal(JSON.parse(row.document).paycoreEncoding, "operation-v1");
  });
});
