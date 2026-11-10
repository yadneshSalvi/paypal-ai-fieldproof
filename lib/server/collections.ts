import { randomUUID } from "node:crypto";
import { canonicalJson, payloadHash, sha256, type PaymentAction, type PaymentCommand, type PaymentCore, type PaymentOperation, type ProviderAdapter, type ProviderResource, type SqlConnection } from "@fracture/paypal-core";
import type { ApprovalRecord, SettlementReceipt } from "../contracts";
import { CONDITIONAL_AMOUNTS, CONDITIONAL_PACKAGE, CONDITIONAL_TARGET_MINOR, assertCollectibleConsent, conditionalPolicy, consentDigest, safeApprovalUrl } from "../domain/consent";
import { DomainError, fundingTotals } from "../domain/money";
import type { Session } from "./auth";
import { CONDITIONAL_COLLECTION_POLICY, type FrozenRoundData } from "./collection-policy";
import { refreshRoundFunding } from "./collection-projection";
import { ownedWallet, type ConsentRow } from "./commitments";
import { database, initializeDatabase, query } from "./db";
import { requireCurrentRole, requireMembership } from "./membership";
import { ingestOwnedOrderRead, ingestPaymentOperation, paymentCore, paymentStore, paypalProvider } from "./payments";
import { appendEvent } from "./repository";
import { readPaymentCommand, storePaymentCommand } from "./stored-commands";
import { vaultGateway, type VaultGateway } from "./vault";

interface RoundRow {
  id: string; tenant_id: string; project_id: string; package_id: string; package_version: number; target_minor: string;
  collection_started_at: Date; recovery_ends_at: Date; policy_hash: string; state: string; data: FrozenRoundData;
}
interface CollectionItemRow extends ConsentRow {
  item_state: string; operation_id: string | null; wallet_checked_at: Date | null; wallet_identity_hash: string | null;
  obligation_version: number; current_package_version: number;
}
export interface CollectionView {
  id: string; packageId: string; packageVersion: number; state: string; startedAt: string; recoveryEndsAt: string;
  dispatchMode: "review_each" | "automatic";
  targetMinor: number; collectedMinor: number; eligibleMinor: number; shortfallMinor: number; excessLiabilityMinor: number;
  items: { consentId: string; obligationId: string; slotIndex: number; amountMinor: number; collectedMinor: number; state: string; channel: string; lastCode: string | null; own: boolean; approvalUrl: string | null }[];
}
export interface CollectionDependencies { vault: VaultGateway; provider: ProviderAdapter; core: PaymentCore }
function dependencies(): CollectionDependencies { return { vault: vaultGateway(), provider: paypalProvider(), core: paymentCore() }; }
async function ownedRound(session: Pick<Session,"tenantId"|"projectId">, id: string, tx: SqlConnection = database(), lock = false): Promise<RoundRow> {
  const [row] = await query<RoundRow>(`SELECT * FROM fp_collection_rounds WHERE id=$1 AND tenant_id=$2 AND project_id=$3 ${lock ? "FOR UPDATE" : ""}`, [id, session.tenantId, session.projectId], tx);
  if (!row) throw new DomainError("ROUND_NOT_FOUND", "This collection round does not belong to your project.", 404);
  return row;
}
async function roundItems(round: RoundRow, tx: SqlConnection = database(), lock = false): Promise<CollectionItemRow[]> {
  return query<CollectionItemRow>(`SELECT c.*,i.state item_state,i.operation_id,i.wallet_checked_at,i.wallet_identity_hash,i.last_code,
    o.channel,o.version obligation_version,p.version current_package_version
    FROM fp_collection_items i JOIN fp_conditional_consents c ON c.id=i.consent_id AND c.round_id=i.round_id
    JOIN fp_obligations o ON o.id=i.obligation_id JOIN fp_packages p ON p.project_id=c.project_id AND p.id=c.package_id
    WHERE i.round_id=$1 AND c.tenant_id=$2 AND c.project_id=$3 ORDER BY c.slot_index ${lock ? "FOR UPDATE OF c,i,o" : ""}`, [round.id, round.tenant_id, round.project_id], tx);
}
export async function collectionView(session: Session, id?: string): Promise<CollectionView | null> {
  await initializeDatabase();
  await requireMembership(session.tenantId, session.projectId, session.actorId, session.role);
  const round = id ? await ownedRound(session, id) : (await query<RoundRow>("SELECT * FROM fp_collection_rounds WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 ORDER BY collection_started_at DESC LIMIT 1", [session.tenantId, session.projectId, CONDITIONAL_PACKAGE]))[0];
  if (!round) return null;
  const [items, rows] = await Promise.all([
    roundItems(round), query<{ data: SettlementReceipt }>("SELECT r.data FROM fp_settlement_receipts r JOIN fp_collection_items i ON i.obligation_id=r.obligation_id WHERE i.round_id=$1", [round.id]),
  ]);
  const receipts = rows.map(row => row.data), totals = fundingTotals(receipts, Number(round.target_minor), "live_sandbox");
  return { id: round.id, packageId: round.package_id, packageVersion: round.package_version, state: round.state, dispatchMode: round.data.dispatchMode ?? "review_each", startedAt: round.collection_started_at.toISOString(), recoveryEndsAt: round.recovery_ends_at.toISOString(), targetMinor: Number(round.target_minor), collectedMinor: totals.collectedMinor, eligibleMinor: totals.fundingEligibleMinor, shortfallMinor: totals.shortfallMinor, excessLiabilityMinor: totals.excessLiabilityMinor,
    items: await Promise.all(items.map(async item => {
      let approvalUrl: string | null = null;
      const own = item.actor_id === session.actorId;
      if (own && item.item_state === "buyer_action" && item.operation_id) {
        const operation = await paymentStore().get({ tenantId: session.tenantId, projectId: session.projectId }, item.operation_id);
        approvalUrl = safeApprovalUrl(operation?.receipt?.resources.find(resource => resource.kind === "order")?.links.find(link => link.rel === "payer-action" || link.rel === "approve")?.href);
      }
      return { consentId: item.id, obligationId: item.obligation_id, slotIndex: item.slot_index, amountMinor: Number(item.amount_minor), collectedMinor: receipts.filter(receipt => receipt.donorObligationId === item.obligation_id).reduce((sum, receipt) => sum + receipt.creditedMinor - receipt.completedAttributedRefundMinor, 0), state: item.item_state, channel: item.channel ?? "uncollected", lastCode: item.last_code, own, approvalUrl };
    })) };
}


