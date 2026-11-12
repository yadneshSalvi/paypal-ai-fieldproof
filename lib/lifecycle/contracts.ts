import { z } from "zod";
import { orgBrowserContextSchema, orgDisclosureSectionSchema, orgPortfolioFilterSchema, orgProjectBasisSchema, orgProjectSummarySchema } from "../organizations/contracts";

export const LIFECYCLE_VERSION = "private-lifecycle-v1" as const;
export const LIFECYCLE_PROJECT_SCOPE_HEADER = "X-Fieldproof-Lifecycle-Project-Scope";
export const LIFECYCLE_CHANGE_CHANNEL = "fieldproof-lifecycle-changed";
export const LIFECYCLE_PAGE_SIZE = 20;
export const LIFECYCLE_INTERVAL_MINUTES = [15, 60, 1440, 10080] as const;
export const lifecycleIntervals = { 15: "Every 15 minutes", 60: "Every hour", 1440: "Every day", 10080: "Every week" } as const;
const id = z.uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), date = z.iso.datetime();
const head = z.number().int().nonnegative(), version = z.number().int().positive();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), minor = count;
const key = z.string().regex(/^[a-zA-Z0-9:_-]{1,180}$/), currency = z.string().regex(/^[A-Z]{3}$/);
const text = z.string().trim().min(1).max(1400).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "Use plain text without control characters.");
const title = text.max(120), note = text.min(8).max(1000), reasons = z.array(text).max(100);
const unique = (values: readonly unknown[]) => new Set(values).size === values.length;
const command = { intentId: id, expectedScope: hash }, ack = { acknowledged: z.literal(true) };
export const lifecycleProvenanceSchema = z.enum(["sample", "live_sandbox", "replay", "modelled"]);
export type LifecycleProvenance = z.infer<typeof lifecycleProvenanceSchema>;
export const lifecycleRoleSchema = z.enum(["donor", "volunteer", "organizer", "auditor"]);
export const lifecycleCategorySchema = z.enum(["pledges", "contributions", "choices", "repayments"]);
export type LifecycleCategory = z.infer<typeof lifecycleCategorySchema>;
export const lifecycleEventKindSchema = z.enum([
  "pledge_saved", "pledge_withdrawn", "pledge_expired", "contribution_collected", "contribution_return_pending", "contribution_returned", "contribution_moved", "purpose_cancelled",
  "repayment_pending", "repayment_completed", "repayment_failed", "repayment_returned", "repayment_action_required", "repayment_unknown",
]);
export type LifecycleEventKind = z.infer<typeof lifecycleEventKindSchema>;
export const lifecycleTopicSchema = z.enum(["budget", "funding", "expenses", "evidence", "consents", "exceptions"]);
export type LifecycleTopic = z.infer<typeof lifecycleTopicSchema>;
export const lifecycleValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("money"), currency, minor }).strict(),
  z.object({ kind: z.literal("count"), count }).strict(),
  z.object({ kind: z.literal("date"), value: date }).strict(),
  z.object({ kind: z.literal("label"), value: title, spanish: title.nullable() }).strict(),
  z.object({ kind: z.literal("unknown"), reason: text }).strict(),
]);
export type LifecycleValue = z.infer<typeof lifecycleValueSchema>;
/** Safe scalar rows only. Original source/recipient/provider identities and
 * document locations belong in the encrypted server dependency sidecar. */
