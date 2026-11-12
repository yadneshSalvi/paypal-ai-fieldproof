import { z } from "zod";
import { TEMPLATE_IDS } from "../community/templates";
import { citationSchema, competencyScopeSchema, evidenceRequirementSchema, proposedPlanSchema, type EvidenceRequirement } from "../planning/contracts";

/** Organization authority never grants or changes a project WorkspaceRole. */
export const ORG_GOVERNANCE_VERSION = "organization-governance-v1" as const;
export const ORG_PORTFOLIO_VERSION = "organization-portfolio-v1" as const;
export const ORG_SCOPE_HEADER = "X-Fieldproof-Organization-Scope";
export const ORG_PROJECT_SCOPE_HEADER = "X-Fieldproof-Organization-Project-Scope";
export const ORG_CHANGE_CHANNEL = "fieldproof-organization-changed";
export const ORG_PAGE_SIZE = 20;
export const ORG_MAX_GRANT_HOURS = 168;
export const orgRoleSchema = z.enum(["owner", "coordinator", "auditor"]);
export type OrgRole = z.infer<typeof orgRoleSchema>;
export const orgRoleLabels: Record<OrgRole, string> = { owner: "Organization owner", coordinator: "Coordinator", auditor: "Organization auditor" };
const id = z.uuid(), key = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/), token = z.string().regex(/^[A-Za-z0-9_-]{64}$/);
const date = z.iso.datetime(), minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), version = z.number().int().positive(), head = z.number().int().nonnegative();
const currency = z.string().regex(/^[A-Z]{3}$/);
const name = z.string().trim().min(2).max(80).refine(value => !/[\u0000-\u001f\u007f]/.test(value), "Use a name without control characters.");
const title = z.string().trim().min(3).max(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value), "Use a name without control characters.");
const reason = z.string().trim().min(8).max(1000), cursor = z.string().min(1).max(500);
const projectId = z.string().min(1).max(160), projectRole = z.enum(["donor", "volunteer", "organizer", "auditor"]);
const authenticationOrigin = z.enum(["creation_capability", "invitation_possession"]);
export const orgProvenanceSchema = z.enum(["sample", "live_sandbox", "replay", "modelled"]);
export const orgDisclosureSectionSchema = z.enum(["budget", "funding", "expenses", "evidence"]);
export type OrgDisclosureSection = z.infer<typeof orgDisclosureSectionSchema>;
const command = { intentId: id, expectedScope: hash }, dual = { ...command, expectedProjectScope: hash };
const ack = { acknowledged: z.literal(true) }, strings = z.array(z.string().max(1400));
function unique(values: readonly unknown[]) { return new Set(values).size === values.length; }

export const ORG_ERROR_CODES = [
  "ORG_AUTH_REQUIRED", "ORG_CONTEXT_CHANGED", "ORG_SESSION_EXPIRED", "ORG_AUTHORITY_ENDED", "ORG_ROLE_DENIED",
  "ORG_VERSION_CHANGED", "ORG_INTENT_CHANGED", "ORG_COMMAND_BUSY", "ORG_RESOURCE_UNAVAILABLE", "ORG_LAST_OWNER",
  "ORG_ENTRY_SWITCH_REQUIRED", "ORG_ENTRY_USED", "ORG_ENTRY_EXPIRED", "ORG_INVITE_REVOKED", "ORG_ISSUER_CHANGED",
  "ORG_BROWSER_CONTEXT_CHANGED", "ORG_CLEAR_ENDED_REQUIRED", "ORG_LIBRARY_REQUIRED", "ORG_LIBRARY_EXPIRED",
  "ORG_LIBRARY_CONTEXT_CHANGED", "ORG_LIBRARY_FULL", "ORG_RATE_LIMIT", "ORG_POLICY_RETIRED",
  "ORG_POLICY_VERSION_CHANGED", "ORG_POLICY_INVALID", "ORG_POLICY_REVIEW_REQUIRED", "ORG_ADOPTION_CHANGED",
  "ORG_PROJECT_CONTEXT_CHANGED", "ORG_PROJECT_AUTHORITY_REQUIRED", "ORG_PROJECT_SOURCE_CHANGED",
  "ORG_LINK_EXPIRED", "ORG_LINK_SUSPENDED", "ORG_LINK_WITHDRAWN", "ORG_SOURCE_UNAVAILABLE",
  "ORG_PACKAGE_ENCUMBERED", "ORG_PACKAGE_REVISION_REQUIRED", "ORG_PLAN_REVIEW_REQUIRED",
  "ORG_REPORT_WITHDRAWN", "ORG_REPORT_CHANGED",
  "INVALID_INPUT", "INPUT_TOO_LARGE", "REQUEST_UNAVAILABLE", "WORKSPACE_MAINTENANCE", "WORKSPACE_CONTEXT_CHANGED",
] as const;
export type OrgErrorCode = typeof ORG_ERROR_CODES[number];
export const orgApiProblemSchema = z.object({
  error: z.string().max(1400), code: z.enum(ORG_ERROR_CODES), requestId: id.optional(),
  fields: z.array(z.object({ path: z.string().max(400), message: z.string().max(600) }).strict()).max(200).optional(),
}).strict();
export type OrgApiProblem = z.infer<typeof orgApiProblemSchema>;
export const ORG_IDENTITY_CHANGED_CODES = ["ORG_AUTH_REQUIRED", "ORG_CONTEXT_CHANGED", "ORG_SESSION_EXPIRED", "ORG_AUTHORITY_ENDED", "ORG_BROWSER_CONTEXT_CHANGED"] as const;
export const ORG_PROJECT_CHANGED_CODES = ["ORG_PROJECT_CONTEXT_CHANGED", "ORG_PROJECT_AUTHORITY_REQUIRED", "ORG_PROJECT_SOURCE_CHANGED", "WORKSPACE_CONTEXT_CHANGED"] as const;

