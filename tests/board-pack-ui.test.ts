import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createCanvas } from "@napi-rs/canvas";
import type { WorkspaceRole } from "../lib/contracts";
import { COMMUNITY_TEMPLATES, type CommunityTemplate } from "../lib/community/templates";
import { BOARD_PACK_VERSION, boardPackSourceId, type BoardPackDesk, type BoardPackReport, type BoardPackSource, type BoardPackSourceDetail, type BoardPackSourceKind, type BoardPackView } from "../lib/reports/board-pack-contracts";
import { STUDIO_POSITION_VERSION, STUDIO_SEMANTIC_VERSION, type FundingPositionRow, type PackageRow, type SettlementRow } from "../lib/studio/contracts";

const styles = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : nextLoad(url, context);
} });
const { BoardPackDocument } = await import("../components/board-pack/document");
const { BoardPackWorkspace, SourcePanel } = await import("../components/board-pack/workspace");
const { boardPackFetch, BoardPackRequestError, loadBoardPackReviewedImage } = await import("../components/board-pack/shared");
const { default: Loading } = await import("../app/board-pack/loading");
const { default: ErrorPage } = await import("../app/board-pack/error");
styles.deregister();

const AS_OF = "2026-11-12T01:00:00.000Z", REPORT_ID = "11111111-1111-4111-8111-111111111111", HASH = "f".repeat(64);
const noAction = () => {};
const render = (view: BoardPackView, packageId: string | null = null) => renderToStaticMarkup(createElement(BoardPackDocument, { view, packageId, onSource: noAction, onPackageChange: noAction }));

