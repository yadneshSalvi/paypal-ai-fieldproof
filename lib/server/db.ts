import { PostgresDatabase, SqlPaymentStore, type SqlConnection, type SqlDatabase } from "@fracture/paypal-core";
import { DomainError } from "../domain/money";
import { paymentOperationCodec } from "./private-values";
import { RUNTIME_CONTROL_SCHEMA } from "./runtime-control";
import { STUDIO_SCHEMA } from "./studio-schema";
import { PLANNING_SCHEMA } from "./planning-schema";

const state = globalThis as typeof globalThis & { fieldproofDb?: PostgresDatabase; fieldproofReady?: Promise<void> };
export function database(): PostgresDatabase {
  if (!state.fieldproofDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Fieldproof requires a durable PostgreSQL DATABASE_URL.");
    state.fieldproofDb = new PostgresDatabase(url);
  }
  return state.fieldproofDb;
}
export async function query<T>(sql: string, values: unknown[] = [], connection: SqlConnection = database()): Promise<T[]> {
  return (await connection.query(sql, values)).rows as T[];
}
export async function initializeDatabase(): Promise<void> {
  if (!state.fieldproofReady) state.fieldproofReady = initializeDatabaseAt(database()).catch(error => { state.fieldproofReady = undefined; throw error; });
  return state.fieldproofReady;
}
export async function initializeDatabaseAt(target: PostgresDatabase): Promise<void> {
  try {
    await target.transaction(async tx => {
      // A cold request must not wait behind a long workspace import or another migration.
      await tx.query("SET LOCAL lock_timeout='2000ms'; SET LOCAL statement_timeout='15000ms'");
      if (await schemaReady(tx)) return;
      await tx.query("SELECT pg_advisory_xact_lock(410202611)");
      if (await schemaReady(tx)) return;
      await tx.query(schema);
      // Keep the app marker and payment-store migration in the same transaction. A failed
      // initialization must not leave a ready marker ahead of its operation tables/index.
      const transactionalStore: SqlDatabase = {
        dialect: tx.dialect, query: tx.query.bind(tx),
        transaction: work => work(tx), close: async () => undefined,
      };
      await new SqlPaymentStore(transactionalStore, { operationDocumentCodec: paymentOperationCodec }).initialize();
    });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (["55P03", "57014", "40P01"].includes(code))
      throw new DomainError("DATABASE_INITIALIZING", "The private workspace is finishing a database operation. Wait a moment and refresh; no payment has been retried.", 503);
    throw error;
  }
}

const CURRENT_SCHEMA_VERSION = 11;
async function schemaReady(tx: SqlConnection): Promise<boolean> {
  const existing = await tx.query<Record<string, string | null>>(
    "SELECT to_regclass('fp_schema_versions')::text AS app,to_regclass('paycore_operations')::text AS operations,to_regclass('paycore_attempts')::text AS attempts,to_regclass('paycore_resource_locks')::text AS locks,to_regclass('paycore_webhook_events')::text AS events,to_regclass('paycore_webhook_deliveries')::text AS deliveries,to_regclass('paycore_provider_identity')::text AS identity,to_regclass('fp_studio_snapshots')::text AS studio_snapshots,to_regclass('fp_studio_reports')::text AS studio_reports,to_regclass('fp_studio_layout_events')::text AS studio_layout,to_regclass('fp_studio_agent_runs')::text AS studio_runs,to_regclass('fp_studio_tool_receipts')::text AS studio_receipts,to_regclass('fp_studio_chat_threads')::text AS studio_chats,to_regclass('fp_studio_one_delegate')::text AS studio_delegate");
  if (!existing.rows[0] || Object.values(existing.rows[0]).some(value => value === null)) return false;
  const planning = await tx.query<Record<string, string | null>>("SELECT to_regclass('fp_planning_heads')::text AS heads,to_regclass('fp_plan_runs')::text AS runs,to_regclass('fp_work_signoffs')::text AS evidence,to_regclass('fp_reviewer_invites')::text AS reviewer_access");
  if (!planning.rows[0] || Object.values(planning.rows[0]).some(value => value === null)) return false;
  const checkpoint = await tx.query<{ ready: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('fp_plan_runs') AND attname='resume_until' AND NOT attisdropped) AS ready");
  const observations = await tx.query<{ ready: string | null }>("SELECT to_regclass('fp_plan_provider_observations')::text AS ready");
  if (!checkpoint.rows[0]?.ready || !observations.rows[0]?.ready) return false;
  const version = await tx.query<{ version: number | null }>("SELECT max(version) AS version FROM fp_schema_versions");
  return Number(version.rows[0]?.version ?? 0) >= CURRENT_SCHEMA_VERSION;
}

