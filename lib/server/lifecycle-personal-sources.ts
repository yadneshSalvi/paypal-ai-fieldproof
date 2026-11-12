import { sha256, SqlPaymentStore, type CommerceRestResult, type CreatePayout, type PaymentOperation, type PayoutItemObservation, type SqlDatabase } from "@fracture/paypal-core";
import { z } from "zod";
import type { SettlementReceipt } from "../contracts";
import { conditionalPolicy, consentDigest, CONDITIONAL_PACKAGE_TITLE, type ConditionalPolicy } from "../domain/consent";
import type { FundingAssignment } from "../domain/funding-positions";
import { validateReceipt } from "../domain/money";
import { refundParentMatches } from "../domain/refunds";
import type { ReturnObservationContract } from "../funding/reconciliation";
import * as C from "../lifecycle/contracts";
import { lifecycleEventFactSchema, lifecycleEventKey, type LifecycleEventFact } from "../lifecycle/inbox";
import { query } from "./db";
import { caseContract, fundingChoiceContract, type CaseRow } from "./funding-lifecycle";
import { externalReturnRecord } from "./funding-return-reconciliation";
import { lifecycleHash, lifecycleRecipient } from "./lifecycle-core";
import type { OrgTx } from "./organization-core";
import { organizationProjectSummary, type OrganizationProjectAuthority } from "./organization-projects";
import { openPrivate, paymentOperationCodec } from "./private-values";
import { pledgeContract, type PledgeRow } from "./purpose-store";

export const LIFECYCLE_PERSONAL_SOURCE_PAGE_SIZE = 100;
const sourceKinds = ["purpose_saved", "purpose_withdrawn", "purpose_expired", "conditional_saved", "conditional_withdrawn", "conditional_expired", "receipt", "refund_pending", "refund_completed", "sample_return", "external_return", "assignment", "cancellation", "round_cancellation", "purpose_closed", "payout_dispatch", "payout_observation"] as const;
const descriptorSchema = z.object({ type: z.enum(sourceKinds), id: z.string().min(1).max(240), at: z.iso.datetime() }).strict();
export type LifecyclePersonalDescriptor = z.infer<typeof descriptorSchema>;
interface DescriptorRow { type: LifecyclePersonalDescriptor["type"]; id: string; at: Date; }
interface DocumentPin { id: string; version: number; hash: string; controlVersion: number; }
export interface LifecyclePersonalAccounting {
  grossMinor: number; originalCreditMinor: number; retainedMinor: number; returnedMinor: number; pendingReturnMinor: number;
}
/** Never serialize this sidecar. It contains original private source identities,
 * and is encrypted with the immutable inbox snapshot by its caller. */
export interface LifecyclePersonalSource {
  version: "personal-source-v1"; descriptor: LifecyclePersonalDescriptor; fact: LifecycleEventFact;
  currentSignature: string; document: DocumentPin | null; accounting: LifecyclePersonalAccounting | null;
  notices?: string[];
}
class UnavailableSource extends Error {}
class WithdrawnSource extends Error {}
const invalid = (): never => { throw new UnavailableSource("The original personal source cannot establish this event."); };
function check(value: unknown): asserts value { if (!value) invalid(); }
function open<T>(ciphertext: string, context: string): T { try { return openPrivate<T>(ciphertext, context); } catch { return invalid(); } }
function verified<T>(read: () => T): T { try { return read(); } catch { return invalid(); } }
function date(value: string | Date): string { return verified(() => z.iso.datetime().parse(value instanceof Date ? value.toISOString() : value)); }
function amount(value: string | number): number { const parsed = Number(value); check(Number.isSafeInteger(parsed) && parsed > 0); return parsed; }
const scopeValues = (authority: OrganizationProjectAuthority) => [authority.session.tenantId, authority.session.projectId, authority.session.actorId];
const sourceClass = (provenance: C.LifecycleProvenance, observed = false): LifecycleEventFact["sourceClass"] => provenance === "sample" ? "sample_record" : provenance === "replay" ? "replay_record" : observed ? "provider_observed" : "canonical_record";
const safeProviderId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{3,180}$/.test(value);

const cursorSchema = z.object({ owner: z.string().regex(/^[a-f0-9]{64}$/), at: z.iso.datetime(), id: z.string().min(1).max(240), type: descriptorSchema.shape.type }).strict();
function sourceCursor(value: string | undefined, owner: string) {
  if (!value) return null;
  try {
    check(value.length <= 1000 && /^[A-Za-z0-9_-]+$/.test(value));
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    check(parsed.owner === owner); return parsed;
  } catch { throw new UnavailableSource("The bounded source scan position is no longer available."); }
}

/** All queries below are scoped by the recipient BEFORE the bounded union is
 * paged. A read never starts an operation, refreshes a provider, repairs a source
 * or changes the original transition timestamp. */
