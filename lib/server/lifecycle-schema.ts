/** Additive private drafts and opt-in inbox records. No existing authority,
 * financial fact, source permission or original deadline is rewritten. */
export const LIFECYCLE_TABLES = [
  "fp_lifecycle_commands", "fp_lifecycle_preference_heads", "fp_lifecycle_preference_versions",
  "fp_lifecycle_inbox", "fp_lifecycle_inbox_events", "fp_lifecycle_program_heads", "fp_lifecycle_program_versions",
  "fp_lifecycle_schedules", "fp_lifecycle_schedule_versions", "fp_lifecycle_schedule_events",
  "fp_lifecycle_occurrences", "fp_lifecycle_attempts", "fp_lifecycle_snapshots", "fp_lifecycle_contents",
  "fp_lifecycle_reviews", "fp_lifecycle_audit", "fp_lifecycle_observer_heads",
] as const;

export const LIFECYCLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS fp_lifecycle_commands (
  id text NOT NULL UNIQUE, actor_key text NOT NULL, intent_id text NOT NULL, kind text NOT NULL,
  input_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_key,intent_id),
  CHECK(kind IN ('preferences','inbox_state','program_enable','program_disable','schedule_enable','schedule_action','occurrence_retry','occurrence_review','occurrence_state'))
);
CREATE TABLE IF NOT EXISTS fp_lifecycle_preference_heads (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  actor_id text NOT NULL, role text NOT NULL CHECK(role IN ('donor','volunteer')), version integer NOT NULL CHECK(version>0),
  current_version_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,project_id,actor_id,role)
);
CREATE TABLE IF NOT EXISTS fp_lifecycle_preference_versions (
  id text PRIMARY KEY, head_id text NOT NULL REFERENCES fp_lifecycle_preference_heads(id), version integer NOT NULL CHECK(version>0),
  session_id text NOT NULL REFERENCES fp_sessions(id), membership_version integer NOT NULL CHECK(membership_version>0),
  recipient_binding_hash text NOT NULL, enabled boolean NOT NULL, categories jsonb NOT NULL, email_previews boolean NOT NULL,
  history_mode text NOT NULL CHECK(history_mode IN ('future_only','current_records')), opted_in_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL, encrypted_grant text NOT NULL, content_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(head_id,version), UNIQUE(head_id,id), UNIQUE(head_id,version,id), CHECK(expires_at>created_at), CHECK(enabled OR NOT email_previews)
);
CREATE TABLE IF NOT EXISTS fp_lifecycle_inbox (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  actor_id text NOT NULL, role text NOT NULL CHECK(role IN ('donor','volunteer')), session_id text NOT NULL REFERENCES fp_sessions(id),
  membership_version integer NOT NULL CHECK(membership_version>0), preference_version_id text NOT NULL REFERENCES fp_lifecycle_preference_versions(id),
  recipient_binding_hash text NOT NULL, event_key text NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version>0),
  read_state text NOT NULL DEFAULT 'unread' CHECK(read_state IN ('unread','read','archived')),
  source_hash text NOT NULL, snapshot_hash text NOT NULL, content_hash text NOT NULL,
  occurred_at timestamptz NOT NULL, captured_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,project_id,actor_id,role,event_key), CHECK(occurred_at<=captured_at AND captured_at<=created_at AND expires_at>created_at)
);
CREATE INDEX IF NOT EXISTS fp_lifecycle_inbox_history ON fp_lifecycle_inbox(tenant_id,project_id,actor_id,role,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS fp_lifecycle_inbox_events (
  id text PRIMARY KEY, inbox_id text NOT NULL REFERENCES fp_lifecycle_inbox(id), version integer NOT NULL CHECK(version>1),
  actor_key text NOT NULL, action text NOT NULL CHECK(action IN ('read','archive','unarchive')), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(inbox_id,version)
);
CREATE TABLE IF NOT EXISTS fp_lifecycle_program_heads (
  organization_id text PRIMARY KEY REFERENCES fp_organizations(id), version integer NOT NULL CHECK(version>0), current_version_id text NOT NULL,
  state text NOT NULL CHECK(state IN ('enabled','disabled')), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_lifecycle_program_versions (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES fp_organizations(id), version integer NOT NULL CHECK(version>0),
  state text NOT NULL CHECK(state IN ('enabled','disabled')), issuer_session_id text NOT NULL, issuer_membership_id text NOT NULL,
  issuer_membership_version integer NOT NULL CHECK(issuer_membership_version>0), issuer_role text NOT NULL CHECK(issuer_role IN ('owner','coordinator')),
  expires_at timestamptz NOT NULL, encrypted_grant text NOT NULL, content_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,issuer_session_id,issuer_membership_id) REFERENCES fp_org_sessions(organization_id,id,membership_id),
  UNIQUE(organization_id,version), UNIQUE(organization_id,id), UNIQUE(organization_id,version,id), CHECK(state='disabled' OR expires_at>created_at)
);
CREATE TABLE IF NOT EXISTS fp_lifecycle_schedules (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES fp_organizations(id), owner_membership_id text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version>0), current_definition_version integer NOT NULL DEFAULT 1 CHECK(current_definition_version>0),
  state text NOT NULL DEFAULT 'enabled' CHECK(state IN ('enabled','paused','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,owner_membership_id) REFERENCES fp_org_memberships(organization_id,id), UNIQUE(organization_id,id), UNIQUE(organization_id,id,owner_membership_id)
);
CREATE INDEX IF NOT EXISTS fp_lifecycle_schedule_history ON fp_lifecycle_schedules(organization_id,owner_membership_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS fp_lifecycle_schedule_versions (
  id text PRIMARY KEY, schedule_id text NOT NULL, organization_id text NOT NULL, definition_version integer NOT NULL CHECK(definition_version>0),
  definition_hash text NOT NULL, review_hash text NOT NULL, audience text NOT NULL CHECK(audience IN ('project_treasurer','organization_aggregate')),
  issuer_session_id text NOT NULL, issuer_membership_id text NOT NULL, issuer_membership_version integer NOT NULL CHECK(issuer_membership_version>0),
  issuer_role text NOT NULL CHECK(issuer_role IN ('owner','coordinator')), project_session_id text REFERENCES fp_sessions(id),
  program_version integer NOT NULL CHECK(program_version>0), first_due_at timestamptz NOT NULL,
  interval_minutes integer NOT NULL CHECK(interval_minutes IN (15,60,1440,10080)), expires_at timestamptz NOT NULL,
  encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,schedule_id) REFERENCES fp_lifecycle_schedules(organization_id,id),
  FOREIGN KEY(organization_id,schedule_id,issuer_membership_id) REFERENCES fp_lifecycle_schedules(organization_id,id,owner_membership_id),
  FOREIGN KEY(organization_id,issuer_session_id,issuer_membership_id) REFERENCES fp_org_sessions(organization_id,id,membership_id),
  FOREIGN KEY(organization_id,program_version) REFERENCES fp_lifecycle_program_versions(organization_id,version),
  UNIQUE(schedule_id,definition_version), UNIQUE(id,schedule_id,definition_version),
  CHECK((audience='project_treasurer')=(project_session_id IS NOT NULL)), CHECK(first_due_at>created_at AND expires_at>first_due_at)
);
CREATE TABLE IF NOT EXISTS fp_lifecycle_schedule_events (
  id text PRIMARY KEY, schedule_id text NOT NULL REFERENCES fp_lifecycle_schedules(id), definition_version integer NOT NULL CHECK(definition_version>0),
  schedule_version integer NOT NULL CHECK(schedule_version>0), actor_key text NOT NULL,
  action text NOT NULL CHECK(action IN ('enabled','paused','resumed','disabled','replaced')), encrypted_data text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(schedule_id,schedule_version),
  FOREIGN KEY(schedule_id,definition_version) REFERENCES fp_lifecycle_schedule_versions(schedule_id,definition_version)
);
CREATE TABLE IF NOT EXISTS fp_lifecycle_occurrences (
  id text PRIMARY KEY, organization_id text NOT NULL, schedule_id text NOT NULL, definition_id text NOT NULL, definition_version integer NOT NULL,
  occurrence_key text NOT NULL UNIQUE, audience text NOT NULL CHECK(audience IN ('project_treasurer','organization_aggregate')),
  due_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version>0),
  state text NOT NULL CHECK(state IN ('due','capturing','drafting','ready','retry_wait','skipped_paused','blocked_authority','blocked_source','expired','cancelled','failed')),
  read_state text NOT NULL DEFAULT 'unread' CHECK(read_state IN ('unread','read','archived')),
  review_state text NOT NULL DEFAULT 'unreviewed' CHECK(review_state IN ('unreviewed','reviewed_private','changes_requested')),
  captured_at timestamptz, snapshot_hash text, content_hash text, attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  lease_token text, lease_until timestamptz, next_retry_at timestamptz, last_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,schedule_id) REFERENCES fp_lifecycle_schedules(organization_id,id),
  FOREIGN KEY(definition_id,schedule_id,definition_version) REFERENCES fp_lifecycle_schedule_versions(id,schedule_id,definition_version),
  UNIQUE(schedule_id,definition_version,due_at), UNIQUE(id,snapshot_hash,content_hash), UNIQUE(id,snapshot_hash,captured_at),
  CHECK(due_at<=created_at AND expires_at>due_at), CHECK(captured_at IS NULL OR captured_at>=due_at),
  CHECK((captured_at IS NULL)=(snapshot_hash IS NULL)), CHECK(content_hash IS NULL OR snapshot_hash IS NOT NULL),
  CHECK((lease_token IS NULL)=(lease_until IS NULL)), CHECK(lease_until IS NULL OR (lease_until>due_at AND lease_until<=expires_at)), CHECK(state<>'skipped_paused' OR (captured_at IS NULL AND content_hash IS NULL))
);
CREATE INDEX IF NOT EXISTS fp_lifecycle_occurrence_history ON fp_lifecycle_occurrences(organization_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS fp_lifecycle_occurrence_work ON fp_lifecycle_occurrences(state,next_retry_at,lease_until,due_at);
CREATE TABLE IF NOT EXISTS fp_lifecycle_attempts (
  id text PRIMARY KEY, occurrence_id text NOT NULL REFERENCES fp_lifecycle_occurrences(id), ordinal integer NOT NULL CHECK(ordinal>0),
  lease_token text NOT NULL, stage text NOT NULL CHECK(stage IN ('capture','draft','model_poll')),
  outcome text NOT NULL CHECK(outcome IN ('running','succeeded','retryable','blocked','failed')), code text, next_retry_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, UNIQUE(occurrence_id,ordinal),
  CHECK((outcome='running')=(completed_at IS NULL)), CHECK(completed_at IS NULL OR completed_at>=started_at)
);
CREATE TABLE IF NOT EXISTS fp_lifecycle_snapshots (
  id text PRIMARY KEY, occurrence_id text NOT NULL UNIQUE REFERENCES fp_lifecycle_occurrences(id), snapshot_hash text NOT NULL,
  basis_hash text NOT NULL, captured_at timestamptz NOT NULL, encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK(captured_at<=created_at),
  UNIQUE(id,occurrence_id,snapshot_hash),
  FOREIGN KEY(occurrence_id,snapshot_hash,captured_at) REFERENCES fp_lifecycle_occurrences(id,snapshot_hash,captured_at) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS fp_lifecycle_contents (
  id text PRIMARY KEY, occurrence_id text NOT NULL UNIQUE REFERENCES fp_lifecycle_occurrences(id), snapshot_id text NOT NULL UNIQUE REFERENCES fp_lifecycle_snapshots(id),
  snapshot_hash text NOT NULL, content_hash text NOT NULL, origin text NOT NULL CHECK(origin IN ('deterministic','model_selected')),
  encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(snapshot_id,occurrence_id,snapshot_hash) REFERENCES fp_lifecycle_snapshots(id,occurrence_id,snapshot_hash),
  FOREIGN KEY(occurrence_id,snapshot_hash,content_hash) REFERENCES fp_lifecycle_occurrences(id,snapshot_hash,content_hash) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS fp_lifecycle_reviews (
  id text PRIMARY KEY, occurrence_id text NOT NULL, snapshot_hash text NOT NULL, content_hash text NOT NULL, actor_key text NOT NULL,
  decision text NOT NULL CHECK(decision IN ('reviewed_private','changes_requested')), encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(occurrence_id,snapshot_hash,content_hash) REFERENCES fp_lifecycle_occurrences(id,snapshot_hash,content_hash)
);
CREATE TABLE IF NOT EXISTS fp_lifecycle_audit (
  id text PRIMARY KEY, organization_id text REFERENCES fp_organizations(id), tenant_id text REFERENCES fp_tenants(id), project_id text REFERENCES fp_projects(id),
  actor_key text NOT NULL, kind text NOT NULL, resource_id text, encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(organization_id IS NOT NULL OR (tenant_id IS NOT NULL AND project_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS fp_lifecycle_observer_heads (
  name text PRIMARY KEY CHECK(name='personal-v1'), version integer NOT NULL DEFAULT 1 CHECK(version>0),
  encrypted_cursor text, lease_token text, lease_until timestamptz, last_completed_at timestamptz, last_code text,
  last_result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fp_lifecycle_current_preference' AND conrelid='fp_lifecycle_preference_heads'::regclass) THEN
    ALTER TABLE fp_lifecycle_preference_heads ADD CONSTRAINT fp_lifecycle_current_preference FOREIGN KEY(id,version,current_version_id) REFERENCES fp_lifecycle_preference_versions(head_id,version,id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fp_lifecycle_current_program' AND conrelid='fp_lifecycle_program_heads'::regclass) THEN
    ALTER TABLE fp_lifecycle_program_heads ADD CONSTRAINT fp_lifecycle_current_program FOREIGN KEY(organization_id,version,current_version_id) REFERENCES fp_lifecycle_program_versions(organization_id,version,id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fp_lifecycle_current_schedule' AND conrelid='fp_lifecycle_schedules'::regclass) THEN
    ALTER TABLE fp_lifecycle_schedules ADD CONSTRAINT fp_lifecycle_current_schedule FOREIGN KEY(id,current_definition_version) REFERENCES fp_lifecycle_schedule_versions(schedule_id,definition_version) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION fp_lifecycle_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Original lifecycle records are immutable' USING ERRCODE='23514';
END $$;
CREATE OR REPLACE FUNCTION fp_lifecycle_head_contract() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed text[];
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Retain original lifecycle history' USING ERRCODE='23514'; END IF;
  allowed=CASE TG_TABLE_NAME
    WHEN 'fp_lifecycle_preference_heads' THEN ARRAY['version','current_version_id','updated_at']
    WHEN 'fp_lifecycle_program_heads' THEN ARRAY['version','current_version_id','state','updated_at']
    WHEN 'fp_lifecycle_schedules' THEN ARRAY['version','current_definition_version','state','updated_at']
    WHEN 'fp_lifecycle_observer_heads' THEN ARRAY['version','encrypted_cursor','lease_token','lease_until','last_completed_at','last_code','last_result','updated_at']
    WHEN 'fp_lifecycle_inbox' THEN ARRAY['version','read_state','updated_at'] END;
  IF NEW.version<>OLD.version+1 OR to_jsonb(NEW)-allowed<>to_jsonb(OLD)-allowed THEN
    RAISE EXCEPTION 'Retain exact lifecycle identity and advance one reviewed head' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='fp_lifecycle_schedules' THEN
    IF NEW.current_definition_version NOT IN (OLD.current_definition_version,OLD.current_definition_version+1)
      OR (OLD.state='disabled' AND NEW.state<>'disabled' AND NEW.current_definition_version=OLD.current_definition_version) THEN
      RAISE EXCEPTION 'A disabled definition cannot be revived' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION fp_lifecycle_occurrence_contract() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed text[]=ARRAY['version','state','read_state','review_state','captured_at','snapshot_hash','content_hash','attempt_count','lease_token','lease_until','next_retry_at','last_code','updated_at']; definition fp_lifecycle_schedule_versions%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Retain original due slots' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT * INTO definition FROM fp_lifecycle_schedule_versions WHERE id=NEW.definition_id AND schedule_id=NEW.schedule_id AND organization_id=NEW.organization_id AND definition_version=NEW.definition_version;
    IF NOT FOUND OR NEW.audience<>definition.audience OR NEW.expires_at<>definition.expires_at OR NEW.due_at<definition.first_due_at OR NEW.due_at>=definition.expires_at
      OR mod(extract(epoch FROM (NEW.due_at-definition.first_due_at)),definition.interval_minutes*60)<>0 THEN
      RAISE EXCEPTION 'A due slot must retain its exact original definition, cadence and deadline' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version<>OLD.version+1 OR to_jsonb(NEW)-allowed<>to_jsonb(OLD)-allowed OR NEW.attempt_count<OLD.attempt_count
    OR (OLD.snapshot_hash IS NOT NULL AND (NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash OR NEW.captured_at IS DISTINCT FROM OLD.captured_at))
    OR (OLD.content_hash IS NOT NULL AND NEW.content_hash IS DISTINCT FROM OLD.content_hash)
    OR (OLD.state IN ('ready','skipped_paused','blocked_authority','blocked_source','expired','cancelled') AND NEW.state<>OLD.state) THEN
    RAISE EXCEPTION 'Keep the original occurrence, actual cutoff and frozen source/content hashes' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION fp_lifecycle_attempt_contract() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Retain original attempts' USING ERRCODE='23514'; END IF;
  IF OLD.outcome<>'running' OR NEW.outcome='running'
    OR to_jsonb(NEW)-ARRAY['outcome','code','next_retry_at','completed_at']<>to_jsonb(OLD)-ARRAY['outcome','code','next_retry_at','completed_at'] THEN
    RAISE EXCEPTION 'An original attempt has one terminal result' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION fp_lifecycle_project_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM fp_projects p JOIN fp_memberships m ON m.tenant_id=p.tenant_id AND m.project_id=p.id
    WHERE p.id=NEW.project_id AND p.tenant_id=NEW.tenant_id AND m.actor_id=NEW.actor_id) THEN
    RAISE EXCEPTION 'Lifecycle recipient must belong to the original project' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='fp_lifecycle_inbox' THEN
    IF NOT EXISTS(SELECT 1 FROM fp_sessions s WHERE s.id=NEW.session_id AND s.tenant_id=NEW.tenant_id AND s.project_id=NEW.project_id
      AND s.actor_id=NEW.actor_id AND s.role=NEW.role AND NEW.expires_at<=s.expires_at) THEN
      RAISE EXCEPTION 'Personal item cannot widen or renew its original session grant' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['fp_lifecycle_commands','fp_lifecycle_preference_versions','fp_lifecycle_inbox_events','fp_lifecycle_program_versions','fp_lifecycle_schedule_versions','fp_lifecycle_schedule_events','fp_lifecycle_snapshots','fp_lifecycle_contents','fp_lifecycle_reviews','fp_lifecycle_audit'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(name) AND tgname=name||'_immutable') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fp_lifecycle_immutable()',name||'_immutable',name);
    END IF;
  END LOOP;
  FOREACH name IN ARRAY ARRAY['fp_lifecycle_preference_heads','fp_lifecycle_program_heads','fp_lifecycle_schedules','fp_lifecycle_inbox','fp_lifecycle_observer_heads'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(name) AND tgname=name||'_head') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fp_lifecycle_head_contract()',name||'_head',name);
    END IF;
  END LOOP;
  FOREACH name IN ARRAY ARRAY['fp_lifecycle_preference_heads','fp_lifecycle_inbox'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(name) AND tgname=name||'_scope') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION fp_lifecycle_project_scope()',name||'_scope',name);
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='fp_lifecycle_occurrences'::regclass AND tgname='fp_lifecycle_occurrence_guard') THEN
    CREATE TRIGGER fp_lifecycle_occurrence_guard BEFORE INSERT OR UPDATE OR DELETE ON fp_lifecycle_occurrences FOR EACH ROW EXECUTE FUNCTION fp_lifecycle_occurrence_contract();
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='fp_lifecycle_attempts'::regclass AND tgname='fp_lifecycle_attempt_guard') THEN
    CREATE TRIGGER fp_lifecycle_attempt_guard BEFORE UPDATE OR DELETE ON fp_lifecycle_attempts FOR EACH ROW EXECUTE FUNCTION fp_lifecycle_attempt_contract();
  END IF;
END $$;
`;
