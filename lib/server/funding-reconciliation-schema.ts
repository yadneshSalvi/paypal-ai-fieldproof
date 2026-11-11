export const FUNDING_RECONCILIATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS fp_funding_reconciliations (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
 kind text NOT NULL CHECK(kind IN ('allocation_adjustment','return_attribution')),
 case_id text REFERENCES fp_funding_cases(id), receipt_id text REFERENCES fp_settlement_receipts(id),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), state text NOT NULL, digest text NOT NULL, encrypted_data text NOT NULL,
 created_by text NOT NULL, membership_version integer NOT NULL, expires_at timestamptz NOT NULL,
 result_case_id text REFERENCES fp_funding_cases(id), applied_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fp_funding_active_adjustment ON fp_funding_reconciliations(case_id)
 WHERE kind='allocation_adjustment' AND state='awaiting_donors';
CREATE TABLE IF NOT EXISTS fp_funding_reconciliation_consents (
 id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL,
 reconciliation_id text NOT NULL REFERENCES fp_funding_reconciliations(id), actor_id text NOT NULL,
 membership_version integer NOT NULL, version integer NOT NULL CHECK(version>0),
 decision text NOT NULL CHECK(decision IN ('accept','decline')), state text NOT NULL DEFAULT 'recorded',
 digest text NOT NULL, encrypted_data text NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(reconciliation_id,actor_id,version)
);
CREATE UNIQUE INDEX IF NOT EXISTS fp_funding_current_adjustment_consent ON fp_funding_reconciliation_consents(reconciliation_id,actor_id) WHERE state='recorded';
CREATE TABLE IF NOT EXISTS fp_funding_return_observations (
 id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL,
 receipt_id text NOT NULL REFERENCES fp_settlement_receipts(id), receipt_version integer NOT NULL,
 digest text NOT NULL, encrypted_data text NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fp_funding_return_observation_scope ON fp_funding_return_observations(tenant_id,project_id,receipt_id,created_at DESC);
CREATE TABLE IF NOT EXISTS fp_funding_return_holds (
 id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, receipt_id text NOT NULL REFERENCES fp_settlement_receipts(id),
 digest text NOT NULL, encrypted_data text NOT NULL, state text NOT NULL DEFAULT 'held',
 released_by text REFERENCES fp_funding_reconciliations(id), released_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fp_funding_active_return_hold ON fp_funding_return_holds(receipt_id) WHERE state='held';
CREATE TABLE IF NOT EXISTS fp_funding_external_returns (
 id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, receipt_id text NOT NULL REFERENCES fp_settlement_receipts(id),
 reconciliation_id text NOT NULL REFERENCES fp_funding_reconciliations(id), provider_refund_hash text NOT NULL UNIQUE,
 amount_minor bigint NOT NULL CHECK(amount_minor>0), digest text NOT NULL, encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_sample_funding_use_evidence (
 allocation_id text PRIMARY KEY REFERENCES fp_receipt_allocations(id), tenant_id text NOT NULL, project_id text NOT NULL,
 document_digest text NOT NULL, encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS fp_funding_reconciliation_contract ON fp_funding_reconciliations;
CREATE TRIGGER fp_funding_reconciliation_contract BEFORE UPDATE OR DELETE ON fp_funding_reconciliations FOR EACH ROW EXECUTE FUNCTION fp_funding_contract_immutable();
DROP TRIGGER IF EXISTS fp_funding_reconciliation_consent_contract ON fp_funding_reconciliation_consents;
CREATE TRIGGER fp_funding_reconciliation_consent_contract BEFORE UPDATE OR DELETE ON fp_funding_reconciliation_consents FOR EACH ROW EXECUTE FUNCTION fp_funding_contract_immutable();
DROP TRIGGER IF EXISTS fp_funding_return_hold_contract ON fp_funding_return_holds;
CREATE TRIGGER fp_funding_return_hold_contract BEFORE UPDATE OR DELETE ON fp_funding_return_holds FOR EACH ROW EXECUTE FUNCTION fp_funding_contract_immutable();
DROP TRIGGER IF EXISTS fp_funding_return_observation_immutable ON fp_funding_return_observations;
CREATE TRIGGER fp_funding_return_observation_immutable BEFORE UPDATE OR DELETE ON fp_funding_return_observations FOR EACH ROW EXECUTE FUNCTION fp_funding_immutable();
DROP TRIGGER IF EXISTS fp_funding_external_return_immutable ON fp_funding_external_returns;
CREATE TRIGGER fp_funding_external_return_immutable BEFORE UPDATE OR DELETE ON fp_funding_external_returns FOR EACH ROW EXECUTE FUNCTION fp_funding_immutable();
DROP TRIGGER IF EXISTS fp_sample_funding_use_immutable ON fp_sample_funding_use_evidence;
CREATE TRIGGER fp_sample_funding_use_immutable BEFORE UPDATE OR DELETE ON fp_sample_funding_use_evidence FOR EACH ROW EXECUTE FUNCTION fp_funding_immutable();
`;
