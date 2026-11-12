import type { SqlConnection } from "@fracture/paypal-core";
import { canonical, digest, identifier, requireOperation, type Catalog, type NamespaceIdentity, type SequenceState, type TableRows } from "./contracts";

/** One catalog round trip, independent of the number of covered tables. OIDs,
 * generated RI trigger names and physical schema names are not portable identity. */
export async function readCatalog(tx: SqlConnection): Promise<Catalog> {
  const result = await tx.query<{ catalog: Catalog; namespace: string }>(`
    WITH ns AS (SELECT oid,nspname FROM pg_namespace WHERE nspname=current_schema()),
    relations AS (SELECT c.* FROM pg_class c JOIN ns ON c.relnamespace=ns.oid WHERE c.relkind IN ('r','p'))
    SELECT current_schema() namespace,jsonb_build_object('format',1,
      'postgresMajor',current_setting('server_version_num')::int/10000,
      'tables',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name',c.relname,'kind',c.relkind,'persistence',c.relpersistence,'rowSecurity',c.relrowsecurity,
        'forceRowSecurity',c.relforcerowsecurity,'replicaIdentity',c.relreplident,
        'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
          'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,
          'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE (SELECT collname FROM pg_collation WHERE oid=a.attcollation) END) ORDER BY a.attnum)
          FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
          WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
        'keys',COALESCE((SELECT jsonb_agg(a.attname ORDER BY k.ordinality) FROM pg_constraint p
          CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY k(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=p.conrelid AND a.attnum=k.attnum
          WHERE p.conrelid=c.oid AND p.contype='p'),'[]'::jsonb),
        'foreignKeys',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',f.conname,
          'columns',(SELECT jsonb_agg(a.attname ORDER BY k.ordinality) FROM unnest(f.conkey) WITH ORDINALITY k(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=k.attnum),
          'target',CASE WHEN target.relnamespace=c.relnamespace THEN target.relname ELSE target.oid::regclass::text END,
          'targetColumns',(SELECT jsonb_agg(a.attname ORDER BY k.ordinality) FROM unnest(f.confkey) WITH ORDINALITY k(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=f.confrelid AND a.attnum=k.attnum),
          'deferred',f.condeferrable,'initiallyDeferred',f.condeferred,'definition',pg_get_constraintdef(f.oid,true)) ORDER BY f.conname)
          FROM pg_constraint f JOIN pg_class target ON target.oid=f.confrelid WHERE f.conrelid=c.oid AND f.contype='f'),'[]'::jsonb),
        'constraints',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',p.conname,'type',p.contype,'validated',p.convalidated,'deferred',p.condeferrable,
          'initiallyDeferred',p.condeferred,'definition',pg_get_constraintdef(p.oid,true)) ORDER BY p.conname) FROM pg_constraint p WHERE p.conrelid=c.oid),'[]'::jsonb),
        'indexes',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',i.relname,'definition',pg_get_indexdef(x.indexrelid),
          'valid',x.indisvalid,'ready',x.indisready,'unique',x.indisunique,'primary',x.indisprimary) ORDER BY i.relname)
          FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid),'[]'::jsonb),
        'triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',CASE WHEN t.tgisinternal THEN NULL ELSE t.tgname END,
          'internal',t.tgisinternal,'enabled',t.tgenabled,'type',t.tgtype,'function',p.proname,
          'constraint',con.conname,'deferrable',t.tgdeferrable,'initiallyDeferred',t.tginitdeferred,
          'definition',CASE WHEN t.tgisinternal THEN NULL ELSE pg_get_triggerdef(t.oid,true) END)
          ORDER BY t.tgisinternal,t.tgname COLLATE "C") FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
          LEFT JOIN pg_constraint con ON con.oid=t.tgconstraint WHERE t.tgrelid=c.oid),'[]'::jsonb)
      ) ORDER BY c.relname COLLATE "C") FROM relations c),'[]'::jsonb),
      'functions',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),
        'definition',pg_get_functiondef(p.oid),'securityDefiner',p.prosecdef,'config',p.proconfig) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid))
        FROM pg_proc p JOIN ns ON ns.oid=p.pronamespace),'[]'::jsonb),
      'sequences',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',c.relname,'type',format_type(s.seqtypid,NULL),
        'start',s.seqstart::text,'increment',s.seqincrement::text,'min',s.seqmin::text,'max',s.seqmax::text,'cache',s.seqcache::text,'cycle',s.seqcycle,
        'table',parent.relname,'column',a.attname) ORDER BY c.relname)
        FROM pg_class c JOIN ns ON c.relnamespace=ns.oid JOIN pg_sequence s ON s.seqrelid=c.oid
        LEFT JOIN pg_depend d ON d.objid=c.oid AND d.deptype IN ('a','i') AND d.classid='pg_class'::regclass
        LEFT JOIN pg_class parent ON parent.oid=d.refobjid LEFT JOIN pg_attribute a ON a.attrelid=parent.oid AND a.attnum=d.refobjsubid),'[]'::jsonb),
      'extraRelations',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind) ORDER BY c.relname)
        FROM pg_class c JOIN ns ON c.relnamespace=ns.oid WHERE c.relkind NOT IN ('r','p','S','i','I','t')),'[]'::jsonb),
      'extraTypes',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',t.typname,'kind',t.typtype) ORDER BY t.typname)
        FROM pg_type t JOIN ns ON t.typnamespace=ns.oid WHERE t.typtype IN ('d','e','r','m')),'[]'::jsonb)
    ) catalog`);
  requireOperation(result.rows.length === 1 && !!result.rows[0].namespace, "UNSUPPORTED_COVERAGE", "The explicit namespace does not have an initialized current catalog.");
  const { namespace } = result.rows[0];
  const catalog = JSON.parse(JSON.stringify(result.rows[0].catalog).replaceAll(`${namespace}.`, "__namespace__.").replaceAll(`\\\"${namespace}\\\".`, "__namespace__.")) as Catalog;
  // Internal RI names contain allocation OIDs; compare the full guard attributes instead.
  for (const table of catalog.tables) table.triggers.sort((a,b) => canonical(a).localeCompare(canonical(b), "en"));
  return catalog;
}