/** Honest synthetic DTO: four original receipts = 500 cents; 200 returned, 300 currently assigned. */
function reportFixture(template: CommunityTemplate = COMMUNITY_TEMPLATES[0], role: WorkspaceRole = "organizer"): BoardPackReport {
  const [original, materials, wood] = [template.packages.find(pkg => pkg.id === "electronics") ?? template.packages[0], template.packages.find(pkg => pkg.id === "materials") ?? template.packages[1], template.packages.find(pkg => pkg.id === "woodworking") ?? template.packages[2]];
  const source = (kind: BoardPackSourceKind, id: string, label: string, packageIds: string[]): BoardPackSource => ({
    id: boardPackSourceId(kind, id), kind, label, packageIds, provenance: "sample", observedAt: AS_OF,
    reviewerLabel: kind === "evidence" ? "Synthetic reviewer" : null, reviewedAt: kind === "evidence" ? AS_OF : null,
    scope: "Fictional rendering-test source; no provider or physical result is claimed.", available: true,
  });
  const audience: BoardPackReport["audience"] = { role, label: role === "donor" ? "Your contribution report" : role === "volunteer" ? "Your expense report" : `${role === "auditor" ? "Auditor" : "Organizer"} project report`, detail: "This synthetic report keeps project aggregates separate from the permitted source rows.", receiptScope: role === "volunteer" ? "none" : role === "donor" ? "own_contributions" : "project", expenseScope: role === "donor" ? "none" : role === "volunteer" ? "own_claims" : role === "auditor" ? "project_redacted" : "project_private" };
  const packages: PackageRow[] = template.packages.map((pkg, index) => ({
    id: pkg.id, packageId: pkg.id, title: pkg.title, shortTitle: pkg.shortTitle, budgetMinor: pkg.budgetMinor,
    pledgedMinor: pkg.id === original.id ? 500 : pkg.id === materials.id ? 700 : 0,
    collectedMinor: pkg.id === materials.id ? 200 : pkg.id === wood.id ? 100 : 0,
    fundingEligibleMinor: pkg.id === materials.id ? 200 : pkg.id === wood.id ? 100 : 0,
    shortfallMinor: pkg.budgetMinor - (pkg.id === materials.id ? 200 : pkg.id === wood.id ? 100 : 0),
    pendingRefundMinor: 0, completedRefundMinor: pkg.id === original.id ? 200 : 0, excessLiabilityMinor: 0,
    allocationReservedMinor: pkg.id === materials.id ? 91 : 0, availableAllocationMinor: pkg.id === materials.id ? 109 : pkg.id === wood.id ? 100 : 0,
    approvedExpenseMinor: pkg.id === materials.id ? 66 : 0, paidExpenseMinor: pkg.id === materials.id ? 66 : 0,
    reviewedItemCount: pkg.id === materials.id ? 1 : 0, requiredItemCount: pkg.requirements.length,
    reviewedExpenseLineCount: pkg.id === materials.id ? 1 : 0, fundingState: pkg.id === original.id ? "cancelled" : "open", workState: "planned", geometryRef: pkg.id, provenance: "sample",
  }));
  const settlements: SettlementRow[] = [200, 100, 100, 100].map((value, index) => ({
    id: `synthetic-receipt-${index + 1}`, packageId: original.id, settlementReceiptId: `synthetic-receipt-${index + 1}`, sourceKind: "orders_capture", purpose: "conditional_pledge", observedState: "COMPLETED", grossMinor: value, creditedMinor: value,
    completedRefundMinor: index === 0 ? 200 : 0, pendingRefundMinor: 0, fundingEligibleMinor: index === 0 ? 0 : value,
    excludedMinor: 0, excessLiabilityMinor: 0, currency: "USD", observedAt: AS_OF, provenance: "sample",
  }));
  const positions: FundingPositionRow[] = settlements.map((receipt, index) => ({
    id: `synthetic-position-${index + 1}`, packageId: index === 0 ? original.id : index === 2 ? wood.id : materials.id,
    semanticVersion: STUDIO_POSITION_VERSION, settlementReceiptId: receipt.id, receiptVersion: 2, originalPackageId: original.id,
    sourceKind: receipt.sourceKind, assignedMinor: receipt.creditedMinor, collectedMinor: index === 0 ? 0 : receipt.creditedMinor,
    fundingEligibleMinor: index === 0 ? 0 : receipt.creditedMinor, refundedMinor: index === 0 ? 200 : 0, pendingRefundMinor: 0, excludedMinor: 0,
    reservedMinor: index === 3 ? 25 : 0, paidMinor: index === 3 ? 66 : 0, availableMinor: index === 0 ? 0 : index === 3 ? 9 : 100, assignmentCount: index === 0 ? 0 : 1, provenance: "sample",
  }));
  const receiptRows = role === "volunteer" ? [] : settlements, positionRows = role === "volunteer" ? [] : positions;
  const assignments: BoardPackReport["assignments"] = role === "volunteer" ? [] : settlements.slice(1).map((receipt, index) => ({ id: `synthetic-move-${index + 1}`, receiptId: receipt.id, kind: index === 1 ? "rollover" : "reallocation", amountMinor: 100, fromPackageId: original.id, toPackageId: index === 1 ? wood.id : materials.id, committedAt: AS_OF, sequence: index + 1, sourceId: boardPackSourceId("assignment", `synthetic-move-${index + 1}`) }));
  const evidence: BoardPackReport["data"]["evidence"] = [{ id: "synthetic-reviewed-photo", packageId: materials.id, evidenceId: "synthetic-reviewed-photo", title: "Fictional alignment review", sourceClass: "reviewed_photo", reviewState: "accepted_within_scope", itemCount: 1, reviewedAt: AS_OF, sourceAvailable: false, documentId: null, claimId: null, provenance: "sample", reviewScope: "A sample comparison within a recorded image region; no installation or safety certification.", amountMinor: null }];
  const expenses: BoardPackReport["expenses"] = role === "donor" ? [] : [{ id: "synthetic-expense", packageIds: [materials.id], claimId: role === "auditor" ? null : "synthetic-claim", title: role === "auditor" ? "Redacted reviewed expense" : "Synthetic materials expense", state: "reviewed", claimVersion: 3, approvedMinor: 66, requestedMinor: 66, reviewedAt: AS_OF, reviewerLabel: "Synthetic reviewer", repayments: [{ id: "synthetic-payment", state: "completed", principalMinor: 66, deliveredMinor: 66, returnedMinor: 0, feeAllowanceMinor: 25, actualFeeMinor: null, feeState: "not_observed", observedAt: AS_OF, sourceId: boardPackSourceId("expense", "synthetic-payment") }], sourceId: boardPackSourceId("expense", "synthetic-expense") }];
  const sources: BoardPackSource[] = [
    ...packages.map(pkg => source("package", pkg.id, pkg.title, [pkg.packageId])),
    ...receiptRows.map(row => source("receipt", row.id, `Original receipt ${row.id}`, [row.packageId, ...positions.filter(position => position.settlementReceiptId === row.id).map(position => position.packageId)])),
    ...positionRows.map(row => source("position", row.id, `Current purpose ${row.id}`, [row.packageId])),
    ...assignments.map(row => source("assignment", row.id, `Purpose change ${row.id}`, [row.fromPackageId, row.toPackageId])),
    ...evidence.map(row => source("evidence", row.id, row.title, [row.packageId])),
    ...expenses.flatMap(row => [source("expense", row.id, row.title, row.packageIds), ...row.repayments.map(payment => source("expense", payment.id, "Repayment observation", row.packageIds))]),
  ];
  return {
    schemaVersion: BOARD_PACK_VERSION, id: REPORT_ID, label: "Synthetic board meeting edition", contentHash: HASH,
    project: { id: `synthetic-${template.id}`, title: template.title, templateId: template.id, currency: "USD", mode: "sample" }, audience, asOf: AS_OF, projectionVersion: 12, eventCursor: 41,
    semanticVersion: STUDIO_SEMANTIC_VERSION, datasetVersions: { funding_positions: STUDIO_POSITION_VERSION },
    data: { packages, settlements: receiptRows, funding_positions: positionRows, allocations: [], evidence, exceptions: [] },
    packages: packages.map((pkg, index) => ({ packageId: pkg.packageId, version: pkg.packageId === original.id ? 2 : 3, title: pkg.title, lifecycleState: pkg.packageId === original.id ? "cancelled" : "active", originalCommitmentRecordMinor: pkg.packageId === original.id ? 500 : pkg.packageId === materials.id ? 700 : 0, unpaidCommitmentMinor: pkg.packageId === materials.id ? 700 : 0, acceptedSponsorUnpaidMinor: pkg.packageId === materials.id ? 250 : 0, currentCase: pkg.packageId === original.id ? { id: "synthetic-closed-case", state: "closed", revision: 2, deadline: "2026-11-11T23:00:00.000Z", packageVersion: 1 } : null, requirements: [{ id: `synthetic-requirement-${index}`, label: "Recorded evidence requirement", satisfied: pkg.packageId === materials.id, detail: "Fictional requirement for report rendering.", scope: pkg.packageId === materials.id ? "Recorded image region only" : null }], blockers: pkg.packageId === original.id ? ["This purpose was cancelled; completed returns and changed purposes remain in the record."] : [], sourceId: boardPackSourceId("package", pkg.packageId) })),
    geometry: Object.fromEntries(packages.map((pkg, index) => { const x = .08 + (index % 3) * .30, y = .1 + Math.floor(index / 3) * .4; return [pkg.packageId, { packageId: pkg.packageId, points: [{ x, y }, { x: x + .25, y }, { x: x + .25, y: y + .3 }, { x, y: y + .3 }], label: { x: x + .125, y: y + .15 } }]; })),
    geometrySource: null, reviewedImages: [],
    totals: { project: { budgetMinor: template.totalMinor, currentCollectedMinor: 300, eligibleMinor: 300, unpaidCommitmentMinor: 700, acceptedSponsorUnpaidMinor: 250, returnedMinor: 200, pendingReturnMinor: 0, reservedMinor: 25, paidMinor: 66, availableMinor: 209, approvedExpenseMinor: 66, deliveredPrincipalMinor: 66, paidFeeMinor: 0, reservedFeeMinor: 25, acceptedWorkItems: 1, requiredWorkItems: packages.reduce((sum, row) => sum + row.requiredItemCount, 0), acceptedPackages: 0, packageCount: packages.length }, receipts: { scope: audience.receiptScope, count: receiptRows.length, grossMinor: role === "volunteer" ? 0 : 500, creditedMinor: role === "volunteer" ? 0 : 500, returnedMinor: role === "volunteer" ? 0 : 200, pendingReturnMinor: 0, excludedMinor: 0, excessLiabilityMinor: 0, ordersGrossMinor: role === "volunteer" ? 0 : 500, invoiceGrossMinor: 0, testGrossMinor: 0 }, positions: { scope: audience.receiptScope, count: positionRows.length, assignedMinor: role === "volunteer" ? 0 : 500, collectedMinor: role === "volunteer" ? 0 : 300, eligibleMinor: role === "volunteer" ? 0 : 300, returnedMinor: role === "volunteer" ? 0 : 200, pendingReturnMinor: 0, excludedMinor: 0, reservedMinor: role === "volunteer" ? 0 : 25, paidMinor: role === "volunteer" ? 0 : 66, availableMinor: role === "volunteer" ? 0 : 209 } },
    assignments, expenses, balance: { state: "not_recorded", observedAt: null, asOf: null, refreshedAt: null, availableMinor: null, code: null, sourceId: null, limitation: "No provider balance observation was included. Receipt credit does not authorize spending." }, sources,
    notices: ["Synthetic rendering evidence only; no actual provider, person or physical completion is claimed."],
  };
}
function viewFixture(report = reportFixture()): BoardPackView {
  return { summary: { id: report.id, label: report.label, asOf: report.asOf, contentHash: report.contentHash, role: report.audience.role, projectionVersion: report.projectionVersion, eventCursor: report.eventCursor, packageCount: report.packages.length }, status: "current", checkedAt: AS_OF, currentProjectionVersion: report.projectionVersion, currentEventCursor: report.eventCursor, reasons: [], report, canPrint: true, canExport: true };
}
function deskFixture(view = viewFixture(), canCapture = true): BoardPackDesk {
  return { scope: "synthetic-actor-membership-scope", projectId: view.report!.project.id, projectTitle: view.report!.project.title, audience: view.report!.audience, sessionExpiresAt: "2099-11-12T01:00:00.000Z", projectionVersion: view.currentProjectionVersion, eventCursor: view.currentEventCursor, history: [view.summary], nextCursor: null, selected: view, canCapture };
}
function section(html: string, title: string, nextTitle: string) {
  const start = html.indexOf(`<h3>${title}</h3>`), end = html.indexOf(`<h3>${nextTitle}</h3>`);
  assert.ok(start >= 0 && end > start, `Missing report sections: ${title}, ${nextTitle}`);
  return html.slice(start, end);
}

