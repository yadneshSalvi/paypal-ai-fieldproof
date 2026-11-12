/** Additive schema. No existing project, credential, payment or deadline is converted. */
export const ORGANIZATION_TABLES = [
  "fp_organizations", "fp_org_memberships", "fp_org_sessions", "fp_org_invitations", "fp_org_access",
  "fp_org_libraries", "fp_org_library_entries", "fp_org_commands", "fp_org_audit", "fp_org_project_links",
  "fp_org_project_consents", "fp_org_policies", "fp_org_policy_versions", "fp_project_governance_heads",
  "fp_project_policy_adoptions", "fp_project_policy_artifacts", "fp_project_package_revisions", "fp_project_policy_subjects",
  "fp_org_portfolios", "fp_org_portfolio_audit",
] as const;

export const ORGANIZATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS fp_organizations (
  id text PRIMARY KEY, version integer NOT NULL DEFAULT 1 CHECK(version>0),
  name text NOT NULL, description text NOT NULL, identity_provenance text NOT NULL CHECK(identity_provenance='self_declared'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_org_memberships (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES fp_organizations(id),
  role text NOT NULL CHECK(role IN ('owner','coordinator','auditor')), version integer NOT NULL DEFAULT 1 CHECK(version>0),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
  authentication_origin text NOT NULL CHECK(authentication_origin IN ('creation_capability','invitation_possession')),
  encrypted_identity text NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,id),
  CHECK(expires_at>created_at), CHECK((state='revoked')=(revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS fp_org_member_history ON fp_org_memberships(organization_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS fp_org_sessions (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES fp_organizations(id), membership_id text NOT NULL,
  token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,id,membership_id),
  FOREIGN KEY(organization_id,membership_id) REFERENCES fp_org_memberships(organization_id,id), CHECK(expires_at>created_at)
);
CREATE TABLE IF NOT EXISTS fp_org_invitations (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES fp_organizations(id),
  issuer_membership_id text NOT NULL, issuer_membership_version integer NOT NULL CHECK(issuer_membership_version>0),
  issuer_session_id text NOT NULL, issuer_session_expires_at timestamptz NOT NULL, issuer_browser_hash text NOT NULL,
  role text NOT NULL CHECK(role IN ('owner','coordinator','auditor')), token_hash text NOT NULL UNIQUE,
  encrypted_token text, encrypted_label text NOT NULL,
  state text NOT NULL DEFAULT 'invited' CHECK(state IN ('invited','joined','revoked')), version integer NOT NULL DEFAULT 1 CHECK(version>0),
  expires_at timestamptz NOT NULL, joined_at timestamptz, revoked_at timestamptz, revoked_by text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,id),
  FOREIGN KEY(organization_id,issuer_session_id,issuer_membership_id) REFERENCES fp_org_sessions(organization_id,id,membership_id),
  CHECK(expires_at>created_at AND expires_at<=issuer_session_expires_at),
  CHECK((state='invited' AND joined_at IS NULL AND encrypted_token IS NOT NULL) OR state<>'invited'),
  CHECK((state='revoked')=(revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS fp_org_invitation_history ON fp_org_invitations(organization_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS fp_org_access (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES fp_organizations(id), membership_id text NOT NULL,
  session_id text NOT NULL UNIQUE, invitation_id text UNIQUE,
  authentication_origin text NOT NULL CHECK(authentication_origin IN ('creation_capability','invitation_possession')),
  original_browser_hash text NOT NULL, acceptance_intent_id text NOT NULL, input_hash text NOT NULL,
  return_token_hash text NOT NULL UNIQUE, encrypted_data text NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,session_id,membership_id) REFERENCES fp_org_sessions(organization_id,id,membership_id),
  FOREIGN KEY(organization_id,invitation_id) REFERENCES fp_org_invitations(organization_id,id),
  CHECK((authentication_origin='invitation_possession')=(invitation_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS fp_org_libraries (
  id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), CHECK(expires_at>created_at)
);
CREATE TABLE IF NOT EXISTS fp_org_library_entries (
  id text PRIMARY KEY, library_id text NOT NULL REFERENCES fp_org_libraries(id), organization_id text NOT NULL,
  session_id text NOT NULL, membership_id text NOT NULL, encrypted_data text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(library_id,session_id),
  FOREIGN KEY(organization_id,session_id,membership_id) REFERENCES fp_org_sessions(organization_id,id,membership_id)
);
CREATE TABLE IF NOT EXISTS fp_org_commands (
  id text NOT NULL UNIQUE, actor_key text NOT NULL, intent_id text NOT NULL, kind text NOT NULL, input_hash text NOT NULL,
  organization_id text REFERENCES fp_organizations(id), session_id text REFERENCES fp_org_sessions(id), membership_id text REFERENCES fp_org_memberships(id),
  membership_version integer, browser_hash text, result jsonb NOT NULL, encrypted_recovery text,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_key,intent_id)
);
CREATE TABLE IF NOT EXISTS fp_org_audit (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES fp_organizations(id), kind text NOT NULL,
  authority_origin text NOT NULL CHECK(authority_origin IN ('organization_session','project_session','creation_capability','invitation_possession')),
  session_id text, membership_id text, membership_version integer, role text,
  encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fp_org_audit_history ON fp_org_audit(organization_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS fp_org_project_links (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES fp_organizations(id),
  tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>0), state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','withdrawn')),
  current_consent_id text NOT NULL, withdrawn_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,project_id), UNIQUE(id,organization_id,tenant_id,project_id), CHECK((state='withdrawn')=(withdrawn_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS fp_org_project_consents (
  id text PRIMARY KEY, link_id text NOT NULL, organization_id text NOT NULL,
  tenant_id text NOT NULL, project_id text NOT NULL, revision integer NOT NULL CHECK(revision>0),
  disclosure jsonb NOT NULL, content_hash text NOT NULL,
  org_membership_id text NOT NULL, org_membership_version integer NOT NULL CHECK(org_membership_version>0),
  org_session_id text NOT NULL, org_session_expires_at timestamptz NOT NULL,
  project_actor_id text NOT NULL, project_membership_version integer NOT NULL CHECK(project_membership_version>0),
  project_session_id text NOT NULL REFERENCES fp_sessions(id), project_session_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL, encrypted_data text NOT NULL, approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(link_id,revision), UNIQUE(link_id,id),
  FOREIGN KEY(link_id,organization_id,tenant_id,project_id) REFERENCES fp_org_project_links(id,organization_id,tenant_id,project_id),
  FOREIGN KEY(organization_id,org_session_id,org_membership_id) REFERENCES fp_org_sessions(organization_id,id,membership_id),
  CHECK(expires_at>approved_at AND expires_at<=org_session_expires_at AND expires_at<=project_session_expires_at)
);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fp_org_link_current_consent' AND conrelid='fp_org_project_links'::regclass) THEN
    ALTER TABLE fp_org_project_links ADD CONSTRAINT fp_org_link_current_consent FOREIGN KEY(id,current_consent_id) REFERENCES fp_org_project_consents(link_id,id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS fp_org_policies (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES fp_organizations(id), head_version integer NOT NULL DEFAULT 1 CHECK(head_version>0),
  kind text NOT NULL CHECK(kind IN ('package_library','fund_restriction','evidence_policy')), title text NOT NULL,
  template_ids jsonb NOT NULL, draft_hash text NOT NULL, encrypted_draft text NOT NULL,
  latest_revision integer NOT NULL DEFAULT 0 CHECK(latest_revision>=0), latest_version_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,id)
);
CREATE TABLE IF NOT EXISTS fp_org_policy_versions (
  id text PRIMARY KEY, policy_id text NOT NULL, organization_id text NOT NULL, revision integer NOT NULL CHECK(revision>0),
  content_hash text NOT NULL, encrypted_definition text NOT NULL,
  publisher_membership_id text NOT NULL, publisher_membership_version integer NOT NULL CHECK(publisher_membership_version>0),
  publisher_session_id text NOT NULL, publisher_role text NOT NULL CHECK(publisher_role IN ('owner','coordinator')),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','retired')), state_version integer NOT NULL DEFAULT 1 CHECK(state_version>0),
  published_at timestamptz NOT NULL DEFAULT now(), retired_at timestamptz,
  FOREIGN KEY(organization_id,policy_id) REFERENCES fp_org_policies(organization_id,id),
  FOREIGN KEY(organization_id,publisher_session_id,publisher_membership_id) REFERENCES fp_org_sessions(organization_id,id,membership_id),
  UNIQUE(policy_id,revision), UNIQUE(policy_id,id), UNIQUE(organization_id,policy_id,id), CHECK((state='retired')=(retired_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS fp_project_governance_heads (
  tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  version integer NOT NULL DEFAULT 0 CHECK(version>=0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,project_id)
);
CREATE TABLE IF NOT EXISTS fp_project_policy_adoptions (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  link_id text NOT NULL, source_organization_id text NOT NULL, source_policy_id text REFERENCES fp_org_policies(id),
  source_policy_version_id text REFERENCES fp_org_policy_versions(id), parent_adoption_id text REFERENCES fp_project_policy_adoptions(id),
  origin text NOT NULL CHECK(origin IN ('organization_adoption','project_revision')),
  kind text NOT NULL CHECK(kind IN ('package_library','fund_restriction','evidence_policy')), title text NOT NULL,
  rule_hash text NOT NULL, encrypted_rule text NOT NULL, mappings jsonb NOT NULL,
  adoption_head integer NOT NULL CHECK(adoption_head>0), version integer NOT NULL DEFAULT 1 CHECK(version>0),
  state text NOT NULL CHECK(state IN ('draft','materialized','applied','superseded','deactivated')),
  project_actor_id text NOT NULL, project_membership_version integer NOT NULL CHECK(project_membership_version>0),
  project_session_id text NOT NULL REFERENCES fp_sessions(id), org_membership_id text, org_membership_version integer, org_session_id text,
  materialized_plan_id text, materialized_plan_revision integer, canonical_revision_id text,
  superseded_by text REFERENCES fp_project_policy_adoptions(id) DEFERRABLE INITIALLY DEFERRED, deactivated_at timestamptz,
  adopted_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(link_id,source_organization_id,tenant_id,project_id) REFERENCES fp_org_project_links(id,organization_id,tenant_id,project_id),
  FOREIGN KEY(source_organization_id,source_policy_id,source_policy_version_id) REFERENCES fp_org_policy_versions(organization_id,policy_id,id),
  FOREIGN KEY(source_organization_id,org_session_id,org_membership_id) REFERENCES fp_org_sessions(organization_id,id,membership_id),
  UNIQUE(tenant_id,project_id,id), CHECK((origin='organization_adoption')=(source_policy_id IS NOT NULL AND source_policy_version_id IS NOT NULL)),
  CHECK((state='superseded')=(superseded_by IS NOT NULL)), CHECK((state='deactivated')=(deactivated_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS fp_project_policy_current ON fp_project_policy_adoptions(tenant_id,project_id,adopted_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS fp_project_policy_artifacts (
  id text PRIMARY KEY, adoption_id text NOT NULL, tenant_id text NOT NULL, project_id text NOT NULL,
  consumer text NOT NULL, artifact_id text NOT NULL, artifact_hash text NOT NULL,
  state text NOT NULL CHECK(state IN ('enforced','materialized','pending','not_applicable')), adoption_head integer NOT NULL CHECK(adoption_head>0),
  encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,project_id,adoption_id) REFERENCES fp_project_policy_adoptions(tenant_id,project_id,id),
  UNIQUE(adoption_id,consumer,artifact_id,artifact_hash)
);
CREATE TABLE IF NOT EXISTS fp_project_package_revisions (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  adoption_id text NOT NULL REFERENCES fp_project_policy_adoptions(id) DEFERRABLE INITIALLY DEFERRED,
  version integer NOT NULL CHECK(version>0), content_hash text NOT NULL, encrypted_data text NOT NULL,
  actor_id text NOT NULL, membership_version integer NOT NULL CHECK(membership_version>0), session_id text NOT NULL REFERENCES fp_sessions(id),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,version),
  FOREIGN KEY(tenant_id,project_id,adoption_id) REFERENCES fp_project_policy_adoptions(tenant_id,project_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS fp_project_policy_subjects (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  consumer text NOT NULL CHECK(consumer='payable_approval'), artifact_id text NOT NULL, artifact_hash text NOT NULL,
  bindings_hash text NOT NULL, encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,project_id,consumer,artifact_id)
);
CREATE TABLE IF NOT EXISTS fp_org_portfolios (
  id text PRIMARY KEY, organization_id text NOT NULL, membership_id text NOT NULL,
  role text NOT NULL CHECK(role IN ('owner','coordinator','auditor')), membership_version integer NOT NULL CHECK(membership_version>0),
  scope_hash text NOT NULL, intent_id text NOT NULL, input_hash text NOT NULL, content_hash text NOT NULL, basis_hash text NOT NULL,
  semantic_version text NOT NULL, as_of timestamptz NOT NULL, encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,membership_id) REFERENCES fp_org_memberships(organization_id,id), UNIQUE(organization_id,membership_id,role,intent_id),
  UNIQUE(id,organization_id,membership_id,membership_version,role,content_hash)
);
CREATE INDEX IF NOT EXISTS fp_org_portfolio_history ON fp_org_portfolios(organization_id,membership_id,role,as_of DESC,id DESC);
CREATE TABLE IF NOT EXISTS fp_org_portfolio_audit (
  id text PRIMARY KEY, report_id text NOT NULL REFERENCES fp_org_portfolios(id), organization_id text NOT NULL,
  membership_id text NOT NULL, membership_version integer NOT NULL CHECK(membership_version>0), role text NOT NULL,
  content_hash text NOT NULL, event text NOT NULL CHECK(event='captured'), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,membership_id) REFERENCES fp_org_memberships(organization_id,id),
  FOREIGN KEY(report_id,organization_id,membership_id,membership_version,role,content_hash) REFERENCES fp_org_portfolios(id,organization_id,membership_id,membership_version,role,content_hash)
);

CREATE OR REPLACE FUNCTION fp_org_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Organization history is retained' USING ERRCODE='23514'; END $$;

CREATE OR REPLACE FUNCTION fp_org_versioned() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous jsonb; proposed jsonb; version_key text:=TG_ARGV[0]; allowed text[]:=TG_ARGV;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Organization history cannot be deleted' USING ERRCODE='23514'; END IF;
  previous:=to_jsonb(OLD); proposed:=to_jsonb(NEW);
  IF (previous-allowed) IS DISTINCT FROM (proposed-allowed) OR (proposed->>version_key)::integer<>(previous->>version_key)::integer+1 THEN
    RAISE EXCEPTION 'Only a versioned organization transition is allowed' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='fp_org_invitations' AND (
    previous->>'state'='revoked' OR (previous->>'state'='joined' AND proposed->>'state'<>'revoked') OR
    (previous->>'state'='invited' AND proposed->>'state' NOT IN ('joined','revoked')) OR proposed->>'encrypted_token' IS NOT NULL
  ) THEN RAISE EXCEPTION 'An invitation is consumed once' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='fp_org_policy_versions' AND (previous->>'state'<>'active' OR proposed->>'state'<>'retired') THEN
    RAISE EXCEPTION 'A policy version only retires' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='fp_project_policy_adoptions' AND (previous->>'state' IN ('superseded','deactivated') OR proposed->>'state' NOT IN ('superseded','deactivated')) THEN
    RAISE EXCEPTION 'A copied project rule only supersedes or deactivates' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='fp_org_project_links' AND proposed->>'state'='active' AND previous->>'current_consent_id'=proposed->>'current_consent_id' THEN
    RAISE EXCEPTION 'Active disclosure requires a new consent revision' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fp_org_membership_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Original memberships are retained' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(OLD)-ARRAY['role','version','state','revoked_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['role','version','state','revoked_at'])
    OR NEW.version<>OLD.version+1 OR OLD.state='revoked' OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'Original membership identity and deadline are fixed' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM fp_organizations WHERE id=OLD.organization_id FOR UPDATE;
  IF OLD.role='owner' AND OLD.state='active' AND OLD.expires_at>clock_timestamp() AND (NEW.role<>'owner' OR NEW.state<>'active')
    AND NOT EXISTS(SELECT 1 FROM fp_org_memberships WHERE organization_id=OLD.organization_id AND id<>OLD.id AND role='owner' AND state='active' AND expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'Retain a current organization owner' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fp_org_session_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Original sessions are retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM fp_org_memberships m WHERE m.organization_id=NEW.organization_id AND m.id=NEW.membership_id AND m.state='active' AND m.expires_at>=NEW.expires_at AND NEW.expires_at>clock_timestamp()) THEN
      RAISE EXCEPTION 'Session must use the original current membership deadline' USING ERRCODE='23514'; END IF;
  ELSIF (to_jsonb(OLD)-'revoked_at') IS DISTINCT FROM (to_jsonb(NEW)-'revoked_at') OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'Original session identity and deadline are fixed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fp_org_project_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM fp_projects WHERE id=NEW.project_id AND tenant_id=NEW.tenant_id) THEN
    RAISE EXCEPTION 'Organization disclosure is bound to its exact project tenant' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='fp_project_policy_adoptions' THEN
    IF NOT EXISTS(SELECT 1 FROM fp_sessions WHERE id=NEW.project_session_id AND tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND actor_id=NEW.project_actor_id) THEN
      RAISE EXCEPTION 'Copied rule must retain its exact project session identity' USING ERRCODE='23514'; END IF;
    IF NEW.origin='project_revision' AND NOT EXISTS(SELECT 1 FROM fp_project_policy_adoptions WHERE id=NEW.parent_adoption_id AND tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND link_id=NEW.link_id) THEN
      RAISE EXCEPTION 'Project revision must retain its same-project original rule lineage' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS fp_org_organization_versioned ON fp_organizations;
CREATE TRIGGER fp_org_organization_versioned BEFORE UPDATE OR DELETE ON fp_organizations FOR EACH ROW EXECUTE FUNCTION fp_org_versioned('version','name','description','updated_at');
DROP TRIGGER IF EXISTS fp_org_membership_retained ON fp_org_memberships;
CREATE TRIGGER fp_org_membership_retained BEFORE UPDATE OR DELETE ON fp_org_memberships FOR EACH ROW EXECUTE FUNCTION fp_org_membership_contract();
DROP TRIGGER IF EXISTS fp_org_session_retained ON fp_org_sessions;
CREATE TRIGGER fp_org_session_retained BEFORE INSERT OR UPDATE OR DELETE ON fp_org_sessions FOR EACH ROW EXECUTE FUNCTION fp_org_session_contract();
DROP TRIGGER IF EXISTS fp_org_invitation_versioned ON fp_org_invitations;
CREATE TRIGGER fp_org_invitation_versioned BEFORE UPDATE OR DELETE ON fp_org_invitations FOR EACH ROW EXECUTE FUNCTION fp_org_versioned('version','state','joined_at','revoked_at','revoked_by','encrypted_token');
DROP TRIGGER IF EXISTS fp_org_link_versioned ON fp_org_project_links;
CREATE TRIGGER fp_org_link_versioned BEFORE UPDATE OR DELETE ON fp_org_project_links FOR EACH ROW EXECUTE FUNCTION fp_org_versioned('version','state','current_consent_id','withdrawn_at','updated_at');
DROP TRIGGER IF EXISTS fp_org_policy_versioned ON fp_org_policies;
CREATE TRIGGER fp_org_policy_versioned BEFORE UPDATE OR DELETE ON fp_org_policies FOR EACH ROW EXECUTE FUNCTION fp_org_versioned('head_version','title','template_ids','draft_hash','encrypted_draft','latest_revision','latest_version_id','updated_at');
DROP TRIGGER IF EXISTS fp_org_policy_publication_retained ON fp_org_policy_versions;
CREATE TRIGGER fp_org_policy_publication_retained BEFORE UPDATE OR DELETE ON fp_org_policy_versions FOR EACH ROW EXECUTE FUNCTION fp_org_versioned('state_version','state','retired_at');
DROP TRIGGER IF EXISTS fp_project_governance_head_versioned ON fp_project_governance_heads;
CREATE TRIGGER fp_project_governance_head_versioned BEFORE UPDATE OR DELETE ON fp_project_governance_heads FOR EACH ROW EXECUTE FUNCTION fp_org_versioned('version','updated_at');
DROP TRIGGER IF EXISTS fp_project_policy_adoption_retained ON fp_project_policy_adoptions;
CREATE TRIGGER fp_project_policy_adoption_retained BEFORE UPDATE OR DELETE ON fp_project_policy_adoptions FOR EACH ROW EXECUTE FUNCTION fp_org_versioned('version','state','superseded_by','deactivated_at','updated_at');
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['fp_org_access','fp_org_libraries','fp_org_library_entries','fp_org_commands','fp_org_audit','fp_org_project_consents','fp_project_policy_artifacts','fp_project_package_revisions','fp_project_policy_subjects','fp_org_portfolios','fp_org_portfolio_audit'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',relation||'_retained',relation);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fp_org_immutable()',relation||'_retained',relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['fp_org_project_links','fp_project_governance_heads','fp_project_policy_adoptions','fp_project_package_revisions','fp_project_policy_subjects'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',relation||'_scope',relation);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION fp_org_project_scope()',relation||'_scope',relation);
  END LOOP;
END $$;
`;
