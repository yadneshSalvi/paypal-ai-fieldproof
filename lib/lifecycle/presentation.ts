import { DomainError } from "../domain/money";
import * as C from "./contracts";

export type LifecycleLocale = "en" | "es";
const slots = /\{\{([a-z][a-z0-9_]*)\}\}/g;
const keys = (value: string) => [...value.matchAll(slots)].map(match => match[1]).sort();
export function lifecycleDate(value: string, locale: LifecycleLocale = "en"): string {
  if (!Number.isFinite(Date.parse(value))) return locale === "es" ? "Fecha no disponible" : "Date unavailable";
  return `${new Intl.DateTimeFormat(locale === "es" ? "es-US" : "en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value))} UTC`;
}
/** A redacted cutoff means permission is unavailable, not that capture failed. */
export function lifecycleCaptureText(row: C.LifecycleOccurrence): string {
  if (row.capturedAt) return lifecycleDate(row.capturedAt);
  if (row.state === "skipped_paused") return "No source was captured";
  if (row.status === "withdrawn" || row.status === "unavailable") {
    const recorded = row.state === "ready" || row.attempts.some(attempt => attempt.stage === "capture" && attempt.outcome === "succeeded");
    return recorded ? "Captured source is withheld; its original cutoff is not disclosed." : "Source capture details are withheld under the current permission.";
  }
  return "No successful source capture is recorded";
}
export function lifecycleValueText(raw: C.LifecycleValue, locale: LifecycleLocale = "en"): string {
  const value = C.lifecycleValueSchema.parse(raw), language = locale === "es" ? "es-US" : "en-US";
  if (value.kind === "money") {
    const format = new Intl.NumberFormat(language, { style: "currency", currency: value.currency, currencyDisplay: "code" }), places = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(value.minor / 10 ** places);
  }
  if (value.kind === "count") return new Intl.NumberFormat(language).format(value.count);
  if (value.kind === "date") return lifecycleDate(value.value, locale);
  if (value.kind === "label") return locale === "es" && value.spanish ? value.spanish : value.value;
  return locale === "es" ? "No consta" : "Not recorded";
}
/** Format exact protected scalar values only. This client-safe renderer has no
 * hashing/provider/DB dependency and never follows a source-supplied URL. */
export function renderLifecycleStatement(raw: C.LifecycleStatement, sources: readonly C.LifecycleSourceRow[], locale: LifecycleLocale = "en"): string {
  const statement = C.lifecycleStatementSchema.parse(raw), rows = new Map(sources.map(row => [row.id, row]));
  if (rows.size !== sources.length || statement.citations.some(citation => rows.get(citation.sourceId)?.contentHash !== citation.sourceHash)) throw new DomainError("LIFECYCLE_SOURCE_CHANGED", "Every sentence needs its exact captured scalar source.", 422);
  if (statement.values.some(value => rows.get(value.sourceId)?.contentHash !== value.sourceHash || !statement.citations.some(citation => citation.sourceId === value.sourceId && citation.sourceHash === value.sourceHash))) throw new DomainError("LIFECYCLE_SOURCE_CHANGED", "A protected value cannot refer outside this sentence's original citations.", 422);
  const expected = statement.values.map(value => value.key).sort();
  if (JSON.stringify(keys(statement.english)) !== JSON.stringify(expected) || JSON.stringify(keys(statement.spanish)) !== JSON.stringify(expected)) throw new DomainError("LIFECYCLE_SOURCE_CHANGED", "English, Spanish and protected source values must use the same exact placeholders.", 422);
  const template = locale === "es" ? statement.spanish : statement.english;
  if (/\{\{|\}\}/.test(template.replace(slots, ""))) throw new DomainError("LIFECYCLE_SOURCE_CHANGED", "An incomplete source placeholder needs review.", 422);
  const values = new Map(statement.values.map(value => [value.key, rows.get(value.sourceId)!]));
  return template.replace(slots, (_all, key: string) => lifecycleValueText(values.get(key)!.value, locale));
}
export function lifecycleEmailPreview(content: C.LifecycleContent, sources: readonly C.LifecycleSourceRow[]): C.LifecycleEmailPreview {
  return C.lifecycleEmailPreviewSchema.parse({ mode: "preview_only", sent: false, subject: content.title, english: content.statements.map(statement => renderLifecycleStatement(statement, sources, "en")), spanish: content.statements.map(statement => renderLifecycleStatement(statement, sources, "es")), sourceHash: content.sourceHash, spanishStatus: "authored_unreviewed", destination: null, notices: ["Email preview only. No email was sent, and no address or delivery permission was collected.", "Spanish wording is authored and has not received a fluent-language review."] });
}
export const lifecycleProvenanceLabels: Record<C.LifecycleProvenance, string> = { sample: "Sample · fictional", live_sandbox: "Live · Sandbox", replay: "Replay · recorded", modelled: "Modelled · scenario" };
export const lifecycleEventLabels: Record<C.LifecycleEventKind, string> = {
  pledge_saved: "Your pledge is saved", pledge_withdrawn: "Your unpaid pledge was withdrawn", pledge_expired: "Your pledge window ended",
  contribution_collected: "Your payment was recorded", contribution_return_pending: "Your return is still pending", contribution_returned: "Your return was recorded", contribution_moved: "Your support has a new purpose", purpose_cancelled: "Your package was cancelled",
  repayment_pending: "Your repayment is pending", repayment_completed: "Your repayment was recorded as completed", repayment_failed: "Your repayment needs attention", repayment_returned: "Your repayment was returned", repayment_action_required: "Your repayment needs your attention", repayment_unknown: "Your repayment outcome is being checked",
};
export const lifecycleOccurrenceLabels: Record<C.LifecycleOccurrence["state"], string> = {
  due: "Scheduled slot is due", capturing: "Capturing current permitted facts", drafting: "Preparing cited private draft", ready: "Private draft ready", retry_wait: "Waiting to retry the same occurrence", skipped_paused: "Paused slot skipped", blocked_authority: "Original authority ended", blocked_source: "Original source is unavailable", expired: "Original deadline ended", cancelled: "Scheduled slot cancelled", failed: "Draft preparation needs attention",
};
