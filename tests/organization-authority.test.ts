import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { ORG_GOVERNANCE_VERSION } from "../lib/organizations/contracts";
import { DomainError } from "../lib/domain/money";
import { query, database } from "../lib/server/db";
import { orgToken, organizationTransaction, requireOrganization, type OrganizationRequest } from "../lib/server/organization-core";
import { acceptOrganizationInvitation, createOrganization, organizationBootstrap, organizationLibraryAction, restoreOrganizationAccess, reviewOrganizationEntry } from "../lib/server/organization-entry";
import { changeOrganizationMember, createOrganizationInvitation, organizationInvitationsPage, organizationMembersPage, revokeOrganizationInvitation } from "../lib/server/organization-members";
import { organizationTestDatabase } from "./helpers/organization-database";

organizationTestDatabase();
const browser = (): OrganizationRequest => ({ organizationToken: null, libraryToken: null, projectToken: null, browserKey: orgToken() });
function receive(request: OrganizationRequest, result: { cookies?: { kind: string; token: string | null }[] }) {
  for (const cookie of result.cookies ?? []) if (cookie.kind === "session") request.organizationToken = cookie.token; else if (cookie.kind === "library") request.libraryToken = cookie.token;
}
const code = (wanted: string) => (error: unknown) => error instanceof DomainError && error.code === wanted;
async function owner(label = "Controlled Sample organization") {
  const request = browser(), before = await organizationBootstrap(request);
  const input = { intentId: randomUUID(), expectedScope: before.context.scope, expectedLibraryScope: before.library.scope,
    organizationName: label, description: "Fictional controlled authority test", displayName: "Controlled Sample owner", expiresHours: 12, contractVersion: ORG_GOVERNANCE_VERSION, acknowledged: true as const };
  const result = await createOrganization(request, input); receive(request, result);
  return { request, input, result };
}
async function invite(request: OrganizationRequest, role: "owner" | "coordinator" | "auditor") {
  const context = await organizationBootstrap(request);
  return createOrganizationInvitation(request, { intentId: randomUUID(), expectedScope: context.context.scope, label: `Controlled ${role} recipient`, role, expiresHours: 7, acknowledged: true });
}
async function join(invitation: Awaited<ReturnType<typeof invite>>, label: string) {
  const request = browser(), token = invitation.invitation.path.split("#invite=")[1];
  const view = await reviewOrganizationEntry(request, { kind: "invite", token });
  const input = { intentId: randomUUID(), expectedScope: view.entry.scope, token, displayName: label, contractVersion: ORG_GOVERNANCE_VERSION, acknowledged: true as const };
  const result = await acceptOrganizationInvitation(request, input); receive(request, result);
  return { request, input, result, token };
}
describe("real organization authority and independent fixed entry", () => {
  it("creates one independent owner and recovers the exact credential/deadline after a lost response", async () => {
    const original = await owner();
    const again = await createOrganization(original.request, original.input);
    assert.deepEqual(again.body, original.result.body); assert.deepEqual(again.cookies, original.result.cookies);
    const [{ members, sessions }] = await query<{ members: string; sessions: string }>("SELECT (SELECT count(*) FROM fp_org_memberships WHERE organization_id=$1) members,(SELECT count(*) FROM fp_org_sessions WHERE organization_id=$1) sessions", [original.result.body.welcome.profile.organizationId]);
    assert.equal(Number(members), 1); assert.equal(Number(sessions), 1);
    await assert.rejects(createOrganization(original.request, { ...original.input, displayName: "Changed name" }), code("ORG_INTENT_CHANGED"));
    assert.equal(original.request.projectToken, null);
  });
  it("serializes independent acceptance, denies another browser and preserves the original saved request", async () => {
    const original = await owner(), invitation = await invite(original.request, "coordinator"), recipient = browser();
    const token = invitation.invitation.path.split("#invite=")[1], review = await reviewOrganizationEntry(recipient, { kind: "invite", token });
    const input = { intentId: randomUUID(), expectedScope: review.entry.scope, token, displayName: "Controlled independent recipient", contractVersion: ORG_GOVERNANCE_VERSION, acknowledged: true as const };
    const [a, b] = await Promise.all([acceptOrganizationInvitation(recipient, input), acceptOrganizationInvitation(recipient, input)]);
    assert.deepEqual(a, b); receive(recipient, a);
    const here = await reviewOrganizationEntry(recipient, { kind: "invite", token, intentId: input.intentId });
    assert.equal(here.entry.state, "joined_here");
    const other = browser(), denied = await reviewOrganizationEntry(other, { kind: "invite", token, intentId: input.intentId });
    assert.equal(denied.entry.state, "used"); assert.equal(denied.entry.organization, null); assert.equal(denied.entry.recipient, null);
    const scope = (await organizationBootstrap(other)).context.scope;
    await assert.rejects(acceptOrganizationInvitation(other, { ...input, expectedScope: scope }), code("ORG_ENTRY_USED"));
    assert.equal(a.body.welcome.profile.sessionExpiresAt, invitation.invitation.expiresAt);
    await assert.rejects(organizationTransaction(tx => requireOrganization(tx, recipient, here.entry.scope, ["owner"])), code("ORG_ROLE_DENIED"));
  });
  it("denies an issuer after explicit leave and hides target identity from a different active profile", async () => {
    const first = await owner(), second = await owner("Other controlled Sample organization"), invitation = await invite(first.request, "auditor"), token = invitation.invitation.path.split("#invite=")[1];
    const mixed = await reviewOrganizationEntry(second.request, { kind: "invite", token });
    assert.equal(mixed.entry.state, "switch_required"); assert.equal(mixed.entry.organization, null); assert.equal(mixed.entry.role, null);
    const before = await organizationBootstrap(first.request);
    const left = await organizationLibraryAction(first.request, "leave", { intentId: randomUUID(), expectedScope: before.context.scope, expectedLibraryScope: before.library.scope, acknowledged: true }); receive(first.request, left);
    const issuer = await reviewOrganizationEntry(first.request, { kind: "invite", token }); assert.equal(issuer.entry.state, "issuer");
    await assert.rejects(acceptOrganizationInvitation(first.request, { intentId: randomUUID(), expectedScope: issuer.entry.scope, token, displayName: "Same inviting browser", contractVersion: ORG_GOVERNANCE_VERSION, acknowledged: true }), code("ORG_ROLE_DENIED"));
  });
  it("serializes last-owner protection and recovers only the original minimal self-change receipt", async () => {
    const first = await owner(), firstContext = await organizationBootstrap(first.request), own = firstContext.context.profile!;
    await assert.rejects(changeOrganizationMember(first.request, own.membershipId, "end", { intentId: randomUUID(), expectedScope: firstContext.context.scope, expectedVersion: own.membershipVersion, reason: "Controlled last owner guard", acknowledged: true }), code("ORG_LAST_OWNER"));
    const second = await join(await invite(first.request, "owner"), "Controlled second owner"), context = await organizationBootstrap(first.request);
    const input = { intentId: randomUUID(), expectedScope: context.context.scope, expectedVersion: own.membershipVersion, role: "coordinator" as const, reason: "Controlled ownership handover", acknowledged: true as const };
    const changed = await changeOrganizationMember(first.request, own.membershipId, "role", input);
    assert.deepEqual(await changeOrganizationMember(first.request, own.membershipId, "role", input), changed);
    assert.deepEqual(Object.keys(changed), ["receipt"]);
    const newContext = await organizationBootstrap(first.request); assert.equal(newContext.context.profile!.role, "coordinator");
    assert.equal(newContext.context.profile!.sessionExpiresAt, own.sessionExpiresAt);
    await assert.rejects(organizationTransaction(async tx => organizationMembersPage(tx, await requireOrganization(tx, first.request, newContext.context.scope))), code("ORG_ROLE_DENIED"));
    assert.equal((await organizationBootstrap(second.request)).context.profile!.role, "owner");
  });
  it("invalidates unused invitations when issuer authority changes without ending an accepted independent co-owner", async () => {
    const first = await owner(), pending = await invite(first.request, "auditor"), second = await join(await invite(first.request, "owner"), "Accepted independent owner"), context = await organizationBootstrap(first.request);
    await changeOrganizationMember(first.request, context.context.profile!.membershipId, "role", { intentId: randomUUID(), expectedScope: context.context.scope, expectedVersion: context.context.profile!.membershipVersion, role: "coordinator", reason: "Controlled issuer role transition", acknowledged: true });
    const view = await reviewOrganizationEntry(browser(), { kind: "invite", token: pending.invitation.path.split("#invite=")[1] });
    assert.equal(view.entry.state, "authority_changed"); assert.equal(view.entry.organization, null);
    assert.equal((await organizationBootstrap(second.request)).context.state, "active");
  });
  it("rechecks the original inviter after a concurrent authority change releases the organization lock", async () => {
    const first = await owner(), invitation = await invite(first.request, "auditor");
    await join(await invite(first.request, "owner"), "Controlled remaining owner");
    const recipient = browser(), token = invitation.invitation.path.split("#invite=")[1], before = await reviewOrganizationEntry(recipient, { kind: "invite", token });
    const original = first.result.body.welcome.profile;
    let release!: () => void, acquired!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { acquired = resolve; });
    // This disposable-schema transaction models a concurrent committed member
    // update. It changes no credential, actor or original deadline.
    const writer = database().transaction(async tx => {
      await tx.query("SELECT id FROM fp_organizations WHERE id=$1 FOR UPDATE", [original.organizationId]); acquired(); await gate;
      await tx.query("UPDATE fp_org_memberships SET role='coordinator',version=version+1 WHERE id=$1", [original.membershipId]);
    });
    await ready;
    const rejected = assert.rejects(acceptOrganizationInvitation(recipient, { intentId: randomUUID(), expectedScope: before.entry.scope, token, displayName: "Controlled waiting recipient", contractVersion: ORG_GOVERNANCE_VERSION, acknowledged: true }), code("ORG_ISSUER_CHANGED"));
    await new Promise(resolve => setTimeout(resolve, 75)); release(); await writer; await rejected;
    const [saved] = await query<{ state: string; count: string }>("SELECT state,(SELECT count(*) FROM fp_org_access WHERE invitation_id=i.id) count FROM fp_org_invitations i WHERE id=$1", [invitation.invitation.id]);
    assert.equal(saved.state, "invited"); assert.equal(Number(saved.count), 0);
    assert.equal((await organizationBootstrap(first.request)).context.profile!.sessionExpiresAt, original.sessionExpiresAt);
  });
  it("ends a joined invitation, then explicitly clears the ended cookie and restores the original saved profile without renewal", async () => {
    const first = await owner(), invitation = await invite(first.request, "auditor"), recipient = await join(invitation, "Controlled withdrawn auditor");
    const originalDeadline = recipient.result.body.welcome.profile.sessionExpiresAt, ownerContext = await organizationBootstrap(first.request);
    const invitations = await organizationTransaction(async tx => organizationInvitationsPage(tx, await requireOrganization(tx, first.request, ownerContext.context.scope)));
    const joined = invitations.invitations.find(row => row.id === invitation.invitation.id)!;
    await revokeOrganizationInvitation(first.request, joined.id, { intentId: randomUUID(), expectedScope: ownerContext.context.scope, expectedVersion: joined.version, reason: "Controlled access withdrawal test", acknowledged: true });
    const ended = await organizationBootstrap(recipient.request); assert.equal(ended.context.state, "ended");
    const restoreToken = recipient.result.body.returnPath.split("#access=")[1];
    const denied = await reviewOrganizationEntry({ ...recipient.request, organizationToken: null }, { kind: "access", token: restoreToken });
    assert.equal(denied.entry.state, "revoked"); assert.equal(denied.entry.organization, null);
    const cleared = await organizationLibraryAction(recipient.request, "clear_ended", { intentId: randomUUID(), expectedScope: ended.context.scope, expectedLibraryScope: ended.library.scope, acknowledged: true }); receive(recipient.request, cleared);
    assert.equal((await organizationBootstrap(recipient.request)).context.state, "none");
    const originalOwner = first.result.body.returnPath.split("#access=")[1], ready = await reviewOrganizationEntry(recipient.request, { kind: "access", token: originalOwner });
    const restored = await restoreOrganizationAccess(recipient.request, { intentId: randomUUID(), expectedScope: ready.entry.scope, token: originalOwner, acknowledged: true });
    assert.equal(restored.body.welcome.profile.membershipId, first.result.body.welcome.profile.membershipId);
    assert.equal(restored.body.welcome.profile.sessionExpiresAt, first.result.body.welcome.profile.sessionExpiresAt);
    const [session] = await query<{ expires_at: Date; revoked_at: Date }>("SELECT expires_at,revoked_at FROM fp_org_sessions WHERE membership_id=$1", [recipient.result.body.welcome.profile.membershipId]);
    assert.equal(session.expires_at.toISOString(), originalDeadline); assert.ok(session.revoked_at);
  });
  it("database guards retain original identities, credentials, deadlines and consumed invitations", async () => {
    const first = await owner(), id = first.result.body.welcome.profile.membershipId;
    for (const statement of ["UPDATE fp_org_memberships SET expires_at=expires_at+interval '1 hour',version=version+1 WHERE id=$1", "DELETE FROM fp_org_memberships WHERE id=$1", "UPDATE fp_org_sessions SET expires_at=expires_at+interval '1 hour' WHERE membership_id=$1", "DELETE FROM fp_org_access WHERE membership_id=$1"])
      await assert.rejects(database().query(statement, [id]), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "23514");
  });
});
