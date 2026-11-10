import { randomUUID } from "node:crypto";
import { canonicalJson, sha256, type CommerceRestResult, type DraftInvoice, type InvoiceObservation, type ProviderAdapter, type SqlConnection } from "@fracture/paypal-core";
import type { SettlementReceipt } from "../contracts";
import { assertBalanced, DomainError, fundingTotals, splitSettlement, validateReceipt } from "../domain/money";
import { safeApprovalUrl } from "../domain/consent";
import type { Session } from "./auth";
import { commerceGateway, invoicePaymentReader, type CommerceGateway, type InvoicePaymentReader, type InvoiceCaptureEvidence } from "./commerce";
import { ownedWallet, type ConsentRow } from "./commitments";
import { definitiveCollectionDecline } from "./collections";
import { refreshRoundFunding } from "./collection-projection";
import { database, initializeDatabase, query } from "./db";
import { requireCurrentRole, requireMembership } from "./membership";
import { ingestOwnedOrderRead, paymentStore, paypalProvider, providerConfiguration } from "./payments";
import { openPrivate, sealPrivate } from "./private-values";
import { claimExternalOperation, dispatchExternalOperation, finishExternalOperation, type ExternalOperation } from "./provider-operations";
import { appendEvent } from "./repository";
import { vaultGateway, type VaultGateway } from "./vault";