describe("the actual Board Pack document", () => {
  it("keeps original money, completed returns, current positions and actual unpaid promises distinct", () => {
    const html = render(viewFixture());
    const original = section(html, "Original payments", "Where receipt credit stands now");
    const current = section(html, "Where receipt credit stands now", "Expenses and repayments");
    assert.match(original, /Observed gross<\/dt><dd>\$5\.00/);
    assert.match(original, /Completed attributed returns<\/dt><dd>\$2\.00/);
    assert.match(current, /Currently collected<\/dt><dd>\$3\.00/);
    assert.match(current, /Uncommitted credit<\/dt><dd>\$2\.09/);
    assert.match(html, /Original commitment record<\/dt><dd>\$5\.00/);
    assert.match(html, /Current unpaid promises<\/dt><dd>\$0\.00/);
    assert.match(html, /Unpaid commitments<\/span><strong>\$7\.00/);
    assert.match(html, /Includes sponsor promises: \$2\.50/);
    assert.match(html, /Package v2 · cancelled/);
    assert.match(html, /package v1\. Recorded deadline/);
    assert.doesNotMatch(html, /unpaid[^<]*\$5\.00/i);
  });

  it("keeps an original receipt inspectable when its current purpose is selected", () => {
    const report = reportFixture(), materials = report.assignments[0].toPackageId;
    const html = render(viewFixture(report), materials);
    const original = section(html, "Original payments", "Where receipt credit stands now");
    const current = section(html, "Where receipt credit stands now", "Expenses and repayments");
    assert.match(original, /synthetic-receipt-2/);
    assert.match(original, /synthetic-receipt-4/);
    assert.doesNotMatch(original, /synthetic-receipt-1|synthetic-receipt-3/);
    assert.match(original, /Electronics benches/);
    assert.match(current, /synthetic-position-2/);
    assert.match(current, /synthetic-position-4/);
    assert.match(html, /Project and audience totals remain for their full stated scope/);
    assert.match(html, /aria-pressed="true"/);
  });

  it("uses each template and audience’s provided scope without an organizer-only overview", () => {
    for (const template of COMMUNITY_TEMPLATES) for (const role of ["organizer", "auditor", "donor", "volunteer"] as const) {
      const report = reportFixture(template, role), html = render(viewFixture(report));
      assert.ok(html.includes(template.title), `${template.id}/${role}: project title`);
      assert.ok(html.includes(report.audience.label), `${template.id}/${role}: audience label`);
      assert.match(html, /Financial &amp; work cutoff/);
      assert.match(html, /Fictional Sample/);
      assert.match(html, /Sources &amp; limits of this record/);
      if (template.id !== "makerspace") assert.doesNotMatch(html, /EASTSIDE MAKERSPACE|Electronics benches/);
      if (role === "donor") { assert.match(html, /Your contribution receipts only/); assert.doesNotMatch(html, /Synthetic materials expense|synthetic-claim/); }
      if (role === "volunteer") { assert.match(html, /Your expense claims only/); assert.doesNotMatch(html, /synthetic-receipt-[1-4]/); }
      if (role === "auditor") { assert.match(html, /Redacted reviewed expense/); assert.doesNotMatch(html, /synthetic-claim/); }
    }
  });

  it("includes invoice receipts in current funding while keeping rail subtotals non-additive", () => {
    const report = reportFixture(), destination = report.assignments[0].toPackageId;
    report.data.settlements.push({ id: "synthetic-invoice", packageId: destination, settlementReceiptId: "synthetic-invoice", sourceKind: "invoice_payment", purpose: "conditional_pledge", observedState: "COMPLETED", grossMinor: 35, creditedMinor: 35, completedRefundMinor: 0, pendingRefundMinor: 0, fundingEligibleMinor: 35, excludedMinor: 0, excessLiabilityMinor: 0, currency: "USD", observedAt: AS_OF, provenance: "sample" });
    report.data.funding_positions!.push({ id: "synthetic-invoice-position", packageId: destination, semanticVersion: STUDIO_POSITION_VERSION, settlementReceiptId: "synthetic-invoice", receiptVersion: 1, originalPackageId: destination, sourceKind: "invoice_payment", assignedMinor: 35, collectedMinor: 35, fundingEligibleMinor: 35, refundedMinor: 0, pendingRefundMinor: 0, excludedMinor: 0, reservedMinor: 0, paidMinor: 0, availableMinor: 35, assignmentCount: 0, provenance: "sample" });
    report.sources.push({ ...report.sources[0], id: boardPackSourceId("receipt", "synthetic-invoice"), kind: "receipt", label: "Synthetic invoice payment", packageIds: [destination] }, { ...report.sources[0], id: boardPackSourceId("position", "synthetic-invoice-position"), kind: "position", label: "Synthetic invoice current position", packageIds: [destination] });
    const packageRow = report.data.packages.find(row => row.packageId === destination)!;
    packageRow.collectedMinor = 235; packageRow.fundingEligibleMinor = 235; packageRow.availableAllocationMinor = 144;
    report.totals.project.currentCollectedMinor = 335; report.totals.project.eligibleMinor = 335; report.totals.project.availableMinor = 244;
    Object.assign(report.totals.receipts, { count: 5, grossMinor: 535, creditedMinor: 535, invoiceGrossMinor: 35 });
    Object.assign(report.totals.positions, { count: 5, assignedMinor: 535, collectedMinor: 335, eligibleMinor: 335, availableMinor: 244 });
    const html = render(viewFixture(report)), original = section(html, "Original payments", "Where receipt credit stands now"), current = section(html, "Where receipt credit stands now", "Expenses and repayments");
    assert.match(original, /Orders gross · part of gross<\/dt><dd>\$5\.00/);
    assert.match(original, /Invoice gross · part of gross<\/dt><dd>\$0\.35/);
    assert.match(original, /Observed gross<\/dt><dd>\$5\.35/);
    assert.match(current, /Currently collected<\/dt><dd>\$3\.35/);
    assert.match(original, /Invoice payment/);
    assert.match(current, /synthetic-invoice/);
    assert.match(current, /Receipt v1 · Invoice payment/);
    assert.match(current, /\$0\.35 assigned/);
    assert.match(html, /Original gross and original credit are historical measures/);
  });

  it("does not turn an unknown fee into observed zero or a reviewed photo into accepted installation", () => {
    const html = render(viewFixture());
    assert.match(html, /Actual fee not observed/);
    assert.match(html, /\$0\.25 allowance · not observed/);
    assert.match(html, /\$0\.66 delivered/);
    assert.match(html, /No provider balance observation was included/);
    assert.match(html, /Fictional alignment review/);
    assert.match(html, /Recorded image region only/);
    assert.match(html, /no installation or safety certification/);
    assert.match(html, /not a merchant balance or permission to spend/);
    assert.doesNotMatch(html, /\$0\.00 actual|Approved sample plan scope|Reviewed work<[^>]+>0%/);
  });

  it("names journal reversals without presenting them as another original payment", () => {
    const report = reportFixture();
    report.assignments.push({ ...report.assignments[0], id: "synthetic-reversal", kind: "reversal", fromPackageId: report.assignments[0].toPackageId, toPackageId: report.assignments[0].fromPackageId, sequence: 4, sourceId: boardPackSourceId("assignment", "synthetic-reversal") });
    report.sources.push({ ...report.sources[0], id: boardPackSourceId("assignment", "synthetic-reversal"), kind: "assignment", label: "Recorded journal reversal", packageIds: [report.assignments[0].fromPackageId, report.assignments[0].toPackageId] });
    const restored = report.data.funding_positions!.find(row => row.id === "synthetic-position-2")!;
    Object.assign(restored, { packageId: report.assignments[0].fromPackageId, receiptVersion: 3, fundingEligibleMinor: 0, excludedMinor: 100, availableMinor: 0, assignmentCount: 2 });
    const originalPackage = report.data.packages.find(row => row.packageId === restored.packageId)!, destination = report.data.packages.find(row => row.packageId === report.assignments[0].toPackageId)!;
    originalPackage.collectedMinor = 100; destination.collectedMinor = 100; destination.fundingEligibleMinor = 100; destination.availableAllocationMinor = 9; destination.shortfallMinor = destination.budgetMinor - 100;
    report.data.settlements[1].excludedMinor = 100; report.data.settlements[1].fundingEligibleMinor = 0;
    Object.assign(report.totals.positions, { eligibleMinor: 200, excludedMinor: 100, availableMinor: 109 });
    Object.assign(report.totals.project, { eligibleMinor: 200, availableMinor: 109 }); report.totals.receipts.excludedMinor = 100;
    const html = render(viewFixture(report)), original = section(html, "Original payments", "Where receipt credit stands now"), current = section(html, "Where receipt credit stands now", "Expenses and repayments");
    assert.match(current, /class="bp-state">reversal<\/span>/);
    assert.match(current, /Recorded journal reversal/);
    assert.match(original, /Original payments<\/dt><dd>4<\/dd>/);
    assert.match(original, /Observed gross<\/dt><dd>\$5\.00/);
  });

  it("labels an older cutoff with its original facts and current version instead of silently refreshing them", () => {
    const view = viewFixture(); view.status = "historical"; view.currentProjectionVersion = 15; view.currentEventCursor = 51; view.reasons = ["The project has changed since this edition."];
    const html = render(view);
    assert.match(html, /Historical edition · facts remain at the captured cutoff/);
    assert.match(html, /Current project version 15; event 51/);
    assert.match(html, /v12 \/ 41/);
    assert.match(html, /The project has changed since this edition/);
    assert.match(html, /Currently collected<\/dt><dd>\$3\.00/);
    assert.match(html, /Nov 12, 2026, 1:00 AM UTC/);
  });

  it("refuses to render retained private payload after withdrawal even if a caller still passes it", () => {
    const view = viewFixture(); view.status = "withdrawn"; view.canPrint = false; view.canExport = false; view.reasons = ["A bound source or membership was withdrawn."];
    view.report!.project.title = "PRIVATE-WITHDRAWN-PROJECT";
    view.report!.data.evidence[0].title = "PRIVATE-WITHDRAWN-SOURCE";
    const html = render(view);
    assert.match(html, /This edition needs a new review/);
    assert.match(html, /A bound source or membership was withdrawn/);
    assert.match(html, /Synthetic board meeting edition/);
    assert.doesNotMatch(html, /PRIVATE-WITHDRAWN|synthetic-receipt|<svg[^>]*class="bp-plan"|\$3\.00|ffffffffffffffff/);
    assert.match(html, /Previously downloaded and printed copies cannot be recalled/);
  });

  it("places only matching transient reviewed images in the report with scope, reviewer and provenance", () => {
    const report = reportFixture(), source = report.sources.find(row => row.kind === "evidence")!;
    const descriptor = { sourceId: source.id, width: 600, height: 400, alt: "A permitted fictional image region", contentHash: "a".repeat(64) };
    report.reviewedImages = [descriptor];
    const images = { [source.id]: { state: "ready" as const, contentHash: descriptor.contentHash, url: "blob:synthetic-reviewed-region", error: null } };
    const html = renderToStaticMarkup(createElement(BoardPackDocument, { view: viewFixture(report), images, onSource: noAction }));
    assert.match(html, /<img data-bp-reviewed-image="evidence:synthetic-reviewed-photo" src="blob:synthetic-reviewed-region" alt="A permitted fictional image region" width="600" height="400"/);
    assert.match(html, /1 of 1 authorized images opened/);
    assert.match(html, /Synthetic reviewer/);
    assert.match(html, /Fictional rendering-test source; no provider or physical result is claimed/);
    assert.match(html, /Image SHA-256 aaaaaaaaaaaaaaaa/);
    assert.doesNotMatch(html, /src="\/api\/|src="https?:/);
    const stale = renderToStaticMarkup(createElement(BoardPackDocument, { view: viewFixture(report), images: { [source.id]: { ...images[source.id], contentHash: "b".repeat(64) } } }));
    assert.doesNotMatch(stale, /<img|blob:synthetic-reviewed-region/);
    assert.match(stale, /Opening the reviewed image after its access check/);
    const withdrawn = viewFixture(report); withdrawn.status = "withdrawn";
    assert.doesNotMatch(renderToStaticMarkup(createElement(BoardPackDocument, { view: withdrawn, images })), /<img|blob:synthetic-reviewed-region|A permitted fictional image region/);
  });
});

