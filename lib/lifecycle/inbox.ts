import { canonicalJson, sha256 } from "@fracture/paypal-core";
import { z } from "zod";
import { COMMUNITY_CONTRACT, type BriefSource, type BriefValue } from "../community/contracts";
import { assertStatementSources } from "../community/content";
import { DomainError } from "../domain/money";
import { orgPortfolioSnapshotSchema, orgProjectSummarySchema, type OrgPortfolioSnapshot } from "../organizations/contracts";
import * as C from "./contracts";
import { lifecycleEmailPreview, lifecycleEventLabels, renderLifecycleStatement } from "./presentation";

const hash = (value: unknown) => sha256(canonicalJson(value));
const fail = (message: string): never => { throw new DomainError("LIFECYCLE_SOURCE_CHANGED", message, 422); };
const topicFor = { project: "budget", funding: "funding", evidence: "evidence", repayment: "expenses", consent: "consents", exception: "exceptions" } as const;
const projectSlots = new Set(["project_name", "project_budget", "recorded_pledges", "collected", "receipt_count", "identity_count", "eligible", "refund_reserve", "test_checkout", "package_name", "package_collected", "package_budget", "accepted_reviews", "required_reviews", "recovery_deadline", "claim_requested", "claim_reviewed", "repayment_principal", "fee_allowance", "dispatch_count", "ended_approvals", "consent_count", "current_consents"]);
function briefValue(value: BriefValue): C.LifecycleValue {
  if (!projectSlots.has(value.key)) fail("This protected field is outside the private digest's allowed scalar source contract.");
  if (value.kind === "money") return C.lifecycleValueSchema.parse({ kind: "money", currency: "USD", minor: value.value });
  if (value.kind === "count") return C.lifecycleValueSchema.parse({ kind: "count", count: value.value });
  if (value.kind === "date") return C.lifecycleValueSchema.parse({ kind: "date", value: value.value });
  if (!["project_name", "package_name"].includes(value.key)) fail("Only the reviewed project and purpose labels can appear as text source values.");
  return C.lifecycleValueSchema.parse({ kind: "label", value: value.value, spanish: value.displayEs ?? null });
}
function scalar(id: string, label: string, topic: C.LifecycleTopic, value: C.LifecycleValue, provenance: C.LifecycleProvenance, originHash: string, observedAt: string | null = null, limitation: string | null = null): C.LifecycleSourceRow {
  const body = { id, label, topic, value, provenance, observedAt, limitation };
  return C.lifecycleSourceRowSchema.parse({ ...body, contentHash: hash({ contract: C.LIFECYCLE_VERSION, ...body, originHash }) });
}
function finishSnapshot(body: Omit<C.LifecycleSnapshot, "contractVersion" | "snapshotHash">): C.LifecycleSnapshot {
  const { snapshotHash: _previous, ...base } = C.lifecycleSnapshotSchema.parse({ ...body, contractVersion: C.LIFECYCLE_VERSION, snapshotHash: "0".repeat(64) });
  const source = { ...base, sources: [...base.sources].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
  const snapshot = C.lifecycleSnapshotSchema.parse({ ...source, snapshotHash: hash(source) });
  for (const statement of snapshot.statements) { renderLifecycleStatement(statement, snapshot.sources, "en"); renderLifecycleStatement(statement, snapshot.sources, "es"); }
  return snapshot;
}
export function verifyLifecycleSnapshot(raw: C.LifecycleSnapshot): C.LifecycleSnapshot {
  const snapshot = C.lifecycleSnapshotSchema.parse(raw), { snapshotHash, ...body } = snapshot;
  if (hash(body) !== snapshotHash) fail("The original frozen source snapshot no longer matches its saved hash.");
  for (const statement of snapshot.statements) { renderLifecycleStatement(statement, snapshot.sources, "en"); renderLifecycleStatement(statement, snapshot.sources, "es"); }
  return snapshot;
}
/** Consume the existing real treasurer projection, not a fabricated organizer
 * identity or model prose. Its raw row IDs/URLs/extra fields are never copied
 * into the lifecycle scalar snapshot. Keep original bindings encrypted server
 * side when persisting this adapter's result. */
export function projectLifecycleSnapshot(input: { project: z.infer<typeof orgProjectSummarySchema>; source: BriefSource; topics: readonly C.LifecycleTopic[] }): C.LifecycleSnapshot {
  const project = orgProjectSummarySchema.parse(input.project), source = input.source;
  const { capturedAt, contentHash, ...stable } = source;
  if (source.contract !== COMMUNITY_CONTRACT || source.audience !== "treasurer" || source.projectId !== project.id || source.mode !== project.mode || source.templateId !== project.templateId || source.title !== project.title || project.currency !== "USD" || hash(stable) !== contentHash) fail("Use the exact independently authorized current project treasurer source; currency and audience cannot be inferred.");
  assertStatementSources(source);
  const sources: C.LifecycleSourceRow[] = [], statements: C.LifecycleStatement[] = [];
  for (const sentence of source.statements) {
    if (!Object.hasOwn(topicFor, sentence.category)) fail("A private project digest cannot consume a different audience's personal source.");
    const topic = topicFor[sentence.category as keyof typeof topicFor];
    if (!input.topics.includes(topic) && sentence.id !== "project:provenance") continue;
    const originHash = hash(sentence.citations.map(citation => ({ rowId: citation.rowId, rowHash: citation.rowHash })));
    const base = scalar(`s:${hash({ id: sentence.id, originHash })}`, "Captured project fact", topic, { kind: "label", value: "Recorded project source", spanish: "Fuente registrada del proyecto" }, source.mode, originHash);
    sources.push(base);
    const values = sentence.values.map(value => {
      const row = scalar(`v:${hash({ statementId: sentence.id, key: value.key, originHash })}`, value.key.replaceAll("_", " "), topic, briefValue(value), source.mode, originHash); sources.push(row);
      return { key: value.key, sourceId: row.id, sourceHash: row.contentHash };
    });
    statements.push({ id: `p:${hash(sentence.id)}`, topic, english: sentence.english, spanish: sentence.spanish, values, citations: [base, ...values.map(value => sources.find(row => row.id === value.sourceId)!)].map(row => ({ sourceId: row.id, sourceHash: row.contentHash })) });
  }
  if (!statements.length) fail("No supported factual sentences match the reviewed digest topics.");
  return finishSnapshot({ audience: "project_treasurer", asOf: capturedAt, basisHash: source.contentHash, targetLabel: project.title, sources, statements, observedRange: null, notices: [
    source.mode === "sample" ? "Sample source: fictional records establish no actual payment, independent person or physical work." : "Live Sandbox source: payment records use test funds and do not certify physical work.",
    "Every amount and sentence retains its exact original source. A private draft is separate from sending or payment authority.",
    "The snapshot cutoff is not a claim of current provider liquidity or a provider observation-time range.",
    "Spanish wording is authored and has no fluent-language review.",
  ] });
}

type DraftOptions = { title?: string; selection?: unknown };
export const lifecycleModelSelectionSchema = z.object({ sourceHash: z.string().regex(/^[a-f0-9]{64}$/), selections: z.array(z.object({ statementId: z.string().min(1).max(180), citationSourceIds: z.array(z.string().min(1).max(180)).min(1).max(30) }).strict()).min(1).max(1000), unknownStatementIds: z.array(z.string().max(180)).max(1000) }).strict();
export function buildLifecycleDraft(raw: C.LifecycleSnapshot, options: DraftOptions = {}): C.LifecycleContent {
  const snapshot = verifyLifecycleSnapshot(raw); let statements = snapshot.statements;
  if (options.selection !== undefined) {
    const selection = lifecycleModelSelectionSchema.parse(options.selection);
    if (selection.sourceHash !== snapshot.snapshotHash || selection.unknownStatementIds.length || new Set(selection.selections.map(row => row.statementId)).size !== selection.selections.length) fail("Optional model assistance cannot change the source, repeat a sentence or invent an unsupported fact.");
    statements = selection.selections.map(row => {
      const sentence = snapshot.statements.find(statement => statement.id === row.statementId);
      if (!sentence) return fail("A model-selected sentence is outside the exact captured source.");
      if (canonicalJson([...row.citationSourceIds].sort()) !== canonicalJson(sentence.citations.map(citation => citation.sourceId).sort())) fail("Every selected sentence must retain its exact complete captured citations.");
      return structuredClone(sentence);
    });
  }
  const body = { contractVersion: C.LIFECYCLE_VERSION, title: options.title ?? `${snapshot.targetLabel.slice(0, 90)} · private draft`, sourceHash: snapshot.snapshotHash, asOf: snapshot.asOf, origin: options.selection === undefined ? "deterministic" as const : "model_selected" as const, statements: structuredClone(statements), delivery: "private_in_app" as const, externalSendingAuthorized: false as const, spanishStatus: "authored_unreviewed" as const, notices: [...snapshot.notices] };
  return C.lifecycleContentSchema.parse({ ...body, contentHash: hash(body) });
}
export function verifyLifecycleDraft(raw: C.LifecycleContent, source: C.LifecycleSnapshot): C.LifecycleContent {
  const snapshot = verifyLifecycleSnapshot(source), content = C.lifecycleContentSchema.parse(raw), { contentHash, ...body } = content;
  if (hash(body) !== contentHash || content.sourceHash !== snapshot.snapshotHash || content.asOf !== snapshot.asOf || content.statements.some(sentence => canonicalJson(sentence) !== canonicalJson(snapshot.statements.find(row => row.id === sentence.id)))) fail("The private draft changed its original source, protected values or immutable content hash.");
  if (content.origin === "deterministic" && canonicalJson(content.statements) !== canonicalJson(snapshot.statements)) fail("A deterministic draft must retain every selected captured factual sentence.");
  return content;
}

const metricLabels = {
  originalGrossMinor: ["Original receipt gross", "Importe bruto de los registros originales"], currentCollectedMinor: ["Current collected support", "Apoyo recaudado actual"], unpaidCommitmentMinor: ["Current unpaid promises", "Compromisos actuales pendientes de pago"], acceptedSponsorUnpaidMinor: ["Accepted sponsor unpaid subset", "Subconjunto pendiente de patrocinadores"], returnedMinor: ["Original contribution returns", "Devoluciones de aportaciones originales"],
  paidMinor: ["Recorded paid uses", "Usos registrados como pagados"], reservedMinor: ["Existing commitments to recorded uses", "Compromisos existentes para usos registrados"], availableMinor: ["Remaining recorded funding position", "Posición de financiación registrada restante"],
  approvedExpenseMinor: ["Reviewed expense principal", "Principal de gastos revisados"], deliveredPrincipalMinor: ["Currently delivered repayment principal", "Principal de reembolsos actualmente entregado"], returnedPrincipalMinor: ["Recipient principal returned after delivery", "Principal devuelto después de la entrega"], undeliveredPrincipalMinor: ["Undelivered principal released before payment", "Principal no entregado liberado antes del pago"], knownPaidFeeMinor: ["Known observed payout fees", "Comisiones de pago observadas conocidas"], reservedFeeMinor: ["Existing fee allowance", "Provisión existente para comisiones"],
} as const;
function addFact(rows: C.LifecycleSourceRow[], statements: C.LifecycleStatement[], input: { key: string; label: string; spanishLabel: string; topic: C.LifecycleTopic; value: C.LifecycleValue; provenance: C.LifecycleProvenance; originHash: string; scope: string; spanishScope?: string }) {
  const context = scalar(`scope:${hash(input.key)}`, "Disclosed scalar scope", input.topic, { kind: "label", value: input.scope.slice(0, 120), spanish: (input.spanishScope ?? input.scope).slice(0, 120) }, input.provenance, input.originHash);
  const label = scalar(`label:${hash(input.key)}`, "Metric definition", input.topic, { kind: "label", value: input.label, spanish: input.spanishLabel }, input.provenance, input.originHash);
  const value = scalar(`value:${hash(input.key)}`, input.label, input.topic, input.value, input.provenance, input.originHash);
  rows.push(context, label, value);
  statements.push({ id: `fact:${hash(input.key)}`, topic: input.topic, english: "{{scope}} · {{metric}}: {{value}}.", spanish: "{{scope}} · {{metric}}: {{value}}.", values: [{ key: "scope", sourceId: context.id, sourceHash: context.contentHash }, { key: "metric", sourceId: label.id, sourceHash: label.contentHash }, { key: "value", sourceId: value.id, sourceHash: value.contentHash }], citations: [context, label, value].map(row => ({ sourceId: row.id, sourceHash: row.contentHash })) });
}
/** Only the strict aggregate DTO is consumed. Exact consent heads bind every
 * selected project; a future-project filter cannot silently widen the draft. */
export function aggregateLifecycleSnapshot(input: { organizationName: string; snapshot: OrgPortfolioSnapshot; links: readonly C.LifecycleConsentPin[]; topics: readonly C.LifecycleTopic[] }): C.LifecycleSnapshot {
  const snapshot = orgPortfolioSnapshotSchema.parse(input.snapshot), expected = [...input.links].sort((a, b) => a.linkId < b.linkId ? -1 : 1);
  if (!expected.length || snapshot.projects.length !== expected.length || snapshot.projects.some(project => {
    const pin = expected.find(row => row.linkId === project.linkId);
    return !pin || !["included", "partial"].includes(project.state) || !project.lineage || project.linkVersion !== pin.linkVersion || project.consentRevision !== pin.consentRevision || project.lineage.disclosureHash !== pin.consentHash || project.lineage.disclosureExpiresAt !== pin.expiresAt || canonicalJson([...project.disclosedSections].sort()) !== canonicalJson([...pin.disclosure].sort());
  })) fail("The aggregate's exact original project consent scope changed. Newly linked or re-reviewed projects cannot silently enter this draft.");
  if (input.topics.some(topic => !["budget", "funding", "expenses", "evidence"].includes(topic))) fail("An organization aggregate draft cannot include private consent, payee or exception records.");
  const rows: C.LifecycleSourceRow[] = [], statements: C.LifecycleStatement[] = [];
  const names = { sample: ["Sample · fictional", "Ejemplo ficticio"], live_sandbox: ["Live · Sandbox", "Activo · entorno de pruebas"], replay: ["Replay · recorded", "Reproducción de registros"], modelled: ["Modelled · scenario", "Escenario modelado"] } as const;
  for (const group of snapshot.groups) {
    const scope = `${group.currency} · ${names[group.provenance][0]}`, spanishScope = `${group.currency} · ${names[group.provenance][1]}`;
    const add = (key: string, label: string, spanishLabel: string, topic: C.LifecycleTopic, value: C.LifecycleValue) => addFact(rows, statements, { key: `${group.currency}:${group.provenance}:${key}`, label, spanishLabel, topic, value, provenance: group.provenance, originHash: snapshot.basisHash, scope, spanishScope });
    if (input.topics.includes("budget")) add("budget", "Disclosed canonical package budget", "Presupuesto canónico de paquetes divulgado", "budget", group.budgetMinor === null ? { kind: "unknown", reason: "No permitted budget amount exists in this disclosed group." } : { kind: "money", currency: group.currency, minor: group.budgetMinor });
    if (input.topics.includes("funding")) for (const key of ["originalGrossMinor", "currentCollectedMinor", "unpaidCommitmentMinor", "acceptedSponsorUnpaidMinor", "returnedMinor", "paidMinor", "reservedMinor", "availableMinor"] as const) {
      const [label, spanishLabel] = metricLabels[key]; add(key, label, spanishLabel, "funding", group.funding ? { kind: "money", currency: group.currency, minor: group.funding[key] } : { kind: "unknown", reason: "The approved funding section is unavailable, not zero." });
    }
    if (input.topics.includes("expenses")) {
      for (const key of ["approvedExpenseMinor", "deliveredPrincipalMinor", "returnedPrincipalMinor", "undeliveredPrincipalMinor", "knownPaidFeeMinor", "reservedFeeMinor"] as const) { const [label, spanishLabel] = metricLabels[key]; add(key, label, spanishLabel, "expenses", group.expenses ? { kind: "money", currency: group.currency, minor: group.expenses[key] } : { kind: "unknown", reason: "The approved expense section is unavailable, not zero." }); }
      add("unobserved_fees", "Fee outcomes awaiting a current observation", "Comisiones pendientes de una observación actual", "expenses", group.expenses ? { kind: "count", count: group.expenses.unobservedFeeCount } : { kind: "unknown", reason: "The expense source is unavailable." });
    }
    if (input.topics.includes("evidence")) for (const [key, label, spanishLabel] of [["acceptedReviewItems", "Accepted review requirements", "Requisitos de revisión aceptados"], ["requiredReviewItems", "Required review requirements", "Requisitos de revisión necesarios"], ["acceptedPackages", "Accepted packages", "Paquetes aceptados"], ["packageCount", "Packages in this evidence scope", "Paquetes en este ámbito de evidencia"]] as const) add(key, label, spanishLabel, "evidence", group.evidence ? { kind: "count", count: group.evidence[key] } : { kind: "unknown", reason: "Current evidence is unavailable; no zero acceptance was substituted." });
    for (const topic of input.topics) {
      const coverage = group.coverage[topic as keyof typeof group.coverage]; if (!coverage) continue;
      add(`coverage_${topic}_included`, `${topic} sections included`, `Secciones de ${{budget:"presupuesto",funding:"financiación",expenses:"gastos",evidence:"evidencia",consents:"consentimientos",exceptions:"excepciones"}[topic]} incluidas`, topic, { kind: "count", count: coverage.includedProjects });
      add(`coverage_${topic}_denominator`, `${topic} sections approved`, `Secciones de ${{budget:"presupuesto",funding:"financiación",expenses:"gastos",evidence:"evidencia",consents:"consentimientos",exceptions:"excepciones"}[topic]} aprobadas`, topic, { kind: "count", count: coverage.denominatorProjects });
      add(`coverage_${topic}_omitted`, `${topic} sections unavailable`, `Secciones de ${{budget:"presupuesto",funding:"financiación",expenses:"gastos",evidence:"evidencia",consents:"consentimientos",exceptions:"excepciones"}[topic]} no disponibles`, topic, { kind: "count", count: coverage.omittedProjects });
    }
  }
  if (!statements.length) fail("Choose an approved aggregate section with a current disclosed source group.");
  return finishSnapshot({ audience: "organization_aggregate", asOf: snapshot.asOf, basisHash: snapshot.basisHash, targetLabel: input.organizationName, sources: rows, statements, observedRange: snapshot.sourceObservedRange, notices: [
    "Only the exact reviewed project disclosures are included. Organization affiliation does not grant private project, document, donor or payment access.",
    "Original receipts, current positions and unpaid promises are different overlapping measures. Accepted sponsor unpaid amounts are already included in total unpaid promises.",
    "Currencies and provenance stay separate. Fees and recipient returns remain distinct from original contribution returns; recorded available funding is not provider liquidity.",
    "Evidence counts use approved weighted denominators, not an average of project percentages. Illustrative-image review does not establish physical acceptance.",
    "The source cutoff is separate from provider observation times. Missing sections remain unavailable, never zero.", "Spanish wording is authored and has no fluent-language review.",
  ] });
}

const queueBasis = z.object({
  state: z.enum(["available", "unavailable"]), count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  scopeLabel: z.string().min(1).max(120), complete: z.boolean(), includedRecords: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(), denominatorRecords: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(), reason: z.string().min(1).max(1000).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.state === "available" && (value.count === null || !value.sourceHash) || value.state === "unavailable" && (value.count !== null || value.complete || !value.reason) || value.complete && (value.includedRecords === null || value.denominatorRecords === null || value.includedRecords !== value.denominatorRecords) || value.includedRecords !== null && value.denominatorRecords !== null && value.includedRecords > value.denominatorRecords) ctx.addIssue({ code: "custom", path: ["count"], message: "An unavailable subset has no invented count. Complete coverage needs the exact recorded subset and denominator, not a broader legacy total." });
});
export const lifecycleOperationalFactsSchema = z.object({
  asOf: z.iso.datetime(), unsettledRepayments: queueBasis, missingEvidence: queueBasis,
  expiringConsents: queueBasis.safeExtend({ withinHours: z.number().int().min(1).max(168), legacyIncluded: z.boolean(), purposePledgesIncluded: z.boolean() }),
  reconciliationExceptions: queueBasis.safeExtend({ providerLag: z.string().max(600).nullable() }),
}).strict().superRefine((value, ctx) => {
  if (value.expiringConsents.complete && (!value.expiringConsents.legacyIncluded || !value.expiringConsents.purposePledgesIncluded)) ctx.addIssue({ code: "custom", path: ["expiringConsents", "complete"], message: "A complete expiry queue includes both original collection consents and named-purpose pledge deadlines." });
});
export type LifecycleOperationalFacts = z.infer<typeof lifecycleOperationalFactsSchema>;
/** Adapters supply actual current queue scopes. Absent or incomplete subsets
 * remain unknown; all-payable/all-consent totals cannot stand in for them. */
