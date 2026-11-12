import { canonicalJson, sha256 } from "@fracture/paypal-core";
import { DomainError } from "../domain/money";
import * as C from "./contracts";

export function procurementBasisHash(raw: C.ProcurementBasis): string { return sha256(canonicalJson({ contractVersion: C.PROCUREMENT_VERSION, ...C.procurementBasisSchema.parse(raw) })); }
const edges: Record<C.ProcurementState, C.ProcurementState[]> = {
  draft: ["approved", "blocked", "canceled"], approved: ["draft", "procurement_ready", "blocked", "canceled"],
  procurement_ready: ["in_progress", "blocked", "canceled"], in_progress: ["review_pending", "blocked", "canceled"],
  review_pending: ["in_progress", "accepted", "blocked", "canceled"], accepted: ["reopened", "canceled"],
  blocked: ["draft", "approved", "procurement_ready", "in_progress", "review_pending", "canceled"], canceled: ["reopened"], reopened: ["draft", "approved", "blocked", "canceled"],
};
export interface OperationsObservation {
  role: C.ProcurementRole; originalAuthorityCurrent: boolean; ownAcceptedResponsibility: boolean;
  from: C.ProcurementState; to: C.ProcurementState; blockedFrom: C.ProcurementState | null; cycle: number; observedAt: string;
  basis: C.ProcurementBasis; planCurrent: boolean; prerequisitesCurrent: boolean;
  policyCompatible?: boolean;
  responsibility: { state: C.Responsibility["state"]; cycle: number; authorityCurrent: boolean; expiresAt: string } | null;
  selection: { cycle: number; sourceCurrent: boolean; reviewed: boolean; amountMinor: number | null; currency: string; validUntil: string | null; capabilitiesKnown: boolean } | null;
  financialReady: boolean; accountingAvailableMinor: number | null;
  requirements: { id: string; kind: "photo_association" | "physical_review"; current: boolean; currentCycle: boolean }[];
  blockingReportedExceptions: number;
}
export interface OperationsAssessment { allowed: boolean; code: C.ProcurementProblem["code"] | null; blockers: string[]; warnings: string[]; effects: string[]; }
/** Interpret current locked observations without purchasing, reimbursing or
 * certifying work. Cancel/reopen never edits earlier physical/financial facts. */
