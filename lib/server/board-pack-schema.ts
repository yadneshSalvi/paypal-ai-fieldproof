export const BOARD_PACK_SCHEMA = `
CREATE TABLE IF NOT EXISTS fp_board_packs (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES fp_tenants(id), project_id text NOT NULL REFERENCES fp_projects(id),
 actor_id text NOT NULL, role text NOT NULL CHECK(role IN ('donor','volunteer','organizer','auditor')),
 membership_version integer NOT NULL CHECK(membership_version>0), scope_hash text NOT NULL,
 intent_id text NOT NULL, input_hash text NOT NULL, content_hash text NOT NULL,
 source_hash text NOT NULL, semantic_version text NOT NULL, projection_version integer NOT NULL, event_cursor bigint NOT NULL,
 as_of timestamptz NOT NULL, encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,project_id,actor_id,role,intent_id)
);
CREATE INDEX IF NOT EXISTS fp_board_pack_history ON fp_board_packs(tenant_id,project_id,actor_id,role,as_of DESC,id DESC);
CREATE TABLE IF NOT EXISTS fp_board_pack_audit (
 id text PRIMARY KEY, report_id text NOT NULL REFERENCES fp_board_packs(id), tenant_id text NOT NULL, project_id text NOT NULL,
 actor_id text NOT NULL, role text NOT NULL, membership_version integer NOT NULL,
 event text NOT NULL CHECK(event IN ('captured')), content_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION fp_board_pack_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Board Pack captures and audit are immutable' USING ERRCODE='23514'; END;
$$;
DROP TRIGGER IF EXISTS fp_board_pack_retained ON fp_board_packs;
CREATE TRIGGER fp_board_pack_retained BEFORE UPDATE OR DELETE ON fp_board_packs FOR EACH ROW EXECUTE FUNCTION fp_board_pack_immutable();
DROP TRIGGER IF EXISTS fp_board_pack_audit_retained ON fp_board_pack_audit;
CREATE TRIGGER fp_board_pack_audit_retained BEFORE UPDATE OR DELETE ON fp_board_pack_audit FOR EACH ROW EXECUTE FUNCTION fp_board_pack_immutable();
`;
