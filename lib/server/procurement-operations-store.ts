import { randomUUID } from "node:crypto";
import type { SqlConnection } from "@fracture/paypal-core";
import type { PlanSourceBinding } from "../planning/contracts";
import type * as C from "../procurement/contracts";
import { DomainError } from "../domain/money";
import { procurementBasisHash } from "../procurement/state";
import { dbClock, operationsHead, procurementHash, scopeValues, sealProcurement, type OperationsPayload, type ProcurementAuthority } from "./procurement-store";

export interface OperationsEventPayload {
  contractVersion: typeof C.PROCUREMENT_VERSION;
  head: OperationsPayload; reason: string; sharedWithResponsibilityId: string | null;
  basis: C.ProcurementBasis; snapshot: C.ProcurementDetail | null; bindings: PlanSourceBinding[];
}
export interface OperationsEventRow {
  id: string; tenant_id: string; project_id: string; package_id: string; version: number; cycle: number;
  kind: C.ProcurementHistoryItem["kind"]; from_state: C.ProcurementState | null; to_state: C.ProcurementState | null;
  actor_id: string; actor_session_id: string; actor_role: "organizer" | "volunteer"; membership_version: number;
  basis_hash: string; content_hash: string; encrypted_data: string; created_at: Date;
}
export function expectOperationsHead(head: OperationsPayload, version: number, cycle: number) {
  if (head.version !== version || head.cycle !== cycle) throw new DomainError("PROCUREMENT_VERSION_CHANGED", "This package has a newer saved operational decision or cycle. Review the current history before continuing.", 409);
}
export async function writeOperationsHead(tx: SqlConnection, authority: ProcurementAuthority, previous: OperationsPayload, changes: Partial<Omit<OperationsPayload, "contractVersion" | "packageId" | "version">>): Promise<OperationsPayload> {
  await operationsHead(tx, authority.session, previous.packageId, true);
  const next: OperationsPayload = { ...previous, ...changes, version: previous.version + 1 };
  const rows = await tx.query("UPDATE fp_package_operations SET version=$4,cycle=$5,state=$6,blocked_from=$7,cycle_started_at=$8,content_hash=$9,encrypted_data=$10,updated_at=clock_timestamp() WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 AND version=$11 RETURNING package_id", [...scopeValues(authority.session), next.packageId, next.version, next.cycle, next.state, next.blockedFrom, next.cycleStartedAt, procurementHash(next), sealProcurement(authority.session, "operations", next.packageId, next.version, next), previous.version]);
  if (!rows.rows.length) throw new DomainError("PROCUREMENT_VERSION_CHANGED", "The operational head changed before this exact decision could be recorded.", 409);
  return next;
}
/** The deferred database guard requires this exact-version event before commit.
 * Source bindings are private sidecars, never public history identifiers. */
export async function recordOperationsEvent(tx: SqlConnection, authority: ProcurementAuthority, kind: OperationsEventRow["kind"], previous: OperationsPayload, data: OperationsEventPayload): Promise<string> {
  const id = randomUUID(), session = authority.session, head = data.head;
  await tx.query("INSERT INTO fp_package_operation_events(id,tenant_id,project_id,package_id,version,cycle,kind,from_state,to_state,actor_id,actor_session_id,actor_role,membership_version,basis_hash,content_hash,encrypted_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)", [id, session.tenantId, session.projectId, head.packageId, head.version, head.cycle, kind, previous.state, head.state, session.actorId, session.id, session.role, authority.membershipVersion, procurementBasisHash(data.basis), procurementHash(data), sealProcurement(session, "operations-event", id, 1, data)]);
  return id;
}
export async function assertOpenOperations(head: OperationsPayload) {
  if (["accepted", "canceled"].includes(head.state)) throw new DomainError("PROCUREMENT_TRANSITION_BLOCKED", "This cycle is accepted or canceled. Explicitly reopen a new cycle before assigning, selecting or reporting new work.", 409);
}
export async function nextCycleTime(tx: SqlConnection, original: string) {
  const now = await dbClock(tx);
  if (Date.parse(now) <= Date.parse(original)) throw new DomainError("PROCUREMENT_BUSY", "The new cycle must start after its original recorded cutoff. Retry the same saved request.", 409);
  return now;
}