export const lifecycleSourceRowSchema = z.object({
  id: key, contentHash: hash, label: title, topic: lifecycleTopicSchema,
  provenance: lifecycleProvenanceSchema, value: lifecycleValueSchema,
  observedAt: date.nullable(), limitation: text.nullable(),
}).strict();
export type LifecycleSourceRow = z.infer<typeof lifecycleSourceRowSchema>;
export const lifecycleStatementSchema = z.object({
  id: key, topic: lifecycleTopicSchema, english: text.max(2500), spanish: text.max(2500),
  values: z.array(z.object({ key, sourceId: key, sourceHash: hash }).strict()).max(30).refine(values => unique(values.map(value => value.key))),
  citations: z.array(z.object({ sourceId: key, sourceHash: hash }).strict()).min(1).max(30).refine(values => unique(values.map(value => value.sourceId))),
}).strict();
export type LifecycleStatement = z.infer<typeof lifecycleStatementSchema>;
export const lifecycleSnapshotSchema = z.object({
  contractVersion: z.literal(LIFECYCLE_VERSION), audience: z.enum(["project_treasurer", "organization_aggregate", "personal_event"]),
  asOf: date, basisHash: hash, snapshotHash: hash, targetLabel: title,
  sources: z.array(lifecycleSourceRowSchema).min(1).max(2000), statements: z.array(lifecycleStatementSchema).min(1).max(1000),
  observedRange: z.object({ earliest: date, latest: date }).strict().nullable(), notices: reasons,
}).strict().superRefine((value, ctx) => {
  if (!unique(value.sources.map(row => row.id)) || !unique(value.statements.map(row => row.id))) ctx.addIssue({ code: "custom", path: ["sources"], message: "Every frozen scalar source and factual sentence needs one unambiguous identity." });
});
export type LifecycleSnapshot = z.infer<typeof lifecycleSnapshotSchema>;
export const lifecycleContentSchema = z.object({
  contractVersion: z.literal(LIFECYCLE_VERSION), title, contentHash: hash, sourceHash: hash, asOf: date,
  origin: z.enum(["deterministic", "model_selected"]), statements: z.array(lifecycleStatementSchema).min(1).max(1000),
  delivery: z.literal("private_in_app"), externalSendingAuthorized: z.literal(false),
  spanishStatus: z.literal("authored_unreviewed"), notices: reasons,
}).strict().superRefine((value, ctx) => {
  if (!unique(value.statements.map(row => row.id))) ctx.addIssue({ code: "custom", path: ["statements"], message: "Retain every cited factual sentence at most once." });
});
export type LifecycleContent = z.infer<typeof lifecycleContentSchema>;
export const lifecycleSourceDetailSchema = z.object({ scope: hash, source: lifecycleSourceRowSchema, asOf: date, snapshotHash: hash, status: z.enum(["current", "historical"]), notices: reasons }).strict();
export type LifecycleSourceDetail = z.infer<typeof lifecycleSourceDetailSchema>;

export const lifecycleProjectContextSchema = z.object({
  scope: hash, state: z.enum(["none", "active", "ended"]),
  profile: z.object({ project: orgProjectSummarySchema, role: lifecycleRoleSchema, label: title, membershipVersion: version, expiresAt: date, identityProvenance: z.enum(["self_declared", "workspace_session"]) }).strict().nullable(),
  canReadInbox: z.boolean(), canChangePreferences: z.boolean(), canPrepareTreasurer: z.boolean(), reasons,
}).strict().superRefine((value, ctx) => {
  if ((value.state === "active") !== (value.profile !== null) || value.state !== "active" && (value.canReadInbox || value.canChangePreferences || value.canPrepareTreasurer) || value.canPrepareTreasurer && value.profile?.role !== "organizer") ctx.addIssue({ code: "custom", path: ["profile"], message: "Only an independently current project profile exposes its personal lifecycle rights; treasurer preparation needs its organizer role." });
});
export type LifecycleProjectContext = z.infer<typeof lifecycleProjectContextSchema>;
export const lifecycleContextSchema = z.object({
  contractVersion: z.literal(LIFECYCLE_VERSION), checkedAt: date, project: lifecycleProjectContextSchema, organization: orgBrowserContextSchema,
  canManageProgram: z.boolean(), canPrepareAggregate: z.boolean(), deliveryMode: z.literal("private_drafts_and_email_previews"),
}).strict().superRefine((value, ctx) => {
  const writer = value.organization.state === "active" && ["owner", "coordinator"].includes(value.organization.profile?.role ?? "");
  if ((value.canManageProgram || value.canPrepareAggregate) && !writer) ctx.addIssue({ code: "custom", path: ["canManageProgram"], message: "Organization scheduling requires current owner/coordinator authority. It grants no project role." });
});
export type LifecycleContext = z.infer<typeof lifecycleContextSchema>;

