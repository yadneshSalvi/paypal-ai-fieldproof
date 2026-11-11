/** Public projections are separate from private originals and financial authority. */
export const PROOF_SCHEMA = `
CREATE TABLE IF NOT EXISTS fp_proof_heads (
  tenant_id text NOT NULL, project_id text NOT NULL REFERENCES fp_projects(id), package_id text NOT NULL,
  slug text NOT NULL UNIQUE, version integer NOT NULL DEFAULT 0, current_snapshot_id text,
  state text NOT NULL DEFAULT 'private' CHECK(state IN ('private','published','withdrawn')),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,package_id)
);
CREATE TABLE IF NOT EXISTS fp_proof_derivatives (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL REFERENCES fp_projects(id), package_id text NOT NULL,
  document_id text NOT NULL REFERENCES fp_documents(id), content_hash text NOT NULL, encrypted_data text NOT NULL,
  version integer NOT NULL DEFAULT 1, state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','reviewed','revoked')),
  author_id text NOT NULL, reviewed_by text, reviewer_membership_version integer, reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fp_proof_snapshots (
  id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL REFERENCES fp_projects(id), package_id text NOT NULL,
  revision integer NOT NULL, state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','reviewed','published','superseded','revoked')),
  payload jsonb NOT NULL, content_hash text NOT NULL, encrypted_bindings text NOT NULL, source_hash text NOT NULL,
  author_id text NOT NULL, reviewed_by text, reviewer_membership_version integer, reviewed_at timestamptz, published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,package_id,revision)
);
CREATE INDEX IF NOT EXISTS fp_proof_derivative_scope ON fp_proof_derivatives(tenant_id,project_id,created_at);
CREATE INDEX IF NOT EXISTS fp_proof_snapshot_scope ON fp_proof_snapshots(tenant_id,project_id,package_id,revision);
`;
