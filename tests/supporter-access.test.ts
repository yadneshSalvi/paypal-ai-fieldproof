import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PostgresDatabase } from "@fracture/paypal-core";
import { SUPPORTER_ACCESS_VERSION } from "../lib/supporters/contracts";
import { acceptSupporterInvite, createSupporterInvite, restoreSupporterAccess, reviewSupporterEntry, revokeSupporterInvite, supporterDesk, supporterEntryScope, supporterInviteLink, type SupporterEntryContext } from "../lib/server/supporter-access";
import { database, initializeDatabase, query } from "../lib/server/db";
import { createProject } from "../lib/server/seed";
import { sessionForToken, setRole, tokenHash, type Session } from "../lib/server/auth";
import { createFundingPolicy, fundingDesk } from "../lib/server/funding-lifecycle";
import { createPurposePledge } from "../lib/server/purpose-pledges";
import { acceptSponsorOffer, createSponsorOffer } from "../lib/server/sponsors";

const original = process.env.DATABASE_URL!, schema = `fp_supporter_test_${randomUUID().replaceAll("-", "")}`, admin = new PostgresDatabase(original);
before(async () => { await admin.query(`CREATE SCHEMA "${schema}"`); const url = new URL(original); url.searchParams.set("options", `-c search_path=${schema}`); process.env.DATABASE_URL = url.href; await initializeDatabase(); });
after(async () => { await database().close(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.close(); process.env.DATABASE_URL = original; });
const browser = () => randomBytes(32).toString("base64url");
const recipient = (): SupporterEntryContext => ({ session: null, credentialHash: null, browserKey: browser() });
const code = (expected: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === expected;
async function fixture() {
  const session: Session = { id: randomUUID(), tenantId: randomUUID(), projectId: randomUUID(), actorId: randomUUID(), role: "organizer", mode: "sample", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  const sessionToken = randomBytes(32).toString("base64url"), browserKey = browser();
  await database().transaction(async tx => {
    await createProject(tx, session.tenantId, session.projectId, `synthetic-onboarding-${randomUUID()}`, "live_sandbox");
    await tx.query("UPDATE fp_tenants SET mode='sample' WHERE id=$1", [session.tenantId]);
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,'[\"organizer\"]'::jsonb)", [session.tenantId, session.projectId, session.actorId]);
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'organizer',$6)", [session.id, tokenHash(sessionToken), session.tenantId, session.projectId, session.actorId, session.expiresAt]);
  });
  return { session, sessionToken, browserKey, desk: await supporterDesk(session) };
}
async function invitation(f: Awaited<ReturnType<typeof fixture>>, purpose: "donor" | "sponsor" = "donor") {
  const input = { intentId: randomUUID(), expectedScope: f.desk.scope, label: `Private synthetic ${purpose} ${randomUUID()}`, purpose, expiresHours: 72, acknowledged: true as const };
  return { input, ...(await createSupporterInvite(f.session, f.browserKey, input)) };
}
function acceptance(token: string, context: SupporterEntryContext) {
  return { token, intentId: randomUUID(), expectedScope: supporterEntryScope(context), displayName: `Synthetic recipient ${randomUUID()}`, contractVersion: SUPPORTER_ACCESS_VERSION, acknowledged: true as const };
}
describe("native possession-based supporter onboarding", () => {
  it("creates one exact invitation for concurrent retries without approving or creating money", async () => {
    const f = await fixture(), input = { intentId: randomUUID(), expectedScope: f.desk.scope, label: "Synthetic independent donor", purpose: "donor" as const, expiresHours: 24, acknowledged: true as const };
    const results = await Promise.all(Array.from({ length: 6 }, () => createSupporterInvite(f.session, f.browserKey, input)));
    assert.equal(new Set(results.map(result => result.id)).size, 1); assert.equal(new Set(results.map(result => result.token)).size, 1); assert.equal(new Set(results.map(result => result.expiresAt)).size, 1);
    assert.equal((await query("SELECT id FROM fp_supporter_invites WHERE project_id=$1", [f.session.projectId])).length, 1);
    for (const table of ["fp_obligations", "fp_settlement_receipts", "fp_journal", "fp_payment_commands"]) assert.equal((await query(`SELECT * FROM ${table} WHERE project_id=$1`, [f.session.projectId])).length, 0);
    await assert.rejects(createSupporterInvite(f.session, f.browserKey, { ...input, purpose: "sponsor" }), code("SUPPORTER_INTENT_CHANGED"));
  });
  it("creates independent donor and sponsor actors with the exact original fixed access deadline", async () => {
    const f = await fixture(), donorLink = await invitation(f), sponsorLink = await invitation(f, "sponsor");
    const a = recipient(), b = recipient(), first = acceptance(donorLink.token, a), second = acceptance(sponsorLink.token, b);
    const donor = await acceptSupporterInvite(first, a), sponsor = await acceptSupporterInvite(second, b);
    assert.equal(new Set([f.session.actorId, donor.session.actorId, sponsor.session.actorId]).size, 3);
    for (const [result, link] of [[donor, donorLink], [sponsor, sponsorLink]] as const) {
      assert.equal(result.session.projectId, f.session.projectId); assert.equal(result.session.tenantId, f.session.tenantId); assert.equal(result.session.role, "donor"); assert.equal(result.session.expiresAt, link.expiresAt);
      assert.deepEqual((await query<{ roles: string[] }>("SELECT roles FROM fp_memberships WHERE project_id=$1 AND actor_id=$2", [result.session.projectId, result.session.actorId]))[0].roles, ["donor"]);
      assert.equal((await sessionForToken(result.sessionToken))?.actorId, result.session.actorId);
      await assert.rejects(setRole(result.session, "organizer"), code("MEMBERSHIP_DENIED"));
    }
    assert.equal(sponsor.welcome.purpose, "sponsor"); assert.equal(sponsor.welcome.identityProvenance, "self_declared");
  });
  it("keeps an invited sponsor's grant and each donor's pledge attached to their own actor", async () => {
    const f = await fixture(), a = recipient(), b = recipient(), al = await invitation(f), bl = await invitation(f, "sponsor");
    const donor = await acceptSupporterInvite(acceptance(al.token, a), a), sponsor = await acceptSupporterInvite(acceptance(bl.token, b), b);
    const opened = await createFundingPolicy(f.session, { intentId: randomUUID(), packageId: "materials", expectedVersion: 1, kind: "mixed", acknowledged: true });
    const policy = (await fundingDesk(f.session)).policies.find(item => item.id === opened.id)!;
    await createPurposePledge(donor.session, { intentId: randomUUID(), policyId: policy.id, policyDigest: policy.digest, amountMinor: 200, acknowledged: true });
    const offered = await createSponsorOffer(f.session, { intentId: randomUUID(), kind: "grant", name: "Controlled synthetic sponsor offer", note: "Test grant; no provider request or payment has occurred.", totalCapMinor: 100, matchBasisPoints: 10000, expiresAt: new Date(Date.now() + 3_000_000).toISOString(), packages: [{ policyId: policy.id, policyDigest: policy.digest, capMinor: 100 }], acknowledged: true });
    const offer = (await fundingDesk(f.session)).sponsors.find(item => item.id === offered.id)!;
    await acceptSponsorOffer(sponsor.session, { intentId: randomUUID(), offerId: offer.id, digest: offer.digest, expectedVersion: offer.version, acknowledged: true });
    const donorDesk = await fundingDesk(donor.session), sponsorDesk = await fundingDesk(sponsor.session), full = await fundingDesk(f.session);
    assert.deepEqual(donorDesk.pledges.map(pledge => pledge.amountMinor), [200]); assert.deepEqual(sponsorDesk.pledges.map(pledge => pledge.amountMinor), [100]); assert.equal(sponsorDesk.pledges[0].kind, "grant"); assert.equal(full.pledges.length, 2);
    assert.equal((await query("SELECT id FROM fp_settlement_receipts WHERE project_id=$1", [f.session.projectId])).length, 0);
  });
  it("recovers a lost acceptance response using only the exact browser, intent and unchanged declaration", async () => {
    const f = await fixture(), link = await invitation(f), context = recipient(), input = acceptance(link.token, context);
    const first = await acceptSupporterInvite(input, context), second = await acceptSupporterInvite(input, context);
    assert.deepEqual(first, second);
    const entered = { ...context, session: first.session, credentialHash: tokenHash(first.sessionToken) };
    assert.deepEqual(await acceptSupporterInvite(input, entered), first);
    await assert.rejects(acceptSupporterInvite({ ...input, displayName: "A different declaration" }, context), code("SUPPORTER_INVITE_USED"));
    assert.equal((await query("SELECT id FROM fp_supporter_access WHERE invitation_id=$1", [link.id])).length, 1);
    const view = await reviewSupporterEntry({ kind: "invite", token: link.token, intentId: input.intentId }, entered);
    assert.equal(view.state, "joined_here"); assert.equal(view.recipient?.displayName, input.displayName);
  });
  it("restores the same original session from the recipient return capability on another browser", async () => {
    const f = await fixture(), link = await invitation(f), context = recipient(), joined = await acceptSupporterInvite(acceptance(link.token, context), context), fresh = recipient();
    const input = { token: joined.recoveryToken, intentId: randomUUID(), expectedScope: supporterEntryScope(fresh), acknowledged: true as const };
    const restored = await restoreSupporterAccess(input, fresh); assert.deepEqual(restored, joined);
    const entered = { ...fresh, session: joined.session, credentialHash: tokenHash(joined.sessionToken) };
    assert.deepEqual(await restoreSupporterAccess(input, entered), joined);
    assert.equal((await query("SELECT id FROM fp_sessions WHERE project_id=$1 AND actor_id=$2", [joined.session.projectId, joined.session.actorId])).length, 1);
    assert.equal((await query("SELECT id FROM fp_supporter_access_audit WHERE invitation_id=$1 AND kind='restored'", [link.id])).length, 1);
  });
  it("withdraws accepted access without replacing its actor, deadline or funding history", async () => {
    const f = await fixture(), link = await invitation(f), context = recipient(), joined = await acceptSupporterInvite(acceptance(link.token, context), context);
    const accessBefore = await query("SELECT * FROM fp_supporter_access WHERE invitation_id=$1", [link.id]);
    const input = { intentId: randomUUID(), expectedScope: f.desk.scope, expectedVersion: 2, acknowledged: true as const };
    await revokeSupporterInvite(f.session, link.id, input); await revokeSupporterInvite(f.session, link.id, input);
    assert.equal(await sessionForToken(joined.sessionToken), null); assert.deepEqual(await query("SELECT * FROM fp_supporter_access WHERE invitation_id=$1", [link.id]), accessBefore);
    await assert.rejects(restoreSupporterAccess({ token: joined.recoveryToken, intentId: randomUUID(), expectedScope: supporterEntryScope(context), acknowledged: true }, context), code("SUPPORTER_ACCESS_UNAVAILABLE"));
    assert.equal((await supporterDesk(f.session)).invitations[0].state, "revoked");
    assert.equal((await query<{ expires_at: Date }>("SELECT expires_at FROM fp_sessions WHERE id=$1", [joined.session.id]))[0].expires_at.toISOString(), link.expiresAt);
  });
  it("never exposes invitation, session or recovery credentials through organizer lists or public events", async () => {
    const f = await fixture(), link = await invitation(f), context = recipient(), input = acceptance(link.token, context), joined = await acceptSupporterInvite(input, context);
    const desk = await supporterDesk(f.session), plainRows = await query("SELECT * FROM fp_supporter_invites WHERE id=$1", [link.id]), audits = await query("SELECT * FROM fp_supporter_access_audit WHERE invitation_id=$1", [link.id]), events = await query("SELECT data FROM fp_events WHERE project_id=$1", [f.session.projectId]);
    for (const value of [link.token, joined.sessionToken, joined.recoveryToken]) for (const payload of [desk, plainRows, audits, events]) assert.ok(!JSON.stringify(payload).includes(value));
    assert.equal(desk.invitations[0].recipient?.identityProvenance, "self_declared"); assert.ok(!JSON.stringify(events).includes(input.displayName));
    await assert.rejects(supporterDesk(joined.session), code("ROLE_DENIED"));
    await assert.rejects(supporterInviteLink(f.session, link.id, { expectedScope: f.desk.scope, expectedVersion: 2 }), code("SUPPORTER_INVITE_UNAVAILABLE"));
  });
  it("keeps invitation terms, grant provenance and private audit immutable in PostgreSQL", async () => {
    const f = await fixture(), link = await invitation(f), context = recipient(); await acceptSupporterInvite(acceptance(link.token, context), context);
    await assert.rejects(query("UPDATE fp_supporter_invites SET expires_at=expires_at+interval '1 hour' WHERE id=$1", [link.id]), /immutable/);
    await assert.rejects(query("UPDATE fp_supporter_access SET actor_id=$2 WHERE invitation_id=$1", [link.id, randomUUID()]), /append-only/);
    await assert.rejects(query("DELETE FROM fp_supporter_access_audit WHERE invitation_id=$1", [link.id]), /append-only/);
    assert.equal((await supporterDesk(f.session)).invitations[0].expiresAt, link.expiresAt);
  });
});
