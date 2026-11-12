import { z } from "zod";
import { competencyScopeSchema, sourceRegionSchema } from "../planning/contracts";
import { TEMPLATE_IDS } from "../community/templates";

export const PROCUREMENT_VERSION = "project-procurement-v1" as const;
export const PROCUREMENT_SCOPE_HEADER = "X-Fieldproof-Procurement-Scope";
export const PROCUREMENT_CHANGE_CHANNEL = "fieldproof-procurement-changed";
export const PROCUREMENT_PAGE_SIZE = 20;
const id = z.uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), date = z.iso.datetime();
const key = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), version = z.number().int().positive(), head = z.number().int().nonnegative();
const minor = z.number().int().min(0).max(100_000_000), count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), currency = z.string().regex(/^[A-Z]{3}$/);
const scalarMinor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = z.string().trim().min(1).max(1400).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "Use plain text without control characters.");
const title = text.max(160), reason = text.min(8).max(1000), reasons = z.array(text).max(100), cursor = z.string().min(1).max(500).nullable();
const unique = (values: readonly unknown[]) => new Set(values).size === values.length;
const command = { intentId: id, expectedScope: hash }, ack = { acknowledged: z.literal(true) };
export const procurementRoleSchema = z.enum(["organizer", "volunteer", "auditor", "donor"]);
export type ProcurementRole = z.infer<typeof procurementRoleSchema>;
export const procurementStateSchema = z.enum(["draft", "approved", "procurement_ready", "in_progress", "review_pending", "accepted", "blocked", "canceled", "reopened"]);
export type ProcurementState = z.infer<typeof procurementStateSchema>;
export const procurementProvenanceSchema = z.enum(["sample", "user_declared", "reviewer_attested", "provider_observed", "replay"]);
export type ProcurementProvenance = z.infer<typeof procurementProvenanceSchema>;
export const procurementFundingStateSchema = z.enum(["open", "ready", "collecting", "recovering", "funded", "funding_review", "compensating", "cancelled"]);
export const procurementProjectSchema = z.object({ id: z.string().min(1).max(160), title, templateId: z.enum(TEMPLATE_IDS), mode: z.enum(["sample", "live_sandbox"]), currency }).strict();
export type ProcurementProject = z.infer<typeof procurementProjectSchema>;
export const procurementContextSchema = z.object({
  contractVersion: z.literal(PROCUREMENT_VERSION), scope: hash, state: z.enum(["none", "active", "ended"]), checkedAt: date,
  project: procurementProjectSchema.nullable(), profile: z.object({ label: title, role: procurementRoleSchema, membershipVersion: version, expiresAt: date, identityProvenance: z.enum(["self_declared", "workspace_session"]) }).strict().nullable(),
  canRead: z.boolean(), canManage: z.boolean(), canProposeQuotes: z.boolean(), canReportOwnWork: z.boolean(), canInviteVolunteers: z.boolean(), reasons,
}).strict().superRefine((value, ctx) => {
  if ((value.state === "active") !== !!value.profile || (value.state === "active") !== !!value.project || value.state !== "active" && [value.canRead, value.canManage, value.canProposeQuotes, value.canReportOwnWork, value.canInviteVolunteers].some(Boolean)) ctx.addIssue({ code: "custom", path: ["profile"], message: "Only the independently current project profile exposes scoped procurement rights." });
  if ((value.canManage || value.canInviteVolunteers) && value.profile?.role !== "organizer" || value.canReportOwnWork && !["organizer", "volunteer"].includes(value.profile?.role ?? "") || value.canProposeQuotes && !["organizer", "volunteer"].includes(value.profile?.role ?? "") || value.canRead && value.profile?.role === "donor") ctx.addIssue({ code: "custom", path: ["canManage"], message: "Controls follow the exact current project role. A procurement assignment never grants membership or financial authority." });
});
export type ProcurementContext = z.infer<typeof procurementContextSchema>;

/** Supplier information is a project user's declaration. No contact message,
 * account validation, supplier response or purchase is implied. */
