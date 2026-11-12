import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { procurementTestDatabase } from "./helpers/procurement-database";
import * as A from "../lib/procurement/access-contracts";

const unit = await procurementTestDatabase();
const { communityFixture } = await import("./helpers/community");
const { tokenHash, setRole, sessionForToken } = await import("../lib/server/auth");
const { procurementAuthority, procurementProjectLock } = await import("../lib/server/procurement-store");
const { acceptVolunteerInvitation, createVolunteerInvitation, restoreVolunteerProfile, reviewVolunteerEntry, revokeVolunteerInvitation, volunteerInvitationLink, validateVolunteerLeave, readVolunteerInvitations } = await import("../lib/server/procurement-access");
type Context = import("../lib/server/procurement-access").VolunteerEntryContext;
const browser = () => randomBytes(32).toString("base64url"), empty = (key = browser()): Context => ({ session: null, credentialHash: null, browserKey: key }), code = (expected: string) => (value: unknown) => value instanceof Error && "code" in value && value.code === expected;
async function invitation(f?: Awaited<ReturnType<typeof communityFixture>>, key = browser()) {
  const workspace = f ?? await communityFixture("makerspace"), scope = (await procurementAuthority(workspace.session)).scope;
  const input: A.VolunteerInviteInput = { intentId: randomUUID(), expectedScope: scope, label: "PRIVATE VOLUNTEER LABEL CANARY", expiresHours: 2, role: "volunteer", contractVersion: A.VOLUNTEER_ENTRY_VERSION, acknowledged: true }, saved = await createVolunteerInvitation(workspace.session, key, input), token = saved.invitation.path.split("#invite=")[1];
  return { workspace, key, input, saved, token };
}
async function enter(i: Awaited<ReturnType<typeof invitation>>, ctx = empty(), displayName = "PRIVATE SELF DECLARED VOLUNTEER CANARY") {
  const intentId = randomUUID(), reviewed = await reviewVolunteerEntry({ kind: "invite", token: i.token, intentId }, ctx);
  const input: A.VolunteerAccept = { intentId, expectedScope: reviewed.scope, token: i.token, displayName, role: "volunteer", contractVersion: A.VOLUNTEER_ENTRY_VERSION, acknowledged: true };
  const joined = await acceptVolunteerInvitation(input, ctx); return { ctx, input, reviewed, joined, current: { session: joined.session, credentialHash: tokenHash(joined.sessionToken), browserKey: ctx.browserKey } satisfies Context };
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitForAdvisoryWaiter(scope: { tenantId: string; projectId: string }) { for (let attempt = 0; attempt < 80; attempt++) { const result = await unit.db.query<{ count: string }>("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objsubid=1 AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid AND objid=(hashtextextended($1,0)&4294967295)::oid AND database=(SELECT oid FROM pg_database WHERE datname=current_database())", [`procurement-project:${scope.tenantId}:${scope.projectId}`]); if (Number(result.rows[0].count)) return; await pause(5); } assert.fail("The controlled command never reached its advisory wait."); }

describe("ordinary one-use volunteer entry and exact original profile recovery", () => {
  it("issues a private exact-role fixed-deadline invitation and preserves the identical original issuance receipt and capability", async () => {
    const i = await invitation(); assert.deepEqual(await createVolunteerInvitation(i.workspace.session, i.key, i.input), i.saved); assert.equal(i.saved.invitation.path.includes("?"), false); assert.equal(i.saved.invitation.expiresAt <= i.workspace.session.expiresAt, true);
    const copied = await volunteerInvitationLink(i.workspace.session, i.saved.invitation.id, { expectedScope: i.input.expectedScope, expectedVersion: 1 }); assert.deepEqual(copied.invitation, i.saved.invitation);
    const desk = await readVolunteerInvitations(i.workspace.session, i.input.expectedScope); assert.equal(desk.invitations[0].role, "volunteer"); assert.equal(desk.invitations[0].recipient, null); assert.equal(desk.invitations[0].canCopy, true);
    await assert.rejects(createVolunteerInvitation(i.workspace.session, i.key, { ...i.input, label: "Changed original issuance intent" }), code("VOLUNTEER_ENTRY_INTENT_CHANGED"));
  });
  it("grants exactly one separate volunteer actor/member/session and replays the identical acceptance after its response wrote the original cookie", async () => {
    const i = await invitation(), ctx = empty(), intentId = randomUUID(), review = await reviewVolunteerEntry({ kind: "invite", token: i.token, intentId }, ctx), input: A.VolunteerAccept = { intentId, expectedScope: review.scope, token: i.token, displayName: "PRIVATE ORDINARY VOLUNTEER IDENTITY", role: "volunteer", contractVersion: A.VOLUNTEER_ENTRY_VERSION, acknowledged: true };
    const [a, b] = await Promise.all([acceptVolunteerInvitation(input, ctx), acceptVolunteerInvitation(input, ctx)]); assert.deepEqual(a, b); assert.notEqual(a.session.actorId, i.workspace.session.actorId); assert.equal(a.session.role, "volunteer"); assert.equal(a.session.expiresAt, i.saved.invitation.expiresAt);
    const current = { session: a.session, credentialHash: tokenHash(a.sessionToken), browserKey: ctx.browserKey }; assert.deepEqual(await acceptVolunteerInvitation(input, current), a);
    const members = await unit.db.query<{ actor_id: string; roles: string[]; version: number }>("SELECT actor_id,roles,version FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 ORDER BY actor_id", [a.session.tenantId, a.session.projectId]); assert.equal(members.rows.length, 2); assert.deepEqual(members.rows.find(row => row.actor_id === a.session.actorId)?.roles, ["volunteer"]); assert.equal(members.rows.find(row => row.actor_id === a.session.actorId)?.version, 1);
    assert.equal((await unit.db.query<{ count: string }>("SELECT count(*) FROM fp_procurement_access WHERE invitation_id=$1", [i.saved.invitation.id])).rows[0].count, "1");
    await assert.rejects(setRole(a.session, "organizer")); await assert.rejects(setRole(a.session, "donor")); assert.equal((await sessionForToken(a.sessionToken))?.role, "volunteer");
  });
  it("never binds changed identity/token fields or another browser to a retained acceptance intent", async () => {
    const i = await invitation(), joined = await enter(i), another = await invitation();
    await assert.rejects(acceptVolunteerInvitation({ ...joined.input, displayName: "Changed identity under original intent" }, joined.ctx), code("VOLUNTEER_ENTRY_INTENT_CHANGED"));
    await assert.rejects(acceptVolunteerInvitation({ ...joined.input, token: another.token }, joined.ctx), code("VOLUNTEER_ENTRY_INTENT_CHANGED"));
    await assert.rejects(acceptVolunteerInvitation(joined.input, empty()), code("VOLUNTEER_ENTRY_USED"));
    const used = await reviewVolunteerEntry({ kind: "invite", token: i.token, intentId: joined.input.intentId }, empty()); assert.equal(used.state, "used"); assert.equal(used.project, null); assert.equal(used.recipient, null);
  });
  it("refuses malformed role widening and keeps an unrelated active or ended cookie outside private recipient/project recovery", async () => {
    const i = await invitation(), joined = await enter(i), foreign = await communityFixture("community-garden"), other: Context = { session: foreign.session, credentialHash: tokenHash(foreign.token), browserKey: browser() };
    await assert.rejects(acceptVolunteerInvitation({ ...joined.input, role: "organizer" } as unknown as A.VolunteerAccept, joined.ctx));
    await assert.rejects(acceptVolunteerInvitation({ ...joined.input, roles: ["volunteer", "organizer"] } as A.VolunteerAccept, joined.ctx));
    const token = joined.joined.result.returnPath.split("#access=")[1], otherReview = await reviewVolunteerEntry({ kind: "access", token }, other); assert.equal(otherReview.state, "switch_required"); assert.equal(otherReview.project, null); assert.equal(otherReview.recipient, null); assert.equal(otherReview.current?.title, foreign.createInput.title);
    await assert.rejects(restoreVolunteerProfile({ intentId: randomUUID(), expectedScope: otherReview.scope, token, acknowledged: true }, other), code("VOLUNTEER_ENTRY_SWITCH_REQUIRED"));
    const ended = { ...joined.ctx, credentialHash: tokenHash("UNRELATED ENDED CREDENTIAL"), session: null }, endedReview = await reviewVolunteerEntry({ kind: "invite", token: i.token, intentId: joined.input.intentId }, ended); assert.equal(endedReview.state, "switch_required"); assert.equal(endedReview.project, null); assert.equal(endedReview.recipient, null);
    await assert.rejects(acceptVolunteerInvitation(joined.input, ended), code("VOLUNTEER_ENTRY_SWITCH_REQUIRED")); await validateVolunteerLeave(endedReview.scope, ended); await assert.rejects(validateVolunteerLeave(endedReview.scope, { ...ended, credentialHash: tokenHash("DIFFERENT ENDED CREDENTIAL") }), code("VOLUNTEER_ENTRY_CONTEXT_CHANGED"));
  });
  it("prevents the issuing actor or browser from becoming an invitation participant, without asserting verified human independence", async () => {
    const i = await invitation(), ctx = empty(i.key), review = await reviewVolunteerEntry({ kind: "invite", token: i.token }, ctx); assert.equal(review.state, "issuer"); assert.equal(review.project, null);
    await assert.rejects(acceptVolunteerInvitation({ intentId: randomUUID(), expectedScope: review.scope, token: i.token, displayName: "Fictional independent person must not be inferred", role: "volunteer", contractVersion: A.VOLUNTEER_ENTRY_VERSION, acknowledged: true }, ctx), code("VOLUNTEER_ENTRY_ISSUER"));
    const active = { session: i.workspace.session, credentialHash: tokenHash(i.workspace.token), browserKey: browser() }; assert.equal((await reviewVolunteerEntry({ kind: "invite", token: i.token }, active)).state, "issuer");
  });
  it("restores only the exact original actor/session/deadline by return-capability possession and retains the original restore intent after cookie write", async () => {
    const i = await invitation(), original = await enter(i), ctx = empty(), token = original.joined.result.returnPath.split("#access=")[1], review = await reviewVolunteerEntry({ kind: "access", token }, ctx);
    assert.equal(review.canRestore, true); const before = (await unit.db.query("SELECT * FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 ORDER BY actor_id", [original.joined.session.tenantId, original.joined.session.projectId])).rows;
    const input = { intentId: randomUUID(), expectedScope: review.scope, token, acknowledged: true as const }, returned = await restoreVolunteerProfile(input, ctx); assert.deepEqual(returned.session, original.joined.session); assert.equal(returned.sessionToken, original.joined.sessionToken); assert.equal(returned.result.returnPath, original.joined.result.returnPath);
    const entered: Context = { session: returned.session, credentialHash: tokenHash(returned.sessionToken), browserKey: ctx.browserKey }; assert.deepEqual(await restoreVolunteerProfile(input, entered), returned);
    assert.deepEqual((await unit.db.query("SELECT * FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 ORDER BY actor_id", [returned.session.tenantId, returned.session.projectId])).rows, before);
    await assert.rejects(restoreVolunteerProfile({ ...input, expectedScope: "a".repeat(64) }, entered), code("VOLUNTEER_ENTRY_INTENT_CHANGED"));
  });
  it("allows only one browser in a concurrent different-intent one-use race and rejects a missing actual-cookie provenance", async () => {
    const i = await invitation(), a = empty(), b = empty(), ia = randomUUID(), ib = randomUUID(), ra = await reviewVolunteerEntry({ kind: "invite", token: i.token, intentId: ia }, a), rb = await reviewVolunteerEntry({ kind: "invite", token: i.token, intentId: ib }, b);
    const input = (intentId: string, scope: string): A.VolunteerAccept => ({ intentId, expectedScope: scope, token: i.token, displayName: "Controlled one-use race participant", role: "volunteer", contractVersion: A.VOLUNTEER_ENTRY_VERSION, acknowledged: true });
    const results = await Promise.allSettled([acceptVolunteerInvitation(input(ia, ra.scope), a), acceptVolunteerInvitation(input(ib, rb.scope), b)]); assert.equal(results.filter(row => row.status === "fulfilled").length, 1); assert.equal(results.filter(row => row.status === "rejected" && code("VOLUNTEER_ENTRY_USED")(row.reason)).length, 1);
    const joined = results.find((row): row is PromiseFulfilledResult<Awaited<ReturnType<typeof acceptVolunteerInvitation>>> => row.status === "fulfilled")!.value;
    await assert.rejects(reviewVolunteerEntry({ kind: "access", token: joined.result.returnPath.split("#access=")[1] }, { session: joined.session, credentialHash: null, browserKey: a.browserKey }), code("VOLUNTEER_ENTRY_CONTEXT_CHANGED"));
  });
  it("rechecks the original inviter membership version at acceptance and discloses no identity on invalid return", async () => {
    const i = await invitation(), ctx = empty(), intentId = randomUUID(), review = await reviewVolunteerEntry({ kind: "invite", token: i.token, intentId }, ctx);
    await unit.db.query("UPDATE fp_memberships SET version=version+1 WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [i.workspace.session.tenantId, i.workspace.session.projectId, i.workspace.session.actorId]);
    await assert.rejects(acceptVolunteerInvitation({ intentId, expectedScope: review.scope, token: i.token, displayName: "Controlled stale-inviter participant", role: "volunteer", contractVersion: A.VOLUNTEER_ENTRY_VERSION, acknowledged: true }, ctx), code("VOLUNTEER_ENTRY_ISSUER_CHANGED"));
    const changed = await reviewVolunteerEntry({ kind: "invite", token: i.token, intentId }, ctx); assert.equal(changed.state, "authority_changed"); assert.equal(changed.project, null); assert.equal(changed.recipient, null);
    const unknown = await reviewVolunteerEntry({ kind: "access", token: randomBytes(48).toString("base64url") }, ctx); assert.equal(unknown.state, "unavailable"); assert.equal(unknown.recipient, null);
  });
  it("refuses acceptance after expiry under the real project advisory lock and creates no recipient/session after that deadline", async () => {
    const workspace = await communityFixture("makerspace"), expiresAt = new Date(Date.now() + 450).toISOString(); await unit.db.query("UPDATE fp_sessions SET expires_at=$2 WHERE id=$1", [workspace.session.id, expiresAt]); workspace.session.expiresAt = expiresAt;
    const i = await invitation(workspace), ctx = empty(), intentId = randomUUID(), review = await reviewVolunteerEntry({ kind: "invite", token: i.token, intentId }, ctx); let pending: Promise<unknown> | null = null;
    await unit.db.transaction(async tx => { await procurementProjectLock(tx, workspace.session); pending = acceptVolunteerInvitation({ intentId, expectedScope: review.scope, token: i.token, displayName: "Controlled expiry-under-lock participant", role: "volunteer", contractVersion: A.VOLUNTEER_ENTRY_VERSION, acknowledged: true }, ctx); pending.catch(() => {}); await waitForAdvisoryWaiter(workspace.session); await pause(Math.max(0, Date.parse(expiresAt) - Date.now() + 25)); });
    assert.ok(pending); await assert.rejects(pending, code("VOLUNTEER_ENTRY_EXPIRED")); assert.equal((await unit.db.query<{ count: string }>("SELECT count(*) FROM fp_procurement_access WHERE invitation_id=$1", [i.saved.invitation.id])).rows[0].count, "0"); assert.equal((await unit.db.query<{ count: string }>("SELECT count(*) FROM fp_sessions WHERE project_id=$1", [workspace.session.projectId])).rows[0].count, "1");
  });
  it("does not hold issuer authority while queued on the project lock and sees a real membership change made by its lock owner", async () => {
    const i = await invitation(), ctx = empty(), intentId = randomUUID(), review = await reviewVolunteerEntry({ kind: "invite", token: i.token, intentId }, ctx); let pending: Promise<unknown> | null = null;
    await unit.db.transaction(async tx => { await procurementProjectLock(tx, i.workspace.session); pending = acceptVolunteerInvitation({ intentId, expectedScope: review.scope, token: i.token, displayName: "Controlled issuer-change-under-lock participant", role: "volunteer", contractVersion: A.VOLUNTEER_ENTRY_VERSION, acknowledged: true }, ctx); pending.catch(() => {}); await waitForAdvisoryWaiter(i.workspace.session); await tx.query("SET LOCAL lock_timeout='500ms'"); await tx.query("UPDATE fp_memberships SET version=version+1 WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [i.workspace.session.tenantId, i.workspace.session.projectId, i.workspace.session.actorId]); });
    assert.ok(pending); await assert.rejects(pending, code("VOLUNTEER_ENTRY_ISSUER_CHANGED")); assert.equal((await unit.db.query<{ count: string }>("SELECT count(*) FROM fp_procurement_access WHERE invitation_id=$1", [i.saved.invitation.id])).rows[0].count, "0");
  });
  it("withdraws only the original volunteer grant, prevents old capability recovery and retains encrypted private audit with no token/name plaintext in saved results", async () => {
    const i = await invitation(), entered = await enter(i), returnToken = entered.joined.result.returnPath.split("#access=")[1], creatorBefore = (await unit.db.query("SELECT * FROM fp_sessions WHERE id=$1", [i.workspace.session.id])).rows, ownerMembership = (await unit.db.query("SELECT * FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [i.workspace.session.tenantId, i.workspace.session.projectId, i.workspace.session.actorId])).rows;
    const input = { intentId: randomUUID(), expectedScope: i.input.expectedScope, expectedVersion: 2, reason: "Withdraw this controlled original volunteer grant only.", acknowledged: true as const }, revoked = await revokeVolunteerInvitation(i.workspace.session, i.key, i.saved.invitation.id, input); assert.deepEqual(await revokeVolunteerInvitation(i.workspace.session, i.key, i.saved.invitation.id, input), revoked);
    assert.equal(await sessionForToken(entered.joined.sessionToken), null); const review = await reviewVolunteerEntry({ kind: "access", token: returnToken }, empty()); assert.equal(review.state, "revoked"); assert.equal(review.recipient, null); assert.equal(review.project, null); await assert.rejects(restoreVolunteerProfile({ intentId: randomUUID(), expectedScope: review.scope, token: returnToken, acknowledged: true }, empty()), code("VOLUNTEER_ENTRY_REVOKED"));
    assert.deepEqual((await unit.db.query("SELECT * FROM fp_sessions WHERE id=$1", [i.workspace.session.id])).rows, creatorBefore); assert.deepEqual((await unit.db.query("SELECT * FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [i.workspace.session.tenantId, i.workspace.session.projectId, i.workspace.session.actorId])).rows, ownerMembership);
    const stored = JSON.stringify((await unit.db.query("SELECT result FROM fp_procurement_entry_commands WHERE tenant_id=$1 AND project_id=$2", [i.workspace.session.tenantId, i.workspace.session.projectId])).rows); for (const secret of [i.token, returnToken, entered.joined.sessionToken, entered.input.displayName, i.input.label]) assert.ok(!stored.includes(secret)); const audit = JSON.stringify((await unit.db.query("SELECT * FROM fp_procurement_access_audit WHERE tenant_id=$1 AND project_id=$2", [i.workspace.session.tenantId, i.workspace.session.projectId])).rows); assert.ok(!audit.includes(entered.input.displayName)); assert.ok(!audit.includes(i.token)); assert.ok(!audit.includes(returnToken));
  });
});