export function withLifecycleOperationalFacts(source: C.LifecycleSnapshot, raw: LifecycleOperationalFacts | null, topics: readonly C.LifecycleTopic[]): C.LifecycleSnapshot {
  const snapshot = verifyLifecycleSnapshot(source);
  if (snapshot.audience !== "project_treasurer") fail("Private queue detail is not allowed in an organization aggregate or personal event.");
  const facts = raw === null ? null : lifecycleOperationalFactsSchema.parse(raw);
  if (facts && facts.asOf !== snapshot.asOf) fail("Every queue must share this occurrence's exact coherent source cutoff.");
  const sources = [...snapshot.sources], statements = [...snapshot.statements], provenance = snapshot.sources[0].provenance;
  const metrics = [["unsettledRepayments", "Unsettled recorded repayments", "Reembolsos registrados sin resolver", "expenses"], ["missingEvidence", "Missing review requirements", "Requisitos de revisión pendientes", "evidence"], ["expiringConsents", "Consent records nearing their fixed expiry", "Consentimientos próximos a su vencimiento fijo", "consents"], ["reconciliationExceptions", "Recorded exceptions in the declared scope", "Excepciones registradas en el ámbito declarado", "exceptions"]] as const;
  for (const [key, label, spanishLabel, topic] of metrics) {
    if (!topics.includes(topic)) continue;
    const fact = facts?.[key], available = fact?.state === "available" && fact.complete, originHash = fact?.sourceHash ?? hash({ unavailable: key, basis: snapshot.basisHash }), scope = fact?.scopeLabel ?? "Current source subset unavailable";
    addFact(sources, statements, { key: `queue_${key}`, label, spanishLabel, topic, value: available ? { kind: "count", count: fact.count! } : { kind: "unknown", reason: fact?.reason ?? "The complete current source subset has not been supplied; no count was inferred from a broader legacy total." }, provenance, originHash, scope });
    if (fact?.includedRecords !== null && fact?.includedRecords !== undefined) addFact(sources, statements, { key: `queue_${key}_included`, label: "Source records included", spanishLabel: "Registros fuente incluidos", topic, value: { kind: "count", count: fact.includedRecords }, provenance, originHash, scope });
    if (fact?.denominatorRecords !== null && fact?.denominatorRecords !== undefined) addFact(sources, statements, { key: `queue_${key}_denominator`, label: "Records in the declared source subset", spanishLabel: "Registros en el subconjunto fuente declarado", topic, value: { kind: "count", count: fact.denominatorRecords }, provenance, originHash, scope });
    if (key === "expiringConsents" && available) addFact(sources, statements, { key: "queue_expiry_hours", label: "Expiry horizon in hours after the source cutoff", spanishLabel: "Horizonte de vencimiento en horas desde el corte", topic, value: { kind: "count", count: facts!.expiringConsents.withinHours }, provenance, originHash, scope });
  }
  return finishSnapshot({ ...snapshot, sources, statements, basisHash: hash({ original: snapshot.basisHash, queues: facts ? { ...facts, asOf: undefined } : null }), notices: [...snapshot.notices, "Unsettled repayments, missing evidence, approaching expiries and exceptions use declared exact source subsets. An absent or incomplete subset is unknown, not zero.", ...(facts?.reconciliationExceptions.providerLag ? [facts.reconciliationExceptions.providerLag] : [])] });
}

