import type { TableContract } from "./current-registry";
/** Audited qualified fragments. Admission still requires the complete joined catalog receipt. */
export const EXTENSION_FRAGMENTS = [
  {
    "family": "lifecycle22",
    "sourceCommit": "8bfeada4a1bf0aabf5232b2c3d0d3e0932270d7b",
    "source": "lib/server/lifecycle-schema.ts",
    "sourceSha256": "33e87485d4287ea94ef95dd7c0504e0b2ffd01be50147376955756402bc8a5d0",
    "schemaVersion": 22,
    "tables": [
      "fp_lifecycle_commands",
      "fp_lifecycle_preference_heads",
      "fp_lifecycle_preference_versions",
      "fp_lifecycle_inbox",
      "fp_lifecycle_inbox_events",
      "fp_lifecycle_program_heads",
      "fp_lifecycle_program_versions",
      "fp_lifecycle_schedules",
      "fp_lifecycle_schedule_versions",
      "fp_lifecycle_schedule_events",
      "fp_lifecycle_occurrences",
      "fp_lifecycle_attempts",
      "fp_lifecycle_snapshots",
      "fp_lifecycle_contents",
      "fp_lifecycle_reviews",
      "fp_lifecycle_audit",
      "fp_lifecycle_observer_heads"
    ]
  },
  {
    "family": "procurement23",
    "sourceCommit": "5613284a23cb9435433c224a82a2fae4140ab856",
    "source": "lib/server/procurement-schema.ts",
    "sourceSha256": "7b8c0ffeeb76e56734b506c29bfd32b7f55ced665b7e29e0dbc69d59c723ad39",
    "schemaVersion": 23,
    "tables": [
      "fp_procurement_suppliers",
      "fp_procurement_supplier_versions",
      "fp_procurement_quotes",
      "fp_procurement_quote_versions",
      "fp_package_operations",
      "fp_package_operation_events",
      "fp_procurement_responsibilities",
      "fp_procurement_selections",
      "fp_procurement_progress",
      "fp_procurement_exceptions",
      "fp_procurement_exception_events",
      "fp_procurement_expense_links",
      "fp_procurement_commands",
      "fp_procurement_audit",
      "fp_procurement_reviews",
      "fp_procurement_invites",
      "fp_procurement_access",
      "fp_procurement_entry_commands",
      "fp_procurement_access_audit"
    ]
  },
  {
    "family": "recognition24",
    "sourceCommit": "a75d65696326b3dd2a1fff026409de8e72d1b2fa",
    "source": "lib/server/recognition-schema.ts",
    "sourceSha256": "a71c73a6a4fd7df98f22898da9445db62f7d17cd8c0a122166b254f8a2545c67",
    "schemaVersion": 24,
    "tables": [
      "fp_recognition_heads",
      "fp_recognition_consents",
      "fp_recognition_commands",
      "fp_recognition_audit"
    ]
  }
] as const;
export const EXTENSION_TABLES = [
  {"name": "fp_lifecycle_commands", "keys": ["actor_key", "intent_id"], "family": "lifecycle22", "source": "lib/server/lifecycle-schema.ts", "privateColumns": []},
  {"name": "fp_lifecycle_preference_heads", "keys": ["id"], "family": "lifecycle22", "source": "lib/server/lifecycle-schema.ts", "privateColumns": []},
  {"name": "fp_lifecycle_preference_versions", "keys": ["id"], "family": "lifecycle22", "source": "lib/server/lifecycle-schema.ts", "privateColumns": ["encrypted_grant"]},
  {"name": "fp_lifecycle_inbox", "keys": ["id"], "family": "lifecycle22", "source": "lib/server/lifecycle-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_lifecycle_inbox_events", "keys": ["id"], "family": "lifecycle22", "source": "lib/server/lifecycle-schema.ts", "privateColumns": []},
  {"name": "fp_lifecycle_program_heads", "keys": ["organization_id"], "family": "lifecycle22", "source": "lib/server/lifecycle-schema.ts", "privateColumns": []},
  {"name": "fp_lifecycle_program_versions", "keys": ["id"], "family": "lifecycle22", "source": "lib/server/lifecycle-schema.ts", "privateColumns": ["encrypted_grant"]},
  {"name": "fp_lifecycle_schedules", "keys": ["id"], "family": "lifecycle22", "source": "lib/server/lifecycle-schema.ts", "privateColumns": []},
  {"name": "fp_lifecycle_schedule_versions", "keys": ["id"], "family": "lifecycle22", "source": "lib/server/lifecycle-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_lifecycle_schedule_events", "keys": ["id"], "family": "lifecycle22", "source": "lib/server/lifecycle-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_lifecycle_occurrences", "keys": ["id"], "family": "lifecycle22", "source": "lib/server/lifecycle-schema.ts", "privateColumns": []},
  {"name": "fp_lifecycle_attempts", "keys": ["id"], "family": "lifecycle22", "source": "lib/server/lifecycle-schema.ts", "privateColumns": []},
  {"name": "fp_lifecycle_snapshots", "keys": ["id"], "family": "lifecycle22", "source": "lib/server/lifecycle-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_lifecycle_contents", "keys": ["id"], "family": "lifecycle22", "source": "lib/server/lifecycle-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_lifecycle_reviews", "keys": ["id"], "family": "lifecycle22", "source": "lib/server/lifecycle-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_lifecycle_audit", "keys": ["id"], "family": "lifecycle22", "source": "lib/server/lifecycle-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_lifecycle_observer_heads", "keys": ["name"], "family": "lifecycle22", "source": "lib/server/lifecycle-schema.ts", "privateColumns": ["encrypted_cursor"]},
  {"name": "fp_procurement_suppliers", "keys": ["id"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": []},
  {"name": "fp_procurement_supplier_versions", "keys": ["supplier_id", "version"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_procurement_quotes", "keys": ["id"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": []},
  {"name": "fp_procurement_quote_versions", "keys": ["quote_id", "version"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_package_operations", "keys": ["tenant_id", "project_id", "package_id"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_package_operation_events", "keys": ["id"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_procurement_responsibilities", "keys": ["id"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": ["encrypted_data", "encrypted_response"]},
  {"name": "fp_procurement_selections", "keys": ["id"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_procurement_progress", "keys": ["id"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_procurement_exceptions", "keys": ["id"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_procurement_exception_events", "keys": ["id"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_procurement_expense_links", "keys": ["id"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_procurement_commands", "keys": ["tenant_id", "actor_id", "intent_id"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": ["encrypted_input"]},
  {"name": "fp_procurement_audit", "keys": ["id"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_procurement_reviews", "keys": ["id"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_procurement_invites", "keys": ["id"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": ["encrypted_data", "encrypted_token"]},
  {"name": "fp_procurement_access", "keys": ["id"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": ["encrypted_acceptance", "encrypted_identity", "encrypted_return_token", "encrypted_session_token"]},
  {"name": "fp_procurement_entry_commands", "keys": ["tenant_id", "actor_id", "intent_id"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": ["encrypted_input", "encrypted_recovery"]},
  {"name": "fp_procurement_access_audit", "keys": ["id"], "family": "procurement23", "source": "lib/server/procurement-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_recognition_heads", "keys": ["id"], "family": "recognition24", "source": "lib/server/recognition-schema.ts", "privateColumns": []},
  {"name": "fp_recognition_consents", "keys": ["id"], "family": "recognition24", "source": "lib/server/recognition-schema.ts", "privateColumns": ["encrypted_data"]},
  {"name": "fp_recognition_commands", "keys": ["id"], "family": "recognition24", "source": "lib/server/recognition-schema.ts", "privateColumns": ["encrypted_input"]},
  {"name": "fp_recognition_audit", "keys": ["id"], "family": "recognition24", "source": "lib/server/recognition-schema.ts", "privateColumns": ["encrypted_data"]}
] as const satisfies readonly TableContract[];
/** Exact target-only INSERT exception list approved by the integration owner.
 * All FK/check/retention/head/transition/deferred-history guards stay enabled. */
export const HISTORICAL_EXTENSION_GUARDS = [
  { table: "fp_lifecycle_inbox", trigger: "fp_lifecycle_inbox_scope", function: "fp_lifecycle_project_scope", reason: "original recipient role survives a later mutable session role switch; original encrypted grant and recipient identity are independently verified" },
  {
    "table": "fp_procurement_suppliers",
    "trigger": "fp_procurement_suppliers_scope",
    "function": "fp_procurement_scope_guard",
    "reason": "historical actor/creator issuance, initial-draft or current-head-only INSERT assumption"
  },
  {
    "table": "fp_procurement_supplier_versions",
    "trigger": "fp_procurement_supplier_versions_scope",
    "function": "fp_procurement_scope_guard",
    "reason": "historical actor/creator issuance, initial-draft or current-head-only INSERT assumption"
  },
  {
    "table": "fp_procurement_quotes",
    "trigger": "fp_procurement_quotes_scope",
    "function": "fp_procurement_scope_guard",
    "reason": "historical actor/creator issuance, initial-draft or current-head-only INSERT assumption"
  },
  {
    "table": "fp_procurement_quote_versions",
    "trigger": "fp_procurement_quote_versions_scope",
    "function": "fp_procurement_scope_guard",
    "reason": "historical actor/creator issuance, initial-draft or current-head-only INSERT assumption"
  },
  {
    "table": "fp_package_operations",
    "trigger": "fp_package_operations_scope",
    "function": "fp_procurement_scope_guard",
    "reason": "historical actor/creator issuance, initial-draft or current-head-only INSERT assumption"
  },
  {
    "table": "fp_package_operation_events",
    "trigger": "fp_package_operation_events_scope",
    "function": "fp_procurement_scope_guard",
    "reason": "historical actor/creator issuance, initial-draft or current-head-only INSERT assumption"
  },
  {
    "table": "fp_procurement_selections",
    "trigger": "fp_procurement_selections_scope",
    "function": "fp_procurement_scope_guard",
    "reason": "historical actor/creator issuance, initial-draft or current-head-only INSERT assumption"
  },
  {
    "table": "fp_procurement_progress",
    "trigger": "fp_procurement_progress_scope",
    "function": "fp_procurement_scope_guard",
    "reason": "historical actor/creator issuance, initial-draft or current-head-only INSERT assumption"
  },
  {
    "table": "fp_procurement_exception_events",
    "trigger": "fp_procurement_exception_events_scope",
    "function": "fp_procurement_scope_guard",
    "reason": "historical actor/creator issuance, initial-draft or current-head-only INSERT assumption"
  },
  {
    "table": "fp_procurement_expense_links",
    "trigger": "fp_procurement_expense_links_scope",
    "function": "fp_procurement_scope_guard",
    "reason": "historical actor/creator issuance, initial-draft or current-head-only INSERT assumption"
  },
  {
    "table": "fp_procurement_commands",
    "trigger": "fp_procurement_commands_scope",
    "function": "fp_procurement_scope_guard",
    "reason": "historical actor/creator issuance, initial-draft or current-head-only INSERT assumption"
  },
  {
    "table": "fp_procurement_audit",
    "trigger": "fp_procurement_audit_scope",
    "function": "fp_procurement_scope_guard",
    "reason": "historical actor/creator issuance, initial-draft or current-head-only INSERT assumption"
  },
  {
    "table": "fp_procurement_reviews",
    "trigger": "fp_procurement_reviews_scope",
    "function": "fp_procurement_scope_guard",
    "reason": "historical actor/creator issuance, initial-draft or current-head-only INSERT assumption"
  },
  {
    "table": "fp_procurement_invites",
    "trigger": "fp_procurement_invites_scope",
    "function": "fp_procurement_scope_guard",
    "reason": "historical actor/creator issuance, initial-draft or current-head-only INSERT assumption"
  },
  {
    "table": "fp_procurement_access",
    "trigger": "fp_procurement_access_scope",
    "function": "fp_procurement_scope_guard",
    "reason": "historical actor/creator issuance, initial-draft or current-head-only INSERT assumption"
  },
  {
    "table": "fp_procurement_entry_commands",
    "trigger": "fp_procurement_entry_commands_scope",
    "function": "fp_procurement_scope_guard",
    "reason": "historical actor/creator issuance, initial-draft or current-head-only INSERT assumption"
  },
  {
    "table": "fp_procurement_access_audit",
    "trigger": "fp_procurement_access_audit_scope",
    "function": "fp_procurement_scope_guard",
    "reason": "historical actor/creator issuance, initial-draft or current-head-only INSERT assumption"
  },
  {
    "table": "fp_recognition_consents",
    "trigger": "fp_recognition_consent_lineage",
    "function": "fp_recognition_consent_lineage",
    "reason": "original consent may outlive current session, membership or publication eligibility"
  },
  {
    "table": "fp_recognition_commands",
    "trigger": "fp_recognition_command_lineage",
    "function": "fp_recognition_command_lineage",
    "reason": "original decision is retained after its original authority ends"
  }
] as const;

/** Exact16 new stored guard functions in the joined schema24 fragments. */
export const EXTENSION_FUNCTIONS = [
  "fp_lifecycle_attempt_contract",
  "fp_lifecycle_head_contract",
  "fp_lifecycle_immutable",
  "fp_lifecycle_occurrence_contract",
  "fp_lifecycle_project_scope",
  "fp_procurement_head_guard",
  "fp_procurement_history_guard",
  "fp_procurement_invite_guard",
  "fp_procurement_operations_guard",
  "fp_procurement_retained_guard",
  "fp_procurement_scope_guard",
  "fp_recognition_command_lineage",
  "fp_recognition_consent_lineage",
  "fp_recognition_current_version",
  "fp_recognition_head_guard",
  "fp_recognition_immutable"
] as const;