type InvoiceGateway = Pick<CommerceGateway, "createInvoice" | "getInvoice" | "findInvoices" | "sendInvoice" | "cancelInvoice">;
export interface RecoveryDependencies { gateway: InvoiceGateway; reader: InvoicePaymentReader; vault: VaultGateway; payments: ProviderAdapter }
function dependencies(): RecoveryDependencies { return { gateway: commerceGateway(), reader: invoicePaymentReader, vault: vaultGateway(), payments: paypalProvider() }; }
interface RecoveryPrivate { request: DraftInvoice; observation?: InvoiceObservation; observationHash?: string }
interface InvoiceRow {
  id: string; tenant_id: string; project_id: string; round_id: string; consent_id: string; obligation_id: string;
  actor_id: string; created_by: string; creator_membership_version: number; consent_version: number; consent_digest: string;
  package_version: number; amount_minor: string; invoice_number: string; reference: string; state: string; version: number;
  encrypted_data: string; recipient_label: string; last_code: string | null; observed_at: Date | null; created_at: Date;
}
interface SourceRow extends ConsentRow { round_state: string; recovery_ends_at: Date; current_package_version: number; operation_id: string | null }
export interface RecoveryInvoiceView {
  id: string; consentId: string; obligationId: string; amountMinor: number; state: string; providerState: string | null;
  recipientLabel: string; payerUrl: string | null; observedAt: string | null; recoveryEndsAt: string; lastCode: string | null;
  collectedMinor: number; paymentEvidencePending: boolean; canShare: boolean; canCancel: boolean;
}
function context(row: Pick<InvoiceRow, "id" | "tenant_id" | "project_id">) { return `recovery-invoice:${row.tenant_id}:${row.project_id}:${row.id}`; }
function privateInvoice(row: InvoiceRow): RecoveryPrivate { return openPrivate<RecoveryPrivate>(row.encrypted_data, context(row)); }
function sessionScope(session: Session) {
  if (session.mode !== "live_sandbox" || !["donor", "organizer"].includes(session.role)) throw new DomainError("ROLE_DENIED", "A current donor or organizer must approve this exact recovery invoice.", 403);
}
async function source(scope: Pick<Session, "tenantId" | "projectId">, consentId: string, tx: SqlConnection = database(), lock = false): Promise<SourceRow> {
  if (lock) await tx.query("SELECT r.id FROM fp_collection_rounds r JOIN fp_conditional_consents c ON c.round_id=r.id WHERE c.id=$1 AND r.tenant_id=$2 AND r.project_id=$3 FOR UPDATE OF r", [consentId, scope.tenantId, scope.projectId]);
  const [row] = await query<SourceRow>(`SELECT c.*,o.channel,r.state round_state,r.recovery_ends_at,p.version current_package_version,i.operation_id
    FROM fp_conditional_consents c JOIN fp_obligations o ON o.id=c.obligation_id
    JOIN fp_collection_rounds r ON r.id=c.round_id JOIN fp_collection_items i ON i.consent_id=c.id AND i.round_id=r.id
    JOIN fp_packages p ON p.project_id=c.project_id AND p.id=c.package_id
    WHERE c.id=$1 AND c.tenant_id=$2 AND c.project_id=$3 ${lock ? "FOR UPDATE OF c,o,i" : ""}`, [consentId, scope.tenantId, scope.projectId], tx);
  if (!row) throw new DomainError("RECOVERY_NOT_FOUND", "This contribution has no owned frozen collection round.", 404);
  return row;
}
async function authorizeSession(session: Session, row: SourceRow, tx: SqlConnection = database()) {
  sessionScope(session);
  const authority = await requireCurrentRole(session, session.role, tx);
  if (session.role === "donor" && row.actor_id !== session.actorId) throw new DomainError("RECOVERY_NOT_FOUND", "This contribution does not belong to you.", 404);
  await requireMembership(session.tenantId, session.projectId, row.actor_id, "donor", tx);
  return authority;
}
function assertWindow(row: SourceRow, first: boolean) {
  if (!["collecting", "recovering"].includes(row.round_state) || row.recovery_ends_at.getTime() - Date.now() <= 60000 || row.expires_at.getTime() <= Date.now()) throw new DomainError("RECOVERY_WINDOW_CLOSED", "There is not enough time to open a new provider payment before the original collection deadline.");
  if (row.withdrawn_at || row.package_version !== row.current_package_version) throw new DomainError("CONSENT_CHANGED", "The original contribution or package approval changed.");
  if (row.channel !== (first ? "definitively_declined" : "recovery_invoice_open")) throw new DomainError("RECOVERY_CHANNEL_BLOCKED", "Resolve the original payment outcome before opening another payment channel.");
}
async function invoiceRow(scope: Pick<Session, "tenantId" | "projectId">, id: string, tx: SqlConnection = database(), lock = false): Promise<InvoiceRow> {
  const [row] = await query<InvoiceRow>(`SELECT * FROM fp_recovery_invoices WHERE id=$1 AND tenant_id=$2 AND project_id=$3 ${lock ? "FOR UPDATE" : ""}`, [id, scope.tenantId, scope.projectId], tx);
  if (!row) throw new DomainError("INVOICE_NOT_FOUND", "That recovery invoice is outside this project.", 404);
  return row;
}
function matches(row: InvoiceRow, observation: InvoiceObservation): boolean {
  const saved = privateInvoice(row), priorId = saved.observation?.id;
  return (!priorId || priorId === observation.id) && observation.invoiceNumber === row.invoice_number && observation.reference === row.reference
    && observation.money?.currency === "USD" && observation.money.minor === Number(row.amount_minor)
    && observation.recipientEmails.length === 1 && observation.recipientEmails[0].toLowerCase() === saved.request.recipientEmail.toLowerCase();
}
async function preserveResult(row: InvoiceRow, result: CommerceRestResult<InvoiceObservation>, operation?: ExternalOperation): Promise<boolean> {
  return database().transaction(async tx => {
    const current = await invoiceRow({ tenantId: row.tenant_id, projectId: row.project_id }, row.id, tx, true);
    if (result.outcome !== "succeeded" || !matches(current, result.value)) {
      const code = result.outcome === "succeeded" ? "INVOICE_IDENTITY_UNPROVEN" : result.code;
      if (operation) await finishExternalOperation(tx, operation.id, result.outcome === "succeeded" ? "unknown" : result.outcome, { code, httpStatus: result.httpStatus ?? undefined });
      await tx.query("UPDATE fp_recovery_invoices SET last_code=$2,state=CASE WHEN state IN ('paid','cancelled') THEN state ELSE 'review_required' END WHERE id=$1", [row.id, code]);
      return false;
    }
    const bodyHash = sha256(canonicalJson(result.value)), saved: RecoveryPrivate = { ...privateInvoice(current), observation: result.value, observationHash: bodyHash };
    const providerState = result.value.status;
    const state = ["CANCELLED", "AUTO_CANCELLED"].includes(providerState) ? "cancelled" : ["PAID", "PARTIALLY_PAID", "PAYMENT_PENDING", "MARKED_AS_PAID", "REFUNDED", "PARTIALLY_REFUNDED"].includes(providerState) ? "payment_evidence_pending" : providerState === "DRAFT" ? "draft" : ["SENT", "SHARED", "UNPAID"].includes(providerState) ? "open" : "review_required";
    await tx.query("UPDATE fp_recovery_invoices SET provider_invoice_hash=$2,encrypted_data=$3,state=CASE WHEN state='paid' AND $4='payment_evidence_pending' THEN state ELSE $4 END,observed_at=$5,last_code=NULL WHERE id=$1", [row.id, sha256(result.value.id), sealPrivate(saved, context(current)), state, result.observedAt]);
    if (operation) await finishExternalOperation(tx, operation.id, "succeeded", { httpStatus: result.httpStatus ?? undefined, observation: { bodyHash, providerState, recovered: result.recovered } });
    return true;
  });
}
export async function recoveryInvoiceView(session: Session, id: string): Promise<RecoveryInvoiceView> {
  const row = await invoiceRow(session, id);
  await requireMembership(session.tenantId, session.projectId, session.actorId, session.role);
  if (row.actor_id !== session.actorId && !["organizer", "auditor"].includes(session.role)) throw new DomainError("INVOICE_NOT_FOUND", "That recovery invoice does not belong to you.", 404);
  const origin = await source(session, row.consent_id), saved = privateInvoice(row);
  const receipts = (await query<{ data: SettlementReceipt }>("SELECT data FROM fp_settlement_receipts WHERE obligation_id=$1", [row.obligation_id])).map(item => item.data);
  const totals = fundingTotals(receipts, Number(row.amount_minor), "live_sandbox"), active = origin.recovery_ends_at.getTime() > Date.now() && ["collecting", "recovering"].includes(origin.round_state);
  return { id: row.id, consentId: row.consent_id, obligationId: row.obligation_id, amountMinor: Number(row.amount_minor), state: row.state, providerState: saved.observation?.status ?? null,
    recipientLabel: row.recipient_label, payerUrl: row.actor_id === session.actorId && active && row.state === "open" ? safeApprovalUrl(saved.observation?.payerUrl ?? undefined) : null,
    observedAt: row.observed_at?.toISOString() ?? null, recoveryEndsAt: origin.recovery_ends_at.toISOString(), lastCode: row.last_code, collectedMinor: totals.collectedMinor,
    paymentEvidencePending: row.state === "payment_evidence_pending", canShare: active && row.state === "draft" && ["donor", "organizer"].includes(session.role), canCancel: row.state === "open" && ["donor", "organizer"].includes(session.role) };
}
export async function recoveryInvoiceViews(session: Session): Promise<RecoveryInvoiceView[]> {
  await requireMembership(session.tenantId, session.projectId, session.actorId, session.role);
  const rows = await query<{ id: string }>("SELECT id FROM fp_recovery_invoices WHERE tenant_id=$1 AND project_id=$2 AND ($3::boolean OR actor_id=$4) ORDER BY created_at", [session.tenantId, session.projectId, ["organizer", "auditor"].includes(session.role), session.actorId]);
  return Promise.all(rows.map(row => recoveryInvoiceView(session, row.id)));
}
async function proveOriginalDecline(row: SourceRow, deps: RecoveryDependencies): Promise<void> {
  if (!row.operation_id) throw new DomainError("ORIGINAL_OUTCOME_UNPROVEN", "The original payment has no authoritative operation record.");
  const operation = await paymentStore().get({ tenantId: row.tenant_id, projectId: row.project_id }, row.operation_id);
  if (!operation) throw new DomainError("ORIGINAL_OUTCOME_UNPROVEN", "The original payment outcome must be reconciled first.");
  const order = operation.receipt?.resources.find(item => item.kind === "order");
  let resources = operation.receipt?.resources ?? [];
  if (order) { resources = await deps.payments.read("order", order.id, AbortSignal.timeout(15000)); await ingestOwnedOrderRead(order.id, resources); }
  if (!definitiveCollectionDecline(operation, resources)) throw new DomainError("ORIGINAL_OUTCOME_UNPROVEN", "The original payment has not been definitively declined. An unknown outcome cannot open an invoice.");
}
export async function createRecoveryInvoice(session: Session, input: { consentId: string; expectedVersion: number; acknowledged: true }, deps: RecoveryDependencies = dependencies()): Promise<RecoveryInvoiceView> {
  await initializeDatabase();
  let origin = await source(session, input.consentId);
  await authorizeSession(session, origin);
  if (!input.acknowledged || origin.version !== input.expectedVersion) throw new DomainError("CONSENT_CHANGED", "Review this exact original contribution before opening its recovery invoice.");
  const [existing] = await query<{ id: string }>("SELECT id FROM fp_recovery_invoices WHERE obligation_id=$1", [origin.obligation_id]);
  if (existing) return recoveryInvoiceView(session, existing.id);
  assertWindow(origin, true);
  await proveOriginalDecline(origin, deps);
  const wallet = ownedWallet(origin);
  if (!wallet.tokenId) throw new DomainError("RECIPIENT_UNPROVEN", "The original supporter wallet is unavailable.");
  const token = await deps.vault.readToken(wallet.tokenId);
  const paypal = token.outcome === "succeeded" ? token.value.paymentSource?.paypal : undefined;
  if (token.outcome !== "succeeded" || token.value.id !== wallet.tokenId || !wallet.payerId || paypal?.payerId !== wallet.payerId || !paypal.emailAddress || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(paypal.emailAddress)) throw new DomainError("RECIPIENT_UNPROVEN", "PayPal must confirm the original participant's invoice address before this recovery can open.");
  const merchantEmail = process.env.PAYPAL_SANDBOX_SELLER_EMAIL;
  if (!merchantEmail) throw new DomainError("INVOICE_NOT_CONFIGURED", "The isolated merchant's invoicing profile is not configured.", 503);
  const claim = await database().transaction(async tx => {
    origin = await source(session, input.consentId, tx, true);
    const authority = await authorizeSession(session, origin, tx);
    const [prior] = await query<{ id: string }>("SELECT id FROM fp_recovery_invoices WHERE obligation_id=$1", [origin.obligation_id], tx);
    if (prior) return { existingId: prior.id };
    assertWindow(origin, true);
    const receipts = await query("SELECT id FROM fp_settlement_receipts WHERE obligation_id=$1", [origin.obligation_id], tx);
    if (receipts.length) throw new DomainError("RECOVERY_CHANNEL_BLOCKED", "A settlement already exists for this contribution; reconcile it before recovery.");
    const id = randomUUID(), invoiceNumber = `FP-${sha256(origin.obligation_id).slice(0, 20)}`, reference = `fieldproof:${sha256(origin.obligation_id)}`;
    const request: DraftInvoice = { invoiceNumber, reference, merchantEmail, recipientEmail: paypal.emailAddress!, itemName: "Electronics Benches — original conditional contribution", money: { currency: "USD", minor: Number(origin.amount_minor) } };
    const rowContext = { id, tenant_id: session.tenantId, project_id: session.projectId };
    await tx.query(`INSERT INTO fp_recovery_invoices(id,tenant_id,project_id,round_id,consent_id,obligation_id,actor_id,created_by,creator_membership_version,consent_version,consent_digest,package_version,amount_minor,invoice_number,reference,encrypted_data,recipient_label)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [id, session.tenantId, session.projectId, origin.round_id, origin.id, origin.obligation_id, origin.actor_id, session.actorId, authority.membershipVersion, origin.version, origin.policy_digest, origin.package_version, origin.amount_minor, invoiceNumber, reference, sealPrivate({ request }, context(rowContext)), origin.wallet_label ?? "Your PayPal account"]);
    await tx.query("UPDATE fp_obligations SET channel='recovery_invoice_open' WHERE id=$1", [origin.obligation_id]);
    await tx.query("UPDATE fp_collection_items SET state='recovery_invoice_open' WHERE consent_id=$1", [origin.id]);
    const operation = await claimExternalOperation(tx, { tenantId: session.tenantId, projectId: session.projectId, actorId: session.actorId, resourceId: id, kind: "invoice.create", businessKey: `recovery:${id}:create`, payload: request });
    if (!(await dispatchExternalOperation(tx, operation))) throw new DomainError("INVOICE_CLAIMED", "The original invoice operation is already recorded.");
    await appendEvent(tx, session, "recovery.invoice_requested", "A recovery path for the same contribution", "The original declined obligation owns one exact recovery invoice. Its amount and 48-hour deadline are unchanged; creating a draft does not collect money.");
    return { row: await invoiceRow(session, id, tx), operation, request };
  });
  if ("existingId" in claim) return recoveryInvoiceView(session, claim.existingId!);
  await preserveResult(claim.row, await deps.gateway.createInvoice(claim.request, AbortSignal.timeout(25000)), claim.operation);
  return recoveryInvoiceView(session, claim.row.id);
}

export async function shareRecoveryInvoice(session: Session, id: string, deps: RecoveryDependencies = dependencies()): Promise<RecoveryInvoiceView> {
  const row = await invoiceRow(session, id);
  const claim = await database().transaction(async tx => {
    const origin = await source(session, row.consent_id, tx, true);
    await authorizeSession(session, origin, tx);
    assertWindow(origin, false);
    const current = await invoiceRow(session, id, tx, true), saved = privateInvoice(current);
    if (current.consent_version !== origin.version || current.consent_digest !== origin.policy_digest || current.package_version !== origin.current_package_version) throw new DomainError("CONSENT_CHANGED", "This invoice no longer matches the original consent and plan.");
    if (!saved.observation || !matches(current, saved.observation)) throw new DomainError("INVOICE_IDENTITY_UNPROVEN", "Read and verify the original provider invoice before sharing it.");
    if (current.state === "open" || current.state === "paid") return null;
    if (current.state !== "draft") throw new DomainError("INVOICE_STATE_UNPROVEN", "The provider invoice must be a confirmed draft before sharing.");
    const owned = { id: saved.observation.id, invoiceNumber: current.invoice_number, reference: current.reference };
    const operation = await claimExternalOperation(tx, { tenantId: session.tenantId, projectId: session.projectId, actorId: session.actorId, resourceId: id, kind: "invoice.share", businessKey: `recovery:${id}:share`, payload: { owned, consentDigest: current.consent_digest, amountMinor: Number(current.amount_minor), notifications: false } });
    return await dispatchExternalOperation(tx, operation) ? { row: current, operation, owned } : null;
  });
  if (claim) {
    const saved = await preserveResult(claim.row, await deps.gateway.sendInvoice(claim.owned, AbortSignal.timeout(25000)), claim.operation);
    if (saved) await database().transaction(tx => appendEvent(tx, session, "recovery.invoice_shared", "Your original contribution has a PayPal recovery link", "The share link belongs to the same amount and obligation. No email notification was requested, and sharing is not payment evidence."));
  }
  return recoveryInvoiceView(session, id);
}

async function recordPaymentObservation(row: InvoiceRow, paymentId: string, state: string, observation: unknown): Promise<void> {
  const identityHash = sha256(paymentId), bodyHash = sha256(canonicalJson(observation));
  await query(`INSERT INTO fp_invoice_payment_observations(id,invoice_id,payment_identity_hash,state,body_hash,encrypted_data)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(invoice_id,payment_identity_hash,body_hash) DO NOTHING`,
  [randomUUID(), row.id, identityHash, state, bodyHash, sealPrivate(observation, `invoice-payment:${row.tenant_id}:${row.id}:${identityHash}`)]);
}

async function creditInvoicePayment(row: InvoiceRow, invoice: InvoiceObservation, capture: InvoiceCaptureEvidence): Promise<void> {
  await database().transaction(async tx => {
    const origin = await source({ tenantId: row.tenant_id, projectId: row.project_id }, row.consent_id, tx, true);
    const current = await invoiceRow({ tenantId: row.tenant_id, projectId: row.project_id }, row.id, tx, true);
    if (!matches(current, invoice)) throw new DomainError("INVOICE_IDENTITY_UNPROVEN", "The invoice payment no longer matches its exact recovery record.");
    const merchantScope = sha256(providerConfiguration().clientId), aliases = [`paypal:capture:${capture.id}`, `paypal:invoice_payment:${invoice.id}:${capture.id}`];
    const existing = await query<{ id: string; obligation_id: string; data: SettlementReceipt }>(`SELECT DISTINCT r.id,r.obligation_id,r.data FROM fp_economic_aliases a JOIN fp_settlement_receipts r ON r.id=a.receipt_id WHERE a.merchant_scope=$1 AND a.alias=ANY($2::text[])`, [merchantScope, aliases], tx);
    if (existing.length) {
      if (existing.length !== 1 || existing[0].obligation_id !== row.obligation_id) throw new DomainError("PAYMENT_OWNER_CONFLICT", "This economic payment is already assigned to a different obligation.");
      const receipt = existing[0].data;
      if (receipt.grossSettledMinor !== capture.money.minor || receipt.currency !== capture.money.currency) throw new DomainError("PAYMENT_AMOUNT_CONFLICT", "The already recorded payment has contradictory amount evidence.");
      for (const alias of aliases) await tx.query("INSERT INTO fp_economic_aliases(merchant_scope,alias,receipt_id) VALUES($1,$2,$3) ON CONFLICT(merchant_scope,alias) DO NOTHING", [merchantScope, alias, receipt.id]);
      receipt.economicAliases = [...new Set([...receipt.economicAliases, ...aliases])];
      receipt.sourceInvoiceId = invoice.id;
      await tx.query("UPDATE fp_settlement_receipts SET data=$2::jsonb WHERE id=$1", [receipt.id, JSON.stringify(receipt)]);
    } else {
      const prior = (await query<{ data: SettlementReceipt }>("SELECT data FROM fp_settlement_receipts WHERE obligation_id=$1", [row.obligation_id], tx)).map(item => item.data);
      const split = splitSettlement(capture.money.minor, Number(row.amount_minor), prior.reduce((sum, receipt) => sum + receipt.creditedMinor, 0));
      const receipt: SettlementReceipt = { id: randomUUID(), tenantId: row.tenant_id, projectId: row.project_id, packageId: origin.package_id, donorObligationId: row.obligation_id,
        sourceKind: "invoice_payment", provenance: "live_sandbox", actualProviderPaymentRef: capture.id, economicAliases: aliases, sourceOrderId: capture.orderId,
        sourceInvoiceId: invoice.id, authoritativeObservedState: "COMPLETED", observedAt: capture.observedAt, currency: "USD", grossSettledMinor: capture.money.minor, ...split,
        completedAttributedRefundMinor: 0, pendingAttributedRefundReserveMinor: 0, excludedMinor: ["compensating", "cancelled"].includes(origin.round_state) || origin.recovery_ends_at.getTime() <= Date.now() ? split.creditedMinor : 0,
        provenRefundableRef: capture.id, refundAdapter: "capture_refund" };
      validateReceipt(receipt);
      const entries = [{ account: "paypal_clearing", side: "debit" as const, amountMinor: receipt.grossSettledMinor }, { account: "package_funds", side: "credit" as const, amountMinor: receipt.creditedMinor }, { account: "excess_refund_liability", side: "credit" as const, amountMinor: receipt.excessLiabilityMinor }];
      assertBalanced(entries);
      await tx.query("INSERT INTO fp_settlement_receipts(id,tenant_id,project_id,obligation_id,package_id,provider_ref,provenance,data) VALUES($1,$2,$3,$4,$5,$6,'live_sandbox',$7::jsonb)", [receipt.id, row.tenant_id, row.project_id, row.obligation_id, origin.package_id, capture.id, JSON.stringify(receipt)]);
      for (const alias of aliases) await tx.query("INSERT INTO fp_economic_aliases(merchant_scope,alias,receipt_id) VALUES($1,$2,$3)", [merchantScope, alias, receipt.id]);
      for (const entry of entries) if (entry.amountMinor) await tx.query("INSERT INTO fp_journal(id,tenant_id,project_id,receipt_id,account,side,amount_minor,currency) VALUES($1,$2,$3,$4,$5,$6,$7,'USD')", [randomUUID(), row.tenant_id, row.project_id, receipt.id, entry.account, entry.side, entry.amountMinor]);
      await appendEvent(tx, { tenantId: row.tenant_id, projectId: row.project_id, mode: "live_sandbox" }, "recovery.payment_confirmed", "PayPal confirmed the recovery payment", "The invoice transaction and its independently read payment resource share one canonical receipt and one balanced journal.");
    }
    const receipts = (await query<{ data: SettlementReceipt }>("SELECT data FROM fp_settlement_receipts WHERE obligation_id=$1", [row.obligation_id], tx)).map(item => item.data);
    const totals = fundingTotals(receipts, Number(row.amount_minor), "live_sandbox"), settled = totals.collectedMinor >= Number(row.amount_minor);
    const compensating = ["compensating", "cancelled"].includes(origin.round_state) || ["collecting", "recovering"].includes(origin.round_state) && origin.recovery_ends_at.getTime() <= Date.now();
    const state = compensating ? "compensating" : totals.excessLiabilityMinor ? "excess_reconciliation" : settled ? "collected" : "recovery_invoice_open";
    await tx.query("UPDATE fp_obligations SET channel=$2 WHERE id=$1", [row.obligation_id, state]);
    await tx.query("UPDATE fp_collection_items SET state=$2 WHERE consent_id=$1", [row.consent_id, state]);
    if (settled) {
      await tx.query("UPDATE fp_recovery_invoices SET state='paid',last_code=NULL WHERE id=$1", [row.id]);
      await tx.query("UPDATE fp_conditional_consents SET status=$2 WHERE id=$1", [row.consent_id, compensating ? "refunding" : "collected"]);
    }
    if (totals.excessLiabilityMinor) await tx.query("INSERT INTO fp_outbox(id,tenant_id,project_id,kind,data) VALUES($1,$2,$3,'collection.excess',$4::jsonb) ON CONFLICT(id) DO NOTHING", [`excess:${row.obligation_id}`, row.tenant_id, row.project_id, JSON.stringify({ roundId: row.round_id, obligationId: row.obligation_id })]);
    if (compensating) {
      await tx.query("UPDATE fp_collection_rounds SET state='compensating' WHERE id=$1 AND state='cancelled'", [row.round_id]);
      await tx.query("INSERT INTO fp_outbox(id,tenant_id,project_id,kind,data) VALUES($1,$2,$3,'collection.compensate',$4::jsonb) ON CONFLICT(id) DO UPDATE SET status='queued',available_at=now()", [`compensate:${row.round_id}`, row.tenant_id, row.project_id, JSON.stringify({ roundId: row.round_id })]);
    }
    await refreshRoundFunding(tx, row.round_id);
  });
}

async function reconcileInvoice(row: InvoiceRow, deps: RecoveryDependencies): Promise<void> {
  const saved = privateInvoice(row);
  let result: CommerceRestResult<InvoiceObservation>;
  if (saved.observation) result = await deps.gateway.getInvoice(saved.observation.id, AbortSignal.timeout(20000));
  else {
    const found = await deps.gateway.findInvoices({ invoiceNumber: row.invoice_number, reference: row.reference }, AbortSignal.timeout(25000));
    if (found.outcome !== "succeeded") { await preserveResult(row, found); return; }
    if (found.value.length !== 1) { await query("UPDATE fp_recovery_invoices SET state='review_required',last_code=$2 WHERE id=$1", [row.id, found.value.length ? "INVOICE_IDENTITY_AMBIGUOUS" : "ORIGINAL_INVOICE_NOT_LOCATED"]); return; }
    result = { ...found, value: found.value[0], recovered: true };
  }
  if (!(await preserveResult(row, result)) || result.outcome !== "succeeded") return;
  const invoice = result.value;
  let unproved = false;
  for (const payment of invoice.payments) {
    const paymentId = payment.id ?? sha256(canonicalJson(payment));
    if (payment.type !== "PAYPAL" || !payment.id || payment.money?.currency !== "USD" || payment.money.minor <= 0) {
      await recordPaymentObservation(row, paymentId, "not_confirmed_provider_money", payment); unproved = true; continue;
    }
    const read = await deps.reader.readCapture(payment.id);
    if (read.outcome !== "succeeded" || read.value.source !== "live_sandbox" || read.value.id !== payment.id || read.value.status !== "COMPLETED"
      || read.value.money.currency !== payment.money.currency || read.value.money.minor !== payment.money.minor
      || read.value.invoiceId && ![invoice.id, invoice.invoiceNumber].includes(read.value.invoiceId)
      || read.value.merchantEmail && read.value.merchantEmail.toLowerCase() !== saved.request.merchantEmail.toLowerCase()) {
      await recordPaymentObservation(row, paymentId, "payment_rail_unproven", { payment, read }); unproved = true; continue;
    }
    await recordPaymentObservation(row, payment.id, "corroborated_capture", { payment, capture: read.value, invoiceBodyHash: sha256(canonicalJson(invoice)) });
    await creditInvoicePayment(row, invoice, read.value);
  }
  if (unproved || ["PAID", "PARTIALLY_PAID", "PAYMENT_PENDING", "MARKED_AS_PAID"].includes(invoice.status) && !invoice.payments.length) await query("UPDATE fp_recovery_invoices SET state=CASE WHEN state='paid' THEN state ELSE 'payment_evidence_pending' END,last_code='PAYMENT_RAIL_UNCONFIRMED' WHERE id=$1", [row.id]);
  if (invoice.refunds.length) await query("UPDATE fp_recovery_invoices SET last_code='REFUND_LINEAGE_REQUIRES_CORROBORATION' WHERE id=$1", [row.id]);
}
export async function checkRecoveryInvoice(session: Session, id: string, deps: RecoveryDependencies = dependencies()): Promise<RecoveryInvoiceView> {
  await recoveryInvoiceView(session, id);
  await reconcileInvoice(await invoiceRow(session, id), deps);
  return recoveryInvoiceView(session, id);
}
export async function cancelRecoveryInvoice(session: Session, id: string, deps: RecoveryDependencies = dependencies()): Promise<RecoveryInvoiceView> {
  const row = await invoiceRow(session, id), origin = await source(session, row.consent_id);
  await authorizeSession(session, origin);
  await reconcileInvoice(row, deps);
  const claim = await database().transaction(async tx => {
    const currentOrigin = await source(session, row.consent_id, tx, true);
    await authorizeSession(session, currentOrigin, tx);
    const current = await invoiceRow(session, id, tx, true), saved = privateInvoice(current);
    if (current.state === "cancelled") return null;
    if (current.state !== "open" || !saved.observation) throw new DomainError("INVOICE_CANNOT_CANCEL", "Only a currently unpaid shared invoice can be cancelled. A payment needs its own refund reconciliation.");
    const owned = { id: saved.observation.id, invoiceNumber: current.invoice_number, reference: current.reference };
    const operation = await claimExternalOperation(tx, { tenantId: session.tenantId, projectId: session.projectId, actorId: session.actorId, resourceId: id, kind: "invoice.cancel", businessKey: `recovery:${id}:cancel`, payload: owned });
    return await dispatchExternalOperation(tx, operation) ? { current, owned, operation } : null;
  });
  if (claim) await preserveResult(claim.current, await deps.gateway.cancelInvoice(claim.owned, AbortSignal.timeout(25000)), claim.operation);
  await reconcileInvoice(await invoiceRow(session, id), deps);
  return recoveryInvoiceView(session, id);
}
export async function reconcileRecoveryInvoices(limit = 2, deps: RecoveryDependencies = dependencies()): Promise<number> {
  const rows = await query<InvoiceRow>("SELECT * FROM fp_recovery_invoices WHERE state NOT IN ('paid','cancelled') ORDER BY observed_at NULLS FIRST,created_at LIMIT $1", [Math.min(5, Math.max(1, limit))]);
  for (const row of rows) await reconcileInvoice(row, deps);
  return rows.length;
}

/** A signed event is only a hint; ownership and fresh independent payment reads still apply. */
export async function observeOwnedInvoice(providerInvoiceId: string, deps: RecoveryDependencies = dependencies()) {
  const rows = await query<InvoiceRow>("SELECT * FROM fp_recovery_invoices WHERE provider_invoice_hash=$1", [sha256(providerInvoiceId)]);
  if (rows.length !== 1 || privateInvoice(rows[0]).observation?.id !== providerInvoiceId) throw new DomainError("INVOICE_OWNERSHIP_UNRESOLVED", "The invoice event has no unique application owner.");
  await reconcileInvoice(rows[0], deps);
  return { tenant_id: rows[0].tenant_id, project_id: rows[0].project_id };
}

/** Original disclosed compensation authority closes only an owned unpaid recovery channel. */
export async function closeRecoveryChannel(scope: Pick<Session, "tenantId" | "projectId">, id: string, deps: RecoveryDependencies = dependencies()): Promise<{ closed: boolean; state: string }> {
  let row = await invoiceRow(scope, id);
  const origin = await source(scope, row.consent_id);
  if (!["compensating", "cancelled"].includes(origin.round_state)) throw new DomainError("COMPENSATION_NOT_APPROVED", "The original round must stop collection before closing its recovery channel.");
  await reconcileInvoice(row, deps);
  row = await invoiceRow(scope, id);
  if (row.state === "open") {
    const claim = await database().transaction(async tx => {
      const currentOrigin = await source(scope, row.consent_id, tx, true);
      if (!["compensating", "cancelled"].includes(currentOrigin.round_state)) return null;
      const current = await invoiceRow(scope, id, tx, true), saved = privateInvoice(current);
      if (current.state !== "open" || !saved.observation) return null;
      const owned = { id: saved.observation.id, invoiceNumber: current.invoice_number, reference: current.reference };
      const operation = await claimExternalOperation(tx, { ...scope, actorId: current.created_by, resourceId: id, kind: "invoice.cancel", businessKey: `recovery:${id}:cancel`, payload: owned });
      return await dispatchExternalOperation(tx, operation) ? { current, owned, operation } : null;
    });
    if (claim) await preserveResult(claim.current, await deps.gateway.cancelInvoice(claim.owned, AbortSignal.timeout(25000)), claim.operation);
    await reconcileInvoice(await invoiceRow(scope, id), deps);
    row = await invoiceRow(scope, id);
  }
  const saved = privateInvoice(row);
  const [share] = await query<{ status: string }>("SELECT status FROM fp_provider_operations WHERE tenant_id=$1 AND business_key=$2", [scope.tenantId, `recovery:${id}:share`]);
  const unsharedDraft = row.state === "draft" && (!share || ["refused", "not_sent"].includes(share.status));
  const closed = row.state === "cancelled" || unsharedDraft || row.state === "paid" && !row.last_code && !!saved.observation?.payments.length;
  return { closed, state: unsharedDraft ? "unshared_draft" : row.state };
}
