/** Additive schema 13. Does not copy, replace or renew any existing session or project. */
export const COMMUNITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS fp_workspace_libraries (
  id text PRIMARY KEY, token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_workspace_library_entries (
  library_id text NOT NULL REFERENCES fp_workspace_libraries(id), session_id text NOT NULL REFERENCES fp_sessions(id),
  tenant_id text NOT NULL, project_id text NOT NULL, actor_id text NOT NULL,
  encrypted_token text NOT NULL, token_hash text NOT NULL, saved_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz, PRIMARY KEY(library_id,session_id)
);
CREATE TABLE IF NOT EXISTS fp_workspace_creation_intents (
  library_id text NOT NULL REFERENCES fp_workspace_libraries(id), intent_id text NOT NULL,
  input_hash text NOT NULL, session_id text NOT NULL REFERENCES fp_sessions(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(library_id,intent_id)
);
CREATE TABLE IF NOT EXISTS fp_workspace_switch_events (
  id text PRIMARY KEY, library_id text NOT NULL REFERENCES fp_workspace_libraries(id),
  from_session_id text, to_session_id text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_community_actions (
  tenant_id text NOT NULL, project_id text NOT NULL, actor_id text NOT NULL, intent_id text NOT NULL,
  kind text NOT NULL, input_hash text NOT NULL, encrypted_result text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,actor_id,intent_id)
);
CREATE TABLE IF NOT EXISTS fp_community_snapshots (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL REFERENCES fp_projects(id), actor_id text NOT NULL,
  role text NOT NULL, membership_version integer NOT NULL, audience text NOT NULL CHECK(audience IN ('treasurer','supporter')),
  content_hash text NOT NULL, snapshot_hash text NOT NULL, encrypted_source text NOT NULL, captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fp_community_snapshot_scope ON fp_community_snapshots(project_id,actor_id,captured_at DESC);
CREATE TABLE IF NOT EXISTS fp_community_drafts (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, actor_id text NOT NULL,
  snapshot_id text NOT NULL REFERENCES fp_community_snapshots(id), source_hash text NOT NULL, content_hash text NOT NULL,
  audience text NOT NULL CHECK(audience IN ('treasurer','supporter')), origin text NOT NULL CHECK(origin IN ('selected','model')),
  source_run_id text, encrypted_content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_community_translation_heads (
  draft_id text PRIMARY KEY REFERENCES fp_community_drafts(id), version integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS fp_community_translations (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, actor_id text NOT NULL,
  draft_id text NOT NULL REFERENCES fp_community_drafts(id), revision integer NOT NULL,
  source_hash text NOT NULL, content_hash text NOT NULL, origin text NOT NULL CHECK(origin IN ('authored_starter','manual','model')),
  source_run_id text, encrypted_content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(draft_id,revision)
);
CREATE TABLE IF NOT EXISTS fp_community_backtranslations (
  id text PRIMARY KEY, translation_id text NOT NULL REFERENCES fp_community_translations(id), translation_hash text NOT NULL,
  content_hash text NOT NULL, origin text NOT NULL CHECK(origin IN ('manual','model')), source_run_id text,
  actor_id text NOT NULL, encrypted_content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_community_translation_reviews (
  id text PRIMARY KEY, translation_id text NOT NULL REFERENCES fp_community_translations(id), translation_hash text NOT NULL,
  backtranslation_id text NOT NULL REFERENCES fp_community_backtranslations(id), backtranslation_hash text NOT NULL,
  reviewer_actor_id text NOT NULL, reviewer_session_id text NOT NULL REFERENCES fp_sessions(id), membership_version integer NOT NULL,
  decision text NOT NULL CHECK(decision IN ('approved','needs_changes')), kind text NOT NULL CHECK(kind IN ('fluent_reviewer','sample_exercise')),
  encrypted_note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_community_runs (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, actor_id text NOT NULL,
  session_id text NOT NULL REFERENCES fp_sessions(id), membership_version integer NOT NULL,
  task text NOT NULL CHECK(task IN ('brief','translate','backtranslate')), model text NOT NULL,
  input_hash text NOT NULL, encrypted_input text NOT NULL, state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed','unknown')),
  dispatch_count integer NOT NULL DEFAULT 0 CHECK(dispatch_count BETWEEN 0 AND 1), poll_count integer NOT NULL DEFAULT 0,
  lease_id text, lease_until timestamptz, dispatched_at timestamptz, next_poll_at timestamptz, resume_until timestamptz,
  encrypted_response_id text, response_identity_hash text, encrypted_output text, output_hash text, result_id text, code text,
  duration_ms integer, input_tokens integer, output_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS fp_community_update_previews (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, actor_id text NOT NULL,
  draft_id text NOT NULL REFERENCES fp_community_drafts(id), translation_id text REFERENCES fp_community_translations(id),
  source_hash text NOT NULL, draft_hash text NOT NULL, translation_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fp_community_due_runs ON fp_community_runs(state,next_poll_at) WHERE state IN ('queued','running');
CREATE TABLE IF NOT EXISTS fp_community_model_observations (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES fp_community_runs(id), kind text NOT NULL,
  request_hash text NOT NULL, response_identity_hash text, code text, encrypted_content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
