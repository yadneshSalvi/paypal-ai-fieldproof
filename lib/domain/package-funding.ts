import type { FundingState, Provenance } from "../contracts";
import { assertMinor, DomainError } from "./money";

const labels: Record<FundingState, string> = {
  open: "Open for pledges", ready: "Ready to collect", collecting: "Collecting contributions",
  recovering: "Recovery in progress", funded: "Collected", funding_review: "Funding needs review",
  compensating: "Returning contributions", cancelled: "Cancelled",
};
export const fundingStateLabel = (state: FundingState): string => labels[state];

/** A current read-model decision, not authority to send a payment. Historical
 * credit alone cannot reopen a closed package or replace a current live round. */
export function assessPackageFunding(input: {
  state: FundingState; version: number; budgetMinor: number; eligibleMinor: number; provenance: Provenance;
  round?: { packageVersion: number; state: string } | undefined;
}): { state: FundingState; complete: boolean } {
  assertMinor(input.budgetMinor, false); assertMinor(input.eligibleMinor);
  if (!Number.isSafeInteger(input.version) || input.version < 1 || !Object.hasOwn(labels, input.state))
    throw new DomainError("PACKAGE_FUNDING_POLICY", "The package needs a valid current funding policy before its collection can be qualified.");
  if (input.state === "cancelled" || input.state === "compensating") return { state: input.state, complete: false };
  const round = input.round?.packageVersion === input.version ? input.round : undefined;
  if (round?.state === "cancelled" || round?.state === "compensating") return { state: round.state, complete: false };
  const financialMode = input.provenance === "live_sandbox" || input.provenance === "sample";
  const complete = financialMode && input.eligibleMinor >= input.budgetMinor && (round?.state === "funded" || (input.provenance === "sample" && !input.round));
  if (complete) return { state: "funded", complete: true };
  if (round?.state === "collecting" || round?.state === "recovering") return { state: round.state, complete: false };
  if (input.state === "funded" || round?.state === "funded" || input.eligibleMinor >= input.budgetMinor)
    return { state: "funding_review", complete: false };
  return { state: input.state, complete: false };
}