export const supplierDraftSchema = z.object({ name: title, description: text.max(1000), declaredLocation: text.max(200).nullable(), sourceNote: reason, provenance: z.enum(["user_declared", "sample"]), ...ack }).strict();
export type SupplierDraft = z.infer<typeof supplierDraftSchema>;
export const supplierSaveSchema = z.object({ ...command, supplierId: id.nullable(), expectedVersion: head, draft: supplierDraftSchema }).strict().superRefine((value, ctx) => { if ((value.supplierId === null) !== (value.expectedVersion === 0)) ctx.addIssue({ code: "custom", path: ["supplierId"], message: "Bind either a new supplier or the exact current supplier version." }); });
export const supplierStateSchema = z.object({ ...command, expectedVersion: version, action: z.enum(["archive", "restore"]), reason, ...ack }).strict();
export const supplierViewSchema = z.object({ id, version, state: z.enum(["active", "archived"]), name: title, description: text.max(1000), declaredLocation: text.max(200).nullable(), sourceNote: reason, provenance: z.enum(["user_declared", "sample"]), identityVerified: z.literal(false), own: z.boolean(), createdAt: date, updatedAt: date, canEdit: z.boolean(), canArchive: z.boolean(), canRestore: z.boolean() }).strict();
export type SupplierView = z.infer<typeof supplierViewSchema>;

