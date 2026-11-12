import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import type { SqlConnection } from "@fracture/paypal-core";
import { DomainError } from "../lib/domain/money";
import { SUPPORTER_ACCESS_VERSION, type SupporterPurpose } from "../lib/supporters/contracts";
import { sessionForToken, setRole, tokenHash, type Session } from "../lib/server/auth";
import { database, initializeDatabase, query } from "../lib/server/db";
import { sealPrivate } from "../lib/server/private-values";
import { createProject } from "../lib/server/seed";
import {
  acceptSupporterInvite, createSupporterInvite, restoreSupporterAccess, reviewSupporterEntry, revokeSupporterInvite,
  supporterDesk, supporterEntryScope, supporterInviteLink, type SupporterEntryContext,
} from "../lib/server/supporter-access";

before(initializeDatabase);
after(async () => { await database().close(); });

const browserKey = () => randomBytes(32).toString("base64url");
const anonymous = (key = browserKey()): SupporterEntryContext => ({ session: null, credentialHash: null, browserKey: key });
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
const outcome = <T>(promise: Promise<T>): Promise<Outcome<T>> => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));

async function workspace() {
  const session: Session = {
    id: randomUUID(), tenantId: randomUUID(), projectId: randomUUID(), actorId: randomUUID(), role: "organizer",
    mode: "live_sandbox", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const issuerBrowserKey = browserKey(), credential = browserKey();
  await database().transaction(async tx => {
    await createProject(tx, session.tenantId, session.projectId, `adversarial-onboarding-${randomUUID()}`, "live_sandbox");
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,'[\"organizer\",\"auditor\"]'::jsonb)", [session.tenantId, session.projectId, session.actorId]);
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'organizer',$6)", [session.id, tokenHash(credential), session.tenantId, session.projectId, session.actorId, session.expiresAt]);
  });
  return { session, issuerBrowserKey, credential };
}
type Workspace = Awaited<ReturnType<typeof workspace>>;
async function invite(f: Workspace, purpose: SupporterPurpose = "donor", label = `Private invite ${randomUUID()}`) {
  return createSupporterInvite(f.session, f.issuerBrowserKey, {
    intentId: randomUUID(), expectedScope: (await supporterDesk(f.session)).scope, label, purpose, expiresHours: 1, acknowledged: true,
  });
}
function acceptance(token: string, context: SupporterEntryContext, displayName = `Private supporter ${randomUUID()}`) {
  return { token, intentId: randomUUID(), expectedScope: supporterEntryScope(context), displayName,
    contractVersion: SUPPORTER_ACCESS_VERSION, acknowledged: true as const };
}
async function shortInvitation(f: Workspace, milliseconds = 2000) {
  // This fixture is inserted with its initial short deadline. Immutable retained
  // invitation terms and every native review fixture remain untouched.
  const id = randomUUID(), token = randomBytes(48).toString("base64url");
  const createdAt = (await query<{ at: Date }>("SELECT clock_timestamp() AS at"))[0].at;
  const expiresAt = new Date(createdAt.getTime() + milliseconds);
  const context = `supporter-invite:${f.session.tenantId}:${f.session.projectId}:${id}`;
  await query(`INSERT INTO fp_supporter_invites(id,tenant_id,project_id,issuer_actor_id,issuer_session_id,issuer_membership_version,issuer_browser_hash,purpose,role,token_hash,encrypted_token,encrypted_data,created_at,expires_at)
    VALUES($1,$2,$3,$4,$5,1,$6,'donor','donor',$7,$8,$9,$10,$11)`,
  [id, f.session.tenantId, f.session.projectId, f.session.actorId, f.session.id, tokenHash(f.issuerBrowserKey), tokenHash(token),
    sealPrivate(token, `${context}:token`), sealPrivate({ label: "Initially short-lived adversarial fixture", contractVersion: SUPPORTER_ACCESS_VERSION }, context), createdAt, expiresAt]);
  return { id, token, expiresAt: expiresAt.toISOString() };
}
async function addOtherActor(f: Workspace) {
  const credential = browserKey(), session: Session = { ...f.session, id: randomUUID(), actorId: randomUUID(), role: "donor" };
  await database().transaction(async tx => {
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,'[\"donor\"]'::jsonb)", [session.tenantId, session.projectId, session.actorId]);
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'donor',$6)", [session.id, tokenHash(credential), session.tenantId, session.projectId, session.actorId, session.expiresAt]);
  });
  return { session, credential };
}
async function counts(projectId: string) {
  return (await query<{ invitations: number; accesses: number; sessions: number; memberships: number; accepted: number; restored: number }>(`SELECT
    (SELECT count(*)::int FROM fp_supporter_invites WHERE project_id=$1) invitations,
    (SELECT count(*)::int FROM fp_supporter_access WHERE project_id=$1) accesses,
    (SELECT count(*)::int FROM fp_sessions WHERE project_id=$1) sessions,
    (SELECT count(*)::int FROM fp_memberships WHERE project_id=$1) memberships,
    (SELECT count(*)::int FROM fp_supporter_access_audit WHERE project_id=$1 AND kind='accepted') accepted,
    (SELECT count(*)::int FROM fp_supporter_access_audit WHERE project_id=$1 AND kind='restored') restored`, [projectId]))[0];
}
async function expireSessionSoon(session: Session, milliseconds = 2000) {
  const [row] = await query<{ expires_at: Date }>("UPDATE fp_sessions SET expires_at=clock_timestamp()+$2::double precision*interval '1 millisecond' WHERE id=$1 RETURNING expires_at", [session.id, milliseconds]);
  return row.expires_at.toISOString();
}
async function afterDeadline(expiresAt: string) {
  await query("SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.04)", [expiresAt]);
}
async function waitForBlockedBy(pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [row] = await query<{ blocked: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) blocked", [pid]);
    if (row.blocked) return;
    await delay(10);
  }
  assert.fail("The service did not reach the held authority lock.");
}
async function withLock<T>(sql: string, values: unknown[], work: (gate: { pid: number; tx: SqlConnection; release(): void }) => Promise<T>) {
  let release!: () => void, ready!: (gate: { pid: number; tx: SqlConnection; release(): void }) => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const acquired = new Promise<{ pid: number; tx: SqlConnection; release(): void }>(resolve => { ready = resolve; });
  const holding = database().transaction(async tx => {
    await tx.query(sql, values);
    const [{ pid }] = await query<{ pid: number }>("SELECT pg_backend_pid() pid", [], tx);
    ready({ pid, tx, release });
    await released;
  });
  try { return await work(await acquired); }
  finally { release(); await holding; }
}
function rejectedWith(result: Outcome<unknown>, codes: string[]) {
  assert.equal(result.ok, false, "The request must be refused without returning a credential or recipient.");
  if (result.ok) return;
  assert.ok(result.error instanceof DomainError);
  assert.ok(codes.includes(result.error.code), `Unexpected refusal code: ${result.error.code}`);
}

