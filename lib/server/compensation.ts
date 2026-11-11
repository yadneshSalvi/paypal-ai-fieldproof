import { randomUUID } from "node:crypto";
import type {
  PaymentCommand,
  PaymentCore,
  ProviderAdapter,
  ProviderResource,
} from "@fracture/paypal-core";
import type { SettlementReceipt } from "../contracts";
import { DomainError, validateReceipt } from "../domain/money";
import type { Session } from "./auth";
import { collectionView, type CollectionView } from "./collections";
import { expireCollectionRounds } from "./collection-projection";
import { database, query } from "./db";
import { requireCurrentRole } from "./membership";
import {
  ingestOwnedOrderRead,
  ingestPaymentOperation,
  paymentCore,
  paymentStore,
  paypalProvider,
} from "./payments";
import {
  closeRecoveryChannel,
  type RecoveryDependencies,
} from "./recovery-invoices";
import { compensateReceipt, type RefundDependencies } from "./refunds";
import { appendEvent } from "./repository";
import { readPaymentCommand } from "./stored-commands";
import { projectClaimLock } from "./claims";
import { lockFundingScope } from "./funding-positions";
import { persistFundingReceipt } from "./funding-writes";

type Scope = Pick<Session, "tenantId" | "projectId">;
export interface CompensationDependencies {
  provider: ProviderAdapter;
  core: PaymentCore;
  recovery?: RecoveryDependencies;
  refunds?: RefundDependencies;
}
function dependencies(): CompensationDependencies {
  return { provider: paypalProvider(), core: paymentCore() };
}

export async function cancelUnspentCollection(
  session: Session,
  input: { roundId: string; expectedVersion: number; acknowledged: true },
): Promise<CollectionView> {
  if (input.acknowledged !== true || session.mode !== "live_sandbox")
    throw new DomainError(
      "CANCELLATION_APPROVAL_REQUIRED",
      "Review the complete unspent round and approve its original-route refunds.",
    );
  await database().transaction(async (tx) => {
    await projectClaimLock(tx, session.projectId);
    await lockFundingScope(session, tx);
    await requireCurrentRole(session, "organizer", tx);
    const [round] = await query<{
      id: string;
      state: string;
      package_id: string;
      package_version: number;
    }>(
      "SELECT * FROM fp_collection_rounds WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR UPDATE",
      [input.roundId, session.tenantId, session.projectId],
      tx,
    );
    if (!round)
      throw new DomainError(
        "ROUND_NOT_FOUND",
        "The round is outside this project.",
        404,
      );
    if (round.package_version !== input.expectedVersion)
      throw new DomainError(
        "VERSION_CHANGED",
        "Review the current original round before cancelling.",
      );
    if (["compensating", "cancelled"].includes(round.state)) return;
    const controlled = await query(`SELECT id FROM fp_funding_cases WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 AND state<>'superseded'
      UNION ALL SELECT id FROM fp_funding_assignments WHERE tenant_id=$1 AND project_id=$2 AND (debit_package_id=$3 OR credit_package_id=$3)`, [session.tenantId, session.projectId, round.package_id], tx);
    if (controlled.length) throw new DomainError("CANCELLATION_CHOICE_REQUIRED", "This purpose has a recorded donor decision or assigned support. Continue its funding case so each current-purpose share keeps its original payment trail.");
    const [uses] = await query<{ count: string }>(
      "SELECT count(*) count FROM fp_receipt_allocations a JOIN fp_collection_items i ON i.obligation_id=(SELECT obligation_id FROM fp_settlement_receipts WHERE id=a.receipt_id) WHERE i.round_id=$1 AND a.state IN ('reserved','paid')",
      [round.id],
      tx,
    );
    if (Number(uses.count))
      throw new DomainError(
        "PACKAGE_HAS_COMMITTED_USES",
        "This package has reviewed or paid expenses. Reverse eligible commitments and review a remaining-funds plan first.",
      );
    const rows = await query<{ version: number; data: SettlementReceipt }>(
      "SELECT r.version,r.data FROM fp_settlement_receipts r JOIN fp_collection_items i ON i.obligation_id=r.obligation_id WHERE i.round_id=$1 FOR UPDATE OF r",
      [round.id],
      tx,
    );
    for (const row of rows) {
      const receipt = structuredClone(row.data);
      receipt.excludedMinor =
        receipt.creditedMinor -
        receipt.completedAttributedRefundMinor -
        receipt.pendingAttributedRefundReserveMinor;
      validateReceipt(receipt);
      await persistFundingReceipt(tx, { ...session, provenance: session.mode }, row, receipt,
        [{ packageId: round.package_id, excludedMinor: receipt.excludedMinor - row.data.excludedMinor }]);
    }
    await tx.query(
      "UPDATE fp_collection_rounds SET state='compensating',cancellation_reason='package_cancelled',cancelled_by=$2,cancellation_requested_at=now() WHERE id=$1",
      [round.id, session.actorId],
    );
    await tx.query(
      "UPDATE fp_packages SET data=jsonb_set(data,'{fundingState}','\"compensating\"'::jsonb) WHERE project_id=$1 AND id=$2",
      [session.projectId, round.package_id],
    );
    await tx.query(
      "INSERT INTO fp_outbox(id,tenant_id,project_id,kind,data) VALUES($1,$2,$3,'collection.compensate',$4::jsonb) ON CONFLICT(id) DO UPDATE SET status='queued',available_at=now()",
      [
        `compensate:${round.id}`,
        session.tenantId,
        session.projectId,
        JSON.stringify({ roundId: round.id }),
      ],
    );
    await appendEvent(
      tx,
      session,
      "collection.cancellation_requested",
      "Collection stopped; original-route refunds are due",
      "The organizer cancelled an unspent package. New collection is closed, received value is excluded from spending, and each actual payment must be reconciled and returned before cancellation is complete.",
    );
  });
  return (await collectionView(session, input.roundId))!;
}

