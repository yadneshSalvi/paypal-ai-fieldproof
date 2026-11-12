import { DomainError } from "../domain/money";
import * as C from "./contracts";

const checked = (value: number, label: string) => { if (!Number.isSafeInteger(value)) throw new DomainError("PROCUREMENT_QUOTE_INVALID", `${label} exceeds supported exact integer arithmetic.`, 422); return value; };
/** Source-stated lines stay source-stated. Missing tax, discount, delivery or
 * a line price is unknown even when a partial sum can be calculated. */
export function quoteArithmetic(raw: C.QuoteDraft): C.QuoteArithmetic {
  const quote = C.quoteDraftSchema.parse(raw), missing: string[] = [], errors: string[] = [];
  let subtotal = 0, allLinesKnown = true;
  for (const line of quote.lines) {
    if (line.quantity === null) missing.push(`${line.key}: quantity not recorded`);
    if (line.unitMinor === null) missing.push(`${line.key}: unit price not recorded`);
    if (line.lineMinor === null) { missing.push(`${line.key}: line amount not recorded`); allLinesKnown = false; }
    else subtotal = checked(subtotal + line.lineMinor, "The quote subtotal");
    if (line.quantity !== null && line.unitMinor !== null && line.lineMinor !== null && checked(line.quantity * line.unitMinor, "A quantity × unit amount") !== line.lineMinor) errors.push(`${line.key}: quantity × unit price does not match the source line amount. Correct the declared values or retain this quote for clarification.`);
  }
  for (const [name, value] of [["Tax", quote.taxMinor], ["Delivery", quote.deliveryMinor], ["Discount", quote.discountMinor], ["Stated total", quote.statedTotalMinor]] as const) if (value === null) missing.push(`${name} not recorded`);
  const subtotalMinor = allLinesKnown ? subtotal : null;
  const total = subtotalMinor !== null && quote.taxMinor !== null && quote.deliveryMinor !== null && quote.discountMinor !== null ? checked(subtotalMinor + quote.taxMinor + quote.deliveryMinor - quote.discountMinor, "The complete quote amount") : null;
  if (total !== null && total < 0) errors.push("The declared discount exceeds the known subtotal, tax and delivery.");
  if (total !== null && total > 100_000_000) errors.push("The complete quote exceeds the supported package cost limit. It cannot be selected for new procurement.");
  const differenceMinor = total !== null && quote.statedTotalMinor !== null ? checked(quote.statedTotalMinor - total, "The quote difference") : null;
  if (differenceMinor !== null && differenceMinor !== 0) errors.push("The stated source total does not match its complete line, tax, delivery and discount components.");
  const packageCosts: C.QuoteArithmetic["packageCosts"] = quote.allocation.kind === "single_package" ? [{ packageId: quote.packageIds[0], amountMinor: quote.statedTotalMinor, basis: "source_total" }] : quote.allocation.shares.map(row => ({ packageId: row.packageId, amountMinor: row.amountMinor, basis: "reviewed_internal_share" }));
  const allocationTotalMinor = packageCosts.every(row => row.amountMinor !== null) ? checked(packageCosts.reduce((sum, row) => sum + row.amountMinor!, 0), "The reviewed internal cost shares") : null;
  if (allocationTotalMinor === null) missing.push("Complete package cost shares not recorded");
  if (allocationTotalMinor !== null && quote.statedTotalMinor !== null && allocationTotalMinor !== quote.statedTotalMinor) errors.push("The reviewed internal package shares do not reconcile to the complete quote total. The whole bundle amount cannot be counted once for every package.");
  const complete = total !== null && total >= 0 && quote.statedTotalMinor !== null && differenceMinor === 0 && !errors.length;
  return C.quoteArithmeticSchema.parse({ subtotalMinor, calculatedTotalMinor: total !== null && total >= 0 ? total : null, statedTotalMinor: quote.statedTotalMinor, differenceMinor, complete, allocationComplete: complete && allocationTotalMinor === quote.statedTotalMinor, allocationTotalMinor, packageCosts, missing, errors });
}
export interface QuoteComparisonRow {
  id: string; version: number; label: string; supplier: string; currency: string | null;
  knownTotalMinor: number | null; fullQuoteMinor: number | null; priceBasis: "source_total" | "reviewed_internal_share" | null; deltaToBudgetMinor: number | null;
  capabilityCoverage: { supported: number; required: number; unknown: string[]; conflicts: string[] };
  comparable: boolean; eligibleForSelection: boolean; reasons: string[];
  provenance: "sample" | "user_declared" | null; expiry: string | null; leadDays: number | null;
}
/** Compare exact scope/currency/provenance and reviewed capabilities. No
 * conversion, cheapest-is-best inference or supplier acceptance is invented. */