describe("supporter onboarding adversarial authority", () => {
  it("serializes simultaneous lost-response acceptance retries into one exact recipient and one audit", async () => {
    const f = await workspace(), invitation = await invite(f), context = anonymous(), input = acceptance(invitation.token, context);
    const results = await Promise.all(Array.from({ length: 6 }, () => acceptSupporterInvite(input, context)));
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.equal(results[0].session.expiresAt, invitation.expiresAt);
    assert.deepEqual(await counts(f.session.projectId), { invitations: 1, accesses: 1, sessions: 2, memberships: 2, accepted: 1, restored: 0 });
  });

  it("allows only one of two concurrent holders to claim a possession invitation", async () => {
    const f = await workspace(), invitation = await invite(f), contexts = [anonymous(), anonymous()];
    const results = await Promise.all(contexts.map(context => outcome(acceptSupporterInvite(acceptance(invitation.token, context), context))));
    assert.equal(results.filter(result => result.ok).length, 1);
    rejectedWith(results.find(result => !result.ok)!, ["SUPPORTER_INVITE_USED"]);
    assert.deepEqual(await counts(f.session.projectId), { invitations: 1, accesses: 1, sessions: 2, memberships: 2, accepted: 1, restored: 0 });
  });

  it("refuses a same-attempt replay after a null-session browser's credential scope changed", async () => {
    const f = await workspace(), invitation = await invite(f), context = anonymous(), input = acceptance(invitation.token, context);
    await acceptSupporterInvite(input, context);
    const stale = { ...context, credentialHash: tokenHash("an-unrelated-ended-browser-credential") };
    const result = await outcome(acceptSupporterInvite(input, stale));
    rejectedWith(result, ["SUPPORTER_CONTEXT_CHANGED"]);
  });

  it("withholds the accepted recipient from invitation review after a stale credential scope change", async () => {
    const f = await workspace(), invitation = await invite(f), context = anonymous(), input = acceptance(invitation.token, context);
    await acceptSupporterInvite(input, context);
    const stale = { ...context, credentialHash: tokenHash("a-different-ended-browser-credential") };
    const view = await reviewSupporterEntry({ kind: "invite", token: invitation.token, intentId: input.intentId }, stale);
    assert.deepEqual({ recipient: view.recipient, canRestore: view.canRestore, project: view.project }, { recipient: null, canRestore: false, project: null });
  });

  it("rechecks issuer membership after waiting, before admitting any recipient", async () => {
    const f = await workspace(), invitation = await invite(f), context = anonymous(), input = acceptance(invitation.token, context);
    await withLock("SELECT actor_id FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 FOR UPDATE", [f.session.tenantId, f.session.projectId, f.session.actorId], async gate => {
      const pending = outcome(acceptSupporterInvite(input, context));
      await waitForBlockedBy(gate.pid);
      await gate.tx.query("UPDATE fp_memberships SET state='revoked',version=version+1,revoked_at=clock_timestamp() WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [f.session.tenantId, f.session.projectId, f.session.actorId]);
      gate.release();
      rejectedWith(await pending, ["SUPPORTER_INVITER_CHANGED"]);
    });
    assert.deepEqual(await counts(f.session.projectId), { invitations: 1, accesses: 0, sessions: 1, memberships: 1, accepted: 0, restored: 0 });
  });

  it("does not extend a short invitation while acceptance waits for issuer membership", async () => {
    const f = await workspace(), invitation = await shortInvitation(f), context = anonymous(), input = acceptance(invitation.token, context);
    await withLock("SELECT actor_id FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 FOR UPDATE", [f.session.tenantId, f.session.projectId, f.session.actorId], async gate => {
      const pending = outcome(acceptSupporterInvite(input, context));
      await waitForBlockedBy(gate.pid); await afterDeadline(invitation.expiresAt); gate.release();
      rejectedWith(await pending, ["SUPPORTER_ACCESS_UNAVAILABLE"]);
    });
    assert.equal((await counts(f.session.projectId)).accesses, 0);
  });

  it("refuses restoration if the fixed recipient deadline passes while waiting for its command lock", async () => {
    const f = await workspace(), invitation = await shortInvitation(f), context = anonymous();
    const joined = await acceptSupporterInvite(acceptance(invitation.token, context), context);
    const intentId = randomUUID(), input = { token: joined.recoveryToken, intentId, expectedScope: supporterEntryScope(context), acknowledged: true as const };
    await withLock("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`supporter-command:${joined.session.tenantId}:${joined.session.actorId}:${intentId}`], async gate => {
      const pending = outcome(restoreSupporterAccess(input, context));
      await waitForBlockedBy(gate.pid); await afterDeadline(invitation.expiresAt); gate.release();
      const result = await pending, saved = await counts(f.session.projectId);
      assert.deepEqual({ restored: result.ok, restoreAudits: saved.restored }, { restored: false, restoreAudits: 0 });
      assert.equal(await sessionForToken(joined.sessionToken), null);
    });
  });

  it("refuses invitation creation if organizer authority expires behind the command lock", async () => {
    const f = await workspace(), expectedScope = (await supporterDesk(f.session)).scope, intentId = randomUUID();
    const deadline = await expireSessionSoon(f.session);
    const input = { intentId, expectedScope, label: "Organizer deadline race", purpose: "donor" as const, expiresHours: 1, acknowledged: true as const };
    await withLock("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`supporter-command:${f.session.tenantId}:${f.session.actorId}:${intentId}`], async gate => {
      const pending = outcome(createSupporterInvite(f.session, f.issuerBrowserKey, input));
      await waitForBlockedBy(gate.pid); await afterDeadline(deadline); gate.release();
      const result = await pending, saved = await counts(f.session.projectId);
      assert.deepEqual({ invitationReturned: result.ok, invitations: saved.invitations }, { invitationReturned: false, invitations: 0 });
    });
  });

  it("withholds invitation secrets if organizer authority expires behind an invitation row lock", async () => {
    const f = await workspace(), invitation = await invite(f), expectedScope = (await supporterDesk(f.session)).scope;
    const deadline = await expireSessionSoon(f.session);
    await withLock("SELECT id FROM fp_supporter_invites WHERE id=$1 FOR UPDATE", [invitation.id], async gate => {
      const pending = outcome(supporterInviteLink(f.session, invitation.id, { expectedScope, expectedVersion: 1 }));
      await waitForBlockedBy(gate.pid); await afterDeadline(deadline); gate.release();
      rejectedWith(await pending, ["ROLE_DENIED", "SUPPORTER_ACCESS_UNAVAILABLE"]);
    });
  });

  it("refuses a new grant if its invitation expires behind the later project projection lock", async () => {
    const f = await workspace(), invitation = await shortInvitation(f), context = anonymous(), input = acceptance(invitation.token, context);
    // NO KEY UPDATE permits the grant's foreign-key checks, but blocks the
    // later appendEvent projection update after its first deadline check.
    await withLock("SELECT id FROM fp_projects WHERE id=$1 FOR NO KEY UPDATE", [f.session.projectId], async gate => {
      const pending = outcome(acceptSupporterInvite(input, context));
      await waitForBlockedBy(gate.pid); await afterDeadline(invitation.expiresAt); gate.release();
      const result = await pending, saved = await counts(f.session.projectId);
      assert.deepEqual({ accepted: result.ok, accesses: saved.accesses, acceptanceAudits: saved.accepted, sessions: saved.sessions },
        { accepted: false, accesses: 0, acceptanceAudits: 0, sessions: 1 });
    });
  });

  it("does not let organizer expiry behind the project invite-cap lock create a fresh capability", async () => {
    const f = await workspace(), expectedScope = (await supporterDesk(f.session)).scope, deadline = await expireSessionSoon(f.session);
    const input = { intentId: randomUUID(), expectedScope, label: "Project invite-cap deadline race", purpose: "donor" as const, expiresHours: 1, acknowledged: true as const };
    await withLock("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`supporter-invites:${f.session.projectId}`], async gate => {
      const pending = outcome(createSupporterInvite(f.session, f.issuerBrowserKey, input));
      await waitForBlockedBy(gate.pid); await afterDeadline(deadline); gate.release();
      const result = await pending, saved = await counts(f.session.projectId);
      assert.deepEqual({ invitationReturned: result.ok, invitations: saved.invitations }, { invitationReturned: false, invitations: 0 });
    });
  });

  it("does not revoke an accepted recipient after the organizer expires behind the invitation lock", async () => {
    const f = await workspace(), invitation = await invite(f), context = anonymous();
    const joined = await acceptSupporterInvite(acceptance(invitation.token, context), context);
    const organizerView = await supporterDesk(f.session), deadline = await expireSessionSoon(f.session);
    const input = { intentId: randomUUID(), expectedScope: organizerView.scope, expectedVersion: organizerView.invitations[0].version, acknowledged: true as const };
    await withLock("SELECT id FROM fp_supporter_invites WHERE id=$1 FOR UPDATE", [invitation.id], async gate => {
      const pending = outcome(revokeSupporterInvite(f.session, invitation.id, input));
      await waitForBlockedBy(gate.pid); await afterDeadline(deadline); gate.release();
      const result = await pending;
      const [saved] = await query<{ state: string; revoked: boolean }>("SELECT i.state,s.revoked_at IS NOT NULL revoked FROM fp_supporter_invites i JOIN fp_supporter_access a ON a.invitation_id=i.id JOIN fp_sessions s ON s.id=a.session_id WHERE i.id=$1", [invitation.id]);
      assert.deepEqual({ requestCompleted: result.ok, ...saved }, { requestCompleted: false, state: "joined", revoked: false });
      assert.equal((await sessionForToken(joined.sessionToken))?.id, joined.session.id);
    });
  });
});