/** Only read and project existing operations. An uncertain charge never becomes a fresh write here. */
export async function reconcileCollectionPayments(
  scope: Scope,
  roundId: string,
  deps: CompensationDependencies = dependencies(),
): Promise<number> {
  const commands = await query<{ command: PaymentCommand }>(
    "SELECT pc.command FROM fp_payment_commands pc JOIN fp_collection_items i ON i.obligation_id=pc.obligation_id WHERE i.round_id=$1 AND pc.tenant_id=$2 AND pc.project_id=$3 AND pc.business_key LIKE 'conditional:%' ORDER BY pc.created_at",
    [roundId, scope.tenantId, scope.projectId],
  );
  let unresolved = 0;
  const readOrders = new Map<string, ProviderResource[]>();
  for (const saved of commands) {
    const command = readPaymentCommand(saved.command);
    const existing = await paymentStore().get(scope, command.operationId);
    if (!existing) continue; // Domain command was committed; provider dispatch was never claimed.
    const operation = await deps.core.reconcile(scope, command.operationId);
    await ingestPaymentOperation(operation);
    if (
      ["claimed", "dispatching", "pending_reconciliation"].includes(
        operation.status,
      )
    )
      unresolved++;
    const order = operation.receipt?.resources.find(
      (resource) => resource.kind === "order",
    );
    const orderId =
      order?.id ??
      (command.action.kind === "capture_order" ? command.action.orderId : null);
    if (!orderId || readOrders.has(orderId)) continue;
    const resources = await deps.provider.read(
      "order",
      orderId,
      AbortSignal.timeout(15000),
    );
    readOrders.set(orderId, resources);
    await ingestOwnedOrderRead(orderId, resources);
    if (
      resources.some(
        (resource) =>
          resource.kind === "capture" &&
          ![
            "COMPLETED",
            "REFUNDED",
            "PARTIALLY_REFUNDED",
            "DENIED",
            "DECLINED",
          ].includes(resource.status),
      )
    )
      unresolved++;
  }
  return unresolved;
}

