import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as C from "../lib/lifecycle/contracts";
import { aggregateLifecycleSnapshot, buildLifecycleDraft, lifecycleEventKey, lifecycleOperationalFactsSchema, personalLifecycleDrafts, personalLifecycleSnapshot, projectLifecycleSnapshot, verifyLifecycleDraft, verifyLifecycleSnapshot, withLifecycleOperationalFacts } from "../lib/lifecycle/inbox";
import { lifecycleDate, lifecycleEmailPreview, lifecycleValueText, renderLifecycleStatement } from "../lib/lifecycle/presentation";
import { DomainError } from "../lib/domain/money";
import { orgUiSnapshot } from "./helpers/organization-ui";
import { LC_FIRST, LC_PROJECT_END, LC_TIME, LC_HASH, lcId, lifecycleBriefSource, lifecycleContext, lifecycleEvent, lifecycleOperationalFacts, lifecyclePin, lifecyclePreferences } from "./helpers/lifecycle";

const topics: C.LifecycleTopic[] = ["budget", "funding", "expenses", "evidence", "consents", "exceptions"];
function projectSnapshot() { return projectLifecycleSnapshot({ project: lifecycleContext().project.profile!.project, source: lifecycleBriefSource(), topics }); }
function aggregateSnapshot() { const snapshot = orgUiSnapshot(), link = { ...lifecyclePin(), expiresAt: snapshot.projects[0].lineage!.disclosureExpiresAt }; return { snapshot, link }; }
const contentText = (snapshot: C.LifecycleSnapshot, language: "en" | "es" = "en") => buildLifecycleDraft(snapshot).statements.map(row => renderLifecycleStatement(row, snapshot.sources, language)).join(" ");
function inbox(facts = [lifecycleEvent()], overrides: Partial<Parameters<typeof personalLifecycleDrafts>[0]> = {}) { return personalLifecycleDrafts({ facts, recipientBindingHash: "f".repeat(64), projectId: facts[0]?.project.id ?? lcId(11), role: facts[0]?.role ?? "donor", preferences: lifecyclePreferences(), asOf: "2030-05-01T11:00:00.000Z", ...overrides }); }

