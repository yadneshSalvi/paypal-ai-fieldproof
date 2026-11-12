import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import { createHash } from "node:crypto";
import type { PackageView } from "../contracts";
import type { BriefSource } from "../community/contracts";
import { SUPPORTER_STORY_VERSION, type StoryBudget, type StoryContribution, type StoryEvidence, type StoryPosition, type StoryReview, type StorySourceDocument, type StorySourceResponse, type StoryTimelineItem, type SupporterJourney } from "../community/supporter-contracts";
import { projectFundingLots, type FundingLot } from "../domain/funding-lots";
import { projectFundingPositions } from "../domain/funding-positions";
import { bindStoryBudget, contributionShare, type BudgetCandidate } from "../domain/supporter-share";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { communitySource, personalCommunitySource } from "./community-source";
import { database, query } from "./db";
import { readFundingJournal, readFundingOrigins } from "./funding-positions";
import { fundingChoiceContract, savedFundingPolicy } from "./funding-lifecycle";
import { allocationEvidence } from "./funding-adjustments";
import { externalReturnRecord, holdContract } from "./funding-return-reconciliation";
import { requireCurrentRole } from "./membership";
import { alignmentViews, signoffViews } from "./planning-evidence";
import { currentSourceCheck, planPayload, planningHash, type PlanRow } from "./planning-store";
import { sharedAlignmentImage } from "./planning-evidence";
import { publicProofImage, supporterProofRecords } from "./proof";
import type { DocumentStorage } from "./document-storage";

interface PackageRow { id: string; version: number; budget_minor: string; data: PackageView; }
type ChoiceRow = Parameters<typeof fundingChoiceContract>[0] & { executed_at: Date | null };
const missingReview = (scope: string): StoryReview => ({ status: "missing", scope, reviewerLabel: null, reviewedAt: null, sourceHash: null });
const fullView = (session: Session) => ["organizer", "auditor"].includes(session.role);
const scope = (session: Session) => [session.tenantId, session.projectId];
function returnNarrative(state:string):Pick<StoryTimelineItem,"title"|"detail"> {
  if(state==="completed")return{title:"Original-route return completed",detail:"The original return record confirms completion. Reopening the story does not resend it."};
  if(state==="refused")return{title:"Original-route return refused",detail:"The original attempt was refused. No completed return is recorded. Review or retry that same operation in the funding desk; its reserved share remains unavailable."};
  if(state==="not_sent")return{title:"Original-route return not sent",detail:"The original operation was not sent. No completed return is recorded. Continue that same operation from the funding desk; reopening this source does not send it or release its reservation."};
  if(["unknown","pending_reconciliation"].includes(state))return{title:"Original-route return needs an outcome check",detail:"The original operation's outcome is unresolved. Check that same operation before treating the amount as returned or available. This read does not retry it."};
  return{title:"Original-route return pending",detail:"The original return record is awaiting its outcome. Reopening the story does not resend it or establish completion."};
}

export async function supporterContext(session: Session, tx: SqlConnection = database()): Promise<string> {
  const member = await requireCurrentRole(session, session.role, tx);
  return planningHash({ contract: SUPPORTER_STORY_VERSION, session: session.id, actor: session.actorId, tenant: session.tenantId,
    project: session.projectId, role: session.role, membership: member.membershipVersion, expiry: session.expiresAt });
}
export async function assertSupporterContext(session: Session, expected: string, tx: SqlConnection = database()) {
  if (await supporterContext(session, tx) !== expected)
    throw new DomainError("STORY_CONTEXT_CHANGED", "Your project identity or access changed. Reopen the story in your current view.", 409);
}