export async function processCompensation(
  scope: Scope,
  roundId: string,
  deps: CompensationDependencies = dependencies(),
  limit = 2,
) {
  const [round] = await query<{
    state: string;
    package_id: string;
    cancellation_reason: string | null;
  }>(
    "SELECT * FROM fp_collection_rounds WHERE id=$1 AND tenant_id=$2 AND project_id=$3",
    [roundId, scope.tenantId, scope.projectId],
  );
  if (!round || round.state !== "compensating")
    return { completed: round?.state === "cancelled", pending: 0 };
  let pending = await reconcileCollectionPayments(scope, roundId, deps);
  for (const invoice of await query<{ id: string }>(
    "SELECT id FROM fp_recovery_invoices WHERE round_id=$1",
    [roundId],
  )) {
    if (!(await closeRecoveryChannel(scope, invoice.id, deps.recovery)).closed)
      pending++;
  }
  const receipts = await query<{ id: string; data: SettlementReceipt }>(
    `SELECT r.id,r.data FROM fp_settlement_receipts r JOIN fp_collection_items i ON i.obligation_id=r.obligation_id
    WHERE i.round_id=$1 AND ((r.data->>'creditedMinor')::bigint-(r.data->>'completedAttributedRefundMinor')::bigint+(r.data->>'excessLiabilityMinor')::bigint)>0
    ORDER BY (SELECT max(f.checked_at) FROM fp_refunds f WHERE f.receipt_id=r.id) NULLS FIRST,r.created_at,r.id LIMIT $2`,
    [roundId, Math.max(1, Math.min(3, limit))],
  );
  for (const receipt of receipts) {
    try {
      await compensateReceipt(
        scope,
        receipt.id,
        round.cancellation_reason === "package_cancelled"
          ? "package_cancelled"
          : "incomplete_round",
        deps.refunds ?? { provider: deps.provider, core: deps.core },
      );
    } catch (error) {
      pending++;
      await query(
        "UPDATE fp_collection_items SET state='refund_review',last_code=$2 WHERE obligation_id=$1",
        [
          receipt.data.donorObligationId,
          error instanceof DomainError ? error.code : "REFUND_READ_UNAVAILABLE",
        ],
      );
    }
  }
  return database().transaction(async (tx) => {
    await tx.query(
      "SELECT id FROM fp_collection_rounds WHERE id=$1 FOR UPDATE",
      [roundId],
    );
    const rows = await query<{ data: SettlementReceipt }>(
      "SELECT r.data FROM fp_settlement_receipts r JOIN fp_collection_items i ON i.obligation_id=r.obligation_id WHERE i.round_id=$1",
      [roundId],
      tx,
    );
    const remaining = rows.reduce(
      (sum, row) =>
        sum +
        row.data.creditedMinor -
        row.data.completedAttributedRefundMinor +
        row.data.excessLiabilityMinor,
      0,
    );
    // Operations can have changed after the reads. Any current ambiguous write still blocks completion.
    const operationIds = await query<{ operation_id: string }>(
      "SELECT pc.operation_id FROM fp_payment_commands pc JOIN fp_collection_items i ON i.obligation_id=pc.obligation_id WHERE i.round_id=$1 AND pc.business_key LIKE 'conditional:%'",
      [roundId],
      tx,
    );
    for (const item of operationIds) {
      const operation = await paymentStore().get(scope, item.operation_id);
      if (
        operation &&
        ["claimed", "dispatching", "pending_reconciliation"].includes(
          operation.status,
        )
      )
        pending++;
    }
    const completed = pending === 0 && remaining === 0;
    if (completed) {
      await tx.query(
        "UPDATE fp_collection_rounds SET state='cancelled' WHERE id=$1 AND state='compensating'",
        [roundId],
      );
      await tx.query(
        "UPDATE fp_packages SET data=jsonb_set(data,'{fundingState}','\"cancelled\"'::jsonb) WHERE project_id=$1 AND id=$2",
        [scope.projectId, round.package_id],
      );
      await tx.query(
        "UPDATE fp_conditional_consents SET status='cancelled' WHERE round_id=$1 AND status<>'refunded'",
        [roundId],
      );
      await tx.query(
        "UPDATE fp_collection_items SET state='cancelled' WHERE round_id=$1 AND state<>'refunded'",
        [roundId],
      );
      await tx.query(
        "UPDATE fp_obligations SET channel='cancelled' WHERE id IN (SELECT obligation_id FROM fp_collection_items WHERE round_id=$1) AND channel<>'refunded'",
        [roundId],
      );
      await appendEvent(
        tx,
        { ...scope, mode: "live_sandbox" },
        "collection.cancelled",
        "The round is fully reconciled and cancelled",
        "All confirmed receipts from this frozen round have been returned through their actual payment routes. Uncharged contributions are closed, with original history retained.",
      );
    }
    return { completed, pending: pending + (remaining > 0 ? 1 : 0) };
  });
}

export async function runCompensationJobs(
  limit = 1,
  deps?: CompensationDependencies,
) {
  await expireCollectionRounds();
  let processed = 0,
    deferred = 0;
  for (let index = 0; index < Math.max(1, Math.min(2, limit)); index++) {
    const lease = randomUUID();
    const [job] = await query<{
      id: string;
      tenant_id: string;
      project_id: string;
      data: { roundId: string };
    }>(
      `WITH ready AS (
      SELECT id FROM fp_outbox WHERE kind='collection.compensate' AND ((status IN ('queued','retry') AND available_at<=now()) OR (status='processing' AND lease_until<=now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE fp_outbox o SET status='processing',lease_until=now()+interval '90 seconds',attempts=attempts+1,data=jsonb_set(data,'{leaseId}',to_jsonb($1::text)) FROM ready WHERE o.id=ready.id RETURNING o.*`,
      [lease],
    );
    if (!job) break;
    try {
      const result = await processCompensation(
        { tenantId: job.tenant_id, projectId: job.project_id },
        job.data.roundId,
        deps,
        1,
      );
      await query(
        "UPDATE fp_outbox SET status=$3,available_at=now()+interval '1 minute',lease_until=NULL WHERE id=$1 AND data->>'leaseId'=$2",
        [job.id, lease, result.completed ? "delivered" : "retry"],
      );
      if (result.completed) processed++;
      else deferred++;
    } catch (error) {
      await query(
        "UPDATE fp_outbox SET status='retry',available_at=now()+interval '2 minutes',lease_until=NULL,data=jsonb_set(data,'{lastCode}',to_jsonb($3::text)) WHERE id=$1 AND data->>'leaseId'=$2",
        [
          job.id,
          lease,
          error instanceof DomainError
            ? error.code
            : "COMPENSATION_CHECK_UNAVAILABLE",
        ],
      );
      deferred++;
    }
  }
  return { processed, deferred };
}