export const lifecycleEventFactSchema = z.object({
  kind: C.lifecycleEventKindSchema, recipientBindingHash: z.string().regex(/^[a-f0-9]{64}$/), role: C.lifecycleRoleSchema, project: orgProjectSummarySchema,
  resourceKey: z.string().regex(/^[a-f0-9]{64}$/), transitionKey: z.string().regex(/^[a-f0-9]{64}$/), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["accepted", "withdrawn", "expired", "completed", "pending", "returned", "reassigned", "cancelled", "failed", "action_required", "unknown"]),
  effectiveAt: z.iso.datetime(), observedAt: z.iso.datetime(), provenance: C.lifecycleProvenanceSchema,
  sourceClass: z.enum(["canonical_record", "provider_observed", "sample_record", "replay_record", "modelled_record"]),
  amount: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().nullable(), purpose: z.string().trim().min(1).max(120).nullable(),
}).strict();
export type LifecycleEventFact = z.infer<typeof lifecycleEventFactSchema>;
const eventStates: Record<C.LifecycleEventKind, LifecycleEventFact["state"]> = { pledge_saved: "accepted", pledge_withdrawn: "withdrawn", pledge_expired: "expired", contribution_collected: "completed", contribution_return_pending: "pending", contribution_returned: "returned", contribution_moved: "reassigned", purpose_cancelled: "cancelled", repayment_pending: "pending", repayment_completed: "completed", repayment_failed: "failed", repayment_returned: "returned", repayment_action_required: "action_required", repayment_unknown: "unknown" };
export function lifecycleEventCategory(kind: C.LifecycleEventKind): C.LifecycleCategory { return kind.startsWith("pledge_") ? "pledges" : kind.startsWith("repayment_") ? "repayments" : ["purpose_cancelled", "contribution_moved"].includes(kind) ? "choices" : "contributions"; }
export function lifecycleEventKey(raw: LifecycleEventFact): string {
  const fact = lifecycleEventFactSchema.parse(raw);
  return hash({ contract: C.LIFECYCLE_VERSION, recipient: fact.recipientBindingHash, role: fact.role, projectId: fact.project.id, kind: fact.kind, resource: fact.resourceKey, transition: fact.transitionKey });
}
function checkEvent(raw: LifecycleEventFact): LifecycleEventFact {
  const fact = lifecycleEventFactSchema.parse(raw), category = lifecycleEventCategory(fact.kind);
  if (fact.state !== eventStates[fact.kind] || fact.role !== (category === "repayments" ? "volunteer" : "donor") || fact.provenance === "modelled" || fact.sourceClass === "modelled_record" || fact.amount && fact.amount.currency !== fact.project.currency || fact.kind !== "purpose_cancelled" && fact.amount === null) fail("A personal event must match its exact own-role recorded state, currency and source; a forecast or approval cannot become a completed payment.");
  if (fact.provenance === "sample" && fact.sourceClass !== "sample_record" || fact.provenance === "replay" && fact.sourceClass !== "replay_record" || fact.provenance === "live_sandbox" && ["contribution_collected", "contribution_returned", "repayment_completed", "repayment_returned"].includes(fact.kind) && fact.sourceClass !== "provider_observed") fail("A financial completion needs its authoritative observation or an explicit Sample/Replay record.");
  if (["sample", "live_sandbox"].includes(fact.provenance) && fact.provenance !== fact.project.mode || category !== "repayments" && fact.purpose === null || category === "repayments" && fact.purpose !== null) fail("Keep the exact source provenance and named purpose; a personal repayment template does not need a private claimant label.");
  return fact;
}
const eventCopy: Record<C.LifecycleEventKind, [string, string]> = {
  pledge_saved: ["Your {{amount}} pledge for {{purpose}} is saved. Payment needs your own approval.", "Tu compromiso de {{amount}} para {{purpose}} está guardado. El pago requiere tu propia aprobación."],
  pledge_withdrawn: ["Your unpaid {{amount}} pledge for {{purpose}} was withdrawn.", "Se retiró tu compromiso pendiente de {{amount}} para {{purpose}}."],
  pledge_expired: ["The original window for your {{amount}} pledge to {{purpose}} ended.", "Terminó el plazo original de tu compromiso de {{amount}} para {{purpose}}."],
  contribution_collected: ["The record shows your {{amount}} payment for {{purpose}} as completed.", "El registro muestra tu pago de {{amount}} para {{purpose}} como completado."],
  contribution_return_pending: ["Your requested {{amount}} return for {{purpose}} is still pending. Open its original record for the current next step.", "La devolución solicitada de {{amount}} para {{purpose}} sigue pendiente. Abre el registro original para consultar el siguiente paso."],
  contribution_returned: ["The record shows {{amount}} returned for {{purpose}} through the original payment route.", "El registro muestra la devolución de {{amount}} para {{purpose}} por la vía de pago original."],
  contribution_moved: ["Your reviewed choice moved {{amount}} to {{purpose}}. The original payment stays in its history.", "Tu decisión revisada trasladó {{amount}} a {{purpose}}. El pago original conserva su historial."],
  purpose_cancelled: ["{{purpose}} was cancelled. Open your original support record to review any available choices.", "Se canceló {{purpose}}. Abre tu registro de apoyo original para revisar las opciones disponibles."],
  repayment_pending: ["Your {{amount}} repayment is pending. Its completed outcome has not been confirmed.", "Tu reembolso de {{amount}} está pendiente. No se ha confirmado que esté completado."],
  repayment_completed: ["The record marks your {{amount}} repayment as completed.", "El registro marca tu reembolso de {{amount}} como completado."],
  repayment_failed: ["Your {{amount}} repayment did not complete. Open the original record for its next step.", "Tu reembolso de {{amount}} no se completó. Abre el registro original para consultar el siguiente paso."],
  repayment_returned: ["Your {{amount}} repayment was returned. The earlier delivery and return remain separate in the record.", "Tu reembolso de {{amount}} fue devuelto. La entrega anterior y la devolución siguen separadas en el registro."],
  repayment_action_required: ["Your {{amount}} repayment needs attention. Open the original record before taking its next step.", "Tu reembolso de {{amount}} necesita atención. Abre el registro original antes del siguiente paso."],
  repayment_unknown: ["We are checking the outcome of your {{amount}} repayment. Its result is not confirmed.", "Estamos comprobando el resultado de tu reembolso de {{amount}}. Todavía no está confirmado."],
};