export async function scanLifecyclePersonalSources(tx: OrgTx, authority: OrganizationProjectAuthority, input: { asOf: string; since: string | null; cursor?: string; limit?: number; binding: string }) {
  const limit = z.number().int().min(1).max(LIFECYCLE_PERSONAL_SOURCE_PAGE_SIZE).parse(input.limit ?? LIFECYCLE_PERSONAL_SOURCE_PAGE_SIZE);
  date(input.asOf); if (input.since) date(input.since);
  const owner = lifecycleHash({ binding: input.binding, recipient: lifecycleRecipient(authority), session: authority.session.id, membership: authority.membershipVersion });
  const cursor = sourceCursor(input.cursor, owner), values = [...scopeValues(authority), input.asOf, cursor?.at ?? null, cursor?.id ?? null, cursor?.type ?? null, limit + 1];
  const donor = `
    SELECT 'purpose_saved'::text type,p.id,p.created_at at FROM fp_purpose_pledges p WHERE p.tenant_id=$1 AND p.project_id=$2 AND p.donor_actor_id=$3
    UNION ALL SELECT 'purpose_withdrawn',a.intent_id,a.created_at FROM fp_funding_actions a JOIN fp_purpose_pledges p ON p.id=a.result->>'id' AND p.tenant_id=a.tenant_id AND p.project_id=a.project_id AND p.donor_actor_id=a.actor_id WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.actor_id=$3 AND a.kind='withdraw_pledge'
    UNION ALL SELECT 'purpose_expired',p.id,p.expires_at FROM fp_purpose_pledges p WHERE p.tenant_id=$1 AND p.project_id=$2 AND p.donor_actor_id=$3 AND p.operation_id IS NULL AND p.state IN ('pledged','held','expired')
    UNION ALL SELECT 'conditional_saved',c.id,c.acknowledged_at FROM fp_conditional_consents c WHERE c.tenant_id=$1 AND c.project_id=$2 AND c.actor_id=$3
    UNION ALL SELECT 'conditional_withdrawn',c.id,c.withdrawn_at FROM fp_conditional_consents c WHERE c.tenant_id=$1 AND c.project_id=$2 AND c.actor_id=$3 AND c.withdrawn_at IS NOT NULL
    UNION ALL SELECT 'conditional_expired',c.id,c.expires_at FROM fp_conditional_consents c JOIN fp_obligations o ON o.id=c.obligation_id AND o.tenant_id=c.tenant_id AND o.project_id=c.project_id AND o.actor_id=c.actor_id WHERE c.tenant_id=$1 AND c.project_id=$2 AND c.actor_id=$3 AND c.round_id IS NULL AND c.withdrawn_at IS NULL AND o.channel='uncollected'
    UNION ALL SELECT 'receipt',r.id,r.created_at FROM fp_settlement_receipts r JOIN fp_obligations o ON o.id=r.obligation_id AND o.tenant_id=r.tenant_id AND o.project_id=r.project_id WHERE r.tenant_id=$1 AND r.project_id=$2 AND o.actor_id=$3 AND o.purpose='conditional_pledge'
    UNION ALL SELECT 'refund_pending',f.id,f.created_at FROM fp_refunds f JOIN fp_obligations o ON o.id=f.obligation_id AND o.tenant_id=f.tenant_id AND o.project_id=f.project_id WHERE f.tenant_id=$1 AND f.project_id=$2 AND o.actor_id=$3 AND o.purpose='conditional_pledge'
    UNION ALL SELECT 'refund_completed',f.id,f.completed_at FROM fp_refunds f JOIN fp_obligations o ON o.id=f.obligation_id AND o.tenant_id=f.tenant_id AND o.project_id=f.project_id WHERE f.tenant_id=$1 AND f.project_id=$2 AND o.actor_id=$3 AND o.purpose='conditional_pledge' AND f.completed_at IS NOT NULL
    UNION ALL SELECT 'sample_return',c.id,c.executed_at FROM fp_funding_choices c WHERE c.tenant_id=$1 AND c.project_id=$2 AND c.donor_actor_id=$3 AND c.kind='return' AND c.state='returned' AND c.executed_at IS NOT NULL AND c.executed_id=('sample-return:'||c.id)
    UNION ALL SELECT 'external_return',e.id,e.created_at FROM fp_funding_external_returns e JOIN fp_settlement_receipts r ON r.id=e.receipt_id AND r.tenant_id=e.tenant_id AND r.project_id=e.project_id JOIN fp_obligations o ON o.id=r.obligation_id AND o.tenant_id=r.tenant_id AND o.project_id=r.project_id WHERE e.tenant_id=$1 AND e.project_id=$2 AND o.actor_id=$3 AND o.purpose='conditional_pledge'
    UNION ALL SELECT 'assignment',a.id,a.committed_at FROM fp_funding_assignments a JOIN fp_funding_choices c ON c.id=a.consent_id AND c.receipt_id=a.receipt_id AND c.tenant_id=a.tenant_id AND c.project_id=a.project_id WHERE a.tenant_id=$1 AND a.project_id=$2 AND c.donor_actor_id=$3 AND c.authority='donor' AND c.accepted_by=$3 AND a.kind IN ('reallocation','rollover')
    UNION ALL SELECT 'cancellation',c.id,c.created_at FROM fp_funding_cases c WHERE c.tenant_id=$1 AND c.project_id=$2 AND c.supersedes_id IS NULL AND (EXISTS(SELECT 1 FROM fp_obligations o WHERE o.tenant_id=c.tenant_id AND o.project_id=c.project_id AND o.actor_id=$3 AND o.package_id=c.package_id AND o.purpose='conditional_pledge') OR EXISTS(SELECT 1 FROM fp_funding_assignments a JOIN fp_settlement_receipts r ON r.id=a.receipt_id AND r.tenant_id=a.tenant_id AND r.project_id=a.project_id JOIN fp_obligations o ON o.id=r.obligation_id AND o.tenant_id=r.tenant_id AND o.project_id=r.project_id WHERE a.tenant_id=c.tenant_id AND a.project_id=c.project_id AND a.credit_package_id=c.package_id AND o.actor_id=$3 AND o.purpose='conditional_pledge'))
    UNION ALL SELECT 'round_cancellation',r.id,r.cancellation_requested_at FROM fp_collection_rounds r WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.cancellation_reason='package_cancelled' AND r.cancellation_requested_at IS NOT NULL AND EXISTS(SELECT 1 FROM fp_conditional_consents c WHERE c.tenant_id=r.tenant_id AND c.project_id=r.project_id AND c.round_id=r.id AND c.actor_id=$3 AND c.package_id=r.package_id AND c.package_version=r.package_version)
    UNION ALL SELECT 'purpose_closed',a.intent_id,a.created_at FROM fp_funding_actions a JOIN fp_funding_policies f ON f.id=a.result->>'id' AND f.tenant_id=a.tenant_id AND f.project_id=a.project_id WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.kind='purpose_window' AND f.state='closed' AND EXISTS(SELECT 1 FROM fp_purpose_pledges p WHERE p.policy_id=f.id AND p.tenant_id=f.tenant_id AND p.project_id=f.project_id AND p.donor_actor_id=$3 AND p.state='cancelled')`;
  const volunteer = `
    SELECT 'payout_dispatch'::text type,p.id,p.first_dispatched_at at FROM fp_payables p JOIN fp_claims c ON c.id=p.claim_id AND c.tenant_id=p.tenant_id AND c.project_id=p.project_id WHERE p.tenant_id=$1 AND p.project_id=$2 AND c.actor_id=$3 AND p.first_dispatched_at IS NOT NULL
    UNION ALL SELECT 'payout_observation',o.id,o.created_at FROM fp_payout_observations o JOIN fp_payables p ON p.id=o.payable_id JOIN fp_claims c ON c.id=p.claim_id AND c.tenant_id=p.tenant_id AND c.project_id=p.project_id WHERE p.tenant_id=$1 AND p.project_id=$2 AND c.actor_id=$3`;
  // Some original transition times live inside immutable encrypted contracts;
  // created_at is only the scan position. Future-only filtering belongs to the
  // verified effectiveAt, never to an observation or insertion timestamp.
  const rows = await query<DescriptorRow>(`WITH candidates AS (${authority.session.role === "donor" ? donor : volunteer}), positioned AS (SELECT type,id,at,date_trunc('milliseconds',at) cursor_at FROM candidates) SELECT type,id,cursor_at at FROM positioned WHERE at<=$4::timestamptz AND ($5::timestamptz IS NULL OR (cursor_at,id,type)>($5::timestamptz,$6::text,$7::text)) ORDER BY cursor_at,id,type LIMIT $8`, values, tx);
  const page = rows.slice(0, limit), sources: LifecyclePersonalSource[] = [], seen = new Set<string>(); let skipped = 0;
  for (const row of page) {
    const source = await loadLifecyclePersonalSource(tx, authority, { type: row.type, id: row.id, at: date(row.at) }, input.asOf);
    if (!source) { skipped++; continue; }
    const key = lifecycleEventKey(source.fact);
    // Repeated provider polling can retain many observations of one state. Its
    // first original observation wins; it never creates another transition.
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key); sources.push(source);
  }
  const last = page.at(-1);
  return { sources, checked: page.length, skipped, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ owner, at: date(last.at), id: last.id, type: last.type })).toString("base64url") : null };
}

