import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DomainError } from "../lib/domain/money";
import * as C from "../lib/lifecycle/contracts";
import { dueLifecycleSlots, lifecycleDefinitionHash, lifecycleFixedDeadline, lifecycleOccurrenceKey, lifecyclePermission, lifecycleRetryAllowed, type LifecycleDueInput, type LifecycleRecovery } from "../lib/lifecycle/schedule";
import { LC_FIRST, LC_LINK_END, LC_ORG_END, LC_PROGRAM_END, LC_PROJECT_END, LC_TIME, LC_HASH, lcId, lifecycleContext, lifecycleDesk, lifecycleOccurrenceDetail, lifecycleObservation, lifecyclePin, lifecyclePrepare, lifecycleReview, lifecycleSchedule } from "./helpers/lifecycle";

const dueInput = (): LifecycleDueInput => ({ scheduleId: lcId(501), definitionVersion: 1, cadence: { intervalMinutes: 15, timeZone: "UTC", firstDueAt: LC_FIRST }, expiresAt: LC_PROJECT_END, afterDueAt: null, observedAt: "2030-05-01T11:10:00.000Z", pauses: [], disabledAt: null });
const recovery = (): LifecycleRecovery => ({ occurrenceKey: LC_HASH, requestedOccurrenceKey: LC_HASH, state: "retry_wait", savedSnapshotHash: "d".repeat(64), requestedSnapshotHash: "d".repeat(64), knownModelResponse: false, modelDispatched: false, authorizationExpiresAt: LC_PROJECT_END, observedAt: "2030-05-01T11:00:00.000Z", nextRetryAt: null });

