import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalJson, sha256, SqlPaymentStore, type PostgresDatabase, type SqlConnection } from "@fracture/paypal-core";
import { DomainError } from "../domain/money";
import { openPrivate, paymentOperationCodec, sealPrivate } from "./private-values";
import { query } from "./db";
import { HOSTED_ORIGIN, LOCAL_ORIGIN } from "./workspace-handoff";
import { executionQuiescence } from "./runtime-control";

type Row = Record<string, unknown>;
type Scope = { tenantId: string; projectId: string };
interface TableSpec { name: string; keys: string[]; where: string; order?: string; }
const scoped = "t.tenant_id=$1 AND t.project_id=$2";
const project = "t.project_id=$2";
const child = (field: string, table: string) => `t.${field} IN (SELECT id FROM ${table} WHERE tenant_id=$1 AND project_id=$2)`;
const spec = (name: string, keys: string[], where = scoped, order?: string): TableSpec => ({ name, keys, where, order });
// Explicit dependency order; no arbitrary tables or source paths are accepted.
const tables: TableSpec[] = [
  spec("fp_tenants", ["id"], "t.id=$1"), spec("fp_projects", ["id"], "t.tenant_id=$1 AND t.id=$2"),
  spec("fp_packages", ["project_id", "id"], project), spec("fp_sessions", ["id"]), spec("fp_memberships", ["project_id", "actor_id"]),
  spec("fp_collection_rounds", ["id"]), spec("fp_obligations", ["id"]), spec("fp_conditional_consents", ["id"]),
  spec("fp_collection_items", ["round_id", "consent_id"], child("round_id", "fp_collection_rounds")),
  spec("fp_approval_records", ["id"]), spec("fp_payment_commands", ["operation_id"]), spec("fp_provider_orders", ["order_id"]),
  spec("paycore_operations", ["tenant_id", "project_id", "id"]), spec("paycore_resource_locks", ["tenant_id", "project_id", "resource_key"]), spec("paycore_attempts", ["id"]),
  spec("fp_settlement_receipts", ["id"]), spec("fp_economic_aliases", ["merchant_scope", "alias"], child("receipt_id", "fp_settlement_receipts")),
  spec("fp_journal", ["id"]), spec("fp_evidence", ["id"]), spec("fp_events", ["id"], scoped, "t.sequence"), spec("fp_outbox", ["id"]),
  spec("fp_identity_states", ["state_hash"], child("session_id", "fp_sessions")),
  spec("fp_recipient_accounts", ["id"], "t.tenant_id=$1 AND t.actor_id IN (SELECT actor_id FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2)"),
  spec("fp_provider_operations", ["id"]), spec("fp_recovery_invoices", ["id"]), spec("fp_invoice_payment_observations", ["id"], child("invoice_id", "fp_recovery_invoices")), spec("fp_refunds", ["id"]),
  spec("fp_documents", ["id"]), spec("fp_ai_runs", ["id"]), spec("fp_ai_attempts", ["run_id", "attempt"], child("run_id", "fp_ai_runs")),
  spec("fp_receipt_groups", ["id"]), spec("fp_receipt_group_documents", ["document_id"], child("document_id", "fp_documents")), spec("fp_receipt_group_lines", ["group_id", "line_key"], child("group_id", "fp_receipt_groups")),
  spec("fp_claims", ["id"]), spec("fp_claim_revisions", ["claim_id", "version"], child("claim_id", "fp_claims")), spec("fp_claim_line_reviews", ["claim_id", "claim_line_id"], child("claim_id", "fp_claims")), spec("fp_receipt_comparison_decisions", ["id"]),
  spec("fp_payable_reviews", ["id"]), spec("fp_balance_observations", ["id"], "t.id IN (SELECT balance_observation_id FROM fp_payables WHERE tenant_id=$1 AND project_id=$2)"),
  spec("fp_payables", ["id"]), spec("fp_payable_lines", ["payable_id", "claim_line_id"], child("payable_id", "fp_payables")), spec("fp_payable_approval_intents", ["tenant_id", "actor_id", "intent_id"]),
  spec("fp_receipt_allocations", ["id"]), spec("fp_merchant_journal", ["id"], child("payable_id", "fp_payables")), spec("fp_payout_observations", ["id"], child("payable_id", "fp_payables")),
  spec("fp_allocation_revisions", ["id"], child("receipt_id", "fp_settlement_receipts"), "t.revision,t.id"), spec("fp_workspace_handoffs", ["id"]),
];
const identifier = (value: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw new Error("TRANSFER_IDENTIFIER_INVALID"); return `"${value}"`; };
const digest = (value: unknown) => sha256(canonicalJson(value));
const normalize = (table: string, row: Row): Row => { const value = { ...row }; if (table === "fp_events") delete value.sequence; return value; };
const values = (bundle: WorkspaceTransfer, table: string) => bundle.tables.find(value => value.name === table)?.rows ?? [];
export interface TransferConfiguration { authSecret: string; clientId: string; blobToken: string; }
function configProof(config: TransferConfiguration) {
  if (config.authSecret.length < 32 || !config.clientId || !config.blobToken) throw new DomainError("TRANSFER_CONFIGURATION_MISSING", "Private encryption, isolated merchant and private Blob configuration are all required.", 409);
  return { encryption: createHash("sha256").update(`fieldproof-transfer-encryption:${config.authSecret}`).digest("hex"), merchant: sha256(config.clientId), blob: sha256(config.blobToken) };
}
export function transferConfiguration(): TransferConfiguration { return { authSecret: process.env.AUTH_SECRET ?? "", clientId: process.env.PAYPAL_CLIENT_ID ?? "", blobToken: process.env.BLOB_READ_WRITE_TOKEN ?? "" }; }
function sameProof(left: string, right: string): boolean { return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right)); }
export function assertTransferConfiguration(bundle: WorkspaceTransfer, configuration: TransferConfiguration): void {
  const proof = configProof(configuration);
  if (!Object.entries(proof).every(([key, value]) => sameProof(value, bundle.configuration[key as keyof typeof proof]))) throw new DomainError("TRANSFER_CONFIGURATION_MISMATCH", "The destination encryption secret, isolated merchant or private Blob configuration differs. No project records were imported.", 409);
}
export interface WorkspaceTransfer {
  version: 1; id: string; scope: Scope; cutoff: string; sourceOrigin: typeof LOCAL_ORIGIN; targetOrigin: typeof HOSTED_ORIGIN;
  configuration: ReturnType<typeof configProof>; schemaVersions: number[];
  sourceExecution: Awaited<ReturnType<typeof executionQuiescence>>;
  tables: { name: string; rows: Row[] }[];
  sourceEventSequence: { eventId: string; sequence: string }[];
  webhookArchive: { table: string; keyHash: string; bodyHash: string; row: Row }[];
}
export interface TransferEnvelope { format: "fieldproof-private-transfer-v1"; id: string; ciphertext: string; }
export interface TransferManifest {
  version: 1; bundleId: string; bundleHash: string; sourceCutoff: string; tenantIdHash: string; projectIdHash: string;
  schemaVersions: number[]; tables: { name: string; rows: number; inserted?: number; alreadyPresent?: number }[];
  eventSequencePolicy: string; webhookArchiveRows: number; historicalWebhookReplay: false;
  collection: { rounds: number; targetMinor: number; canonicalCreditedMinor: number; conditionalCreditedMinor: number; separateTestCreditedMinor: number; untouchedItems: number; deadlines: string[] };
  claims: { count: number; revisions: number; approvedMinor: number }; providerWrites: 0;
  configurationMatches?: boolean; mode?: "dry_run" | "applied" | "already_applied";
  sourceExecution: Awaited<ReturnType<typeof executionQuiescence>>;
  destinationExecution?: Awaited<ReturnType<typeof executionQuiescence>>;
}
export function transferManifest(bundle: WorkspaceTransfer): TransferManifest {
  const rounds = values(bundle, "fp_collection_rounds"), receipts = values(bundle, "fp_settlement_receipts");
  const conditional = new Set(values(bundle, "fp_obligations").filter(row => row.purpose === "conditional_pledge").map(row => row.id));
  const test = new Set(values(bundle, "fp_obligations").filter(row => row.purpose === "sandbox_test").map(row => row.id));
  return { version: 1, bundleId: bundle.id, bundleHash: digest(bundle), sourceCutoff: bundle.cutoff, tenantIdHash: sha256(bundle.scope.tenantId), projectIdHash: sha256(bundle.scope.projectId), schemaVersions: bundle.schemaVersions,
    tables: bundle.tables.map(table => ({ name: table.name, rows: table.rows.length })), eventSequencePolicy: "Preserve immutable event IDs and source order; allocate destination-local cursor sequences and retain the original sequence map.", webhookArchiveRows: bundle.webhookArchive.length, historicalWebhookReplay: false,
    collection: { rounds: rounds.length, targetMinor: rounds.reduce((sum, row) => sum + Number(row.target_minor), 0), canonicalCreditedMinor: receipts.reduce((sum, row) => sum + Number((row.data as Row).creditedMinor ?? 0), 0), conditionalCreditedMinor: receipts.filter(row => conditional.has(row.obligation_id)).reduce((sum, row) => sum + Number((row.data as Row).creditedMinor ?? 0), 0), separateTestCreditedMinor: receipts.filter(row => test.has(row.obligation_id)).reduce((sum, row) => sum + Number((row.data as Row).creditedMinor ?? 0), 0), untouchedItems: values(bundle, "fp_collection_items").filter(row => !row.operation_id).length, deadlines: rounds.map(row => String(row.recovery_ends_at)) },
    claims: { count: values(bundle, "fp_claims").length, revisions: values(bundle, "fp_claim_revisions").length, approvedMinor: values(bundle, "fp_claims").reduce((sum, row) => sum + Number(row.approved_minor), 0) }, providerWrites: 0, sourceExecution: bundle.sourceExecution };
}
export function sealTransfer(bundle: WorkspaceTransfer): TransferEnvelope { return { format: "fieldproof-private-transfer-v1", id: bundle.id, ciphertext: sealPrivate(bundle, `workspace-transfer:${bundle.id}`) }; }
export function openTransfer(envelope: TransferEnvelope): WorkspaceTransfer {
  if (envelope.format !== "fieldproof-private-transfer-v1" || !/^[a-f0-9-]{36}$/.test(envelope.id)) throw new DomainError("TRANSFER_INVALID", "The private transfer format is not supported.", 400);
  const bundle = openPrivate<WorkspaceTransfer>(envelope.ciphertext, `workspace-transfer:${envelope.id}`);
  if (bundle.version !== 1 || bundle.id !== envelope.id || bundle.sourceOrigin !== LOCAL_ORIGIN || bundle.targetOrigin !== HOSTED_ORIGIN || !Number.isFinite(Date.parse(bundle.cutoff))) throw new DomainError("TRANSFER_INVALID", "The private transfer identity does not match.", 400);
  if (bundle.tables.length !== tables.length || tables.some((table, index) => table.name !== bundle.tables[index]?.name || !Array.isArray(bundle.tables[index]?.rows))) throw new DomainError("TRANSFER_SCHEMA_CHANGED", "This transfer has a different table contract. Review its source version before continuing.", 409);
  return bundle;
}
export async function exportWorkspace(source: PostgresDatabase, scope: Scope, configuration = transferConfiguration()): Promise<WorkspaceTransfer> {
  return source.transaction(async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await tx.query("SET LOCAL timezone='UTC'");
    const [owner] = await query<{ mode: string }>("SELECT t.mode FROM fp_tenants t JOIN fp_projects p ON p.tenant_id=t.id WHERE t.id=$1 AND p.id=$2", [scope.tenantId, scope.projectId], tx);
    if (owner?.mode !== "live_sandbox") throw new DomainError("TRANSFER_WORKSPACE_INVALID", "Choose the original live sandbox workspace.", 409);
    const bundle: WorkspaceTransfer = { version: 1, id: randomUUID(), scope, cutoff: new Date().toISOString(), sourceOrigin: LOCAL_ORIGIN, targetOrigin: HOSTED_ORIGIN, configuration: configProof(configuration), schemaVersions: (await query<{ version: number }>("SELECT version FROM fp_schema_versions ORDER BY version", [], tx)).map(row => row.version), sourceExecution: await executionQuiescence(tx), tables: [], sourceEventSequence: [], webhookArchive: [] };
    for (const table of tables) {
      const rows = await query<{ data: Row }>(`SELECT to_jsonb(t) AS data FROM ${identifier(table.name)} t WHERE (${table.where}) AND $1::text IS NOT NULL AND $2::text IS NOT NULL ORDER BY ${table.order ?? table.keys.map(key => `t.${identifier(key)}`).join(",")}`, [scope.tenantId, scope.projectId], tx);
      for (const { data } of rows) {
        if (data.lease_until && Date.parse(String(data.lease_until)) > Date.now()) throw new DomainError("TRANSFER_ACTIVE_LEASE", "Wait for the original in-flight work to finish before freezing this snapshot.", 409);
        if (table.name === "paycore_operations" && ["claimed", "dispatching"].includes(String(data.status))) throw new DomainError("TRANSFER_ACTIVE_PAYMENT", "Reconcile the original in-flight payment before transferring its workspace.", 409);
        if (table.name === "fp_events") bundle.sourceEventSequence.push({ eventId: String(data.id), sequence: String(data.sequence) });
      }
      bundle.tables.push({ name: table.name, rows: rows.map(({ data }) => normalize(table.name, data)) });
    }
    // Use the same authenticated operation codec as the application. Wrong keys
    // or altered command identities stop export before a cloud import is possible.
    const store = new SqlPaymentStore({ dialect: tx.dialect, query: tx.query.bind(tx), transaction: async work => work(tx), close: async () => {} }, { operationDocumentCodec: paymentOperationCodec });
    for (const row of values(bundle, "paycore_operations")) await store.get(scope, String(row.id));
    const ownedJobs = await query<{ data: Row }>("SELECT to_jsonb(t) AS data FROM fp_webhook_jobs t WHERE owner_tenant_id=$1 AND owner_project_id=$2 ORDER BY inbox_id,event_id", [scope.tenantId, scope.projectId], tx);
    for (const { data: job } of ownedJobs) {
      bundle.webhookArchive.push({ table: "fp_webhook_jobs", keyHash: digest([job.inbox_id, job.event_id]), bodyHash: digest(job), row: job });
      for (const table of ["paycore_webhook_events", "paycore_webhook_deliveries"]) {
        const rows = await query<{ data: Row }>(`SELECT to_jsonb(t) AS data FROM ${identifier(table)} t WHERE tenant_id=$1 AND event_id=$2 ORDER BY ${table.endsWith("deliveries") ? "id" : "project_id"}`, [job.inbox_id, job.event_id], tx);
        for (const { data } of rows) bundle.webhookArchive.push({ table, keyHash: digest(table.endsWith("deliveries") ? data.id : [data.tenant_id, data.project_id, data.event_id]), bodyHash: digest(data), row: data });
      }
    }
    return bundle;
  });
}
class DryRunComplete extends Error { constructor(readonly manifest: TransferManifest) { super("TRANSFER_DRY_RUN_ROLLED_BACK"); } }
async function rowAt(tx: SqlConnection, table: TableSpec, row: Row) {
  const [existing] = await query<{ data: Row }>(`SELECT to_jsonb(t) AS data FROM ${identifier(table.name)} t WHERE ${table.keys.map((key, index) => `t.${identifier(key)}=$${index + 1}`).join(" AND ")}`, table.keys.map(key => row[key]), tx);
  return existing ? normalize(table.name, existing.data) : null;
}
export async function importWorkspace(target: PostgresDatabase, bundle: WorkspaceTransfer, configuration: TransferConfiguration, dryRun = true): Promise<TransferManifest> {
  assertTransferConfiguration(bundle, configuration);
  const manifest = transferManifest(bundle);
  if (!bundle.sourceExecution?.quiescent) throw new DomainError("TRANSFER_SOURCE_NOT_QUIESCENT", "The source snapshot was not taken under a drained execution hold. Hold the original writer, wait for work to finish and export again.", 409);
  try {
    return await target.transaction(async tx => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await tx.query("SET LOCAL timezone='UTC'");
      await tx.query("SET LOCAL lock_timeout='5s'");
      await tx.query("SET LOCAL statement_timeout='60s'");
      await tx.query("SET LOCAL idle_in_transaction_session_timeout='30s'");
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`workspace-import:${bundle.scope.projectId}`]);
      const versions = (await query<{ version: number }>("SELECT version FROM fp_schema_versions ORDER BY version", [], tx)).map(row => row.version);
      if (canonicalJson(versions) !== canonicalJson(bundle.schemaVersions)) throw new DomainError("TRANSFER_SCHEMA_MISMATCH", "Deploy and initialize the exact application schema before importing this snapshot.", 409);
      const [previous] = await query<{ bundle_hash: string; manifest: TransferManifest }>("SELECT bundle_hash,manifest FROM fp_workspace_imports WHERE id=$1", [bundle.id], tx);
      if (previous) {
        if (previous.bundle_hash !== manifest.bundleHash) throw new DomainError("TRANSFER_IDENTITY_CHANGED", "This import identity already records a different snapshot.", 409);
        return { ...previous.manifest, mode: "already_applied" };
      }
      await tx.query("SELECT key FROM fp_runtime_control WHERE key='execution' FOR UPDATE");
      manifest.destinationExecution = await executionQuiescence(tx);
      if (!manifest.destinationExecution.quiescent) throw new DomainError("TRANSFER_TARGET_NOT_QUIESCENT", "The hosted writer is not held and drained. No records were imported.", 409);
      await tx.query(`LOCK TABLE ${[...tables.map(table => table.name), "fp_workspace_imports", "fp_transfer_webhook_archive"].sort().map(identifier).join(",")} IN SHARE ROW EXCLUSIVE MODE`);
      let negativeCursor = Number((await query<{ minimum: string }>("SELECT COALESCE(min(sequence),0) AS minimum FROM fp_events", [], tx))[0].minimum) - 1;
      for (const [index, table] of tables.entries()) {
        const report = manifest.tables[index]; report.inserted = 0; report.alreadyPresent = 0;
        const columns = (await query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1", [table.name], tx)).map(row => row.column_name);
        for (const incoming of bundle.tables[index].rows) {
          if (!table.keys.every(key => incoming[key] !== undefined && incoming[key] !== null) || Object.keys(incoming).some(key => !columns.includes(key))) throw new DomainError("TRANSFER_ROW_INVALID", `The ${table.name} row contract does not match the destination schema.`, 409);
          const existing = await rowAt(tx, table, incoming);
          if (existing) {
            if (digest(existing) !== digest(incoming)) throw new DomainError("TRANSFER_RECORD_CONFLICT", `An existing ${table.name} record differs from the original snapshot. Nothing was overwritten.`, 409);
            report.alreadyPresent++; continue;
          }
          // Dry runs exercise all SQL constraints but allocate no real sequence values.
          const row = table.name === "fp_events" && dryRun ? { ...incoming, sequence: negativeCursor-- } : incoming;
          const names = Object.keys(row).map(identifier).join(",");
          await tx.query(`INSERT INTO ${identifier(table.name)} (${names}) SELECT ${names} FROM jsonb_populate_record(NULL::${identifier(table.name)},$1::jsonb)`, [canonicalJson(row)]);
          report.inserted++;
        }
      }
      manifest.configurationMatches = true; manifest.mode = dryRun ? "dry_run" : "applied";
      const handoffs = values(bundle, "fp_workspace_handoffs").filter(row => !row.consumed_at && !row.revoked_at).map(row => row.id);
      await tx.query("INSERT INTO fp_workspace_imports(id,bundle_hash,tenant_id,project_id,source_cutoff,handoff_ids,manifest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)", [bundle.id, manifest.bundleHash, bundle.scope.tenantId, bundle.scope.projectId, bundle.cutoff, canonicalJson(handoffs), canonicalJson({ ...manifest, sourceEventSequence: bundle.sourceEventSequence })]);
      for (const entry of bundle.webhookArchive) {
        const id = randomUUID();
        await tx.query("INSERT INTO fp_transfer_webhook_archive(id,bundle_id,tenant_id,project_id,source_table,source_key_hash,source_body_hash,encrypted_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id, bundle.id, bundle.scope.tenantId, bundle.scope.projectId, entry.table, entry.keyHash, entry.bodyHash, sealPrivate(entry.row, `transfer-webhook:${bundle.scope.tenantId}:${bundle.scope.projectId}:${bundle.id}:${id}`)]);
      }
      if (dryRun) throw new DryRunComplete(manifest);
      return manifest;
    });
  } catch (error) {
    if (error instanceof DryRunComplete) return error.manifest;
    if (error instanceof DomainError) throw error;
    throw new DomainError("TRANSFER_DATABASE_CONFLICT", "The destination rejected a row or constraint. The entire import was rolled back; existing hosted history is unchanged.", 409);
  }
}
