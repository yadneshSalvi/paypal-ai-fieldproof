export const SUPPORTER_ACCESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS fp_supporter_invites (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  issuer_actor_id text NOT NULL, issuer_session_id text NOT NULL REFERENCES fp_sessions(id), issuer_membership_version integer NOT NULL,
  issuer_browser_hash text NOT NULL, purpose text NOT NULL CHECK(purpose IN ('donor','sponsor')), role text NOT NULL CHECK(role='donor'),
  token_hash text NOT NULL UNIQUE, encrypted_token text, encrypted_data text NOT NULL,
  state text NOT NULL DEFAULT 'invited' CHECK(state IN ('invited','joined','revoked')), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  joined_at timestamptz, revoked_at timestamptz, revoked_by text,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '7 days'),
  CHECK((state='revoked')=(revoked_at IS NOT NULL)), CHECK((revoked_at IS NULL)=(revoked_by IS NULL))
);
CREATE INDEX IF NOT EXISTS fp_supporter_invite_scope ON fp_supporter_invites(tenant_id,project_id,created_at DESC);
CREATE TABLE IF NOT EXISTS fp_supporter_access (
  id text PRIMARY KEY, invitation_id text NOT NULL UNIQUE REFERENCES fp_supporter_invites(id),
  tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id), actor_id text NOT NULL,
  session_id text NOT NULL UNIQUE REFERENCES fp_sessions(id), membership_version integer NOT NULL DEFAULT 1,
  acceptance_intent_id text NOT NULL, acceptance_hash text NOT NULL, browser_hash text NOT NULL,
  encrypted_identity text NOT NULL, encrypted_acceptance text NOT NULL,
  encrypted_session_token text NOT NULL, recovery_token_hash text NOT NULL UNIQUE, encrypted_recovery_token text NOT NULL,
  identity_provenance text NOT NULL CHECK(identity_provenance='self_declared'), authentication_method text NOT NULL CHECK(authentication_method='invitation_possession'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  UNIQUE(tenant_id,project_id,actor_id)
);
CREATE TABLE IF NOT EXISTS fp_supporter_commands (
  tenant_id text NOT NULL, project_id text NOT NULL, actor_id text NOT NULL, intent_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('invite','revoke','restore')), input_hash text NOT NULL, encrypted_input text NOT NULL,
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,actor_id,intent_id)
);
CREATE TABLE IF NOT EXISTS fp_supporter_access_audit (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, invitation_id text NOT NULL REFERENCES fp_supporter_invites(id),
  kind text NOT NULL CHECK(kind IN ('invited','accepted','revoked','restored')), actor_id text NOT NULL,
  session_id text NOT NULL, membership_version integer NOT NULL, encrypted_data text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS fp_supporter_audit_scope ON fp_supporter_access_audit(tenant_id,project_id,invitation_id,created_at);
CREATE OR REPLACE FUNCTION fp_supporter_invite_contract_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR ROW(NEW.id,NEW.tenant_id,NEW.project_id,NEW.issuer_actor_id,NEW.issuer_session_id,NEW.issuer_membership_version,NEW.issuer_browser_hash,NEW.purpose,NEW.role,NEW.token_hash,NEW.encrypted_data,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.project_id,OLD.issuer_actor_id,OLD.issuer_session_id,OLD.issuer_membership_version,OLD.issuer_browser_hash,OLD.purpose,OLD.role,OLD.token_hash,OLD.encrypted_data,OLD.created_at,OLD.expires_at)
    THEN RAISE EXCEPTION 'Supporter invitation terms and expiry are immutable'; END IF;
  IF OLD.state='revoked' OR (OLD.state='joined' AND NEW.state<>'revoked') OR NEW.state='invited' OR NEW.version<>OLD.version+1
    OR (OLD.joined_at IS NOT NULL AND NEW.joined_at IS DISTINCT FROM OLD.joined_at) OR NEW.encrypted_token IS NOT NULL
    THEN RAISE EXCEPTION 'Invalid supporter invitation transition'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fp_supporter_invite_contract ON fp_supporter_invites;
CREATE TRIGGER fp_supporter_invite_contract BEFORE UPDATE OR DELETE ON fp_supporter_invites FOR EACH ROW EXECUTE FUNCTION fp_supporter_invite_contract_guard();
CREATE OR REPLACE FUNCTION fp_supporter_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Supporter access history is append-only'; END $$;
DROP TRIGGER IF EXISTS fp_supporter_access_immutable ON fp_supporter_access;
CREATE TRIGGER fp_supporter_access_immutable BEFORE UPDATE OR DELETE ON fp_supporter_access FOR EACH ROW EXECUTE FUNCTION fp_supporter_append_only_guard();
DROP TRIGGER IF EXISTS fp_supporter_audit_immutable ON fp_supporter_access_audit;
CREATE TRIGGER fp_supporter_audit_immutable BEFORE UPDATE OR DELETE ON fp_supporter_access_audit FOR EACH ROW EXECUTE FUNCTION fp_supporter_append_only_guard();
DROP TRIGGER IF EXISTS fp_supporter_command_immutable ON fp_supporter_commands;
CREATE TRIGGER fp_supporter_command_immutable BEFORE UPDATE OR DELETE ON fp_supporter_commands FOR EACH ROW EXECUTE FUNCTION fp_supporter_append_only_guard();
`;
