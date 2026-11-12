import { randomUUID } from "node:crypto";
import type { SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import * as C from "../procurement/contracts";
import { assessOperationsTransition, assertProcurementBasis, procurementBasisHash } from "../procurement/state";
import { quoteArithmetic } from "../procurement/arithmetic";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { database, query } from "./db";
import { claimPrivate, requireClaim } from "./claims";
import { currentSourceCheck } from "./planning-store";
import { quoteVersion } from "./procurement-catalog";
import { loadProcurementFacts, observeProcurementPackage, type SelectionPayload } from "./procurement-facts";
import { assertOpenOperations, expectOperationsHead, nextCycleTime, writeOperationsHead } from "./procurement-operations-store";
import { buildProcurementDetail, exceptionPayload, finishProcurementMutation, operationsObservation, type ExceptionRow, type ExpenseLinkPayload } from "./procurement-projection";
import { assertOwnResponsibility, dbClock, expectProcurementScope, integrity, lockProcurementBasis, operationsHead, openProcurement, procurementAuthority, procurementBusy, procurementCommand, procurementHash, procurementProjectLock, quotePayload, requireQuote, responsibilityCurrent, scopeValues, sealProcurement, type ProcurementAuthority } from "./procurement-store";

function writer(session: Session) { if (!["organizer", "volunteer"].includes(session.role)) throw new DomainError("PROCUREMENT_ROLE_DENIED", "This role cannot record operational work.", 403); }
async function packageWriter(tx: SqlConnection, session: Session, packageId: string) { writer(session); if (session.role === "volunteer") await assertOwnResponsibility(tx, session, packageId); }
export async function selectProcurementQuote(session: Session, raw: z.infer<typeof C.quoteSelectionInputSchema>) {
  const input = C.quoteSelectionInputSchema.parse(raw);
  return procurementCommand(session, input, "quote_selection", ["organizer"], async (tx, authority) => {
    await lockProcurementBasis(tx, session);
    const previous = (await operationsHead(tx, session, input.packageId, true)).data; expectOperationsHead(previous, input.expectedOperationsVersion, input.expectedCycle); await assertOpenOperations(previous);
    const facts = await loadProcurementFacts(tx, session, await dbClock(tx)), observed = await observeProcurementPackage(tx, session, facts, input.packageId); assertProcurementBasis(input.expectedBasisHash, observed.basis);
    for (const head of input.comparisonQuoteHeads) { const row = await requireQuote(tx, session, head.id), version = await quoteVersion(tx, session, row), data = quotePayload(version); if (!row.package_ids.includes(input.packageId) || row.version !== head.version || version.content_hash !== head.contentHash) throw new DomainError("PROCUREMENT_VERSION_CHANGED", "A compared alternative or its exact scope changed. Review every retained comparison head again.", 409); if (data.sourceBinding && (await currentSourceCheck(session, [data.sourceBinding], tx, true)).length) throw new DomainError("PROCUREMENT_SOURCE_WITHDRAWN", "A compared original source is no longer permitted. Reload the current alternatives.", 410); }
    const row = await requireQuote(tx, session, input.quoteId), version = await quoteVersion(tx, session, row), data = quotePayload(version), arithmetic = quoteArithmetic(data.draft);
    const [supplier] = await query<{ state: string; version: number }>("SELECT state,version FROM fp_procurement_suppliers WHERE tenant_id=$1 AND project_id=$2 AND id=$3", [...scopeValues(session), data.draft.supplierId], tx);
    if (row.version !== input.quoteVersion || version.content_hash !== input.quoteHash || row.state !== "reviewed" || !row.package_ids.includes(input.packageId) || data.packageVersions[input.packageId] !== observed.canonical.version) throw new DomainError("PROCUREMENT_QUOTE_INVALID", "Select the exact current internally reviewed quote for this package and canonical version.", 409);
    if (supplier?.state !== "active" || supplier.version !== data.draft.supplierVersion) throw new DomainError("PROCUREMENT_SUPPLIER_CHANGED", "The supplier declaration changed. A separate current quote revision needs review.", 409);
    if (data.draft.validUntil && Date.parse(data.draft.validUntil) <= Date.parse(await dbClock(tx))) throw new DomainError("PROCUREMENT_QUOTE_EXPIRED", "The original quote deadline ended. Selection cannot renew it.", 409);
    if (data.sourceBinding && (await currentSourceCheck(session, [data.sourceBinding], tx, true)).length) throw new DomainError("PROCUREMENT_SOURCE_WITHDRAWN", "The exact selected source is no longer permitted.", 410);
    if (arithmetic.errors.length || data.draft.currency !== observed.basis.currency) throw new DomainError("PROCUREMENT_QUOTE_INVALID", "Correct quote arithmetic or currency conflicts before selecting. No currency conversion is inferred.", 422);
    if (input.shareScalarsWithAssignee && (!observed.responsibilityCurrent || observed.responsibility?.state !== "accepted")) throw new DomainError("PROCUREMENT_ASSIGNMENT_REQUIRED", "Explicit scalar sharing needs the exact current accepted responsibility. A future assignee never inherits this disclosure.", 409);
    const id = randomUUID(), payload: SelectionPayload = { quoteId: row.id, quoteVersion: row.version, quoteHash: version.content_hash, cycle: previous.cycle, label: data.draft.title, supplierName: data.supplier.name, amountMinor: arithmetic.packageCosts.find(row => row.packageId === input.packageId)?.amountMinor ?? null, currency: data.draft.currency, comparisonQuoteHeads: input.comparisonQuoteHeads, reason: input.reason, shareScalarsWithAssignee: input.shareScalarsWithAssignee, sharedWithResponsibilityId: input.shareScalarsWithAssignee ? observed.responsibility!.id : null };
    await tx.query("INSERT INTO fp_procurement_selections(id,tenant_id,project_id,package_id,cycle,quote_id,quote_version,content_hash,encrypted_data,actor_id,actor_session_id,actor_role,membership_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)", [id, session.tenantId, session.projectId, input.packageId, previous.cycle, row.id, row.version, procurementHash(payload), sealProcurement(session, "selection", id, 1, payload), session.actorId, session.id, session.role, authority.membershipVersion]);
    const next = await writeOperationsHead(tx, authority, previous, { selectionId: id, reviewedBasis: null }); await finishProcurementMutation(tx, authority, "quote_selection", previous, next, input.reason, payload.sharedWithResponsibilityId);
    return { id, version: 1, message: "The exact quote and reviewed package cost share are selected for coordination. Unknown costs remain unknown. This sends no order or message and grants no spending approval.", validate: async () => { if (data.draft.validUntil && Date.parse(data.draft.validUntil) <= Date.parse(await dbClock(tx))) throw new DomainError("PROCUREMENT_QUOTE_EXPIRED", "The original quote expired while its selection receipt was being saved.", 409); if (input.shareScalarsWithAssignee && observed.responsibility && !await responsibilityCurrent(tx, observed.responsibility)) throw new DomainError("PROCUREMENT_ASSIGNMENT_ENDED", "The exact recipient responsibility ended before this scalar disclosure could be recorded.", 409); } };
  });
}

interface ReviewRow { id: string; review_hash: string; content_hash: string; encrypted_data: string; expires_at: Date; actor_id: string; actor_session_id: string; actor_role: string; membership_version: number; }
async function currentReview(tx: SqlConnection, authority: ProcurementAuthority, input: C.ProcurementTransitionPrepare): Promise<C.ProcurementTransitionReview> {
  const session = authority.session, previous = (await operationsHead(tx, session, input.packageId)).data; expectOperationsHead(previous, input.expectedVersion, input.expectedCycle);
  const facts = await loadProcurementFacts(tx, session, await dbClock(tx)), observed = await observeProcurementPackage(tx, session, facts, input.packageId); assertProcurementBasis(input.expectedBasisHash, observed.basis);
  if (session.role === "volunteer") await assertOwnResponsibility(tx, session, input.packageId);
  if (input.sharedWithResponsibilityId && (input.sharedWithResponsibilityId !== observed.responsibility?.id || !observed.responsibilityCurrent)) throw new DomainError("PROCUREMENT_ASSIGNMENT_ENDED", "Explicitly shared notes must bind this exact current responsibility. A later assignee cannot inherit them.", 409);
  const assessment = assessOperationsTransition({ ...operationsObservation(authority, facts, observed), to: input.to });
  return C.procurementTransitionReviewSchema.parse({ reviewHash: "0".repeat(64), input, from: previous.state, to: input.to, basis: observed.basis, basisHash: procurementBasisHash(observed.basis), checkedAt: facts.checkedAt, expiresAt: new Date(Math.min(Date.parse(session.expiresAt), Date.parse(facts.checkedAt) + 10 * 60_000)).toISOString(), canCommit: assessment.allowed, gates: (await buildProcurementDetail(tx, authority, input.packageId, facts)).value.gates, blockers: assessment.blockers, warnings: assessment.warnings, effects: assessment.effects });
}
export async function prepareProcurementTransition(session: Session, raw: C.ProcurementTransitionPrepare): Promise<C.ProcurementTransitionReview> {
  const input = C.procurementTransitionPrepareSchema.parse(raw);
  expectProcurementScope(await procurementAuthority(session, database(), ["organizer", "volunteer"]), input.expectedScope);
  try { return await database().transaction(async tx => {
    await tx.query("SET LOCAL lock_timeout='2000ms'; SET LOCAL statement_timeout='20000ms'"); await procurementProjectLock(tx, session);
    const authority = await procurementAuthority(session, tx, ["organizer", "volunteer"], true); expectProcurementScope(authority, input.expectedScope); await lockProcurementBasis(tx, session);
    const review = await currentReview(tx, authority, input), id = randomUUID(), reviewHash = procurementHash({ id, scope: authority.scope, review });
    review.reviewHash = reviewHash;
    await tx.query("INSERT INTO fp_procurement_reviews(id,tenant_id,project_id,package_id,review_hash,content_hash,encrypted_data,expires_at,actor_id,actor_session_id,actor_role,membership_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [id, session.tenantId, session.projectId, input.packageId, reviewHash, procurementHash(review), sealProcurement(session, "transition-review", id, 1, review), review.expiresAt, session.actorId, session.id, session.role, authority.membershipVersion]);
    expectProcurementScope(await procurementAuthority(session, tx, ["organizer", "volunteer"]), input.expectedScope);
    if (Date.parse(await dbClock(tx)) >= Date.parse(review.expiresAt)) throw new DomainError("PROCUREMENT_REVIEW_REQUIRED", "The fixed review deadline ended during preparation. Review the current facts again.", 409);
    return review;
  }); } catch (error) { return procurementBusy(error); }
}
export async function commitProcurementTransition(session: Session, raw: z.infer<typeof C.procurementTransitionCommitSchema>) {
  const input = C.procurementTransitionCommitSchema.parse(raw);
  return procurementCommand(session, input, "transition", ["organizer", "volunteer"], async (tx, authority) => {
    await lockProcurementBasis(tx, session);
    const [saved] = await query<ReviewRow>("SELECT * FROM fp_procurement_reviews WHERE tenant_id=$1 AND project_id=$2 AND review_hash=$3 AND actor_id=$4 AND actor_session_id=$5 AND actor_role=$6 AND membership_version=$7", [...scopeValues(session), input.reviewHash, session.actorId, session.id, session.role, authority.membershipVersion], tx);
    if (!saved) throw new DomainError("PROCUREMENT_REVIEW_REQUIRED", "This exact original project profile has no matching prepared review. Review current sources and effects first.", 409);
    const review = C.procurementTransitionReviewSchema.parse(openProcurement(session, "transition-review", saved.id, 1, saved.encrypted_data)); integrity(review, saved.content_hash);
    if (procurementHash(review.input) !== procurementHash(input.review) || review.reviewHash !== input.reviewHash || !review.canCommit || saved.expires_at.getTime() <= Date.parse(await dbClock(tx))) throw new DomainError("PROCUREMENT_REVIEW_REQUIRED", "The prepared decision changed, was blocked or its original review deadline ended. Review the current exact facts again.", 409);
    const nowReview = await currentReview(tx, authority, input.review);
    if (!nowReview.canCommit || nowReview.basisHash !== review.basisHash || nowReview.from !== review.from) throw new DomainError("PROCUREMENT_BASIS_CHANGED", "The source, package, money, membership or physical-review basis changed after review. The earlier decision stays uncommitted.", 409);
    const previous = (await operationsHead(tx, session, input.review.packageId, true)).data, reopening = input.review.to === "reopened";
    const next = await writeOperationsHead(tx, authority, previous, { state: input.review.to, blockedFrom: input.review.to === "blocked" ? previous.state : null, ...(reopening ? { cycle: previous.cycle + 1, cycleStartedAt: await nextCycleTime(tx, previous.cycleStartedAt), responsibilityId: null, selectionId: null, progressId: null, reviewedBasis: null } : { reviewedBasis: nowReview.basis }) });
    await finishProcurementMutation(tx, authority, "transition", previous, next, input.review.reason, input.review.sharedWithResponsibilityId);
    if (Date.parse(await dbClock(tx)) >= saved.expires_at.getTime()) throw new DomainError("PROCUREMENT_REVIEW_REQUIRED", "The original prepared review expired while the exact decision was being recorded. Its uncommitted changes were rolled back.", 409);
    return { id: next.packageId, version: next.version, message: reopening ? "The next operational cycle is recorded. Earlier money, physical evidence and approvals remain unchanged; responsibility and source readiness need fresh review." : input.review.to === "canceled" ? "Operational coordination is canceled with a retained reason. Financial obligations, original donor choices, expense payables and physical evidence are not changed by this record." : "The exact operational step is recorded with its reviewed source and package versions. No merchant purchase, payment or physical review was executed.", validate: async () => {
      if (Date.parse(await dbClock(tx)) >= saved.expires_at.getTime()) throw new DomainError("PROCUREMENT_REVIEW_REQUIRED", "The original prepared review expired while its receipt was being saved. All uncommitted coordination changes were rolled back.", 409);
      if (!["canceled", "reopened", "draft", "blocked"].includes(input.review.to)) {
        const latest = await loadProcurementFacts(tx, session, await dbClock(tx)), observed = await observeProcurementPackage(tx, session, latest, previous.packageId), observation = operationsObservation(authority, latest, observed), assessment = assessOperationsTransition({ ...observation, from: previous.state, blockedFrom: previous.blockedFrom, cycle: previous.cycle, to: input.review.to });
        if (!assessment.allowed || procurementBasisHash(observed.basis) !== review.basisHash) throw new DomainError("PROCUREMENT_BASIS_CHANGED", "Original evidence, quote, responsibility or readiness authority ended while the receipt was being saved. Review current facts; this step was not committed.", 409);
      }
    } };
  });
}
export async function recordProcurementProgress(session: Session, raw: z.infer<typeof C.procurementProgressInputSchema>) {
  const input = C.procurementProgressInputSchema.parse(raw);
  return procurementCommand(session, input, "progress", ["organizer", "volunteer"], async (tx, authority) => {
    await lockProcurementBasis(tx, session); await packageWriter(tx, session, input.packageId); const previous = (await operationsHead(tx, session, input.packageId, true)).data; expectOperationsHead(previous, input.expectedVersion, input.expectedCycle); await assertOpenOperations(previous);
    const at = await dbClock(tx); if (Date.parse(input.observedAt) > Date.parse(at) || Date.parse(input.observedAt) < Date.parse(previous.cycleStartedAt)) throw new DomainError("PROCUREMENT_SOURCE_INVALID", "Record an observation within this original operational cycle and no later than the current time.", 422);
    const id = randomUUID(), data = C.procurementProgressSchema.parse({ percent: input.percent, note: input.note, observedAt: input.observedAt, recordedAt: at, cycle: previous.cycle, basis: "self_reported", provenance: session.mode === "sample" ? "sample" : "user_declared" });
    await tx.query("INSERT INTO fp_procurement_progress(id,tenant_id,project_id,package_id,cycle,percent,observed_at,content_hash,encrypted_data,actor_id,actor_session_id,actor_role,membership_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)", [id, session.tenantId, session.projectId, input.packageId, previous.cycle, input.percent, input.observedAt, procurementHash(data), sealProcurement(session, "progress", id, 1, data), session.actorId, session.id, session.role, authority.membershipVersion]);
    const next = await writeOperationsHead(tx, authority, previous, { progressId: id }); await finishProcurementMutation(tx, authority, "progress", previous, next, input.note, session.role === "volunteer" ? previous.responsibilityId : null);
    return { id, version: 1, message: input.percent === null ? "Unknown progress is recorded explicitly. It is not zero or a physical acceptance." : "The self-reported progress declaration is saved. Even 100% does not accept physical work or authorize repayment." };
  });
}
export async function openProcurementException(session: Session, raw: z.infer<typeof C.procurementExceptionInputSchema>) {
  const input = C.procurementExceptionInputSchema.parse(raw);
  return procurementCommand(session, input, "exception_open", ["organizer", "volunteer"], async (tx, authority) => {
    await lockProcurementBasis(tx, session); await packageWriter(tx, session, input.packageId); const previous = (await operationsHead(tx, session, input.packageId, true)).data; expectOperationsHead(previous, input.expectedVersion, input.expectedCycle); await assertOpenOperations(previous);
    const [{ count }] = await query<{ count: string }>("SELECT count(*) FROM fp_procurement_exceptions WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 AND cycle=$4 AND state='open'", [...scopeValues(session), input.packageId, previous.cycle], tx);
    if (Number(count) >= 100) throw new DomainError("PROCUREMENT_TRANSITION_BLOCKED", "Review and resolve the existing open reported issues before adding another. Their full immutable history remains available.", 409);
    const id = randomUUID(), data = { title: input.title, reason: input.reason, createdRole: session.role };
    await tx.query("INSERT INTO fp_procurement_exceptions(id,tenant_id,project_id,package_id,cycle,category,created_by,encrypted_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id, session.tenantId, session.projectId, input.packageId, previous.cycle, input.category, session.actorId, sealProcurement(session, "exception", id, 1, data)]);
    await tx.query("INSERT INTO fp_procurement_exception_events(id,exception_id,tenant_id,project_id,version,kind,actor_id,actor_session_id,actor_role,membership_version,encrypted_data) VALUES($1,$2,$3,$4,1,'opened',$5,$6,$7,$8,$9)", [randomUUID(), id, session.tenantId, session.projectId, session.actorId, session.id, session.role, authority.membershipVersion, sealProcurement(session, "exception-event", id, 1, data)]);
    const next = await writeOperationsHead(tx, authority, previous, {}); await finishProcurementMutation(tx, authority, "exception", previous, next, input.reason, session.role === "volunteer" ? previous.responsibilityId : null);
    return { id, version: 1, message: "The reported operational issue is saved with its original reason. It changes no payment, supplier response or physical decision." };
  });
}
export async function resolveProcurementException(session: Session, id: string, raw: z.infer<typeof C.procurementExceptionResolveSchema>) {
  const input = C.procurementExceptionResolveSchema.parse(raw);
  return procurementCommand(session, { ...input, resourceId: id }, "exception_resolve", ["organizer", "volunteer"], async (tx, authority) => {
    await lockProcurementBasis(tx, session); const [row] = await query<ExceptionRow>("SELECT * FROM fp_procurement_exceptions WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE", [...scopeValues(session), id], tx);
    if (!row || session.role !== "organizer" && !(row.created_by === session.actorId && exceptionPayload(row).createdRole === "volunteer")) throw new DomainError("PROCUREMENT_NOT_FOUND", "This reported issue is outside your permitted current view.", 404);
    await packageWriter(tx, session, row.package_id); const previous = (await operationsHead(tx, session, row.package_id, true)).data; await assertOpenOperations(previous);
    if (row.version !== input.expectedVersion || row.state !== "open" || row.cycle !== previous.cycle) throw new DomainError("PROCUREMENT_VERSION_CHANGED", "This reported issue or operational cycle changed. Review its current retained version.", 409);
    await tx.query("UPDATE fp_procurement_exceptions SET version=version+1,state='resolved',resolved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1 AND project_id=$2 AND id=$3", [...scopeValues(session), id]);
    await tx.query("INSERT INTO fp_procurement_exception_events(id,exception_id,tenant_id,project_id,version,kind,actor_id,actor_session_id,actor_role,membership_version,encrypted_data) VALUES($1,$2,$3,$4,$5,'resolved',$6,$7,$8,$9,$10)", [randomUUID(), id, session.tenantId, session.projectId, row.version + 1, session.actorId, session.id, session.role, authority.membershipVersion, sealProcurement(session, "exception-event", id, row.version + 1, { reason: input.reason })]);
    const next = await writeOperationsHead(tx, authority, previous, {}); await finishProcurementMutation(tx, authority, "exception", previous, next, input.reason, session.role === "volunteer" ? previous.responsibilityId : null);
    return { id, version: row.version + 1, message: "The reported issue is resolved with an immutable reason. Derived source, funding or physical-evidence gates still require their actual underlying facts to change." };
  });
}
export async function linkProcurementExpense(session: Session, raw: z.infer<typeof C.procurementExpenseLinkInputSchema>) {
  const input = C.procurementExpenseLinkInputSchema.parse(raw);
  return procurementCommand(session, input, "expense_link", ["organizer", "volunteer"], async (tx, authority) => {
    await lockProcurementBasis(tx, session); await packageWriter(tx, session, input.packageId); const previous = (await operationsHead(tx, session, input.packageId, true)).data; expectOperationsHead(previous, input.expectedVersion, input.expectedCycle); await assertOpenOperations(previous);
    const claim = await requireClaim(session, input.claimId, tx, true), data = claimPrivate(claim);
    if (claim.version !== input.claimVersion || !data.lines.some(row => row.packageId === input.packageId)) throw new DomainError("PROCUREMENT_EXPENSE_CHANGED", "The exact existing claim version or its assigned package changed. Review the current expense through its original workflow.", 409);
    const [existing] = await query<{ id: string }>("SELECT id FROM fp_procurement_expense_links WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 AND cycle=$4 AND claim_id=$5 AND claim_version=$6", [...scopeValues(session), input.packageId, previous.cycle, claim.id, claim.version], tx); if (existing) return { id: existing.id, version: 1, message: "This exact claim version is already linked; no second expense, payable or repayment was created." };
    const id = randomUUID(), values = data.lines.filter(row => row.packageId === input.packageId), payload: ExpenseLinkPayload = { claimId: claim.id, claimVersion: claim.version, claimHash: procurementHash(data), packageId: input.packageId, title: data.title, requestedMinor: values.reduce((sum, row) => sum + row.requestedMinor, 0), approvedMinor: values.reduce((sum, row) => sum + row.approvedMinor, 0), currency: claim.currency, reason: input.reason, documentId: claim.document_id, documentVersion: data.sourceDocumentVersion, documentHash: data.sourceHash };
    await tx.query("INSERT INTO fp_procurement_expense_links(id,tenant_id,project_id,package_id,cycle,claim_id,claim_version,content_hash,encrypted_data,actor_id,actor_session_id,actor_role,membership_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)", [id, session.tenantId, session.projectId, input.packageId, previous.cycle, claim.id, claim.version, procurementHash(payload), sealProcurement(session, "expense-link", id, 1, payload), session.actorId, session.id, session.role, authority.membershipVersion]);
    const next = await writeOperationsHead(tx, authority, previous, {}); await finishProcurementMutation(tx, authority, "expense_link", previous, next, input.reason, session.role === "volunteer" ? previous.responsibilityId : null);
    return { id, version: 1, message: "The original guarded expense is linked to this operational cycle. Its claim, approval, recipient, payment and allocation records were not changed." };
  });
}