export const lifecyclePreferencesSchema = z.object({
  version: head, enabled: z.boolean(), categories: z.array(lifecycleCategorySchema).max(4).refine(unique),
  emailPreviews: z.boolean(), history: z.enum(["future_only", "current_records"]),
  optedInAt: date.nullable(), expiresAt: date.nullable(), status: z.enum(["disabled", "enabled", "expired", "authority_changed"]),
  canEdit: z.boolean(), reasons,
}).strict().superRefine((value, ctx) => {
  if (value.enabled && (!value.categories.length || !value.optedInAt || !value.expiresAt || value.status !== "enabled") || !value.enabled && value.status === "enabled") ctx.addIssue({ code: "custom", path: ["enabled"], message: "Enabled preferences retain an explicit category selection and original fixed authorization deadline." });
});
export type LifecyclePreferences = z.infer<typeof lifecyclePreferencesSchema>;
export const lifecyclePreferencesInputSchema = z.object({ ...command, expectedVersion: head, enabled: z.boolean(), categories: z.array(lifecycleCategorySchema).max(4).refine(unique), emailPreviews: z.boolean(), history: z.enum(["future_only", "current_records"]), ...ack }).strict().superRefine((value, ctx) => {
  if (value.enabled && !value.categories.length || !value.enabled && value.emailPreviews) ctx.addIssue({ code: "custom", path: ["categories"], message: "Choose the personal events to receive, or disable both future records and their email previews." });
});
export type LifecyclePreferencesInput = z.infer<typeof lifecyclePreferencesInputSchema>;
export const lifecycleReadStateSchema = z.enum(["unread", "read", "archived"]);
export type LifecycleReadState = z.infer<typeof lifecycleReadStateSchema>;
export const lifecycleInboxItemSchema = z.object({
  id, version, readState: lifecycleReadStateSchema, status: z.enum(["current", "historical", "withdrawn", "unavailable"]),
  kind: lifecycleEventKindSchema.nullable(), title: title.nullable(), occurredAt: date.nullable(), recordedAt: date,
  provenance: lifecycleProvenanceSchema.nullable(), contentHash: hash.nullable(), canRead: z.boolean(), canArchive: z.boolean(), canRestore: z.boolean(), reasons,
}).strict().superRefine((value, ctx) => {
  const visible = ["current", "historical"].includes(value.status);
  if (visible && !(value.kind && value.title && value.occurredAt && value.provenance && value.contentHash) || !visible && (value.kind !== null || value.title !== null || value.occurredAt !== null || value.provenance !== null || value.contentHash !== null || value.canRead)) ctx.addIssue({ code: "custom", path: ["title"], message: "Withdrawn personal items retain metadata only, without event, source or recipient details." });
});
export type LifecycleInboxItem = z.infer<typeof lifecycleInboxItemSchema>;
export const lifecycleEmailPreviewSchema = z.object({
  mode: z.literal("preview_only"), sent: z.literal(false), subject: title,
  english: z.array(text.max(2500)).min(1).max(1000), spanish: z.array(text.max(2500)).min(1).max(1000),
  sourceHash: hash, spanishStatus: z.literal("authored_unreviewed"), destination: z.null(), notices: reasons,
}).strict();
export type LifecycleEmailPreview = z.infer<typeof lifecycleEmailPreviewSchema>;
export const lifecycleInboxDetailSchema = z.object({ scope: hash, checkedAt: date, item: lifecycleInboxItemSchema, content: lifecycleContentSchema.nullable(), sources: z.array(lifecycleSourceRowSchema).max(2000), emailPreview: lifecycleEmailPreviewSchema.nullable() }).strict().superRefine((value, ctx) => {
  const visible = ["current", "historical"].includes(value.item.status);
  if (!visible && (value.content || value.sources.length || value.emailPreview) || visible && (!value.content || value.content.contentHash !== value.item.contentHash)) ctx.addIssue({ code: "custom", path: ["content"], message: "The exact authorized item hash controls every source sentence and preview; withdrawn content stays absent." });
});
export type LifecycleInboxDetail = z.infer<typeof lifecycleInboxDetailSchema>;
export const lifecycleInboxSchema = z.object({
  scope: hash, checkedAt: date, preferences: lifecyclePreferencesSchema, items: z.array(lifecycleInboxItemSchema).max(LIFECYCLE_PAGE_SIZE), nextCursor: z.string().max(500).nullable(),
  counts: z.object({ unread: count, read: count, archived: count }).strict(), filter: lifecycleReadStateSchema.nullable(),
}).strict();
export type LifecycleInbox = z.infer<typeof lifecycleInboxSchema>;
export const lifecycleInboxActionSchema = z.object({ ...command, expectedVersion: version, contentHash: hash.nullable(), action: z.enum(["read", "archive", "unarchive"]), ...ack }).strict();
export type LifecycleInboxAction = z.infer<typeof lifecycleInboxActionSchema>;

