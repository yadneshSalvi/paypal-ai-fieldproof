import { PostgresDatabase, SqlPaymentStore, type SqlConnection } from "@fracture/paypal-core";

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
    await new SqlPaymentStore(database()).initialize();
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
CREATE TABLE IF NOT EXISTS fp_collection_rounds (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, package_id text NOT NULL,
  package_version integer NOT NULL, target_minor bigint NOT NULL,
  collection_started_at timestamptz NOT NULL, recovery_ends_at timestamptz NOT NULL,
  policy_hash text NOT NULL, state text NOT NULL, data jsonb NOT NULL,
  CHECK(recovery_ends_at = collection_started_at + interval '48 hours')
);
CREATE UNIQUE INDEX IF NOT EXISTS fp_active_round ON fp_collection_rounds(project_id,package_id)
  WHERE state IN ('collecting','recovering');
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
CREATE TABLE IF NOT EXISTS fp_schema_versions (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO fp_schema_versions(version) VALUES(1) ON CONFLICT DO NOTHING;
`;