interface ConditionalRow {
  id: string; tenant_id: string; project_id: string; actor_id: string; obligation_id: string; package_id: string; package_version: number;
  amount_minor: string; version: number; slot_index: number; policy_digest: string; policy: ConditionalPolicy; status: string;
  expires_at: Date; acknowledged_at: Date; withdrawn_at: Date | null; round_id: string | null; channel: string;
}
async function conditional(tx: OrgTx, authority: OrganizationProjectAuthority, id: string) {
  const [row] = await query<ConditionalRow>(`SELECT c.*,o.channel FROM fp_conditional_consents c JOIN fp_obligations o ON o.id=c.obligation_id AND o.tenant_id=c.tenant_id AND o.project_id=c.project_id AND o.actor_id=c.actor_id AND o.package_id=c.package_id WHERE c.tenant_id=$1 AND c.project_id=$2 AND c.actor_id=$3 AND c.id=$4`, [...scopeValues(authority), id], tx);
  check(row);
  const policy = verified(() => conditionalPolicy(row.slot_index, row.package_version));
  check(lifecycleHash(policy) === lifecycleHash(row.policy) && row.policy_digest === consentDigest({ tenantId: row.tenant_id, projectId: row.project_id, actorId: row.actor_id, obligationId: row.obligation_id, version: row.version, policy }) && policy.amountMinor === amount(row.amount_minor) && date(row.expires_at) === policy.expiresAt);
  return row;
}
async function ownPledge(tx: OrgTx, authority: OrganizationProjectAuthority, id: string) {
  const [row] = await query<PledgeRow>("SELECT p.* FROM fp_purpose_pledges p JOIN fp_obligations o ON o.id=p.obligation_id AND o.tenant_id=p.tenant_id AND o.project_id=p.project_id AND o.actor_id=p.donor_actor_id AND o.package_id=p.package_id WHERE p.tenant_id=$1 AND p.project_id=$2 AND p.donor_actor_id=$3 AND p.id=$4", [...scopeValues(authority), id], tx);
  check(row); const value = verified(() => pledgeContract(row)); check(value.provenance === authority.session.mode || value.provenance === "replay"); return { row, value };
}
interface ReceiptRow { id: string; tenant_id: string; project_id: string; obligation_id: string; package_id: string; provider_ref: string; provenance: C.LifecycleProvenance; data: SettlementReceipt; version: number; created_at: Date; }
async function ownReceipt(tx: OrgTx, authority: OrganizationProjectAuthority, id: string) {
  const [row] = await query<ReceiptRow>("SELECT r.* FROM fp_settlement_receipts r JOIN fp_obligations o ON o.id=r.obligation_id AND o.tenant_id=r.tenant_id AND o.project_id=r.project_id WHERE r.tenant_id=$1 AND r.project_id=$2 AND o.actor_id=$3 AND o.purpose='conditional_pledge' AND r.id=$4", [...scopeValues(authority), id], tx);
  check(row); const value = row.data; verified(() => validateReceipt(value));
  check(value.id === row.id && value.tenantId === row.tenant_id && value.projectId === row.project_id && value.donorObligationId === row.obligation_id && value.packageId === row.package_id && value.actualProviderPaymentRef === row.provider_ref && value.provenance === row.provenance && value.provenance !== "modelled" && (value.provenance === authority.session.mode || value.provenance === "replay"));
  return row;
}
async function receiptOrigin(tx: OrgTx, authority: OrganizationProjectAuthority, receipt: ReceiptRow): Promise<{ title: string; hash: string }> {
  const [pledge] = await query<{ id: string }>("SELECT id FROM fp_purpose_pledges WHERE tenant_id=$1 AND project_id=$2 AND donor_actor_id=$3 AND obligation_id=$4", [...scopeValues(authority), receipt.obligation_id], tx);
  if (pledge) { const { row, value } = await ownPledge(tx, authority, pledge.id); check(value.packageId === receipt.package_id); return { title: value.title, hash: row.digest }; }
  const [legacy] = await query<{ id: string }>("SELECT id FROM fp_conditional_consents WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND obligation_id=$4", [...scopeValues(authority), receipt.obligation_id], tx);
  if (legacy) { const row = await conditional(tx, authority, legacy.id); check(row.package_id === receipt.package_id); return { title: CONDITIONAL_PACKAGE_TITLE, hash: row.policy_digest }; }
  const [sample] = await query<{ id: string; package_version: number; digest: string; encrypted_data: string }>("SELECT id,package_version,digest,encrypted_data FROM fp_sample_funding_origins WHERE tenant_id=$1 AND project_id=$2 AND obligation_id=$3 AND package_id=$4", [authority.session.tenantId, authority.session.projectId, receipt.obligation_id, receipt.package_id], tx);
  check(sample && receipt.provenance === "sample");
  const value = open<{ schemaVersion: string; id: string; tenantId: string; projectId: string; provenance: string; obligationId: string; donorActorId: string; packageId: string; packageVersion: number; amountMinor: number; title: string }>(sample.encrypted_data, `sample-funding-origin:${authority.session.tenantId}:${authority.session.projectId}:${sample.id}`);
  check(lifecycleHash(value) === sample.digest && value.schemaVersion === "sample-original-purpose-v1" && value.id === sample.id && value.tenantId === authority.session.tenantId && value.projectId === authority.session.projectId && value.provenance === "sample" && value.donorActorId === authority.session.actorId && value.obligationId === receipt.obligation_id && value.packageId === receipt.package_id && value.packageVersion === sample.package_version && value.amountMinor >= receipt.data.creditedMinor);
  return { title: value.title, hash: sample.digest };
}
function paymentStoreAt(tx: OrgTx) {
  const database: SqlDatabase = { dialect: tx.dialect, query: tx.query.bind(tx), transaction: work => work(tx), close: async () => undefined };
  return new SqlPaymentStore(database, { operationDocumentCodec: paymentOperationCodec });
}
async function operation(tx: OrgTx, authority: OrganizationProjectAuthority, id: string): Promise<PaymentOperation> {
  let value: PaymentOperation | null;
  try { value = await paymentStoreAt(tx).get(authority.session, id); } catch (error) {
    if (error instanceof Error && "kind" in error && error.kind === "OPERATION_DOCUMENT_UNAVAILABLE") return invalid();
    throw error;
  }
  check(value && value.command.operationId === id && value.command.scope.tenantId === authority.session.tenantId && value.command.scope.projectId === authority.session.projectId); return value;
}
async function captureProof(tx: OrgTx, authority: OrganizationProjectAuthority, row: ReceiptRow, asOf: string) {
  if (row.provenance !== "live_sandbox") return;
  const receipt = row.data; check(receipt.authoritativeObservedState === "COMPLETED" && safeProviderId(receipt.actualProviderPaymentRef));
  const commands = await query<{ operation_id: string }>("SELECT operation_id FROM fp_payment_commands WHERE tenant_id=$1 AND project_id=$2 AND obligation_id=$3 ORDER BY created_at,operation_id LIMIT 100", [row.tenant_id, row.project_id, row.obligation_id], tx);
  for (const command of commands) {
    const value = await operation(tx, authority, command.operation_id), proof = value.receipt;
    if (proof?.source !== "live_sandbox" || proof.transport === "local_fixture" || proof.status < 200 || proof.status >= 300 || proof.operationId !== command.operation_id || proof.providerRequestId !== value.command.providerRequestId) continue;
    if (proof.resources.some(resource => resource.kind === "capture" && resource.id === receipt.actualProviderPaymentRef && resource.status === "COMPLETED" && resource.source === "live_sandbox" && resource.money?.currency === receipt.currency && resource.money.minor === receipt.grossSettledMinor && Date.parse(date(resource.observedAt)) <= Date.parse(asOf))) return;
  }
  // An invoice PAID label is insufficient. This retained observation contains
  // the independently read original payment resource and exact invoice lineage.
  if (receipt.sourceInvoiceId) {
    // The frozen transaction determines which retained proof rows exist. Their
    // provider observation time is checked below; an insertion/ingestion time
    // is not the original payment's effective or provider-observed timestamp.
    const rows = await query<{ invoice_id: string; invoice_number: string; provider_invoice_hash: string | null; payment_identity_hash: string; body_hash: string; encrypted_data: string }>(`SELECT o.invoice_id,i.invoice_number,i.provider_invoice_hash,o.payment_identity_hash,o.body_hash,o.encrypted_data FROM fp_invoice_payment_observations o JOIN fp_recovery_invoices i ON i.id=o.invoice_id WHERE i.tenant_id=$1 AND i.project_id=$2 AND i.obligation_id=$3 AND i.actor_id=$4 AND o.payment_identity_hash=$5 AND o.state='corroborated_capture' ORDER BY o.observed_at,o.id LIMIT 100`, [row.tenant_id, row.project_id, row.obligation_id, authority.session.actorId, sha256(receipt.actualProviderPaymentRef)], tx);
    for (const observed of rows) {
      const evidence = open<{ payment: { id: string; type: string; money: { currency: string; minor: number } }; capture: { id: string; source: string; status: string; invoiceId: string | null; observedAt: string; money: { currency: string; minor: number } } }>(observed.encrypted_data, `invoice-payment:${row.tenant_id}:${observed.invoice_id}:${observed.payment_identity_hash}`);
      if (lifecycleHash(evidence) !== observed.body_hash) continue;
      const capture = evidence.capture;
      if (observed.provider_invoice_hash === sha256(receipt.sourceInvoiceId) && evidence.payment?.id === receipt.actualProviderPaymentRef && evidence.payment.type === "PAYPAL" && evidence.payment.money?.currency === receipt.currency && evidence.payment.money.minor === receipt.grossSettledMinor && capture?.id === receipt.actualProviderPaymentRef && capture.source === "live_sandbox" && capture.status === "COMPLETED" && (!capture.invoiceId || [receipt.sourceInvoiceId, observed.invoice_number].includes(capture.invoiceId)) && capture.money?.currency === receipt.currency && capture.money.minor === receipt.grossSettledMinor && Date.parse(date(capture.observedAt)) <= Date.parse(asOf)) return;
    }
  }
  invalid();
}