export const lifecycleProgramSchema = z.object({
  version: head, state: z.enum(["disabled", "enabled", "expired", "authority_changed"]), expiresAt: date.nullable(), maxExpiresAt: date.nullable(),
  canEnable: z.boolean(), canDisable: z.boolean(), reasons,
}).strict().superRefine((value, ctx) => { if (value.state === "enabled" && !value.expiresAt) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Organization opt-in retains its original fixed deadline." }); });
export type LifecycleProgram = z.infer<typeof lifecycleProgramSchema>;
export const lifecycleProgramEnableSchema = z.object({ ...command, expectedVersion: head, expiresAt: date, ...ack }).strict();
export const lifecycleProgramDisableSchema = z.object({ ...command, expectedVersion: version, reason: note, ...ack }).strict();
export const lifecycleConsentPinSchema = z.object({ linkId: id, linkVersion: version, consentRevision: version, consentHash: hash, expiresAt: date, disclosure: z.array(orgDisclosureSectionSchema).min(1).max(4).refine(unique) }).strict();
export type LifecycleConsentPin = z.infer<typeof lifecycleConsentPinSchema>;
const interval = z.union([z.literal(15), z.literal(60), z.literal(1440), z.literal(10080)]);
export const lifecycleCadenceSchema = z.object({ intervalMinutes: interval, timeZone: z.literal("UTC"), firstDueAt: date }).strict();
export type LifecycleCadence = z.infer<typeof lifecycleCadenceSchema>;
export const lifecycleTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project_treasurer"), expectedProjectScope: hash, projectId: z.string().min(1).max(160), expectedProjectBasis: orgProjectBasisSchema, link: lifecycleConsentPinSchema }).strict(),
  z.object({ kind: z.literal("organization_aggregate"), expectedProjectScope: z.null(), filters: orgPortfolioFilterSchema, expectedBasisHash: hash, links: z.array(lifecycleConsentPinSchema).min(1).max(200).refine(values => unique(values.map(value => value.linkId))) }).strict(),
]);
export type LifecycleTarget = z.infer<typeof lifecycleTargetSchema>;
export const lifecycleScheduleProposalSchema = z.object({
  title, target: lifecycleTargetSchema, cadence: lifecycleCadenceSchema, expiresAt: date,
  topics: z.array(lifecycleTopicSchema).min(1).max(6).refine(unique), drafting: z.literal("deterministic"),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.cadence.firstDueAt)) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "The original authorization must remain valid beyond the first due occurrence." });
  if (value.target.kind === "organization_aggregate" && value.topics.some(topic => !orgDisclosureSectionSchema.options.includes(topic as z.infer<typeof orgDisclosureSectionSchema>))) ctx.addIssue({ code: "custom", path: ["topics"], message: "An aggregate draft can contain approved aggregate sections only, without private consent or exception records." });
});
export type LifecycleScheduleProposal = z.infer<typeof lifecycleScheduleProposalSchema>;
export const lifecycleSchedulePrepareSchema = z.object({
  expectedScope: hash, expectedProgramVersion: version, scheduleId: id.nullable(), expectedDefinitionVersion: head, expectedVersion: head,
  proposal: lifecycleScheduleProposalSchema,
}).strict().superRefine((value, ctx) => {
  if (value.scheduleId === null && (value.expectedVersion || value.expectedDefinitionVersion) || value.scheduleId !== null && (!value.expectedVersion || !value.expectedDefinitionVersion)) ctx.addIssue({ code: "custom", path: ["scheduleId"], message: "Bind either a new schedule or both exact existing schedule heads." });
});
export type LifecycleSchedulePrepare = z.infer<typeof lifecycleSchedulePrepareSchema>;
export const lifecycleAuthorizationSchema = z.object({
  organizationRole: z.enum(["owner", "coordinator"]), organizationMembershipVersion: version, organizationExpiresAt: date,
  programVersion: version, programExpiresAt: date,
  project: z.object({ role: z.literal("organizer"), membershipVersion: version, expiresAt: date }).strict().nullable(),
  links: z.array(lifecycleConsentPinSchema).min(1).max(200), expiresAt: date,
}).strict().superRefine((value, ctx) => {
  if (!unique(value.links.map(link => link.linkId)) || Date.parse(value.expiresAt) > Math.min(Date.parse(value.organizationExpiresAt), Date.parse(value.programExpiresAt), ...value.links.map(link => Date.parse(link.expiresAt)), value.project ? Date.parse(value.project.expiresAt) : Infinity)) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "No schedule or retry may extend any original organization, project, program or disclosure deadline." });
});
export type LifecycleAuthorization = z.infer<typeof lifecycleAuthorizationSchema>;
export const lifecycleScheduleReviewSchema = z.object({
  reviewHash: hash, input: lifecycleSchedulePrepareSchema, sourceBasisHash: hash, checkedAt: date,
  authorization: lifecycleAuthorizationSchema, targetLabel: title, sourceSummary: reasons,
  warnings: reasons, blockers: reasons, canEnable: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if ((value.input.proposal.target.kind === "project_treasurer") !== (value.authorization.project !== null) || value.authorization.programVersion !== value.input.expectedProgramVersion || value.canEnable && (value.blockers.length > 0 || Date.parse(value.authorization.expiresAt) <= Date.parse(value.input.proposal.cadence.firstDueAt))) ctx.addIssue({ code: "custom", path: ["authorization"], message: "The reviewed audience, original authority and first occurrence must describe the same permitted schedule." });
  const target = value.input.proposal.target, requested = target.kind === "project_treasurer" ? [target.link] : target.links;
  const pins = (links: LifecycleConsentPin[]) => links.map(link => JSON.stringify([link.linkId, link.linkVersion, link.consentRevision, link.consentHash, link.expiresAt, [...link.disclosure].sort()])).sort();
  if (JSON.stringify(pins(requested)) !== JSON.stringify(pins(value.authorization.links)) || Date.parse(value.authorization.expiresAt) > Date.parse(value.input.proposal.expiresAt) || value.canEnable && Date.parse(value.input.proposal.cadence.firstDueAt) <= Date.parse(value.checkedAt)) ctx.addIssue({ code: "custom", path: ["authorization"], message: "The reviewed exact links and original deadline cannot be widened, or a past first occurrence silently reconstructed." });
});
export type LifecycleScheduleReview = z.infer<typeof lifecycleScheduleReviewSchema>;
export const lifecycleScheduleEnableSchema = z.object({ ...command, reviewHash: hash, review: lifecycleSchedulePrepareSchema, ...ack }).strict().superRefine((value, ctx) => { if (value.expectedScope !== value.review.expectedScope) ctx.addIssue({ code: "custom", path: ["expectedScope"], message: "Retain the reviewed original organization context." }); });
export type LifecycleScheduleEnable = z.infer<typeof lifecycleScheduleEnableSchema>;
export const lifecycleAudienceSchema = z.enum(["project_treasurer", "organization_aggregate"]);
export const lifecycleScheduleSchema = z.object({
  id, version, definitionVersion: version, definitionHash: hash, audience: lifecycleAudienceSchema,
  state: z.enum(["enabled", "paused", "disabled", "expired", "authority_changed", "disclosure_suspended"]), access: z.enum(["ready", "project_profile_required", "authority_ended"]),
  definition: lifecycleScheduleProposalSchema.nullable(), authorization: lifecycleAuthorizationSchema.nullable(), targetLabel: title.nullable(),
  nextDueAt: date.nullable(), createdAt: date, canPause: z.boolean(), canResume: z.boolean(), canDisable: z.boolean(), canReplace: z.boolean(), reasons,
}).strict().superRefine((value, ctx) => {
  if (value.access !== "ready" && (value.definition || value.authorization || value.targetLabel || value.nextDueAt || value.canResume || value.canReplace)) ctx.addIssue({ code: "custom", path: ["definition"], message: "Without the exact original scope, retain recovery metadata only; no private target or resume authority is inferred." });
  if (["expired", "authority_changed", "disclosure_suspended"].includes(value.state) && (value.definition || value.authorization || value.targetLabel || value.nextDueAt || value.canPause || value.canResume)) ctx.addIssue({ code: "custom", path: ["definition"], message: "Ended authority retains metadata only; an older project or organization must not remain visible." });
  if (value.state === "disabled" && (value.canResume || value.nextDueAt)) ctx.addIssue({ code: "custom", path: ["canResume"], message: "A disabled definition cannot silently revive or enqueue more work." });
});
export type LifecycleSchedule = z.infer<typeof lifecycleScheduleSchema>;
export const lifecycleScheduleActionSchema = z.object({ ...command, expectedProjectScope: hash.nullable(), expectedVersion: version, expectedDefinitionVersion: version, definitionHash: hash, action: z.enum(["pause", "resume", "disable"]), reason: note, ...ack }).strict();
export type LifecycleScheduleAction = z.infer<typeof lifecycleScheduleActionSchema>;

