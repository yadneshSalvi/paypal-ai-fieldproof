/** Additive schema: original package versions and every financial row are untouched. */
export const PLANNING_SCHEMA = `
CREATE TABLE IF NOT EXISTS fp_planning_heads (
  project_id text PRIMARY KEY REFERENCES fp_projects(id), tenant_id text NOT NULL REFERENCES fp_tenants(id),
  version integer NOT NULL DEFAULT 0, current_plan_id text, publication_id text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_plan_versions (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
  revision integer NOT NULL, author_id text NOT NULL, origin text NOT NULL CHECK(origin IN ('manual','sample','model')),
  source_run_id text, content_hash text NOT NULL, geometry_hash text NOT NULL, source_hash text NOT NULL, package_hash text NOT NULL,
  encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,revision)
);
CREATE TABLE IF NOT EXISTS fp_plan_reviews (
  id text PRIMARY KEY, plan_id text NOT NULL UNIQUE REFERENCES fp_plan_versions(id), tenant_id text NOT NULL, project_id text NOT NULL,
  actor_id text NOT NULL, membership_version integer NOT NULL, decision text NOT NULL CHECK(decision IN ('approved','needs_changes')),
  content_hash text NOT NULL, encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_plan_publications (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, plan_id text NOT NULL UNIQUE REFERENCES fp_plan_versions(id),
  review_id text NOT NULL REFERENCES fp_plan_reviews(id), actor_id text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','superseded','revoked')), content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS fp_one_current_plan ON fp_plan_publications(project_id) WHERE state='active';
CREATE TABLE IF NOT EXISTS fp_plan_source_controls (
  document_id text PRIMARY KEY REFERENCES fp_documents(id), tenant_id text NOT NULL, project_id text NOT NULL,
  version integer NOT NULL DEFAULT 1, permission text NOT NULL DEFAULT 'allowed' CHECK(permission IN ('allowed','withdrawn')),
  classification text NOT NULL CHECK(classification IN ('source','photograph','illustration','credential')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_planning_actions (
  tenant_id text NOT NULL, project_id text NOT NULL, actor_id text NOT NULL, intent_id text NOT NULL,
  kind text NOT NULL, input_hash text NOT NULL, encrypted_input text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,actor_id,intent_id)
);
CREATE TABLE IF NOT EXISTS fp_plan_runs (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, actor_id text NOT NULL, session_id text NOT NULL,
  membership_version integer NOT NULL, input_hash text NOT NULL, encrypted_input text NOT NULL,
  provider text NOT NULL, model text NOT NULL, prompt_version text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed')), encrypted_output text,
  code text, stats jsonb, attempt integer NOT NULL DEFAULT 0, lease_id text, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE(project_id,actor_id,input_hash,provider,model,prompt_version)
);
CREATE TABLE IF NOT EXISTS fp_plan_run_attempts (
  run_id text NOT NULL REFERENCES fp_plan_runs(id), attempt integer NOT NULL, lease_id text NOT NULL,
  state text NOT NULL, code text, encrypted_result text, stats jsonb,
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, PRIMARY KEY(run_id,attempt)
);
ALTER TABLE fp_plan_runs ADD COLUMN IF NOT EXISTS encrypted_checkpoint text;
ALTER TABLE fp_plan_runs ADD COLUMN IF NOT EXISTS next_poll_at timestamptz;
ALTER TABLE fp_plan_runs ADD COLUMN IF NOT EXISTS resume_until timestamptz;
CREATE TABLE IF NOT EXISTS fp_plan_provider_observations (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES fp_plan_runs(id), attempt integer NOT NULL,
  kind text NOT NULL, code text, encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fp_plan_observation_history ON fp_plan_provider_observations(run_id,attempt,created_at);
CREATE INDEX IF NOT EXISTS fp_plan_run_queue ON fp_plan_runs(state,created_at) WHERE state IN ('queued','running');
CREATE INDEX IF NOT EXISTS fp_plan_version_history ON fp_plan_versions(tenant_id,project_id,revision DESC);
CREATE TABLE IF NOT EXISTS fp_photo_alignments (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, plan_id text NOT NULL REFERENCES fp_plan_versions(id),
  package_id text NOT NULL, document_id text NOT NULL REFERENCES fp_documents(id), author_id text NOT NULL,
  revision integer NOT NULL DEFAULT 1, content_hash text NOT NULL, encrypted_data text NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','reviewed','revoked')), reviewed_by text, reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_reviewer_qualifications (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, actor_id text NOT NULL,
  scope text NOT NULL, document_id text NOT NULL REFERENCES fp_documents(id), source_hash text NOT NULL, control_version integer NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','verified','revoked')), version integer NOT NULL DEFAULT 1,
  membership_version integer NOT NULL, provenance text NOT NULL CHECK(provenance IN ('sample','reviewer_attested')),
  encrypted_data text NOT NULL, valid_until timestamptz NOT NULL, reviewed_by text, reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fp_photo_alignment_scope ON fp_photo_alignments(tenant_id,project_id,created_at DESC);
CREATE INDEX IF NOT EXISTS fp_reviewer_qualification_scope ON fp_reviewer_qualifications(tenant_id,project_id,actor_id);
CREATE TABLE IF NOT EXISTS fp_work_signoffs (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, plan_id text NOT NULL REFERENCES fp_plan_versions(id),
  package_id text NOT NULL, requirement_id text NOT NULL, qualification_id text NOT NULL REFERENCES fp_reviewer_qualifications(id),
  qualification_version integer NOT NULL, actor_id text NOT NULL, decision text NOT NULL CHECK(decision IN ('accepted','needs_information','rejected')),
  content_hash text NOT NULL, encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fp_work_signoff_history ON fp_work_signoffs(project_id,plan_id,package_id,requirement_id,created_at DESC);
CREATE TABLE IF NOT EXISTS fp_reviewer_invites (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, issuer_id text NOT NULL, issuer_membership_version integer NOT NULL,
  version integer NOT NULL DEFAULT 1, token_hash text NOT NULL UNIQUE, encrypted_data text NOT NULL,
  state text NOT NULL DEFAULT 'invited' CHECK(state IN ('invited','joined','revoked')), expires_at timestamptz NOT NULL,
  actor_id text, session_id text, redemption_nonce_hash text, encrypted_session_token text, joined_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fp_reviewer_invite_scope ON fp_reviewer_invites(tenant_id,project_id,actor_id);
`;
