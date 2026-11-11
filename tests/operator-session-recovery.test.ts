import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { addActor, errorCode, isolatedPlanningDatabase } from "./helpers/planning";
import { database, query } from "../lib/server/db";
import { createProject } from "../lib/server/seed";
import { sessionForToken } from "../lib/server/auth";
import { inspectExpiredSession, recoverExpiredSession, type OperatorSessionIntent } from "../lib/server/operator-session-recovery";

isolatedPlanningDatabase();
async function fixture() {
  const project = { tenantId: randomUUID(), projectId: randomUUID(), mode: "live_sandbox" as const };
  await database().transaction(tx => createProject(tx, project.tenantId, project.projectId, `recovery-${randomUUID()}`, project.mode));
  const session = await addActor(project, "organizer", ["organizer", "volunteer"]);
  await query("UPDATE fp_sessions SET expires_at=now()-interval '5 minutes' WHERE id=$1", [session.id]);
  const { mode: _mode, ...binding } = await inspectExpiredSession(database(), session.id), at = new Date();
  const intent: OperatorSessionIntent = { version: 1, ...binding, sessionId: randomUUID(), token: randomBytes(32).toString("base64url"), preparedAt: at.toISOString(), expiresAt: new Date(at.getTime() + 12 * 60 * 60_000).toISOString(), reason: "Automated isolated operator-recovery qualification; no real participant or provider action." };
  return { session, intent };
}
describe("audited operator recovery of expired workspace access", () => {
  it("creates the same participant/role without changing the old session, receipts or expired approval", async () => {
    const { session, intent } = await fixture(), approvalId = randomUUID();
    await query("INSERT INTO fp_approval_records(id,tenant_id,project_id,actor_id,resource_id,resource_version,digest,expires_at,data) VALUES($1,$2,$3,$4,$5,1,$6,now()-interval '1 minute','{}')", [approvalId, session.tenantId, session.projectId, session.actorId, randomUUID(), "a".repeat(64)]);
    const old = await query("SELECT * FROM fp_sessions WHERE id=$1", [session.id]), approval = await query("SELECT * FROM fp_approval_records WHERE id=$1", [approvalId]), receipts = await query("SELECT * FROM fp_settlement_receipts WHERE project_id=$1 ORDER BY id", [session.projectId]);
    const recovered = await recoverExpiredSession(database(), intent);
    assert.equal(recovered.id, intent.sessionId); assert.equal(recovered.actorId, session.actorId); assert.equal(recovered.role, "organizer"); assert.equal(recovered.mode, "live_sandbox");
    assert.deepEqual(await query("SELECT * FROM fp_sessions WHERE id=$1", [session.id]), old);
    assert.deepEqual(await query("SELECT * FROM fp_approval_records WHERE id=$1", [approvalId]), approval);
    assert.deepEqual(await query("SELECT * FROM fp_settlement_receipts WHERE project_id=$1 ORDER BY id", [session.projectId]), receipts);
    assert.equal((await sessionForToken(intent.token))?.projectId, session.projectId);
    const events = await query<{ data: Record<string, unknown> }>("SELECT data FROM fp_events WHERE project_id=$1 AND type='workspace.operator_session_recovered'", [session.projectId]);
    assert.equal(events.length, 1); assert.equal(events[0].data.sourceSessionId, session.id); assert.equal(JSON.stringify(events).includes(intent.token), false);
  });
  it("replays an exact saved intent once across concurrent submissions and rejects a changed token", async () => {
    const { intent } = await fixture();
    const results = await Promise.all([recoverExpiredSession(database(), intent), recoverExpiredSession(database(), intent)]);
    assert.equal(results[0].id, results[1].id);
    assert.equal((await query("SELECT id FROM fp_sessions WHERE id=$1", [intent.sessionId])).length, 1);
    assert.equal((await query("SELECT id FROM fp_events WHERE id=$1", [intent.sessionId])).length, 1);
    await assert.rejects(recoverExpiredSession(database(), { ...intent, token: randomBytes(32).toString("base64url") }), errorCode("RECOVERY_REPLAY_CHANGED"));
  });
  it("never recovers a revoked source session or revoked membership", async () => {
    const a = await fixture(); await query("UPDATE fp_sessions SET revoked_at=now() WHERE id=$1", [a.session.id]);
    await assert.rejects(recoverExpiredSession(database(), a.intent), errorCode("RECOVERY_SOURCE_CHANGED"));
    await assert.rejects(inspectExpiredSession(database(), a.session.id), errorCode("RECOVERY_SOURCE_UNAVAILABLE"));
    const b = await fixture(); await query("UPDATE fp_memberships SET state='revoked',version=version+1 WHERE actor_id=$1", [b.session.actorId]);
    await assert.rejects(recoverExpiredSession(database(), b.intent), errorCode("MEMBERSHIP_DENIED"));
  });
  it("rejects substituted actor, project, role and changed membership versions", async () => {
    const { intent } = await fixture();
    for (const altered of [{ actorId: randomUUID() }, { projectId: randomUUID() }, { role: "volunteer" as const }]) await assert.rejects(recoverExpiredSession(database(), { ...intent, ...altered }), errorCode("RECOVERY_SOURCE_CHANGED"));
    await query("UPDATE fp_memberships SET version=version+1 WHERE actor_id=$1", [intent.actorId]);
    await assert.rejects(recoverExpiredSession(database(), intent), errorCode("MEMBERSHIP_DENIED"));
  });
  it("does not create duplicate active access or revive a revoked recovery session", async () => {
    const { intent } = await fixture(); await recoverExpiredSession(database(), intent);
    await assert.rejects(recoverExpiredSession(database(), { ...intent, sessionId: randomUUID(), token: randomBytes(32).toString("base64url") }), errorCode("RECOVERY_ACTIVE_SESSION"));
    await query("UPDATE fp_sessions SET revoked_at=now() WHERE id=$1", [intent.sessionId]);
    await assert.rejects(recoverExpiredSession(database(), intent), errorCode("RECOVERY_REPLAY_CHANGED"));
  });
  it("requires a recent reviewed intent with the fixed twelve-hour lifetime", async () => {
    const { intent } = await fixture();
    await assert.rejects(recoverExpiredSession(database(), { ...intent, expiresAt: new Date(Date.parse(intent.expiresAt) + 1).toISOString() }), errorCode("RECOVERY_INTENT_INVALID"));
    const preparedAt = new Date(Date.now() - 11 * 60_000), expiresAt = new Date(preparedAt.getTime() + 12 * 60 * 60_000);
    await assert.rejects(recoverExpiredSession(database(), { ...intent, preparedAt: preparedAt.toISOString(), expiresAt: expiresAt.toISOString() }), errorCode("RECOVERY_INTENT_EXPIRED"));
  });
});