describe("durable private draft schedule semantics", () => {
  it("assigns one immutable due identity across time formatting, retries and unchanged definition data", () => {
    const first = lifecycleOccurrenceKey(lcId(501), 1, LC_FIRST), equivalent = lifecycleOccurrenceKey(lcId(501), 1, "2030-05-01T10:15:00Z");
    assert.equal(first, equivalent); assert.notEqual(first, lifecycleOccurrenceKey(lcId(501), 2, LC_FIRST)); assert.notEqual(first, lifecycleOccurrenceKey(lcId(502), 1, LC_FIRST)); assert.notEqual(first, lifecycleOccurrenceKey(lcId(501), 1, "2030-05-01T10:30:00.000Z"));
  });
  it("keeps the original UTC cadence after a late worker and resumes a bounded cursor without duplicating or silently dropping slots", () => {
    const input = { ...dueInput(), limit: 2 }, first = dueLifecycleSlots(input);
    assert.deepEqual(first.slots.map(slot => slot.dueAt), ["2030-05-01T10:15:00.000Z", "2030-05-01T10:30:00.000Z"]); assert.equal(first.hasMore, true);
    const second = dueLifecycleSlots({ ...input, afterDueAt: first.cursor }); assert.deepEqual(second.slots.map(slot => slot.dueAt), ["2030-05-01T10:45:00.000Z", "2030-05-01T11:00:00.000Z"]); assert.equal(second.hasMore, false); assert.equal(second.nextDueAt, "2030-05-01T11:15:00.000Z");
    const all = [...first.slots, ...second.slots]; assert.equal(new Set(all.map(slot => slot.occurrenceKey)).size, 4);
    assert.throws(() => dueLifecycleSlots({ ...input, afterDueAt: "2030-05-01T10:31:00.000Z" }), DomainError);
  });
  it("records every paused slot as skipped, with an exclusive resume boundary and no later catch-up capture", () => {
    const input = { ...dueInput(), pauses: [{ pausedAt: "2030-05-01T10:30:00.000Z", resumedAt: "2030-05-01T11:00:00.000Z" }] }, slots = dueLifecycleSlots(input);
    assert.deepEqual(slots.slots.map(slot => [slot.dueAt, slot.state]), [["2030-05-01T10:15:00.000Z", "due"], ["2030-05-01T10:30:00.000Z", "skipped_paused"], ["2030-05-01T10:45:00.000Z", "skipped_paused"], ["2030-05-01T11:00:00.000Z", "due"]]);
    assert.deepEqual(dueLifecycleSlots({ ...input, afterDueAt: slots.cursor, observedAt: "2030-05-01T11:16:00.000Z" }).slots.map(slot => slot.dueAt), ["2030-05-01T11:15:00.000Z"]);
    const ongoing = dueLifecycleSlots({ ...input, pauses: [{ pausedAt: LC_FIRST, resumedAt: null }] }); assert.ok(ongoing.slots.every(slot => slot.state === "skipped_paused"));
  });
  it("never captures an expired original slot using new facts, and stops producing slots at the original deadline", () => {
    const result = dueLifecycleSlots({ ...dueInput(), expiresAt: "2030-05-01T11:00:00.000Z", observedAt: "2030-05-01T12:00:00.000Z" });
    assert.deepEqual(result.slots.map(slot => slot.state), ["expired", "expired", "expired"]); assert.equal(result.slots.at(-1)!.dueAt, "2030-05-01T10:45:00.000Z"); assert.equal(result.nextDueAt, null);
    assert.ok(dueLifecycleSlots({ ...dueInput(), disabledAt: "2030-05-01T10:30:00.000Z" }).slots.slice(1).every(slot => slot.state === "cancelled"));
  });
  it("does not recreate daily/weekly occurrence times from a browser timezone or daylight-saving offset", () => {
    const cadence = { intervalMinutes: 1440 as const, timeZone: "UTC" as const, firstDueAt: "2030-03-09T15:00:00.000Z" };
    const slots = dueLifecycleSlots({ ...dueInput(), cadence, expiresAt: "2030-03-13T15:00:00.000Z", observedAt: "2030-03-12T15:01:00.000Z" });
    assert.deepEqual(slots.slots.map(slot => slot.dueAt), ["2030-03-09T15:00:00.000Z", "2030-03-10T15:00:00.000Z", "2030-03-11T15:00:00.000Z", "2030-03-12T15:00:00.000Z"]);
    assert.equal(C.lifecycleCadenceSchema.safeParse({ ...cadence, timeZone: "America/New_York" }).success, false);
  });
  it("takes the exact original minimum deadline and hashes semantic set selections without hiding an actual source/consent change", () => {
    assert.equal(lifecycleFixedDeadline({ requestedExpiresAt: LC_ORG_END, organizationExpiresAt: LC_ORG_END, programExpiresAt: LC_PROGRAM_END, projectExpiresAt: LC_PROJECT_END, links: [lifecyclePin()] }), LC_PROJECT_END);
    assert.equal(lifecycleFixedDeadline({ requestedExpiresAt: LC_ORG_END, organizationExpiresAt: LC_ORG_END, programExpiresAt: LC_PROGRAM_END, projectExpiresAt: null, links: [lifecyclePin()] }), LC_LINK_END);
    const first = lifecyclePrepare("organization_aggregate").proposal, reverse = structuredClone(first); reverse.topics.reverse(); if (reverse.target.kind === "organization_aggregate") reverse.target.links[0].disclosure.reverse();
    assert.equal(lifecycleDefinitionHash(first), lifecycleDefinitionHash(reverse)); if (reverse.target.kind === "organization_aggregate") reverse.target.links[0].consentRevision++;
    assert.notEqual(lifecycleDefinitionHash(first), lifecycleDefinitionHash(reverse));
  });
});