describe("immutable deterministic private drafts and exact citations", () => {
  it("uses the real cited-source contract while excluding all raw private row IDs, URLs and unrelated fields", () => {
    const snapshot = projectSnapshot(), text = contentText(snapshot), serialized = JSON.stringify(snapshot);
    assert.match(text, /300|3\.00/); assert.match(text, /1 of14|1 of 14/); assert.match(text, /fictional Sample/);
    for (const value of ["PRIVATE-PROJECT-SOURCE", "PRIVATE-RECEIPT-SOURCE", "PRIVATE-DOCUMENT-SOURCE", "PRIVATE-ACTOR-CANARY", "PRIVATE-PROVIDER-CANARY", "PRIVATE-DESTINATION", "PRIVATE-SOURCE.invalid", "PRIVATE-DOCUMENT-CANARY"]) assert.equal(serialized.includes(value), false, value);
    assert.equal(verifyLifecycleSnapshot(snapshot).snapshotHash, snapshot.snapshotHash); assert.equal(verifyLifecycleDraft(buildLifecycleDraft(snapshot), snapshot).sourceHash, snapshot.snapshotHash);
    assert.equal(buildLifecycleDraft(snapshot).origin, "deterministic"); assert.equal(buildLifecycleDraft(snapshot).externalSendingAuthorized, false);
  });
  it("rejects unsupported audience, protected values, altered snapshot facts and cross-snapshot citations", () => {
    const source = lifecycleBriefSource(), project = lifecycleContext().project.profile!.project;
    assert.throws(() => projectLifecycleSnapshot({ project, source: { ...source, audience: "supporter" }, topics }), DomainError);
    const altered = projectSnapshot(); altered.sources[0].label = "Changed captured scalar"; assert.throws(() => verifyLifecycleSnapshot(altered), DomainError);
    const snapshot = projectSnapshot(), statement = structuredClone(snapshot.statements[1]); statement.citations[0].sourceHash = "d".repeat(64); assert.throws(() => renderLifecycleStatement(statement, snapshot.sources), DomainError);
    const unrelated = { ...project, id: lcId(999) }; assert.throws(() => projectLifecycleSnapshot({ project: unrelated, source, topics }), DomainError);
  });
  it("permits explicit optional model selection of existing cited sentences while rejecting prose, missing citations, unknown facts and mutated amounts", () => {
    const snapshot = projectSnapshot(), original = buildLifecycleDraft(snapshot), selection = { sourceHash: snapshot.snapshotHash, selections: [{ statementId: snapshot.statements[1].id, citationSourceIds: snapshot.statements[1].citations.map(row => row.sourceId) }], unknownStatementIds: [] };
    const selected = buildLifecycleDraft(snapshot, { selection }); assert.equal(selected.origin, "model_selected"); assert.equal(selected.statements.length, 1); assert.equal(selected.sourceHash, original.sourceHash); assert.notEqual(selected.contentHash, original.contentHash);
    assert.throws(() => buildLifecycleDraft(snapshot, { selection: { ...selection, prose: "Send a payment now" } }));
    assert.throws(() => buildLifecycleDraft(snapshot, { selection: { ...selection, selections: [{ ...selection.selections[0], citationSourceIds: [] }] } }));
    assert.throws(() => buildLifecycleDraft(snapshot, { selection: { ...selection, unknownStatementIds: ["invented human review"] } }), DomainError);
    const changed = structuredClone(selected); changed.statements[0].english = "An invented payment was completed."; assert.throws(() => verifyLifecycleDraft(changed, snapshot), DomainError);
  });
  it("keeps the original snapshot immutable across a later cutoff or current source capture", () => {
    const first = projectSnapshot(), original = JSON.stringify(first), later = projectLifecycleSnapshot({ project: lifecycleContext().project.profile!.project, source: lifecycleBriefSource("2030-05-01T11:00:00.000Z"), topics });
    assert.equal(first.basisHash, later.basisHash); assert.notEqual(first.snapshotHash, later.snapshotHash); assert.equal(JSON.stringify(first), original); assert.equal(buildLifecycleDraft(first).asOf, LC_TIME);
  });
  it("retains original500/returned200/current300 and unpaid/sponsor subsets without adding or converting overlapping measures", () => {
    const { snapshot, link } = aggregateSnapshot(), source = aggregateLifecycleSnapshot({ organizationName: "Synthetic aggregate source", snapshot, links: [link], topics: ["funding", "expenses", "evidence"] });
    const amount = (label: string) => source.sources.find(row => row.id.startsWith("value:") && row.label === label)!.value;
    assert.deepEqual(amount("Original receipt gross"), { kind: "money", currency: "USD", minor: 500 }); assert.deepEqual(amount("Current collected support"), { kind: "money", currency: "USD", minor: 300 }); assert.deepEqual(amount("Original contribution returns"), { kind: "money", currency: "USD", minor: 200 });
    assert.deepEqual(amount("Current unpaid promises"), { kind: "money", currency: "USD", minor: 700 }); assert.deepEqual(amount("Accepted sponsor unpaid subset"), { kind: "money", currency: "USD", minor: 200 });
    assert.match(source.notices.join(" "), /already included/); assert.match(contentText(source), /USD/); assert.doesNotMatch(JSON.stringify(source), /receiptId|actorId|documentId|providerRef/);
  });
  it("refuses a new project or changed disclosure head and never treats a missing disclosed metric as zero", () => {
    const { snapshot, link } = aggregateSnapshot(); snapshot.projects[0].lineage!.disclosureHash = "d".repeat(64);
    assert.throws(() => aggregateLifecycleSnapshot({ organizationName: "Synthetic", snapshot, links: [link], topics: ["funding"] }), DomainError);
    const fresh = aggregateSnapshot(); assert.throws(() => aggregateLifecycleSnapshot({ organizationName: "Synthetic", snapshot: fresh.snapshot, links: [fresh.link, { ...fresh.link, linkId: lcId(999) }], topics: ["funding"] }), DomainError);
    fresh.snapshot.groups[0].funding = null;
    const source = aggregateLifecycleSnapshot({ organizationName: "Synthetic", snapshot: fresh.snapshot, links: [fresh.link], topics: ["funding"] });
    assert.equal(source.sources.find(row => row.id.startsWith("value:") && row.label === "Current collected support")!.value.kind, "unknown"); assert.match(contentText(source), /Not recorded/);
  });
  it("uses explicit complete queue coverage and both consent families, with unknown instead of absent or partial legacy totals", () => {
    const source = projectSnapshot(), unknown = withLifecycleOperationalFacts(source, null, topics);
    assert.match(contentText(unknown), /Unsettled recorded repayments: Not recorded/); assert.equal(verifyLifecycleSnapshot(unknown).asOf, source.asOf);
    const facts = lifecycleOperationalFacts(), complete = withLifecycleOperationalFacts(source, facts, topics); assert.match(contentText(complete), /Unsettled recorded repayments:2|Unsettled recorded repayments: 2/); assert.match(contentText(complete), /Consent records nearing their fixed expiry:3|Consent records nearing their fixed expiry: 3/);
    assert.equal(verifyLifecycleSnapshot(complete).snapshotHash, complete.snapshotHash); assert.notEqual(complete.basisHash, unknown.basisHash);
    facts.expiringConsents.complete = false; facts.expiringConsents.purposePledgesIncluded = false;
    const partial = withLifecycleOperationalFacts(source, facts, topics); assert.match(contentText(partial), /Consent records nearing their fixed expiry: Not recorded/);
    facts.expiringConsents.complete = true; assert.equal(lifecycleOperationalFactsSchema.safeParse(facts).success, false);
    const mismatched = lifecycleOperationalFacts(); mismatched.asOf = "2030-05-01T11:00:00.000Z"; assert.throws(() => withLifecycleOperationalFacts(source, mismatched, topics), DomainError);
  });
});