export const quoteSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("document"), documentId: id, documentVersion: version, contentHash: hash, controlVersion: version, page: z.number().int().min(1).max(12), region: sourceRegionSchema, excerpt: text.max(600), sourceChecked: z.boolean() }).strict(),
  z.object({ kind: z.literal("entered_estimate"), note: text.min(20).max(1000), declaredAt: date, sourceChecked: z.boolean() }).strict(),
]);
export type QuoteSource = z.infer<typeof quoteSourceSchema>;
export const quoteLineSchema = z.object({ key, description: title, quantity: z.number().int().min(1).max(100_000).nullable(), unitMinor: minor.nullable(), lineMinor: minor.nullable(), capabilityKeys: z.array(text.max(160)).max(12).refine(unique), sourceText: text.max(600).nullable() }).strict();
export type QuoteLine = z.infer<typeof quoteLineSchema>;
export const quoteDraftSchema = z.object({
  supplierId: id, supplierVersion: version, packageIds: z.array(key).min(1).max(20).refine(unique), title,
  currency, lines: z.array(quoteLineSchema).min(1).max(60), taxMinor: minor.nullable(), deliveryMinor: minor.nullable(), discountMinor: minor.nullable(), statedTotalMinor: minor.nullable(),
  priceBasis: z.enum(["exclusive_components", "all_inclusive"]),
  validUntil: date.nullable(), estimatedLeadDays: z.number().int().min(0).max(3660).nullable(), terms: text.max(1000).nullable(), source: quoteSourceSchema,
  capabilityAssessment: z.array(z.object({ capability: text.max(160), state: z.enum(["supported", "unknown", "conflict"]), note: reason }).strict()).max(12),
  provenance: z.enum(["user_declared", "sample"]),
  allocation: z.discriminatedUnion("kind", [z.object({ kind: z.literal("single_package") }).strict(), z.object({ kind: z.literal("reviewed_shares"), shares: z.array(z.object({ packageId: key, amountMinor: minor.nullable(), note: reason }).strict()).min(1).max(20) }).strict()]),
}).strict().superRefine((value, ctx) => {
  if (!unique(value.lines.map(line => line.key)) || !unique(value.capabilityAssessment.map(row => row.capability))) ctx.addIssue({ code: "custom", path: ["lines"], message: "Keep each quote line and current capability assessment unambiguous." });
  if (value.priceBasis === "all_inclusive" && [value.taxMinor, value.deliveryMinor, value.discountMinor].some(amount => amount !== 0)) ctx.addIssue({ code: "custom", path: ["priceBasis"], message: "All-inclusive line totals require explicitly reviewed zero additional components. Unknown is not zero." });
  if (value.allocation.kind === "single_package" ? value.packageIds.length !== 1 : !unique(value.allocation.shares.map(row => row.packageId)) || value.allocation.shares.length !== value.packageIds.length || value.allocation.shares.some(row => !value.packageIds.includes(row.packageId))) ctx.addIssue({ code: "custom", path: ["allocation"], message: "A bundled quote needs an explicit nonduplicated cost share for every scoped package. Never reuse the whole bundle amount for each package." });
});
export type QuoteDraft = z.infer<typeof quoteDraftSchema>;
export const quoteSaveSchema = z.object({ ...command, quoteId: id.nullable(), expectedVersion: head, expectedPackageVersions: z.record(key, version), revisionReason: reason, draft: quoteDraftSchema }).strict().superRefine((value, ctx) => { if ((value.quoteId === null) !== (value.expectedVersion === 0) || (Object.keys(value.expectedPackageVersions).length !== value.draft.packageIds.length || value.draft.packageIds.some(packageId => !Object.hasOwn(value.expectedPackageVersions, packageId)))) ctx.addIssue({ code: "custom", path: ["quoteId"], message: "Bind the exact quote and every current target package version." }); });
export const quoteReviewSchema = z.object({ ...command, expectedVersion: version, contentHash: hash, decision: z.enum(["reviewed", "needs_information", "retired"]), note: reason, sourceChecked: z.boolean(), amountsChecked: z.boolean(), limitationsAcknowledged: z.literal(true) }).strict().superRefine((value, ctx) => { if (value.decision !== "retired" && (!value.sourceChecked || !value.amountsChecked)) ctx.addIssue({ code: "custom", message: "Review the exact source and amounts before recording a source decision. Retirement alone makes no source-review attestation." }); });
export const quoteArithmeticSchema = z.object({ subtotalMinor: scalarMinor.nullable(), calculatedTotalMinor: scalarMinor.nullable(), statedTotalMinor: minor.nullable(), differenceMinor: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(), complete: z.boolean(), allocationComplete: z.boolean(), allocationTotalMinor: scalarMinor.nullable(), packageCosts: z.array(z.object({ packageId: key, amountMinor: minor.nullable(), basis: z.enum(["source_total", "reviewed_internal_share"]) }).strict()).min(1).max(20), missing: z.array(text.max(200)).max(200), errors: reasons }).strict();
export type QuoteArithmetic = z.infer<typeof quoteArithmeticSchema>;
export const quoteViewSchema = z.object({ id, version, contentHash: hash, state: z.enum(["draft", "reviewed", "needs_information", "retired", "expired", "source_withdrawn", "supplier_changed"]), recordedState: z.enum(["draft", "reviewed", "needs_information", "retired"]), own: z.boolean(), draft: quoteDraftSchema.nullable(), supplier: z.object({ id, version, name: title, identityVerified: z.literal(false) }).strict().nullable(), arithmetic: quoteArithmeticSchema.nullable(), sourceAvailable: z.boolean(), review: z.object({ decision: z.enum(["reviewed", "needs_information", "retired"]), note: reason, reviewedAt: date }).strict().nullable(), createdAt: date, updatedAt: date, canEdit: z.boolean(), canReview: z.boolean(), canRetire: z.boolean(), canInspectSource: z.boolean(), reasons }).strict().superRefine((value, ctx) => {
  if (value.state === "source_withdrawn" && (value.draft || value.supplier || value.arithmetic || value.review || value.sourceAvailable || value.canInspectSource)) ctx.addIssue({ code: "custom", path: ["draft"], message: "A withdrawn source retains only safe quote recovery metadata." });
});
export type QuoteView = z.infer<typeof quoteViewSchema>;
export const quoteSourceOptionSchema = z.object({ documentId: id, version, contentHash: hash, controlVersion: version, label: z.string().min(1).max(180), provenance: z.enum(["user_upload", "sample_document"]), own: z.boolean(), pages: z.array(z.object({ number: z.number().int().min(1).max(12), width: count, height: count }).strict()).max(12) }).strict();
export type QuoteSourceOption = z.infer<typeof quoteSourceOptionSchema>;
export const quoteSourceDetailSchema = z.object({ scope: hash, quoteId: id, quoteVersion: version, contentHash: hash, status: z.enum(["current", "historical"]), provenance: z.enum(["user_declared", "sample"]), excerpt: text.max(1000), observedAt: date.nullable(), originalDocumentAccess: z.boolean(), preview: z.object({ page: version, width: count, height: count, contentHash: hash }).strict().nullable(), notices: reasons }).strict().superRefine((value, ctx) => { if (!value.originalDocumentAccess && value.preview) ctx.addIssue({ code: "custom", path: ["preview"], message: "An assigned scalar summary grants no original-document or image access." }); });
export type QuoteSourceDetail = z.infer<typeof quoteSourceDetailSchema>;