export const orgProfileSchema = z.object({
  organizationId: id, organizationName: title, membershipId: id, displayName: name,
  identityProvenance: z.literal("self_declared"), authenticationOrigin, role: orgRoleSchema, membershipVersion: version,
  membershipExpiresAt: date, sessionExpiresAt: date,
}).strict();
export type OrgProfile = z.infer<typeof orgProfileSchema>;
export const orgBrowserContextSchema = z.object({
  scope: hash, state: z.enum(["none", "active", "ended"]), profile: orgProfileSchema.nullable(),
  canCreate: z.boolean(), canLeave: z.boolean(), canClearEnded: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if ((value.state === "active") !== (value.profile !== null)) ctx.addIssue({ code: "custom", path: ["profile"], message: "Only an active original credential has a current profile." });
});
export type OrgBrowserContext = z.infer<typeof orgBrowserContextSchema>;
export const orgLibraryEntrySchema = z.object({
  id, organizationId: id, organizationName: title, profileLabel: z.string().min(1).max(120),
  identityProvenance: z.enum(["self_declared", "organization_session"]), authenticationOrigin, role: orgRoleSchema,
  expiresAt: date, current: z.boolean(), available: z.boolean(), unavailableReason: z.string().max(600).nullable(),
}).strict();
export const orgLibrarySchema = z.object({
  scope: hash, ready: z.boolean(), expiresAt: date.nullable(), entries: z.array(orgLibraryEntrySchema),
}).strict();
export type OrgLibrary = z.infer<typeof orgLibrarySchema>;
export const orgBootstrapSchema = z.object({ context: orgBrowserContextSchema, library: orgLibrarySchema }).strict();
export type OrgBootstrap = z.infer<typeof orgBootstrapSchema>;
export const orgCreateSchema = z.object({
  ...command, expectedLibraryScope: hash, organizationName: title, description: z.string().trim().max(600),
  displayName: name, expiresHours: z.number().int().min(1).max(ORG_MAX_GRANT_HOURS),
  contractVersion: z.literal(ORG_GOVERNANCE_VERSION), ...ack,
}).strict();
export type OrgCreateInput = z.infer<typeof orgCreateSchema>;
export const orgUpdateSchema = z.object({ ...command, expectedVersion: version, organizationName: title, description: z.string().trim().max(600), ...ack }).strict();
export const orgLibraryActionSchema = z.object({ ...command, expectedLibraryScope: hash, ...ack }).strict();
export const orgLibraryOpenSchema = orgLibraryActionSchema.extend({ entryId: id }).strict();
export const orgInviteSchema = z.object({
  ...command, label: name, role: orgRoleSchema, expiresHours: z.number().int().min(1).max(ORG_MAX_GRANT_HOURS), ...ack,
}).strict();
export type OrgInviteInput = z.infer<typeof orgInviteSchema>;
export const orgInviteLinkSchema = z.object({ expectedScope: hash, expectedVersion: version }).strict();
export const orgInviteRevokeSchema = z.object({ ...command, expectedVersion: version, reason, ...ack }).strict();
export const orgMemberRoleSchema = z.object({ ...command, expectedVersion: version, role: orgRoleSchema, reason, ...ack }).strict();
export const orgMemberEndSchema = z.object({ ...command, expectedVersion: version, reason, ...ack }).strict();
export const orgEntryReviewSchema = z.object({ kind: z.enum(["invite", "access"]), token, intentId: id.optional() }).strict();
export const orgEntryAcceptSchema = z.object({
  ...command, token, displayName: name, contractVersion: z.literal(ORG_GOVERNANCE_VERSION), ...ack,
}).strict();
export const orgEntryRestoreSchema = z.object({ ...command, token, ...ack }).strict();
export const orgEntryLeaveSchema = orgLibraryActionSchema;
export type OrgEntryAcceptInput = z.infer<typeof orgEntryAcceptSchema>;
export type OrgEntryRestoreInput = z.infer<typeof orgEntryRestoreSchema>;
export const orgMemberSchema = z.object({
  id, version, displayName: name, identityProvenance: z.literal("self_declared"), authenticationOrigin, role: orgRoleSchema,
  state: z.enum(["active", "expired", "revoked"]), joinedAt: date, expiresAt: date, endedAt: date.nullable(),
  isOwn: z.boolean(), canChangeRole: z.boolean(), canEnd: z.boolean(), actionReason: z.string().max(600).nullable(),
}).strict();
export type OrgMember = z.infer<typeof orgMemberSchema>;
export const orgInvitationSchema = z.object({
  id, version, label: name, role: orgRoleSchema,
  state: z.enum(["invited", "joined", "expired", "revoked", "authority_changed"]),
  createdAt: date, expiresAt: date, joinedAt: date.nullable(), revokedAt: date.nullable(),
  recipient: z.object({ displayName: name, identityProvenance: z.literal("self_declared") }).strict().nullable(),
  canCopy: z.boolean(), canRevoke: z.boolean(), actionReason: z.string().max(600).nullable(),
}).strict();
export type OrgInvitation = z.infer<typeof orgInvitationSchema>;
export const orgEntryViewSchema = z.object({
  kind: z.enum(["invite", "access"]),
  state: z.enum(["ready", "issuer", "switch_required", "joined_here", "used", "expired", "revoked", "authority_changed", "unavailable"]),
  scope: hash, organization: z.object({ name: title, identityProvenance: z.literal("self_declared") }).strict().nullable(),
  role: orgRoleSchema.nullable(), expiresAt: date.nullable(),
  current: z.object({ organizationName: title, role: orgRoleSchema, expiresAt: date }).strict().nullable(),
  recipient: z.object({ displayName: name, identityProvenance: z.literal("self_declared") }).strict().nullable(),
  canLeave: z.boolean(), canAccept: z.boolean(), canRestore: z.boolean(), libraryScope: hash,
}).strict().superRefine((value, ctx) => {
  if (["switch_required", "issuer", "used", "unavailable"].includes(value.state) && value.recipient) ctx.addIssue({ code: "custom", path: ["recipient"], message: "This state cannot disclose a recipient identity." });
  if (["switch_required", "used", "expired", "revoked", "authority_changed", "unavailable"].includes(value.state) && (value.organization || value.role || value.expiresAt || value.recipient)) ctx.addIssue({ code: "custom", path: ["organization"], message: "An unavailable or different-profile entry cannot disclose the target organization or recipient." });
  if (value.canAccept && (value.kind !== "invite" || value.state !== "ready")) ctx.addIssue({ code: "custom", path: ["canAccept"], message: "Only the exact reviewed ready invitation may be accepted." });
  if (value.canRestore && (value.kind !== "access" || value.state !== "ready")) ctx.addIssue({ code: "custom", path: ["canRestore"], message: "Only the exact reviewed ready return capability may restore its original profile." });
});
export type OrgEntryView = z.infer<typeof orgEntryViewSchema>;
export const orgWelcomeSchema = z.object({ profile: orgProfileSchema, identityProvenance: z.literal("self_declared") }).strict();
export type OrgWelcome = z.infer<typeof orgWelcomeSchema>;
export const orgPrivateInvitationSchema = z.object({ id, path: z.string().regex(/^\/organizations\/join#invite=[A-Za-z0-9_-]{64}$/), expiresAt: date }).strict();
export const orgReturnPathSchema = z.string().regex(/^\/organizations\/join#access=[A-Za-z0-9_-]{64}$/);
export const ORG_COMMAND_KINDS = [
  "create", "update", "invite", "accept_invitation", "restore_profile", "revoke_invite", "change_member_role", "end_member", "leave", "clear_ended", "remember", "open_profile",
  "link_project", "withdraw_project", "save_policy", "publish_policy", "retire_policy", "adopt_policy", "materialize_policy",
  "publish_empty_packages", "deactivate_project_rule", "replace_project_rule", "capture_portfolio",
] as const;
/** Exact self-removal recovery returns this alone, never a roster or secret. */
export const orgCommandReceiptSchema = z.object({
  intentId: id, kind: z.enum(ORG_COMMAND_KINDS), outcome: z.literal("committed"), committedAt: date,
  resourceId: id.nullable(), resourceVersion: head.nullable(), message: z.string().max(1000),
}).strict();
export type OrgCommandReceipt = z.infer<typeof orgCommandReceiptSchema>;
export const orgReceiptResponseSchema = z.object({ receipt: orgCommandReceiptSchema }).strict();
export const orgWelcomeResponseSchema = orgReceiptResponseSchema.extend({ welcome: orgWelcomeSchema, returnPath: orgReturnPathSchema }).strict();
export const orgInviteResponseSchema = orgReceiptResponseSchema.extend({ invitation: orgPrivateInvitationSchema }).strict();
export const orgCapabilitiesSchema = z.object({
  canEditOrganization: z.boolean(), canManageMembers: z.boolean(), canReadRoster: z.boolean(),
  canReadPolicyDrafts: z.boolean(), canWritePolicies: z.boolean(), canLinkProjects: z.boolean(), canAdoptPolicies: z.boolean(),
  canCapturePortfolio: z.boolean(), canExportPortfolio: z.boolean(), canPrintPortfolio: z.boolean(),
}).strict();
export type OrgCapabilities = z.infer<typeof orgCapabilitiesSchema>;
export const orgProjectSummarySchema = z.object({
  id: projectId, title: z.string().max(140), templateId: z.enum(TEMPLATE_IDS), currency, mode: z.enum(["sample", "live_sandbox"]),
}).strict();
export const orgProjectBasisSchema = z.object({
  hash, projectionVersion: head, planningHead: head, adoptionHead: head, packageHash: hash, sourceHash: hash,
}).strict();
export type OrgProjectBasis = z.infer<typeof orgProjectBasisSchema>;
export const orgProjectPackageSchema = z.object({
  id: key, version, title: z.string().max(120), description: z.string().max(1400), budgetMinor: minor,
  category: z.string().max(160), requirements: z.array(evidenceRequirementSchema).max(12),
  canReviseEmpty: z.boolean(), revisionBlockers: strings,
}).strict();
export const orgProjectSourceSchema = z.object({
  id, filename: z.string().max(300), purpose: z.enum(["sketch", "quote"]), provenance: z.enum(["user_upload", "sample_document"]),
  pages: z.array(z.number().int().min(1).max(12)).max(12), version, contentHash: hash, controlVersion: version,
}).strict();
export const orgProjectContextSchema = z.object({
  scope: hash, state: z.enum(["none", "active", "ended"]), project: orgProjectSummarySchema.nullable(),
  role: projectRole.nullable(), profileLabel: z.string().max(120).nullable(), expiresAt: date.nullable(),
  basis: orgProjectBasisSchema.nullable(), maxLinkExpiresAt: date.nullable(),
  packages: z.array(orgProjectPackageSchema).max(20), sources: z.array(orgProjectSourceSchema).max(150),
  currentPlan: z.object({ id, revision: version, contentHash: hash, sourceDocumentId: id, sourcePage: z.number().int().min(1).max(12) }).strict().nullable(),
  canLink: z.boolean(), canAdopt: z.boolean(), canMaterialize: z.boolean(), canReviseEmptyPackages: z.boolean(), reasons: strings,
}).strict().superRefine((value, ctx) => {
  const capable = value.canLink || value.canAdopt || value.canMaterialize || value.canReviseEmptyPackages;
  if ((value.state !== "active" || value.role !== "organizer") && (value.sources.length || value.packages.length || value.currentPlan || value.basis || value.maxLinkExpiresAt || capable)) ctx.addIssue({ code: "custom", path: ["sources"], message: "Policy source details and controls require the separate active project organizer." });
  if (value.state !== "active" && (value.project || value.role || value.profileLabel || value.expiresAt)) ctx.addIssue({ code: "custom", path: ["project"], message: "An ended project context exposes no private project profile." });
});
export type OrgProjectContext = z.infer<typeof orgProjectContextSchema>;
const disclosure = z.array(orgDisclosureSectionSchema).min(1).max(4).refine(unique, "Choose each aggregate scope once.");
export const orgLinkProposalSchema = z.object({ disclosure, expiresAt: date }).strict();
export const orgLinkReviewInputSchema = z.object({
  expectedScope: hash, expectedProjectScope: hash, expectedProjectBasis: orgProjectBasisSchema,
  existingLinkId: id.nullable(), expectedLinkVersion: head, proposal: orgLinkProposalSchema,
}).strict();
export const orgLinkSchema = z.object({
  id, version, state: z.enum(["active", "suspended", "expired", "withdrawn"]), project: orgProjectSummarySchema.nullable(),
  consent: z.object({ id, revision: version, contentHash: hash, disclosure, approvedAt: date, expiresAt: date,
    projectMembershipVersion: version, organizationMembershipVersion: version }).strict(),
  canRereview: z.boolean(), canWithdraw: z.boolean(), reasons: strings,
}).strict().superRefine((value, ctx) => {
  if (value.state !== "active" && value.project) ctx.addIssue({ code: "custom", path: ["project"], message: "Ended or suspended aggregate disclosure retains only organization-owned link metadata." });
});
export type OrgLink = z.infer<typeof orgLinkSchema>;
export const orgLinkReviewSchema = z.object({
  reviewHash: hash, input: orgLinkReviewInputSchema, project: orgProjectSummarySchema, organizationName: title,
  effectiveExpiresAt: date, scopes: disclosure, warnings: strings, blockers: strings, canCommit: z.boolean(),
}).strict();
export type OrgLinkReview = z.infer<typeof orgLinkReviewSchema>;
export const orgLinkCommitSchema = orgLinkReviewInputSchema.extend({ ...command, reviewHash: hash, ...ack }).strict();
/** Reducing aggregate disclosure never removes an adopted project rule. */
export const orgLinkWithdrawSchema = z.discriminatedUnion("authority", [
  z.object({ authority: z.literal("organization"), ...command, expectedVersion: version, reason, ...ack }).strict(),
  z.object({ authority: z.literal("project"), intentId: id, expectedProjectScope: hash, expectedVersion: version, reason, ...ack }).strict(),
]);
export const orgRequirementScopes: Record<EvidenceRequirement["kind"], z.infer<typeof competencyScopeSchema> | null> = {
  photo_association: null, installation_review: "equipment_setup", ventilation_check: "ventilation",
  electrical_check: "electrical_safety", laser_safety_check: "laser_safety", site_review: "soil_suitability",
  access_review: "site_access", water_review: "water_safety", food_handling_review: "food_safety", distribution_review: "distribution_safety",
};
const requirement = evidenceRequirementSchema.refine(value => value.scope === orgRequirementScopes[value.kind], "This requirement needs its matching competence scope.");
const templates = z.array(z.enum(TEMPLATE_IDS)).min(1).max(3).refine(unique, "Choose each template once.");
const definition = { title, description: z.string().trim().max(1400), templateIds: templates };
export const orgPolicyKindSchema = z.enum(["package_library", "fund_restriction", "evidence_policy"]);
export type OrgPolicyKind = z.infer<typeof orgPolicyKindSchema>;
export const orgPolicyDefinitionSchema = z.discriminatedUnion("kind", [
  z.object({ ...definition, kind: z.literal("package_library"),
    packages: z.array(z.object({ key, title: z.string().trim().min(1).max(120), description: z.string().trim().max(1400),
      proposedBudgetMinor: z.number().int().min(1).max(100000000).nullable(), currency: z.literal("USD"),
      category: z.string().trim().min(1).max(160), capabilities: z.array(z.string().trim().min(1).max(160)).max(12),
      requirements: z.array(requirement).min(1).max(12),
    }).strict()).min(1).max(20),
    dependencies: z.array(z.object({ packageKey: key, prerequisiteKey: key, kind: z.enum(["included", "accepted_work", "safety_signoff"]), reason: z.string().trim().min(1).max(300) }).strict()).max(80),
  }).strict(),
  z.object({ ...definition, kind: z.literal("fund_restriction"),
    packageKeys: z.array(key).min(1).max(20).refine(unique, "Choose each purpose key once."),
    allowedUses: z.array(z.enum(["reviewed_expense", "provider_fee"])).min(1).max(2).refine(unique, "Choose each permitted use once."),
    maximumExpenseMinor: z.number().int().positive().max(100000000).nullable(),
    maximumFeeAllowanceMinor: minor.nullable(), maximumSponsorCapMinor: z.number().int().positive().max(100000000).nullable(),
    maximumMatchBasisPoints: z.number().int().min(1).max(40000).nullable(),
    allowGrants: z.boolean(), allowMatches: z.boolean(), allowReallocation: z.boolean(), allowRollover: z.boolean(),
    requireReviewedPlan: z.boolean(), requireAcceptedWorkBeforeNewSpending: z.boolean(),
  }).strict(),
  z.object({ ...definition, kind: z.literal("evidence_policy"),
    packages: z.array(z.object({ key, requirements: z.array(requirement).min(1).max(12) }).strict()).min(1).max(20),
    allowedSourceProvenance: z.array(z.enum(["user_upload", "sample_document"])).min(1).max(2).refine(unique, "Choose each source class once."),
    maximumImageSharing: z.enum(["reviewers_only", "project_members"]),
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.kind === "fund_restriction") return;
  if (!unique(value.packages.map(pkg => pkg.key))) ctx.addIssue({ code: "custom", path: ["packages"], message: "Every library package needs its own stable key." });
  for (const [index, pkg] of value.packages.entries()) if (!unique(pkg.requirements.map(row => row.id))) ctx.addIssue({ code: "custom", path: ["packages", index, "requirements"], message: "Each requirement needs its own stable identifier." });
  if (value.kind !== "package_library") return;
  const keys = new Set(value.packages.map(pkg => pkg.key)), edges = new Map(value.packages.map(pkg => [pkg.key, [] as string[]])), pairs = new Set<string>();
  for (const [index, dependency] of value.dependencies.entries()) {
    const pair = dependency.packageKey + ":" + dependency.prerequisiteKey;
    if (!keys.has(dependency.packageKey) || !keys.has(dependency.prerequisiteKey) || dependency.packageKey === dependency.prerequisiteKey || pairs.has(pair)) ctx.addIssue({ code: "custom", path: ["dependencies", index], message: "Use each pair of different package keys once." });
    else edges.get(dependency.packageKey)!.push(dependency.prerequisiteKey);
    pairs.add(pair);
  }
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (current: string): boolean => {
    if (visiting.has(current)) return false; if (done.has(current)) return true;
    visiting.add(current); if ((edges.get(current) ?? []).some(next => !visit(next))) return false;
    visiting.delete(current); done.add(current); return true;
  };
  if ([...keys].some(current => !visit(current))) ctx.addIssue({ code: "custom", path: ["dependencies"], message: "The reusable package prerequisites form a cycle." });
});
export type OrgPolicyDefinition = z.infer<typeof orgPolicyDefinitionSchema>;
export const orgPolicySaveSchema = z.object({ ...command, policyId: id.nullable(), expectedHead: head, definition: orgPolicyDefinitionSchema }).strict();
export type OrgPolicySaveInput = z.infer<typeof orgPolicySaveSchema>;
export const orgPolicyPublishReviewInputSchema = z.object({ expectedScope: hash, policyId: id, expectedHead: version, definitionHash: hash }).strict();
const issue = z.object({ code: z.string().max(100), path: z.string().max(400), message: z.string().max(1400), severity: z.enum(["error", "review", "notice"]) }).strict();
export const orgPolicyPublishReviewSchema = z.object({
  reviewHash: hash, policyId: id, expectedHead: version, definitionHash: hash,
  definition: orgPolicyDefinitionSchema, issues: z.array(issue), effectiveConsumers: strings, preservedHistory: strings, canPublish: z.boolean(),
}).strict();
export type OrgPolicyPublishReview = z.infer<typeof orgPolicyPublishReviewSchema>;
export const orgPolicyPublishSchema = orgPolicyPublishReviewInputSchema.extend({ ...command, reviewHash: hash, ...ack }).strict();
export const orgPolicyRetireSchema = z.object({ ...command, versionId: id, expectedStateVersion: version, reason, ...ack }).strict();
export const orgPublishedPolicySchema = z.object({
  id, revision: version, contentHash: hash, state: z.enum(["active", "retired"]), stateVersion: version,
  publishedAt: date, retiredAt: date.nullable(), publisherRole: orgRoleSchema, definition: orgPolicyDefinitionSchema, canRetire: z.boolean(),
}).strict();
export type OrgPublishedPolicy = z.infer<typeof orgPublishedPolicySchema>;
export const orgPolicySummarySchema = z.object({
  id, headVersion: version, title, kind: orgPolicyKindSchema, templateIds: templates, hasDraft: z.boolean(),
  latestRevision: head, latestHash: hash.nullable(), publishedAt: date.nullable(), activeVersionCount: count, canEdit: z.boolean(),
}).strict();
export type OrgPolicySummary = z.infer<typeof orgPolicySummarySchema>;
export const orgPolicyDetailSchema = z.object({
  scope: hash, summary: orgPolicySummarySchema,
  draft: z.object({ headVersion: version, contentHash: hash, definition: orgPolicyDefinitionSchema, updatedAt: date }).strict().nullable(),
  selectedVersion: orgPublishedPolicySchema.nullable(),
  versions: z.array(orgPublishedPolicySchema.omit({ definition: true })).max(ORG_PAGE_SIZE), nextCursor: cursor.nullable(),
}).strict();
export type OrgPolicyDetail = z.infer<typeof orgPolicyDetailSchema>;

export const orgConsumerKindSchema = z.enum([
  "planning_draft", "canonical_empty_packages", "plan_review", "plan_publication", "funding_policy",
  "sponsor_offer", "purpose_pledge", "expense_review", "payable_approval", "image_review", "physical_signoff",
]);
export type OrgConsumerKind = z.infer<typeof orgConsumerKindSchema>;
export const orgApplicationStateSchema = z.enum(["draft", "materialized", "applied", "superseded", "deactivated", "needs_review"]);
export const orgPackageMappingSchema = z.object({ policyPackageKey: key, targetPackageIds: z.array(key).min(1).max(20).refine(unique, "Choose each target package once.") }).strict();
export const orgPackageMappingsSchema = z.array(orgPackageMappingSchema).min(1).max(20).refine(rows => unique(rows.map(row => row.policyPackageKey)), "Map each reusable key once.");
export const orgPlanSourceSchema = z.object({
  strategy: z.enum(["none", "current_draft", "new_draft"]), sketchDocumentId: id.nullable(), page: z.number().int().min(1).max(12).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.strategy === "new_draft" && (!value.sketchDocumentId || !value.page)) ctx.addIssue({ code: "custom", message: "Choose a target-project sketch and page." });
  if (value.strategy !== "new_draft" && (value.sketchDocumentId || value.page)) ctx.addIssue({ code: "custom", message: "Unused sketch and page fields must be empty." });
});
const quoteMapping = z.object({
  policyPackageKey: key, targetPackageId: key, reviewedBudgetMinor: z.number().int().positive().max(100000000),
  citation: citationSchema.extend({ kind: z.literal("quote") }).strict(),
}).strict();
export const orgAdoptionSelectionSchema = z.object({
  expectedScope: hash, expectedProjectScope: hash, expectedProjectBasis: orgProjectBasisSchema,
  linkId: id, expectedLinkVersion: version, policyVersionId: id, policyHash: hash, expectedPolicyStateVersion: version,
  mappings: orgPackageMappingsSchema,
  planSource: orgPlanSourceSchema, reviseCanonicalEmptyPackages: z.boolean(), reviewedQuotes: z.array(quoteMapping).max(20),
}).strict().superRefine((value, ctx) => {
  if (value.reviseCanonicalEmptyPackages && !value.reviewedQuotes.length) ctx.addIssue({ code: "custom", path: ["reviewedQuotes"], message: "Canonical budgets require target-local reviewed quote citations." });
});
export type OrgAdoptionSelection = z.infer<typeof orgAdoptionSelectionSchema>;
export const orgAdoptionReviewSchema = z.object({
  reviewHash: hash, selection: orgAdoptionSelectionSchema, policy: orgPublishedPolicySchema,
  project: orgProjectSummarySchema, consumers: z.array(orgConsumerKindSchema).min(1),
  proposedPlan: proposedPlanSchema.nullable(), issues: z.array(issue),
  packageChanges: z.array(z.object({ packageId: key, title: z.string().max(120), beforeVersion: version, beforeBudgetMinor: minor, proposedBudgetMinor: minor, quoteCitationId: key }).strict()).max(20),
  preservedHistory: strings, warnings: strings, blockers: strings, canApply: z.boolean(),
}).strict();
export type OrgAdoptionReview = z.infer<typeof orgAdoptionReviewSchema>;
export const orgAdoptSchema = z.object({ ...dual, selection: orgAdoptionSelectionSchema, reviewHash: hash, preservedHistoryAcknowledged: z.literal(true), ...ack }).strict().superRefine((value, ctx) => {
  if (value.expectedScope !== value.selection.expectedScope || value.expectedProjectScope !== value.selection.expectedProjectScope) ctx.addIssue({ code: "custom", path: ["selection"], message: "Commit the exact original reviewed organization and project context." });
});
export type OrgAdoptInput = z.infer<typeof orgAdoptSchema>;
export const orgConsumerBindingSchema = z.object({
  consumer: orgConsumerKindSchema, state: z.enum(["enforced", "materialized", "pending", "not_applicable"]),
  bindingHash: hash, adoptionHead: version, appliedAt: date.nullable(), limitations: strings,
}).strict();
export const orgRuleSnapshotSchema = z.object({
  origin: z.enum(["organization_adoption", "project_revision"]), contentHash: hash, definition: orgPolicyDefinitionSchema, createdAt: date,
  sourceOrganizationPolicy: z.object({ organizationId: id, policyId: id, versionId: id, revision: version, contentHash: hash }).strict().nullable(),
}).strict();
export const orgAdoptionSummarySchema = z.object({
  id, linkId: id, version, policyId: id.nullable(), policyVersionId: id.nullable(), policyRevision: version.nullable(), policyHash: hash.nullable(),
  ruleHash: hash, origin: z.enum(["organization_adoption", "project_revision"]),
  title, kind: orgPolicyKindSchema, state: orgApplicationStateSchema, adoptedAt: date,
  complianceState: z.enum(["current", "pending_publication", "gap", "historical"]),
  issueCount: count, materializedPlanRevision: version.nullable(), consumers: z.array(orgConsumerKindSchema),
}).strict();
export type OrgAdoptionSummary = z.infer<typeof orgAdoptionSummarySchema>;
/** Available through the independently held project profile, including after
 * organization disclosure or membership ends. It grants no org resources. */
export const orgProjectParticipationSchema = z.object({
  projectContext: orgProjectContextSchema,
  links: z.array(z.object({ id, version, organizationName: title, state: z.enum(["active", "suspended", "expired", "withdrawn"]), disclosure, expiresAt: date, canWithdraw: z.boolean(), reasons: strings }).strict()),
  adoptions: z.array(orgAdoptionSummarySchema).max(ORG_PAGE_SIZE), nextAdoptionCursor: cursor.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.projectContext.state !== "active" || value.projectContext.role !== "organizer") && (value.links.length || value.adoptions.length || value.nextAdoptionCursor)) ctx.addIssue({ code: "custom", path: ["adoptions"], message: "Project links and rule administration require the active independent project organizer." });
});
export type OrgProjectParticipation = z.infer<typeof orgProjectParticipationSchema>;
/** Private target-plan IDs occur only in this project-authorized application
 * view, never in the aggregate portfolio DTO. The rule snapshot is project-owned. */
export const orgPolicyApplicationSchema = z.object({
  projectScope: hash, summary: orgAdoptionSummarySchema, rule: orgRuleSnapshotSchema,
  projectBasis: orgProjectBasisSchema, mappings: z.array(orgPackageMappingSchema), bindings: z.array(orgConsumerBindingSchema),
  materializedPlan: z.object({ id, revision: version, headVersion: version, contentHash: hash }).strict().nullable(),
  canonicalRevision: z.object({ id, version, packages: z.array(z.object({ id: key, version, budgetMinor: minor }).strict()) }).strict().nullable(),
  issues: z.array(issue), preservedHistory: strings, canDeactivate: z.boolean(), canReplace: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.summary.state === "applied" && !value.bindings.some(binding => binding.state === "enforced")) ctx.addIssue({ code: "custom", path: ["bindings"], message: "An applied policy needs an actual enforced consumer binding." });
  if (value.summary.state === "materialized" && !value.materializedPlan) ctx.addIssue({ code: "custom", path: ["materializedPlan"], message: "Materialized means a real editable target plan exists." });
  if (value.rule.contentHash !== value.summary.ruleHash) ctx.addIssue({ code: "custom", path: ["rule"], message: "The rule must match its immutable adoption binding." });
});
export type OrgPolicyApplication = z.infer<typeof orgPolicyApplicationSchema>;
const projectRuleCommand = { intentId: id, expectedProjectScope: hash, expectedProjectBasis: orgProjectBasisSchema, expectedVersion: version, reason, ...ack };
export const orgProjectRuleDeactivateSchema = z.object({ ...projectRuleCommand, preservedHistoryAcknowledged: z.literal(true) }).strict();
export const orgProjectRuleReplaceReviewInputSchema = z.object({
  expectedProjectScope: hash, expectedProjectBasis: orgProjectBasisSchema, expectedVersion: version,
  definition: orgPolicyDefinitionSchema, mappings: orgPackageMappingsSchema,
  planSource: orgPlanSourceSchema, reviseCanonicalEmptyPackages: z.boolean(), reviewedQuotes: z.array(quoteMapping).max(20),
}).strict().superRefine((value, ctx) => {
  if (value.reviseCanonicalEmptyPackages && !value.reviewedQuotes.length) ctx.addIssue({ code: "custom", path: ["reviewedQuotes"], message: "Canonical budgets require target-local reviewed quote citations." });
});
export const orgProjectRuleReplaceReviewSchema = z.object({
  reviewHash: hash, input: orgProjectRuleReplaceReviewInputSchema, issues: z.array(issue), blockers: strings, warnings: strings,
  proposedPlan: proposedPlanSchema.nullable(), consumers: z.array(orgConsumerKindSchema).min(1), preservedHistory: strings, canApply: z.boolean(),
}).strict();
export type OrgProjectRuleReplaceReview = z.infer<typeof orgProjectRuleReplaceReviewSchema>;
export const orgProjectRuleReplaceSchema = z.object({
  ...projectRuleCommand, reviewHash: hash, input: orgProjectRuleReplaceReviewInputSchema, preservedHistoryAcknowledged: z.literal(true),
}).strict().superRefine((value, ctx) => {
  if (value.expectedProjectScope !== value.input.expectedProjectScope || value.expectedVersion !== value.input.expectedVersion || value.expectedProjectBasis.hash !== value.input.expectedProjectBasis.hash) ctx.addIssue({ code: "custom", path: ["input"], message: "Retain the original reviewed project scope, rule version and source basis." });
});

/** These are separate views of the same money. None authorizes a transfer or
 * pooling; original receipts, current positions and unpaid promises are not
 * additive. An accepted sponsor promise is a subset of unpaid commitments. */
export const orgPortfolioFundingSchema = z.object({
  originalGrossMinor: minor, originalCreditedMinor: minor,
  ordersGrossMinor: minor, invoiceGrossMinor: minor, testGrossMinor: minor,
  returnedMinor: minor, pendingReturnMinor: minor, excludedMinor: minor, excessLiabilityMinor: minor,
  currentAssignedMinor: minor, currentCollectedMinor: minor, eligibleMinor: minor,
  paidMinor: minor, reservedMinor: minor, availableMinor: minor,
  originalCommitmentRecordMinor: minor, unpaidCommitmentMinor: minor, acceptedSponsorUnpaidMinor: minor,
}).strict().superRefine((value, ctx) => {
  if (value.acceptedSponsorUnpaidMinor > value.unpaidCommitmentMinor) ctx.addIssue({ code: "custom", path: ["acceptedSponsorUnpaidMinor"], message: "Sponsor unpaid promises are already included in total unpaid promises." });
});
export type OrgPortfolioFunding = z.infer<typeof orgPortfolioFundingSchema>;
export const orgPortfolioExpensesSchema = z.object({
  approvedExpenseMinor: minor, deliveredPrincipalMinor: minor,
  returnedPrincipalMinor: minor, undeliveredPrincipalMinor: minor,
  paidPrincipalMinor: minor, knownPaidFeeMinor: minor, unobservedFeeCount: count,
  reservedPrincipalMinor: minor, reservedFeeMinor: minor, claimCount: count,
}).strict();
export type OrgPortfolioExpenses = z.infer<typeof orgPortfolioExpensesSchema>;
export const orgPortfolioEvidenceSchema = z.object({
  acceptedReviewItems: count, requiredReviewItems: count, acceptedPackages: count, packageCount: count,
  currentScopedSignoffs: count, reviewedIllustrations: count, planRevision: version.nullable(),
  policyRevisions: z.array(z.object({ policyId: id, revision: version, contentHash: hash }).strict()),
  limitations: strings,
}).strict().superRefine((value, ctx) => {
  if (value.acceptedReviewItems > value.requiredReviewItems) ctx.addIssue({ code: "custom", path: ["acceptedReviewItems"], message: "Accepted review items must use the disclosed requirement denominator." });
  if (value.acceptedPackages > value.packageCount) ctx.addIssue({ code: "custom", path: ["acceptedPackages"], message: "Accepted packages must use the disclosed package denominator." });
});
export type OrgPortfolioEvidence = z.infer<typeof orgPortfolioEvidenceSchema>;
const metricCoverage = z.object({
  includedProjects: count, omittedProjects: count, denominatorProjects: count,
  complete: z.boolean(), reasons: strings,
}).strict().superRefine((value, ctx) => {
  if (value.includedProjects + value.omittedProjects !== value.denominatorProjects || (value.complete && value.omittedProjects !== 0)) ctx.addIssue({ code: "custom", path: ["denominatorProjects"], message: "Coverage must describe the same approved project set without hidden global counts." });
});
export const orgPortfolioCoverageSchema = z.object({
  budget: metricCoverage, funding: metricCoverage, expenses: metricCoverage, evidence: metricCoverage,
}).strict();
export type OrgPortfolioCoverage = z.infer<typeof orgPortfolioCoverageSchema>;
export const orgPortfolioLineageSchema = z.object({
  asOf: date, aggregateHash: hash, projectVersion: version, projectionVersion: head, eventCursor: head,
  planRevision: version.nullable(), planHash: hash.nullable(), packageHash: hash,
  disclosureRevision: version, disclosureHash: hash, disclosureExpiresAt: date,
}).strict();
export const orgPortfolioProjectSchema = z.object({
  linkId: id, linkVersion: version, consentRevision: version,
  state: z.enum(["included", "partial", "suspended", "expired", "withdrawn", "unavailable"]),
  project: orgProjectSummarySchema.nullable(), lineage: orgPortfolioLineageSchema.nullable(),
  disclosedSections: z.array(orgDisclosureSectionSchema).max(4).refine(unique),
  budget: z.object({ currency, provenance: orgProvenanceSchema, amountMinor: minor, packageCount: count, basis: z.literal("current_canonical_packages") }).strict().nullable(),
  money: z.array(z.object({ currency, provenance: orgProvenanceSchema, funding: orgPortfolioFundingSchema.nullable(), expenses: orgPortfolioExpensesSchema.nullable() }).strict()),
  evidence: z.array(z.object({ provenance: orgProvenanceSchema, values: orgPortfolioEvidenceSchema }).strict()),
  reasons: strings, notices: strings,
}).strict().superRefine((value, ctx) => {
  if (!["included", "partial"].includes(value.state) && (value.project || value.lineage || value.budget || value.money.length || value.evidence.length)) ctx.addIssue({ code: "custom", path: ["project"], message: "Unavailable disclosure retains link metadata only, without private project content." });
  if (value.budget && !value.disclosedSections.includes("budget")) ctx.addIssue({ code: "custom", path: ["budget"], message: "Budget was not disclosed." });
  if (value.money.some(row => row.funding) && !value.disclosedSections.includes("funding")) ctx.addIssue({ code: "custom", path: ["money"], message: "Funding was not disclosed." });
  if (value.money.some(row => row.expenses) && !value.disclosedSections.includes("expenses")) ctx.addIssue({ code: "custom", path: ["money"], message: "Expenses were not disclosed." });
  if (value.evidence.length && !value.disclosedSections.includes("evidence")) ctx.addIssue({ code: "custom", path: ["evidence"], message: "Evidence was not disclosed." });
  if (!unique(value.money.map(row => `${row.currency}:${row.provenance}`)) || !unique(value.evidence.map(row => row.provenance))) ctx.addIssue({ code: "custom", path: ["money"], message: "Count each currency and provenance group once." });
});
export type OrgPortfolioProject = z.infer<typeof orgPortfolioProjectSchema>;
export const orgPortfolioGroupSchema = z.object({
  currency, provenance: orgProvenanceSchema, projectCount: count,
  budgetMinor: minor.nullable(), funding: orgPortfolioFundingSchema.nullable(),
  expenses: orgPortfolioExpensesSchema.nullable(), evidence: orgPortfolioEvidenceSchema.nullable(),
  coverage: orgPortfolioCoverageSchema,
}).strict().superRefine((value, ctx) => {
  if (value.projectCount > 1 && value.evidence?.planRevision !== null && value.evidence) ctx.addIssue({ code: "custom", path: ["evidence", "planRevision"], message: "A multi-project group has no single plan revision; keep revisions on each project." });
});
export type OrgPortfolioGroup = z.infer<typeof orgPortfolioGroupSchema>;
export const orgPortfolioFilterSchema = z.object({
  templateIds: z.array(z.enum(TEMPLATE_IDS)).max(3).refine(unique),
  provenance: z.array(orgProvenanceSchema).max(4).refine(unique),
  currencies: z.array(currency).max(20).refine(unique), linkIds: z.array(id).max(200).refine(unique),
}).strict();
export type OrgPortfolioFilter = z.infer<typeof orgPortfolioFilterSchema>;
/** No private actor, receipt, provider, source-document IDs or image URLs are
 * admitted anywhere in this aggregate snapshot. Drill-through is aggregate-only. */
export const orgPortfolioSnapshotSchema = z.object({
  schemaVersion: z.literal(ORG_PORTFOLIO_VERSION), basisHash: hash, asOf: date, semanticVersion: z.string().min(1).max(100),
  filters: orgPortfolioFilterSchema, projects: z.array(orgPortfolioProjectSchema), groups: z.array(orgPortfolioGroupSchema),
  coverage: orgPortfolioCoverageSchema,
  knownLinks: count, activeLinks: count, suspendedLinks: count, expiredLinks: count, withdrawnLinks: count,
  sourceObservedRange: z.object({ earliest: date, latest: date }).strict().nullable(), notices: strings,
}).strict().superRefine((value, ctx) => {
  if (!unique(value.projects.map(row => row.linkId)) || !unique(value.groups.map(row => `${row.currency}:${row.provenance}`))) ctx.addIssue({ code: "custom", path: ["projects"], message: "Do not duplicate a project link or provenance group." });
  if (value.activeLinks + value.suspendedLinks + value.expiredLinks + value.withdrawnLinks !== value.knownLinks) ctx.addIssue({ code: "custom", path: ["knownLinks"], message: "Link counts describe only this organization's known disclosures." });
});
export type OrgPortfolioSnapshot = z.infer<typeof orgPortfolioSnapshotSchema>;
export const orgPortfolioSummarySchema = z.object({
  id, label: title, asOf: date, contentHash: hash, basisHash: hash, role: orgRoleSchema, projectCount: count,
}).strict();
export type OrgPortfolioSummary = z.infer<typeof orgPortfolioSummarySchema>;
export const orgPortfolioReportSchema = z.object({
  schemaVersion: z.literal(ORG_PORTFOLIO_VERSION), id, label: title, contentHash: hash,
  organization: z.object({ id, name: title, identityProvenance: z.literal("self_declared") }).strict(),
  audience: z.object({ role: orgRoleSchema, label: z.string().max(300), scope: z.literal("approved_project_aggregates") }).strict(),
  snapshot: orgPortfolioSnapshotSchema,
}).strict();
export type OrgPortfolioReport = z.infer<typeof orgPortfolioReportSchema>;
export const orgPortfolioViewSchema = z.object({
  summary: orgPortfolioSummarySchema, status: z.enum(["current", "historical", "withdrawn"]),
  checkedAt: date, currentBasisHash: hash, report: orgPortfolioReportSchema.nullable(), reasons: strings,
  canPrint: z.boolean(), canExport: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "withdrawn" && (value.report || value.canPrint || value.canExport)) ctx.addIssue({ code: "custom", path: ["report"], message: "Withdrawn editions retain metadata only." });
  if (value.status !== "withdrawn" && !value.report) ctx.addIssue({ code: "custom", path: ["report"], message: "A readable edition needs its exact frozen report." });
  if (value.report && (value.report.id !== value.summary.id || value.report.contentHash !== value.summary.contentHash || value.report.audience.role !== value.summary.role)) ctx.addIssue({ code: "custom", path: ["report"], message: "The frozen report must match its original summary and audience." });
});
export type OrgPortfolioView = z.infer<typeof orgPortfolioViewSchema>;
export const orgPortfolioCaptureSchema = z.object({ ...command, label: title, expectedBasisHash: hash, filters: orgPortfolioFilterSchema, ...ack }).strict();
export type OrgPortfolioCaptureInput = z.infer<typeof orgPortfolioCaptureSchema>;
export const orgPortfolioDeskSchema = z.object({
  scope: hash, live: orgPortfolioSnapshotSchema, history: z.array(orgPortfolioSummarySchema).max(ORG_PAGE_SIZE),
  nextCursor: cursor.nullable(), selected: orgPortfolioViewSchema.nullable(), canCapture: z.boolean(),
}).strict();
export type OrgPortfolioDesk = z.infer<typeof orgPortfolioDeskSchema>;
export const orgPortfolioDetailSchema = z.object({
  scope: hash, reportId: id.nullable(), contentHash: hash, asOf: date, project: orgPortfolioProjectSchema,
  definitions: z.array(z.object({
    metric: z.enum(["budget", "original_receipts", "current_funding", "unpaid_promises", "expenses", "evidence"]),
    label: z.string().max(140), basis: z.string().max(1400), unit: z.enum(["minor_units", "count", "ratio"]), limitations: strings,
  }).strict()), notices: strings,
}).strict();
export type OrgPortfolioDetail = z.infer<typeof orgPortfolioDetailSchema>;
export const orgEventSchema = z.object({
  id, occurredAt: date, kind: z.string().min(1).max(100), title: z.string().max(160), detail: z.string().max(1400),
  authorityLabel: z.string().max(160),
}).strict();
export type OrgEvent = z.infer<typeof orgEventSchema>;
export const orgDeskSchema = z.object({
  contractVersion: z.literal(ORG_GOVERNANCE_VERSION), scope: hash, checkedAt: date,
  organization: z.object({ id, version, name: title, description: z.string().max(600), identityProvenance: z.literal("self_declared"), createdAt: date }).strict(),
  profile: orgProfileSchema, capabilities: orgCapabilitiesSchema, ownMembership: orgMemberSchema,
  roster: z.object({ members: z.array(orgMemberSchema).max(ORG_PAGE_SIZE), nextMemberCursor: cursor.nullable(), invitations: z.array(orgInvitationSchema).max(ORG_PAGE_SIZE), nextInvitationCursor: cursor.nullable() }).strict().nullable(),
  links: z.array(orgLinkSchema).max(ORG_PAGE_SIZE), nextLinkCursor: cursor.nullable(),
  adoptions: z.array(orgAdoptionSummarySchema).max(ORG_PAGE_SIZE), nextAdoptionCursor: cursor.nullable(),
  policies: z.array(orgPolicySummarySchema).max(ORG_PAGE_SIZE), nextPolicyCursor: cursor.nullable(),
  events: z.array(orgEventSchema).max(ORG_PAGE_SIZE), nextEventCursor: cursor.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.profile.role !== "owner" && value.roster) ctx.addIssue({ code: "custom", path: ["roster"], message: "Only the current organization owner receives the full roster and invitation list." });
  if (!value.ownMembership.isOwn || value.ownMembership.id !== value.profile.membershipId || value.ownMembership.role !== value.profile.role || value.ownMembership.version !== value.profile.membershipVersion) ctx.addIssue({ code: "custom", path: ["ownMembership"], message: "The current profile must match its exact current membership." });
});
export type OrgDesk = z.infer<typeof orgDeskSchema>;
export const orgPageQuerySchema = z.object({ before: cursor.optional() }).strict();
export const orgPortfolioReviewSchema = z.object({ filters: orgPortfolioFilterSchema }).strict();