export function compareProcurementQuotes(input: { packageId: string; currency: string; budgetMinor: number; capabilities: string[]; observedAt: string; quotes: readonly C.QuoteView[] }): { groups: { currency: string | null; provenance: QuoteComparisonRow["provenance"]; rows: QuoteComparisonRow[] }[]; rows: QuoteComparisonRow[] } {
  if (!Number.isSafeInteger(input.budgetMinor) || input.budgetMinor < 0 || !Number.isFinite(Date.parse(input.observedAt))) throw new DomainError("PROCUREMENT_QUOTE_INVALID", "Compare against the exact current package and source cutoff.", 422);
  const seen = new Set<string>();
  const rows = input.quotes.map(raw => {
    const quote = C.quoteViewSchema.parse(raw); if (seen.has(quote.id)) throw new DomainError("PROCUREMENT_QUOTE_INVALID", "Each alternative needs one exact current quote version.", 422); seen.add(quote.id);
    const draft = quote.draft, arithmetic = draft ? quoteArithmetic(draft) : null, reasons = [...quote.reasons];
    const coverage = input.capabilities.map(capability => ({ capability, state: draft?.capabilityAssessment.find(row => row.capability === capability)?.state ?? "unknown" }));
    const unknown = coverage.filter(row => row.state === "unknown").map(row => row.capability), conflicts = coverage.filter(row => row.state === "conflict").map(row => row.capability);
    const packageCost = arithmetic?.packageCosts.find(row => row.packageId === input.packageId), amount = arithmetic?.complete && arithmetic.allocationComplete ? packageCost?.amountMinor ?? null : null, scoped = draft?.packageIds.includes(input.packageId) ?? false, sameCurrency = draft?.currency === input.currency;
    if (!scoped) reasons.push("This quote has no current scope for this package.");
    if (!sameCurrency) reasons.push("Keep this currency separate. No conversion to the canonical project budget has been reviewed.");
    if (!arithmetic?.complete) reasons.push("The complete declared quote cost needs review; a partial sum is not a known price.");
    if (!draft?.validUntil) reasons.push("The original quote validity deadline is unknown.");
    else if (Date.parse(draft.validUntil) <= Date.parse(input.observedAt)) reasons.push("The original quote deadline ended.");
    if (unknown.length) reasons.push("Some current package capabilities are unknown in this alternative.");
    if (conflicts.length) reasons.push("This alternative conflicts with a required current package capability.");
    if (quote.state !== "reviewed") reasons.push("Only a current explicitly reviewed quote can be selected for procurement.");
    if (!quote.sourceAvailable) reasons.push("The original source permission is unavailable.");
    const comparable = !!draft && scoped && sameCurrency && amount !== null;
    const eligibleForSelection = comparable && quote.state === "reviewed" && quote.sourceAvailable && !!draft.validUntil && Date.parse(draft.validUntil) > Date.parse(input.observedAt) && !unknown.length && !conflicts.length;
    return { id: quote.id, version: quote.version, label: draft?.title ?? "Source-withheld quote", supplier: quote.supplier?.name ?? "Supplier details withheld", currency: draft?.currency ?? null, knownTotalMinor: amount, fullQuoteMinor: arithmetic?.statedTotalMinor ?? null, priceBasis: packageCost?.basis ?? null, deltaToBudgetMinor: comparable ? checked(amount! - input.budgetMinor, "The package comparison") : null, capabilityCoverage: { supported: coverage.filter(row => row.state === "supported").length, required: coverage.length, unknown, conflicts }, comparable, eligibleForSelection, reasons, provenance: draft?.provenance ?? null, expiry: draft?.validUntil ?? null, leadDays: draft?.estimatedLeadDays ?? null } satisfies QuoteComparisonRow;
  });
  const groups = new Map<string, { currency: string | null; provenance: QuoteComparisonRow["provenance"]; rows: QuoteComparisonRow[] }>();
  for (const row of rows) { const key = `${row.currency ?? "unknown"}:${row.provenance ?? "unknown"}`, group = groups.get(key) ?? { currency: row.currency, provenance: row.provenance, rows: [] }; group.rows.push(row); groups.set(key, group); }
  return { groups: [...groups.values()], rows };
}
export function procurementAmountInput(value: string, currency: string): number | null {
  if (!value.trim()) return null;
  const places = new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  if (!new RegExp(`^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,${Math.max(places, 1)}})?$`).test(value.trim()) || places === 0 && value.includes(".")) throw new DomainError("PROCUREMENT_QUOTE_INVALID", "Enter an unambiguous nonnegative source amount in this currency's minor units.", 422);
  const [whole, fractional = ""] = value.trim().split("."), units = BigInt(whole) * 10n ** BigInt(places) + BigInt(fractional.padEnd(places, "0") || "0");
  if (units > 100_000_000n) throw new DomainError("PROCUREMENT_QUOTE_INVALID", "This declared quote amount exceeds the supported cost limit.", 422);
  return Number(units);
}
