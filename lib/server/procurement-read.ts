import type { SqlConnection } from "@fracture/paypal-core";
import type { PlanSourceBinding } from "../planning/contracts";
import type { ProcurementRole } from "../procurement/contracts";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { database, query } from "./db";
import { currentSourceCheck } from "./planning-store";
import { procurementAuthority, expectProcurementScope, type ProcurementAuthority } from "./procurement-store";

export interface ProcurementDisclosure<T> { value: T; bindings: PlanSourceBinding[]; }
/** The immutable observation and the final disclosure check are deliberately
 * separate snapshots. A first source-control insertion after the original read
 * must be visible before any private serialized value or image leaves. */
export async function procurementRead<T>(session: Session, expectedScope: string | undefined, roles: ProcurementRole[], work: (tx: SqlConnection, authority: ProcurementAuthority) => Promise<ProcurementDisclosure<T>>): Promise<T> {
  const result = await database().transaction(async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const authority = await procurementAuthority(session, tx, roles);
    if (expectedScope) expectProcurementScope(authority, expectedScope);
    const output = await work(tx, authority);
    // Materialize getters/JSON failures before the final current check.
    JSON.stringify(output.value);
    return { ...output, scope: authority.scope };
  });
  await database().transaction(async tx => {
    const authority = await procurementAuthority(session, tx, roles, true);
    expectProcurementScope(authority, expectedScope ?? result.scope);
    const ids = [...new Set(result.bindings.map(row => row.documentId))].sort();
    if (ids.length) {
      await query("SELECT id FROM fp_documents WHERE tenant_id=$1 AND project_id=$2 AND id=ANY($3::text[]) ORDER BY id FOR SHARE", [session.tenantId, session.projectId, ids], tx);
      await query("SELECT document_id FROM fp_plan_source_controls WHERE tenant_id=$1 AND project_id=$2 AND document_id=ANY($3::text[]) ORDER BY document_id FOR SHARE", [session.tenantId, session.projectId, ids], tx);
    }
    for (const binding of result.bindings) {
      if ((await currentSourceCheck(session, [binding], tx)).length) throw new DomainError("PROCUREMENT_SOURCE_WITHDRAWN", "Permission or the exact source changed while this view was being prepared. Reload to retain only its permitted history.", 410);
    }
    expectProcurementScope(await procurementAuthority(session, tx, roles), result.scope);
  });
  return result.value;
}
