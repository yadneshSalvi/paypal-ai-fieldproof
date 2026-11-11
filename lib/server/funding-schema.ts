/** Restricted credit is an append-only journal, separate from economic receipts
 * and expense allocations. No transfer executor is enabled by this schema. */
export const FUNDING_SCHEMA = `
CREATE TABLE IF NOT EXISTS fp_funding_assignments (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES fp_tenants(id),
  project_id text NOT NULL REFERENCES fp_projects(id),
  receipt_id text NOT NULL REFERENCES fp_settlement_receipts(id),
  sequence integer NOT NULL CHECK(sequence>0),
  kind text NOT NULL CHECK(kind IN ('reallocation','rollover','reversal')),
  amount_minor bigint NOT NULL CHECK(amount_minor>0 AND amount_minor<=9007199254740991),
  debit_package_id text NOT NULL, credit_package_id text NOT NULL,
  consent_id text NOT NULL, consent_digest text NOT NULL CHECK(consent_digest ~ '^[a-f0-9]{64}$'),
  document_digest text NOT NULL CHECK(document_digest ~ '^[a-f0-9]{64}$'),
  encrypted_data text NOT NULL,
  committed_at timestamptz NOT NULL,
  UNIQUE(receipt_id,sequence),
  CHECK(debit_package_id<>credit_package_id),
  FOREIGN KEY(project_id,debit_package_id) REFERENCES fp_packages(project_id,id),
  FOREIGN KEY(project_id,credit_package_id) REFERENCES fp_packages(project_id,id)
);
CREATE INDEX IF NOT EXISTS fp_funding_assignment_scope ON fp_funding_assignments(tenant_id,project_id,receipt_id,sequence);
CREATE TABLE IF NOT EXISTS fp_funding_deductions (
  receipt_id text NOT NULL REFERENCES fp_settlement_receipts(id),
  receipt_version integer NOT NULL CHECK(receipt_version>0),
  tenant_id text NOT NULL REFERENCES fp_tenants(id),
  project_id text NOT NULL REFERENCES fp_projects(id),
  document_digest text NOT NULL CHECK(document_digest ~ '^[a-f0-9]{64}$'),
  encrypted_data text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(receipt_id,receipt_version)
);
CREATE INDEX IF NOT EXISTS fp_funding_deduction_scope ON fp_funding_deductions(tenant_id,project_id,receipt_id,receipt_version);
CREATE OR REPLACE FUNCTION fp_funding_source_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fp_settlement_receipts r JOIN fp_projects p ON p.id=r.project_id AND p.tenant_id=r.tenant_id
    WHERE r.id=NEW.receipt_id AND r.tenant_id=NEW.tenant_id AND r.project_id=NEW.project_id) THEN
    RAISE EXCEPTION 'Restricted funding source is outside this workspace' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS fp_funding_assignment_source_scope ON fp_funding_assignments;
CREATE TRIGGER fp_funding_assignment_source_scope BEFORE INSERT ON fp_funding_assignments
  FOR EACH ROW EXECUTE FUNCTION fp_funding_source_scope();
DROP TRIGGER IF EXISTS fp_funding_deduction_source_scope ON fp_funding_deductions;
CREATE TRIGGER fp_funding_deduction_source_scope BEFORE INSERT ON fp_funding_deductions
  FOR EACH ROW EXECUTE FUNCTION fp_funding_source_scope();
CREATE OR REPLACE FUNCTION fp_funding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Restricted funding history is append-only' USING ERRCODE='23514';
END;
$$;
DROP TRIGGER IF EXISTS fp_funding_assignment_immutable ON fp_funding_assignments;
CREATE TRIGGER fp_funding_assignment_immutable BEFORE UPDATE OR DELETE ON fp_funding_assignments
  FOR EACH ROW EXECUTE FUNCTION fp_funding_immutable();
DROP TRIGGER IF EXISTS fp_funding_deduction_immutable ON fp_funding_deductions;
CREATE TRIGGER fp_funding_deduction_immutable BEFORE UPDATE OR DELETE ON fp_funding_deductions
  FOR EACH ROW EXECUTE FUNCTION fp_funding_immutable();
CREATE OR REPLACE FUNCTION fp_receipt_advance_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.data IS DISTINCT FROM OLD.data THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS fp_receipt_version_on_change ON fp_settlement_receipts;
CREATE TRIGGER fp_receipt_version_on_change BEFORE UPDATE OF data,version ON fp_settlement_receipts
  FOR EACH ROW EXECUTE FUNCTION fp_receipt_advance_version();
`;
