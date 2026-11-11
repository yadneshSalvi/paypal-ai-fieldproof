import { canonicalJson, sha256 } from "@fracture/paypal-core";
import type { SettlementReceipt } from "../contracts";
import { cancellationPosition, type CancellationPosition } from "../domain/cancellation-position";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { database, query } from "./db";
import { requireCurrentRole } from "./membership";

export interface CancellationReview extends CancellationPosition {
  roundId: string; packageTitle: string; packageVersion: number; roundState: string;
  observedAt: string; digest: string; canCancelUnspent: boolean;
  limitation: "committed_uses" | "already_compensating" | "closed" | "package_changed" | null;
}

export async function readCancellationReview(session: Session, roundId: string): Promise<CancellationReview> {
  if (!["organizer", "auditor"].includes(session.role)) throw new DomainError("ROLE_DENIED", "The complete contribution review is for the organizer or Auditor.", 403);
  const review = await database().transaction(async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await requireCurrentRole(session, session.role, tx);
    const [round] = await query<{ id: string; package_id: string; package_version: number; state: string; current_version: number; title: string }>(
      `SELECT r.id,r.package_id,r.package_version,r.state,p.version current_version,p.data->>'title' title
       FROM fp_collection_rounds r JOIN fp_packages p ON p.project_id=r.project_id AND p.id=r.package_id
       WHERE r.id=$1 AND r.tenant_id=$2 AND r.project_id=$3`, [roundId, session.tenantId, session.projectId], tx);
    if (!round) throw new DomainError("ROUND_NOT_FOUND", "That collection round is outside this workspace.", 404);
    const rows = await query<{ id: string; version: number; data: SettlementReceipt; reserved: string; paid: string }>(
      `SELECT sr.id,sr.version,sr.data,
       COALESCE((SELECT sum(a.amount_minor) FROM fp_receipt_allocations a WHERE a.receipt_id=sr.id AND a.tenant_id=$2 AND a.project_id=$3 AND a.state='reserved'),0) reserved,
       COALESCE((SELECT sum(a.amount_minor) FROM fp_receipt_allocations a WHERE a.receipt_id=sr.id AND a.tenant_id=$2 AND a.project_id=$3 AND a.state='paid'),0) paid
       FROM fp_settlement_receipts sr JOIN fp_collection_items i ON i.obligation_id=sr.obligation_id
       WHERE i.round_id=$1 AND sr.tenant_id=$2 AND sr.project_id=$3 ORDER BY sr.id`, [roundId, session.tenantId, session.projectId], tx);
    if (rows.some(row => row.id !== row.data.id)) throw new DomainError("CANCELLATION_SOURCE_IDENTITY", "A saved contribution has inconsistent receipt identity.");
    const position = cancellationPosition(rows.map(row => ({ receipt: row.data, version: row.version, reservedMinor: Number(row.reserved), paidMinor: Number(row.paid) })), {
      tenantId: session.tenantId, projectId: session.projectId, packageId: round.package_id, provenance: session.mode,
    });
    const limitation: CancellationReview["limitation"] = position.hasCommittedUses ? "committed_uses" : round.state === "compensating" ? "already_compensating" : !["collecting", "recovering", "funded"].includes(round.state) ? "closed" : round.current_version !== round.package_version ? "package_changed" : null;
    const canonical = { version: "cancellation-position.v1", roundId, packageId: round.package_id, packageVersion: round.package_version, currentVersion: round.current_version, state: round.state, ...position };
    // Session expiry is checked again with wall-clock time before disclosing the snapshot.
    await requireCurrentRole(session, session.role, tx);
    return { ...position, roundId, packageTitle: round.title, packageVersion: round.package_version, roundState: round.state, observedAt: new Date().toISOString(), digest: sha256(canonicalJson(canonical)), canCancelUnspent: limitation === null, limitation };
  });
  // The financial snapshot stays repeatable; permission revocations are checked
  // against the latest committed state before its private contents leave us.
  await requireCurrentRole(session, session.role);
  return review;
}
