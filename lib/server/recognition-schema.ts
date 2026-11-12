/** Integration owns marker24. This fragment creates only recognition-owned objects. */
export const RECOGNITION_SCHEMA_VERSION = 24;
export const RECOGNITION_SCHEMA = `
CREATE TABLE IF NOT EXISTS fp_recognition_heads (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, actor_id text NOT NULL,
  role text NOT NULL CHECK(role IN ('donor','volunteer')), slug text NOT NULL,
  version integer NOT NULL CHECK(version>0), state text NOT NULL CHECK(state IN ('consented','withdrawn','suppressed')),
  current_consent_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,project_id,actor_id,role,slug), UNIQUE(id,tenant_id,project_id,actor_id,role,slug)
);
CREATE TABLE IF NOT EXISTS fp_recognition_consents (
  id text PRIMARY KEY, head_id text NOT NULL REFERENCES fp_recognition_heads(id) DEFERRABLE INITIALLY DEFERRED,
  tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id), actor_id text NOT NULL, role text NOT NULL CHECK(role IN ('donor','volunteer')),
  version integer NOT NULL CHECK(version>0), session_id text NOT NULL REFERENCES fp_sessions(id), session_hash text NOT NULL, membership_version integer NOT NULL CHECK(membership_version>0),
  session_expires_at timestamptz NOT NULL, entry_kind text NOT NULL CHECK(entry_kind IN ('supporter','reviewer','procurement')),
  entry_id text NOT NULL, entry_expires_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  slug text NOT NULL, proof_snapshot_id text NOT NULL REFERENCES fp_proof_snapshots(id), proof_hash text NOT NULL, review_key text NOT NULL,
  access_id text NOT NULL, mode text NOT NULL CHECK(mode IN ('sample','live_sandbox')), encrypted_data text NOT NULL, consented_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(expires_at=LEAST(session_expires_at,entry_expires_at) AND consented_at<expires_at), UNIQUE(head_id,version),
  UNIQUE(id,head_id,tenant_id,project_id,actor_id,role,slug),
  FOREIGN KEY(project_id,actor_id) REFERENCES fp_memberships(project_id,actor_id),
  FOREIGN KEY(head_id,tenant_id,project_id,actor_id,role,slug) REFERENCES fp_recognition_heads(id,tenant_id,project_id,actor_id,role,slug) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS fp_recognition_wall ON fp_recognition_consents(slug,date_trunc('milliseconds',consented_at AT TIME ZONE 'UTC'),id);
CREATE INDEX IF NOT EXISTS fp_recognition_scope ON fp_recognition_heads(tenant_id,project_id,slug,state);
CREATE TABLE IF NOT EXISTS fp_recognition_commands (
  id text PRIMARY KEY, intent_id text NOT NULL UNIQUE, tenant_id text NOT NULL, project_id text NOT NULL, actor_id text NOT NULL,
  role text NOT NULL CHECK(role IN ('donor','volunteer','organizer')), session_id text NOT NULL REFERENCES fp_sessions(id), session_hash text NOT NULL,
  access_id text NOT NULL, input_hash text NOT NULL, action text NOT NULL CHECK(action IN ('consent','withdraw','suppress')),
  encrypted_input text NOT NULL, receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(project_id,actor_id) REFERENCES fp_memberships(project_id,actor_id), CHECK((action='suppress')=(role='organizer'))
);
CREATE TABLE IF NOT EXISTS fp_recognition_audit (
  id text PRIMARY KEY, command_id text NOT NULL UNIQUE REFERENCES fp_recognition_commands(id) DEFERRABLE INITIALLY DEFERRED,
  head_id text NOT NULL REFERENCES fp_recognition_heads(id), kind text NOT NULL CHECK(kind IN ('consent','withdraw','suppress')),
  encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION fp_recognition_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Recognition history is immutable'; END; $$;
DO $$ DECLARE item text; BEGIN
  FOREACH item IN ARRAY ARRAY['consents','commands','audit'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fp_recognition_'||item||'_immutable' AND tgrelid=('fp_recognition_'||item)::regclass) THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fp_recognition_immutable()', 'fp_recognition_'||item||'_immutable','fp_recognition_'||item);
    END IF;
  END LOOP;
END $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fp_recognition_current_consent_scope' AND conrelid='fp_recognition_heads'::regclass) THEN
    ALTER TABLE fp_recognition_heads ADD CONSTRAINT fp_recognition_current_consent_scope
      FOREIGN KEY(current_consent_id,id,tenant_id,project_id,actor_id,role,slug)
      REFERENCES fp_recognition_consents(id,head_id,tenant_id,project_id,actor_id,role,slug) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION fp_recognition_consent_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM fp_sessions s JOIN fp_projects p ON p.id=s.project_id AND p.tenant_id=s.tenant_id
    JOIN fp_tenants t ON t.id=s.tenant_id JOIN fp_memberships m ON m.tenant_id=s.tenant_id AND m.project_id=s.project_id AND m.actor_id=s.actor_id
    WHERE s.id=NEW.session_id AND s.tenant_id=NEW.tenant_id AND s.project_id=NEW.project_id AND s.actor_id=NEW.actor_id
      AND s.role=NEW.role AND s.token_hash=NEW.session_hash AND s.expires_at=NEW.session_expires_at AND s.revoked_at IS NULL
      AND s.expires_at>clock_timestamp() AND m.state='active' AND m.version=NEW.membership_version AND m.roles=jsonb_build_array(NEW.role)
      AND t.mode=NEW.mode) THEN RAISE EXCEPTION 'Recognition consent requires exact original session and membership lineage'; END IF;
  IF NOT EXISTS(SELECT 1 FROM fp_proof_snapshots p JOIN fp_proof_heads h ON h.current_snapshot_id=p.id
    WHERE p.id=NEW.proof_snapshot_id AND p.tenant_id=NEW.tenant_id AND p.project_id=NEW.project_id AND p.content_hash=NEW.proof_hash
      AND h.slug=NEW.slug AND h.tenant_id=NEW.tenant_id AND h.project_id=NEW.project_id AND h.state='published' AND p.state='published')
    THEN RAISE EXCEPTION 'Recognition consent requires exact current public proof lineage'; END IF;
  RETURN NEW;
END; $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fp_recognition_consent_lineage' AND tgrelid='fp_recognition_consents'::regclass) THEN
    CREATE TRIGGER fp_recognition_consent_lineage BEFORE INSERT ON fp_recognition_consents FOR EACH ROW EXECUTE FUNCTION fp_recognition_consent_lineage();
  END IF;
END $$;
CREATE OR REPLACE FUNCTION fp_recognition_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Recognition heads retain history'; END IF;
  IF ROW(NEW.id,NEW.tenant_id,NEW.project_id,NEW.actor_id,NEW.role,NEW.slug,NEW.created_at) IS DISTINCT FROM
     ROW(OLD.id,OLD.tenant_id,OLD.project_id,OLD.actor_id,OLD.role,OLD.slug,OLD.created_at)
     OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at
     OR (NEW.state<>'consented' AND (NEW.current_consent_id<>OLD.current_consent_id OR OLD.state<>'consented'))
     OR (NEW.state='consented' AND NEW.current_consent_id=OLD.current_consent_id) THEN
    RAISE EXCEPTION 'Recognition head requires a separate versioned decision';
  END IF;
  RETURN NEW;
END; $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fp_recognition_head_guard' AND tgrelid='fp_recognition_heads'::regclass) THEN
    CREATE TRIGGER fp_recognition_head_guard BEFORE UPDATE OR DELETE ON fp_recognition_heads FOR EACH ROW EXECUTE FUNCTION fp_recognition_head_guard();
  END IF;
END $$;
CREATE OR REPLACE FUNCTION fp_recognition_current_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM fp_recognition_heads h JOIN fp_recognition_consents c ON c.id=h.current_consent_id
    WHERE h.id=NEW.id AND ((h.state='consented' AND h.version<>c.version) OR (h.state<>'consented' AND h.version<=c.version)))
    THEN RAISE EXCEPTION 'A public decision requires its new exact consent version'; END IF;
  RETURN NULL;
END; $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fp_recognition_current_version' AND tgrelid='fp_recognition_heads'::regclass) THEN
    CREATE CONSTRAINT TRIGGER fp_recognition_current_version AFTER INSERT OR UPDATE ON fp_recognition_heads
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fp_recognition_current_version();
  END IF;
END $$;
CREATE OR REPLACE FUNCTION fp_recognition_command_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM fp_sessions s JOIN fp_memberships m ON m.project_id=s.project_id AND m.actor_id=s.actor_id AND m.tenant_id=s.tenant_id
    WHERE s.id=NEW.session_id AND s.tenant_id=NEW.tenant_id AND s.project_id=NEW.project_id AND s.actor_id=NEW.actor_id
      AND s.role=NEW.role AND s.token_hash=NEW.session_hash AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND m.state='active' AND m.roles ? NEW.role) THEN RAISE EXCEPTION 'Recognition command requires original current authority'; END IF;
  RETURN NEW;
END; $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fp_recognition_command_lineage' AND tgrelid='fp_recognition_commands'::regclass) THEN
    CREATE TRIGGER fp_recognition_command_lineage BEFORE INSERT ON fp_recognition_commands FOR EACH ROW EXECUTE FUNCTION fp_recognition_command_lineage();
  END IF;
END $$;
`;