async function budgetCandidates(session: Session, packages: PackageRow[], tx: SqlConnection): Promise<BudgetCandidate[]> {
  const result: BudgetCandidate[] = packages.map(pkg => ({ packageId: pkg.id, version: pkg.version, title: pkg.data.title,
    purpose: pkg.data.description, amountMinor: Number(pkg.budget_minor), basis: "current_package", sourceHashes: [planningHash({ id: pkg.id, version: pkg.version, budgetMinor: Number(pkg.budget_minor), title: pkg.data.title, purpose: pkg.data.description })], review: missingReview("Package budget review") }));
  // If the duplicated live amount disagrees, keep both sources so the binder
  // reports a conflict instead of selecting whichever number looks complete.
  for (const pkg of packages) if (pkg.data.budgetMinor !== Number(pkg.budget_minor))
    result.push({ ...result.find(row => row.packageId === pkg.id)!, amountMinor: pkg.data.budgetMinor, sourceHashes: [planningHash(pkg.data)] });
  for (const policy of await query<{ id: string }>("SELECT id FROM fp_funding_policies WHERE tenant_id=$1 AND project_id=$2 ORDER BY id", scope(session), tx)) {
    const { row, value } = await savedFundingPolicy(session, policy.id, tx);
    const [member] = await query<{ version: number; state: string; roles: string[] }>("SELECT version,state,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [...scope(session), value.createdBy], tx);
    const current = member?.state === "active" && member.version === value.membershipVersion && member.roles.includes("organizer");
    result.push({ packageId: value.packageId, version: value.packageVersion, title: value.title, purpose: value.purpose, amountMinor: value.budgetMinor,
      basis: "saved_purpose", sourceHashes: [row.digest], review: { status: !current ? "stale" : session.mode === "sample" ? "sample" : "recorded",
        scope: "Recorded purpose terms and budget; not an expense or work review", reviewerLabel: session.mode === "sample" ? "Sample organizer record" : "Project organizer", reviewedAt: value.createdAt, sourceHash: row.digest } });
  }
  const plans = await query<PlanRow & { publication_state: string; review_hash: string; review_decision: string; reviewed_at: Date; reviewer_id: string;reviewer_current:boolean }>(`SELECT DISTINCT ON(v.id) v.*,p.state publication_state,r.content_hash review_hash,r.decision review_decision,r.created_at reviewed_at,r.actor_id reviewer_id,
    COALESCE(m.state='active' AND m.version=r.membership_version AND m.roles ? 'organizer',false) reviewer_current
    FROM fp_plan_versions v JOIN fp_plan_publications p ON p.plan_id=v.id JOIN fp_plan_reviews r ON r.id=p.review_id AND r.plan_id=v.id
    LEFT JOIN fp_memberships m ON m.tenant_id=r.tenant_id AND m.project_id=r.project_id AND m.actor_id=r.actor_id
    WHERE v.tenant_id=$1 AND v.project_id=$2 AND p.state IN ('active','superseded') ORDER BY v.id,p.created_at DESC`, scope(session), tx);
  for (const row of plans) {
    const payload = planPayload(row);
    if ((await currentSourceCheck(session, payload.sources, tx)).length) continue;
    const reviewed = row.review_decision === "approved" && row.review_hash === row.content_hash;
    for (const pkg of payload.packages) result.push({ packageId: pkg.packageId, version: pkg.version, title: pkg.title, purpose: null,
      amountMinor: pkg.budgetMinor, basis: "saved_plan", sourceHashes: [row.content_hash], review: reviewed ? {
        status: !row.reviewer_current ? "stale" : session.mode === "sample" ? "sample" : "recorded", scope: "Shared plan and package budget; not physical work acceptance",
        reviewerLabel: session.mode === "sample" ? "Sample organizer record" : "Project organizer", reviewedAt: row.reviewed_at.toISOString(), sourceHash: row.content_hash,
      } : missingReview("Package budget review") });
  }
  return result;
}

async function storyEvidence(session: Session, tx: SqlConnection): Promise<StoryEvidence[]> {
  const evidence: StoryEvidence[] = [];
  // Every association keeps the package version in its own immutable plan.
  // A newer publication must never lend an old image its newer budget version.
  const plans = new Map((await query<PlanRow>("SELECT * FROM fp_plan_versions WHERE tenant_id=$1 AND project_id=$2",scope(session),tx)).map(row=>[row.id,planPayload(row)]));
  const versionFor = (planId:string,packageId:string) => plans.get(planId)?.packages.find(pkg=>pkg.packageId===packageId)?.version??null;
  for (const row of await alignmentViews(session, tx, true)) {
    // A withdrawn shared item may leave a minimal tombstone. An item never
    // shared with this audience must leave no identity, source hash or image.
    if (row.imageSharing !== "project_members" && session.role !== "organizer") continue;
    if (session.role !== "organizer" && !row.reviewedAt) continue;
    const current = row.state === "reviewed" && !!row.previewUrl;
    evidence.push({ id: `alignment:${row.id}`, packageId: row.packageId, packageVersion: versionFor(row.planId,row.packageId), kind: "image_association",
      state: row.state === "revoked" ? "revoked" : row.state === "stale" ? "stale" : current ? "current" : "unreviewed",
      label: row.sourceClass === "sample_illustration" ? "Sample image association" : row.reviewedAt ? "Reviewed image association" : "Image association awaiting review",
      scope: "Three-landmark association with the shared plan; no safety or completion certification",
      sourceClass: row.sourceClass === "sample_illustration" ? "sample" : "submitted", reviewerLabel: row.reviewedAt ? row.reviewerLabel : null, reviewedAt: row.reviewedAt,
      sourceHash: current ? row.sharedPreviewHash : null, previewUrl: current ? row.previewUrl : null, proofUrl: null,
      detail: current ? "This cropped copy uses the reviewed permanent masks. The original stays private." : row.state === "revoked" ? "This image was withdrawn. Its former review does not permit displaying it now." : row.state === "stale" ? "The source or shared plan changed. Review the new version before showing an image." : "An image review is still needed." });
  }
  // signoffViews already redacts donor statements, qualification identities and
  // names. Keep only the scope and its actual review date in this projection.
  for (const row of await signoffViews(session, tx, true)) evidence.push({ id: `signoff:${row.id}`, packageId: row.packageId,
    packageVersion: versionFor(row.planId,row.packageId), kind: "work_review", state: row.current ? "current" : "stale", label: row.decision === "accepted" ? "Scoped work review" : "Work review needs attention",
    scope: row.scope.replaceAll("_", " "), sourceClass: row.provenance === "sample" ? "sample" : "reviewer_attested", reviewerLabel: row.reviewerLabel,
    reviewedAt: row.recordedAt, sourceHash: null, previewUrl: null, proofUrl: null,
    detail: row.current ? `${row.decision === "accepted" ? "Accepted" : "Needs changes"} for this scope only. Observation: ${row.observedAt}. ${row.limitations}` : row.stateReason ?? "This earlier review no longer establishes current acceptance." });
  for (const { packageId, proof, reviews } of await supporterProofRecords(session, tx)) {
    const snapshot = proof.snapshot;
    if (!snapshot) { evidence.push({ id: `publication:${proof.slug}`, packageId, packageVersion: null, kind: "publication", state: "revoked",
      label: "Proof Page withdrawn", scope: "Public proof edition", sourceClass: session.mode === "sample" ? "sample" : "submitted", reviewerLabel: null,
      reviewedAt: null, sourceHash: null, previewUrl: null, proofUrl: `/proof/${proof.slug}`, detail: "Its public content is unavailable for review. Earlier downloads cannot be recalled." }); continue; }
    for (const image of snapshot.payload.evidence) {
      const review = reviews.find(row => row.id === image.id);
      evidence.push({ id: `proof:${proof.slug}:${image.id}:${snapshot.payload.revision}`, packageId, packageVersion: snapshot.payload.package.version,
        kind: image.kind === "receipt" ? "public_receipt" : "public_image", state: "current", label: image.label,
        scope: `Privacy-reviewed public copy · edition ${snapshot.payload.revision}; not a physical work review`, sourceClass: image.sample ? "sample" : "submitted",
        reviewerLabel: review?.reviewerLabel ?? null, reviewedAt: review?.reviewedAt ?? null, sourceHash: image.contentHash,
        previewUrl: `/api/public-proof/${proof.slug}/images/${image.id}?revision=${snapshot.payload.revision}`, proofUrl: `/proof/${proof.slug}?revision=${snapshot.payload.revision}`,
        detail: `Published with the exact package version and evidence cutoff ${snapshot.payload.cutoff}. Funding and work acceptance remain separate.` });
    }
  }
  return evidence.sort((a,b) => a.packageId.localeCompare(b.packageId) || a.id.localeCompare(b.id));
}

async function choicesFor(session: Session, ids: string[], tx: SqlConnection): Promise<ChoiceRow[]> {
  return query<ChoiceRow>("SELECT * FROM fp_funding_choices WHERE tenant_id=$1 AND project_id=$2 AND receipt_id=ANY($3::text[]) ORDER BY created_at,id", [...scope(session), ids], tx);
}

/** Read-only extension of the community source. It never opens a provider or
 * creates a new source, translation, review, approval or financial operation. */
export async function readSupporterJourney(session: Session, source: BriefSource, personal: BriefSource, tx: SqlConnection): Promise<SupporterJourney> {
  const contextHash = await supporterContext(session, tx), fundingScope = { tenantId: session.tenantId, projectId: session.projectId, provenance: session.mode };
  const journal = await readFundingJournal(fundingScope, tx), projection = projectFundingPositions(journal, fundingScope), origins = await readFundingOrigins(fundingScope, tx);
  const packages = await query<PackageRow>("SELECT p.id,p.version,p.budget_minor,p.data FROM fp_packages p JOIN fp_projects r ON r.id=p.project_id WHERE p.project_id=$1 AND r.tenant_id=$2 ORDER BY p.id", [session.projectId, session.tenantId], tx);
  const obligations = await query<{ id: string; actor_id: string; amount_minor: string; channel: string }>("SELECT id,actor_id,amount_minor,channel FROM fp_obligations WHERE tenant_id=$1 AND project_id=$2 AND purpose='conditional_pledge' ORDER BY id", scope(session), tx);
  const permitted = obligations.filter(row => fullView(session) || (session.role === "donor" && row.actor_id === session.actorId));
  const selected = journal.sources.filter(row => permitted.some(obligation => obligation.id === row.receipt.donorObligationId));
  const candidates = await budgetCandidates(session, packages, tx), choices = await choicesFor(session, selected.map(row => row.receipt.id), tx), contributions: StoryContribution[] = [];
  const evidence = await storyEvidence(session, tx);
  const bind = (packageId: string, version: number | null, title?: string, purpose?: string) => bindStoryBudget(packageId, version, candidates, { title: title ?? packages.find(pkg => pkg.id === packageId && pkg.version === version)?.data.title ?? "Earlier purpose", purpose });
  const uses = await query<{ id: string; receipt_id: string; package_id: string; kind: string; amount_minor: string; state: string; created_at: Date;
    reviewed_at: Date | null; reviewed_by: string | null; claim_version: number | null; reviewed_version: number | null }>(`SELECT a.id,a.receipt_id,a.package_id,a.kind,a.amount_minor,a.state,a.created_at,c.reviewed_at,c.reviewed_by,c.version reviewed_version,p.claim_version
    FROM fp_receipt_allocations a LEFT JOIN fp_payables p ON p.id=a.payable_id AND p.tenant_id=a.tenant_id AND p.project_id=a.project_id
    LEFT JOIN fp_claims c ON c.id=a.claim_id AND c.tenant_id=a.tenant_id AND c.project_id=a.project_id
    WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.receipt_id=ANY($3::text[]) AND a.state IN ('paid','reserved') ORDER BY a.created_at,a.id`, [...scope(session), selected.map(row => row.receipt.id)], tx);
  const useEvidence = (await Promise.all([...new Set(uses.map(row => row.package_id))].map(id => allocationEvidence(session, id, tx)))).flat();
  const refunds = await query<{ id: string; receipt_id: string; funding_package_id:string|null; amount_minor: string; state: string; created_at: Date; completed_at: Date | null }>("SELECT id,receipt_id,funding_package_id,amount_minor,state,created_at,completed_at FROM fp_refunds WHERE tenant_id=$1 AND project_id=$2 AND receipt_id=ANY($3::text[]) ORDER BY created_at,id", [...scope(session), selected.map(row => row.receipt.id)], tx);
  const outside = await query<Parameters<typeof externalReturnRecord>[0] & { created_at: Date }>("SELECT * FROM fp_funding_external_returns WHERE tenant_id=$1 AND project_id=$2 AND receipt_id=ANY($3::text[]) ORDER BY created_at,id", [...scope(session), selected.map(row => row.receipt.id)], tx);
  const holds = await query<Parameters<typeof holdContract>[0]>("SELECT * FROM fp_funding_return_holds WHERE tenant_id=$1 AND project_id=$2 AND receipt_id=ANY($3::text[]) ORDER BY created_at,id", [...scope(session), selected.map(row => row.receipt.id)], tx);
  for (const [index, saved] of selected.entries()) {
    const receipt = saved.receipt, origin = origins.find(row => row.receiptId === receipt.id), own = permitted.find(row => row.id === receipt.donorObligationId)!.actor_id === session.actorId;
    const original = bind(receipt.packageId, origin?.packageVersion ?? null, origin?.title, origin?.purpose);
    let lots: FundingLot[] = [], lotIssue: string | null = null;
    try { lots = projectFundingLots({ sources: [saved], assignments: journal.assignments.filter(row => row.receiptId === receipt.id),
      deductions: journal.deductions.filter(row => row.receiptId === receipt.id), uses: journal.uses.filter(row => row.receiptId === receipt.id) }, fundingScope, origin ? [origin] : []); }
    catch (error) { if (!(error instanceof DomainError)) throw error; lotIssue = error.code; }
    const positions: StoryPosition[] = projection.positions.filter(row => row.receiptId === receipt.id).map(row => {
      const current = packages.find(pkg => pkg.id === row.packageId), relevant = lots.filter(lot => lot.packageId === row.packageId);
      const historical = journal.assignments.filter(entry => entry.receiptId === receipt.id).flatMap(entry => [entry.debit, entry.credit]).filter(entry => entry.packageId === row.packageId).map(entry => entry.packageVersion);
      const versions = [...new Set(relevant.length ? relevant.map(lot => lot.packageVersion) : [...historical, ...(origin?.packageId === row.packageId ? [origin.packageVersion] : [])])].sort((a,b) => a-b);
      const version = !lotIssue && versions.length === 1 ? versions[0] : null, budget = bind(row.packageId, version, origin?.packageId === row.packageId ? origin.title : undefined, origin?.packageId === row.packageId ? origin.purpose : undefined);
      const sourceIssue = lotIssue ?? (versions.length > 1 ? "MULTIPLE_PURPOSE_VERSIONS" : budget.status === "conflict" ? "BUDGET_SOURCE_CONFLICT" : budget.status === "missing" ? "BUDGET_SOURCE_MISSING" : null);
      const state: StoryPosition["state"] = sourceIssue || row.excludedMinor ? "review" : row.pendingRefundMinor ? "pending_return" : !row.assignedMinor ? "moved" : !row.collectedMinor ? "returned" : current?.version !== version ? "earlier_version" : ["cancelled", "compensating"].includes(current.data.fundingState) ? "cancelled" : "active";
      return { id: `${receipt.id}:${row.packageId}`, packageId: row.packageId, versions, currentVersion: current?.version ?? null, budget,
        share: budget.amountMinor !== null && !sourceIssue ? contributionShare(row.collectedMinor, budget.amountMinor, "current-purpose-net-credit-v1") : null,
        purposeState: current?.data.fundingState ?? "missing", assignedMinor: row.assignedMinor, netMinor: row.collectedMinor, returnedMinor: row.refundedMinor,
        pendingReturnMinor: row.pendingRefundMinor, paidMinor: row.paidMinor, feeMinor: uses.filter(use => use.receipt_id === receipt.id && use.package_id === row.packageId && use.kind === "fee" && use.state === "paid").reduce((sum,use) => sum + Number(use.amount_minor),0),
        committedMinor: row.reservedMinor, reviewMinor: row.excludedMinor, availableMinor: row.availableMinor, state, sourceIssue, assignmentIds: row.assignmentIds };
    }).sort((a,b) => b.netMinor-a.netMinor || a.packageId.localeCompare(b.packageId));
    const timeline: StoryTimelineItem[] = [{ id: `receipt:${receipt.id}`, kind: "payment", at: receipt.observedAt, amountMinor: receipt.creditedMinor,
      state: receipt.authoritativeObservedState.toLowerCase(), packageId: receipt.packageId, title: receipt.sourceKind === "invoice_payment" ? "Original invoice payment" : "Original Orders payment",
      detail: receipt.provenance === "sample" ? "Fictional Sample receipt. No provider payment occurred." : "One economic payment, preserved on its original payment rail.", review: null }];
    for (const choice of choices.filter(row => row.receipt_id === receipt.id)) {
      const value = fundingChoiceContract(choice);
      timeline.push({ id: `choice:${choice.id}`, kind: "decision", at: value.consentedAt, amountMinor: value.amountMinor, state: choice.state, packageId: value.sourcePackageId,
        title: value.kind === "return" ? "Return decision recorded" : value.kind === "rollover" ? "New-cycle choice recorded" : "New-purpose choice recorded",
        detail: value.destination ? `${value.destination.title} · version ${value.destination.packageVersion}. This choice and its execution are separate records.` : "Return to the original payment route. A saved choice is separate from a completed return.", review: null });
      if (choice.revoked_at) timeline.push({ id: `withdrawn:${choice.id}`, kind: "decision", at: choice.revoked_at.toISOString(), amountMinor: value.amountMinor, state: "revoked", packageId: value.sourcePackageId, title: "Earlier choice withdrawn", detail: "The prior choice remains in the history; withdrawal did not move a payment.", review: null });
      if (receipt.provenance === "sample" && choice.kind === "return" && choice.state === "returned") timeline.push({ id: `return:${choice.id}`, kind: "return", at: choice.executed_at?.toISOString() ?? null, amountMinor: value.amountMinor, state: "returned", packageId: value.sourcePackageId, title: "Sample return recorded", detail: "Fictional return on the original rail. No provider refund occurred.", review: null });
    }
    for (const assignment of journal.assignments.filter(row => row.receiptId === receipt.id)) timeline.push({ id: `assignment:${assignment.id}`, kind: "assignment", at: assignment.committedAt, amountMinor: assignment.amountMinor, state: "executed", packageId: assignment.credit.packageId,
      title: assignment.kind === "rollover" ? "Support renewed for a new cycle" : assignment.kind === "reversal" ? "Earlier move reversed" : "Support moved to its chosen purpose",
      detail: `${bind(assignment.debit.packageId, assignment.debit.packageVersion).title} (v${assignment.debit.packageVersion}) → ${bind(assignment.credit.packageId, assignment.credit.packageVersion).title} (v${assignment.credit.packageVersion}). The original receipt is unchanged.`, review: null });
    for (const use of uses.filter(row => row.receipt_id === receipt.id)) {
      const verified = useEvidence.find(row => row.id === use.id), currentReview = use.reviewed_at && use.reviewed_by && use.claim_version === use.reviewed_version;
      const review: StoryReview = currentReview ? { status: session.mode === "sample" ? "sample" : "recorded", scope: "Expense claim review; not physical acceptance", reviewerLabel: session.mode === "sample" ? "Sample organizer record" : "Project organizer", reviewedAt: use.reviewed_at!.toISOString(), sourceHash: verified?.digest ?? null } : missingReview("Matching expense review is not recorded in this view");
      timeline.push({ id: `use:${use.id}`, kind: use.kind === "fee" ? "fee" : "expense", at: use.created_at.toISOString(), amountMinor: Number(use.amount_minor), state: use.state,
        packageId: use.package_id, title: use.kind === "fee" ? "Payment fee recorded" : use.state === "paid" ? "Expense use recorded" : "Expense outcome pending",
        detail: verified?.detail ?? "The recorded use remains separate from review and physical work acceptance.", review });
    }
    for (const refund of refunds.filter(row => row.receipt_id === receipt.id)) timeline.push({ id: `refund:${refund.id}`, kind: "return", at: refund.completed_at?.toISOString() ?? refund.created_at.toISOString(), amountMinor: Number(refund.amount_minor), state: refund.state, packageId: refund.funding_package_id??receipt.packageId, ...returnNarrative(refund.state), review: null });
    for (const row of outside.filter(row => row.receipt_id === receipt.id)) { const value = externalReturnRecord(row); timeline.push({ id: `outside:${row.id}`, kind: "return", at: value.observedAt, amountMinor: value.amountMinor, state: "returned", packageId: value.packageId, title: "Outside return attributed", detail: session.mode === "sample" ? "Fictional outside return, attributed through a separate Sample evidence review." : "An independently observed original return was attributed to its proven purpose.", review: null }); }
    for (const row of holds.filter(row => row.receipt_id === receipt.id)) { const value = holdContract(row); timeline.push({ id: `hold:${row.id}`, kind: "hold", at: value.createdAt, amountMinor: value.positions.reduce((sum,p) => sum+p.amountMinor,0), state: row.state, packageId: value.positions[0]?.packageId ?? receipt.packageId, title: "Outside-return evidence needed", detail: row.state === "held" ? "This source cannot support another use while the original return is being checked." : "This review restriction was released by its separate attribution decision. The original restriction remains recorded.", review: null }); }
    timeline.sort((a,b) => (a.at ?? "9999").localeCompare(b.at ?? "9999") || a.id.localeCompare(b.id));
    const stable = { id: receipt.id, receiptVersion: saved.version, own, label: own ? "Your contribution" : `Contribution ${String(index+1).padStart(2,"0")}`,
      sourceKind: receipt.sourceKind, provenance: receipt.provenance, observedAt: receipt.observedAt, grossMinor: receipt.grossSettledMinor, creditedMinor: receipt.creditedMinor, excessMinor: receipt.excessLiabilityMinor,
      original, originalShare: original.amountMinor === null || lotIssue ? null : contributionShare(receipt.creditedMinor, original.amountMinor, "original-credited-budget-v1"), positions, timeline };
    contributions.push({ ...stable, sourceHash: planningHash({ ...stable, receiptHash: planningHash(receipt), originDigest: origin?.consentDigest ?? null, choiceDigests: choices.filter(row => row.receipt_id === receipt.id).map(row => row.digest) }) });
  }
  const unpaid = permitted.filter(row => !journal.sources.some(source => source.receipt.donorObligationId === row.id && source.receipt.creditedMinor > 0));
  const [hidden] = await query<{ count: string }>(`SELECT count(*) count FROM (SELECT DISTINCT ON(draft_id) source_hash FROM fp_community_update_previews WHERE tenant_id=$1 AND project_id=$2 ORDER BY draft_id,created_at DESC,id DESC) p WHERE p.source_hash<>$3`, [...scope(session), source.contentHash], tx);
  const stable = { contract: SUPPORTER_STORY_VERSION, projectId: session.projectId, role: session.role, scope: fullView(session) ? "project_contributions" as const : session.role === "donor" ? "own_contributions" as const : "project_only" as const,
    contextHash, contributions, evidence, unpaid: { count: unpaid.length, amountMinor: unpaid.reduce((sum,row) => sum+Number(row.amount_minor),0) }, hiddenUpdateCount: Number(hidden.count) };
  return { ...stable, sourceHash: planningHash({ ...stable, communitySourceHash: source.contentHash, personalSourceHash: personal.contentHash }), observedAt: source.capturedAt };
}

async function sourceAt(session: Session, expected: { contextHash: string; sourceHash: string }, tx: SqlConnection) {
  await assertSupporterContext(session, expected.contextHash, tx);
  const source = await communitySource(session, "supporter", tx), personal = await personalCommunitySource(session, tx), journey = await readSupporterJourney(session, source, personal, tx);
  if (journey.sourceHash !== expected.sourceHash) throw new DomainError("STORY_SOURCE_CHANGED", "The story’s source changed. Refresh it before opening this record again.", 409);
  return { source, personal, journey };
}
async function finalSourceCheck(session: Session, expected: { contextHash: string; sourceHash: string }) {
  await database().transaction(async tx => { await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"); await sourceAt(session, expected, tx); });
  await assertSupporterContext(session, expected.contextHash);
}
export async function readContributionSource(session: Session, receiptId: string, expected: { contextHash: string; sourceHash: string }, beforeDisclosure?: () => Promise<void>): Promise<StorySourceResponse> {
  const document = await database().transaction(async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { source, personal, journey } = await sourceAt(session, expected, tx), contribution = journey.contributions.find(row => row.id === receiptId);
    if (!contribution) throw new DomainError("STORY_RECEIPT_NOT_FOUND", "This original receipt is outside your current view.", 404);
    const journal = await readFundingJournal({ tenantId: session.tenantId, projectId: session.projectId, provenance: session.mode }, tx), saved = journal.sources.find(row => row.receipt.id === receiptId)!;
    const original = (await readFundingOrigins({ tenantId: session.tenantId, projectId: session.projectId, provenance: session.mode }, tx)).find(row => row.receiptId === receiptId);
    const [consent] = await query<{ id: string; version: number; policy_digest: string; policy: { statement?: string }; expires_at: Date }>("SELECT id,version,policy_digest,policy,expires_at FROM fp_conditional_consents WHERE tenant_id=$1 AND project_id=$2 AND obligation_id=$3", [...scope(session), saved.receipt.donorObligationId], tx);
    const receipt = saved.receipt;
    const value: StorySourceDocument = { contract: SUPPORTER_STORY_VERSION, sourceHash: journey.sourceHash, communitySourceHash: source.contentHash, personalSourceHash: personal.contentHash, observedAt: journey.observedAt, contribution,
      receipt: { id: receipt.id, version: saved.version, donorObligationId: receipt.donorObligationId, sourceKind: receipt.sourceKind, originalPackageId: receipt.packageId,
        originalPackageVersion: original?.packageVersion ?? null, actualProviderPaymentRef: receipt.actualProviderPaymentRef, sourceOrderId: receipt.sourceOrderId,
        sourceInvoiceId: receipt.sourceInvoiceId, provenRefundableRef: receipt.provenRefundableRef, refundAdapter: receipt.refundAdapter, observedState: receipt.authoritativeObservedState,
        observedAt: receipt.observedAt, currency: receipt.currency, grossMinor: receipt.grossSettledMinor, creditedMinor: receipt.creditedMinor, receiptHash: planningHash(receipt) },
      consent: original ? { id: original.consentId, version: original.consentVersion, digest: original.consentDigest, provenance: receipt.provenance === "sample" ? "sample" : "recorded",
        statement: receipt.provenance === "sample" ? "Fictional starting authority; no actual donor consent is asserted." : consent?.id === original.consentId && consent.version === original.consentVersion && consent.policy_digest === original.consentDigest ? consent.policy.statement ?? null : original.purpose ?? null,
        expiresAt: consent?.id === original.consentId ? consent.expires_at.toISOString() : null } : null,
      decisions: (await choicesFor(session, [receiptId], tx)).map(row => { const choice = fundingChoiceContract(row); return { id: row.id, version: row.version, digest: row.digest,
        kind: choice.kind, amountMinor: choice.amountMinor, state: row.state, sourcePackageId: choice.sourcePackageId, sourcePackageVersion: choice.sourcePackageVersion,
        destination: choice.destination ? { packageId: choice.destination.packageId, packageVersion: choice.destination.packageVersion, title: choice.destination.title, purpose: choice.destination.purpose } : null,
        consentedAt: choice.consentedAt, expiresAt: choice.expiresAt, revokedAt: row.revoked_at?.toISOString() ?? null, executedId: row.executed_id }; }),
      limitations: ["This is an accounting statement, not a claim that particular physical dollars bought a particular object.", "A pledge or saved payment method is not collected money.",
        "Funding, expense review, privacy review and physical work acceptance have separate sources.", "Reopening or downloading this source does not send a payment, return, translation or declaration."] };
    return value;
  });
  await beforeDisclosure?.(); await finalSourceCheck(session, expected);
  const downloadText = canonicalJson(document);
  return { document, downloadHash: sha256(downloadText), downloadText };
}

export async function readStoryImage(session: Session, id: string, expected: { contextHash: string; sourceHash: string }, storage?: DocumentStorage, beforeDisclosure?:()=>Promise<void>): Promise<Buffer> {
  const evidence = await database().transaction(async tx => { await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return (await sourceAt(session, expected, tx)).journey.evidence.find(row => row.id === id); });
  if (!evidence?.previewUrl || evidence.state !== "current") throw new DomainError("STORY_IMAGE_UNAVAILABLE", "This source is missing, changed or no longer shared.", 410);
  const parts = id.split(":"), bytes = parts[0] === "alignment" ? await sharedAlignmentImage(session, parts[1], storage)
    : parts[0] === "proof" ? await publicProofImage(parts[1], parts[2], Number(parts[3]), storage) : null;
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== evidence.sourceHash) throw new DomainError("STORY_IMAGE_CHANGED", "The image no longer matches its exact reviewed copy.", 409);
  await beforeDisclosure?.();await finalSourceCheck(session, expected);
  return bytes;
}