export const lifecycleOccurrenceStateSchema = z.enum(["due", "capturing", "drafting", "ready", "retry_wait", "skipped_paused", "blocked_authority", "blocked_source", "expired", "cancelled", "failed"]);
export const lifecycleAttemptSchema = z.object({ attempt: version, startedAt: date, completedAt: date.nullable(), stage: z.enum(["capture", "draft", "model_poll"]), outcome: z.enum(["running", "succeeded", "retryable", "blocked", "failed"]), code: z.string().max(100).nullable(), nextRetryAt: date.nullable() }).strict();
export type LifecycleAttempt = z.infer<typeof lifecycleAttemptSchema>;
export const lifecycleOccurrenceSchema = z.object({
  id, version, scheduleId: id, definitionVersion: version, occurrenceKey: hash, audience: lifecycleAudienceSchema, dueAt: date, recordedAt: date,
  state: lifecycleOccurrenceStateSchema, status: z.enum(["current", "historical", "withdrawn", "unavailable"]),
  title: title.nullable(), targetLabel: title.nullable(), provenance: z.array(lifecycleProvenanceSchema).max(4).refine(unique),
  capturedAt: date.nullable(), snapshotHash: hash.nullable(), contentHash: hash.nullable(),
  readState: lifecycleReadStateSchema, review: z.enum(["unreviewed", "reviewed_private", "changes_requested", "historical"]),
  authorizationExpiresAt: date, totalAttempts: count, attempts: z.array(lifecycleAttemptSchema).max(LIFECYCLE_PAGE_SIZE), attemptsNextCursor: z.string().max(500).nullable(), nextRetryAt: date.nullable(),
  canRetry: z.boolean(), canReview: z.boolean(), canRead: z.boolean(), canArchive: z.boolean(), canRestore: z.boolean(), reasons,
}).strict().superRefine((value, ctx) => {
  if (["withdrawn", "unavailable"].includes(value.status) && (value.title || value.targetLabel || value.provenance.length || value.capturedAt || value.snapshotHash || value.contentHash || value.canRetry || value.canReview || value.canRead)) ctx.addIssue({ code: "custom", path: ["contentHash"], message: "A withdrawn occurrence exposes only recovery metadata, not the earlier private source context." });
  if (value.canRetry && !["retry_wait", "failed"].includes(value.state) || value.canReview && (value.state !== "ready" || value.status !== "current")) ctx.addIssue({ code: "custom", path: ["canRetry"], message: "Only the exact saved retryable occurrence or current ready private draft can accept that action." });
  if (value.state === "skipped_paused" && (value.capturedAt || value.snapshotHash || value.contentHash || value.canRetry || value.canReview || value.canRead)) ctx.addIssue({ code: "custom", path: ["capturedAt"], message: "A paused slot records an explicit skip; it cannot capture a later source or become a catch-up draft." });
  if (value.capturedAt && Date.parse(value.capturedAt) < Date.parse(value.dueAt)) ctx.addIssue({ code: "custom", path: ["capturedAt"], message: "The actual occurrence capture cannot be relabelled as a cutoff before its original due slot." });
});
export type LifecycleOccurrence = z.infer<typeof lifecycleOccurrenceSchema>;
export const lifecycleOccurrenceDetailSchema = z.object({ scope: hash, checkedAt: date, occurrence: lifecycleOccurrenceSchema, content: lifecycleContentSchema.nullable(), sources: z.array(lifecycleSourceRowSchema).max(2000) }).strict().superRefine((value, ctx) => {
  const hidden = ["withdrawn", "unavailable"].includes(value.occurrence.status);
  if (hidden && (value.content || value.sources.length) || value.content && (value.content.contentHash !== value.occurrence.contentHash || value.content.sourceHash !== value.occurrence.snapshotHash || value.content.asOf !== value.occurrence.capturedAt)) ctx.addIssue({ code: "custom", path: ["content"], message: "A source or authority change cannot expose a previous audience's private draft; preserve its original hashes and actual capture cutoff." });
});
export type LifecycleOccurrenceDetail = z.infer<typeof lifecycleOccurrenceDetailSchema>;
const occurrenceCommand = { ...command, expectedProjectScope: hash.nullable(), expectedVersion: version, occurrenceKey: hash };
export const lifecycleOccurrenceRetrySchema = z.object({ ...occurrenceCommand, expectedSnapshotHash: hash.nullable(), ...ack }).strict();
export type LifecycleOccurrenceRetry = z.infer<typeof lifecycleOccurrenceRetrySchema>;
export const lifecycleOccurrenceReviewSchema = z.object({ ...occurrenceCommand, snapshotHash: hash, contentHash: hash, decision: z.enum(["reviewed_private", "changes_requested"]), note, sourcesChecked: z.literal(true), privateDraftOnly: z.literal(true), ...ack }).strict();
export type LifecycleOccurrenceReview = z.infer<typeof lifecycleOccurrenceReviewSchema>;
export const lifecycleOccurrenceActionSchema = z.object({ ...occurrenceCommand, contentHash: hash.nullable(), action: z.enum(["read", "archive", "unarchive"]), ...ack }).strict();
export const lifecycleScheduleDeskSchema = z.object({ scope: hash, checkedAt: date, program: lifecycleProgramSchema, schedules: z.array(lifecycleScheduleSchema).max(LIFECYCLE_PAGE_SIZE), nextCursor: z.string().max(500).nullable(), canPrepare: z.boolean() }).strict().superRefine((value, ctx) => { if (value.schedules.some(row => row.audience === "project_treasurer" && row.access === "ready")) ctx.addIssue({ code: "custom", path: ["schedules"], message: "Organization-only schedule lists retain private project recovery metadata, never an independently scoped definition." }); });
export type LifecycleScheduleDesk = z.infer<typeof lifecycleScheduleDeskSchema>;
export const lifecycleOccurrencePageSchema = z.object({ scope: hash, checkedAt: date, occurrences: z.array(lifecycleOccurrenceSchema).max(LIFECYCLE_PAGE_SIZE), nextCursor: z.string().max(500).nullable() }).strict().superRefine((value, ctx) => { if (value.occurrences.some(row => row.audience === "project_treasurer" && !["withdrawn", "unavailable"].includes(row.status))) ctx.addIssue({ code: "custom", path: ["occurrences"], message: "Organization-only history retains private project metadata; its source facts and hashes require the original independent project organizer." }); });
export type LifecycleOccurrencePage = z.infer<typeof lifecycleOccurrencePageSchema>;
export const lifecycleAttemptPageSchema = z.object({ scope: hash, occurrenceId: id, occurrenceKey: hash, total: count, attempts: z.array(lifecycleAttemptSchema).max(LIFECYCLE_PAGE_SIZE), nextCursor: z.string().max(500).nullable() }).strict();
export type LifecycleAttemptPage = z.infer<typeof lifecycleAttemptPageSchema>;
export const lifecycleTargetsSchema = z.object({
  scope: hash, projectScope: hash.nullable(), checkedAt: date, audience: lifecycleAudienceSchema,
  project: z.object({ project: orgProjectSummarySchema, projectBasis: orgProjectBasisSchema, link: lifecycleConsentPinSchema }).strict().nullable(),
  aggregate: z.object({ basisHash: hash, filters: orgPortfolioFilterSchema, links: z.array(lifecycleConsentPinSchema).min(1).max(200), availableLinks: z.array(z.object({ project: orgProjectSummarySchema, link: lifecycleConsentPinSchema }).strict()).max(200), notices: reasons }).strict().nullable(), reasons,
}).strict().superRefine((value, ctx) => {
  if (value.audience === "organization_aggregate" && (value.project || value.projectScope) || value.audience === "project_treasurer" && value.aggregate || value.project && !value.projectScope) ctx.addIssue({ code: "custom", path: ["audience"], message: "An aggregate target has no project-cookie context; private project details require that separate original organizer context." });
});
export type LifecycleTargets = z.infer<typeof lifecycleTargetsSchema>;