export async function freezeCollection(session: Session, input: { expectedVersion: number; intentId: string; automatic?: boolean }): Promise<CollectionView> {
  if (session.mode !== "live_sandbox") throw new DomainError("LIVE_COLLECTION_REQUIRED", "Real collection uses a live sandbox project with actual supporter approvals.");
  await initializeDatabase();
  const id = await database().transaction(async tx => {
    const organizer = await requireCurrentRole(session, "organizer", tx);
    const [packageRow] = await query<{ version: number; budget_minor: string }>("SELECT version,budget_minor FROM fp_packages WHERE project_id=$1 AND id=$2 FOR UPDATE", [session.projectId, CONDITIONAL_PACKAGE], tx);
    if (!packageRow || packageRow.version !== input.expectedVersion || Number(packageRow.budget_minor) !== CONDITIONAL_TARGET_MINOR) throw new DomainError("VERSION_CHANGED", "Review the current exact package budget before collection.");
    const [prior] = await query<RoundRow>("SELECT * FROM fp_collection_rounds WHERE project_id=$1 AND package_id=$2 ORDER BY collection_started_at LIMIT 1", [session.projectId, CONDITIONAL_PACKAGE], tx);
    if (prior) {
      if (prior.data.intentId !== input.intentId) throw new DomainError("ROUND_ALREADY_FROZEN", "The original round and its fixed deadline are already recorded. Open that collection record.");
      return prior.id;
    }
    const consents = await query<ConsentRow>(`SELECT c.*,o.channel FROM fp_conditional_consents c JOIN fp_obligations o ON o.id=c.obligation_id
      WHERE c.tenant_id=$1 AND c.project_id=$2 AND c.package_id=$3 AND c.withdrawn_at IS NULL ORDER BY c.slot_index FOR UPDATE OF c,o`, [session.tenantId, session.projectId, CONDITIONAL_PACKAGE], tx);
    if (consents.length !== CONDITIONAL_AMOUNTS.length || consents.reduce((sum, row) => sum + Number(row.amount_minor), 0) !== CONDITIONAL_TARGET_MINOR) throw new DomainError("PLEDGE_TARGET_NOT_MET", "The eight eligible conditional commitments must total exactly $960 before the clock starts.");
    const frozen: FrozenRoundData["consents"] = [];
    for (let index = 0; index < consents.length; index++) {
      const consent = consents[index];
      if (consent.slot_index !== index || Number(consent.amount_minor) !== CONDITIONAL_AMOUNTS[index] || consent.channel !== "uncollected" || consent.round_id) throw new DomainError("OBLIGATION_SET_CHANGED", "The contribution set is not the exact approved eight-obligation round.");
      assertCollectibleConsent({ status: consent.status, expiresAt: consent.expires_at, withdrawnAt: consent.withdrawn_at, packageVersion: consent.package_version, currentPackageVersion: packageRow.version, encryptedWallet: consent.encrypted_wallet });
      const policy = conditionalPolicy(consent.slot_index, consent.package_version);
      if (canonicalJson(consent.policy) !== canonicalJson(policy) || consent.policy_digest !== consentDigest({ tenantId: session.tenantId, projectId: session.projectId, actorId: consent.actor_id, obligationId: consent.obligation_id, version: consent.version, policy })) throw new DomainError("CONSENT_CHANGED", "A contribution no longer matches its exact acknowledged policy.");
      if (!ownedWallet(consent).tokenId) throw new DomainError("WALLET_NOT_READY", "Every contribution needs an actual confirmed PayPal payment token.");
      const membership = await requireMembership(session.tenantId, session.projectId, consent.actor_id, "donor", tx);
      frozen.push({ id: consent.id, version: consent.version, digest: consent.policy_digest, actorId: consent.actor_id, membershipVersion: membership.version, amountMinor: Number(consent.amount_minor) });
    }
    const roundId = randomUUID(), start = new Date(), end = new Date(start.getTime() + 48 * 60 * 60 * 1000);
    const data: FrozenRoundData = { intentId: input.intentId, organizerId: session.actorId, organizerMembershipVersion: organizer.membershipVersion, dispatchMode: input.automatic ? "automatic" : "review_each", consents: frozen };
    const hash = sha256(canonicalJson({ policy: CONDITIONAL_COLLECTION_POLICY, data, recoveryEndsAt: end.toISOString(), packageVersion: packageRow.version }));
    await tx.query(`INSERT INTO fp_collection_rounds(id,tenant_id,project_id,package_id,package_version,target_minor,collection_started_at,recovery_ends_at,policy_hash,state,data)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'collecting',$10::jsonb)`, [roundId, session.tenantId, session.projectId, CONDITIONAL_PACKAGE, packageRow.version, CONDITIONAL_TARGET_MINOR, start.toISOString(), end.toISOString(), hash, JSON.stringify(data)]);
    for (const consent of consents) {
      await tx.query("INSERT INTO fp_collection_items(round_id,consent_id,obligation_id,consent_version,consent_digest,amount_minor) VALUES($1,$2,$3,$4,$5,$6)", [roundId, consent.id, consent.obligation_id, consent.version, consent.policy_digest, Number(consent.amount_minor)]);
      await tx.query("UPDATE fp_conditional_consents SET round_id=$2,status='collecting' WHERE id=$1", [consent.id, roundId]);
      await tx.query("INSERT INTO fp_outbox(id,tenant_id,project_id,kind,data) VALUES($1,$2,$3,'collection.collect',$4::jsonb)", [`collection:${consent.id}`, session.tenantId, session.projectId, JSON.stringify({ roundId, consentId: consent.id })]);
    }
    await tx.query("UPDATE fp_packages SET data=jsonb_set(data,'{fundingState}','\"collecting\"'::jsonb) WHERE project_id=$1 AND id=$2", [session.projectId, CONDITIONAL_PACKAGE]);
    await appendEvent(tx, session, "collection.frozen", "Eight exact commitments. One fixed collection window.", "The $960 Electronics Benches round is frozen. Its 48-hour clock starts now; each payment stays linked to its original obligation.");
    return roundId;
  });
  return (await collectionView(session, id))!;
}