export const responsibleCandidateSchema = z.object({ id, label: title, role: z.enum(["organizer", "volunteer"]), membershipVersion: version, authorityHash: hash, expiresAt: date, identityProvenance: z.enum(["self_declared", "workspace_session"]), own: z.boolean() }).strict();
export type ResponsibleCandidate = z.infer<typeof responsibleCandidateSchema>;
export const responsibilitySchema = z.object({ id, version, cycle: version, state: z.enum(["proposed", "accepted", "declined", "withdrawn", "authority_ended"]), label: title.nullable(), role: z.enum(["organizer", "volunteer"]), own: z.boolean(), expiresAt: date, proposedAt: date, respondedAt: date.nullable(), canAccept: z.boolean(), canDecline: z.boolean(), canWithdraw: z.boolean(), reasons }).strict();
export type Responsibility = z.infer<typeof responsibilitySchema>;
export const responsibilityProposeSchema = z.object({ ...command, packageId: key, expectedOperationsVersion: head, expectedCycle: version, candidateId: id, candidateAuthorityHash: hash, candidateMembershipVersion: version, note: reason, acceptOwnResponsibility: z.boolean(), ...ack }).strict();
export const responsibilityActionSchema = z.object({ ...command, expectedVersion: version, action: z.enum(["accept", "decline", "withdraw"]), reason, ...ack }).strict();

