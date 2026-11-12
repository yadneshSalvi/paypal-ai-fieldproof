import type { BoardPackAudience, BoardPackPositionTotals, BoardPackReceiptTotals, BoardPackReport } from "./board-pack-contracts";
import type { StudioData } from "../studio/contracts";

/** Rollups use the already authorized canonical dataset. Original payments and
 * current positions remain separate grains and are never added together. */
export function boardPackScopedTotals(data: StudioData, audience: BoardPackAudience): { receipts: BoardPackReceiptTotals; positions: BoardPackPositionTotals } {
  const sum = <T>(rows: T[], value: (row: T) => number) => rows.reduce((total, row) => {
    const amount = value(row), next = total + amount;
    if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(next)) throw new Error("Board Pack amounts must be safe nonnegative integer cents.");
    return next;
  }, 0);
  const receipts = data.settlements, positions = data.funding_positions ?? [];
  return {
    receipts: { scope: audience.receiptScope, count: receipts.length,
      grossMinor: sum(receipts, r => r.grossMinor), creditedMinor: sum(receipts, r => r.creditedMinor),
      returnedMinor: sum(receipts, r => r.completedRefundMinor), pendingReturnMinor: sum(receipts, r => r.pendingRefundMinor),
      excludedMinor: sum(receipts, r => r.excludedMinor), excessLiabilityMinor: sum(receipts, r => r.excessLiabilityMinor),
      ordersGrossMinor: sum(receipts.filter(r => r.sourceKind === "orders_capture"), r => r.grossMinor),
      invoiceGrossMinor: sum(receipts.filter(r => r.sourceKind === "invoice_payment"), r => r.grossMinor),
      testGrossMinor: sum(receipts.filter(r => r.purpose !== "conditional_pledge"), r => r.grossMinor) },
    positions: { scope: audience.receiptScope, count: positions.length,
      assignedMinor: sum(positions, r => r.assignedMinor), collectedMinor: sum(positions, r => r.collectedMinor), eligibleMinor: sum(positions, r => r.fundingEligibleMinor),
      returnedMinor: sum(positions, r => r.refundedMinor), pendingReturnMinor: sum(positions, r => r.pendingRefundMinor), excludedMinor: sum(positions, r => r.excludedMinor),
      reservedMinor: sum(positions, r => r.reservedMinor), paidMinor: sum(positions, r => r.paidMinor), availableMinor: sum(positions, r => r.availableMinor) },
  };
}

const cell = (value: unknown): string => {
  let text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  // Spreadsheet programs must treat user-authored labels as data, never formulas.
  if (typeof value === "string" && /^[\s]*[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
/** One UTF-8 CSV contains named tables from the exact frozen, role-scoped report.
 * Integer cents retain their precision; every section carries the same cutoff/hash. */
export function boardPackCsv(report: BoardPackReport): string {
  const rows: unknown[][] = [["Fieldproof Board Pack", report.schemaVersion], ["Report", report.id], ["Title", report.label],
    ["Project", report.project.title], ["Audience", report.audience.label], ["Audience scope", report.audience.detail],
    ["Cutoff UTC", report.asOf], ["Content SHA-256", report.contentHash], ["Currency", "USD"], ["Amounts", "Integer cents; original receipts and current assignments are separate measures"], []];
  const section = (name: string, records: object[]) => {
    rows.push([name, report.asOf, report.contentHash]);
    if (!records.length) rows.push(["No rows in this audience's saved report"]);
    else { const keys = Object.keys(records[0]); rows.push(keys); for (const record of records) rows.push(keys.map(key => (record as Record<string, unknown>)[key])); }
    rows.push([]);
  };
  section("Project totals · public project aggregates", [report.totals.project]);
  section(`Original receipt totals · ${report.totals.receipts.scope}`, [report.totals.receipts]);
  section(`Current restricted position totals · ${report.totals.positions.scope}`, [report.totals.positions]);
  section("Packages · funding and reviewed work are separate", report.data.packages);
  section("Package versions, commitments and lifecycle", report.packages);
  section("Original receipts · all observed rails", report.data.settlements);
  section("Current-purpose positions · not new payments", report.data.funding_positions ?? []);
  section("Paired purpose changes", report.assignments);
  section("Expense allocation revisions · sum activeAllocationMinor only", report.data.allocations);
  section("Scoped expense and repayment records", report.expenses);
  section("Reviewed evidence · stated scope only", report.data.evidence);
  section("Exceptions · affected amounts overlap and are not additive", report.data.exceptions);
  section("Recorded balance evidence · no current spending authority", [report.balance]);
  section("Source index", report.sources);
  for (const notice of report.notices) rows.push(["Limitation", notice]);
  return `\ufeff${rows.map(row => row.map(cell).join(",")).join("\r\n")}\r\n`;
}
