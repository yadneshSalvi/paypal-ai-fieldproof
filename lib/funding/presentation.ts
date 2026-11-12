import type { PackageView, WorkspaceRole } from "../contracts";
import type { FundingDesk } from "./contracts";

type PackageLifecycle = Pick<PackageView, "fundingState">;

export function packageFundingPresentation(item: PackageLifecycle) {
  const closed = item.fundingState === "cancelled" || item.fundingState === "compensating";
  return {
    closed,
    pledgeLabel: closed ? "historical pledge record" : "pledged",
    followHref: closed ? "/funding?view=decisions" : "/progress",
    followLabel: closed ? "View donor decisions" : "Follow the progress",
  };
}

export function canBackPackage(item: PackageLifecycle, role: WorkspaceRole): boolean {
  return role === "donor" && (item.fundingState === "open" || item.fundingState === "ready");
}

/** This only selects an affordance. The server rechecks complete collected
 * positions and started operations before allowing a window to close. */
export function fundingWindowAction(
  pkg: FundingDesk["packages"][number],
  policy: FundingDesk["policies"][number] | undefined,
  pledges: FundingDesk["pledges"],
  now = Date.now(),
): "review_expiry" | "close_empty" | null {
  if (!policy || ["cancelled", "compensating"].includes(pkg.state) ||
      !["open", "expired", "review_required"].includes(policy.state)) return null;
  if (Date.parse(policy.expiresAt) <= now) return "review_expiry";
  const hasPayment = pledges.some(pledge => pledge.packageId === pkg.id &&
    (pledge.collectedMinor > 0 || pledge.operationId !== null &&
      !["withdrawn", "collected", "partially_collected", "returned", "cancelled"].includes(pledge.state)));
  return pkg.state === "funded" || pkg.eligibleMinor > 0 || hasPayment ? null : "close_empty";
}
