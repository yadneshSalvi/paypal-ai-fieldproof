import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SettlementReceipt } from "../lib/contracts";
import { cancellationPosition, type CancellationSource } from "../lib/domain/cancellation-position";

const scope = { tenantId: "tenant", projectId: "project", packageId: "electronics", provenance: "sample" as const };
function source(id: string, amount = 10000): CancellationSource {
  const receipt: SettlementReceipt = { id, ...scope, donorObligationId: `obligation-${id}`, sourceKind: "orders_capture", actualProviderPaymentRef: `capture-${id}`, economicAliases: [`capture:${id}`], sourceOrderId: `order-${id}`, sourceInvoiceId: null, authoritativeObservedState: "COMPLETED", observedAt: "2026-11-11T10:00:00Z", currency: "USD", grossSettledMinor: amount, creditedMinor: amount, completedAttributedRefundMinor: 0, pendingAttributedRefundReserveMinor: 0, excludedMinor: 0, excessLiabilityMinor: 0, provenRefundableRef: `capture-${id}`, refundAdapter: "capture_refund" };
  return { receipt, version: 1, reservedMinor: 0, paidMinor: 0 };
}
describe("cancellation position from saved canonical receipts", () => {
  it("includes both rails, paid fees and reserved fees without presenting their money as unspent", () => {
    const a=source("orders",92500), b=source("invoice",3500);
    b.receipt.sourceKind="invoice_payment"; b.receipt.sourceInvoiceId="invoice-id";
    a.paidMinor=6625; a.reservedMinor=1975;
    const result=cancellationPosition([b,a],scope);
    assert.equal(result.creditedMinor,96000); assert.equal(result.uncommittedMinor,87400);
    assert.equal(result.hasCommittedUses,true); assert.equal(result.sources.length,2);
    assert.equal(result.paidMinor,6625); assert.equal(result.reservedMinor,1975);
  });
  it("keeps refunds, pending reserves and spending exclusions distinct", () => {
    const a=source("a"); a.receipt.completedAttributedRefundMinor=1000; a.receipt.pendingAttributedRefundReserveMinor=2000; a.receipt.excludedMinor=7000;
    const result=cancellationPosition([a],scope);
    assert.equal(result.uncommittedMinor,7000); assert.equal(result.excludedMinor,7000); assert.equal(result.pendingRefundMinor,2000); assert.equal(result.refundedMinor,1000); assert.equal(result.hasCommittedUses,false);
  });
  it("retains unproven invoice refund routes as unresolved rather than calling bookkeeping a refund", () => {
    const a=source("invoice"); a.receipt.sourceKind="invoice_payment"; a.receipt.sourceInvoiceId="invoice"; a.receipt.refundAdapter="unqualified"; a.receipt.provenRefundableRef=null;
    assert.equal(cancellationPosition([a],scope).unqualifiedRouteCount,1);
    a.receipt.completedAttributedRefundMinor=10000;
    assert.equal(cancellationPosition([a],scope).unqualifiedRouteCount,0);
  });
  it("rejects duplicate canonical rows and alias collisions", () => {
    const a=source("a"), b=source("b"); b.receipt.economicAliases.push("capture:a");
    assert.throws(()=>cancellationPosition([a,a],scope),/same payment/);
    assert.throws(()=>cancellationPosition([a,b],scope),/same payment/);
    a.receipt.economicAliases.push('capture:a');
    assert.throws(()=>cancellationPosition([a],scope),/same payment/);
  });
  it("rejects mixed tenants, projects, packages and provenance", () => {
    for(const key of ["tenantId","projectId","packageId","provenance"] as const){const a=source("a"); (a.receipt as unknown as Record<string,string>)[key]="other"; assert.throws(()=>cancellationPosition([a],scope),/workspace/);}
  });
  it("does not hide overdrawn positions or unsafe integer totals", () => {
    const a=source("a"); a.paidMinor=10001; assert.throws(()=>cancellationPosition([a],scope),/reconciliation/);
    a.paidMinor=100; a.receipt.excludedMinor=10000; assert.throws(()=>cancellationPosition([a],scope),/reconciliation/);
    a.paidMinor=-1; assert.throws(()=>cancellationPosition([a],scope),/whole number/);
    assert.throws(()=>cancellationPosition([source("a",Number.MAX_SAFE_INTEGER),source("b",Number.MAX_SAFE_INTEGER)],scope),/whole number/);
  });
  it("is deterministic and leaves historical receipts unchanged", () => {
    const a=source("a"), b=source("b"), before=JSON.stringify([a,b]);
    assert.deepEqual(cancellationPosition([a,b],scope),cancellationPosition([b,a],scope));
    assert.equal(JSON.stringify([a,b]),before); assert.equal(cancellationPosition([],scope).uncommittedMinor,0);
  });
});
