import { EXTENSION_TABLES } from "./extensions";
import type { Catalog, Row } from "./contracts";
import { canonical, digest, requireOperation, SCHEMA_VERSIONS } from "./contracts";

export interface TableContract { readonly name: string; readonly keys: readonly string[]; readonly family: string; readonly source: string; readonly privateColumns: readonly string[]; }
/** Frozen schema21 base, qualified in dbafefab. No prefix wildcard admits future families. */
export const SCHEMA21_TABLES = [
  {"name": "fp_ai_attempts", "keys": ["run_id", "attempt"], "family": "core", "source": "lib/server/db.ts", "privateColumns": ["encrypted_result"]},
  {"name": "fp_ai_runs", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": ["encrypted_input", "encrypted_output"]},
  {"name": "fp_allocation_revisions", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_approval_records", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_balance_observations", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_board_pack_audit", "keys": ["id"], "family": "board-pack", "source": "lib/server/board-pack-schema.ts", "privateColumns": []},
  {"name": "fp_board_packs", "keys": ["id"], "family": "board-pack", "source": "lib/server/board-pack-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_claim_line_reviews", "keys": ["claim_id", "claim_line_id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_claim_revisions", "keys": ["claim_id", "version"], "family": "core", "source": "lib/server/db.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_claims", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_collection_items", "keys": ["round_id", "consent_id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_collection_rounds", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_community_actions", "keys": ["tenant_id", "actor_id", "intent_id"], "family": "community", "source": "lib/server/community-schema.ts", "privateColumns": ["encrypted_result"]},
  {"name": "fp_community_backtranslations", "keys": ["id"], "family": "community", "source": "lib/server/community-schema.ts", "privateColumns": ["encrypted_content"]},
  {"name": "fp_community_drafts", "keys": ["id"], "family": "community", "source": "lib/server/community-schema.ts", "privateColumns": ["encrypted_content"]},
  {"name": "fp_community_model_observations", "keys": ["id"], "family": "community", "source": "lib/server/community-schema.ts", "privateColumns": ["encrypted_content"]},
  {"name": "fp_community_runs", "keys": ["id"], "family": "community", "source": "lib/server/community-schema.ts", "privateColumns": ["encrypted_input", "encrypted_response_id", "encrypted_output"]},
  {"name": "fp_community_snapshots", "keys": ["id"], "family": "community", "source": "lib/server/community-schema.ts", "privateColumns": ["encrypted_source"]},
  {"name": "fp_community_translation_heads", "keys": ["draft_id"], "family": "community", "source": "lib/server/community-schema.ts", "privateColumns": []},
  {"name": "fp_community_translation_reviews", "keys": ["id"], "family": "community", "source": "lib/server/community-schema.ts", "privateColumns": ["encrypted_note"]},
  {"name": "fp_community_translations", "keys": ["id"], "family": "community", "source": "lib/server/community-schema.ts", "privateColumns": ["encrypted_content"]},
  {"name": "fp_community_update_previews", "keys": ["id"], "family": "community", "source": "lib/server/community-schema.ts", "privateColumns": []},
  {"name": "fp_conditional_consents", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": ["encrypted_wallet"]},
  {"name": "fp_documents", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_economic_aliases", "keys": ["merchant_scope", "alias"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_events", "keys": ["sequence"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_evidence", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_funding_actions", "keys": ["tenant_id", "actor_id", "intent_id"], "family": "funding-lifecycle", "source": "lib/server/funding-lifecycle-schema.ts", "privateColumns": []},
  {"name": "fp_funding_assignments", "keys": ["id"], "family": "funding", "source": "lib/server/funding-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_funding_case_events", "keys": ["id"], "family": "funding-lifecycle", "source": "lib/server/funding-lifecycle-schema.ts", "privateColumns": []},
  {"name": "fp_funding_cases", "keys": ["id"], "family": "funding-lifecycle", "source": "lib/server/funding-lifecycle-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_funding_choices", "keys": ["id"], "family": "funding-lifecycle", "source": "lib/server/funding-lifecycle-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_funding_deductions", "keys": ["receipt_id", "receipt_version"], "family": "funding", "source": "lib/server/funding-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_funding_external_returns", "keys": ["id"], "family": "funding-reconciliation", "source": "lib/server/funding-reconciliation-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_funding_policies", "keys": ["id"], "family": "funding-lifecycle", "source": "lib/server/funding-lifecycle-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_funding_reconciliation_consents", "keys": ["id"], "family": "funding-reconciliation", "source": "lib/server/funding-reconciliation-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_funding_reconciliations", "keys": ["id"], "family": "funding-reconciliation", "source": "lib/server/funding-reconciliation-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_funding_return_holds", "keys": ["id"], "family": "funding-reconciliation", "source": "lib/server/funding-reconciliation-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_funding_return_observations", "keys": ["id"], "family": "funding-reconciliation", "source": "lib/server/funding-reconciliation-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_identity_states", "keys": ["state_hash"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_invoice_payment_observations", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_journal", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_memberships", "keys": ["project_id", "actor_id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_merchant_journal", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_obligations", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_org_access", "keys": ["id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_org_audit", "keys": ["id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_org_commands", "keys": ["actor_key", "intent_id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": ["encrypted_recovery"]},
  {"name": "fp_org_invitations", "keys": ["id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": ["encrypted_token", "encrypted_label"]},
  {"name": "fp_org_libraries", "keys": ["id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": []},
  {"name": "fp_org_library_entries", "keys": ["id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_org_memberships", "keys": ["id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": ["encrypted_identity"]},
  {"name": "fp_org_policies", "keys": ["id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": ["encrypted_draft"]},
  {"name": "fp_org_policy_versions", "keys": ["id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": ["encrypted_definition"]},
  {"name": "fp_org_portfolio_audit", "keys": ["id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": []},
  {"name": "fp_org_portfolios", "keys": ["id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_org_project_consents", "keys": ["id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_org_project_links", "keys": ["id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": []},
  {"name": "fp_org_sessions", "keys": ["id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": []},
  {"name": "fp_organizations", "keys": ["id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": []},
  {"name": "fp_outbox", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_packages", "keys": ["project_id", "id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_payable_approval_intents", "keys": ["tenant_id", "actor_id", "intent_id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_payable_lines", "keys": ["payable_id", "claim_line_id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_payable_reviews", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_payables", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_payment_commands", "keys": ["operation_id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_payout_observations", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_photo_alignments", "keys": ["id"], "family": "planning", "source": "lib/server/planning-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_plan_provider_observations", "keys": ["id"], "family": "planning", "source": "lib/server/planning-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_plan_publications", "keys": ["id"], "family": "planning", "source": "lib/server/planning-schema.ts", "privateColumns": []},
  {"name": "fp_plan_reviews", "keys": ["id"], "family": "planning", "source": "lib/server/planning-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_plan_run_attempts", "keys": ["run_id", "attempt"], "family": "planning", "source": "lib/server/planning-schema.ts", "privateColumns": ["encrypted_result"]},
  {"name": "fp_plan_runs", "keys": ["id"], "family": "planning", "source": "lib/server/planning-schema.ts", "privateColumns": ["encrypted_input", "encrypted_output", "encrypted_checkpoint"]},
  {"name": "fp_plan_source_controls", "keys": ["document_id"], "family": "planning", "source": "lib/server/planning-schema.ts", "privateColumns": []},
  {"name": "fp_plan_versions", "keys": ["id"], "family": "planning", "source": "lib/server/planning-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_planning_actions", "keys": ["tenant_id", "actor_id", "intent_id"], "family": "planning", "source": "lib/server/planning-schema.ts", "privateColumns": ["encrypted_input"]},
  {"name": "fp_planning_heads", "keys": ["project_id"], "family": "planning", "source": "lib/server/planning-schema.ts", "privateColumns": []},
  {"name": "fp_project_governance_heads", "keys": ["tenant_id", "project_id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": []},
  {"name": "fp_project_package_revisions", "keys": ["id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_project_policy_adoptions", "keys": ["id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": ["encrypted_rule"]},
  {"name": "fp_project_policy_artifacts", "keys": ["id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_project_policy_subjects", "keys": ["id"], "family": "organization", "source": "lib/server/organization-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_projects", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_proof_derivatives", "keys": ["id"], "family": "proof", "source": "lib/server/proof-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_proof_heads", "keys": ["project_id", "package_id"], "family": "proof", "source": "lib/server/proof-schema.ts", "privateColumns": []},
  {"name": "fp_proof_snapshots", "keys": ["id"], "family": "proof", "source": "lib/server/proof-schema.ts", "privateColumns": ["encrypted_bindings"]},
  {"name": "fp_provider_operations", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_provider_orders", "keys": ["order_id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_purpose_pledges", "keys": ["id"], "family": "purpose", "source": "lib/server/purpose-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_receipt_allocations", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_receipt_comparison_decisions", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_receipt_group_documents", "keys": ["document_id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_receipt_group_lines", "keys": ["group_id", "line_key"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_receipt_groups", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_recipient_accounts", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": ["encrypted_destination"]},
  {"name": "fp_recovery_invoices", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_refunds", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_request_buckets", "keys": ["bucket_key"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_request_leases", "keys": ["id"], "family": "runtime-control", "source": "lib/server/runtime-control.ts", "privateColumns": []},
  {"name": "fp_reviewer_invites", "keys": ["id"], "family": "planning", "source": "lib/server/planning-schema.ts", "privateColumns": ["encrypted_data", "encrypted_session_token"]},
  {"name": "fp_reviewer_qualifications", "keys": ["id"], "family": "planning", "source": "lib/server/planning-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_runtime_control", "keys": ["key"], "family": "runtime-control", "source": "lib/server/runtime-control.ts", "privateColumns": []},
  {"name": "fp_runtime_control_events", "keys": ["id"], "family": "runtime-control", "source": "lib/server/runtime-control.ts", "privateColumns": []},
  {"name": "fp_sample_funding_origins", "keys": ["id"], "family": "purpose", "source": "lib/server/purpose-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_sample_funding_use_evidence", "keys": ["allocation_id"], "family": "funding-reconciliation", "source": "lib/server/funding-reconciliation-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_schema_versions", "keys": ["version"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_sessions", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_settlement_receipts", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_sponsor_acceptances", "keys": ["id"], "family": "purpose", "source": "lib/server/purpose-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_sponsor_events", "keys": ["id"], "family": "purpose", "source": "lib/server/purpose-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_sponsor_offers", "keys": ["id"], "family": "purpose", "source": "lib/server/purpose-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_studio_agent_runs", "keys": ["id"], "family": "studio", "source": "lib/server/studio-schema.ts", "privateColumns": ["encrypted_input", "encrypted_transcript"]},
  {"name": "fp_studio_chat_threads", "keys": ["id"], "family": "studio", "source": "lib/server/studio-schema.ts", "privateColumns": ["encrypted_summary", "encrypted_thread"]},
  {"name": "fp_studio_layout_events", "keys": ["id"], "family": "studio", "source": "lib/server/studio-schema.ts", "privateColumns": ["encrypted_summary"]},
  {"name": "fp_studio_reports", "keys": ["id"], "family": "studio", "source": "lib/server/studio-schema.ts", "privateColumns": ["encrypted_history"]},
  {"name": "fp_studio_snapshots", "keys": ["id"], "family": "studio", "source": "lib/server/studio-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_studio_tool_receipts", "keys": ["id"], "family": "studio", "source": "lib/server/studio-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_supporter_access", "keys": ["id"], "family": "supporter-access", "source": "lib/server/supporter-access-schema.ts", "privateColumns": ["encrypted_identity", "encrypted_acceptance", "encrypted_session_token", "encrypted_recovery_token"]},
  {"name": "fp_supporter_access_audit", "keys": ["id"], "family": "supporter-access", "source": "lib/server/supporter-access-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_supporter_commands", "keys": ["tenant_id", "actor_id", "intent_id"], "family": "supporter-access", "source": "lib/server/supporter-access-schema.ts", "privateColumns": ["encrypted_input"]},
  {"name": "fp_supporter_invites", "keys": ["id"], "family": "supporter-access", "source": "lib/server/supporter-access-schema.ts", "privateColumns": ["encrypted_token", "encrypted_data"]},
  {"name": "fp_tenants", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_transfer_webhook_archive", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_webhook_jobs", "keys": ["inbox_id", "event_id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_work_signoffs", "keys": ["id"], "family": "planning", "source": "lib/server/planning-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_workspace_creation_intents", "keys": ["library_id", "intent_id"], "family": "community", "source": "lib/server/community-schema.ts", "privateColumns": []},
  {"name": "fp_workspace_handoffs", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_workspace_imports", "keys": ["id"], "family": "core", "source": "lib/server/db.ts", "privateColumns": []},
  {"name": "fp_workspace_libraries", "keys": ["id"], "family": "community", "source": "lib/server/community-schema.ts", "privateColumns": []},
  {"name": "fp_workspace_library_entries", "keys": ["library_id", "session_id"], "family": "community", "source": "lib/server/community-schema.ts", "privateColumns": ["encrypted_token"]},
  {"name": "fp_workspace_switch_events", "keys": ["id"], "family": "community", "source": "lib/server/community-schema.ts", "privateColumns": []},
  {"name": "paycore_attempts", "keys": ["id"], "family": "payment-core", "source": "vendor/fracture-paypal-core-0.2.7.tgz", "privateColumns": ["document"]},
  {"name": "paycore_operations", "keys": ["tenant_id", "project_id", "id"], "family": "payment-core", "source": "vendor/fracture-paypal-core-0.2.7.tgz", "privateColumns": ["document"]},
  {"name": "paycore_resource_locks", "keys": ["tenant_id", "project_id", "resource_key"], "family": "payment-core", "source": "vendor/fracture-paypal-core-0.2.7.tgz", "privateColumns": []},
  {"name": "paycore_webhook_deliveries", "keys": ["id"], "family": "payment-core", "source": "vendor/fracture-paypal-core-0.2.7.tgz", "privateColumns": ["document"]},
  {"name": "paycore_webhook_events", "keys": ["tenant_id", "project_id", "event_id"], "family": "payment-core", "source": "vendor/fracture-paypal-core-0.2.7.tgz", "privateColumns": ["document"]}
] as const satisfies readonly TableContract[];
export const CURRENT_TABLES: readonly TableContract[] = [...SCHEMA21_TABLES, ...EXTENSION_TABLES].sort((a,b) => a.name.localeCompare(b.name, "en"));
export const TABLE_NAMES: readonly string[] = CURRENT_TABLES.map(table => table.name);
export const TABLE_BY_NAME = new Map<string, TableContract>(CURRENT_TABLES.map(table => [table.name, table]));
/** Observed in two independently initialized private PostgreSQL18 namespaces. */
export const SCHEMA21_CATALOG_HASH = "54acfbd8fd9887c1fb3517912748cce1929de947b02b9248c99a07a079ada175";
/** Observed in two reviewed independently initialized schema24 namespaces.
 * The schema21 baseline receipt remains separately frozen and reproducible. */
export const SCHEMA24_CATALOG_HASH = "aa7168ab4953d862c9ddc790e6db5616c2bec0281089b603ea1a1502bca2b0da";
export function assertCatalog(catalog: Catalog): void {
  requireOperation(digest(catalog) === SCHEMA24_CATALOG_HASH, "CATALOG_CHANGED", "The catalog differs from the qualified schema24 contract, including its keys, private columns, guards or PostgreSQL major version.");
}

/** Later fragments remain typed requirements, never an implicit compatibility switch. */
export interface CoverageExtension {
  family: string; schemaVersion: number;
  tables: readonly TableContract[]; catalog: Catalog; dependencies: readonly { table: string; columns: readonly string[]; target: string; targetColumns: readonly string[] }[];
  privateSources: readonly { table: string; column: string; codecVersion: string; binding: string }[];
  artifacts: readonly { table: string; codecVersion: string }[];
  qualification: { sourceCommit: string; testReceiptHash: string; fullCatalogHash: string; restoreReceiptHash: string };
}
export const PENDING_EXTENSIONS: readonly { family: string; schemaVersion: number; status: string }[] = [];
export function assertRegistry(catalog: Catalog, schemaRows: readonly Row[]): void {
  requireOperation(catalog.tables.length === 177 && canonical(catalog.tables.map(table => table.name).sort()) === canonical([...TABLE_NAMES].sort()), "UNSUPPORTED_COVERAGE", "This namespace has missing, unknown or unqualified table families.");
  requireOperation(canonical(schemaRows.map(row => Number(row.version)).sort((a,b) => a-b)) === canonical([...SCHEMA_VERSIONS]), "UNSUPPORTED_COVERAGE", "Only the reviewed current schema24 marker set is supported; no initialization is performed.");
  for (const table of catalog.tables) {
    const contract = TABLE_BY_NAME.get(table.name)!;
    requireOperation(canonical(table.keys) === canonical(contract.keys), "UNSUPPORTED_COVERAGE", "The source table keys do not match the reviewed lineage registry.");
    requireOperation(canonical(table.columns.filter(column => column.name.startsWith("encrypted_")).map(column => column.name).sort()) === canonical(contract.privateColumns.filter(column => column.startsWith("encrypted_")).sort()), "UNSUPPORTED_COVERAGE", "The namespace has unreviewed private-source coverage.");
    for (const dependency of table.foreignKeys) requireOperation(TABLE_BY_NAME.has(dependency.target), "UNSUPPORTED_COVERAGE", "A source dependency is outside the supported whole namespace.");
  }
}