describe("supporter onboarding adversarial privacy and scope", () => {
  it("does not replace an active other actor through invitation replay or a stolen return capability", async () => {
    const f = await workspace(), invitation = await invite(f), context = anonymous(), input = acceptance(invitation.token, context);
    const joined = await acceptSupporterInvite(input, context), other = await addOtherActor(f);
    const otherContext: SupporterEntryContext = { session: other.session, credentialHash: tokenHash(other.credential), browserKey: context.browserKey };
    const before = await counts(f.session.projectId);
    rejectedWith(await outcome(acceptSupporterInvite(input, otherContext)), ["SUPPORTER_CONTEXT_CHANGED"]);
    const view = await reviewSupporterEntry({ kind: "access", token: joined.recoveryToken }, otherContext);
    assert.deepEqual({ state: view.state, recipient: view.recipient, project: view.project, canRestore: view.canRestore }, { state: "switch_required", recipient: null, project: null, canRestore: false });
    rejectedWith(await outcome(restoreSupporterAccess({ token: joined.recoveryToken, intentId: randomUUID(), expectedScope: supporterEntryScope(otherContext), acknowledged: true }, otherContext)), ["SUPPORTER_CONTEXT_CHANGED"]);
    assert.deepEqual(await counts(f.session.projectId), before);
    assert.equal((await sessionForToken(other.credential))?.actorId, other.session.actorId);
  });

  it("keeps private names and raw capabilities out of persisted side channels and stranger views", async () => {
    const f = await workspace(), label = `Hidden-label-${randomUUID()}`, displayName = `Hidden-person-${randomUUID()}`;
    const invitation = await invite(f, "sponsor", label), context = anonymous(), input = acceptance(invitation.token, context, displayName);
    const joined = await acceptSupporterInvite(input, context), stranger = anonymous();
    const view = await reviewSupporterEntry({ kind: "invite", token: invitation.token, intentId: input.intentId }, stranger);
    assert.deepEqual({ state: view.state, recipient: view.recipient, project: view.project, purpose: view.purpose }, { state: "used", recipient: null, project: null, purpose: null });
    const rows: unknown[] = [];
    for (const table of ["fp_supporter_invites", "fp_supporter_access", "fp_supporter_commands", "fp_supporter_access_audit", "fp_events", "fp_outbox"])
      rows.push(...await query<{ body: unknown }>(`SELECT to_jsonb(record) body FROM ${table} record WHERE project_id=$1`, [f.session.projectId]));
    const persisted = JSON.stringify(rows);
    for (const value of [label, displayName, invitation.token, joined.sessionToken, joined.recoveryToken, f.issuerBrowserKey, context.browserKey])
      assert.equal(persisted.includes(value), false, "Plaintext private values must not appear in stored records or public event detail.");
    const organizerView = JSON.stringify(await supporterDesk(f.session));
    assert.ok(organizerView.includes(displayName));
    for (const token of [invitation.token, joined.sessionToken, joined.recoveryToken]) assert.equal(organizerView.includes(token), false);
  });

  it("prevents sponsor invitations, forged acceptance fields and altered membership rows from widening the exact donor grant", async () => {
    const f = await workspace(), invitation = await invite(f, "sponsor"), context = anonymous(), input = acceptance(invitation.token, context);
    const forged = { ...input, role: "organizer", tenantId: randomUUID(), projectId: randomUUID(), actorId: f.session.actorId };
    assert.equal((await outcome(acceptSupporterInvite(forged, context))).ok, false);
    assert.equal((await counts(f.session.projectId)).accesses, 0);
    const joined = await acceptSupporterInvite(input, context);
    assert.equal(joined.welcome.purpose, "sponsor"); assert.equal(joined.session.role, "donor");
    for (const role of ["organizer", "auditor", "volunteer"] as const)
      rejectedWith(await outcome(setRole(joined.session, role)), ["MEMBERSHIP_DENIED"]);
    const [membership] = await query<{ roles: string[]; version: number }>("SELECT roles,version FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [joined.session.tenantId, joined.session.projectId, joined.session.actorId]);
    assert.deepEqual(membership, { roles: ["donor"], version: 1 });
    // Adversarial corruption is isolated to this newly-created test actor.
    await query("UPDATE fp_memberships SET roles='[\"donor\",\"organizer\"]'::jsonb WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [joined.session.tenantId, joined.session.projectId, joined.session.actorId]);
    const freshBrowser = anonymous();
    rejectedWith(await outcome(restoreSupporterAccess({ token: joined.recoveryToken, intentId: randomUUID(), expectedScope: supporterEntryScope(freshBrowser), acknowledged: true }, freshBrowser)), ["SUPPORTER_ACCESS_UNAVAILABLE"]);
    assert.equal((await counts(f.session.projectId)).restored, 0);
  });
});