async function refreshCollectionWallet(round: RoundRow, item: CollectionItemRow, gateway: VaultGateway): Promise<boolean> {
  const wallet = ownedWallet(item);
  if (!wallet.tokenId) return false;
  const result = await gateway.readToken(wallet.tokenId);
  const valid = result.outcome === "succeeded" && result.value.id === wallet.tokenId && !!result.value.paymentSource?.paypal
    && (!wallet.customerId || wallet.customerId === result.value.customer?.id)
    && (!wallet.payerId || result.value.paymentSource.paypal.payerId === wallet.payerId)
    && (!wallet.tokenMerchantCustomerId || result.value.customer?.merchantCustomerId === wallet.tokenMerchantCustomerId)
    && (!result.value.paymentSource.paypal.usageType || result.value.paymentSource.paypal.usageType === "MERCHANT")
    && (!result.value.paymentSource.paypal.usagePattern || result.value.paymentSource.paypal.usagePattern === "UNSCHEDULED_PREPAID");
  await query("UPDATE fp_collection_items SET wallet_checked_at=CASE WHEN $3 THEN now() ELSE NULL END,wallet_identity_hash=CASE WHEN $3 THEN $4 ELSE NULL END,last_code=$5 WHERE round_id=$1 AND consent_id=$2", [round.id, item.id, valid, sha256(wallet.tokenId), valid ? null : result.outcome === "succeeded" ? "TOKEN_IDENTITY_UNPROVEN" : result.code]);
  return valid;
}

