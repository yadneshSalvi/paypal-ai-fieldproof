/** Private report storage. No table grants application or financial authority. */
export const STUDIO_SCHEMA = `
CREATE TABLE IF NOT EXISTS fp_studio_snapshots (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  actor_id text NOT NULL, role text NOT NULL CHECK(role IN ('donor','volunteer','organizer','auditor')),
  scope_hash text NOT NULL, membership_version integer NOT NULL, projection_version integer NOT NULL,
  event_cursor bigint NOT NULL, as_of timestamptz NOT NULL, content_hash text NOT NULL,
  encrypted_data text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fp_studio_snapshot_scope ON fp_studio_snapshots(scope_hash,created_at DESC);
CREATE TABLE IF NOT EXISTS fp_studio_reports (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  actor_id text NOT NULL, role text NOT NULL CHECK(role IN ('donor','volunteer','organizer','auditor')),
  scope_hash text NOT NULL UNIQUE, membership_version integer NOT NULL, revision integer NOT NULL DEFAULT 1,
  history_hash text NOT NULL, encrypted_history text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_studio_layout_events (
  id text PRIMARY KEY, report_id text NOT NULL REFERENCES fp_studio_reports(id), revision integer NOT NULL,
  actor_id text NOT NULL, source text NOT NULL DEFAULT 'client_observed', history_hash text NOT NULL,
  encrypted_summary text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(report_id,revision)
);
CREATE TABLE IF NOT EXISTS fp_studio_agent_runs (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  actor_id text NOT NULL, session_id text NOT NULL REFERENCES fp_sessions(id), role text NOT NULL,
  scope_hash text NOT NULL, membership_version integer NOT NULL, snapshot_id text NOT NULL REFERENCES fp_studio_snapshots(id),
  agent_id text NOT NULL, thread_id text NOT NULL, run_key text NOT NULL, provider text NOT NULL, model text NOT NULL,
  prompt_version text NOT NULL, input_hash text NOT NULL, encrypted_input text NOT NULL, encrypted_transcript text NOT NULL,
  state text NOT NULL, version integer NOT NULL DEFAULT 1, stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  parent_run_key text, parent_call_id text, client_outcome text, client_finished_at timestamptz, client_history_hash text,
  lease_id text, lease_until timestamptz, last_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(scope_hash,run_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS fp_studio_one_delegate ON fp_studio_agent_runs(scope_hash,parent_run_key,parent_call_id) WHERE parent_call_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS fp_studio_tool_receipts (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES fp_studio_agent_runs(id), call_id text NOT NULL,
  tool_name text NOT NULL, transport text NOT NULL, input_hash text NOT NULL, output_hash text NOT NULL,
  status text NOT NULL, encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,call_id)
);
CREATE TABLE IF NOT EXISTS fp_studio_chat_threads (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  actor_id text NOT NULL, role text NOT NULL, scope_hash text NOT NULL, membership_version integer NOT NULL,
  thread_id text NOT NULL, agent_id text NOT NULL, revision integer NOT NULL DEFAULT 1,
  content_hash text NOT NULL, encrypted_summary text NOT NULL, encrypted_thread text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE(scope_hash,thread_id)
);
CREATE INDEX IF NOT EXISTS fp_studio_chat_scope ON fp_studio_chat_threads(scope_hash,updated_at DESC);
`;
