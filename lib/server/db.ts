import { PostgresDatabase, SqlPaymentStore, type SqlConnection } from "@fracture/paypal-core";
import { paymentOperationCodec } from "./private-values";

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
  if (!state.fieldproofReady) state.fieldproofReady = (async () => {
    await database().transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(410202611)");
      await tx.query(schema);
    });
    await new SqlPaymentStore(database(),{operationDocumentCodec:paymentOperationCodec}).initialize();
  })().catch(error => { state.fieldproofReady = undefined; throw error; });
  return state.fieldproofReady;
}

const schema = `
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
CREATE TABLE IF NOT EXISTS fp_schema_versions (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO fp_schema_versions(version) VALUES(1) ON CONFLICT DO NOTHING;
INSERT INTO fp_schema_versions(version) VALUES(2) ON CONFLICT DO NOTHING;
INSERT INTO fp_schema_versions(version) VALUES(3) ON CONFLICT DO NOTHING;
INSERT INTO fp_schema_versions(version) VALUES(4) ON CONFLICT DO NOTHING;
`;