export const LIFECYCLE_ERROR_CODES = [
  "LIFECYCLE_AUTH_REQUIRED", "LIFECYCLE_PROJECT_CHANGED", "LIFECYCLE_ORGANIZATION_CHANGED", "LIFECYCLE_AUTHORITY_ENDED", "LIFECYCLE_VERSION_CHANGED", "LIFECYCLE_INTENT_CHANGED", "LIFECYCLE_BUSY", "LIFECYCLE_RESOURCE_UNAVAILABLE", "LIFECYCLE_PROGRAM_DISABLED", "LIFECYCLE_SCHEDULE_PAUSED", "LIFECYCLE_SCHEDULE_DISABLED", "LIFECYCLE_EXPIRED", "LIFECYCLE_SOURCE_WITHDRAWN", "LIFECYCLE_SOURCE_CHANGED", "LIFECYCLE_REVIEW_REQUIRED", "LIFECYCLE_OCCURRENCE_CHANGED", "LIFECYCLE_RETRY_NOT_ALLOWED", "LIFECYCLE_MODEL_IDENTITY_UNKNOWN",
  "ORG_AUTH_REQUIRED", "ORG_CONTEXT_CHANGED", "ORG_SESSION_EXPIRED", "ORG_AUTHORITY_ENDED", "ORG_ROLE_DENIED", "ORG_PROJECT_CONTEXT_CHANGED", "ORG_PROJECT_AUTHORITY_REQUIRED", "ORG_LINK_EXPIRED", "ORG_LINK_SUSPENDED", "ORG_LINK_WITHDRAWN", "WORKSPACE_CONTEXT_CHANGED", "WORKSPACE_MAINTENANCE", "INVALID_INPUT", "INPUT_TOO_LARGE", "REQUEST_UNAVAILABLE",
] as const;
export const lifecycleProblemSchema = z.object({ error: text, code: z.enum(LIFECYCLE_ERROR_CODES), fields: z.array(z.object({ path: z.string().max(300), message: text }).strict()).max(100).optional() }).strict();
export type LifecycleProblem = z.infer<typeof lifecycleProblemSchema>;
export const lifecycleReceiptSchema = z.object({ intentId: id, kind: z.enum(["preferences", "inbox_state", "program_enable", "program_disable", "schedule_enable", "schedule_action", "occurrence_retry", "occurrence_review", "occurrence_state"]), resourceId: id.nullable(), resourceVersion: head, recordedAt: date, message: text }).strict();
export type LifecycleReceipt = z.infer<typeof lifecycleReceiptSchema>;

