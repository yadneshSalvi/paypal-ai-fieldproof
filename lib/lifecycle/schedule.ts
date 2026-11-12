import { canonicalJson, sha256 } from "@fracture/paypal-core";
import { z } from "zod";
import { DomainError } from "../domain/money";
import * as C from "./contracts";

const iso = (value: string): string => {
  if (!z.iso.datetime().safeParse(value).success || !Number.isFinite(Date.parse(value))) throw new DomainError("LIFECYCLE_OCCURRENCE_CHANGED", "Use the original valid UTC occurrence time.", 422);
  return new Date(value).toISOString();
};
const hash = (value: unknown) => sha256(canonicalJson(value));
const pins = (values: readonly C.LifecycleConsentPin[]) => [...values].map(value => ({ ...value, expiresAt: iso(value.expiresAt), disclosure: [...value.disclosure].sort() })).sort((a, b) => a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0);

/** A business occurrence is a due slot of an immutable definition. Its key has
 * no worker/attempt identity, moving wall clock, source refresh or read state. */
export function lifecycleOccurrenceKey(scheduleId: string, definitionVersion: number, dueAt: string): string {
  z.uuid().parse(scheduleId); z.number().int().positive().parse(definitionVersion);
  return hash({ contract: C.LIFECYCLE_VERSION, scheduleId, definitionVersion, dueAt: iso(dueAt) });
}
export function lifecycleDefinitionHash(raw: C.LifecycleScheduleProposal): string {
  const proposal = C.lifecycleScheduleProposalSchema.parse(raw), target = proposal.target;
  return hash({ contract: C.LIFECYCLE_VERSION, ...proposal, cadence: { ...proposal.cadence, firstDueAt: iso(proposal.cadence.firstDueAt) }, expiresAt: iso(proposal.expiresAt), topics: [...proposal.topics].sort(),
    target: target.kind === "project_treasurer" ? { ...target, link: pins([target.link])[0] } : { ...target, links: pins(target.links), filters: Object.fromEntries(Object.entries(target.filters).map(([key, values]) => [key, [...values].sort()])) },
  });
}
export function lifecycleFixedDeadline(input: { requestedExpiresAt: string; organizationExpiresAt: string; programExpiresAt: string; projectExpiresAt: string | null; links: readonly C.LifecycleConsentPin[] }): string {
  if (!input.links.length) throw new DomainError("LIFECYCLE_SOURCE_CHANGED", "Review at least one exact project disclosure before scheduling.", 422);
  const dates = [input.requestedExpiresAt, input.organizationExpiresAt, input.programExpiresAt, ...input.links.map(link => link.expiresAt), ...(input.projectExpiresAt ? [input.projectExpiresAt] : [])];
  return new Date(Math.min(...dates.map(value => Date.parse(iso(value))))).toISOString();
}
export interface LifecyclePause { pausedAt: string; resumedAt: string | null; }
export interface LifecycleDueSlot { occurrenceKey: string; dueAt: string; state: "due" | "skipped_paused" | "expired" | "cancelled"; }
export interface LifecycleDueInput {
  scheduleId: string; definitionVersion: number; cadence: C.LifecycleCadence; expiresAt: string;
  afterDueAt: string | null; observedAt: string; pauses: readonly LifecyclePause[]; disabledAt: string | null; limit?: number;
}
/** Bounded cursor work, not silent catch-up/coalescing. The caller persists each
 * original slot and its disposition atomically before advancing afterDueAt.
 * A skipped slot never receives a snapshot. A real capture, if permitted, uses
 * its own actual transaction time, never this historical scheduled time. */