export function assessOperationsTransition(raw: OperationsObservation): OperationsAssessment {
  const input = { ...raw, basis: C.procurementBasisSchema.parse(raw.basis) }, blockers: string[] = [], warnings: string[] = [], effects: string[] = [];
  const deny = (code: C.ProcurementProblem["code"], message: string): OperationsAssessment => ({ allowed: false, code, blockers: [message], warnings, effects });
  if (!Number.isSafeInteger(input.cycle) || input.cycle < 1 || !Number.isFinite(Date.parse(input.observedAt))) return deny("PROCUREMENT_BASIS_CHANGED", "Use the exact current operations cycle and actual review cutoff.");
  if (!input.originalAuthorityCurrent) return deny("PROCUREMENT_AUTHORITY_ENDED", "The original current project role or its fixed session deadline ended.");
  if (!edges[input.from]?.includes(input.to)) return deny("PROCUREMENT_TRANSITION_BLOCKED", "This transition is unavailable from the current saved state. Review its preserved history.");
  if (input.from === "blocked" && !["canceled", "draft"].includes(input.to) && input.to !== input.blockedFrom) return deny("PROCUREMENT_TRANSITION_BLOCKED", "Resolve a block back to its exact prior step. A block cannot skip an approval or readiness review.");
  const volunteerAction = input.role === "volunteer" && input.ownAcceptedResponsibility && ["in_progress", "review_pending", "blocked"].includes(input.to) && ["procurement_ready", "in_progress", "review_pending", "blocked"].includes(input.from);
  if (input.role !== "organizer" && !volunteerAction) return deny("PROCUREMENT_ROLE_DENIED", "A current organizer approves, cancels, reopens and accepts packages. A current assignee reports only their own permitted work step.");
  if (input.to === "canceled") {
    effects.push("Record cancellation of operational coordination only.", "Keep all original funding, donor choices, expense approvals, payables, sources and physical decisions in their existing history.");
    warnings.push("Financial obligations remain independently actionable through their original guarded workflows. This does not cancel or return a payment.");
    return { allowed: true, code: null, blockers, warnings, effects };
  }
  if (input.to === "reopened") {
    effects.push("Create the next operational cycle with an explicit reason.", "Require a fresh responsible-person acceptance and quote/source readiness review.", "Retain old physical decisions as history; new-cycle acceptance needs new current physical decisions.");
    warnings.push("Reopening renews no membership, quote, source permission or canceled funding purpose. No earlier financial or evidence row is rewritten.");
    return { allowed: true, code: null, blockers, warnings, effects };
  }
  if (["draft", "blocked"].includes(input.to)) {
    effects.push(input.to === "blocked" ? "Record a reasoned block with explicit unknown cost, progress and financial outcomes." : "Return the operational proposal for edits while preserving earlier decisions.");
    return { allowed: true, code: null, blockers, warnings, effects };
  }
  if (!input.planCurrent || input.basis.planStatus !== "current" || !input.basis.plan) blockers.push("A current published plan, exact package version and permitted sources are required.");
  if (input.policyCompatible === false) blockers.push("Current project-owned plan or evidence rules have unresolved prospective requirements. Earlier approvals and physical decisions remain retained as history.");
  if (["procurement_ready", "in_progress", "review_pending"].includes(input.to)) {
    const assignment = input.responsibility;
    if (!assignment || assignment.state !== "accepted" || assignment.cycle !== input.cycle || !assignment.authorityCurrent || Date.parse(assignment.expiresAt) <= Date.parse(input.observedAt)) blockers.push("A current independently authorized responsible person must explicitly accept this cycle before work proceeds.");
  }
  if (["procurement_ready", "in_progress", "accepted"].includes(input.to) && !input.prerequisitesCurrent) blockers.push("Required predecessors and qualified safety reviews are not satisfied under the current plan.");
  if (input.to === "procurement_ready") {
    const selection = input.selection;
    if (!selection || selection.cycle !== input.cycle || !selection.sourceCurrent || !selection.reviewed) blockers.push("Select a current explicitly reviewed quote for this exact cycle.");
    if (!selection || selection.amountMinor === null || selection.currency !== input.basis.currency) blockers.push("The complete declared cost must be known in the canonical package currency. Unknown costs are not zero and no exchange rate is inferred.");
    if (!selection?.validUntil || Date.parse(selection.validUntil) <= Date.parse(input.observedAt)) blockers.push("The original quote deadline is unknown or ended. Review a new current source.");
    if (!selection?.capabilitiesKnown) blockers.push("Current required capabilities need source-supported assessments without unresolved conflicts.");
    if (!input.financialReady || ["cancelled", "compensating"].includes(input.basis.fundingState)) blockers.push("The canonical funding purpose is not eligible for new procurement review.");
    if (selection?.amountMinor !== null && selection?.amountMinor !== undefined && (input.accountingAvailableMinor === null || input.accountingAvailableMinor < selection.amountMinor)) blockers.push("The application ledger does not establish enough unallocated eligible funding for the selected cost.");
    warnings.push("Ready means ready for separate purchase/spending review. Provider liquidity is unchecked; no merchant order or payment is authorized.");
  }
  if (input.to === "accepted") {
    if (!input.requirements.length || input.requirements.some(requirement => !requirement.current || requirement.kind === "physical_review" && !requirement.currentCycle)) blockers.push("Every current evidence requirement needs its permitted reviewed association or a qualified physical decision for this cycle.");
    if (input.blockingReportedExceptions) blockers.push("Resolve reported operational blocks before recording acceptance.");
    effects.push("Record operational acceptance against these exact source and physical-review hashes.", "Keep original financial outcomes independent. Acceptance confirms neither repayment nor merchant fulfillment.");
  } else effects.push("Record this exact operational step without executing a purchase, payment or physical review.");
  return { allowed: !blockers.length, code: blockers.length ? input.to === "accepted" ? "PROCUREMENT_PHYSICAL_REVIEW_REQUIRED" : "PROCUREMENT_TRANSITION_BLOCKED" : null, blockers, warnings, effects };
}
export function availableOperationsTargets(input: Omit<OperationsObservation, "to">): C.ProcurementState[] { return edges[input.from].filter(to => assessOperationsTransition({ ...input, to }).allowed); }
/** A blocked readiness review must remain discoverable. These are only role-
 * permitted review candidates; every positive gate is rechecked by the server. */
export function reviewableOperationsTargets(input: Pick<OperationsObservation, "role" | "ownAcceptedResponsibility" | "from" | "blockedFrom">): C.ProcurementState[] {
  return edges[input.from].filter(to => (input.from !== "blocked" || ["draft", "canceled"].includes(to) || to === input.blockedFrom) && (input.role === "organizer" || input.role === "volunteer" && input.ownAcceptedResponsibility && ["in_progress", "review_pending", "blocked"].includes(to) && ["procurement_ready", "in_progress", "review_pending", "blocked"].includes(input.from)));
}
export function assertProcurementBasis(expectedHash: string, current: C.ProcurementBasis) { if (procurementBasisHash(current) !== expectedHash) throw new DomainError("PROCUREMENT_BASIS_CHANGED", "The package, plan, source, responsibility, quote or financial basis changed. Review the current version before committing.", 409); }