/** Exact reviewed commands only; no private source paragraphs, document URL,
 * credential, email address or model/provider request is accepted here. */
export const lifecycleCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preferences"), input: lifecyclePreferencesInputSchema }).strict(),
  z.object({ kind: z.literal("inbox_state"), resourceId: id, input: lifecycleInboxActionSchema }).strict(),
  z.object({ kind: z.literal("program_enable"), input: lifecycleProgramEnableSchema }).strict(),
  z.object({ kind: z.literal("program_disable"), input: lifecycleProgramDisableSchema }).strict(),
  z.object({ kind: z.literal("schedule_enable"), input: lifecycleScheduleEnableSchema }).strict(),
  z.object({ kind: z.literal("schedule_action"), resourceId: id, input: lifecycleScheduleActionSchema }).strict(),
  z.object({ kind: z.literal("occurrence_retry"), resourceId: id, input: lifecycleOccurrenceRetrySchema }).strict(),
  z.object({ kind: z.literal("occurrence_review"), resourceId: id, input: lifecycleOccurrenceReviewSchema }).strict(),
  z.object({ kind: z.literal("occurrence_state"), resourceId: id, input: lifecycleOccurrenceActionSchema }).strict(),
]);
export type LifecycleCommand = z.infer<typeof lifecycleCommandSchema>;