export async function collectionCommand(roundId: string, consentId: string, kind: "create" | "capture", orderId?: string): Promise<PaymentCommand> {
  return database().transaction(async tx => {
    const [reference] = await query<{ tenant_id: string; project_id: string }>("SELECT tenant_id,project_id FROM fp_collection_rounds WHERE id=$1", [roundId], tx);
    if (!reference) throw new DomainError("ROUND_NOT_FOUND", "The frozen collection record is missing.", 404);
    const round = await ownedRound({ tenantId: reference.tenant_id, projectId: reference.project_id }, roundId, tx, true);
    const item = (await roundItems(round, tx, true)).find(row => row.id === consentId);
    if (!item) throw new DomainError("COLLECTION_CHANNEL_BLOCKED", "This obligation is absent from the original frozen round.");
    const businessKey = `conditional:${round.id}:${item.id}:${kind}`;
    const [existing] = await query<{ command: PaymentCommand }>("SELECT command FROM fp_payment_commands WHERE tenant_id=$1 AND business_key=$2", [round.tenant_id, businessKey], tx);
    if (existing) {
      const command = readPaymentCommand(existing.command);
      if (kind === "capture" && command.action.kind === "capture_order" && command.action.orderId !== orderId) throw new DomainError("ORDER_CONFLICT", "This continuation already belongs to a different original order.");
      return command;
    }
    if (!["collecting", "recovering"].includes(round.state) || round.recovery_ends_at.getTime() <= Date.now()) throw new DomainError("COLLECTION_CLOSED", "The fixed collection window is closed.");
    if (item.withdrawn_at || !["uncollected", "original_in_flight", "unknown_reconciling"].includes(item.channel ?? "")) throw new DomainError("COLLECTION_CHANNEL_BLOCKED", "This obligation cannot start another original payment.");
    const wallet = ownedWallet(item);
    if (!wallet.tokenId || !item.wallet_checked_at || Date.now() - item.wallet_checked_at.getTime() > 60000 || item.wallet_identity_hash !== sha256(wallet.tokenId)) throw new DomainError("WALLET_READ_REQUIRED", "Refresh the owned wallet before creating a collection command.");
    if (kind === "create") {
      await tx.query("SELECT pg_advisory_xact_lock(410202614)");
      const [usage] = await query<{ total: string }>("SELECT COALESCE(sum((command->'action'->'money'->>'minor')::bigint),0) total FROM fp_payment_commands WHERE business_key LIKE 'conditional:%:create'", [], tx);
      if (Number(usage.total) + Number(item.amount_minor) > CONDITIONAL_TARGET_MINOR) throw new DomainError("QUALIFICATION_LIMIT", "The exact $960 conditional collection allowance has already been claimed. Existing operations can still be checked.");
    } else if (!orderId || !(await query("SELECT order_id FROM fp_provider_orders WHERE order_id=$1 AND tenant_id=$2 AND project_id=$3 AND obligation_id=$4", [orderId, round.tenant_id, round.project_id, item.obligation_id], tx)).length) throw new DomainError("ORDER_NOT_OWNED", "Only the original approved order can be continued.", 403);
    const expiresAt = new Date(Math.min(item.expires_at.getTime(), round.recovery_ends_at.getTime())).toISOString();
    const approval: ApprovalRecord = { id: randomUUID(), tenantId: round.tenant_id, actorId: item.actor_id, operation: kind === "create" ? "create_order" : "capture_order", resourceId: item.obligation_id, resourceVersion: item.obligation_version, amountMinor: Number(item.amount_minor), currency: "USD", recipientVersion: null, policyHash: CONDITIONAL_COLLECTION_POLICY, digest: "", expiresAt, revokedAt: null };
    approval.digest = sha256(canonicalJson(approval));
    const action: PaymentAction = kind === "create" ? { kind: "create_order", money: { currency: "USD", minor: Number(item.amount_minor) }, intent: "CAPTURE", customId: item.obligation_id, savedWallet: { vaultId: wallet.tokenId, consentId: item.id, consentVersion: item.version, consentDigest: item.policy_digest, paymentInitiator: "MERCHANT", usagePattern: "UNSCHEDULED_PREPAID", usage: "DERIVED" } } : { kind: "capture_order", money: { currency: "USD", minor: Number(item.amount_minor) }, orderId: orderId! };
    const command: PaymentCommand = { scope: { tenantId: round.tenant_id, projectId: round.project_id }, operationId: randomUUID(), businessKey, intentId: item.obligation_id, providerRequestId: randomUUID(), payloadHash: payloadHash(action), action, approval: { id: approval.id, version: approval.resourceVersion, digest: approval.digest, expiresAt } };
    await tx.query("INSERT INTO fp_approval_records(id,tenant_id,project_id,actor_id,resource_id,resource_version,digest,expires_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)", [approval.id, round.tenant_id, round.project_id, item.actor_id, item.obligation_id, approval.resourceVersion, approval.digest, expiresAt, JSON.stringify(approval)]);
    await tx.query("INSERT INTO fp_payment_commands(operation_id,tenant_id,project_id,obligation_id,session_id,business_key,payload_hash,command) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)", [command.operationId, round.tenant_id, round.project_id, item.obligation_id, item.session_id, businessKey, command.payloadHash, JSON.stringify(storePaymentCommand(command))]);
    await tx.query("UPDATE fp_collection_items SET operation_id=$3,state='dispatching' WHERE round_id=$1 AND consent_id=$2", [round.id, item.id, command.operationId]);
    await tx.query("UPDATE fp_obligations SET channel='original_in_flight' WHERE id=$1", [item.obligation_id]);
    return command;
  });
}

