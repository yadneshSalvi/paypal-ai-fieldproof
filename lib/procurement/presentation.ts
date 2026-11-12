import type { ProcurementState } from "./contracts";

export const operationsLabels: Record<ProcurementState, string> = { draft: "Operational draft", approved: "Plan for procurement reviewed", procurement_ready: "Ready for procurement review", in_progress: "Work reported in progress", review_pending: "Awaiting current work review", accepted: "Operational acceptance recorded", blocked: "Work blocked", canceled: "Operations cancelled", reopened: "New cycle reopened" };
export const operationsActionLabels: Record<ProcurementState, string> = { draft: "Return for edits", approved: "Review operational plan", procurement_ready: "Check procurement readiness", in_progress: "Report work starting", review_pending: "Request work review", accepted: "Review operational acceptance", blocked: "Record a block", canceled: "Cancel operational work", reopened: "Review a new operational cycle" };
export const procurementDate = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? `${new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }).format(new Date(value))} UTC` : "Not recorded";
export const procurementMoney = (minor: number | null, currency: string) => {
  if (minor === null) return "Not recorded";
  const format = new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "code" }), exponent = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(minor / 10 ** exponent);
};
