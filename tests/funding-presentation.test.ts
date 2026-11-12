import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import type { PackageView, ProjectSnapshot, SettlementReceipt, WorkspaceRole } from "../lib/contracts";
import { packagePositionTotals, projectFundingPositions, type FundingAssignment } from "../lib/domain/funding-positions";
import type { FundingCaseView, FundingDesk } from "../lib/funding/contracts";
import { currentPledgeCommitment, type PurposePledgeView } from "../lib/funding/pledges";

// Keep the real component tree; CSS has no effect on these static labels or
// controls, and Node's test runner does not load Next's stylesheet bundles.
const styles = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : nextLoad(url, context);
} });
const { FieldproofApp } = await import("../components/fieldproof-app");
const { FundingWorkspace } = await import("../components/funding/workspace");
styles.deregister();

const router: AppRouterInstance = {
  back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: "render-test",
};
const expiresAt = "2099-12-31T23:59:59.000Z";
const observedAt = "2026-11-12T03:30:00.000Z";

function renderProject(snapshot: ProjectSnapshot, view: "project" | "packages" | "organizer" | "board-pack") {
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router },
    createElement(FieldproofApp, { initial: snapshot, view })));
}
function renderDesk(desk: FundingDesk) {
  return renderToStaticMarkup(createElement(FundingWorkspace, { initial: desk }));
}
function packageView(id = "electronics", fundingState: PackageView["fundingState"] = "open"): PackageView {
  return {
    id, title: id === "electronics" ? "Electronics benches" : id === "materials" ? "Student materials fund" : "Woodworking corner",
    shortTitle: id, description: `A separately reviewed ${id} purpose.`, budgetMinor: 96000, version: 1,
    pledgedMinor: 0, collectedMinor: 0, fundingEligibleMinor: 0, shortfallMinor: 96000, pendingRefundMinor: 0,
    excessLiabilityMinor: 0, fundingState, workState: "planned", evidenceAccepted: 0, evidenceRequired: 2,
    dependencies: [], category: "The project", icon: "spark",
    zone: { packageId: id, points: [{ x: .1, y: .1 }, { x: .4, y: .1 }, { x: .4, y: .4 }, { x: .1, y: .4 }], label: { x: .25, y: .25 } },
  };
}
function projectSnapshot(role: WorkspaceRole = "donor", packages = [packageView()]): ProjectSnapshot {
  return {
    id: "presentation-project", tenantId: "presentation-tenant", slug: "presentation", title: "A shared makerspace",
    subtitle: "A synthetic rendering fixture", organizer: "Sample organizer", location: "Sample school", currency: "USD",
    mode: "sample", version: 1, projectionVersion: 1, targetMinor: packages.reduce((sum, pkg) => sum + pkg.budgetMinor, 0),
    deadline: expiresAt, packages, obligations: [], receipts: [], financialScope: "project", evidence: [], events: [], tourStep: 0,
    session: { role, actorId: "presentation-actor", expiresAt },
    capabilities: { checkoutConfigured: false, savedWalletQualified: false, payoutQualified: false, invoiceQualified: false, studioConfigured: false },
  };
}
function receipt(id: string, minor: number, returnedMinor = 0): SettlementReceipt {
  return {
    id, tenantId: "presentation-tenant", projectId: "presentation-project", packageId: "electronics", donorObligationId: `obligation-${id}`,
    sourceKind: "orders_capture", provenance: "sample", actualProviderPaymentRef: `sample-payment-${id}`, economicAliases: [`sample:${id}`],
    sourceOrderId: `sample-order-${id}`, sourceInvoiceId: null, authoritativeObservedState: "COMPLETED", observedAt, currency: "USD",
    grossSettledMinor: minor, creditedMinor: minor, completedAttributedRefundMinor: returnedMinor,
    pendingAttributedRefundReserveMinor: 0, excludedMinor: 0, excessLiabilityMinor: 0,
    provenRefundableRef: `sample-payment-${id}`, refundAdapter: "capture_refund",
  };
}
function pledge(overrides: Partial<PurposePledgeView> = {}): PurposePledgeView {
  return {
    id: "sample-pledge", version: 1, digest: "a".repeat(64), packageId: "electronics", packageVersion: 1,
    title: "Electronics benches", purpose: "A separately reviewed electronics purpose.", kind: "donor", amountMinor: 100,
    collectedMinor: 0, pendingMinor: 100, state: "pledged", own: false, acceptedAt: observedAt, expiresAt,
    operationId: null, orderId: null, lastCode: null, canWithdraw: false, canCheckout: false, canCheck: false, canRetry: false,
    receiptIds: [], ...overrides,
  };
}
function desk(overrides: Partial<FundingDesk["packages"][number]> = {}, policyOverrides: Partial<FundingDesk["policies"][number]> = {}): FundingDesk {
  const pkg = { id: "electronics", version: 1, title: "Electronics benches", purpose: "A separately reviewed electronics purpose.",
    budgetMinor: 96000, eligibleMinor: 0, availableMinor: 0, state: "open", hasRound: true, ...overrides };
  return {
    schemaVersion: "purpose-funding-v1", projectId: "presentation-project", projectTitle: "A shared makerspace",
    role: "organizer", mode: "sample", observedAt, checkoutEnabled: false, packages: [pkg],
    policies: [{ id: "sample-policy", digest: "b".repeat(64), packageId: pkg.id, packageVersion: pkg.version,
      title: pkg.title, purpose: pkg.purpose, budgetMinor: pkg.budgetMinor, remainingMinor: pkg.budgetMinor - pkg.eligibleMinor,
      pledgedMinor: 0, kind: "mixed", state: "open", expiresAt, ...policyOverrides }],
    cases: [], pledges: [], sponsors: [],
  };
}