export function definitiveCollectionDecline(operation: PaymentOperation, resources: ProviderResource[] = operation.receipt?.resources ?? []): boolean {
  if (resources.some(resource => resource.kind === "capture" && ["COMPLETED", "PENDING", "PARTIALLY_REFUNDED", "REFUNDED"].includes(resource.status))) return false;
  if (resources.some(resource => resource.kind === "capture" && ["DENIED", "DECLINED"].includes(resource.status))) return true;
  return operation.status === "refused" && operation.error?.kind === "api" && operation.error.httpStatus >= 400 && operation.error.httpStatus < 500 && /^(INSTRUMENT_DECLINED|PAYMENT_DENIED|CARD_EXPIRED): /.test(operation.error.message);
}

async function projectCollectionOutcome(round: RoundRow, item: CollectionItemRow, operation: PaymentOperation, resources = operation.receipt?.resources ?? []): Promise<void> {
  await database().transaction(async tx => {
    const currentRound = await ownedRound({ tenantId: round.tenant_id, projectId: round.project_id }, round.id, tx, true);
    if (!["collecting", "recovering", "funded"].includes(currentRound.state)) return;
    const [current] = await query<{ channel: string }>("SELECT channel FROM fp_obligations WHERE id=$1 FOR UPDATE", [item.obligation_id], tx);
    const receipts = (await query<{ data: SettlementReceipt }>("SELECT data FROM fp_settlement_receipts WHERE obligation_id=$1", [item.obligation_id], tx)).map(row => row.data);
    const credit = fundingTotals(receipts, Number(item.amount_minor), "live_sandbox");
    let state: string, channel = current.channel, code: string | null = null;
    if (credit.excessLiabilityMinor) { state = "excess_reconciliation"; channel = "excess_reconciliation"; }
    else if (credit.fundingEligibleMinor >= Number(item.amount_minor)) { state = "collected"; channel = "collected"; }
    else if (["recovery_invoice_open", "collected", "excess_reconciliation"].includes(current.channel)) { state = current.channel; }
    else if (definitiveCollectionDecline(operation, resources) && credit.collectedMinor === 0) { state = "declined"; channel = "definitively_declined"; code = operation.error?.message.split(":")[0] ?? "CAPTURE_DECLINED"; }
    else if (["claimed", "dispatching", "pending_reconciliation"].includes(operation.status)) { state = "unknown"; channel = "unknown_reconciling"; code = operation.error?.kind ?? "PROVIDER_OUTCOME_PENDING"; }
    else if (resources.some(resource => resource.kind === "order" && resource.status === "PAYER_ACTION_REQUIRED")) { state = "buyer_action"; channel = "original_in_flight"; code = "PAYER_ACTION_REQUIRED"; }
    else if (["refused", "not_sent"].includes(operation.status)) { state = "review_required"; code = operation.error?.kind ?? "PROVIDER_REFUSED_REQUEST"; }
    else { state = "awaiting_payment"; channel = "original_in_flight"; }
    await tx.query("UPDATE fp_collection_items SET state=$3,last_code=$4 WHERE round_id=$1 AND consent_id=$2", [round.id, item.id, state, code]);
    await tx.query("UPDATE fp_obligations SET channel=$2 WHERE id=$1", [item.obligation_id, channel]);
    if (state === "collected") await tx.query("UPDATE fp_conditional_consents SET status='collected' WHERE id=$1", [item.id]);
    await refreshRoundFunding(tx, round.id);
  });
}