export function personalLifecycleSnapshot(raw: LifecycleEventFact, asOf: string): C.LifecycleSnapshot {
  const fact = checkEvent(raw); z.iso.datetime().parse(asOf);
  if (Date.parse(fact.effectiveAt) > Date.parse(asOf) || Date.parse(fact.observedAt) > Date.parse(asOf)) fail("A personal notification cannot claim an event or observation after its actual source cutoff.");
  const category = lifecycleEventCategory(fact.kind), topic = category === "repayments" ? "expenses" : category === "pledges" ? "consents" : "funding", eventKey = lifecycleEventKey(fact);
  const sources: C.LifecycleSourceRow[] = [], values: C.LifecycleStatement["values"] = [], [english, spanish] = eventCopy[fact.kind];
  const base = scalar(`event:${eventKey}`, "Original recorded event time", topic, { kind: "date", value: fact.effectiveAt }, fact.provenance, fact.sourceHash, fact.observedAt); sources.push(base);
  if (english.includes("{{amount}}")) { const row = scalar(`amount:${eventKey}`, "Original event amount", topic, { kind: "money", currency: fact.amount!.currency, minor: fact.amount!.minor }, fact.provenance, fact.sourceHash, fact.observedAt); sources.push(row); values.push({ key: "amount", sourceId: row.id, sourceHash: row.contentHash }); }
  if (english.includes("{{purpose}}")) { const row = scalar(`purpose:${eventKey}`, "Original reviewed purpose", topic, { kind: "label", value: fact.purpose!, spanish: null }, fact.provenance, fact.sourceHash, fact.observedAt); sources.push(row); values.push({ key: "purpose", sourceId: row.id, sourceHash: row.contentHash }); }
  const statement: C.LifecycleStatement = { id: `event:${eventKey}`, topic, english, spanish, values, citations: sources.map(row => ({ sourceId: row.id, sourceHash: row.contentHash })) };
  return finishSnapshot({ audience: "personal_event", asOf, basisHash: hash({ eventKey, kind: fact.kind, state: fact.state, sourceHash: fact.sourceHash, originalTime: fact.effectiveAt, amount: fact.amount, purpose: fact.purpose }), targetLabel: fact.project.title, sources, statements: [statement], observedRange: { earliest: fact.observedAt, latest: fact.observedAt }, notices: [
    fact.provenance === "sample" ? "Sample · fictional event. No actual payment, person or provider action is established." : fact.provenance === "replay" ? "Replay · retained recorded event, not a newly executed payment." : "Live · Sandbox records use test funds. The source observation states the known outcome.",
    "This is a private in-app record. An email preview does not authorize sending, and a self-declared profile does not establish verified person or account ownership.", "Spanish wording is authored and has no fluent-language review.",
  ] });
}
export interface LifecycleEventDraft { eventKey: string; kind: C.LifecycleEventKind; occurredAt: string; snapshot: C.LifecycleSnapshot; content: C.LifecycleContent; emailPreview: C.LifecycleEmailPreview | null; }
/** Exact recipient/project/current role only. Opt-out stops new records; prior
 * read/archive history is retained independently. Refreshing an observation or
 * re-enabling preferences cannot produce a duplicate original event. */