describe("fixed independent delegated authority and same-occurrence recovery", () => {
  it("requires the exact original project organizer for private facts while aggregate-only operations ignore independent project switches", () => {
    assert.equal(lifecyclePermission(lifecycleReview(), lifecycleObservation()).allowed, true);
    const project = lifecycleObservation(); project.project!.scope = "e".repeat(64); assert.equal(lifecyclePermission(lifecycleReview(), project).code, "LIFECYCLE_PROJECT_CHANGED");
    const aggregate = lifecycleObservation("organization_aggregate"); aggregate.project = project.project; assert.equal(lifecyclePermission(lifecycleReview("organization_aggregate"), aggregate).allowed, true);
  });
  it("rejects changed org actor scope, role/version, source consent and newly linked project inclusion", () => {
    const mutations: ((value: ReturnType<typeof lifecycleObservation>) => void)[] = [value => { value.organization.scope = "e".repeat(64); }, value => { value.organization.membershipVersion++; }, value => { value.organization.role = "coordinator"; }, value => { value.organization.expiresAt = "2030-05-03T18:00:00.000Z"; }];
    for (const mutate of mutations) {
      const current = lifecycleObservation(); mutate(current); assert.equal(lifecyclePermission(lifecycleReview(), current).code, "LIFECYCLE_ORGANIZATION_CHANGED");
    }
    const source = lifecycleObservation(); source.links[0].consentRevision++; assert.equal(lifecyclePermission(lifecycleReview(), source).code, "LIFECYCLE_SOURCE_WITHDRAWN");
    const extra = lifecycleObservation(); extra.links.push({ ...extra.links[0], linkId: lcId(900) }); assert.equal(lifecyclePermission(lifecycleReview(), extra).code, "LIFECYCLE_SOURCE_WITHDRAWN");
  });
  it("stops new production on pause, disable, maintenance or replacement program without erasing permitted prior private drafts", () => {
    for (const [state, code] of [["paused", "LIFECYCLE_SCHEDULE_PAUSED"], ["disabled", "LIFECYCLE_SCHEDULE_DISABLED"]] as const) {
      const current = lifecycleObservation(); current.scheduleState = state; assert.equal(lifecyclePermission(lifecycleReview(), current).code, code); assert.equal(lifecyclePermission(lifecycleReview(), current, "read").allowed, true);
    }
    const held = lifecycleObservation(); held.runtimeHeld = true; assert.equal(lifecyclePermission(lifecycleReview(), held).code, "WORKSPACE_MAINTENANCE");
    const program = lifecycleObservation(); program.program.version++; assert.equal(lifecyclePermission(lifecycleReview(), program).code, "LIFECYCLE_PROGRAM_DISABLED"); assert.equal(lifecyclePermission(lifecycleReview(), program, "read").allowed, true);
  });
  it("never renews access at the exact original deadline, even for known source and response recovery", () => {
    const current = lifecycleObservation(); current.observedAt = LC_PROJECT_END;
    assert.equal(lifecyclePermission(lifecycleReview(), current).code, "LIFECYCLE_EXPIRED"); assert.equal(lifecyclePermission(lifecycleReview(), current, "read").code, "LIFECYCLE_EXPIRED");
    assert.equal(lifecycleRetryAllowed({ ...recovery(), observedAt: LC_PROJECT_END, knownModelResponse: true, modelDispatched: true }).code, "LIFECYCLE_EXPIRED");
  });
  it("retains the exact occurrence and snapshot for retry and never resubmits an unknown optional model response", () => {
    assert.equal(lifecycleRetryAllowed(recovery()).allowed, true);
    assert.equal(lifecycleRetryAllowed({ ...recovery(), requestedOccurrenceKey: "e".repeat(64) }).code, "LIFECYCLE_OCCURRENCE_CHANGED"); assert.equal(lifecycleRetryAllowed({ ...recovery(), requestedSnapshotHash: "e".repeat(64) }).code, "LIFECYCLE_OCCURRENCE_CHANGED");
    assert.equal(lifecycleRetryAllowed({ ...recovery(), modelDispatched: true }).code, "LIFECYCLE_MODEL_IDENTITY_UNKNOWN"); assert.equal(lifecycleRetryAllowed({ ...recovery(), modelDispatched: true, knownModelResponse: true }).allowed, true);
    assert.equal(lifecycleRetryAllowed({ ...recovery(), state: "skipped_paused" }).code, "LIFECYCLE_RETRY_NOT_ALLOWED"); assert.equal(lifecycleRetryAllowed({ ...recovery(), state: "ready" }).code, "LIFECYCLE_RETRY_NOT_ALLOWED");
    assert.equal(lifecycleRetryAllowed({ ...recovery(), nextRetryAt: "2030-05-01T11:01:00.000Z" }).code, "LIFECYCLE_BUSY");
  });
});