export function dueLifecycleSlots(input: LifecycleDueInput): { slots: LifecycleDueSlot[]; cursor: string | null; nextDueAt: string | null; hasMore: boolean } {
  const cadence = C.lifecycleCadenceSchema.parse(input.cadence), first = Date.parse(iso(cadence.firstDueAt)), expiry = Date.parse(iso(input.expiresAt)), now = Date.parse(iso(input.observedAt)), step = cadence.intervalMinutes * 60_000;
  const limit = input.limit ?? C.LIFECYCLE_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || expiry <= first) throw new DomainError("LIFECYCLE_OCCURRENCE_CHANGED", "This definition needs a valid bounded original schedule window.", 422);
  let due = first;
  if (input.afterDueAt !== null) {
    const after = Date.parse(iso(input.afterDueAt));
    if (after < first || (after - first) % step !== 0 || after >= expiry) throw new DomainError("LIFECYCLE_OCCURRENCE_CHANGED", "Keep the exact last durably recorded slot; do not move the schedule cursor.", 409);
    due = after + step;
  }
  const pauses = input.pauses.map(value => {
    const start = Date.parse(iso(value.pausedAt)), end = value.resumedAt === null ? Infinity : Date.parse(iso(value.resumedAt));
    if (end <= start) throw new DomainError("LIFECYCLE_OCCURRENCE_CHANGED", "A pause must retain its original start and later explicit resume.", 422);
    return { start, end };
  });
  const disabled = input.disabledAt === null ? Infinity : Date.parse(iso(input.disabledAt)), slots: LifecycleDueSlot[] = [];
  while (due <= now && due < expiry && slots.length < limit) {
    const dueAt = new Date(due).toISOString(), state = due >= disabled ? "cancelled" : pauses.some(pause => due >= pause.start && due < pause.end) ? "skipped_paused" : now >= expiry ? "expired" : "due";
    slots.push({ occurrenceKey: lifecycleOccurrenceKey(input.scheduleId, input.definitionVersion, dueAt), dueAt, state });
    due += step;
  }
  return { slots, cursor: slots.at(-1)?.dueAt ?? input.afterDueAt, nextDueAt: due < expiry ? new Date(due).toISOString() : null, hasMore: due <= now && due < expiry };
}

export interface LifecycleGrantObservation {
  observedAt: string; runtimeHeld: boolean;
  organization: { state: "active" | "ended"; scope: string; role: string; membershipVersion: number; expiresAt: string };
  project: { state: "active" | "ended"; scope: string; role: string; membershipVersion: number; expiresAt: string } | null;
  program: { state: C.LifecycleProgram["state"]; version: number; expiresAt: string | null };
  links: (C.LifecycleConsentPin & { state: "active" | "withdrawn" | "suspended" | "expired" })[];
  scheduleState: C.LifecycleSchedule["state"];
}
export interface LifecyclePermission { allowed: boolean; code: C.LifecycleProblem["code"] | null; reason: string | null; }
/** This is a pure interpretation of authoritative observations, not an auth
 * provider. The server reads/locks the original scoped grants and performs a
 * fresh check again after awaits/serialization. No token/session is fabricated. */
