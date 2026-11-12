import type { SqlConnection } from "@fracture/paypal-core";
import { identifier, requireOperation, type Snapshot } from "./contracts";
import { TABLE_NAMES } from "./current-registry";
import { HISTORICAL_EXTENSION_GUARDS } from "./extensions";
import { assertFreshDestination } from "./snapshot";

export const HISTORICAL_RESTORE_GUARDS = [
  { table: "fp_org_sessions", trigger: "fp_org_session_retained", function: "fp_org_session_contract", reason: "qualified original historical organization sessions" },
  ...HISTORICAL_EXTENSION_GUARDS,
] as const;

/** Caller owns the import transaction. This window is eligible only after the
 * actual target snapshot is verified fresh under all-table exclusive locks.
 * Every failure is rethrown so that transaction ownership rolls back rows and
 * transactional trigger metadata. This is not an issuance or source-write API. */
export async function withHistoricalRestoreGuards<T>(tx: SqlConnection, fresh: Snapshot, work: () => Promise<T>): Promise<T> {
  assertFreshDestination(fresh);
  const proof = (await tx.query<{ namespace: string; role: string; exclusive: number }>(`SELECT current_schema() namespace,current_user role,
    (SELECT count(DISTINCT c.relname)::int FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE l.pid=pg_backend_pid() AND l.granted AND l.mode='AccessExclusiveLock' AND n.nspname=current_schema() AND c.relname=ANY($1::text[])) exclusive`, [[...TABLE_NAMES]])).rows[0];
  requireOperation(proof.namespace===fresh.identity.schema && proof.role===fresh.identity.role && proof.exclusive===TABLE_NAMES.length, "DESTINATION_NOT_FRESH", "Historical restore requires the reviewed fresh destination and all original table locks in this transaction.");
  for(const guard of HISTORICAL_RESTORE_GUARDS) {
    const original = fresh.catalog.tables.find(table=>table.name===guard.table)?.triggers.find(trigger=>trigger.name===guard.trigger);
    requireOperation(original?.enabled==="O" && original.function===guard.function && original.internal===false, "CATALOG_CHANGED", "A narrowly approved historical restore trigger has an unknown original mode or function.");
  }
  const statement=(enable:boolean)=>HISTORICAL_RESTORE_GUARDS.map(guard=>`ALTER TABLE ${identifier(fresh.identity.schema)}.${identifier(guard.table)} ${enable?"ENABLE":"DISABLE"} TRIGGER ${identifier(guard.trigger)}`).join(";\n");
  await tx.query(`/* HISTORICAL TARGET GUARD WINDOW V2 */ ${statement(false)}`);
  try {
    const result=await work();
    await tx.query(statement(true));
    return result;
  } catch(error) {
    // A JavaScript/transport failure may leave the SQL transaction usable. Put
    // its guard modes back before rethrowing. A SQL-aborted transaction cannot
    // be re-enabled until its mandatory outer rollback, which restores them.
    try { await tx.query(statement(true)); } catch { /* outer rollback required */ }
    throw error;
  }
}