export function personalLifecycleDrafts(input: { facts: readonly LifecycleEventFact[]; recipientBindingHash: string; projectId: string; role: z.infer<typeof C.lifecycleRoleSchema>; preferences: C.LifecyclePreferences; asOf: string; existingEventKeys?: readonly string[] }): { drafts: LifecycleEventDraft[]; reason: string | null } {
  const preferences = C.lifecyclePreferencesSchema.parse(input.preferences); z.iso.datetime().parse(input.asOf);
  if (!preferences.enabled || preferences.status !== "enabled") return { drafts: [], reason: "Personal lifecycle records are disabled for this original profile." };
  if (!preferences.expiresAt || Date.parse(input.asOf) >= Date.parse(preferences.expiresAt)) return { drafts: [], reason: "The original personal preference authorization ended; it cannot renew the profile's deadline." };
  const known = new Set(input.existingEventKeys ?? []), seen = new Map<string, string>(), drafts: LifecycleEventDraft[] = [];
  for (const raw of input.facts) {
    if (raw.recipientBindingHash !== input.recipientBindingHash || raw.project.id !== input.projectId || raw.role !== input.role) continue;
    const fact = checkEvent(raw), category = lifecycleEventCategory(fact.kind), eventKey = lifecycleEventKey(fact);
    if (!preferences.categories.includes(category) || preferences.history === "future_only" && Date.parse(fact.effectiveAt) < Date.parse(preferences.optedInAt!) || known.has(eventKey)) continue;
    const semantic = hash({ kind: fact.kind, state: fact.state, amount: fact.amount, purpose: fact.purpose, effectiveAt: fact.effectiveAt, provenance: fact.provenance, sourceClass: fact.sourceClass }), prior = seen.get(eventKey);
    if (prior) { if (prior !== semantic) fail("Two records contradict the same original personal event. No second or overwritten notification was created."); continue; }
    seen.set(eventKey, semantic);
    const snapshot = personalLifecycleSnapshot(fact, input.asOf), content = buildLifecycleDraft(snapshot, { title: lifecycleEventLabels[fact.kind] });
    drafts.push({ eventKey, kind: fact.kind, occurredAt: fact.effectiveAt, snapshot, content, emailPreview: preferences.emailPreviews ? lifecycleEmailPreview(content, snapshot.sources) : null });
  }
  return { drafts, reason: null };
}