export async function processCollectionItem(roundId: string, consentId: string, deps: CollectionDependencies = dependencies()): Promise<void> {
  const [round] = await query<RoundRow>("SELECT * FROM fp_collection_rounds WHERE id=$1", [roundId]);
  if (!round || !["collecting", "recovering"].includes(round.state)) return;
  if (round.recovery_ends_at.getTime() <= Date.now()) { await database().transaction(tx => refreshRoundFunding(tx, round.id)); return; }
  const item = (await roundItems(round)).find(row => row.id === consentId);
  if (!item || ["collected", "declined", "recovery_invoice_open", "excess_reconciliation"].includes(item.item_state)) return;
  if (!(await refreshCollectionWallet(round, item, deps.vault))) {
    await query("UPDATE fp_collection_items SET state='review_required' WHERE round_id=$1 AND consent_id=$2", [roundId, consentId]);
    return;
  }
  const command = await collectionCommand(roundId, consentId, "create");
  const recorded = await paymentStore().get(command.scope, command.operationId);
  let operation: PaymentOperation;
  if (recorded) operation = recorded;
  else {
    try { operation = await deps.core.execute(command); }
    catch (error) {
      const concurrent = await paymentStore().get(command.scope, command.operationId);
      if (!concurrent) throw error;
      operation = concurrent;
    }
  }
  if (["claimed", "dispatching", "pending_reconciliation"].includes(operation.status)) operation = await deps.core.reconcile(command.scope, command.operationId);
  await ingestPaymentOperation(operation);
  let resources = operation.receipt?.resources ?? [];
  const originalOrder = resources.find(resource => resource.kind === "order");
  if (originalOrder && !resources.some(resource => resource.kind === "capture" && resource.status === "COMPLETED")) {
    const fresh = await deps.provider.read("order", originalOrder.id, AbortSignal.timeout(12000));
    const owned = fresh.find(resource => resource.kind === "order" && resource.id === originalOrder.id && resource.source === "live_sandbox");
    if (!owned || owned.customId && owned.customId !== item.obligation_id || owned.money && (owned.money.currency !== "USD" || owned.money.minor !== Number(item.amount_minor))) throw new DomainError("ORDER_IDENTITY_UNPROVEN", "The current order does not match its original obligation.");
    await ingestOwnedOrderRead(originalOrder.id, fresh);
    resources = fresh;
    if (owned.status === "APPROVED" && !fresh.some(resource => resource.kind === "capture")) {
      const capture = await collectionCommand(roundId, consentId, "capture", originalOrder.id);
      operation = await deps.core.execute(capture);
      await ingestPaymentOperation(operation);
      resources = operation.receipt?.resources ?? [];
    }
  }
  await projectCollectionOutcome(round, item, operation, resources);
}