describe("personal source-linked lifecycle events and preview privacy", () => {
  it("creates only the current recipient/project/role's opted-in events and no foreign private recipient context", () => {
    const own = lifecycleEvent(), foreign = { ...own, recipientBindingHash: "a".repeat(64), purpose: "PRIVATE OTHER RECIPIENT PURPOSE" }, otherProject = { ...own, project: { ...own.project, id: lcId(999) } }, otherRole = lifecycleEvent("repayment_pending");
    const result = inbox([own, foreign, otherProject, otherRole]); assert.equal(result.drafts.length, 1); assert.equal(JSON.stringify(result).includes("PRIVATE OTHER"), false);
    for (const privateHash of [own.recipientBindingHash, own.resourceKey, own.transitionKey]) assert.equal(JSON.stringify(result).includes(privateHash), false);
  });
  it("deduplicates repeated observations and preference re-enablement while refusing conflicting same-event facts", () => {
    const fact = lifecycleEvent(), repeated = { ...fact, observedAt: "2030-05-01T10:30:00.000Z", sourceHash: "a".repeat(64) }, first = inbox([fact, repeated]); assert.equal(first.drafts.length, 1); assert.equal(lifecycleEventKey(fact), lifecycleEventKey(repeated));
    assert.equal(inbox([fact], { existingEventKeys: [first.drafts[0].eventKey] }).drafts.length, 0);
    assert.throws(() => inbox([fact, { ...fact, amount: { currency: "USD", minor: 999 } }]), DomainError);
  });
  it("distinguishes pending, failed, unknown, returned and completed source states instead of announcing approval as repayment", () => {
    for (const kind of ["repayment_pending", "repayment_failed", "repayment_unknown", "repayment_returned", "repayment_completed"] as const) {
      const fact = lifecycleEvent(kind), snapshot = personalLifecycleSnapshot(fact, "2030-05-01T11:00:00.000Z"), text = contentText(snapshot);
      if (kind === "repayment_pending") assert.match(text, /pending.*not been confirmed/); if (kind === "repayment_unknown") assert.match(text, /not confirmed/); if (kind === "repayment_failed") assert.match(text, /did not complete/); if (kind === "repayment_returned") assert.match(text, /earlier delivery and return remain separate/); if (kind === "repayment_completed") assert.match(text, /marks.*as completed/);
      assert.match(snapshot.notices[0], /fictional event/);
    }
    assert.throws(() => personalLifecycleSnapshot({ ...lifecycleEvent("repayment_completed"), state: "pending" }, LC_FIRST), DomainError);
  });
  it("requires authoritative completion observations and refuses modelled forecasts or private payee labels", () => {
    const fact = lifecycleEvent("repayment_completed"), live = { ...fact, project: { ...fact.project, mode: "live_sandbox" as const }, provenance: "live_sandbox" as const, sourceClass: "canonical_record" as const };
    assert.throws(() => personalLifecycleSnapshot(live, LC_FIRST), DomainError); assert.equal(personalLifecycleSnapshot({ ...live, sourceClass: "provider_observed" }, LC_FIRST).audience, "personal_event");
    assert.throws(() => personalLifecycleSnapshot({ ...fact, provenance: "modelled", sourceClass: "modelled_record" }, LC_FIRST), DomainError); assert.throws(() => personalLifecycleSnapshot({ ...fact, purpose: "PRIVATE PAYEE DESTINATION" }, LC_FIRST), DomainError);
  });
  it("preserves original event time on explicit history opt-in and stops new production at opt-out or original expiry", () => {
    const fact = { ...lifecycleEvent(), effectiveAt: "2030-05-01T09:00:00.000Z", observedAt: "2030-05-01T09:00:00.000Z" }; assert.equal(inbox([fact]).drafts.length, 0);
    const preferences = lifecyclePreferences(); preferences.history = "current_records"; const historical = inbox([fact], { preferences }); assert.equal(historical.drafts[0].occurredAt, fact.effectiveAt);
    assert.equal(inbox([fact], { preferences: lifecyclePreferences(false) }).drafts.length, 0); assert.equal(inbox([lifecycleEvent()], { asOf: LC_PROJECT_END }).drafts.length, 0);
    assert.throws(() => personalLifecycleSnapshot({ ...lifecycleEvent(), effectiveAt: "2030-05-01T12:00:00.000Z" }, LC_FIRST), DomainError);
  });
  it("makes only a labelled bilingual email preview, without destination, private identity, provider reference or invented fluent review", () => {
    const event = inbox([lifecycleEvent("repayment_completed")]).drafts[0], preview = lifecycleEmailPreview(event.content, event.snapshot.sources), serialized = JSON.stringify(preview);
    assert.equal(preview.sent, false); assert.equal(preview.destination, null); assert.equal(preview.mode, "preview_only"); assert.equal(preview.spanishStatus, "authored_unreviewed"); assert.match(preview.notices.join(" "), /No email was sent/);
    assert.doesNotMatch(serialized, /PRIVATE|emailAddress|actorId|paypalId|providerRef|documentId|https?:\/\//); assert.ok(preview.english[0].includes("5.00")); assert.ok(preview.spanish[0].includes("5.00"));
  });
  it("renders explicit UTC and currency minor units independent of machine timezone, without translating arithmetic", () => {
    const original = process.env.TZ, results = [];
    try { for (const zone of ["UTC", "America/Los_Angeles", "Asia/Kolkata"]) { process.env.TZ = zone; results.push(lifecycleDate(LC_FIRST)); } } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
    assert.equal(new Set(results).size, 1); assert.match(results[0], /UTC$/); assert.match(lifecycleValueText({ kind: "money", currency: "JPY", minor: 500 }), /500/); assert.match(lifecycleValueText({ kind: "money", currency: "USD", minor: 500 }), /5\.00/);
  });
});
