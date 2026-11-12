import type { Row } from "./contracts";
import type { OriginalRows } from "./lineage";

const lifecycleKinds: Record<string, string> = {
  fp_lifecycle_preference_versions: "preference", fp_lifecycle_inbox: "inbox", fp_lifecycle_program_versions: "program",
  fp_lifecycle_schedule_versions: "definition", fp_lifecycle_schedule_events: "schedule-event", fp_lifecycle_snapshots: "snapshot",
  fp_lifecycle_contents: "content", fp_lifecycle_reviews: "review", fp_lifecycle_audit: "audit", fp_lifecycle_observer_heads: "observer",
};
const procurementKinds: Record<string, string> = {
  fp_procurement_supplier_versions: "supplier", fp_procurement_quote_versions: "quote", fp_package_operations: "operations", fp_package_operation_events: "operations-event",
  fp_procurement_responsibilities: "responsibility", fp_procurement_selections: "selection", fp_procurement_progress: "progress", fp_procurement_exceptions: "exception",
  fp_procurement_exception_events: "exception-event", fp_procurement_expense_links: "expense-link", fp_procurement_commands: "command", fp_procurement_reviews: "transition-review",
  fp_procurement_audit: "audit", fp_procurement_invites: "volunteer-invite", fp_procurement_access: "volunteer-identity", fp_procurement_entry_commands: "volunteer-command", fp_procurement_access_audit: "volunteer-audit",
};
/** The version here is the original encryption context, not the current head's
 * eligibility or a new restore version. Original ciphertext is never resealed. */
export function extensionPrivateContext(table: string, column: string, row: Row, _rows: OriginalRows): string | null {
  if (lifecycleKinds[table]) return `lifecycle:private-lifecycle-v1:${lifecycleKinds[table]}:${table === "fp_lifecycle_observer_heads" ? row.name : row.id}`;
  if (procurementKinds[table]) {
    let kind = procurementKinds[table], id = row.id, version: unknown = 1;
    if (table === "fp_procurement_supplier_versions") { id = row.supplier_id; version = row.version; }
    if (table === "fp_procurement_quote_versions") { id = row.quote_id; version = row.version; }
    if (table === "fp_package_operations") { id = row.package_id; version = row.version; }
    if (table === "fp_procurement_exception_events") { id = row.exception_id; version = row.version; }
    if (table === "fp_procurement_commands" || table === "fp_procurement_entry_commands") id = `${row.actor_id}:${row.intent_id}`;
    if (table === "fp_procurement_responsibilities" && column === "encrypted_response") { kind = "responsibility-response"; version = row.version; }
    if (table === "fp_procurement_invites" && column === "encrypted_token") kind = "volunteer-invite-token";
    if (table === "fp_procurement_access") kind = ({ encrypted_identity: "volunteer-identity", encrypted_acceptance: "volunteer-acceptance", encrypted_session_token: "volunteer-session", encrypted_return_token: "volunteer-return" } as Record<string, string>)[column];
    if (table === "fp_procurement_entry_commands" && column === "encrypted_recovery") kind = "volunteer-command-result";
    return `procurement:${row.tenant_id}:${row.project_id}:${kind}:${id}:${version}`;
  }
  if (table === "fp_recognition_consents") return `recognition-consent:${row.tenant_id}:${row.project_id}:${row.id}`;
  if (table === "fp_recognition_commands") return `recognition-command:${row.id}`;
  if (table === "fp_recognition_audit") return `recognition-audit:${row.id}`;
  return null;
}
export function authenticateExtensionNested(table: string, row: Row, opened: Row, read: (cipher: unknown, context: string) => unknown): void {
  if (table === "fp_recognition_commands" && row.action === "suppress") {
    const input = opened.encrypted_input as Row;
    opened.suppression_handle = read(input?.handle, "recognition-suppression-handle");
  }
}