describe("lifecycle strict reviewed DTO boundaries", () => {
  it("withholds a private project definition from the organization-only desk while retaining an independently authorized detail contract", () => {
    const definition = lifecycleSchedule(); assert.equal(C.lifecycleScheduleSchema.safeParse(definition).success, true);
    assert.equal(C.lifecycleScheduleDeskSchema.safeParse({ ...lifecycleDesk(), schedules: [definition] }).success, false);
  });
  it("rejects private project occurrence facts and source hashes in an organization-only history page", () => {
    const detail = lifecycleOccurrenceDetail(); assert.equal(C.lifecycleOccurrenceDetailSchema.safeParse(detail).success, true);
    assert.equal(C.lifecycleOccurrencePageSchema.safeParse({ scope: detail.scope, checkedAt: detail.checkedAt, occurrences: [detail.occurrence], nextCursor: null }).success, false);
    const earlier = structuredClone(detail); earlier.occurrence.capturedAt = LC_TIME; assert.equal(C.lifecycleOccurrenceDetailSchema.safeParse(earlier).success, false);
  });
  it("rejects added disclosure pins, a widened deadline and private topics inside an aggregate-only review", () => {
    const review = lifecycleReview("organization_aggregate"), extended = structuredClone(review); extended.authorization.links.push({ ...lifecyclePin(), linkId: lcId(900) }); assert.equal(C.lifecycleScheduleReviewSchema.safeParse(extended).success, false);
    const longer = structuredClone(review); longer.authorization.expiresAt = LC_ORG_END; assert.equal(C.lifecycleScheduleReviewSchema.safeParse(longer).success, false);
    const privateTopic = structuredClone(review.input.proposal); privateTopic.topics.push("consents"); assert.equal(C.lifecycleScheduleProposalSchema.safeParse(privateTopic).success, false);
    assert.equal(C.lifecycleScheduleProposalSchema.safeParse({ ...review.input.proposal, email: "PRIVATE@example.invalid" }).success, false);
  });
  it("omits private profile details and all controls after a context ends, without treating an auditor as a scheduling writer", () => {
    const ended = lifecycleContext(); ended.project.state = "ended"; assert.equal(C.lifecycleContextSchema.safeParse(ended).success, false);
    ended.project.profile = null; ended.project.canReadInbox = false; ended.project.canChangePreferences = false; ended.project.canPrepareTreasurer = false; assert.equal(C.lifecycleContextSchema.safeParse(ended).success, true);
    const auditor = lifecycleContext("auditor", "auditor"); assert.equal(auditor.canManageProgram, false); auditor.canManageProgram = true; assert.equal(C.lifecycleContextSchema.safeParse(auditor).success, false);
  });
  it("refuses a partially leaked withdrawn inbox summary and any real-send or recipient-address preview", () => {
    const hidden = { id: lcId(600), version: 1, readState: "unread", status: "withdrawn", kind: null, title: null, occurredAt: null, recordedAt: LC_TIME, provenance: null, contentHash: null, canRead: false, canArchive: true, canRestore: false, reasons: ["Original source withdrawn"] };
    assert.equal(C.lifecycleInboxItemSchema.safeParse(hidden).success, true); assert.equal(C.lifecycleInboxItemSchema.safeParse({ ...hidden, title: "PRIVATE RECIPIENT CANARY" }).success, false);
    const preview = { mode: "preview_only", sent: false, subject: "Controlled preview", english: ["Controlled private factual preview"], spanish: ["Vista previa de hechos"], sourceHash: LC_HASH, spanishStatus: "authored_unreviewed", destination: null, notices: [] };
    assert.equal(C.lifecycleEmailPreviewSchema.safeParse(preview).success, true); assert.equal(C.lifecycleEmailPreviewSchema.safeParse({ ...preview, sent: true }).success, false); assert.equal(C.lifecycleEmailPreviewSchema.safeParse({ ...preview, destination: "PRIVATE@example.invalid" }).success, false);
  });
});
