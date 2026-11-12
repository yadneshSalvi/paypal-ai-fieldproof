import type { SqlConnection } from "@fracture/paypal-core";
import { digest, identifier, OperationsError, requireOperation, type ActivationReview, type Row, type Snapshot, type TransferEndpoint } from "./contracts";
import { assertCatalog, assertRegistry, TABLE_NAMES } from "./current-registry";
import { readCatalog, readIdentity, readRows, readSequences } from "./catalog";
import { assertOriginalLineage, originalRows, timestampMicros } from "./lineage";
import { inspectPrivateLineage } from "./private-lineage";

/** Locks precede the first MVCC query, so a waiter sees commits that completed
 * while it waited. Read plans never mutate rows, authority, counters or leases. */
export async function beginSnapshot(tx: SqlConnection, endpoint: Pick<TransferEndpoint, "schema">, writable = false): Promise<void> {
  requireOperation(tx.dialect === "postgres", "UNSUPPORTED_COVERAGE", "Workspace v2 is qualified only for PostgreSQL18 schema21.");
  await tx.query(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ${writable ? "" : ", READ ONLY"}; SET LOCAL timezone='UTC'; SET LOCAL lock_timeout='5000ms'; SET LOCAL statement_timeout='120000ms'`);
  try { await tx.query(`LOCK TABLE ${TABLE_NAMES.map(name => `${identifier(endpoint.schema)}.${identifier(name)}`).join(",")} IN ${writable ? "ACCESS EXCLUSIVE" : "SHARE"} MODE`); }
  catch { throw new OperationsError("UNSUPPORTED_COVERAGE", "The explicit current namespace could not be locked. Keep it held; missing, older, conflicting or busy catalogs are never initialized by transfer."); }
}
export async function snapshotIn(tx: SqlConnection, endpoint: TransferEndpoint, restricted = false): Promise<Snapshot> {
  const identity = await readIdentity(tx, endpoint, restricted), catalog = await readCatalog(tx);
  // Refuse unknown catalogs before selecting any domain row.
  assertCatalog(catalog);
  const tables = await readRows(tx, catalog), sequences = await readSequences(tx, catalog), rows = originalRows(tables, catalog);
  assertRegistry(catalog, rows.get("fp_schema_versions")!); assertOriginalLineage(rows, catalog);
  const privateData = inspectPrivateLineage(rows, tables, endpoint.authSecret);
  const clock = (await tx.query<{ capturedAt: string; wall: string }>(`SELECT to_char(transaction_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "capturedAt",to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') wall`)).rows[0];
  const control = rows.get("fp_runtime_control")!;
  requireOperation(control.length === 1 && control[0].key === "execution" && Number.isSafeInteger(control[0].version), "UNSUPPORTED_COVERAGE", "The original runtime execution control is missing or ambiguous.");
  const now = timestampMicros(clock.wall), future = (value: unknown) => typeof value === "string" && timestampMicros(value) > now;
  const activeRequests = rows.get("fp_request_leases")!.filter(row => row.completed_at === null && future(row.expires_at)).length;
  let activeWorkers = 0;
  for (const items of rows.values()) activeWorkers += items.filter(row => future(row.lease_until)).length;
  activeWorkers += rows.get("fp_documents")!.filter(row => row.state === "awaiting_upload" && future(row.upload_expires_at)).length;
  activeWorkers += rows.get("fp_provider_operations")!.filter(row => ["claimed", "dispatching"].includes(String(row.status)) && timestampMicros(String(row.dispatched_at ?? row.created_at)) > now - 360_000_000n).length;
  activeWorkers += privateData.paymentOperations.filter(row => ["claimed", "dispatching"].includes(String(row.status)) && (typeof row.leaseUntil !== "string" || future(row.leaseUntil))).length;
  return { identity, catalog, catalogHash: digest(catalog), capturedAt: clock.capturedAt, tables, rowsHash: digest(tables), sequences, sequenceHash: digest(sequences), execution: { held: control[0].held === true, version: Number(control[0].version), activeRequests, activeWorkers } };
}
export async function captureWorkspaceV2(endpoint: TransferEndpoint, restricted = false): Promise<Snapshot> {
  return endpoint.database.transaction(async tx => { await beginSnapshot(tx, endpoint); return snapshotIn(tx, endpoint, restricted); });
}
export function assertDrained(snapshot: Snapshot): void {
  requireOperation(snapshot.execution.held && snapshot.execution.activeRequests === 0 && snapshot.execution.activeWorkers === 0, "SOURCE_NOT_DRAINED", "The original namespace must remain held with every original request and worker lease drained.");
}
export function assertFreshDestination(snapshot: Snapshot): void {
  const rows = originalRows(snapshot.tables, snapshot.catalog);
  for (const table of snapshot.tables) if (!["fp_schema_versions", "fp_runtime_control", "fp_runtime_control_events"].includes(table.name))
    requireOperation(table.count === 0, "DESTINATION_NOT_FRESH", "The destination contains original data or conflicting history. Only an explicitly fresh initialized target is eligible.");
  const control = rows.get("fp_runtime_control")!, events = rows.get("fp_runtime_control_events")!;
  requireOperation(snapshot.execution.held && snapshot.execution.activeRequests === 0 && snapshot.execution.activeWorkers === 0 && control.length === 1 && control[0].version === 2 && String(control[0].reason).trim().length >= 8 && events.length === 1 && events[0].held === true && events[0].version === 2 && events[0].reason === control[0].reason, "DESTINATION_NOT_FRESH", "Initialize a separate fresh target, then apply its single explicit operator hold before planning.");
  requireOperation(snapshot.sequences.every(sequence => !sequence.isCalled && sequence.lastValue === String(snapshot.catalog.sequences.find(item => item.name === sequence.name)?.start)), "DESTINATION_NOT_FRESH", "The destination has already consumed an original sequence or cursor.");
}
const activationTables = ["paycore_operations", "paycore_attempts", "paycore_webhook_events", "paycore_webhook_deliveries", "fp_outbox", "fp_webhook_jobs", "fp_provider_operations", "fp_payables", "fp_ai_runs", "fp_plan_runs", "fp_community_runs", "fp_studio_agent_runs", "fp_documents", "fp_request_leases", "fp_request_buckets", "fp_runtime_control_events"];
export function activationReview(snapshot: Snapshot): ActivationReview {
  return { execution: "held", activation: "separate-root-review-required", uncertainFinancialReplay: false, records: activationTables.map(name => {
    const table = snapshot.tables.find(item => item.name === name)!; const states: Record<string, number> = {};
    for (const text of table.rows) { const row = JSON.parse(text) as Row, value = row.state ?? row.status ?? (row.completed_at === null ? "original-lease" : row.completed_at ? "completed-lease" : "retained-history"); const state = typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : "unclassified"; states[state] = (states[state] ?? 0) + 1; }
    return { table: name, count: table.count, rowsHash: table.hash, states };
  }) };
}
