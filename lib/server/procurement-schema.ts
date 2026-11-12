/** Additive project procurement tables only. The integration owner coordinates
 * the global schema marker. This module never initializes or rewrites a project,
 * financial journal, approval, physical decision, membership or runtime. */
export const PROCUREMENT_TABLES = [
  "fp_procurement_suppliers", "fp_procurement_supplier_versions", "fp_procurement_quotes", "fp_procurement_quote_versions",
  "fp_package_operations", "fp_package_operation_events", "fp_procurement_responsibilities", "fp_procurement_selections",
  "fp_procurement_progress", "fp_procurement_exceptions", "fp_procurement_exception_events", "fp_procurement_expense_links",
  "fp_procurement_commands", "fp_procurement_reviews", "fp_procurement_audit", "fp_procurement_invites", "fp_procurement_access",
  "fp_procurement_entry_commands", "fp_procurement_access_audit",
] as const;
const retained = PROCUREMENT_TABLES.filter(name => !["fp_procurement_suppliers", "fp_procurement_quotes", "fp_package_operations", "fp_procurement_responsibilities", "fp_procurement_exceptions", "fp_procurement_invites"].includes(name));
const mutable = {
  fp_procurement_suppliers: "version,state,updated_at", fp_procurement_quotes: "version,state,supplier_id,package_ids,updated_at",
  fp_package_operations: "version,cycle,state,blocked_from,cycle_started_at,encrypted_data,content_hash,updated_at",
  fp_procurement_responsibilities: "version,state,responded_at,encrypted_response,updated_at", fp_procurement_exceptions: "version,state,resolved_at,updated_at",
} as const;
export const PROCUREMENT_GUARDS = [
  ...PROCUREMENT_TABLES.map(table => ({ table, name: `${table}_scope` })), ...retained.map(table => ({ table, name: `${table}_retained` })),
  ...Object.keys(mutable).map(table => ({ table, name: `${table}_head` })),
  { table: "fp_package_operations", name: "fp_package_operations_transition" }, { table: "fp_package_operations", name: "fp_package_operations_history" },
  { table: "fp_procurement_invites", name: "fp_procurement_invites_contract" },
] as const;

