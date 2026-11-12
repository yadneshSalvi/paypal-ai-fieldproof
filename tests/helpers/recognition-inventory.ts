import { canonicalJson, sha256 } from "@fracture/paypal-core";
import { query } from "../../lib/server/db";

/** Logical rows/catalog only in the runner's sole schema, never other tenants. */
export async function recognitionNamespaceDigest() {
  const [scope] = await query<{ schema: string; paths: string[] }>("SELECT current_schema() schema,current_schemas(false)::text[] paths");
  if (!/^recognition_test_[a-f0-9]{32}$/.test(scope.schema) || scope.paths.length !== 1 || scope.paths[0] !== scope.schema) throw new Error("Inventory requires the exact isolated schema.");
  const tables = await query<{ name: string }>("SELECT c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r' ORDER BY c.relname");
  const rows: unknown[] = [];
  for (const table of tables) {
    if (!/^[a-z][a-z0-9_]+$/.test(table.name)) throw new Error("Unexpected isolated table identifier.");
    rows.push([table.name, (await query<{ rows: unknown }>(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) rows FROM "${table.name}" t`))[0].rows]);
  }
  const constraints = await query("SELECT c.relname,con.conname,pg_get_constraintdef(con.oid) definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() ORDER BY c.relname,con.conname");
  const triggers = await query("SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND NOT t.tgisinternal ORDER BY c.relname,t.tgname");
  const functions = await query("SELECT p.proname,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() ORDER BY p.proname,p.oid");
  const columns = await query("SELECT table_name,column_name,ordinal_position,data_type,column_default,is_nullable FROM information_schema.columns WHERE table_schema=current_schema() ORDER BY table_name,ordinal_position");
  const indexes = await query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() ORDER BY tablename,indexname");
  return { rows: sha256(canonicalJson(rows)), catalog: sha256(canonicalJson({ constraints, triggers, functions, columns, indexes })), tables: tables.length };
}
