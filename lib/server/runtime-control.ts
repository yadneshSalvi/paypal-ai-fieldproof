import { randomUUID } from "node:crypto";
import type { SqlConnection, SqlDatabase } from "@fracture/paypal-core";
import { DomainError } from "../domain/money";

export const RUNTIME_CONTROL_SCHEMA = `
CREATE TABLE IF NOT EXISTS fp_runtime_control (
  key text PRIMARY KEY CHECK(key='execution'), held boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1, reason text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fp_runtime_control(key) VALUES('execution') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS fp_runtime_control_events (
  id text PRIMARY KEY, held boolean NOT NULL, version integer NOT NULL, reason text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_request_leases (
  id text PRIMARY KEY, action text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS fp_request_leases_active ON fp_request_leases(expires_at) WHERE completed_at IS NULL;
`;
export interface RuntimeControl { held: boolean; version: number; activeRequests: number; }
export async function runtimeControl(tx: SqlConnection): Promise<RuntimeControl> {
  const result = await tx.query<{ held: boolean; version: number; active_requests: string }>("SELECT COALESCE((SELECT held FROM fp_runtime_control WHERE key='execution'),false) AS held,COALESCE((SELECT version FROM fp_runtime_control WHERE key='execution'),0) AS version,(SELECT count(*) FROM fp_request_leases WHERE completed_at IS NULL AND expires_at>now()) AS active_requests");
  const row = result.rows[0];
  return { held: row.held, version: row.version, activeRequests: Number(row.active_requests) };
}
export async function setRuntimeHold(db: SqlDatabase, held: boolean, reason: string): Promise<RuntimeControl> {
  if (reason.trim().length < 8 || reason.length > 200) throw new DomainError("MAINTENANCE_REASON_REQUIRED", "Record a concise operator reason for this execution change.", 400);
  await db.transaction(async tx => {
    const result = await tx.query<{ version: number }>("INSERT INTO fp_runtime_control(key,held,reason) VALUES('execution',$1,$2) ON CONFLICT(key) DO UPDATE SET held=$1,reason=$2,version=fp_runtime_control.version+1,updated_at=now() RETURNING version", [held, reason.trim()]);
    await tx.query("INSERT INTO fp_runtime_control_events(id,held,version,reason) VALUES($1,$2,$3,$4)", [randomUUID(), held, result.rows[0].version, reason.trim()]);
  });
  return runtimeControl(db);
}
export async function beginExecutionLease(db: SqlDatabase, action: string): Promise<string> {
  return db.transaction(async tx => {
    await tx.query("INSERT INTO fp_runtime_control(key) VALUES('execution') ON CONFLICT DO NOTHING");
    const row = (await tx.query<{ held: boolean }>("SELECT held FROM fp_runtime_control WHERE key='execution' FOR UPDATE")).rows[0];
    if (row.held) throw new DomainError("WORKSPACE_MAINTENANCE", "This workspace is temporarily read-only while its private records are transferred. Your saved work is intact.", 503);
    const id = randomUUID();
    await tx.query("INSERT INTO fp_request_leases(id,action,expires_at) VALUES($1,$2,now()+interval '6 minutes')", [id, action.slice(0,200)]);
    return id;
  });
}
export async function finishExecutionLease(db: SqlConnection, id: string) { await db.query("UPDATE fp_request_leases SET completed_at=now() WHERE id=$1 AND completed_at IS NULL", [id]); }
export async function executionQuiescence(tx: SqlConnection) {
  const control = await runtimeControl(tx);
  const active: Record<string, number> = {};
  for (const table of ["fp_outbox", "fp_webhook_jobs", "fp_documents", "fp_ai_runs", "fp_payables"]) {
    if (!(await tx.query<{ present: string | null }>("SELECT to_regclass($1)::text AS present", [table])).rows[0].present) continue;
    const result = await tx.query<{ count: string }>(`SELECT count(*) AS count FROM ${table} WHERE lease_until>now()`);
    if (Number(result.rows[0].count)) active[table] = Number(result.rows[0].count);
  }
  if ((await tx.query<{ present: string | null }>("SELECT to_regclass('fp_provider_operations')::text AS present")).rows[0].present) {
    const result = await tx.query<{ count: string }>("SELECT count(*) AS count FROM fp_provider_operations WHERE status IN ('claimed','dispatching') AND COALESCE(dispatched_at,created_at)>now()-interval '6 minutes'");
    if (Number(result.rows[0].count)) active.fp_provider_operations = Number(result.rows[0].count);
  }
  if ((await tx.query<{ present: string | null }>("SELECT to_regclass('paycore_operations')::text AS present")).rows[0].present) {
    const result = await tx.query<{ count: string }>("SELECT count(*) AS count FROM paycore_operations WHERE status IN ('claimed','dispatching')");
    if (Number(result.rows[0].count)) active.paycore_operations = Number(result.rows[0].count);
  }
  return { ...control, activeWorkerLeases: active, quiescent: control.held && control.activeRequests === 0 && Object.keys(active).length === 0 };
}
