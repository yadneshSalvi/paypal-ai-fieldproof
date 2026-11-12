import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { communityFixture } from "./helpers/community";
import { isolatedPlanningDatabase, errorCode } from "./helpers/planning";
import { query } from "../lib/server/db";
import { currentViewRoles } from "../lib/server/membership";
import { setRole, sessionForToken } from "../lib/server/auth";
import { projectSnapshot } from "../lib/server/repository";
import { fundingDesk } from "../lib/server/funding-lifecycle";
import { assertWorkspaceLibraryContext, readWorkspaceLibrary, rememberWorkspace, switchCommunityWorkspace } from "../lib/server/community-workspaces";
import { acceptSupporterInvite, createSupporterInvite, supporterDesk, supporterEntryScope } from "../lib/server/supporter-access";
import { SUPPORTER_ACCESS_VERSION } from "../lib/supporters/contracts";
const styles = registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : next(url, context); } });
const { FundingWorkspace } = await import("../components/funding/workspace");
const { TemplateProject } = await import("../components/community/template-project");
const { TemplateLibrary } = await import("../components/community/template-library");
styles.deregister();
isolatedPlanningDatabase();

describe("current membership views and explicit ended-workspace recovery", () => {
  it("renders only the donor view for donor-only access, while preserving a full organizer membership's views", async () => {
    const f = await communityFixture("community-garden");
    assert.deepEqual(await currentViewRoles(f.session), ["donor", "volunteer", "organizer", "auditor"]);
    assert.deepEqual((await fundingDesk(f.session)).allowedRoles, ["donor", "volunteer", "organizer", "auditor"]);
    await query("UPDATE fp_memberships SET roles='[\"donor\"]'::jsonb,version=version+1 WHERE project_id=$1 AND actor_id=$2", [f.session.projectId, f.session.actorId]);
    await query("UPDATE fp_sessions SET role='donor' WHERE id=$1", [f.session.id]);
    const donor = { ...f.session, role: "donor" as const }, snapshot = await projectSnapshot(donor), desk = await fundingDesk(donor);
    assert.deepEqual(snapshot.session?.allowedRoles, ["donor"]); assert.deepEqual(desk.allowedRoles, ["donor"]);
    const htmls = [renderToStaticMarkup(createElement(FundingWorkspace, { initial: desk })), renderToStaticMarkup(createElement(TemplateProject, { snapshot, view: "project", busy: false, message: null, messageIsError: false, onRoleChange() {}, async onRefresh() {} }))];
    for (const html of htmls) {
      assert.match(html, /<option value="donor"/);
      assert.doesNotMatch(html, /<option value="(?:organizer|auditor|volunteer)"/);
    }
    await assert.rejects(setRole(donor, "organizer"), errorCode("MEMBERSHIP_DENIED"));
    const after = await fundingDesk(donor);
    assert.equal(after.role, "donor"); assert.equal(after.projectId, desk.projectId);
    assert.equal((await sessionForToken(f.token))?.id, donor.id, "A rejected target role does not end the valid donor session");
  });
  it("requires explicit removal of an ended credential before restoring an exact valid saved capability", async () => {
    const first = await communityFixture(), second = await communityFixture("mutual-aid", first.libraryToken, first.token, first.session.projectId);
    await query("UPDATE fp_memberships SET state='revoked',version=version+1 WHERE project_id=$1 AND actor_id=$2", [second.session.projectId, second.session.actorId]);
    const list = await readWorkspaceLibrary(first.libraryToken, second.token);
    assert.equal(list.context?.state, "ended"); assert.equal(list.currentProjectId, null);
    assert.ok(list.entries.find(e => e.sessionId === first.session.id)?.available);
    await assert.rejects(switchCommunityWorkspace(first.libraryToken, second.token, first.session.id, null), errorCode("WORKSPACE_CLEAR_ENDED_REQUIRED"));
    await assertWorkspaceLibraryContext(first.libraryToken, second.token, list.context!.hash, true);
    await assert.rejects(assertWorkspaceLibraryContext(first.libraryToken, first.token, list.context!.hash, true), errorCode("WORKSPACE_LIBRARY_CONTEXT_CHANGED"));
    const cleared = await readWorkspaceLibrary(first.libraryToken, null);
    assert.equal(cleared.context?.state, "none");
    const restored = await switchCommunityWorkspace(first.libraryToken, null, first.session.id, null);
    assert.equal(restored.token, first.token); assert.equal(restored.session.id, first.session.id); assert.equal(restored.session.expiresAt, first.session.expiresAt);
    assert.equal(await sessionForToken(second.token), null);
    const html = renderToStaticMarkup(createElement(TemplateLibrary, { initial: list, returnPath: "/funding" }));
    assert.match(html, /Clear ended workspace/); assert.match(html, /keeps its original expiry/); assert.match(html, /disabled="" aria-label="Open/);
  });
  it("labels separately saved donor profiles with only their self-declared names inside the authorized library", async () => {
    const f = await communityFixture("community-garden"), desk = await supporterDesk(f.session), issuer = randomBytes(32).toString("base64url");
    const names = ["Sample Noor", "Sample Priya"];
    for (const name of names) {
      const invite = await createSupporterInvite(f.session, issuer, { intentId: randomUUID(), expectedScope: desk.scope, label: `Control ${name}`, purpose: "donor", expiresHours: 24, acknowledged: true });
      const context = { session: null, credentialHash: null, browserKey: randomBytes(32).toString("base64url") };
      const joined = await acceptSupporterInvite({ token: invite.token, intentId: randomUUID(), expectedScope: supporterEntryScope(context), displayName: name, contractVersion: SUPPORTER_ACCESS_VERSION, acknowledged: true }, context);
      await rememberWorkspace(f.libraryToken, joined.sessionToken);
    }
    const list = await readWorkspaceLibrary(f.libraryToken, f.token), profiles = list.entries.filter(e => e.role === "donor");
    assert.deepEqual(profiles.map(e => e.profileLabel).sort(), names);
    assert.ok(profiles.every(e => e.identityProvenance === "self_declared"));
    const foreign = await communityFixture();
    const foreignList = JSON.stringify(await readWorkspaceLibrary(foreign.libraryToken, foreign.token));
    for (const name of names) assert.equal(foreignList.includes(name), false);
    assert.equal(JSON.stringify(list).includes(f.token), false); assert.equal(JSON.stringify(list).includes(f.libraryToken), false);
  });
});