async function documentPin(tx: OrgTx, authority: OrganizationProjectAuthority, id: string): Promise<DocumentPin> {
  // A missing control means the original default permission. A table share
  // lock prevents a concurrent first withdrawal from appearing in that gap.
  await tx.query("LOCK TABLE fp_plan_source_controls IN SHARE MODE");
  const [document] = await query<{ id: string; actor_id: string; version: number; sha256: string | null; state: string }>("SELECT id,actor_id,version,sha256,state FROM fp_documents WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR SHARE", [authority.session.tenantId, authority.session.projectId, id], tx);
  if (!document || document.actor_id !== authority.session.actorId || document.state !== "ready" || !document.sha256) throw new WithdrawnSource("The original private source is unavailable.");
  const [control] = await query<{ version: number; permission: string }>("SELECT version,permission FROM fp_plan_source_controls WHERE tenant_id=$1 AND project_id=$2 AND document_id=$3 FOR SHARE", [authority.session.tenantId, authority.session.projectId, id], tx);
  if (control && control.permission !== "allowed") throw new WithdrawnSource("The original source permission was withdrawn.");
  return { id: document.id, version: document.version, hash: document.sha256, controlVersion: control?.version ?? 1 };
}
interface PayableRow { id: string; claim_id: string; claim_version: number; amount_minor: string; request_hash: string; encrypted_data: string; batch_hash: string | null; item_hash: string | null; state: string; first_dispatched_at: Date | null; principal_paid_at: Date | null; principal_returned_at: Date | null; document_id: string; claim_actor_id: string; }
interface PayableData { request: CreatePayout; snapshot: { claimId: string; claimantActorId: string; documentId: string; sourceHash: string; documentVersion: number; funding: { amountMinor: number } }; batchId: string | null; itemId: string | null; }
async function ownPayable(tx: OrgTx, authority: OrganizationProjectAuthority, id: string) {
  const [row] = await query<PayableRow>("SELECT p.*,c.document_id,c.actor_id claim_actor_id FROM fp_payables p JOIN fp_claims c ON c.id=p.claim_id AND c.tenant_id=p.tenant_id AND c.project_id=p.project_id WHERE p.tenant_id=$1 AND p.project_id=$2 AND c.actor_id=$3 AND p.id=$4", [...scopeValues(authority), id], tx);
  check(row);
  const data = open<PayableData>(row.encrypted_data, `payable:${authority.session.tenantId}:${authority.session.projectId}:${row.id}`), request = data.request;
  check(request && lifecycleHash(request) === row.request_hash && request.items?.length === 1 && request.items[0].money?.currency === "USD" && request.items[0].money.minor === amount(row.amount_minor) && data.snapshot?.funding?.amountMinor === Number(row.amount_minor) && data.snapshot.claimId === row.claim_id && data.snapshot.claimantActorId === authority.session.actorId && data.snapshot.documentId === row.document_id);
  const document = await documentPin(tx, authority, row.document_id);
  if (document.hash !== data.snapshot.sourceHash || document.version !== data.snapshot.documentVersion) throw new WithdrawnSource("The original private expense source changed.");
  return { row, data, document };
}
async function observedPriorDelivery(tx: OrgTx, authority: OrganizationProjectAuthority, payable: PayableRow, data: PayableData, returnedAt: string, asOf: string) {
  const rows = await query<{ id: string; body_hash: string; encrypted_data: string }>("SELECT id,body_hash,encrypted_data FROM fp_payout_observations WHERE payable_id=$1 AND kind='item_read' AND outcome='succeeded' ORDER BY abs(extract(epoch FROM (created_at-$2::timestamptz))),id LIMIT 100", [payable.id, payable.principal_paid_at?.toISOString() ?? returnedAt], tx), expected = data.request.items[0];
  for (const row of rows) {
    const result = open<CommerceRestResult<PayoutItemObservation>>(row.encrypted_data, `payout-observation:${authority.session.tenantId}:${authority.session.projectId}:${payable.id}:${row.id}`);
    if (lifecycleHash(result) !== row.body_hash || result.outcome !== "succeeded" || result.source !== "live_sandbox" || Date.parse(date(result.observedAt)) > Math.min(Date.parse(returnedAt), Date.parse(asOf))) continue;
    const item = result.value;
    if (item?.status === "SUCCESS" && safeProviderId(item.transactionId) && item.id === data.itemId && item.batchId === data.batchId && item.senderItemId === expected.senderItemId && item.recipientType === expected.recipientType && item.receiver === expected.receiver && item.money?.currency === "USD" && item.money.minor === Number(payable.amount_minor)) return true;
  }
  return false;
}