export async function readIdentity(tx: SqlConnection, endpoint: { endpoint: string; schema: string }, restricted: boolean): Promise<NamespaceIdentity> {
  identifier(endpoint.schema);
  const row = (await tx.query<{ database: string; namespace: string; role: string; paths: string[]; superuser: boolean; createRole: boolean; createDb: boolean; replication: boolean; bypass: boolean; ownsSchema: boolean; publicAccess: boolean; otherAccess: boolean }>(`
    SELECT current_database() database,current_schema() namespace,current_user role,current_schemas(false)::text[] paths,
      r.rolsuper superuser,r.rolcreaterole "createRole",r.rolcreatedb "createDb",r.rolreplication replication,r.rolbypassrls bypass,
      n.nspowner=r.oid "ownsSchema",EXISTS(SELECT 1 FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) acl WHERE acl.grantee=0) "publicAccess",
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) acl WHERE acl.grantee<>n.nspowner) "otherAccess"
    FROM pg_roles r JOIN pg_namespace n ON n.nspname=current_schema() WHERE r.rolname=current_user`)).rows[0];
  requireOperation(row && row.namespace === endpoint.schema && canonical(row.paths) === canonical([endpoint.schema]), "INVALID_CONFIGURATION", "Each connection must use its explicit sole namespace search_path.");
  const privileges = { superuser: row.superuser, createRole: row.createRole, createDb: row.createDb, replication: row.replication, bypass: row.bypass, ownsSchema: row.ownsSchema, publicAccess: row.publicAccess, otherAccess: row.otherAccess };
  if (restricted) requireOperation(!/^pg_|^public$|^information_schema$/.test(row.namespace) && !row.superuser && !row.createRole && !row.createDb && !row.replication && !row.bypass && row.ownsSchema && !row.publicAccess && !row.otherAccess, "DESTINATION_NOT_RESTRICTED", "The fresh destination requires a dedicated private namespace owned only by a restricted role.");
  return { database: row.database, schema: row.namespace, role: row.role, endpoint: endpoint.endpoint, restrictionHash: digest(privileges) };
}

export async function readRows(tx: SqlConnection, catalog: Catalog, maxRows = 250_000, maxBytes = 128 * 1024 * 1024): Promise<TableRows[]> {
  const sql = catalog.tables.map(table => {
    const decimals = table.columns.filter(column => /^(?:bigint|numeric|decimal)(?:\(|$)/.test(column.type));
    const lossless = decimals.length ? ` || jsonb_build_object(${decimals.map(column => `'${column.name}',t.${identifier(column.name)}::text`).join(",")})` : "";
    return `SELECT '${table.name}' AS name,(to_jsonb(t)${lossless})::text AS document FROM ${identifier(table.name)} t`;
  }).join(" UNION ALL ");
  const result = await tx.query<{ name: string; document: string }>(`SELECT name,document FROM (${sql}) all_rows ORDER BY name COLLATE "C",document COLLATE "C" LIMIT $1`, [maxRows + 1]);
  requireOperation(result.rows.length <= maxRows, "UNSUPPORTED_COVERAGE", "This namespace exceeds the reviewed bounded transfer size; no rows were omitted.");
  let bytes = 0;
  const grouped = new Map(catalog.tables.map(table => [table.name, [] as string[]]));
  for (const row of result.rows) { bytes += Buffer.byteLength(row.document); grouped.get(row.name)!.push(row.document); }
  requireOperation(bytes <= maxBytes, "UNSUPPORTED_COVERAGE", "This namespace exceeds the reviewed private bundle size; no rows were omitted.");
  return catalog.tables.map(table => { const rows = grouped.get(table.name)!; return { name: table.name, rows, count: rows.length, hash: digest(rows) }; });
}

export async function readSequences(tx: SqlConnection, catalog: Catalog): Promise<SequenceState[]> {
  if (!catalog.sequences.length) return [];
  const query = catalog.sequences.map(sequence => `SELECT '${sequence.name}' name,last_value::text AS "lastValue",is_called AS "isCalled" FROM ${identifier(String(sequence.name))}`).join(" UNION ALL ");
  return (await tx.query<SequenceState & Record<string, unknown>>(`SELECT * FROM (${query}) sequences ORDER BY name COLLATE "C"`)).rows;
}