/** Route protocol (all JSON is private/no-store; fragment secrets are POST
 * bodies only; headers are stale-context checks, never credentials):
 *
 * GET /context -> OrgBootstrap (current browser, no prior scope required)
 * GET / -> {desk:OrgDesk}; POST /create -> OrgWelcomeResponse
 * POST /update -> OrgReceiptResponse
 * GET /library -> {library:OrgLibrary}
 * POST /library/{remember,open,clear-ended}, /session/leave -> OrgReceiptResponse
 * POST /entry/review -> {entry:OrgEntryView}
 * POST /entry/{accept,restore} -> OrgWelcomeResponse; /entry/leave -> OrgReceiptResponse
 * GET /{members,invitations,projects,policies,events}?before= -> paged rows
 * POST /invitations -> OrgInviteResponse; /invitations/:id/link -> {invitation:OrgPrivateInvitation}
 * POST /invitations/:id/revoke, /members/:id/{role,end} -> OrgReceiptResponse
 * GET /project-context -> {participation:OrgProjectParticipation}
 * POST /projects/review -> {review:OrgLinkReview}; /projects -> OrgReceiptResponse
 * POST /projects/:id/withdraw -> OrgReceiptResponse (strict org OR project branch)
 * GET /policies/:id?before=&version= -> {policy:OrgPolicyDetail}
 * POST /policies/save -> OrgReceiptResponse; /policies/:id/review -> {review:OrgPolicyPublishReview}
 * POST /policies/:id/{publish,retire} -> OrgReceiptResponse
 * POST /projects/:link/adoptions/review -> {review:OrgAdoptionReview}
 * POST /projects/:link/adoptions -> {receipt,application:OrgPolicyApplication}
 * GET /projects/:link/adoptions?before= -> {adoptions,nextCursor} (org-safe summaries)
 * GET /projects/:link/adoptions/:id -> {application:OrgPolicyApplication} (project organizer only)
 * POST /projects/:link/adoptions/:id/deactivate -> OrgReceiptResponse (project only)
 * POST /projects/:link/adoptions/:id/replace/review -> {review:OrgProjectRuleReplaceReview} (project only)
 * POST /projects/:link/adoptions/:id/replace -> {receipt,application:OrgPolicyApplication} (project only)
 * GET /portfolio?before= -> {portfolio:OrgPortfolioDesk}
 * POST /portfolio/review -> {portfolio:OrgPortfolioDesk} (read-only filtered review)
 * POST /portfolio/capture -> {receipt,view:OrgPortfolioView}
 * GET /portfolio/reports/:id -> {view:OrgPortfolioView}
 * GET /portfolio/projects/:link -> {detail:OrgPortfolioDetail}
 * GET /portfolio/reports/:id/projects/:link -> {detail:OrgPortfolioDetail}
 * GET /portfolio/reports/:id/export -> same frozen, currently authorized CSV
 *
 * All organization-authorized requests carry ORG_SCOPE_HEADER; dual commands
 * also carry ORG_PROJECT_SCOPE_HEADER. Project-only governance uses only its
 * separate project scope; an unrelated or absent org cookie cannot block it.
 * Library/entry reads instead bind their original browser/entry scope in body.
 * A changed project clears only project-bound reviews; a changed org invalidates
 * org responses, drafts, and both authorities' pending dual commands.
 * Every command rechecks original fixed expiry after locks and before commit;
 * private report/detail/CSV disclosure additionally rechecks current permission
 * after projection/serialization. Busy/network retry retains intent and payload.
 */