export const PROCUREMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS fp_procurement_suppliers (
 id text PRIMARY KEY,tenant_id text NOT NULL REFERENCES fp_tenants(id),project_id text NOT NULL REFERENCES fp_projects(id),
 created_by text NOT NULL,created_role text NOT NULL CHECK(created_role IN ('organizer','volunteer')),created_session_id text NOT NULL REFERENCES fp_sessions(id),created_membership_version integer NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','archived')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,project_id,id)
);
CREATE TABLE IF NOT EXISTS fp_procurement_supplier_versions (
 supplier_id text NOT NULL REFERENCES fp_procurement_suppliers(id),tenant_id text NOT NULL,project_id text NOT NULL,version integer NOT NULL CHECK(version>0),
 state text NOT NULL CHECK(state IN ('active','archived')),content_hash text NOT NULL,encrypted_data text NOT NULL,
 actor_id text NOT NULL,actor_session_id text NOT NULL REFERENCES fp_sessions(id),actor_role text NOT NULL CHECK(actor_role IN ('organizer','volunteer')),membership_version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(supplier_id,version)
);
CREATE TABLE IF NOT EXISTS fp_procurement_quotes (
 id text PRIMARY KEY,tenant_id text NOT NULL REFERENCES fp_tenants(id),project_id text NOT NULL REFERENCES fp_projects(id),
 supplier_id text NOT NULL REFERENCES fp_procurement_suppliers(id),package_ids jsonb NOT NULL CHECK(jsonb_typeof(package_ids)='array' AND jsonb_array_length(package_ids) BETWEEN 1 AND 20),created_by text NOT NULL,created_role text NOT NULL CHECK(created_role IN ('organizer','volunteer')),created_session_id text NOT NULL REFERENCES fp_sessions(id),created_membership_version integer NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','reviewed','needs_information','retired')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,project_id,id)
);
CREATE TABLE IF NOT EXISTS fp_procurement_quote_versions (
 quote_id text NOT NULL REFERENCES fp_procurement_quotes(id),tenant_id text NOT NULL,project_id text NOT NULL,version integer NOT NULL CHECK(version>0),
 supplier_id text NOT NULL REFERENCES fp_procurement_suppliers(id),supplier_version integer NOT NULL,
 state text NOT NULL CHECK(state IN ('draft','reviewed','needs_information','retired')),content_hash text NOT NULL,encrypted_data text NOT NULL,
 source_document_id text REFERENCES fp_documents(id),source_document_version integer,source_hash text,source_control_version integer,
 actor_id text NOT NULL,actor_session_id text NOT NULL REFERENCES fp_sessions(id),actor_role text NOT NULL CHECK(actor_role IN ('organizer','volunteer')),membership_version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(quote_id,version),
 FOREIGN KEY(supplier_id,supplier_version) REFERENCES fp_procurement_supplier_versions(supplier_id,version),
 CHECK((source_document_id IS NULL)=(source_document_version IS NULL)),CHECK((source_document_id IS NULL)=(source_hash IS NULL)),CHECK((source_document_id IS NULL)=(source_control_version IS NULL))
);
CREATE TABLE IF NOT EXISTS fp_package_operations (
 tenant_id text NOT NULL,project_id text NOT NULL,package_id text NOT NULL,version integer NOT NULL DEFAULT 0 CHECK(version>=0),cycle integer NOT NULL DEFAULT 1 CHECK(cycle>0),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','approved','procurement_ready','in_progress','review_pending','accepted','blocked','canceled','reopened')),
 blocked_from text,cycle_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),content_hash text NOT NULL,encrypted_data text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,project_id,package_id),
 FOREIGN KEY(project_id,package_id) REFERENCES fp_packages(project_id,id),CHECK((state='blocked')=(blocked_from IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS fp_package_operation_events (
 id text PRIMARY KEY,tenant_id text NOT NULL,project_id text NOT NULL,package_id text NOT NULL,version integer NOT NULL CHECK(version>0),cycle integer NOT NULL CHECK(cycle>0),
 kind text NOT NULL CHECK(kind IN ('transition','responsibility','quote_selection','progress','exception','expense_link')),from_state text,to_state text,
 actor_id text NOT NULL,actor_session_id text NOT NULL REFERENCES fp_sessions(id),actor_role text NOT NULL CHECK(actor_role IN ('organizer','volunteer')),membership_version integer NOT NULL,
 basis_hash text NOT NULL,content_hash text NOT NULL,encrypted_data text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,project_id,package_id,version),FOREIGN KEY(tenant_id,project_id,package_id) REFERENCES fp_package_operations(tenant_id,project_id,package_id)
);
CREATE TABLE IF NOT EXISTS fp_procurement_responsibilities (
 id text PRIMARY KEY,tenant_id text NOT NULL,project_id text NOT NULL,package_id text NOT NULL,cycle integer NOT NULL CHECK(cycle>0),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 responsible_actor_id text NOT NULL,responsible_session_id text NOT NULL REFERENCES fp_sessions(id),responsible_membership_version integer NOT NULL CHECK(responsible_membership_version>0),
 role text NOT NULL CHECK(role IN ('organizer','volunteer')),authority_hash text NOT NULL,expires_at timestamptz NOT NULL,
 proposed_by text NOT NULL,proposed_session_id text NOT NULL REFERENCES fp_sessions(id),state text NOT NULL CHECK(state IN ('proposed','accepted','declined','withdrawn')),
 encrypted_data text NOT NULL,encrypted_response text,responded_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(project_id,package_id) REFERENCES fp_packages(project_id,id),CHECK(expires_at>created_at)
);
CREATE TABLE IF NOT EXISTS fp_procurement_selections (
 id text PRIMARY KEY,tenant_id text NOT NULL,project_id text NOT NULL,package_id text NOT NULL,cycle integer NOT NULL CHECK(cycle>0),
 quote_id text NOT NULL,quote_version integer NOT NULL,content_hash text NOT NULL,encrypted_data text NOT NULL,
 actor_id text NOT NULL,actor_session_id text NOT NULL REFERENCES fp_sessions(id),actor_role text NOT NULL CHECK(actor_role='organizer'),membership_version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),FOREIGN KEY(quote_id,quote_version) REFERENCES fp_procurement_quote_versions(quote_id,version),FOREIGN KEY(project_id,package_id) REFERENCES fp_packages(project_id,id)
);
CREATE TABLE IF NOT EXISTS fp_procurement_progress (
 id text PRIMARY KEY,tenant_id text NOT NULL,project_id text NOT NULL,package_id text NOT NULL,cycle integer NOT NULL CHECK(cycle>0),
 percent integer CHECK(percent BETWEEN 0 AND 100),observed_at timestamptz NOT NULL,content_hash text NOT NULL,encrypted_data text NOT NULL,
 actor_id text NOT NULL,actor_session_id text NOT NULL REFERENCES fp_sessions(id),actor_role text NOT NULL CHECK(actor_role IN ('organizer','volunteer')),membership_version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),FOREIGN KEY(project_id,package_id) REFERENCES fp_packages(project_id,id),CHECK(observed_at<=created_at+interval '5 minutes')
);
CREATE TABLE IF NOT EXISTS fp_procurement_exceptions (
 id text PRIMARY KEY,tenant_id text NOT NULL,project_id text NOT NULL,package_id text NOT NULL,cycle integer NOT NULL CHECK(cycle>0),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),category text NOT NULL CHECK(category IN ('source','price','currency','supplier','responsibility','prerequisite','funding','physical_evidence','expense','other')),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','resolved')),created_by text NOT NULL,encrypted_data text NOT NULL,resolved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),FOREIGN KEY(project_id,package_id) REFERENCES fp_packages(project_id,id),CHECK((state='resolved')=(resolved_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS fp_procurement_exception_events (
 id text PRIMARY KEY,exception_id text NOT NULL REFERENCES fp_procurement_exceptions(id),tenant_id text NOT NULL,project_id text NOT NULL,version integer NOT NULL,kind text NOT NULL CHECK(kind IN ('opened','resolved')),
 actor_id text NOT NULL,actor_session_id text NOT NULL REFERENCES fp_sessions(id),actor_role text NOT NULL CHECK(actor_role IN ('organizer','volunteer')),membership_version integer NOT NULL,
 encrypted_data text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(exception_id,version)
);
CREATE TABLE IF NOT EXISTS fp_procurement_expense_links (
 id text PRIMARY KEY,tenant_id text NOT NULL,project_id text NOT NULL,package_id text NOT NULL,cycle integer NOT NULL CHECK(cycle>0),
 claim_id text NOT NULL REFERENCES fp_claims(id),claim_version integer NOT NULL CHECK(claim_version>0),content_hash text NOT NULL,encrypted_data text NOT NULL,
 actor_id text NOT NULL,actor_session_id text NOT NULL REFERENCES fp_sessions(id),actor_role text NOT NULL CHECK(actor_role IN ('organizer','volunteer')),membership_version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,project_id,package_id,cycle,claim_id,claim_version),FOREIGN KEY(project_id,package_id) REFERENCES fp_packages(project_id,id)
);
CREATE TABLE IF NOT EXISTS fp_procurement_commands (
 tenant_id text NOT NULL,project_id text NOT NULL,actor_id text NOT NULL,actor_session_id text NOT NULL REFERENCES fp_sessions(id),actor_role text NOT NULL,
 membership_version integer NOT NULL,intent_id text NOT NULL,kind text NOT NULL,input_hash text NOT NULL,encrypted_input text NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,actor_id,intent_id)
);
CREATE TABLE IF NOT EXISTS fp_procurement_audit (
 id text PRIMARY KEY,tenant_id text NOT NULL,project_id text NOT NULL,kind text NOT NULL,resource_id text NOT NULL,resource_version integer NOT NULL,
 actor_id text NOT NULL,actor_session_id text NOT NULL REFERENCES fp_sessions(id),actor_role text NOT NULL,membership_version integer NOT NULL,
 encrypted_data text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS fp_procurement_reviews (
 id text PRIMARY KEY,tenant_id text NOT NULL,project_id text NOT NULL,package_id text NOT NULL,
 review_hash text NOT NULL UNIQUE,content_hash text NOT NULL,encrypted_data text NOT NULL,expires_at timestamptz NOT NULL,
 actor_id text NOT NULL,actor_session_id text NOT NULL REFERENCES fp_sessions(id),actor_role text NOT NULL CHECK(actor_role IN ('organizer','volunteer')),membership_version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK(expires_at>created_at),FOREIGN KEY(project_id,package_id) REFERENCES fp_packages(project_id,id)
);
CREATE TABLE IF NOT EXISTS fp_procurement_invites (
 id text PRIMARY KEY,tenant_id text NOT NULL,project_id text NOT NULL,issuer_actor_id text NOT NULL,issuer_session_id text NOT NULL REFERENCES fp_sessions(id),issuer_membership_version integer NOT NULL CHECK(issuer_membership_version>0),
 issuer_session_expires_at timestamptz NOT NULL,issuer_browser_hash text NOT NULL,role text NOT NULL CHECK(role='volunteer'),token_hash text NOT NULL UNIQUE,encrypted_token text,encrypted_data text NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),state text NOT NULL DEFAULT 'invited' CHECK(state IN ('invited','joined','revoked')),
 expires_at timestamptz NOT NULL,joined_at timestamptz,revoked_at timestamptz,revoked_by text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '7 days' AND expires_at<=issuer_session_expires_at),CHECK((state='revoked')=(revoked_at IS NOT NULL)),CHECK((revoked_at IS NULL)=(revoked_by IS NULL))
);
CREATE TABLE IF NOT EXISTS fp_procurement_access (
 id text PRIMARY KEY,invitation_id text NOT NULL UNIQUE REFERENCES fp_procurement_invites(id),tenant_id text NOT NULL,project_id text NOT NULL,actor_id text NOT NULL,
 session_id text NOT NULL UNIQUE REFERENCES fp_sessions(id),membership_version integer NOT NULL CHECK(membership_version=1),acceptance_intent_id text NOT NULL,acceptance_hash text NOT NULL,browser_hash text NOT NULL,
 encrypted_identity text NOT NULL,encrypted_acceptance text NOT NULL,encrypted_session_token text NOT NULL,return_token_hash text NOT NULL UNIQUE,encrypted_return_token text NOT NULL,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,project_id,actor_id),UNIQUE(browser_hash,acceptance_intent_id)
);
CREATE TABLE IF NOT EXISTS fp_procurement_entry_commands (
 tenant_id text NOT NULL,project_id text NOT NULL,actor_id text NOT NULL,actor_session_id text NOT NULL REFERENCES fp_sessions(id),actor_role text NOT NULL,membership_version integer NOT NULL,
 intent_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('invite','revoke','restore')),browser_hash text NOT NULL,input_hash text NOT NULL,encrypted_input text NOT NULL,result jsonb NOT NULL,encrypted_recovery text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,actor_id,intent_id)
);
CREATE TABLE IF NOT EXISTS fp_procurement_access_audit (
 id text PRIMARY KEY,tenant_id text NOT NULL,project_id text NOT NULL,invitation_id text NOT NULL REFERENCES fp_procurement_invites(id),kind text NOT NULL CHECK(kind IN ('invited','accepted','revoked','restored')),
 actor_id text NOT NULL,actor_session_id text NOT NULL REFERENCES fp_sessions(id),actor_role text NOT NULL,membership_version integer NOT NULL,encrypted_data text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS fp_procurement_supplier_history ON fp_procurement_suppliers(tenant_id,project_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS fp_procurement_quote_history ON fp_procurement_quotes(tenant_id,project_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS fp_package_operations_history ON fp_package_operation_events(tenant_id,project_id,package_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS fp_procurement_responsibility_scope ON fp_procurement_responsibilities(tenant_id,project_id,responsible_actor_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS fp_procurement_invitation_history ON fp_procurement_invites(tenant_id,project_id,created_at DESC,id DESC);

CREATE OR REPLACE FUNCTION fp_procurement_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb:=to_jsonb(NEW); s record; m record; invite record;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM fp_projects p WHERE p.id=r->>'project_id' AND p.tenant_id=r->>'tenant_id') THEN RAISE EXCEPTION 'Procurement project scope mismatch'; END IF;
 IF r ? 'package_id' AND r->>'package_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM fp_packages p WHERE p.project_id=r->>'project_id' AND p.id=r->>'package_id') THEN RAISE EXCEPTION 'Procurement package scope mismatch'; END IF;
 IF r ? 'package_ids' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(r->'package_ids') x WHERE NOT EXISTS(SELECT 1 FROM fp_packages p WHERE p.project_id=r->>'project_id' AND p.id=x.value)) THEN RAISE EXCEPTION 'Procurement quote package scope mismatch'; END IF;
 IF r ? 'supplier_id' AND r->>'supplier_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM fp_procurement_suppliers p WHERE p.id=r->>'supplier_id' AND p.tenant_id=r->>'tenant_id' AND p.project_id=r->>'project_id') THEN RAISE EXCEPTION 'Procurement supplier scope mismatch'; END IF;
 IF r ? 'quote_id' AND r->>'quote_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM fp_procurement_quotes p WHERE p.id=r->>'quote_id' AND p.tenant_id=r->>'tenant_id' AND p.project_id=r->>'project_id') THEN RAISE EXCEPTION 'Procurement quote scope mismatch'; END IF;
 IF r ? 'source_document_id' AND r->>'source_document_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM fp_documents d WHERE d.id=r->>'source_document_id' AND d.tenant_id=r->>'tenant_id' AND d.project_id=r->>'project_id' AND d.purpose='quote') THEN RAISE EXCEPTION 'Procurement source scope mismatch'; END IF;
 IF r ? 'claim_id' AND NOT EXISTS(SELECT 1 FROM fp_claims c WHERE c.id=r->>'claim_id' AND c.tenant_id=r->>'tenant_id' AND c.project_id=r->>'project_id' AND c.version>=(r->>'claim_version')::integer) THEN RAISE EXCEPTION 'Procurement expense scope mismatch'; END IF;
 IF r ? 'exception_id' AND NOT EXISTS(SELECT 1 FROM fp_procurement_exceptions e WHERE e.id=r->>'exception_id' AND e.tenant_id=r->>'tenant_id' AND e.project_id=r->>'project_id') THEN RAISE EXCEPTION 'Procurement exception scope mismatch'; END IF;
 IF TG_OP='INSERT' AND r ? 'actor_session_id' THEN
  SELECT * INTO s FROM fp_sessions WHERE id=r->>'actor_session_id' AND tenant_id=r->>'tenant_id' AND project_id=r->>'project_id' AND actor_id=r->>'actor_id';
  SELECT * INTO m FROM fp_memberships WHERE tenant_id=r->>'tenant_id' AND project_id=r->>'project_id' AND actor_id=r->>'actor_id';
  IF s.id IS NULL OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR s.role<>r->>'actor_role' OR m.actor_id IS NULL OR m.state<>'active' OR m.version<>(r->>'membership_version')::integer OR NOT (m.roles ? (r->>'actor_role')) THEN RAISE EXCEPTION 'Procurement actor authority ended'; END IF;
 END IF;
 IF TG_OP='INSERT' AND r ? 'created_session_id' THEN
  SELECT * INTO s FROM fp_sessions WHERE id=r->>'created_session_id' AND tenant_id=r->>'tenant_id' AND project_id=r->>'project_id' AND actor_id=r->>'created_by';
  SELECT * INTO m FROM fp_memberships WHERE tenant_id=r->>'tenant_id' AND project_id=r->>'project_id' AND actor_id=r->>'created_by';
  IF s.id IS NULL OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR s.role<>r->>'created_role' OR m.actor_id IS NULL OR m.state<>'active' OR m.version<>(r->>'created_membership_version')::integer OR NOT (m.roles ? (r->>'created_role')) THEN RAISE EXCEPTION 'Procurement creator authority ended'; END IF;
 END IF;
 IF TG_TABLE_NAME='fp_package_operations' AND TG_OP='INSERT' AND ((r->>'version')::integer<>0 OR (r->>'cycle')::integer<>1 OR r->>'state'<>'draft') THEN RAISE EXCEPTION 'Procurement operations start with a real draft'; END IF;
 IF TG_TABLE_NAME='fp_package_operation_events' AND NOT EXISTS(SELECT 1 FROM fp_package_operations h WHERE h.tenant_id=r->>'tenant_id' AND h.project_id=r->>'project_id' AND h.package_id=r->>'package_id' AND h.version=(r->>'version')::integer AND h.cycle=(r->>'cycle')::integer) THEN RAISE EXCEPTION 'Procurement history must match its exact current head'; END IF;
 IF TG_TABLE_NAME='fp_procurement_responsibilities' AND NOT EXISTS(SELECT 1 FROM fp_sessions t WHERE t.id=r->>'responsible_session_id' AND t.tenant_id=r->>'tenant_id' AND t.project_id=r->>'project_id' AND t.actor_id=r->>'responsible_actor_id') THEN RAISE EXCEPTION 'Procurement responsibility scope mismatch'; END IF;
 IF TG_TABLE_NAME='fp_procurement_invites' AND TG_OP='INSERT' THEN
  SELECT * INTO s FROM fp_sessions WHERE id=NEW.issuer_session_id AND tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND actor_id=NEW.issuer_actor_id;
  SELECT * INTO m FROM fp_memberships WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND actor_id=NEW.issuer_actor_id;
  IF NEW.state<>'invited' OR s.id IS NULL OR s.role<>'organizer' OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR s.expires_at<>NEW.issuer_session_expires_at OR m.actor_id IS NULL OR m.state<>'active' OR m.version<>NEW.issuer_membership_version OR NOT (m.roles ? 'organizer') THEN RAISE EXCEPTION 'A current original organizer must issue volunteer authority'; END IF;
 END IF;
 IF TG_TABLE_NAME='fp_procurement_access' AND TG_OP='INSERT' THEN
  SELECT * INTO invite FROM fp_procurement_invites WHERE id=NEW.invitation_id AND tenant_id=NEW.tenant_id AND project_id=NEW.project_id;
  SELECT * INTO s FROM fp_sessions WHERE id=NEW.session_id AND tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND actor_id=NEW.actor_id;
  SELECT * INTO m FROM fp_memberships WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND actor_id=NEW.actor_id;
  IF invite.id IS NULL OR invite.state='revoked' OR NEW.actor_id=invite.issuer_actor_id OR s.id IS NULL OR s.role<>'volunteer' OR s.revoked_at IS NOT NULL OR s.expires_at<>invite.expires_at OR NEW.expires_at<>invite.expires_at OR NEW.expires_at<=clock_timestamp() OR m.actor_id IS NULL OR m.state<>'active' OR m.version<>1 OR m.roles<>'["volunteer"]'::jsonb THEN RAISE EXCEPTION 'Volunteer acceptance grants only the exact original volunteer session'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION fp_procurement_retained_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Procurement source and decision history is immutable'; END $$;
CREATE OR REPLACE FUNCTION fp_procurement_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-string_to_array(TG_ARGV[0],',')) IS DISTINCT FROM (to_jsonb(OLD)-string_to_array(TG_ARGV[0],',')) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Procurement head terms are scoped and versions advance exactly once'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION fp_procurement_operations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.cycle=OLD.cycle AND NEW.cycle_started_at IS DISTINCT FROM OLD.cycle_started_at THEN RAISE EXCEPTION 'An existing operational cycle cutoff is immutable'; END IF;
 IF NEW.state=OLD.state THEN IF NEW.cycle<>OLD.cycle OR NEW.blocked_from IS DISTINCT FROM OLD.blocked_from THEN RAISE EXCEPTION 'Operational cycles change only through explicit reopen'; END IF; RETURN NEW; END IF;
 IF NEW.state='reopened' THEN IF OLD.state NOT IN ('accepted','canceled') OR NEW.cycle<>OLD.cycle+1 OR NEW.blocked_from IS NOT NULL OR NEW.cycle_started_at<=OLD.cycle_started_at THEN RAISE EXCEPTION 'Explicit reopen starts exactly the next operational cycle'; END IF; RETURN NEW; END IF;
 IF NEW.cycle<>OLD.cycle THEN RAISE EXCEPTION 'A transition cannot rewrite an earlier operational cycle'; END IF;
 IF NEW.state='blocked' THEN IF OLD.state IN ('accepted','canceled') OR NEW.blocked_from<>OLD.state THEN RAISE EXCEPTION 'An operational block retains its exact prior step'; END IF; RETURN NEW; END IF;
 IF OLD.state='blocked' THEN IF NEW.state NOT IN ('draft','canceled') AND NEW.state<>OLD.blocked_from THEN RAISE EXCEPTION 'A block cannot skip operational review'; END IF; RETURN NEW; END IF;
 IF NEW.state='canceled' THEN RETURN NEW; END IF;
 IF NOT ((OLD.state='draft' AND NEW.state='approved') OR (OLD.state='approved' AND NEW.state IN ('draft','procurement_ready')) OR (OLD.state='procurement_ready' AND NEW.state='in_progress') OR (OLD.state='in_progress' AND NEW.state='review_pending') OR (OLD.state='review_pending' AND NEW.state IN ('in_progress','accepted')) OR (OLD.state='reopened' AND NEW.state IN ('draft','approved'))) THEN RAISE EXCEPTION 'Invalid operational transition'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION fp_procurement_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.version>0 AND NOT EXISTS(SELECT 1 FROM fp_package_operation_events e WHERE e.tenant_id=NEW.tenant_id AND e.project_id=NEW.project_id AND e.package_id=NEW.package_id AND e.version=NEW.version AND e.cycle=NEW.cycle) THEN RAISE EXCEPTION 'Each operational change requires immutable exact-version history'; END IF; RETURN NEW; END $$;
CREATE OR REPLACE FUNCTION fp_procurement_invite_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['version','state','joined_at','revoked_at','revoked_by','encrypted_token']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['version','state','joined_at','revoked_at','revoked_by','encrypted_token']) OR NEW.version<>OLD.version+1 OR OLD.state='revoked' OR NEW.state='invited' OR (OLD.state='joined' AND NEW.state<>'revoked') OR (OLD.joined_at IS NOT NULL AND NEW.joined_at IS DISTINCT FROM OLD.joined_at) OR NEW.encrypted_token IS NOT NULL THEN RAISE EXCEPTION 'Volunteer invitation authority, role and fixed deadline are immutable'; END IF;
 RETURN NEW;
END $$;
${PROCUREMENT_TABLES.map(table => `DROP TRIGGER IF EXISTS ${table}_scope ON ${table}; CREATE TRIGGER ${table}_scope BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION fp_procurement_scope_guard();`).join("\n")}
${retained.map(table => `DROP TRIGGER IF EXISTS ${table}_retained ON ${table}; CREATE TRIGGER ${table}_retained BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION fp_procurement_retained_guard();`).join("\n")}
${Object.entries(mutable).map(([table, columns]) => `DROP TRIGGER IF EXISTS ${table}_head ON ${table}; CREATE TRIGGER ${table}_head BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION fp_procurement_head_guard('${columns}');`).join("\n")}
DROP TRIGGER IF EXISTS fp_package_operations_transition ON fp_package_operations; CREATE TRIGGER fp_package_operations_transition BEFORE UPDATE ON fp_package_operations FOR EACH ROW EXECUTE FUNCTION fp_procurement_operations_guard();
DROP TRIGGER IF EXISTS fp_package_operations_history ON fp_package_operations; CREATE CONSTRAINT TRIGGER fp_package_operations_history AFTER INSERT OR UPDATE ON fp_package_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fp_procurement_history_guard();
DROP TRIGGER IF EXISTS fp_procurement_invites_contract ON fp_procurement_invites; CREATE TRIGGER fp_procurement_invites_contract BEFORE UPDATE OR DELETE ON fp_procurement_invites FOR EACH ROW EXECUTE FUNCTION fp_procurement_invite_guard();
`;