export const procurementPlanBasisSchema = z.object({ publicationId: id, planId: id, revision: version, contentHash: hash, headVersion: version }).strict();
export type ProcurementPlanBasis = z.infer<typeof procurementPlanBasisSchema>;
export const procurementRequirementSchema = z.object({ id: key, label: title, scope: competencyScopeSchema.nullable(), kind: z.enum(["photo_association", "physical_review"]), satisfied: z.boolean(), currentCycleSatisfied: z.boolean(), provenance: z.enum(["sample", "reviewer_attested", "unreviewed"]), reviewedAt: date.nullable(), detail: text }).strict();
export const procurementGateSchema = z.object({ code: key, label: title, state: z.enum(["satisfied", "blocked", "unknown", "not_applicable"]), detail: text }).strict();
export type ProcurementGate = z.infer<typeof procurementGateSchema>;
export const procurementBasisSchema = z.object({ packageId: key, packageVersion: version, budgetMinor: minor, currency, fundingState: procurementFundingStateSchema, plan: procurementPlanBasisSchema.nullable(), planStatus: z.enum(["current", "stale", "revoked", "missing"]), fundingHash: hash, policyHash: hash, evidenceHash: hash, sourcePermissionHash: hash, dependencyHash: hash, assignmentHash: hash, selectionHash: hash, claimsHash: hash }).strict();
export type ProcurementBasis = z.infer<typeof procurementBasisSchema>;
export const procurementMoneySchema = z.object({ currency, originalGrossMinor: scalarMinor, returnedMinor: scalarMinor, currentCollectedMinor: scalarMinor, unpaidCommitmentMinor: scalarMinor, acceptedSponsorUnpaidMinor: scalarMinor, eligibleMinor: scalarMinor, reservedExpenseMinor: scalarMinor, paidExpenseMinor: scalarMinor, availableMinor: scalarMinor, financialReady: z.boolean(), providerLiquidity: z.literal("not_checked"), cutoff: date }).strict().superRefine((value, ctx) => { if (value.acceptedSponsorUnpaidMinor > value.unpaidCommitmentMinor) ctx.addIssue({ code: "custom", path: ["acceptedSponsorUnpaidMinor"], message: "The accepted sponsor subset is already part of unpaid commitments." }); });
export type ProcurementMoney = z.infer<typeof procurementMoneySchema>;
export const procurementSelectionSchema = z.object({ id, version, cycle: version, quoteId: id.nullable(), quoteVersion: version.nullable(), quoteHash: hash.nullable(), supplierName: title.nullable(), label: title, amountMinor: minor.nullable(), currency, validUntil: date.nullable(), reviewedAt: date, sourceAvailable: z.literal(true), shareScalarsWithAssignee: z.boolean(), reasons }).strict();
export type ProcurementSelection = z.infer<typeof procurementSelectionSchema>;
export const quoteSelectionInputSchema = z.object({ ...command, packageId: key, expectedOperationsVersion: head, expectedCycle: version, expectedBasisHash: hash, quoteId: id, quoteVersion: version, quoteHash: hash, comparisonQuoteHeads: z.array(z.object({ id, version, contentHash: hash }).strict()).min(1).max(30), reason, shareScalarsWithAssignee: z.boolean(), ...ack }).strict().superRefine((value, ctx) => { if (!unique(value.comparisonQuoteHeads.map(row => row.id)) || !value.comparisonQuoteHeads.some(row => row.id === value.quoteId && row.version === value.quoteVersion && row.contentHash === value.quoteHash)) ctx.addIssue({ code: "custom", path: ["comparisonQuoteHeads"], message: "Retain each reviewed alternative once, including the exact selected quote." }); });
export const procurementProgressSchema = z.object({ percent: z.number().int().min(0).max(100).nullable(), basis: z.literal("self_reported"), note: reason, observedAt: date, recordedAt: date, provenance: z.enum(["sample", "user_declared"]), cycle: version }).strict();
export type ProcurementProgress = z.infer<typeof procurementProgressSchema>;
export const procurementProgressInputSchema = z.object({ ...command, packageId: key, expectedVersion: head, expectedCycle: version, percent: z.number().int().min(0).max(100).nullable(), note: reason, observedAt: date, ...ack }).strict();
export const procurementExceptionSchema = z.object({ id, version, category: z.enum(["source", "price", "currency", "supplier", "responsibility", "prerequisite", "funding", "physical_evidence", "expense", "other"]), state: z.enum(["open", "resolved"]), title, reason, own: z.boolean(), derived: z.boolean(), createdAt: date, resolvedAt: date.nullable(), canResolve: z.boolean() }).strict();
export type ProcurementException = z.infer<typeof procurementExceptionSchema>;
export const procurementExceptionInputSchema = z.object({ ...command, packageId: key, expectedVersion: head, expectedCycle: version, category: procurementExceptionSchema.shape.category, title, reason, ...ack }).strict();
export const procurementExceptionResolveSchema = z.object({ ...command, expectedVersion: version, reason, ...ack }).strict();

