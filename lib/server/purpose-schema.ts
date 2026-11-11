export const PURPOSE_SCHEMA = `
CREATE TABLE IF NOT EXISTS fp_sample_funding_origins (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
 obligation_id text NOT NULL UNIQUE REFERENCES fp_obligations(id), package_id text NOT NULL, package_version integer NOT NULL,
 digest text NOT NULL, encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,package_id) REFERENCES fp_packages(project_id,id)
);
DROP TRIGGER IF EXISTS fp_sample_funding_origin_immutable ON fp_sample_funding_origins;
CREATE TRIGGER fp_sample_funding_origin_immutable BEFORE UPDATE OR DELETE ON fp_sample_funding_origins FOR EACH ROW EXECUTE FUNCTION fp_funding_immutable();
CREATE TABLE IF NOT EXISTS fp_sponsor_offers (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
 version integer NOT NULL DEFAULT 1, kind text NOT NULL CHECK(kind IN ('grant','match')), state text NOT NULL DEFAULT 'offered',
 created_by text NOT NULL, membership_version integer NOT NULL, total_cap_minor bigint NOT NULL CHECK(total_cap_minor>0),
 expires_at timestamptz NOT NULL, digest text NOT NULL, encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_sponsor_acceptances (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
 offer_id text NOT NULL UNIQUE REFERENCES fp_sponsor_offers(id), version integer NOT NULL DEFAULT 1,
 sponsor_actor_id text NOT NULL, membership_version integer NOT NULL, state text NOT NULL DEFAULT 'accepted',
 expires_at timestamptz NOT NULL, digest text NOT NULL, encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_purpose_pledges (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
 policy_id text NOT NULL REFERENCES fp_funding_policies(id), round_id text NOT NULL REFERENCES fp_collection_rounds(id),
 obligation_id text NOT NULL UNIQUE REFERENCES fp_obligations(id), package_id text NOT NULL, package_version integer NOT NULL,
 donor_actor_id text NOT NULL, membership_version integer NOT NULL, version integer NOT NULL DEFAULT 1,
 kind text NOT NULL CHECK(kind IN ('donor','grant','match')), sponsor_acceptance_id text REFERENCES fp_sponsor_acceptances(id),
 sponsor_event_id text UNIQUE, amount_minor bigint NOT NULL CHECK(amount_minor>0),
 state text NOT NULL DEFAULT 'pledged', operation_id text, last_code text, collected_minor bigint NOT NULL DEFAULT 0,
 expires_at timestamptz NOT NULL, digest text NOT NULL, encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,package_id) REFERENCES fp_packages(project_id,id)
);
CREATE INDEX IF NOT EXISTS fp_purpose_pledge_owner ON fp_purpose_pledges(tenant_id,project_id,donor_actor_id,created_at);
CREATE INDEX IF NOT EXISTS fp_purpose_pledge_policy ON fp_purpose_pledges(policy_id,state);
CREATE TABLE IF NOT EXISTS fp_sponsor_events (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
 offer_id text NOT NULL REFERENCES fp_sponsor_offers(id), acceptance_id text NOT NULL REFERENCES fp_sponsor_acceptances(id),
 receipt_id text NOT NULL REFERENCES fp_settlement_receipts(id), policy_id text NOT NULL REFERENCES fp_funding_policies(id),
 pledge_id text UNIQUE REFERENCES fp_purpose_pledges(id), package_id text NOT NULL,
 eligible_minor bigint NOT NULL CHECK(eligible_minor>0), match_minor bigint NOT NULL CHECK(match_minor>=0),
 digest text NOT NULL, encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(offer_id,receipt_id)
);
DROP TRIGGER IF EXISTS fp_sponsor_offer_contract ON fp_sponsor_offers;
CREATE TRIGGER fp_sponsor_offer_contract BEFORE UPDATE OR DELETE ON fp_sponsor_offers FOR EACH ROW EXECUTE FUNCTION fp_funding_contract_immutable();
DROP TRIGGER IF EXISTS fp_sponsor_acceptance_contract ON fp_sponsor_acceptances;
CREATE TRIGGER fp_sponsor_acceptance_contract BEFORE UPDATE OR DELETE ON fp_sponsor_acceptances FOR EACH ROW EXECUTE FUNCTION fp_funding_contract_immutable();
DROP TRIGGER IF EXISTS fp_purpose_pledge_contract ON fp_purpose_pledges;
CREATE TRIGGER fp_purpose_pledge_contract BEFORE UPDATE OR DELETE ON fp_purpose_pledges FOR EACH ROW EXECUTE FUNCTION fp_funding_contract_immutable();
DROP TRIGGER IF EXISTS fp_sponsor_event_immutable ON fp_sponsor_events;
CREATE TRIGGER fp_sponsor_event_immutable BEFORE UPDATE OR DELETE ON fp_sponsor_events FOR EACH ROW EXECUTE FUNCTION fp_funding_immutable();
`;
