import type { SqlConnection } from "@fracture/paypal-core";
import type { SettlementReceipt } from "../contracts";
import { fundingTotals } from "../domain/money";
import { database, query } from "./db";
import { appendEvent } from "./repository";
import { persistFundingReceipt } from "./funding-writes";

export async function refreshRoundFunding(tx: SqlConnection, roundId: string): Promise<void> {
  const [round] = await query<{ tenant_id: string; project_id: string; package_id: string; target_minor: string; state: string; recovery_ends_at: Date }>("SELECT * FROM fp_collection_rounds WHERE id=$1 FOR UPDATE", [roundId], tx);
  if (!round || !["collecting", "recovering"].includes(round.state)) return;
  // A later donor case owns these shares. Legacy expiry never becomes a second
  // automatic return or an exclusion of credit now assigned to another purpose.
  const controlled = await query(`SELECT id FROM fp_funding_cases WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 AND state<>'superseded'
    UNION ALL SELECT id FROM fp_funding_assignments WHERE tenant_id=$1 AND project_id=$2 AND (debit_package_id=$3 OR credit_package_id=$3)`, [round.tenant_id, round.project_id, round.package_id], tx);
  if (controlled.length) return;
  const rows = await query<{ version: number; data: SettlementReceipt }>("SELECT r.version,r.data FROM fp_settlement_receipts r JOIN fp_collection_items i ON i.obligation_id=r.obligation_id WHERE i.round_id=$1", [roundId], tx);
  const totals = fundingTotals(rows.map(row => row.data), Number(round.target_minor), "live_sandbox");
  const recovery = (await query("SELECT consent_id FROM fp_collection_items WHERE round_id=$1 AND state IN ('declined','recovery_invoice_open') LIMIT 1", [roundId], tx)).length > 0;
  const state = round.recovery_ends_at.getTime() <= Date.now() ? "compensating" : totals.fundingEligibleMinor >= Number(round.target_minor) ? "funded" : recovery ? "recovering" : round.state;
  if (state === round.state) return;
  await tx.query("UPDATE fp_collection_rounds SET state=$2 WHERE id=$1", [roundId, state]);
  await tx.query("UPDATE fp_packages SET data=jsonb_set(data,'{fundingState}',$3::jsonb) WHERE project_id=$1 AND id=$2", [round.project_id, round.package_id, JSON.stringify(state)]);
  if (state === "compensating") {
    for (const row of rows) {
      const receipt = structuredClone(row.data);
      receipt.excludedMinor = receipt.creditedMinor - receipt.completedAttributedRefundMinor - receipt.pendingAttributedRefundReserveMinor;
      await persistFundingReceipt(tx, { tenantId: round.tenant_id, projectId: round.project_id, provenance: "live_sandbox" }, row, receipt,
        [{ packageId: round.package_id, excludedMinor: receipt.excludedMinor - row.data.excludedMinor }]);
    }
  }
  await appendEvent(tx, { tenantId: round.tenant_id, projectId: round.project_id, mode: "live_sandbox" }, `collection.${state}`, state === "funded" ? "All eight contributions are collected" : state === "recovering" ? "A contribution needs its recovery path" : "The fixed collection window ended", state === "funded" ? "The frozen $960 round is backed by canonical provider-confirmed receipts. Physical work and expenses still need their own reviews." : state === "recovering" ? "A definitive provider decline has been observed. Recovery keeps the original obligation and original 48-hour deadline." : "Incomplete collection cannot be spent. Settled contributions need their original-rail refund and reconciliation records.");
  if (state === "compensating") await tx.query("INSERT INTO fp_outbox(id,tenant_id,project_id,kind,data) VALUES($1,$2,$3,'collection.compensate',$4::jsonb) ON CONFLICT(id) DO NOTHING", [`compensate:${roundId}`, round.tenant_id, round.project_id, JSON.stringify({ roundId })]);
}

export async function expireCollectionRounds(): Promise<number> {
  const rows = await query<{ id: string }>("SELECT id FROM fp_collection_rounds WHERE state IN ('collecting','recovering') AND recovery_ends_at<=now() ORDER BY recovery_ends_at LIMIT 20");
  for (const row of rows) await database().transaction(tx => refreshRoundFunding(tx, row.id));
  return rows.length;
}
