import { canonicalJson, sha256 } from "@fracture/paypal-core";
import { currentCancellationPosition, type CancellationPosition } from "../domain/cancellation-position";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { database, query } from "./db";
import { requireCurrentRole } from "./membership";
import { readFundingJournal } from "./funding-positions";
import { fundingSourceDigest } from "./funding-writes";

export interface CancellationReview extends CancellationPosition {
  roundId: string; packageTitle: string; packageVersion: number; roundState: string;
  observedAt: string; digest: string; canCancelUnspent: boolean;
  limitation: "committed_uses" | "already_compensating" | "closed" | "package_changed" | "donor_choices_required" | null;
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
    const scope = { tenantId: session.tenantId, projectId: session.projectId, provenance: session.mode };
    const journal = await readFundingJournal(scope, tx), position = currentCancellationPosition(journal, scope, round.package_id);
    const cases = await query("SELECT id FROM fp_funding_cases WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 AND state<>'superseded'", [session.tenantId, session.projectId, round.package_id], tx);
    const assigned = journal.assignments.some(entry => entry.debit.packageId === round.package_id || entry.credit.packageId === round.package_id);
    const limitation: CancellationReview["limitation"] = cases.length || assigned ? "donor_choices_required" : position.hasCommittedUses ? "committed_uses" : round.state === "compensating" ? "already_compensating" : !["collecting", "recovering", "funded"].includes(round.state) ? "closed" : round.current_version !== round.package_version ? "package_changed" : null;
    const canonical = { version: "cancellation-position.v2", roundId, packageId: round.package_id, packageVersion: round.package_version, currentVersion: round.current_version, state: round.state, ...position,
      sourceDigests: position.sources.map(source => fundingSourceDigest(journal, source.receiptId)) };
    // Session expiry is checked again with wall-clock time before disclosing the snapshot.
    await requireCurrentRole(session, session.role, tx);
    return { ...position, roundId, packageTitle: round.title, packageVersion: round.package_version, roundState: round.state, observedAt: new Date().toISOString(), digest: sha256(canonicalJson(canonical)), canCancelUnspent: limitation === null, limitation };
  });
  // The financial snapshot stays repeatable; permission revocations are checked
  // against the latest committed state before its private contents leave us.
  await requireCurrentRole(session, session.role);
  return review;
}
