export const FUNDING_LIFECYCLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS fp_funding_policies (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
 package_id text NOT NULL, package_version integer NOT NULL CHECK(package_version>0), round_id text NOT NULL UNIQUE REFERENCES fp_collection_rounds(id),
 kind text NOT NULL CHECK(kind IN ('reallocation','rollover','mixed')), state text NOT NULL DEFAULT 'open',
 digest text NOT NULL, encrypted_data text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,package_id) REFERENCES fp_packages(project_id,id), UNIQUE(project_id,package_id,package_version)
);
CREATE TABLE IF NOT EXISTS fp_funding_cases (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
 package_id text NOT NULL, package_version integer NOT NULL CHECK(package_version>0), version integer NOT NULL DEFAULT 1,
 revision integer NOT NULL DEFAULT 1, supersedes_id text REFERENCES fp_funding_cases(id),
 state text NOT NULL, digest text NOT NULL, encrypted_data text NOT NULL, deadline timestamptz NOT NULL,
 created_by text NOT NULL, membership_version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,package_id,package_version,revision), FOREIGN KEY(project_id,package_id) REFERENCES fp_packages(project_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS fp_funding_active_case ON fp_funding_cases(project_id,package_id,package_version) WHERE state<>'superseded';
CREATE TABLE IF NOT EXISTS fp_funding_choices (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
 case_id text NOT NULL REFERENCES fp_funding_cases(id), receipt_id text NOT NULL REFERENCES fp_settlement_receipts(id),
 donor_actor_id text NOT NULL, accepted_by text NOT NULL, membership_version integer NOT NULL,
 version integer NOT NULL CHECK(version>0), kind text NOT NULL CHECK(kind IN ('return','reallocation','rollover')),
 authority text NOT NULL CHECK(authority IN ('donor','case_default')), amount_minor bigint NOT NULL CHECK(amount_minor>0),
 state text NOT NULL DEFAULT 'accepted', digest text NOT NULL, encrypted_data text NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, executed_id text, last_code text,
 created_at timestamptz NOT NULL DEFAULT now(), executed_at timestamptz,
 UNIQUE(case_id,receipt_id,version)
);
CREATE UNIQUE INDEX IF NOT EXISTS fp_funding_current_choice ON fp_funding_choices(case_id,receipt_id)
 WHERE state IN ('accepted','executing','return_pending','executed','returned');
CREATE TABLE IF NOT EXISTS fp_funding_actions (
 tenant_id text NOT NULL, project_id text NOT NULL, actor_id text NOT NULL, intent_id text NOT NULL,
 kind text NOT NULL, input_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,actor_id,intent_id)
);
CREATE TABLE IF NOT EXISTS fp_funding_case_events (
 id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, case_id text NOT NULL REFERENCES fp_funding_cases(id),
 actor_id text NOT NULL, kind text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fp_funding_case_scope ON fp_funding_cases(tenant_id,project_id,created_at);
CREATE INDEX IF NOT EXISTS fp_funding_choice_owner ON fp_funding_choices(tenant_id,project_id,donor_actor_id,case_id);
ALTER TABLE fp_refunds ADD COLUMN IF NOT EXISTS funding_package_id text;
ALTER TABLE fp_refunds ADD COLUMN IF NOT EXISTS funding_choice_id text REFERENCES fp_funding_choices(id);
ALTER TABLE fp_refunds ADD COLUMN IF NOT EXISTS funding_source_digest text;
CREATE OR REPLACE FUNCTION fp_funding_contract_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Funding contracts are retained' USING ERRCODE='23514'; END IF;
 IF NEW.encrypted_data IS DISTINCT FROM OLD.encrypted_data OR NEW.digest IS DISTINCT FROM OLD.digest OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.id IS DISTINCT FROM OLD.id THEN
   RAISE EXCEPTION 'Funding contract identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS fp_funding_case_contract ON fp_funding_cases;
CREATE TRIGGER fp_funding_case_contract BEFORE UPDATE OR DELETE ON fp_funding_cases FOR EACH ROW EXECUTE FUNCTION fp_funding_contract_immutable();
DROP TRIGGER IF EXISTS fp_funding_choice_contract ON fp_funding_choices;
CREATE TRIGGER fp_funding_choice_contract BEFORE UPDATE OR DELETE ON fp_funding_choices FOR EACH ROW EXECUTE FUNCTION fp_funding_contract_immutable();
DROP TRIGGER IF EXISTS fp_funding_policy_contract ON fp_funding_policies;
CREATE TRIGGER fp_funding_policy_contract BEFORE UPDATE OR DELETE ON fp_funding_policies FOR EACH ROW EXECUTE FUNCTION fp_funding_contract_immutable();
DROP TRIGGER IF EXISTS fp_funding_case_event_immutable ON fp_funding_case_events;
CREATE TRIGGER fp_funding_case_event_immutable BEFORE UPDATE OR DELETE ON fp_funding_case_events FOR EACH ROW EXECUTE FUNCTION fp_funding_immutable();
`;