const schema = `
${RUNTIME_CONTROL_SCHEMA}
CREATE TABLE IF NOT EXISTS fp_request_buckets (
  bucket_key text PRIMARY KEY, request_count integer NOT NULL CHECK(request_count>0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_tenants (
  id text PRIMARY KEY, mode text NOT NULL CHECK (mode IN ('sample','live_sandbox')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_projects (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), slug text NOT NULL UNIQUE,
  version integer NOT NULL DEFAULT 1, projection_version integer NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL, tour_step integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_packages (
  id text NOT NULL, project_id text NOT NULL REFERENCES fp_projects(id),
  version integer NOT NULL DEFAULT 1, budget_minor bigint NOT NULL CHECK (budget_minor > 0),
  data jsonb NOT NULL, PRIMARY KEY (project_id,id)
);
CREATE TABLE IF NOT EXISTS fp_sessions (
  id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, tenant_id text NOT NULL REFERENCES fp_tenants(id),
  project_id text NOT NULL REFERENCES fp_projects(id), actor_id text NOT NULL,
  role text NOT NULL CHECK(role IN ('donor','volunteer','organizer','auditor')),
  sandbox_limit_minor bigint NOT NULL DEFAULT 500, expires_at timestamptz NOT NULL,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_obligations (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  package_id text NOT NULL, actor_id text NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor > 0),
  channel text NOT NULL, purpose text NOT NULL CHECK(purpose IN ('conditional_pledge','sandbox_test')),
  consent_version integer NOT NULL DEFAULT 1, version integer NOT NULL DEFAULT 1,
  data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,package_id) REFERENCES fp_packages(project_id,id)
);
CREATE TABLE IF NOT EXISTS fp_memberships (
  tenant_id text NOT NULL REFERENCES fp_tenants(id) ON DELETE CASCADE, project_id text NOT NULL REFERENCES fp_projects(id) ON DELETE CASCADE,
  actor_id text NOT NULL, roles jsonb NOT NULL, state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  PRIMARY KEY(project_id,actor_id)
);
INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles)
  SELECT tenant_id,project_id,actor_id,'["donor","volunteer","organizer","auditor"]'::jsonb
  FROM (SELECT DISTINCT ON(project_id) tenant_id,project_id,actor_id FROM fp_sessions ORDER BY project_id,created_at,id) founders
  ON CONFLICT(project_id,actor_id) DO NOTHING;
CREATE TABLE IF NOT EXISTS fp_collection_rounds (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, package_id text NOT NULL,
  package_version integer NOT NULL, target_minor bigint NOT NULL,
  collection_started_at timestamptz NOT NULL, recovery_ends_at timestamptz NOT NULL,
  policy_hash text NOT NULL, state text NOT NULL, data jsonb NOT NULL,
  CHECK(recovery_ends_at = collection_started_at + interval '48 hours')
);
CREATE UNIQUE INDEX IF NOT EXISTS fp_active_round ON fp_collection_rounds(project_id,package_id)
  WHERE state IN ('collecting','recovering');
ALTER TABLE fp_collection_rounds ADD COLUMN IF NOT EXISTS cancellation_reason text;
ALTER TABLE fp_collection_rounds ADD COLUMN IF NOT EXISTS cancelled_by text;
ALTER TABLE fp_collection_rounds ADD COLUMN IF NOT EXISTS cancellation_requested_at timestamptz;
CREATE TABLE IF NOT EXISTS fp_settlement_receipts (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL REFERENCES fp_projects(id),
  obligation_id text NOT NULL REFERENCES fp_obligations(id), package_id text NOT NULL,
  provider_ref text NOT NULL, provenance text NOT NULL, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_economic_aliases (
  merchant_scope text NOT NULL, alias text NOT NULL, receipt_id text NOT NULL REFERENCES fp_settlement_receipts(id),
  PRIMARY KEY(merchant_scope,alias)
);
CREATE TABLE IF NOT EXISTS fp_approval_records (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, actor_id text NOT NULL,
  resource_id text NOT NULL, resource_version integer NOT NULL, digest text NOT NULL,
  expires_at timestamptz NOT NULL, revoked_at timestamptz, data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS fp_payment_commands (
  operation_id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL,
  obligation_id text NOT NULL REFERENCES fp_obligations(id), session_id text NOT NULL REFERENCES fp_sessions(id),
  business_key text NOT NULL, payload_hash text NOT NULL, command jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,business_key)
);
CREATE TABLE IF NOT EXISTS fp_provider_orders (
  order_id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL,
  obligation_id text NOT NULL REFERENCES fp_obligations(id), operation_id text NOT NULL,
  observed_state text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_journal (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL,
  receipt_id text NOT NULL REFERENCES fp_settlement_receipts(id), account text NOT NULL,
  side text NOT NULL CHECK(side IN ('debit','credit')), amount_minor bigint NOT NULL CHECK(amount_minor >= 0),
  currency text NOT NULL CHECK(currency = 'USD'), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_evidence (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL REFERENCES fp_projects(id),
  data jsonb NOT NULL, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_events (
  sequence bigserial PRIMARY KEY, id text NOT NULL UNIQUE, tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES fp_projects(id), type text NOT NULL, data jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_outbox (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL,
  kind text NOT NULL, data jsonb NOT NULL, status text NOT NULL DEFAULT 'queued',
  available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fp_outbox_ready ON fp_outbox(status, available_at);
CREATE TABLE IF NOT EXISTS fp_identity_states (
  state_hash text PRIMARY KEY, session_id text NOT NULL REFERENCES fp_sessions(id),
  expires_at timestamptz NOT NULL, consumed_at timestamptz
);
ALTER TABLE fp_identity_states ADD COLUMN IF NOT EXISTS origin text;
ALTER TABLE fp_payment_commands ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;
ALTER TABLE fp_payment_commands ADD COLUMN IF NOT EXISTS reconciliation_code text;
CREATE TABLE IF NOT EXISTS fp_recipient_accounts (
  id text PRIMARY KEY, tenant_id text NOT NULL, actor_id text NOT NULL,
  encrypted_destination text NOT NULL, masked_label text NOT NULL, verification_method text NOT NULL,
  account_verified boolean NOT NULL, version integer NOT NULL DEFAULT 1,
  verified_at timestamptz NOT NULL, UNIQUE(tenant_id,actor_id)
);
CREATE TABLE IF NOT EXISTS fp_webhook_jobs (
  inbox_id text NOT NULL, event_id text NOT NULL, event_type text NOT NULL, resource_id text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','retry','processed','review')),
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  lease_id text, lease_until timestamptz, last_code text,
  owner_tenant_id text, owner_project_id text, observation jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  PRIMARY KEY(inbox_id,event_id)
);
CREATE INDEX IF NOT EXISTS fp_webhook_jobs_ready ON fp_webhook_jobs(inbox_id,status,available_at);
CREATE TABLE IF NOT EXISTS fp_conditional_consents (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id),
  project_id text NOT NULL REFERENCES fp_projects(id), actor_id text NOT NULL,
  session_id text NOT NULL REFERENCES fp_sessions(id), obligation_id text NOT NULL UNIQUE REFERENCES fp_obligations(id),
  intent_id text NOT NULL, slot_index integer NOT NULL CHECK(slot_index BETWEEN 0 AND 7),
  package_id text NOT NULL, package_version integer NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0),
  version integer NOT NULL DEFAULT 1, status text NOT NULL, policy_digest text NOT NULL,
  policy jsonb NOT NULL, expires_at timestamptz NOT NULL, acknowledged_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz, round_id text REFERENCES fp_collection_rounds(id),
  encrypted_wallet text, wallet_label text, wallet_observed_at timestamptz,
  provider_status text, last_code text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,actor_id,intent_id), FOREIGN KEY(project_id,package_id) REFERENCES fp_packages(project_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS fp_conditional_slot ON fp_conditional_consents(project_id,package_id,slot_index)
  WHERE withdrawn_at IS NULL;
CREATE TABLE IF NOT EXISTS fp_provider_operations (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  actor_id text NOT NULL, resource_id text NOT NULL, kind text NOT NULL, business_key text NOT NULL,
  request_id text NOT NULL, payload_hash text NOT NULL, status text NOT NULL DEFAULT 'claimed',
  diagnostic_code text, http_status integer, observation jsonb, dispatched_at timestamptz,
  completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,business_key)
);
CREATE INDEX IF NOT EXISTS fp_provider_operations_pending ON fp_provider_operations(status,created_at);
CREATE TABLE IF NOT EXISTS fp_collection_items (
  round_id text NOT NULL REFERENCES fp_collection_rounds(id),
  consent_id text NOT NULL UNIQUE REFERENCES fp_conditional_consents(id),
  obligation_id text NOT NULL UNIQUE REFERENCES fp_obligations(id),
  consent_version integer NOT NULL, consent_digest text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>0), state text NOT NULL DEFAULT 'waiting',
  operation_id text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(round_id,consent_id)
);
ALTER TABLE fp_collection_items ADD COLUMN IF NOT EXISTS wallet_checked_at timestamptz;
ALTER TABLE fp_collection_items ADD COLUMN IF NOT EXISTS wallet_identity_hash text;
ALTER TABLE fp_collection_items ADD COLUMN IF NOT EXISTS last_code text;
CREATE TABLE IF NOT EXISTS fp_recovery_invoices (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  round_id text NOT NULL REFERENCES fp_collection_rounds(id), consent_id text NOT NULL REFERENCES fp_conditional_consents(id),
  obligation_id text NOT NULL UNIQUE REFERENCES fp_obligations(id), actor_id text NOT NULL, created_by text NOT NULL,
  creator_membership_version integer NOT NULL, consent_version integer NOT NULL, consent_digest text NOT NULL,
  package_version integer NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0),
  invoice_number text NOT NULL UNIQUE, reference text NOT NULL UNIQUE, provider_invoice_hash text UNIQUE,
  state text NOT NULL DEFAULT 'draft_requested', version integer NOT NULL DEFAULT 1,
  encrypted_data text NOT NULL, recipient_label text NOT NULL, last_code text,
  observed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_invoice_payment_observations (
  id text PRIMARY KEY, invoice_id text NOT NULL REFERENCES fp_recovery_invoices(id),
  payment_identity_hash text NOT NULL, state text NOT NULL, body_hash text NOT NULL,
  encrypted_data text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(invoice_id,payment_identity_hash,body_hash)
);
ALTER TABLE fp_settlement_receipts ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE fp_journal ADD COLUMN IF NOT EXISTS operation_id text;
ALTER TABLE fp_journal ADD COLUMN IF NOT EXISTS entry_kind text NOT NULL DEFAULT 'settlement';
CREATE TABLE IF NOT EXISTS fp_receipt_allocations (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  receipt_id text NOT NULL REFERENCES fp_settlement_receipts(id), claim_id text NOT NULL, claim_line_id text NOT NULL,
  package_id text NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0), state text NOT NULL DEFAULT 'reserved',
  revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(claim_id,claim_line_id,receipt_id,revision)
);
CREATE TABLE IF NOT EXISTS fp_refunds (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  receipt_id text NOT NULL REFERENCES fp_settlement_receipts(id), obligation_id text NOT NULL REFERENCES fp_obligations(id),
  actor_id text NOT NULL, session_id text NOT NULL REFERENCES fp_sessions(id), approved_role text NOT NULL,
  intent_id text NOT NULL, reason text NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0),
  attributed_minor bigint NOT NULL CHECK(attributed_minor>=0), excess_minor bigint NOT NULL CHECK(excess_minor>=0),
  receipt_version integer NOT NULL, receipt_identity_digest text NOT NULL, approval_digest text NOT NULL,
  state text NOT NULL DEFAULT 'reserved', operation_id text UNIQUE, provider_refund_hash text UNIQUE,
  budget jsonb NOT NULL, observed_at timestamptz NOT NULL, last_code text, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,receipt_id,intent_id),
  CHECK(amount_minor=attributed_minor+excess_minor)
);
ALTER TABLE fp_refunds ADD COLUMN IF NOT EXISTS checked_at timestamptz;
CREATE TABLE IF NOT EXISTS fp_documents (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  actor_id text NOT NULL, intent_id text NOT NULL, purpose text NOT NULL CHECK(purpose IN ('receipt','photo','signoff','quote','sketch')),
  provenance text NOT NULL CHECK(provenance IN ('user_upload','sample_document')),
  content_type text NOT NULL, declared_bytes integer NOT NULL CHECK(declared_bytes>0 AND declared_bytes<=8388608), expected_sha256 text NOT NULL,
  pathname text NOT NULL UNIQUE, encrypted_data text NOT NULL, state text NOT NULL DEFAULT 'awaiting_upload',
  version integer NOT NULL DEFAULT 1, sha256 text, perceptual_hash text, page_count integer,
  validation_code text, lease_id text, lease_until timestamptz,
  upload_expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,actor_id,intent_id)
);
CREATE INDEX IF NOT EXISTS fp_documents_hash ON fp_documents(project_id,sha256) WHERE sha256 IS NOT NULL;
ALTER TABLE fp_documents ADD COLUMN IF NOT EXISTS expected_sha256 text;
UPDATE fp_documents SET expected_sha256=sha256 WHERE expected_sha256 IS NULL AND sha256 IS NOT NULL;
CREATE TABLE IF NOT EXISTS fp_ai_runs (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  actor_id text NOT NULL, document_id text NOT NULL REFERENCES fp_documents(id), kind text NOT NULL,
  input_hash text NOT NULL, encrypted_input text NOT NULL, provider text NOT NULL, model text NOT NULL, prompt_version text NOT NULL,
  status text NOT NULL DEFAULT 'queued', encrypted_output text, diagnostic_code text, stats jsonb,
  lease_id text, lease_until timestamptz, attempt integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, completed_at timestamptz,
  UNIQUE(document_id,kind,input_hash,provider,model,prompt_version)
);
ALTER TABLE fp_ai_runs ADD COLUMN IF NOT EXISTS encrypted_input text;
CREATE TABLE IF NOT EXISTS fp_ai_attempts (
  run_id text NOT NULL REFERENCES fp_ai_runs(id), attempt integer NOT NULL, lease_id text NOT NULL,
  status text NOT NULL, diagnostic_code text, encrypted_result text, stats jsonb,
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  PRIMARY KEY(run_id,attempt)
);
CREATE TABLE IF NOT EXISTS fp_receipt_groups (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  reviewed_total_minor bigint CHECK(reviewed_total_minor>=0), currency text CHECK(currency='USD'),
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_receipt_group_documents (
  document_id text PRIMARY KEY REFERENCES fp_documents(id), group_id text NOT NULL REFERENCES fp_receipt_groups(id),
  association_reason text NOT NULL, linked_by text NOT NULL, linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_receipt_group_lines (
  group_id text NOT NULL REFERENCES fp_receipt_groups(id), line_key text NOT NULL,
  source_minor bigint NOT NULL CHECK(source_minor>=0), PRIMARY KEY(group_id,line_key)
);
CREATE TABLE IF NOT EXISTS fp_claims (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  actor_id text NOT NULL, document_id text NOT NULL REFERENCES fp_documents(id), group_id text NOT NULL REFERENCES fp_receipt_groups(id),
  intent_id text NOT NULL, state text NOT NULL DEFAULT 'draft', version integer NOT NULL DEFAULT 1,
  source_run_id text REFERENCES fp_ai_runs(id), currency text, requested_minor bigint NOT NULL DEFAULT 0,
  approved_minor bigint NOT NULL DEFAULT 0 CHECK(approved_minor>=0), encrypted_data text NOT NULL,
  reviewed_by text, reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,actor_id,intent_id)
);
CREATE TABLE IF NOT EXISTS fp_claim_revisions (
  claim_id text NOT NULL REFERENCES fp_claims(id), version integer NOT NULL, actor_id text NOT NULL,
  role text NOT NULL, state text NOT NULL, encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(claim_id,version)
);
CREATE TABLE IF NOT EXISTS fp_claim_line_reviews (
  claim_id text NOT NULL REFERENCES fp_claims(id), claim_line_id text NOT NULL, group_id text NOT NULL REFERENCES fp_receipt_groups(id),
  receipt_line_key text NOT NULL, package_id text, package_version integer, source_minor bigint NOT NULL CHECK(source_minor>=0),
  approved_minor bigint NOT NULL CHECK(approved_minor>=0), decision text NOT NULL, review_version integer NOT NULL,
  PRIMARY KEY(claim_id,claim_line_id), CHECK(approved_minor<=source_minor)
);
CREATE TABLE IF NOT EXISTS fp_receipt_comparison_decisions (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL,
  document_a text NOT NULL REFERENCES fp_documents(id), document_b text NOT NULL REFERENCES fp_documents(id),
  decision text NOT NULL, encrypted_data text NOT NULL, reviewed_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(document_a<document_b)
);
CREATE TABLE IF NOT EXISTS fp_balance_observations (
  id text PRIMARY KEY, merchant_scope text NOT NULL, account_hash text,
  as_of_time timestamptz, last_refresh_time timestamptz, observed_at timestamptz NOT NULL,
  available_minor bigint, body_hash text, code text, encrypted_data text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fp_balance_scope_time ON fp_balance_observations(merchant_scope,observed_at DESC);
CREATE TABLE IF NOT EXISTS fp_payable_reviews (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, actor_id text NOT NULL,
  claim_id text NOT NULL REFERENCES fp_claims(id), claim_version integer NOT NULL,
  digest text NOT NULL, encrypted_data text NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_payables (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, merchant_scope text NOT NULL,
  claim_id text NOT NULL REFERENCES fp_claims(id), claim_version integer NOT NULL, actor_id text NOT NULL,
  session_id text NOT NULL REFERENCES fp_sessions(id), membership_version integer NOT NULL, intent_id text NOT NULL,
  recipient_id text NOT NULL REFERENCES fp_recipient_accounts(id), recipient_version integer NOT NULL, recipient_label text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>0), fee_allowance_minor bigint NOT NULL CHECK(fee_allowance_minor>=0),
  actual_fee_minor bigint CHECK(actual_fee_minor>=0), fee_state text NOT NULL DEFAULT 'reserved',
  approval_id text NOT NULL REFERENCES fp_approval_records(id), request_hash text NOT NULL,
  encrypted_data text NOT NULL, state text NOT NULL DEFAULT 'reserved', provider_status text,
  batch_hash text UNIQUE, item_hash text UNIQUE, uncertain_create boolean NOT NULL DEFAULT false,
  balance_observation_id text REFERENCES fp_balance_observations(id), last_code text,
  lease_id text, lease_until timestamptz, attempt integer NOT NULL DEFAULT 0,
  first_dispatched_at timestamptz, observed_at timestamptz, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,actor_id,intent_id)
);
CREATE TABLE IF NOT EXISTS fp_payable_lines (
  payable_id text NOT NULL REFERENCES fp_payables(id), claim_id text NOT NULL REFERENCES fp_claims(id),
  claim_line_id text NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0), package_id text NOT NULL,
  PRIMARY KEY(payable_id,claim_line_id)
);
ALTER TABLE fp_payables ADD COLUMN IF NOT EXISTS principal_paid_at timestamptz;
ALTER TABLE fp_payables ADD COLUMN IF NOT EXISTS principal_returned_at timestamptz;
ALTER TABLE fp_payables ADD COLUMN IF NOT EXISTS checked_at timestamptz;
CREATE TABLE IF NOT EXISTS fp_payable_approval_intents (
  tenant_id text NOT NULL, project_id text NOT NULL, actor_id text NOT NULL, intent_id text NOT NULL,
  payable_id text NOT NULL REFERENCES fp_payables(id), review_id text NOT NULL REFERENCES fp_payable_reviews(id),
  input_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,actor_id,intent_id)
);
CREATE TABLE IF NOT EXISTS fp_merchant_journal (
  id text PRIMARY KEY, merchant_scope text NOT NULL, payable_id text NOT NULL REFERENCES fp_payables(id),
  account text NOT NULL, side text NOT NULL CHECK(side IN ('debit','credit')),
  amount_minor bigint NOT NULL CHECK(amount_minor>=0), currency text NOT NULL CHECK(currency='USD'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_payout_observations (
  id text PRIMARY KEY, payable_id text NOT NULL REFERENCES fp_payables(id), kind text NOT NULL,
  attempt integer, lease_id text, outcome text NOT NULL, code text, body_hash text NOT NULL,
  encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fp_payout_observation_history ON fp_payout_observations(payable_id,created_at);
ALTER TABLE fp_receipt_allocations ADD COLUMN IF NOT EXISTS payable_id text REFERENCES fp_payables(id);
ALTER TABLE fp_receipt_allocations ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'claim';
ALTER TABLE fp_receipt_allocations ADD COLUMN IF NOT EXISTS initial_amount_minor bigint;
UPDATE fp_receipt_allocations SET initial_amount_minor=amount_minor WHERE initial_amount_minor IS NULL;
CREATE TABLE IF NOT EXISTS fp_allocation_revisions (
  id text PRIMARY KEY, allocation_id text NOT NULL REFERENCES fp_receipt_allocations(id), revision integer NOT NULL,
  receipt_id text NOT NULL REFERENCES fp_settlement_receipts(id), payable_id text NOT NULL REFERENCES fp_payables(id),
  package_id text NOT NULL, purpose text NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>=0),
  state text NOT NULL, reason text NOT NULL, reversal_of text REFERENCES fp_allocation_revisions(id),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(allocation_id,revision)
);
CREATE TABLE IF NOT EXISTS fp_workspace_handoffs (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  session_id text NOT NULL REFERENCES fp_sessions(id), actor_id text NOT NULL, role text NOT NULL,
  membership_version integer NOT NULL, token_hash text NOT NULL UNIQUE,
  source_origin text NOT NULL, target_origin text NOT NULL,
  expires_at timestamptz NOT NULL, consumed_at timestamptz, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_workspace_imports (
  id text PRIMARY KEY, bundle_hash text NOT NULL, tenant_id text NOT NULL, project_id text NOT NULL,
  source_cutoff timestamptz NOT NULL, handoff_ids jsonb NOT NULL, manifest jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_transfer_webhook_archive (
  id text PRIMARY KEY, bundle_id text NOT NULL REFERENCES fp_workspace_imports(id),
  tenant_id text NOT NULL, project_id text NOT NULL, source_table text NOT NULL,
  source_key_hash text NOT NULL, source_body_hash text NOT NULL, encrypted_data text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(bundle_id,source_table,source_key_hash)
);
${STUDIO_SCHEMA}
${PLANNING_SCHEMA}
CREATE TABLE IF NOT EXISTS fp_schema_versions (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO fp_schema_versions(version) VALUES(1) ON CONFLICT DO NOTHING;
INSERT INTO fp_schema_versions(version) VALUES(2) ON CONFLICT DO NOTHING;
INSERT INTO fp_schema_versions(version) VALUES(3) ON CONFLICT DO NOTHING;
INSERT INTO fp_schema_versions(version) VALUES(4) ON CONFLICT DO NOTHING;
INSERT INTO fp_schema_versions(version) VALUES(5) ON CONFLICT DO NOTHING;
INSERT INTO fp_schema_versions(version) VALUES(6) ON CONFLICT DO NOTHING;
INSERT INTO fp_schema_versions(version) VALUES(7) ON CONFLICT DO NOTHING;
INSERT INTO fp_schema_versions(version) VALUES(8) ON CONFLICT DO NOTHING;
INSERT INTO fp_schema_versions(version) VALUES(9) ON CONFLICT DO NOTHING;
INSERT INTO fp_schema_versions(version) VALUES(10) ON CONFLICT DO NOTHING;
INSERT INTO fp_schema_versions(version) VALUES(11) ON CONFLICT DO NOTHING;
`;