/** Fixed service protocol. Every private GET is no-store and reauthorizes its
 * current exact audience after serialization. The scheduler authenticates its
 * operator separately, then rechecks each original delegated grant. A cron key
 * cannot widen a recipient, project, model authority or delivery right.
 *
 * GET  /api/lifecycle/context                           -> { context }
 * GET  /api/lifecycle/inbox?state=&before=               -> { inbox }
 * GET  /api/lifecycle/inbox/:itemId                      -> { detail }
 * GET  /api/lifecycle/inbox/:itemId/sources/:sourceId    -> { detail: LifecycleSourceDetail }
 * POST /api/lifecycle/preferences                       PreferencesInput -> { receipt }
 * POST /api/lifecycle/inbox/:itemId/state                InboxAction -> { receipt }
 * GET  /api/lifecycle/schedules?before=                  -> { desk }
 * GET  /api/lifecycle/schedules/:scheduleId              -> { schedule: LifecycleSchedule }
 * GET  /api/lifecycle/targets?audience=&filters=         -> { targets }
 * POST /api/lifecycle/program/enable                    ProgramEnable -> { receipt }
 * POST /api/lifecycle/program/disable                   ProgramDisable -> { receipt }
 * POST /api/lifecycle/schedules/prepare                 SchedulePrepare -> { review }
 * POST /api/lifecycle/schedules                         ScheduleEnable -> { receipt }
 * POST /api/lifecycle/schedules/:scheduleId/state        ScheduleAction -> { receipt }
 * GET  /api/lifecycle/occurrences?before=                -> { page }
 * GET  /api/lifecycle/occurrences/:occurrenceId          -> { detail }
 * GET  /api/lifecycle/occurrences/:id/attempts?before=    -> { page: LifecycleAttemptPage }
 * GET  /api/lifecycle/occurrences/:id/sources/:sourceId   -> { detail: LifecycleSourceDetail }
 * POST /api/lifecycle/occurrences/:id/retry              OccurrenceRetry -> { receipt }
 * POST /api/lifecycle/occurrences/:id/review             OccurrenceReview -> { receipt }
 * POST /api/lifecycle/occurrences/:id/state              OccurrenceAction -> { receipt }
 *
 * Inbox/preferences use LIFECYCLE_PROJECT_SCOPE_HEADER and the current project
 * actor+role only. Donor preferences cover pledges/contributions/choices;
 * volunteer preferences cover repayments. Neither opts in for another role. Program and organization aggregate reads use ORG_SCOPE_HEADER
 * only. Project preparation/enable/content/source/review/retry additionally uses
 * ORG_PROJECT_SCOPE_HEADER and its exact independently current original project
 * organizer. Org-only lists may retain recovery metadata for those private rows,
 * never their project facts. Aggregate reads never depend on a project cookie.
 * Private schedule detail uses both original scopes before exposing its
 * definition or resume/replacement controls; org-only lists remain metadata.
 * GET targets requests exactly one audience. Project targets require both
 * scopes; aggregate targets use only the org scope, project/projectScope:null,
 * and optional JSON OrgPortfolioFilter in filters. AvailableLinks includes
 * approved aggregate metadata only. Pause/disable may reduce an owned schedule
 * under current org authority alone; resuming a project schedule needs both.
 *
 * Mutations persist intent+canonical payload+minimal receipt atomically, and
 * changed-payload retries are409. State/head/source conflicts are409; expired
 * or withdrawn private content is metadata-only (source detail410); wrong
 * actor/role is403/404 without recipient/source detail. Busy/network recovery
 * retains the identical request. No route sends email or accepts a destination.
 *
 * Program re-enable requires new preparation. Pause records skipped due slots;
 * disable is terminal for that definition. Occurrence identity is independent
 * of retry attempt, read/archive state, source refresh and model response IDs.
 * Capture actual transaction time once, separately from original dueAt, before
 * drafting; retry uses the exact saved snapshot, never a new historical cutoff.
 * Due slots during a pause are skipped and remain visible in paged history;
 * resume starts the next original slot, never catches paused slots up later.
 * Optional model selection can use only supplied source-bound sentence IDs;
 * it is a separate explicit request, never a scheduler's automatic inference.
 * Preparation/enable bind current source heads; a later due occurrence may
 * capture new facts within the same fixed authority, topics and consent heads.
 * Source changes never replace an already saved occurrence snapshot.
 */