export const procurementPackageSchema = z.object({
  packageId: key, title, canonicalVersion: version, budgetMinor: minor, currency, fundingState: procurementFundingStateSchema,
  operationsVersion: head, cycle: version, storedState: procurementStateSchema, blockedFrom: procurementStateSchema.nullable(), status: z.enum(["current", "needs_current_review", "authority_ended"]),
  progressPercent: z.number().int().min(0).max(100).nullable(), progressBasis: z.literal("self_reported"), responsible: responsibilitySchema.nullable(),
  selectedQuote: procurementSelectionSchema.nullable(), exceptionCount: count, canOpen: z.boolean(), canManage: z.boolean(), canReport: z.boolean(), reasons,
}).strict();
export type ProcurementPackage = z.infer<typeof procurementPackageSchema>;
export const procurementExpenseLinkSchema = z.object({ id, version, claimId: id.nullable(), claimVersion: version.nullable(), own: z.boolean(), title: title.nullable(), requestedMinor: minor.nullable(), approvedMinor: minor.nullable(), currency: currency.nullable(), state: z.string().max(100), payableCounts: z.record(z.string().max(100), count), recordedAt: date, canOpenOwnClaim: z.boolean(), canOpenReview: z.boolean(), reasons }).strict();
export type ProcurementExpenseLink = z.infer<typeof procurementExpenseLinkSchema>;
export const procurementExpenseCandidateSchema = z.object({ id, version, title, currency: currency.nullable(), packageScope: z.enum(["matching", "different", "unassigned"]), packageRequestedMinor: scalarMinor.nullable(), packageApprovedMinor: scalarMinor.nullable(), state: z.string().max(100), own: z.boolean(), canLink: z.boolean() }).strict();
export const procurementExpenseCandidatePageSchema = z.object({ scope: hash, packageId: key, items: z.array(procurementExpenseCandidateSchema).max(PROCUREMENT_PAGE_SIZE), nextCursor: cursor }).strict();
export const procurementExpenseLinkInputSchema = z.object({ ...command, packageId: key, expectedVersion: head, expectedCycle: version, claimId: id, claimVersion: version, reason, ...ack }).strict();
export const procurementDetailSchema = z.object({ scope: hash, checkedAt: date, package: procurementPackageSchema, basis: procurementBasisSchema, basisHash: hash, money: procurementMoneySchema.nullable(), gates: z.array(procurementGateSchema).max(100), requirements: z.array(procurementRequirementSchema).max(20), capabilities: z.array(text.max(160)).max(12), prerequisites: z.array(z.object({ packageId: key, title, kind: z.enum(["included", "accepted_work", "safety_signoff"]), satisfied: z.boolean(), detail: text }).strict()).max(40), quotes: z.array(quoteViewSchema).max(PROCUREMENT_PAGE_SIZE), quotesNextCursor: cursor, responsibilities: z.array(responsibilitySchema).max(100), progress: procurementProgressSchema.nullable(), exceptions: z.array(procurementExceptionSchema).max(100), expenses: z.array(procurementExpenseLinkSchema).max(100), historyNextCursor: cursor, transitionTargets: z.array(procurementStateSchema).max(9), notices: reasons }).strict();
export type ProcurementDetail = z.infer<typeof procurementDetailSchema>;
export const procurementDeskSchema = z.object({ scope: hash, checkedAt: date, project: procurementProjectSchema, role: procurementRoleSchema, packages: z.array(procurementPackageSchema).max(30), suppliers: z.array(supplierViewSchema).max(PROCUREMENT_PAGE_SIZE), suppliersNextCursor: cursor, quotes: z.array(quoteViewSchema).max(PROCUREMENT_PAGE_SIZE), quotesNextCursor: cursor, candidates: z.array(responsibleCandidateSchema).max(PROCUREMENT_PAGE_SIZE), candidatesNextCursor: cursor, sources: z.array(quoteSourceOptionSchema).max(PROCUREMENT_PAGE_SIZE), sourcesNextCursor: cursor, openExceptionCount: count, canManage: z.boolean(), canCreateSupplier: z.boolean(), canProposeQuote: z.boolean(), canInviteVolunteers: z.boolean(), uploadMode: z.enum(["private_blob", "isolated_local", "unavailable"]), notices: reasons }).strict().superRefine((value, ctx) => {
  if (value.role !== "organizer" && (value.canManage || value.canInviteVolunteers || value.candidates.length) || value.role === "auditor" && (value.suppliers.length || value.quotes.length || value.sources.length || value.canCreateSupplier || value.canProposeQuote || value.packages.some(row => row.responsible || row.selectedQuote || row.canManage || row.canReport || row.canOpen))) ctx.addIssue({ code: "custom", path: ["role"], message: "Organization membership, hidden columns and a selected browser role cannot disclose project suppliers, members, private sources or authority." });
});
export type ProcurementDesk = z.infer<typeof procurementDeskSchema>;
export const procurementSupplierPageSchema = z.object({ scope: hash, items: z.array(supplierViewSchema).max(PROCUREMENT_PAGE_SIZE), nextCursor: cursor }).strict();
export const procurementQuotePageSchema = z.object({ scope: hash, packageId: key.nullable(), items: z.array(quoteViewSchema).max(PROCUREMENT_PAGE_SIZE), nextCursor: cursor }).strict();
export const procurementCandidatePageSchema = z.object({ scope: hash, items: z.array(responsibleCandidateSchema).max(PROCUREMENT_PAGE_SIZE), nextCursor: cursor }).strict();
export const procurementSourcePageSchema = z.object({ scope: hash, items: z.array(quoteSourceOptionSchema).max(PROCUREMENT_PAGE_SIZE), nextCursor: cursor }).strict();
export const procurementSupplierRevisionPageSchema = z.object({ scope: hash, supplierId: id, items: z.array(z.object({ current: z.boolean(), supplier: supplierViewSchema }).strict()).max(PROCUREMENT_PAGE_SIZE), nextCursor: cursor }).strict();
export const procurementQuoteRevisionPageSchema = z.object({ scope: hash, quoteId: id, items: z.array(z.object({ current: z.boolean(), quote: quoteViewSchema }).strict()).max(PROCUREMENT_PAGE_SIZE), nextCursor: cursor }).strict();

