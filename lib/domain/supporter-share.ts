import type { StoryBudget, StoryShare } from "../community/supporter-contracts";
import { assertMinor } from "./money";

export function contributionShare(numeratorMinor: number, denominatorMinor: number, basis: StoryShare["basis"]): StoryShare {
  assertMinor(numeratorMinor); assertMinor(denominatorMinor, false);
  const numerator = BigInt(numeratorMinor) * 100n, denominator = BigInt(denominatorMinor);
  let a = numerator, b = denominator;
  while (b) { const remainder = a % b; a = b; b = remainder; }
  const divisor = a || 1n;
  return { numeratorMinor, denominatorMinor, percentNumerator: String(numerator / divisor), percentDenominator: String(denominator / divisor),
    percentTenths: String((numerator * 10n + denominator / 2n) / denominator), basis };
}

export type BudgetCandidate = Omit<StoryBudget, "status"> & { amountMinor: number; version: number };
/** No current-version fallback: missing old evidence stays missing. A changed
 * amount under the same version is a conflict, not a choice of nicer totals. */
export function bindStoryBudget(packageId: string, version: number | null, candidates: BudgetCandidate[], fallback: { title: string; purpose?: string | null }): StoryBudget {
  const missing: StoryBudget = { packageId, version, title: fallback.title, purpose: fallback.purpose ?? null, amountMinor: null,
    status: "missing", basis: "unavailable", sourceHashes: [], review: { status: "missing", scope: "Package budget review", reviewerLabel: null, reviewedAt: null, sourceHash: null } };
  if (version === null) return missing;
  const exact = candidates.filter(candidate => candidate.packageId === packageId && candidate.version === version);
  if (!exact.length) return missing;
  exact.forEach(candidate => assertMinor(candidate.amountMinor, false));
  const hashes = [...new Set(exact.flatMap(candidate => candidate.sourceHashes))].sort();
  if (new Set(exact.map(candidate => candidate.amountMinor)).size > 1)
    return { ...missing, status: "conflict", sourceHashes: hashes };
  const rank = { saved_purpose: 0, saved_plan: 1, current_package: 2, unavailable: 3 };
  const selected = [...exact].sort((a,b) => rank[a.basis] - rank[b.basis])[0];
  const reviewed = exact.find(candidate => ["recorded", "sample"].includes(candidate.review.status));
  return { ...selected, status: "bound", sourceHashes: hashes, review: reviewed?.review ?? selected.review };
}