describe("package lifecycle presentation", () => {
  it("keeps the four original receipt amounts distinct from current purposes and historical pledge records", () => {
    // Synthetic receipts model the conserved $5 = $2 returned + $3 assigned pattern.
    const receipts = [receipt("return", 200, 200), receipt("donor", 100), receipt("grant", 100), receipt("match", 100)];
    const assignments: FundingAssignment[] = ["donor", "grant", "match"].map((id, index) => ({
      id: `assignment-${id}`, receiptId: id, sequence: 1, kind: id === "match" ? "rollover" : "reallocation", reversesId: null,
      tenantId: "presentation-tenant", projectId: "presentation-project", provenance: "sample", currency: "USD", amountMinor: 100,
      debit: { packageId: "electronics", packageVersion: 1 }, credit: { packageId: index === 2 ? "woodworking" : "materials", packageVersion: 1 },
      consentId: `consent-${id}`, consentDigest: "c".repeat(64), donorActorId: `sample-${id}`,
      consentedAt: "2026-11-12T03:00:00.000Z", consentExpiresAt: expiresAt, committedAt: observedAt,
    }));
    const projection = projectFundingPositions({ sources: receipts.map(receipt => ({ receipt, version: 1 })), assignments, deductions: [], uses: [] },
      { tenantId: "presentation-tenant", projectId: "presentation-project", provenance: "sample" });
    const packages = [packageView("electronics", "cancelled"), packageView("materials"), packageView("woodworking")]
      .map(pkg => ({ ...pkg, ...packagePositionTotals(projection.positions, pkg.id, pkg.budgetMinor) }));
    packages[0].pledgedMinor = receipts.reduce((sum, row) => sum + currentPledgeCommitment({
      state: row.id === "return" ? "returned" : "collected", amountMinor: row.creditedMinor,
      collectedMinor: row.creditedMinor - row.completedAttributedRefundMinor, expiresAt, operationId: `sample-${row.id}`,
    }), 0);
    const snapshot = { ...projectSnapshot("donor", packages), receipts }, before = JSON.stringify(snapshot);
    assert.deepEqual(packages.map(pkg => pkg.collectedMinor), [0, 200, 100]);
    assert.equal(receipts.reduce((sum, row) => sum + row.grossSettledMinor, 0), 500);
    assert.equal(receipts.reduce((sum, row) => sum + row.completedAttributedRefundMinor, 0) + projection.totals.collectedMinor, 500);
    assert.equal(packages[0].pledgedMinor, 300);

    const home = renderProject(snapshot, "project").match(/<section class="focus-section"[\s\S]*?<\/section>/)![0];
    assert.match(home, /<span class="tag">Cancelled<\/span>/);
    assert.match(home, /<strong>\$3<\/strong><span>historical pledge record<\/span>/);
    assert.match(home, /<strong>\$0<\/strong><span>collected for this purpose<\/span>/);
    assert.match(home, /href="\/funding\?view=decisions"/);
    assert.doesNotMatch(home, /aria-label="Back |to complete collection|Collection complete/);
    assert.match(home, /class="pledged-track" style="width:0%"/);

    const listing = renderProject(snapshot, "packages").match(/<article class="package-card"[\s\S]*?<\/article>/)![0];
    assert.match(listing, /\$3 historical pledge record/);
    assert.match(listing, /\$0 collected for this purpose/);
    assert.match(listing, /View donor decisions/);
    assert.doesNotMatch(listing, /Back this package/);

    const board = renderProject(snapshot, "board-pack");
    assert.match(board, /<th>Pledge record<\/th><th>Collected for this purpose<\/th>/);
    assert.match(board, /Electronics benches<small>Cancelled<\/small><\/th><td>\$960\.00<\/td><td>\$3\.00<small>historical pledge record<\/small><\/td><td>\$0\.00<\/td>/);
    assert.match(board, /<th>Original credit<\/th><th>Completed returns<\/th>/);
    assert.match(board, /<td>\$2\.00<\/td><td>\$2\.00<\/td>/);
    assert.match(board, /They are not unpaid balances/);
    assert.equal(JSON.stringify(snapshot), before);
  });

  it("offers package and homepage backing only in the current donor role", () => {
    for (const role of ["organizer", "auditor", "volunteer"] as const) {
      for (const state of ["open", "ready"] as const) {
        const snapshot = projectSnapshot(role, [packageView("electronics", state)]);
        for (const view of ["project", "packages"] as const)
          assert.doesNotMatch(renderProject(snapshot, view), /aria-label="Back |Back this package/, `${role} ${state} ${view}`);
      }
    }
    const donor = projectSnapshot();
    assert.match(renderProject(donor, "project"), /aria-label="Back Electronics benches"/);
    assert.match(renderProject(donor, "packages"), /Back this package/);
  });

  it("shows the supporter invitation entry only to the current organizer", () => {
    assert.match(renderProject(projectSnapshot("organizer"), "organizer"), /href="\/supporters"[^>]*>[\s\S]*?Invite supporters/);
    for (const role of ["donor", "auditor", "volunteer"] as const)
      assert.doesNotMatch(renderProject(projectSnapshot(role), "organizer"), /href="\/supporters"/);
  });
});

describe("funding window affordances", () => {
  it("keeps cancellation review without offering an empty closure for current support or a funded purpose", () => {
    for (const initial of [desk({ eligibleMinor: 100, availableMinor: 100 }), desk({ state: "funded", eligibleMinor: 96000 }, { state: "funded" })]) {
      const html = renderDesk(initial);
      assert.match(html, /Review cancellation/);
      assert.doesNotMatch(html, /Close an empty purpose/);
    }
  });

  it("does not offer empty closure while original paid credit or an uncertain checkout remains", () => {
    for (const saved of [pledge({ state: "collected", collectedMinor: 100, pendingMinor: 0, operationId: "sample-settled" }),
      pledge({ state: "unknown", operationId: "sample-unresolved" })]) {
      const initial = desk();
      initial.pledges = [saved];
      assert.doesNotMatch(renderDesk(initial), /Close an empty purpose/);
    }
  });

  it("retains ended-window review with collected support", () => {
    const html = renderDesk(desk({ eligibleMinor: 100 }, { state: "expired", expiresAt: "2000-01-01T00:00:00.000Z" }));
    assert.match(html, /Review ended window/);
    assert.match(html, /Review cancellation/);
    assert.doesNotMatch(html, /Close an empty purpose/);
  });

  it("retains a resolved cancellation's decision history while its purpose stays closed", () => {
    const initial = desk({ state: "cancelled" }, { state: "closed" });
    const saved: FundingCaseView = {
      id: "sample-case", version: 1, revision: 1, digest: "d".repeat(64), packageId: "electronics", packageVersion: 1,
      title: "Electronics benches", purpose: initial.packages[0].purpose, reason: "A synthetic cancelled purpose", deadline: expiresAt,
      defaultTreatment: "return_to_original_route", state: "resolved", createdAt: observedAt, totalMinor: 500, denominatorMinor: 500,
      paidMinor: 0, reservedMinor: 0, returnedMinor: 200, movedMinor: 300, unresolvedMinor: 0, conflicts: [],
      method: "largest-remainder-v1", reconciliationId: null, sources: [], history: [],
    };
    initial.cases = [saved];
    const html = renderDesk(initial);
    assert.match(html, /View donor decisions/);
    assert.doesNotMatch(html, /Close an empty purpose|Pledge to this purpose|Review ended window/);
  });

  it("offers an empty closure only to the organizer when no payment has started", () => {
    const initial = desk();
    initial.pledges = [pledge()];
    assert.match(renderDesk(initial), /Close an empty purpose/);
    for (const role of ["donor", "auditor", "volunteer"] as const)
      assert.doesNotMatch(renderDesk({ ...initial, role }), /Close an empty purpose/);
  });
});
