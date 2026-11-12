import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as C from "../lib/organizations/contracts";
import { orgCommandContract, orgEntryForLocation, readOrgAttempt, readOrgEntryDraft, readOrgPendingAttempt, saveOrgAttempt, type OrgEntryDraft } from "../lib/organizations/entry-draft";
import { ORG_UI_HASH, ORG_UI_PROJECT_SCOPE, ORG_UI_SCOPE, orgUiApplication, orgUiDesk, orgUiId, orgUiParticipation, orgUiSnapshot } from "./helpers/organization-ui";

const token = "q".repeat(64), otherToken = "r".repeat(64), intentId = orgUiId(80), newIntent = orgUiId(81);
function forbiddenIntent(): never { assert.fail("An unchanged original attempt must never mint another intent."); }
function acceptance(): OrgEntryDraft { return { version: 1, kind: "invite", token, intentId, acceptance: { token, intentId, expectedScope: ORG_UI_SCOPE, displayName: "Synthetic original declared name", contractVersion: C.ORG_GOVERNANCE_VERSION, acknowledged: true } }; }
function restoration(): OrgEntryDraft { return { version: 1, kind: "access", token, intentId, restoration: { token, intentId, expectedScope: ORG_UI_SCOPE, acknowledged: true } }; }
describe("organization entry and exact pending-command recovery", () => {
  it("retains original acceptance identity, contract, empty-cookie scope and intent after the response may have written a new cookie", () => {
    const original = acceptance(), saved = readOrgEntryDraft(JSON.stringify(original)); assert.ok(saved);
    for (const fragment of ["", "#", `#invite=${token}`]) assert.deepEqual(orgEntryForLocation(fragment, saved, forbiddenIntent), original);
    assert.equal(saved.acceptance?.displayName, "Synthetic original declared name"); assert.equal(saved.acceptance?.expectedScope, ORG_UI_SCOPE);
  });
  it("restores the original return command without issuing a fresh session intent or adopting a newer review scope", () => {
    const original = restoration(), saved = readOrgEntryDraft(JSON.stringify(original)); assert.ok(saved);
    assert.deepEqual(orgEntryForLocation(`#access=${token}`, saved, forbiddenIntent)?.restoration, original.restoration);
    assert.deepEqual(orgEntryForLocation("", saved, forbiddenIntent), original);
  });
  it("resets self-declaration, acknowledgment and request data for a new token or capability kind", () => {
    for (const original of [acceptance(), restoration()]) for (const kind of ["invite", "access"] as const) {
      const changed = orgEntryForLocation(`#${kind}=${otherToken}`, original, () => newIntent);
      assert.deepEqual(changed, { version: 1, kind, token: otherToken, intentId: newIntent });
      assert.equal(changed?.acceptance, undefined); assert.equal(changed?.restoration, undefined);
    }
    assert.deepEqual(orgEntryForLocation(`#access=${token}`, acceptance(), () => newIntent), { version: 1, kind: "access", token, intentId: newIntent });
  });
  it("refuses malformed, duplicate, mixed and role-widening fragments without returning an earlier identity", () => {
    const original = acceptance(), before = JSON.stringify(original);
    for (const fragment of ["#invite=", "#access=short", `#invite=${token}&invite=${token}`, `#invite=${token}&access=${otherToken}`, `#access=${token}&role=owner`, `#unknown=${token}`, `#invite=${token}%00`, `#invite=${token}%ZZ`, `#invite=${token.slice(1)}+`, `#invite=${token}&intentId=${newIntent}`]) assert.equal(orgEntryForLocation(fragment, original, forbiddenIntent), null, fragment);
    assert.equal(JSON.stringify(original), before);
  });
  it("refuses a stored request with changed kind, token, intent, unsupported contract or undeclared role", () => {
    const original = acceptance();
    for (const invalid of [{ ...original, intentId: newIntent }, { ...original, kind: "access" }, { ...original, token: otherToken }, { ...original, restoration: restoration().restoration }, { ...original, acceptance: { ...original.acceptance, token: otherToken } }, { ...original, acceptance: { ...original.acceptance, role: "owner" } }, { ...original, acceptance: { ...original.acceptance, contractVersion: "unreviewed" } }, { ...original, acceptance: { ...original.acceptance, acknowledged: false } }]) assert.equal(readOrgEntryDraft(JSON.stringify(invalid)), null);
    for (const invalid of [null, "", "{bad", "[]", "null", "4"]) assert.equal(readOrgEntryDraft(invalid), null);
  });
  it("retains one real strict command and rejects path/read, scope, role and authority-branch substitutions", () => {
    const body = { intentId, expectedScope: ORG_UI_SCOPE, label: "Synthetic auditor invitation", role: "auditor", expiresHours: 24, acknowledged: true };
    const saved = saveOrgAttempt("invitations", { organization: ORG_UI_SCOPE, project: null }, body, C.orgInviteSchema);
    assert.deepEqual(readOrgPendingAttempt(JSON.stringify(saved)), saved);
    assert.deepEqual(readOrgAttempt(JSON.stringify(saved), "invitations", saved.context, C.orgInviteSchema), saved);
    assert.equal(readOrgAttempt(JSON.stringify(saved), "invitations", { organization: ORG_UI_HASH, project: null }, C.orgInviteSchema), null);
    assert.equal(readOrgPendingAttempt(JSON.stringify({ ...saved, context: { organization: ORG_UI_HASH, project: null } })), null);
    assert.equal(readOrgPendingAttempt(JSON.stringify({ ...saved, body: { ...body, role: "organizer" } })), null);
    for (const path of ["context", "portfolio", "https://example.invalid/", "entry/accept", "members?all=true"]) assert.equal(orgCommandContract(path), null, path);
    assert.throws(() => C.orgLinkWithdrawSchema.parse({ authority: "project", intentId, expectedProjectScope: ORG_UI_PROJECT_SCOPE, expectedScope: ORG_UI_SCOPE, expectedVersion: 1, reason: "Synthetic withdrawal reason", acknowledged: true }));
  });
});
describe("organization contract disclosure and prospective-policy invariants", () => {
  it("rejects ended or non-organizer project details and any participation link/rule list outside active organizer authority", () => {
    const original = orgUiParticipation();
    for (const state of ["ended", "none"] as const) assert.equal(C.orgProjectParticipationSchema.safeParse({ ...original, projectContext: { ...original.projectContext, state } }).success, false);
    for (const role of ["donor", "volunteer", "auditor"] as const) assert.equal(C.orgProjectParticipationSchema.safeParse({ ...original, projectContext: { ...original.projectContext, role } }).success, false);
    const inactive = { ...original.projectContext, state: "ended", project: null, role: null, profileLabel: null, expiresAt: null, basis: null, maxLinkExpiresAt: null, packages: [], sources: [], currentPlan: null, canLink: false, canAdopt: false, canMaterialize: false, canReviseEmptyPackages: false };
    assert.equal(C.orgProjectParticipationSchema.safeParse({ projectContext: inactive, links: [], adoptions: [], nextAdoptionCursor: null }).success, true);
    assert.equal(C.orgProjectParticipationSchema.safeParse({ ...original, projectContext: inactive }).success, false);
  });
  it("keeps an auditor/coordinator's own membership separate from a forbidden full roster", () => {
    for (const role of ["auditor", "coordinator"] as const) { const desk = orgUiDesk(role); assert.equal(desk.roster, null); assert.equal(C.orgDeskSchema.safeParse({ ...desk, roster: orgUiDesk().roster }).success, false); }
  });
  it("uses identical local-source and unique-mapping guards for organization adoption and project replacement", () => {
    for (const strategy of ["none", "current_draft"] as const) {
      assert.equal(C.orgPlanSourceSchema.safeParse({ strategy, sketchDocumentId: orgUiId(20), page: 1 }).success, false);
      assert.equal(C.orgPlanSourceSchema.safeParse({ strategy, sketchDocumentId: null, page: null }).success, true);
    }
    assert.equal(C.orgPlanSourceSchema.safeParse({ strategy: "new_draft", sketchDocumentId: null, page: null }).success, false);
    assert.equal(C.orgPackageMappingsSchema.safeParse([{ policyPackageKey: "purpose", targetPackageIds: ["printing"] }, { policyPackageKey: "purpose", targetPackageIds: ["woodworking"] }]).success, false);
    assert.equal(C.orgPackageMappingsSchema.safeParse([{ policyPackageKey: "purpose", targetPackageIds: ["printing", "printing"] }]).success, false);
  });
  it("does not admit decorative applied pointers or a materialized state without a real target plan", () => {
    const application = orgUiApplication(); assert.equal(C.orgPolicyApplicationSchema.safeParse(application).success, true);
    assert.equal(C.orgPolicyApplicationSchema.safeParse({ ...application, bindings: [] }).success, false);
    assert.equal(C.orgPolicyApplicationSchema.safeParse({ ...application, summary: { ...application.summary, state: "materialized" }, materializedPlan: null }).success, false);
    assert.equal(C.orgPolicyApplicationSchema.safeParse({ ...application, rule: { ...application.rule, contentHash: "e".repeat(64) } }).success, false);
  });
  it("strict aggregate DTOs refuse private values, undisclosed sections and post-withdrawal content", () => {
    const snapshot = orgUiSnapshot(), project = snapshot.projects[0];
    for (const privateField of ["receiptId", "actorId", "documentId", "providerId", "sourceImageUrl"]) assert.equal(C.orgPortfolioSnapshotSchema.safeParse({ ...snapshot, projects: [{ ...project, [privateField]: "private-canary" }] }).success, false, privateField);
    assert.equal(C.orgPortfolioProjectSchema.safeParse({ ...project, disclosedSections: ["budget"] }).success, false);
    for (const state of ["withdrawn", "suspended", "expired"] as const) assert.equal(C.orgPortfolioProjectSchema.safeParse({ ...project, state }).success, false);
    assert.equal(C.orgPortfolioProjectSchema.safeParse({ ...project, state: "withdrawn", project: null, lineage: null, budget: null, money: [], evidence: [] }).success, true);
  });
  it("keeps mixed plans per project and sponsor unpaid promises a subset instead of an extra sum", () => {
    const group = orgUiSnapshot().groups[0];
    assert.equal(C.orgPortfolioGroupSchema.safeParse({ ...group, projectCount: 2 }).success, false);
    assert.equal(C.orgPortfolioGroupSchema.safeParse({ ...group, projectCount: 2, evidence: { ...group.evidence!, planRevision: null } }).success, true);
    assert.equal(C.orgPortfolioFundingSchema.safeParse({ ...group.funding!, acceptedSponsorUnpaidMinor: group.funding!.unpaidCommitmentMinor + 1 }).success, false);
  });
});
