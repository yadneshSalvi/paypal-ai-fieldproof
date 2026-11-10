import { randomUUID } from "node:crypto";
import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import { DomainError } from "../domain/money";
import { query } from "./db";

export type ExternalOperationStatus = "claimed" | "dispatching" | "succeeded" | "refused" | "not_sent" | "unknown";
export interface ExternalOperation {
  id: string; tenant_id: string; project_id: string; actor_id: string; resource_id: string;
  kind: string; business_key: string; request_id: string; payload_hash: string;
  status: ExternalOperationStatus; diagnostic_code: string | null; http_status: number | null;
  observation: Record<string, unknown> | null; dispatched_at: Date | null;
}
export async function claimExternalOperation(tx: SqlConnection, input: {
  tenantId: string; projectId: string; actorId: string; resourceId: string;
  kind: string; businessKey: string; payload: unknown;
}): Promise<ExternalOperation> {
  const digest = sha256(canonicalJson(input.payload));
  await tx.query(`INSERT INTO fp_provider_operations(id,tenant_id,project_id,actor_id,resource_id,kind,business_key,request_id,payload_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,business_key) DO NOTHING`,
  [randomUUID(), input.tenantId, input.projectId, input.actorId, input.resourceId, input.kind, input.businessKey, randomUUID(), digest]);
  const [operation] = await query<ExternalOperation>("SELECT * FROM fp_provider_operations WHERE tenant_id=$1 AND business_key=$2 FOR UPDATE", [input.tenantId, input.businessKey], tx);
  if (!operation || operation.payload_hash !== digest || operation.resource_id !== input.resourceId || operation.actor_id !== input.actorId || operation.project_id !== input.projectId || operation.kind !== input.kind) throw new DomainError("OPERATION_CONFLICT", "This action is already bound to a different request. Check its saved result.");
  return operation;
}
export async function dispatchExternalOperation(tx: SqlConnection, operation: ExternalOperation): Promise<boolean> {
  const rows = await query(`UPDATE fp_provider_operations SET status='dispatching',dispatched_at=now()
    WHERE id=$1 AND status='claimed' AND payload_hash=$2 RETURNING id`, [operation.id, operation.payload_hash], tx);
  return rows.length === 1;
}
export async function finishExternalOperation(tx: SqlConnection, id: string, status: Exclude<ExternalOperationStatus, "claimed" | "dispatching">, input: { code?: string; httpStatus?: number; observation?: Record<string, unknown> } = {}): Promise<void> {
  await tx.query(`UPDATE fp_provider_operations SET status=$2,diagnostic_code=$3,http_status=$4,
    observation=$5::jsonb,completed_at=now() WHERE id=$1 AND status IN ('dispatching','unknown')`,
  [id, status, input.code ?? null, input.httpStatus ?? null, JSON.stringify(input.observation ?? {})]);
}
