import type { FundingTotals, Provenance, SettlementReceipt } from "../contracts";
import { assertMinor, DomainError, validateReceipt } from "./money";

export interface FundingSource { receipt: SettlementReceipt; version: number }
export interface FundingScope { tenantId: string; projectId: string; provenance: Provenance }
export interface FundingAssignment {
  id: string; receiptId: string; sequence: number;
  kind: "reallocation" | "rollover" | "reversal"; reversesId: string | null;
  tenantId: string; projectId: string; provenance: Provenance; currency: "USD"; amountMinor: number;
  /** One atomic journal record contains BOTH sides. Neither side is a receipt. */
  debit: { packageId: string; packageVersion: number };
  credit: { packageId: string; packageVersion: number };
  consentId: string; consentDigest: string; donorActorId: string;
  consentedAt: string; consentExpiresAt: string; committedAt: string;
}
export interface FundingDeductions {
  receiptId: string; receiptVersion: number;
  /** Complete attribution of current receipt counters, never an extra debit. */
  positions: { packageId: string; refundedMinor: number; pendingRefundMinor: number; excludedMinor: number }[];
}
export interface FundingUse {
  id: string; receiptId: string; packageId: string; state: "reserved" | "paid"; amountMinor: number;
}
export interface FundingPosition {
  receiptId: string; receiptVersion: number; originalPackageId: string; donorObligationId: string;
  packageId: string; sourceKind: SettlementReceipt["sourceKind"];
  assignedMinor: number; refundedMinor: number; pendingRefundMinor: number; excludedMinor: number;
  collectedMinor: number; fundingEligibleMinor: number; reservedMinor: number; paidMinor: number;
  availableMinor: number; excessLiabilityMinor: number; assignmentIds: string[];
}
function fail(code: string, message: string): never { throw new DomainError(code, message); }
function id(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 240)
    fail("FUNDING_IDENTITY", "A funding position needs its complete saved identity.");
}
function version(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) fail("FUNDING_VERSION", "A funding position needs its current saved version.");
}
function add(a: number, b: number): number { const result = a + b; assertMinor(result); return result; }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Canonical, all-rail projection. Economic receipts retain original lineage;
 * paired assignments move restricted credit, never copy a payment. The caller
 * supplies the COMPLETE source journal and expense uses. Later source refunds
 * without complete current attribution require reconciliation. This projects
 * recorded facts; it does not authorize a new transfer. */