/** A single original source is reloaded for detail authorization. The retained
 * path permits an earlier pending state to be read as historical; it never
 * manufactures such a state during a new current-record capture. */
export async function loadLifecyclePersonalSource(tx: OrgTx, authority: OrganizationProjectAuthority, raw: LifecyclePersonalDescriptor, asOf: string, retained = false): Promise<LifecyclePersonalSource | null> {
  try { return await load(tx, authority, descriptorSchema.parse(raw), date(asOf), retained); }
  catch (error) { if (error instanceof UnavailableSource || error instanceof WithdrawnSource || error instanceof z.ZodError) return null; throw error; }
}
async function load(tx: OrgTx, authority: OrganizationProjectAuthority, descriptor: LifecyclePersonalDescriptor, asOf: string, retained: boolean): Promise<LifecyclePersonalSource> {
  const { type, id } = descriptor, project = await organizationProjectSummary(tx, authority.session);
  let kind: C.LifecycleEventKind, state: LifecycleEventFact["state"], effectiveAt = descriptor.at, observedAt = descriptor.at, provenance: C.LifecycleProvenance = authority.session.mode;
  let minor: number | null = null, purpose: string | null = null, resource: unknown, transition: unknown, basis: unknown, signature: unknown;
  let document: DocumentPin | null = null, accounting: LifecyclePersonalAccounting | null = null, providerObserved = false;
  const notices: string[] = [];
  const bindReceipt = async (row: ReceiptRow) => {
    const original = await receiptOrigin(tx, authority, row); purpose = original.title; provenance = row.provenance;
    const r = row.data;
    accounting = { grossMinor: r.grossSettledMinor, originalCreditMinor: r.creditedMinor, retainedMinor: r.creditedMinor - r.completedAttributedRefundMinor, returnedMinor: r.completedAttributedRefundMinor, pendingReturnMinor: r.pendingAttributedRefundReserveMinor };
    return { original, stable: { receiptId: r.id, obligationId: r.donorObligationId, packageId: r.packageId, sourceKind: r.sourceKind, provenance: r.provenance, paymentRefHash: sha256(r.actualProviderPaymentRef), currency: r.currency, grossMinor: r.grossSettledMinor, creditedMinor: r.creditedMinor } };
  };
  if (type.startsWith("purpose_") && type !== "purpose_closed") {
    let pledgeId = id;
    if (type === "purpose_withdrawn") {
      const [action] = await query<{ result: { id: string }; created_at: Date }>("SELECT result,created_at FROM fp_funding_actions WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND intent_id=$4 AND kind='withdraw_pledge'", [...scopeValues(authority), id], tx);
      check(action); pledgeId = action.result.id; effectiveAt = date(action.created_at);
    }
    const { row, value } = await ownPledge(tx, authority, pledgeId);
    purpose = value.title; minor = value.amountMinor; provenance = value.provenance;
    resource = { pledge: row.id }; signature = { state: row.state, collected: row.collected_minor };
    if (type === "purpose_saved") { kind = "pledge_saved"; state = "accepted"; effectiveAt = date(value.acceptedAt); }
    else if (type === "purpose_withdrawn") { check(row.state === "withdrawn"); kind = "pledge_withdrawn"; state = "withdrawn"; }
    else { check(row.expires_at <= new Date(asOf) && (retained || !row.operation_id && ["pledged", "held", "expired"].includes(row.state) && Number(row.collected_minor) === 0)); kind = "pledge_expired"; state = "expired"; effectiveAt = date(row.expires_at); }
    observedAt = effectiveAt; transition = { kind }; basis = { digest: row.digest, kind, effectiveAt };
  } else if (type.startsWith("conditional_")) {
    const row = await conditional(tx, authority, id); minor = amount(row.amount_minor); purpose = CONDITIONAL_PACKAGE_TITLE;
    resource = { consent: row.id }; signature = { status: row.status, channel: row.channel };
    if (type === "conditional_saved") { kind = "pledge_saved"; state = "accepted"; effectiveAt = date(row.acknowledged_at); }
    else if (type === "conditional_withdrawn") { check(row.withdrawn_at); kind = "pledge_withdrawn"; state = "withdrawn"; effectiveAt = date(row.withdrawn_at); }
    else { check(row.expires_at <= new Date(asOf) && (retained || !row.round_id && !row.withdrawn_at && row.channel === "uncollected")); kind = "pledge_expired"; state = "expired"; effectiveAt = date(row.expires_at); }
    observedAt = effectiveAt; transition = { kind }; basis = { digest: row.policy_digest, kind, effectiveAt };
  } else if (type === "receipt") {
    const row = await ownReceipt(tx, authority, id), origin = await bindReceipt(row);
    check(row.data.authoritativeObservedState === "COMPLETED" && row.data.grossSettledMinor > 0); await captureProof(tx, authority, row, asOf);
    kind = "contribution_collected"; state = "completed"; minor = row.data.grossSettledMinor; effectiveAt = observedAt = date(row.data.observedAt);
    resource = { receipt: row.id }; transition = { kind: "original_completed" }; basis = { ...origin.stable, origin: origin.original.hash, effectiveAt }; signature = { version: row.version }; providerObserved = provenance === "live_sandbox";
  } else if (type === "refund_pending" || type === "refund_completed") {
    const [row] = await query<{ id: string; receipt_id: string; obligation_id: string; amount_minor: string; state: string; operation_id: string | null; provider_refund_hash: string | null; created_at: Date; completed_at: Date | null }>("SELECT f.* FROM fp_refunds f JOIN fp_obligations o ON o.id=f.obligation_id AND o.tenant_id=f.tenant_id AND o.project_id=f.project_id WHERE f.tenant_id=$1 AND f.project_id=$2 AND o.actor_id=$3 AND f.id=$4", [...scopeValues(authority), id], tx);
    check(row); const receipt = await ownReceipt(tx, authority, row.receipt_id), origin = await bindReceipt(receipt); check(row.obligation_id === receipt.obligation_id);
    minor = amount(row.amount_minor); resource = { refund: row.id }; signature = { state: row.state };
    if (type === "refund_pending") {
      check(retained || ["reserved", "claimed", "dispatching", "pending_reconciliation", "unknown"].includes(row.state)); kind = "contribution_return_pending"; state = "pending"; effectiveAt = observedAt = date(row.created_at);
    } else {
      check(row.state === "completed" && row.completed_at && row.operation_id && row.provider_refund_hash && provenance === "live_sandbox");
      const saved = await operation(tx, authority, row.operation_id), proof = saved.receipt;
      check(saved.command.action.kind === "refund_capture" && saved.command.action.captureId === receipt.data.actualProviderPaymentRef && saved.command.action.money.currency === receipt.data.currency && saved.command.action.money.minor === minor && proof?.source === "live_sandbox" && proof.transport !== "local_fixture" && proof.status >= 200 && proof.status < 300 && proof.operationId === row.operation_id && proof.providerRequestId === saved.command.providerRequestId);
      const refund = proof.resources.find(item => item.kind === "refund" && sha256(item.id) === row.provider_refund_hash && item.source === "live_sandbox" && item.status === "COMPLETED" && refundParentMatches(item, receipt.data.actualProviderPaymentRef) && item.money?.currency === receipt.data.currency && item.money.minor === minor);
      check(refund); kind = "contribution_returned"; state = "returned"; effectiveAt = date(row.completed_at); observedAt = date(refund.observedAt); providerObserved = true;
    }
    transition = { kind }; basis = { origin: origin.original.hash, refund: row.id, amount: minor, kind, effectiveAt };
  } else if (type === "sample_return" || type === "assignment") {
    type ChoiceRow = Parameters<typeof fundingChoiceContract>[0] & { executed_at: Date | null };
    let choiceId = id, entry: FundingAssignment | null = null;
    if (type === "assignment") {
      const [row] = await query<{ id: string; consent_id: string; document_digest: string; encrypted_data: string; receipt_id: string; amount_minor: string; committed_at: Date; credit_package_id: string; debit_package_id: string }>("SELECT a.* FROM fp_funding_assignments a JOIN fp_funding_choices c ON c.id=a.consent_id AND c.receipt_id=a.receipt_id AND c.tenant_id=a.tenant_id AND c.project_id=a.project_id WHERE a.tenant_id=$1 AND a.project_id=$2 AND c.donor_actor_id=$3 AND a.id=$4", [...scopeValues(authority), id], tx);
      check(row); entry = open<FundingAssignment>(row.encrypted_data, `funding-assignment:${authority.session.tenantId}:${authority.session.projectId}:${row.id}`);
      check(lifecycleHash(entry) === row.document_digest && entry.id === row.id && entry.tenantId === authority.session.tenantId && entry.projectId === authority.session.projectId && entry.donorActorId === authority.session.actorId && entry.receiptId === row.receipt_id && entry.consentId === row.consent_id && entry.amountMinor === amount(row.amount_minor) && entry.credit.packageId === row.credit_package_id && entry.debit.packageId === row.debit_package_id && date(entry.committedAt) === date(row.committed_at) && ["reallocation", "rollover"].includes(entry.kind)); choiceId = row.consent_id;
    }
    const [row] = await query<ChoiceRow>("SELECT * FROM fp_funding_choices WHERE tenant_id=$1 AND project_id=$2 AND donor_actor_id=$3 AND id=$4", [...scopeValues(authority), choiceId], tx);
    check(row); const value = verified(() => fundingChoiceContract(row)), receipt = await ownReceipt(tx, authority, row.receipt_id), origin = await bindReceipt(receipt);
    check(value.donorActorId === authority.session.actorId && value.receiptId === receipt.id && value.amountMinor === amount(row.amount_minor)); minor = value.amountMinor;
    if (entry) {
      check(value.authority === "donor" && value.acceptedBy === authority.session.actorId && value.kind === entry.kind && value.destination && value.destination.packageId === entry.credit.packageId && value.destination.packageVersion === entry.credit.packageVersion && entry.consentDigest === row.digest && value.amountMinor === entry.amountMinor && row.state === "executed" && row.executed_id === entry.id && value.provenance === entry.provenance);
      purpose = value.destination.title; kind = "contribution_moved"; state = "reassigned"; effectiveAt = observedAt = date(entry.committedAt); resource = { assignment: entry.id }; basis = { assignment: lifecycleHash(entry), choice: row.digest, origin: origin.original.hash };
    } else {
      check(provenance === "sample" && row.kind === "return" && row.state === "returned" && row.executed_at && row.executed_id === `sample-return:${row.id}`); kind = "contribution_returned"; state = "returned"; effectiveAt = observedAt = date(row.executed_at); resource = { choice: row.id }; basis = { choice: row.digest, origin: origin.original.hash, effectiveAt };
    }
    transition = { kind }; signature = { state: row.state, receiptVersion: receipt.version };
  } else if (type === "external_return") {
    type ExternalRow = Parameters<typeof externalReturnRecord>[0];
    const [row] = await query<ExternalRow>("SELECT e.* FROM fp_funding_external_returns e JOIN fp_settlement_receipts r ON r.id=e.receipt_id AND r.tenant_id=e.tenant_id AND r.project_id=e.project_id JOIN fp_obligations o ON o.id=r.obligation_id AND o.tenant_id=r.tenant_id AND o.project_id=r.project_id WHERE e.tenant_id=$1 AND e.project_id=$2 AND o.actor_id=$3 AND e.id=$4", [...scopeValues(authority), id], tx);
    check(row); const value = verified(() => externalReturnRecord(row)), receipt = await ownReceipt(tx, authority, row.receipt_id), origin = await bindReceipt(receipt);
    const [reconciliation] = await query<{ encrypted_data: string; digest: string }>("SELECT encrypted_data,digest FROM fp_funding_reconciliations WHERE tenant_id=$1 AND project_id=$2 AND receipt_id=$3 AND id=$4 AND state='applied'", [row.tenant_id, row.project_id, row.receipt_id, row.reconciliation_id], tx); check(reconciliation);
    const attribution = open<{ observationId: string; observationDigest: string; returns: { id: string; amountMinor: number }[] }>(reconciliation.encrypted_data, `funding-reconciliation:${row.tenant_id}:${row.project_id}:${row.reconciliation_id}`); check(lifecycleHash(attribution) === reconciliation.digest && attribution.returns.some(item => item.id === value.providerRefundId && item.amountMinor === value.amountMinor));
    const [observation] = await query<{ encrypted_data: string; digest: string }>("SELECT encrypted_data,digest FROM fp_funding_return_observations WHERE tenant_id=$1 AND project_id=$2 AND receipt_id=$3 AND id=$4", [row.tenant_id, row.project_id, row.receipt_id, attribution.observationId], tx); check(observation && observation.digest === attribution.observationDigest);
    const evidence = open<ReturnObservationContract>(observation.encrypted_data, `funding-return-observation:${row.tenant_id}:${row.project_id}:${attribution.observationId}`); check(lifecycleHash(evidence) === observation.digest && evidence.evidence.captureId === receipt.data.actualProviderPaymentRef && evidence.evidence.provenance === provenance && evidence.evidence.refunds.some(item => item.id === value.providerRefundId && item.captureId === evidence.evidence.captureId && item.status === "COMPLETED" && item.amountMinor === value.amountMinor));
    kind = "contribution_returned"; state = "returned"; minor = value.amountMinor; effectiveAt = date(row.created_at); observedAt = date(evidence.evidence.observedAt); resource = { externalReturn: row.id }; transition = { kind }; basis = { original: origin.original.hash, digest: row.digest }; signature = { receiptVersion: receipt.version }; providerObserved = provenance === "live_sandbox";
    notices.push("This event time is the original application record that attributed the observed outside return. Its provider refund creation time is unavailable; the later observation is not substituted for that original transition.");
  } else if (type === "cancellation") {
    const [row] = await query<CaseRow>("SELECT * FROM fp_funding_cases WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND supersedes_id IS NULL", [authority.session.tenantId, authority.session.projectId, id], tx); check(row);
    const value = verified(() => caseContract(row));
    if (!value.sources.some(source => source.donorActorId === authority.session.actorId)) {
      const [unpaid] = await query<{ id: string }>("SELECT id FROM fp_purpose_pledges WHERE tenant_id=$1 AND project_id=$2 AND donor_actor_id=$3 AND package_id=$4 AND package_version=$5 AND state='cancelled' AND created_at<=$6 ORDER BY created_at,id LIMIT 1", [...scopeValues(authority), value.packageId, value.packageVersion, row.created_at], tx);
      check(unpaid); const original = await ownPledge(tx, authority, unpaid.id); check(original.value.title === value.title && Date.parse(original.value.acceptedAt) <= Date.parse(value.approvedAt));
    }
    kind = "purpose_cancelled"; state = "cancelled"; purpose = value.title; provenance = value.provenance; effectiveAt = observedAt = date(value.approvedAt); resource = { purpose: value.packageId, version: value.packageVersion }; transition = { kind }; basis = { digest: row.digest, effectiveAt }; signature = { state: row.state, version: row.version };
  } else if (type === "round_cancellation") {
    const [row] = await query<{ package_id: string; package_version: number; state: string; policy_hash: string; cancellation_requested_at: Date; consent_id: string }>("SELECT r.*,c.id consent_id FROM fp_collection_rounds r JOIN fp_conditional_consents c ON c.round_id=r.id AND c.tenant_id=r.tenant_id AND c.project_id=r.project_id AND c.package_id=r.package_id AND c.package_version=r.package_version WHERE r.tenant_id=$1 AND r.project_id=$2 AND c.actor_id=$3 AND r.id=$4 AND r.cancellation_reason='package_cancelled' AND r.cancellation_requested_at IS NOT NULL ORDER BY c.id LIMIT 1", [...scopeValues(authority), id], tx); check(row);
    const original = await conditional(tx, authority, row.consent_id); check(original.package_id === row.package_id && original.package_version === row.package_version);
    kind = "purpose_cancelled"; state = "cancelled"; purpose = CONDITIONAL_PACKAGE_TITLE; effectiveAt = observedAt = date(row.cancellation_requested_at); resource = { purpose: row.package_id, version: row.package_version }; transition = { kind }; basis = { round: id, original: original.policy_digest, policy: row.policy_hash, effectiveAt }; signature = { state: row.state };
  } else if (type === "purpose_closed") {
    const [row] = await query<{ policy_id: string; package_id: string; package_version: number; created_at: Date; digest: string; encrypted_data: string }>("SELECT f.id policy_id,f.package_id,f.package_version,f.digest,f.encrypted_data,a.created_at FROM fp_funding_actions a JOIN fp_funding_policies f ON f.id=a.result->>'id' AND f.tenant_id=a.tenant_id AND f.project_id=a.project_id WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.intent_id=$4 AND a.kind='purpose_window' AND f.state='closed' AND EXISTS(SELECT 1 FROM fp_purpose_pledges p WHERE p.policy_id=f.id AND p.donor_actor_id=$3 AND p.tenant_id=f.tenant_id AND p.project_id=f.project_id AND p.state='cancelled')", [...scopeValues(authority), id], tx); check(row);
    const value = open<{ id: string; tenantId: string; projectId: string; packageId: string; packageVersion: number; title: string; provenance: C.LifecycleProvenance }>(row.encrypted_data, `funding-policy:${authority.session.tenantId}:${authority.session.projectId}:${row.policy_id}`); check(lifecycleHash(value) === row.digest && value.id === row.policy_id && value.tenantId === authority.session.tenantId && value.projectId === authority.session.projectId && value.packageId === row.package_id && value.packageVersion === row.package_version);
    kind = "purpose_cancelled"; state = "cancelled"; purpose = value.title; provenance = value.provenance; effectiveAt = observedAt = date(row.created_at); resource = { purpose: row.package_id, version: row.package_version }; transition = { kind }; basis = { policy: row.digest, effectiveAt }; signature = { state: "closed" };
  } else {
    check(authority.session.role === "volunteer");
    let payableId = id;
    const [record] = type === "payout_observation" ? await query<{ payable_id: string; kind: string; outcome: string; body_hash: string; encrypted_data: string; created_at: Date }>("SELECT o.* FROM fp_payout_observations o JOIN fp_payables p ON p.id=o.payable_id JOIN fp_claims c ON c.id=p.claim_id AND c.tenant_id=p.tenant_id AND c.project_id=p.project_id WHERE p.tenant_id=$1 AND p.project_id=$2 AND c.actor_id=$3 AND o.id=$4", [...scopeValues(authority), id], tx) : [];
    if (type === "payout_observation") { check(record); payableId = record.payable_id; }
    const { row, data, document: pinned } = await ownPayable(tx, authority, payableId); document = pinned; minor = amount(row.amount_minor); provenance = authority.session.mode; check(provenance === "live_sandbox");
    resource = { payable: row.id }; signature = { state: row.state, paid: row.principal_paid_at ? date(row.principal_paid_at) : null, returned: row.principal_returned_at ? date(row.principal_returned_at) : null };
    if (type === "payout_dispatch") {
      check(row.first_dispatched_at && (retained || !row.principal_paid_at && !row.principal_returned_at && !["failed", "cancelled", "refused", "not_sent"].includes(row.state)));
      kind = "repayment_pending"; state = "pending"; effectiveAt = observedAt = date(row.first_dispatched_at);
    } else {
      check(record); const result = open<CommerceRestResult<PayoutItemObservation>>(record.encrypted_data, `payout-observation:${authority.session.tenantId}:${authority.session.projectId}:${row.id}:${id}`);
      check(lifecycleHash(result) === record.body_hash && result.outcome === record.outcome && result.source === "live_sandbox" && row.first_dispatched_at);
      observedAt = effectiveAt = date(result.observedAt);
      if (record.kind === "item_read" && result.outcome === "succeeded") {
        const item = result.value, expected = data.request.items[0];
        check(item && safeProviderId(item.id) && item.id === data.itemId && item.batchId === data.batchId && sha256(item.id) === row.item_hash && sha256(item.batchId) === row.batch_hash && item.senderItemId === expected.senderItemId && item.recipientType === expected.recipientType && item.receiver === expected.receiver && item.money?.currency === "USD" && item.money.minor === minor);
        if (item.status === "SUCCESS") { check(row.principal_paid_at && safeProviderId(item.transactionId)); kind = "repayment_completed"; state = "completed"; effectiveAt = date(row.principal_paid_at); }
        else if (["RETURNED", "REFUNDED", "CANCELED", "FAILED"].includes(item.status)) {
          check(row.principal_returned_at); effectiveAt = date(row.principal_returned_at);
          if (row.principal_paid_at && item.status !== "FAILED") { check(await observedPriorDelivery(tx, authority, row, data, effectiveAt, asOf)); kind = "repayment_returned"; state = "returned"; }
          else { kind = "repayment_failed"; state = "failed"; }
        } else if (["PENDING", "PROCESSING", "NEW"].includes(item.status)) { check(retained || !row.principal_paid_at && !row.principal_returned_at); kind = "repayment_pending"; state = "pending"; }
        else if (["UNCLAIMED", "ONHOLD", "HELD", "BLOCKED"].includes(item.status)) { check(retained || !row.principal_paid_at && !row.principal_returned_at); kind = "repayment_action_required"; state = "action_required"; }
        else { check(retained || !row.principal_paid_at && !row.principal_returned_at); kind = "repayment_unknown"; state = "unknown"; }
        providerObserved = true;
      } else {
        check(["create", "batch_read", "item_read"].includes(record.kind) && (retained || !row.principal_paid_at && !row.principal_returned_at));
        if (record.kind === "create" && ["refused", "not_sent"].includes(result.outcome)) { kind = "repayment_failed"; state = "failed"; }
        else { kind = "repayment_unknown"; state = "unknown"; }
      }
    }
    transition = { kind }; basis = { requestHash: row.request_hash, kind, effectiveAt, observation: type === "payout_observation" ? id : null, document: pinned };
  }
  check(resource !== undefined && transition !== undefined && basis !== undefined && signature !== undefined);
  const fact = lifecycleEventFactSchema.parse({ kind, recipientBindingHash: lifecycleRecipient(authority), role: authority.session.role, project, resourceKey: lifecycleHash(resource), transitionKey: lifecycleHash(transition), sourceHash: lifecycleHash(basis), state, effectiveAt, observedAt, provenance, sourceClass: sourceClass(provenance, providerObserved), amount: minor === null ? null : { currency: project.currency, minor }, purpose });
  check(Date.parse(fact.effectiveAt) <= Date.parse(asOf) && Date.parse(fact.observedAt) <= Date.parse(asOf));
  return { version: "personal-source-v1", descriptor, fact, currentSignature: lifecycleHash(signature), document, accounting, ...(notices.length ? { notices } : {}) };
}