describe("report entry and source disclosure", () => {
  it("honors server capture/print/export permissions and starts with unchecked printing", () => {
    const view = viewFixture(reportFixture(COMMUNITY_TEMPLATES[1], "auditor")); view.canPrint = false; view.canExport = false;
    const html = renderToStaticMarkup(createElement(BoardPackWorkspace, { initial: deskFixture(view, false) }));
    assert.doesNotMatch(html, /id="bp-capture-label"|Capture current report|<option value="organizer"/);
    assert.match(html, /disabled=""[^>]*><svg[^>]*[\s\S]*?Full scoped CSV<\/button>/);
    assert.match(html, /disabled=""[^>]*><svg[^>]*[\s\S]*?Print \/ save PDF<\/button>/);
    assert.match(html, /data-print-ready="false"/);
    assert.match(html, /@page \{ size: A4; margin: 13mm;/);
    assert.match(html, /Paper size<select[^>]*><option value="A4" selected="">A4<\/option><option value="Letter">Letter/);
    assert.match(html, /Your saved editions/);
  });

  it("shows current access recovery in loading/error routes without exposing thrown error data", () => {
    const loading = renderToStaticMarkup(createElement(Loading));
    assert.match(loading, /role="status" aria-busy="true"/);
    assert.match(loading, /Checking your workspace role and saved report editions/);
    const error = renderToStaticMarkup(createElement(ErrorPage, { error: new Error("PRIVATE-DATABASE-ERROR"), retry: noAction }));
    assert.match(error, /Try again/);
    assert.match(error, /href="\/community"/);
    assert.doesNotMatch(error, /PRIVATE-DATABASE-ERROR/);
  });

  it("omits a stale source payload while a replacement is loading or access has failed", () => {
    const report = reportFixture(), source = report.sources.find(row => row.kind === "evidence")!;
    const detail: BoardPackSourceDetail = { reportId: report.id, contentHash: report.contentHash, asOf: report.asOf, source,
      fields: [{ label: "Private field", value: "PRIVATE-OLD-SOURCE-VALUE" }], image: { url: `/api/board-packs/${report.id}/sources/evidence%3Asynthetic-reviewed-photo/image`, width: 100, height: 100, alt: "Reviewed image region", contentHash: "a".repeat(64) }, relatedSourceIds: [], limitations: [] };
    const base = { detail, preview: "blob:private-old-image", previewBusy: false, previewError: null, onPreview: noAction, onImageError: noAction, onRelated: noAction, close: noAction };
    const loading = renderToStaticMarkup(createElement(SourcePanel, { ...base, loading: true, error: null }));
    const denied = renderToStaticMarkup(createElement(SourcePanel, { ...base, loading: false, error: "Current access changed." }));
    for (const html of [loading, denied]) assert.doesNotMatch(html, /PRIVATE-OLD-SOURCE-VALUE|blob:private-old-image|<img/);
    const opened = renderToStaticMarkup(createElement(SourcePanel, { ...base, loading: false, error: null, preview: null }));
    assert.match(opened, /PRIVATE-OLD-SOURCE-VALUE/);
    assert.match(opened, /Inspect source image/);
    assert.doesNotMatch(opened, /<img|\/api\/board-packs\//);
    assert.match(opened, /Go back to report/);
  });
});

describe("the report request boundary", () => {
  it("sends the exact current scope for JSON reads, capture retries, CSV and protected images", async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), originalFetch = globalThis.fetch;
    const requests: { path: string; headers: Headers; body: BodyInit | null | undefined; method: string | undefined }[] = [];
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://127.0.0.1:4578" } } });
    globalThis.fetch = async (input, options) => { requests.push({ path: String(input), headers: new Headers(options?.headers), body: options?.body, method: options?.method }); return Response.json({ ok: true }); };
    try {
      const scope = "synthetic-exact-actor-role-membership", body = { intentId: "22222222-2222-4222-8222-222222222222", label: "Interrupted report attempt", expectedProjectionVersion: 12 };
      for (const path of ["", `/${REPORT_ID}`, `/${REPORT_ID}/export`, `/${REPORT_ID}/sources/evidence%3Asynthetic/image`]) await boardPackFetch(path, { scope });
      await boardPackFetch("/capture", { scope, body });
      await boardPackFetch("/capture", { scope, body });
      assert.equal(requests.length, 6);
      for (const request of requests) assert.equal(request.headers.get("X-Fieldproof-Board-Pack-Scope"), scope);
      assert.equal(requests[4].method, "POST");
      assert.equal(requests[4].body, requests[5].body);
      assert.deepEqual(JSON.parse(String(requests[4].body)), body);
      assert.ok(requests.every(request => request.path.startsWith("/api/board-packs")));
    } finally { globalThis.fetch = originalFetch; if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); }
  });

  it("preserves structured access codes while withholding an unstructured server failure body", async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://127.0.0.1:4578" } } });
    try {
      globalThis.fetch = async () => Response.json({ error: "The active report context changed.", code: "BOARD_PACK_CONTEXT_CHANGED" }, { status: 409 });
      await assert.rejects(boardPackFetch(`/${REPORT_ID}`, { scope: "old-synthetic-scope" }), error => error instanceof BoardPackRequestError && error.code === "BOARD_PACK_CONTEXT_CHANGED" && error.status === 409);
      globalThis.fetch = async () => new Response("PRIVATE-SERVER-FAILURE-BODY", { status: 500 });
      await assert.rejects(boardPackFetch(`/${REPORT_ID}`, { scope: "old-synthetic-scope" }), error => error instanceof BoardPackRequestError && error.status === 500 && !error.message.includes("PRIVATE-SERVER-FAILURE-BODY"));
    } finally { globalThis.fetch = originalFetch; if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); }
  });

  it("checks the captured image identity, scope and bytes before making an image usable", async () => {
    const canvas = createCanvas(2, 2); canvas.getContext("2d").fillRect(0, 0, 2, 2);
    const bytes = canvas.toBuffer("image/png"), hash = createHash("sha256").update(bytes).digest("hex"), report = reportFixture();
    const source = report.sources.find(row => row.kind === "evidence")!, descriptor = { sourceId: source.id, width: 2, height: 2, alt: "Generated test pixels; no physical-work evidence", contentHash: hash };
    const detail: BoardPackSourceDetail = { reportId: report.id, contentHash: report.contentHash, asOf: report.asOf, source, fields: [], image: { url: `/api/board-packs/${report.id}/sources/${encodeURIComponent(source.id)}/image`, width: 2, height: 2, alt: descriptor.alt, contentHash: hash }, relatedSourceIds: [], limitations: [] };
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), originalFetch = globalThis.fetch;
    let currentDetail = detail, servedBytes = bytes;
    const requests: { path: string; scope: string | null }[] = [];
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://127.0.0.1:4578" } } });
    globalThis.fetch = async (input, options) => {
      requests.push({ path: String(input), scope: new Headers(options?.headers).get("X-Fieldproof-Board-Pack-Scope") });
      return String(input).endsWith("/image") ? new Response(new Uint8Array(servedBytes), { headers: { "Content-Type": "image/png" } }) : Response.json({ detail: currentDetail });
    };
    try {
      const blob = await loadBoardPackReviewedImage(report, descriptor, { scope: "synthetic-image-scope" });
      assert.equal(blob.size, bytes.length); assert.equal(blob.type, "image/png");
      assert.equal(requests.length, 2); assert.ok(requests.every(request => request.scope === "synthetic-image-scope"));
      currentDetail = { ...detail, contentHash: "b".repeat(64) }; requests.length = 0;
      await assert.rejects(loadBoardPackReviewedImage(report, descriptor, { scope: "synthetic-image-scope" }), error => error instanceof BoardPackRequestError && error.status === 410);
      assert.equal(requests.length, 1, "A mismatched edition must not fetch image bytes");
      currentDetail = { ...detail, image: { ...detail.image!, url: "https://private-storage.invalid/source?private=never-requested" } }; requests.length = 0;
      await assert.rejects(loadBoardPackReviewedImage(report, descriptor, { scope: "synthetic-image-scope" }), error => error instanceof BoardPackRequestError && error.status === 410);
      assert.equal(requests.length, 1); assert.ok(requests.every(request => request.path.startsWith("/api/board-packs/")));
      currentDetail = detail; servedBytes = Buffer.from("different synthetic bytes"); requests.length = 0;
      await assert.rejects(loadBoardPackReviewedImage(report, descriptor, { scope: "synthetic-image-scope" }), error => error instanceof BoardPackRequestError && error.code === "BOARD_PACK_IMAGE_CHANGED");
      assert.equal(requests.length, 2);
    } finally { globalThis.fetch = originalFetch; if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); }
  });
});

