import { canonical, digest, exactKeys, requireOperation, type Catalog, type Row, type TableRows } from "./contracts";
import { CURRENT_TABLES, TABLE_BY_NAME } from "./current-registry";

export type OriginalRows = Map<string, Row[]>;
export function keyValues(table: string, row: Row): unknown[] { return TABLE_BY_NAME.get(table)!.keys.map(key => row[key]); }
export function keyHash(table: string, row: Row): string { return digest([table, keyValues(table, row)]); }
export function originalRows(tables: readonly TableRows[], catalog: Catalog): OriginalRows {
  requireOperation(tables.length === CURRENT_TABLES.length && canonical(tables.map(table => table.name).sort()) === canonical(CURRENT_TABLES.map(table => table.name).sort()), "UNSUPPORTED_COVERAGE", "The bundle must contain every current table exactly once, including empty tables.");
  const result: OriginalRows = new Map();
  for (const table of tables) {
    const definition = catalog.tables.find(item => item.name === table.name)!;
    exactKeys(table, ["name", "rows", "count", "hash"]);
    requireOperation(Array.isArray(table.rows) && table.count === table.rows.length && table.hash === digest(table.rows), "INVALID_BUNDLE", "An original table count or row digest has changed.");
    const keys = new Set<string>();
    result.set(table.name, table.rows.map(text => {
      requireOperation(typeof text === "string", "INVALID_BUNDLE", "Original rows must retain their lossless PostgreSQL representation.");
      let row: unknown; try { row = JSON.parse(text); } catch { row = null; }
      exactKeys(row, definition.columns.map(column => column.name));
      const values = keyValues(table.name, row), encodedKey = canonical(values);
      requireOperation(values.every(value => value !== null && value !== undefined) && !keys.has(encodedKey), "PRIVATE_LINEAGE", "An original row has a missing or duplicate immutable key.");
      keys.add(encodedKey); return row;
    }));
  }
  return result;
}
export function findOriginal(rows: OriginalRows, table: string, matches: Row): Row {
  const found = rows.get(table)!.find(row => Object.entries(matches).every(([key, value]) => row[key] === value));
  requireOperation(found, "PRIVATE_LINEAGE", "An original source dependency is missing or crosses an identity boundary.");
  return found;
}
/** Verify the complete FK graph before touching a destination, including deferred
 * edges and the few historic relationships encoded by the application. */
export function assertOriginalLineage(rows: OriginalRows, catalog: Catalog): void {
  const indexes = new Map<string, Set<string>>();
  for (const table of catalog.tables) for (const fk of table.foreignKeys) {
    const index = `${fk.target}:${fk.targetColumns.join(",")}`;
    if (!indexes.has(index)) indexes.set(index, new Set(rows.get(fk.target)!.map(row => canonical(fk.targetColumns.map(key => row[key])))));
    for (const row of rows.get(table.name)!) {
      const values = fk.columns.map(column => row[column]);
      if (values.some(value => value === null)) continue; // Current catalog uses MATCH SIMPLE.
      requireOperation(indexes.get(index)!.has(canonical(values)), "PRIVATE_LINEAGE", "An original foreign-key dependency is absent from this whole-namespace bundle.");
    }
  }
  for (const [table, items] of rows) for (const row of items) {
    if (typeof row.tenant_id === "string" && typeof row.project_id === "string" && table !== "fp_workspace_imports" && table !== "fp_transfer_webhook_archive")
      findOriginal(rows, "fp_projects", { id: row.project_id, tenant_id: row.tenant_id });
  }
  for (const row of rows.get("fp_org_sessions")!) {
    const member = findOriginal(rows, "fp_org_memberships", { id: row.membership_id, organization_id: row.organization_id });
    requireOperation(typeof row.expires_at === "string" && typeof member.expires_at === "string" && timestampMicros(row.expires_at) <= timestampMicros(member.expires_at), "PRIVATE_LINEAGE", "An original organization session exceeds its exact membership deadline.");
  }
  for (const row of rows.get("fp_org_access")!) {
    const session = findOriginal(rows, "fp_org_sessions", { id: row.session_id, organization_id: row.organization_id, membership_id: row.membership_id });
    requireOperation(timestampMicros(String(row.expires_at)) <= timestampMicros(String(session.expires_at)), "PRIVATE_LINEAGE", "An original organization access record exceeds its exact session deadline.");
  }
  for (const row of rows.get("fp_project_policy_adoptions")!) {
    findOriginal(rows, "fp_sessions", { id: row.project_session_id, tenant_id: row.tenant_id, project_id: row.project_id, actor_id: row.project_actor_id });
    if (row.origin === "project_revision") findOriginal(rows, "fp_project_policy_adoptions", { id: row.parent_adoption_id, tenant_id: row.tenant_id, project_id: row.project_id, link_id: row.link_id });
  }
  for (const row of rows.get("paycore_attempts")!) findOriginal(rows, "paycore_operations", { id: row.operation_id, tenant_id: row.tenant_id, project_id: row.project_id });
  for (const row of rows.get("paycore_webhook_deliveries")!) findOriginal(rows, "paycore_webhook_events", { event_id: row.event_id, tenant_id: row.tenant_id, project_id: row.project_id });
  for (const row of rows.get("fp_workspace_switch_events")!) {
    const session = findOriginal(rows, "fp_sessions", { id: row.to_session_id });
    findOriginal(rows, "fp_workspace_library_entries", { library_id: row.library_id, session_id: session.id });
    if (row.from_session_id !== null) findOriginal(rows, "fp_sessions", { id: row.from_session_id });
  }
}
/** Original timestamp comparisons retain six digits, while wall clocks are used
 * only for current drain checks. No deadline is rounded or renewed. */
export function timestampMicros(value: string): bigint {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(value);
  requireOperation(match && Number.isFinite(Date.parse(`${match[1]}Z`)), "PRIVATE_LINEAGE", "An original deadline has an unsupported timestamp encoding.");
  return BigInt(Date.parse(`${match[1]}Z`)) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
export function insertionOrder(catalog: Catalog, rows: OriginalRows): { table: string; rows: Row[] }[] {
  const remaining = new Map(catalog.tables.map(table => [table.name, table]));
  const ordered: { table: string; rows: Row[] }[] = [], done = new Set<string>();
  while (remaining.size) {
    const ready = [...remaining.values()].filter(table => table.foreignKeys.every(fk => fk.deferred || fk.target === table.name || done.has(fk.target)));
    requireOperation(ready.length, "UNSUPPORTED_COVERAGE", "The current insertion graph contains an unsupported immediate dependency cycle.");
    for (const table of ready) {
      // Immediate self-references (history supersedes/parent pointers) must be
      // inserted in original dependency order, not by observed creation time.
      const pending = [...rows.get(table.name)!], written: Row[] = [];
      const self = table.foreignKeys.filter(fk => !fk.deferred && fk.target === table.name);
      while (pending.length) {
        const index = pending.findIndex(row => self.every(fk => fk.columns.some(column => row[column] === null) || written.some(parent => fk.targetColumns.every((column, i) => parent[column] === row[fk.columns[i]]))));
        requireOperation(index >= 0, "PRIVATE_LINEAGE", "An original self-reference is missing or cyclic.");
        written.push(pending.splice(index, 1)[0]);
      }
      ordered.push({ table: table.name, rows: written }); done.add(table.name); remaining.delete(table.name);
    }
  }
  return ordered;
}