/** Revalidates only the captured source, under independently current original
 * recipient authority. No original body, URL or provider identity is returned. */
export async function checkLifecyclePersonalSource(tx: OrgTx, authority: OrganizationProjectAuthority, saved: LifecyclePersonalSource, asOf: string): Promise<{ status: "current" | "historical" | "withdrawn" | "unavailable"; reasons: string[] }> {
  try {
    check(saved.version === "personal-source-v1" && saved.fact.recipientBindingHash === lifecycleRecipient(authority) && saved.fact.role === authority.session.role && saved.fact.project.id === authority.session.projectId);
    const current = await load(tx, authority, descriptorSchema.parse(saved.descriptor), asOf, true);
    if (saved.document && lifecycleHash(saved.document) !== lifecycleHash(current.document)) throw new WithdrawnSource("The exact original source permission or document version changed.");
    const semantic = (fact: LifecycleEventFact) => ({ ...fact, project: { id: fact.project.id, currency: fact.project.currency, mode: fact.project.mode } });
    check(lifecycleEventKey(current.fact) === lifecycleEventKey(saved.fact) && current.fact.sourceHash === saved.fact.sourceHash && lifecycleHash(semantic(current.fact)) === lifecycleHash(semantic(saved.fact)));
    return current.currentSignature === saved.currentSignature && lifecycleHash(current.fact.project) === lifecycleHash(saved.fact.project) ? { status: "current", reasons: [] } : { status: "historical", reasons: ["This is the immutable earlier event. Later source changes remain in the original record."] };
  } catch (error) {
    if (error instanceof WithdrawnSource) return { status: "withdrawn", reasons: ["The original private source or permission changed. Its previously captured body and preview are withheld."] };
    if (error instanceof UnavailableSource || error instanceof z.ZodError) return { status: "unavailable", reasons: ["The original event can no longer be verified in this exact permitted source scope."] };
    throw error;
  }
}