export function projectFundingPositions(input: {
  sources: FundingSource[]; assignments: FundingAssignment[]; deductions: FundingDeductions[]; uses: FundingUse[];
}, scope: FundingScope): { positions: FundingPosition[]; totals: FundingTotals; reservedMinor: number; paidMinor: number; availableMinor: number } {
  const sources = new Map<string, FundingSource>(), aliases = new Set<string>();
  const positions = new Map<string, Map<string, FundingPosition>>();
  let excessLiabilityMinor = 0;
  const position = (receiptId: string, packageId: string): FundingPosition => {
    id(packageId);
    const source = sources.get(receiptId);
    if (!source) return fail("FUNDING_SOURCE_MISSING", "An allocation refers to a payment outside this complete source set.");
    let byPackage = positions.get(receiptId);
    if (!byPackage) positions.set(receiptId, byPackage = new Map());
    let row = byPackage.get(packageId);
    if (!row) {
      const receipt = source.receipt;
      row = { receiptId, receiptVersion: source.version, originalPackageId: receipt.packageId,
        donorObligationId: receipt.donorObligationId, packageId, sourceKind: receipt.sourceKind,
        assignedMinor: 0, refundedMinor: 0, pendingRefundMinor: 0, excludedMinor: 0,
        collectedMinor: 0, fundingEligibleMinor: 0, reservedMinor: 0, paidMinor: 0,
        availableMinor: 0, excessLiabilityMinor: packageId === receipt.packageId ? receipt.excessLiabilityMinor : 0, assignmentIds: [] };
      byPackage.set(packageId, row);
    }
    return row;
  };
  for (const source of input.sources) {
    const receipt = source.receipt;
    validateReceipt(receipt); id(receipt.id); id(receipt.packageId); id(receipt.donorObligationId); version(source.version);
    if (receipt.tenantId !== scope.tenantId || receipt.projectId !== scope.projectId || receipt.provenance !== scope.provenance)
      fail("FUNDING_SCOPE", "Every payment must belong to the exact workspace and source mode.");
    if (sources.has(receipt.id)) fail("DUPLICATE_PAYMENT_ALIAS", "The same economic payment cannot be assigned twice.");
    for (const alias of receipt.economicAliases) {
      id(alias);
      if (aliases.has(alias)) fail("DUPLICATE_PAYMENT_ALIAS", "The same economic payment cannot be assigned twice.");
      aliases.add(alias);
    }
    sources.set(receipt.id, source);
    position(receipt.id, receipt.packageId).assignedMinor = receipt.creditedMinor;
    excessLiabilityMinor = add(excessLiabilityMinor, receipt.excessLiabilityMinor);
  }
  const assignments = new Map<string, FundingAssignment>(), lastSequence = new Map<string, number>(), reversed = new Map<string, number>();
  for (const entry of [...input.assignments].sort((a,b) => compare(a.receiptId,b.receiptId) || a.sequence-b.sequence)) {
    [entry.id, entry.receiptId, entry.consentId, entry.donorActorId].forEach(id);
    version(entry.sequence); version(entry.debit.packageVersion); version(entry.credit.packageVersion); assertMinor(entry.amountMinor, false);
    if (entry.tenantId !== scope.tenantId || entry.projectId !== scope.projectId || entry.provenance !== scope.provenance || entry.currency !== "USD")
      fail("FUNDING_SCOPE", "Every assignment must belong to the exact workspace, currency and source mode.");
    if (assignments.has(entry.id) || entry.sequence !== (lastSequence.get(entry.receiptId) ?? 0) + 1)
      fail("FUNDING_JOURNAL_GAP", "The complete, unique funding journal is required in sequence.");
    if (!/^[a-f0-9]{64}$/.test(entry.consentDigest)) fail("FUNDING_CONSENT", "The recorded donor consent must have a complete digest.");
    const consented = Date.parse(entry.consentedAt), expires = Date.parse(entry.consentExpiresAt), committed = Date.parse(entry.committedAt);
    if (![consented,expires,committed].every(Number.isFinite) || committed < consented || committed >= expires)
      fail("FUNDING_CONSENT", "This assignment was not committed within its recorded donor consent.");
    if (!["reallocation","rollover","reversal"].includes(entry.kind) || entry.debit.packageId === entry.credit.packageId)
      fail("FUNDING_ASSIGNMENT", "A paired assignment must name two different restricted purposes.");
    if (entry.kind === "reversal") {
      const original = entry.reversesId ? assignments.get(entry.reversesId) : null;
      if (!original || original.kind === "reversal" || original.receiptId !== entry.receiptId || original.debit.packageId !== entry.credit.packageId || original.credit.packageId !== entry.debit.packageId)
        fail("FUNDING_REVERSAL", "A reversal must identify the exact prior assignment and its opposite sides.");
      const amount = add(reversed.get(original.id) ?? 0, entry.amountMinor);
      if (amount > original.amountMinor) fail("FUNDING_REVERSAL", "Reversals cannot exceed their original paired assignment.");
      reversed.set(original.id, amount);
    } else if (entry.reversesId !== null) fail("FUNDING_REVERSAL", "Only a reversal can refer to a prior assignment.");
    const debit = position(entry.receiptId, entry.debit.packageId), credit = position(entry.receiptId, entry.credit.packageId);
    if (debit.assignedMinor < entry.amountMinor) fail("FUNDING_OVERDRAWN", "An assignment exceeds the source purpose's recorded credit.");
    debit.assignedMinor -= entry.amountMinor; credit.assignedMinor = add(credit.assignedMinor, entry.amountMinor);
    debit.assignmentIds.push(entry.id); credit.assignmentIds.push(entry.id);
    assignments.set(entry.id, entry); lastSequence.set(entry.receiptId, entry.sequence);
  }
  const attributed = new Map<string, FundingDeductions>();
  for (const attribution of input.deductions) {
    const source = sources.get(attribution.receiptId);
    if (!source || attributed.has(attribution.receiptId) || attribution.receiptVersion !== source.version)
      fail("FUNDING_ATTRIBUTION_VERSION", "Refund attribution must match one complete current receipt version.");
    attributed.set(attribution.receiptId, attribution);
  }
  for (const {receipt,version:receiptVersion} of sources.values()) {
    if (lastSequence.has(receipt.id) && !attributed.has(receipt.id) &&
        (receipt.completedAttributedRefundMinor || receipt.pendingAttributedRefundReserveMinor || receipt.excludedMinor))
      fail("FUNDING_ATTRIBUTION_REQUIRED", "A reassigned payment needs explicit attribution of every current return, reserve and exclusion.");
    const attribution = attributed.get(receipt.id) ?? { receiptId:receipt.id,receiptVersion,positions:[{
      packageId:receipt.packageId,refundedMinor:receipt.completedAttributedRefundMinor,
      pendingRefundMinor:receipt.pendingAttributedRefundReserveMinor,excludedMinor:receipt.excludedMinor,
    }] };
    const used = new Set<string>(); let returned = 0, pending = 0, excluded = 0;
    for (const part of attribution.positions) {
      if (used.has(part.packageId)) fail("FUNDING_ATTRIBUTION_DUPLICATE", "Each restricted purpose appears once in refund attribution.");
      used.add(part.packageId);
      [part.refundedMinor,part.pendingRefundMinor,part.excludedMinor].forEach(value=>assertMinor(value));
      const row = position(receipt.id,part.packageId);
      row.refundedMinor = part.refundedMinor; row.pendingRefundMinor = part.pendingRefundMinor; row.excludedMinor = part.excludedMinor;
      returned=add(returned,part.refundedMinor); pending=add(pending,part.pendingRefundMinor); excluded=add(excluded,part.excludedMinor);
    }
    if (returned !== receipt.completedAttributedRefundMinor || pending !== receipt.pendingAttributedRefundReserveMinor || excluded !== receipt.excludedMinor)
      fail("FUNDING_ATTRIBUTION_TOTAL", "Package deductions must exactly match the original payment's current counters.");
  }
  const uses = new Set<string>();
  for (const use of input.uses) {
    id(use.id); assertMinor(use.amountMinor,false);
    if (uses.has(use.id) || !["reserved","paid"].includes(use.state)) fail("FUNDING_USE_IDENTITY", "Every committed expense use must have one saved state and identity.");
    uses.add(use.id);
    const row=position(use.receiptId,use.packageId), key=use.state === "reserved" ? "reservedMinor" : "paidMinor";
    row[key]=add(row[key],use.amountMinor);
  }
  const rows=[...positions.values()].flatMap(map=>[...map.values()]).sort((a,b)=>compare(a.receiptId,b.receiptId)||compare(a.packageId,b.packageId));
  let collectedMinor=0,fundingEligibleMinor=0,pendingRefundMinor=0,reservedMinor=0,paidMinor=0,availableMinor=0;
  for (const row of rows) {
    row.collectedMinor=row.assignedMinor-row.refundedMinor;
    row.fundingEligibleMinor=row.collectedMinor-row.pendingRefundMinor-row.excludedMinor;
    row.availableMinor=row.fundingEligibleMinor-row.reservedMinor-row.paidMinor;
    if (![row.collectedMinor,row.fundingEligibleMinor,row.availableMinor].every(value=>Number.isSafeInteger(value)&&value>=0))
      fail("FUNDING_RECONCILIATION_REQUIRED", "Source returns, transfers and committed spending need reconciliation before these funds can be used.");
    collectedMinor=add(collectedMinor,row.collectedMinor);fundingEligibleMinor=add(fundingEligibleMinor,row.fundingEligibleMinor);
    pendingRefundMinor=add(pendingRefundMinor,row.pendingRefundMinor);reservedMinor=add(reservedMinor,row.reservedMinor);
    paidMinor=add(paidMinor,row.paidMinor);availableMinor=add(availableMinor,row.availableMinor);
  }
  return { positions:rows,totals:{collectedMinor,fundingEligibleMinor,shortfallMinor:0,pendingRefundMinor,excessLiabilityMinor},reservedMinor,paidMinor,availableMinor };
}

export function packagePositionTotals(positions: FundingPosition[], packageId: string, targetMinor: number): FundingTotals {
  id(packageId); assertMinor(targetMinor);
  const selected=positions.filter(position=>position.packageId===packageId);
  const total=(key:"collectedMinor"|"fundingEligibleMinor"|"pendingRefundMinor"|"excessLiabilityMinor")=>selected.reduce((sum,row)=>add(sum,row[key]),0);
  const fundingEligibleMinor=total("fundingEligibleMinor");
  return {collectedMinor:total("collectedMinor"),fundingEligibleMinor,shortfallMinor:Math.max(0,targetMinor-fundingEligibleMinor),pendingRefundMinor:total("pendingRefundMinor"),excessLiabilityMinor:total("excessLiabilityMinor")};
}