describe("Board Pack source colors", () => {
  it("keeps the actual paper, status, table and dialog text above normal-text contrast thresholds", () => {
    const css = readFileSync(new URL("../app/board-pack/board-pack.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    function declaration(selector: string, property: string): string {
      for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!rule[1].split(",").some(value => value.trim() === selector)) continue;
        const found = rule[2].split(";").map(value => value.trim()).find(value => value.startsWith(`${property}:`));
        if (found) return found.slice(property.length + 1).trim();
      }
      assert.fail(`Missing ${selector} ${property}`);
    }
    function color(value: string): string {
      const variable = /^var\((--[^)]+)\)$/.exec(value);
      return variable ? color(declaration(".bp-shell", variable[1])) : value;
    }
    function luminance(value: string): number {
      const hex = color(value).replace("#", "");
      assert.match(hex, /^[\da-f]{6}$/i);
      const rgb = [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16) / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
      return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
    }
    function contrast(foreground: string, background: string): number {
      const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (light + .05) / (dark + .05);
    }
    const paper = declaration(".bp-report", "background"), sidebar = declaration(".bp-capture", "background");
    const cases: [string, string, string][] = [
      ["body", declaration(".bp-shell", "color"), paper],
      ["muted text", "var(--bp-muted)", paper],
      ["sidebar text", "var(--bp-muted)", sidebar],
      ["eyebrow", declaration(".bp-kicker", "color"), paper],
      ["primary button", declaration(".bp-primary", "color"), declaration(".bp-primary", "background")],
      ["current status", declaration(".bp-report-status", "color"), declaration(".bp-report-status", "background")],
      ["historical status", declaration(".bp-report-status.is-historical", "color"), declaration(".bp-report-status.is-historical", "background")],
      ["error status", declaration(".bp-action-message.is-error", "color"), declaration(".bp-action-message.is-error", "background")],
      ["state label", declaration(".bp-state", "color"), declaration(".bp-state", "background")],
      ["provenance", declaration(".bp-mode", "color"), declaration(".bp-mode", "background")],
      ["table heading", declaration(".bp-table thead th", "color"), declaration(".bp-table thead", "background")],
      ["plan source note", declaration(".bp-plan-note", "color"), declaration(".bp-plan-block", "background")],
      ["purpose case", declaration(".bp-case-note", "color"), declaration(".bp-case-note", "background")],
      ["source dialog", declaration(".bp-dialog", "color"), declaration(".bp-dialog", "background")],
      ["source details label", declaration(".bp-detail-fields dt", "color"), declaration(".bp-dialog", "background")],
      ["placeholder", declaration(".bp-capture input::placeholder", "color"), declaration(".bp-capture input", "background")],
      ["image placeholder", declaration(".bp-image-placeholder", "color"), declaration(".bp-image-placeholder", "background")],
    ];
    for (const [name, foreground, background] of cases) assert.ok(contrast(foreground, background) >= 4.5, `${name}: ${contrast(foreground, background).toFixed(4)}:1`);
    assert.ok(contrast("var(--bp-control)", declaration(".bp-capture input", "background")) >= 3, "Input boundary contrast");
    assert.equal(declaration(".bp-capture input::placeholder", "opacity"), "1");
  });
});