export function lifecyclePermission(raw: C.LifecycleScheduleReview, observation: LifecycleGrantObservation, mode: "produce" | "read" = "produce"): LifecyclePermission {
  const review = C.lifecycleScheduleReviewSchema.parse(raw), grant = review.authorization, now = Date.parse(iso(observation.observedAt));
  const deny = (code: C.LifecycleProblem["code"], reason: string): LifecyclePermission => ({ allowed: false, code, reason });
  if (now >= Date.parse(grant.expiresAt)) return deny("LIFECYCLE_EXPIRED", "The original authorization deadline ended. Retry and restore cannot extend it.");
  const organization = observation.organization;
  if (organization.state !== "active" || organization.scope !== review.input.expectedScope || organization.membershipVersion !== grant.organizationMembershipVersion || organization.role !== grant.organizationRole || iso(organization.expiresAt) !== iso(grant.organizationExpiresAt)) return deny("LIFECYCLE_ORGANIZATION_CHANGED", "The original organization profile, role or membership changed. Prepare a new decision with current authority.");
  const target = review.input.proposal.target;
  if (target.kind === "project_treasurer") {
    const current = observation.project, original = grant.project;
    if (!current || !original || current.state !== "active" || current.scope !== target.expectedProjectScope || current.role !== "organizer" || current.membershipVersion !== original.membershipVersion || iso(current.expiresAt) !== iso(original.expiresAt)) return deny("LIFECYCLE_PROJECT_CHANGED", "Return to the independently held original project-organizer profile. Organization membership supplies no private project access.");
  }
  const originalLinks = pins(grant.links), currentLinks = pins(observation.links.map(({ state: _state, ...link }) => link));
  if (observation.links.some(link => link.state !== "active") || canonicalJson(originalLinks) !== canonicalJson(currentLinks)) return deny("LIFECYCLE_SOURCE_WITHDRAWN", "An exact project disclosure changed or ended. The original private content is withheld; a newer consent cannot silently replace it.");
  if (mode === "read") return { allowed: true, code: null, reason: null };
  if (observation.runtimeHeld) return deny("WORKSPACE_MAINTENANCE", "Draft preparation is paused by the current execution hold. The original occurrence and source remain saved.");
  if (observation.scheduleState === "paused") return deny("LIFECYCLE_SCHEDULE_PAUSED", "The schedule is paused. Due slots are recorded as skipped, without capturing replacement facts.");
  if (observation.scheduleState === "disabled") return deny("LIFECYCLE_SCHEDULE_DISABLED", "This definition is disabled. Enabling a new schedule requires another explicit review.");
  if (observation.scheduleState !== "enabled") return deny("LIFECYCLE_AUTHORITY_ENDED", "This schedule needs a new current authority and disclosure review.");
  if (observation.program.state !== "enabled" || observation.program.version !== grant.programVersion || !observation.program.expiresAt || iso(observation.program.expiresAt) !== iso(grant.programExpiresAt)) return deny("LIFECYCLE_PROGRAM_DISABLED", "The original organization opt-in ended or was replaced. Prepare a new schedule; do not revive the old grant.");
  return { allowed: true, code: null, reason: null };
}

export interface LifecycleRecovery {
  occurrenceKey: string; requestedOccurrenceKey: string; savedSnapshotHash: string | null; requestedSnapshotHash: string | null;
  state: C.LifecycleOccurrence["state"]; knownModelResponse: boolean; modelDispatched: boolean;
  authorizationExpiresAt: string; observedAt: string; nextRetryAt: string | null;
}
export function lifecycleRetryAllowed(input: LifecycleRecovery): LifecyclePermission {
  const deny = (code: C.LifecycleProblem["code"], reason: string): LifecyclePermission => ({ allowed: false, code, reason });
  if (Date.parse(iso(input.observedAt)) >= Date.parse(iso(input.authorizationExpiresAt))) return deny("LIFECYCLE_EXPIRED", "The original occurrence deadline ended; its source and attempt history remain unchanged.");
  if (input.occurrenceKey !== input.requestedOccurrenceKey) return deny("LIFECYCLE_OCCURRENCE_CHANGED", "Retry the exact original occurrence, not another due slot or definition.");
  if (!["retry_wait", "failed"].includes(input.state)) return deny("LIFECYCLE_RETRY_NOT_ALLOWED", "This original slot is not retryable. A ready or skipped occurrence cannot become a second draft.");
  if (input.savedSnapshotHash !== input.requestedSnapshotHash) return deny("LIFECYCLE_OCCURRENCE_CHANGED", "Retry must retain the exact original saved source snapshot.");
  if (input.nextRetryAt && Date.parse(iso(input.observedAt)) < Date.parse(iso(input.nextRetryAt))) return deny("LIFECYCLE_BUSY", "The saved occurrence has a recorded retry time. Keep this same request and check it then.");
  if (input.modelDispatched && !input.knownModelResponse) return deny("LIFECYCLE_MODEL_IDENTITY_UNKNOWN", "The optional model dispatch has an uncertain response identity. It cannot be automatically resubmitted; the deterministic private draft remains available.");
  return { allowed: true, code: null, reason: null };
}
