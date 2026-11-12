/** Synthetic in-memory seam for the owned-read tests only. No PostgreSQL,
 * materialization, initialization, real session or provider state is created. */
import "./toolkit-deny-network.mjs";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Session } from "../../lib/server/auth";
import type { SettlementReceipt } from "../../lib/contracts";
import type { StudioSnapshot } from "../../lib/studio/contracts";
import { DomainError } from "../../lib/domain/money";

type ControlledRecord = { session: Session; receipt: SettlementReceipt; order: string; obligation: string; owner: string; createdAt: number;
  membership: { state: string; roles: string[]; version: number }; snapshot: StudioSnapshot };
const records: ControlledRecord[] = [], key = "fieldproof-toolkit-controlled-authority-v1";
const root = fileURLToPath(new URL("../../", import.meta.url));
const fail = () => { throw new Error("TOOLKIT_TEST_DATABASE_FORBIDDEN"); };
const store = {
  fail,
  async query(sql: string, values: unknown[] = []): Promise<unknown[]> {
    if (sql.startsWith("SELECT id FROM fp_sessions WHERE id=$1")) return records.filter(row =>
      [row.session.id, row.session.tenantId, row.session.projectId, row.session.actorId, row.session.role].every((item, i) => item === values[i])
      && Date.parse(row.session.expiresAt) > Date.now()).map(row => ({ id: row.session.id }));
    if (sql.startsWith("SELECT version,roles,state FROM fp_memberships WHERE")) return records.filter(row =>
      [row.session.tenantId, row.session.projectId, row.session.actorId].every((item, i) => item === values[i])).map(row => row.membership);
    if (sql.startsWith("SELECT r.data,o.actor_id FROM fp_settlement_receipts r JOIN fp_obligations o")) return records.filter(row =>
      [row.receipt.id, row.session.tenantId, row.session.projectId].every((item, i) => item === values[i])
      && Math.floor(row.createdAt) <= Date.parse(String(values[3]))).map(row => ({ data: structuredClone(row.receipt), actor_id: row.owner }));
    if (sql.startsWith("SELECT order_id FROM fp_provider_orders WHERE")) return records.filter(row =>
      [row.order, row.session.tenantId, row.session.projectId, row.obligation].every((item, i) => item === values[i])).map(row => ({ order_id: row.order }));
    if (sql.startsWith("SELECT id FROM fp_recovery_invoices WHERE")) return [];
    return fail();
  },
  dataset(session: Session, id: string, membershipVersion: number) {
    const row = records.find(item => item.snapshot.datasetHandle === id && item.session.id === session.id && item.session.actorId === session.actorId
      && item.session.tenantId === session.tenantId && item.session.projectId === session.projectId && item.session.role === session.role && membershipVersion === 1);
    if (!row) throw new DomainError("STUDIO_DATASET_EXPIRED", "The controlled report is unavailable.", 409);
    return structuredClone(row.snapshot);
  },
};
(globalThis as unknown as { [key: string]: unknown })[key] = store;
const forbiddenExports = ["studioScope", "assertStudioProjection", "readStudioSnapshot", "readStudioSnapshotWithin", "materializeStudioDataset"].map(name => `export const ${name}=store.fail;`).join("\n");
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith("file:") && (specifier.startsWith(".") || specifier.startsWith("file:"))) {
      const url = new URL(specifier, context.parentURL);
      if ([`${root}lib/server/db`, `${root}lib/server/db.ts`].includes(fileURLToPath(url))) return { url: "fieldproof-toolkit-control:db", shortCircuit: true };
      if ([`${root}lib/server/studio-datasets`, `${root}lib/server/studio-datasets.ts`].includes(fileURLToPath(url))) return { url: "fieldproof-toolkit-control:dataset", shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const prefix = `const store=globalThis[${JSON.stringify(key)}];`;
    if (url === "fieldproof-toolkit-control:db") return { format: "module", shortCircuit: true, source: `${prefix}
      export const query=store.query.bind(store); export const database=()=>({query:async(sql,values)=>({rows:await store.query(sql,values)}),transaction:store.fail,close:store.fail});
      export const initializeDatabase=store.fail; export const initializeDatabaseAt=store.fail;` };
    if (url === "fieldproof-toolkit-control:dataset") return { format: "module", shortCircuit: true, source: `${prefix}
      import {requireCurrentRole} from ${JSON.stringify(new URL("../../lib/server/membership.ts", import.meta.url).href)};
      export async function requireStudioDataset(session,id){const {membershipVersion}=await requireCurrentRole(session,session.role);return store.dataset(session,id,membershipVersion);}
      ${forbiddenExports}` };
    return next(url, context);
  },
});

export function controlledToolkitFixture(role: Session["role"] = "organizer", mode: Session["mode"] = "live_sandbox") {
  const session: Session = { id: randomUUID(), tenantId: randomUUID(), projectId: randomUUID(), actorId: randomUUID(), role, mode, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  const obligation = randomUUID(), order = "5O190127TN364715T", receipt: SettlementReceipt = {
    id: randomUUID(), tenantId: session.tenantId, projectId: session.projectId, packageId: "electronics", donorObligationId: obligation,
    sourceKind: "orders_capture", provenance: mode, actualProviderPaymentRef: "CONTROLLED-CAPTURE-1", economicAliases: ["controlled:capture"], sourceOrderId: order, sourceInvoiceId: null,
    authoritativeObservedState: "COMPLETED", observedAt: new Date().toISOString(), currency: "USD", grossSettledMinor: 3500, creditedMinor: 3500,
    completedAttributedRefundMinor: 0, pendingAttributedRefundReserveMinor: 0, excludedMinor: 0, excessLiabilityMinor: 0, provenRefundableRef: null, refundAdapter: "unqualified",
  };
  const snapshot = { datasetHandle: randomUUID(), role, mode, scope: randomUUID(), asOf: new Date().toISOString(), data: { settlements: [{ id: receipt.id }] } } as unknown as StudioSnapshot;
  const record: ControlledRecord = { session, receipt, order, obligation, owner: session.actorId, createdAt: Date.parse(snapshot.asOf),
    membership: { roles: ["organizer", "auditor", "donor", "volunteer"], state: "active", version: 1 }, snapshot };
  records.push(record); return record;
}
export function resetControlledToolkitAuthority() { records.length = 0; }