export const procurementTransitionPrepareSchema = z.object({ expectedScope: hash, packageId: key, expectedVersion: head, expectedCycle: version, expectedBasisHash: hash, to: procurementStateSchema, reason, sharedWithResponsibilityId: id.nullable(), reportedWorkOnly: z.literal(true), historicalObligationsAcknowledged: z.literal(true) }).strict();
export type ProcurementTransitionPrepare = z.infer<typeof procurementTransitionPrepareSchema>;
export const procurementTransitionReviewSchema = z.object({ reviewHash: hash, input: procurementTransitionPrepareSchema, from: procurementStateSchema, to: procurementStateSchema, basis: procurementBasisSchema, basisHash: hash, checkedAt: date, expiresAt: date, canCommit: z.boolean(), gates: z.array(procurementGateSchema).max(100), blockers: reasons, warnings: reasons, effects: reasons }).strict();
export type ProcurementTransitionReview = z.infer<typeof procurementTransitionReviewSchema>;
export const procurementTransitionCommitSchema = z.object({ ...command, reviewHash: hash, review: procurementTransitionPrepareSchema, ...ack }).strict().superRefine((value, ctx) => { if (value.expectedScope !== value.review.expectedScope) ctx.addIssue({ code: "custom", path: ["expectedScope"], message: "Commit only the exact current reviewed project scope." }); });
export const procurementHistoryItemSchema = z.object({ id, version, cycle: version, kind: z.enum(["transition", "responsibility", "quote_selection", "progress", "exception", "expense_link"]), from: procurementStateSchema.nullable(), to: procurementStateSchema.nullable(), occurredAt: date, actorLabel: title, provenance: procurementProvenanceSchema, reason: reason.nullable(), basisHash: hash, contentHash: hash, current: z.boolean(), canInspect: z.boolean() }).strict();
export type ProcurementHistoryItem = z.infer<typeof procurementHistoryItemSchema>;
export const procurementHistoryPageSchema = z.object({ scope: hash, packageId: key, items: z.array(procurementHistoryItemSchema).max(PROCUREMENT_PAGE_SIZE), nextCursor: cursor }).strict();
export const procurementHistoryDetailSchema = z.object({ scope: hash, item: procurementHistoryItemSchema, status: z.enum(["current", "historical", "withdrawn"]), snapshot: procurementDetailSchema.nullable(), notices: reasons }).strict().superRefine((value, ctx) => { if (value.status === "withdrawn" && value.snapshot) ctx.addIssue({ code: "custom", path: ["snapshot"], message: "Retain immutable history while withholding its private source content when current authority or permission ends." }); });
export const procurementReceiptSchema = z.object({ intentId: id, kind: z.enum(["supplier_save", "supplier_state", "quote_save", "quote_review", "quote_selection", "responsibility_propose", "responsibility_action", "transition", "progress", "exception_open", "exception_resolve", "expense_link"]), resourceId: z.string().min(1).max(160), resourceVersion: head, recordedAt: date, message: text }).strict();
export type ProcurementReceipt = z.infer<typeof procurementReceiptSchema>;