export async function advanceCollection(session: Session, id: string, consentId?: string): Promise<CollectionView> {
  await requireCurrentRole(session, "organizer");
  const round = await ownedRound(session, id);
  const items = await roundItems(round), item = consentId ? items.find(candidate => candidate.id === consentId) : items.find(candidate => ["waiting", "awaiting_payment", "unknown", "dispatching"].includes(candidate.item_state));
  if (consentId && !item) throw new DomainError("OBLIGATION_NOT_OWNED", "That contribution is not part of this round.", 404);
  if (item) await processCollectionItem(id, item.id);
  return (await collectionView(session, id))!;
}

export async function runCollectionJobs(limit = 1, deps?: CollectionDependencies): Promise<{ processed: number; deferred: number }> {
  await initializeDatabase();
  let processed = 0, deferred = 0;
  for (let index = 0; index < Math.min(2, limit); index++) {
    const lease = randomUUID();
    const [job] = await query<{ id: string; data: { roundId: string; consentId: string }; lease_id: string }>(`WITH next AS (
      SELECT o.id FROM fp_outbox o JOIN fp_collection_rounds r ON r.id=o.data->>'roundId' JOIN fp_collection_items i ON i.round_id=r.id AND i.consent_id=o.data->>'consentId'
      WHERE o.kind='collection.collect' AND (r.data->>'dispatchMode'='automatic' OR i.operation_id IS NOT NULL)
        AND ((o.status IN ('queued','retry') AND o.available_at<=now()) OR (o.status='processing' AND o.lease_until<=now())) ORDER BY o.created_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1
    ) UPDATE fp_outbox o SET status='processing',lease_until=now()+interval '90 seconds',attempts=attempts+1,
      data=jsonb_set(o.data,'{leaseId}',to_jsonb($1::text)) FROM next WHERE o.id=next.id RETURNING o.id,o.data`, [lease]);
    if (!job) break;
    try {
      await processCollectionItem(job.data.roundId, job.data.consentId, deps);
      const [state] = await query<{ state: string }>("SELECT state FROM fp_collection_items WHERE round_id=$1 AND consent_id=$2", [job.data.roundId, job.data.consentId]);
      const retry = state && ["waiting", "dispatching", "awaiting_payment", "unknown"].includes(state.state);
      await query("UPDATE fp_outbox SET status=$2,lease_until=NULL,available_at=now()+interval '2 minutes' WHERE id=$1 AND data->>'leaseId'=$3", [job.id, retry ? "retry" : "delivered", lease]);
      if (retry) deferred++; else processed++;
    } catch (error) {
      await query("UPDATE fp_outbox SET status='retry',lease_until=NULL,available_at=now()+interval '2 minutes',data=jsonb_set(data,'{lastCode}',to_jsonb($3::text)) WHERE id=$1 AND data->>'leaseId'=$2", [job.id, lease, error instanceof DomainError ? error.code : "COLLECTION_CHECK_FAILED"]);
      deferred++;
    }
  }
  return { processed, deferred };
}

export interface CollectionReview {
  round: CollectionView | null; packageVersion: number; targetMinor: number; eligibleCommitmentsMinor: number;
  readyCount: number; participantCount: number; expiresAt: string;
  slots: { index: number; amountMinor: number; state: string; own: boolean }[];
}
export async function collectionReview(session: Session): Promise<CollectionReview> {
  await initializeDatabase();
  await requireMembership(session.tenantId, session.projectId, session.actorId, session.role);
  const [packageRow] = await query<{ version: number }>("SELECT version FROM fp_packages WHERE project_id=$1 AND id=$2", [session.projectId, CONDITIONAL_PACKAGE]);
  const consents = await query<ConsentRow>("SELECT * FROM fp_conditional_consents WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 AND withdrawn_at IS NULL", [session.tenantId, session.projectId, CONDITIONAL_PACKAGE]);
  const ready = consents.filter(row => row.status === "ready" && row.expires_at.getTime() > Date.now() && row.package_version === packageRow.version);
  return { round: await collectionView(session), packageVersion: packageRow.version, targetMinor: CONDITIONAL_TARGET_MINOR, eligibleCommitmentsMinor: ready.reduce((sum, row) => sum + Number(row.amount_minor), 0), readyCount: ready.length,
    participantCount: new Set(consents.map(row => row.actor_id)).size, expiresAt: conditionalPolicy(0, packageRow.version).expiresAt,
    slots: CONDITIONAL_AMOUNTS.map((amountMinor, index) => { const row = consents.find(item => item.slot_index === index); return { index, amountMinor, state: row?.status ?? "uncommitted", own: row?.actor_id === session.actorId }; }) };
}