export const PROCUREMENT_ERROR_CODES = ["PROCUREMENT_AUTH_REQUIRED", "PROCUREMENT_ROLE_DENIED", "PROCUREMENT_CONTEXT_CHANGED", "PROCUREMENT_AUTHORITY_ENDED", "PROCUREMENT_VERSION_CHANGED", "PROCUREMENT_INTENT_CHANGED", "PROCUREMENT_BUSY", "PROCUREMENT_NOT_FOUND", "PROCUREMENT_SOURCE_WITHDRAWN", "PROCUREMENT_SOURCE_CHANGED", "PROCUREMENT_SOURCE_INVALID", "PROCUREMENT_QUOTE_INVALID", "PROCUREMENT_QUOTE_EXPIRED", "PROCUREMENT_SUPPLIER_CHANGED", "PROCUREMENT_ASSIGNMENT_REQUIRED", "PROCUREMENT_ASSIGNMENT_ENDED", "PROCUREMENT_REVIEW_REQUIRED", "PROCUREMENT_TRANSITION_BLOCKED", "PROCUREMENT_BASIS_CHANGED", "PROCUREMENT_PHYSICAL_REVIEW_REQUIRED", "PROCUREMENT_EXPENSE_CHANGED", "WORKSPACE_CONTEXT_CHANGED", "WORKSPACE_MAINTENANCE", "INVALID_INPUT", "INPUT_TOO_LARGE", "REQUEST_UNAVAILABLE"] as const;
export const procurementProblemSchema = z.object({ error: text, code: z.enum(PROCUREMENT_ERROR_CODES), fields: z.array(z.object({ path: z.string().max(300), message: text }).strict()).max(100).optional() }).strict();
export type ProcurementProblem = z.infer<typeof procurementProblemSchema>;

/** Services bind exact tenant/project/current actor+role+membership/session
 * scope. Writes check again after locks; private disclosure checks fresh current
 * source permission after the coherent transaction. No command here dispatches
 * a purchase, message, payout, collection, refund, model or financial approval.
 *
 * GET  /api/procurement/context -> {context}
 * GET  /api/procurement -> {desk}
 * GET  /api/procurement/suppliers|quotes|candidates|sources?before= -> {page}
 * GET  /api/procurement/quotes?packageId=&before= -> {page}
 * GET  /api/procurement/packages/:packageId -> {detail}
 * GET  /api/procurement/packages/:packageId/history?before= -> {page}
 * GET  /api/procurement/packages/:packageId/expenses?before= -> {page}
 * GET  /api/procurement/history/:eventId -> {detail:ProcurementHistoryDetail}
 * GET  /api/procurement/quotes/:quoteId/versions?before= -> {page}
 * GET  /api/procurement/suppliers/:supplierId/versions?before= -> {page}
 * GET  /api/procurement/quotes/:quoteId/source?version= -> {detail:QuoteSourceDetail}
 * GET  /api/procurement/quotes/:quoteId/preview?version=&page= -> private bytes
 * POST /api/procurement/suppliers -> SupplierSave -> {receipt}
 * POST /api/procurement/suppliers/:id/state -> SupplierState -> {receipt}
 * POST /api/procurement/quotes -> QuoteSave -> {receipt}
 * POST /api/procurement/quotes/:id/review -> QuoteReview -> {receipt}
 * POST /api/procurement/quotes/select -> QuoteSelectionInput -> {receipt}
 * POST /api/procurement/responsibilities -> ResponsibilityPropose -> {receipt}
 * POST /api/procurement/responsibilities/:id/state -> ResponsibilityAction -> {receipt}
 * POST /api/procurement/transitions/prepare -> TransitionPrepare -> {review}
 * POST /api/procurement/transitions -> TransitionCommit -> {receipt}
 * POST /api/procurement/progress -> ProgressInput -> {receipt}
 * POST /api/procurement/exceptions -> ExceptionInput -> {receipt}
 * POST /api/procurement/exceptions/:id/resolve -> ExceptionResolve -> {receipt}
 * POST /api/procurement/expenses -> ExpenseLinkInput -> {receipt}
 *
 * GET source returns only a permitted original/current-version excerpt or an
 * authorized controlled preview. It never widens the existing document API's
 * ownership rights. Current accepted responsibility plus explicit reviewed
 * shareScalarsWithAssignee permits selected scalar terms only, not other bids,
 * supplier private notes or someone else's receipt/original document.
 *
 * Operations records never overwrite fp_packages fundingState/workState,
 * canonical budget, plan, evidence, approvals, payables or financial journals.
 * Cancel/reopen records preserve every prior physical/financial decision. A
 * reopened cycle needs fresh current readiness and explicit responsibility;
 * old physical decisions cannot count as a new cycle's acceptance.
 */
