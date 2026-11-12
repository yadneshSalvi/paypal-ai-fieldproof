import { canonicalJson, sha256 } from "@fracture/paypal-core";
import { digest, hash, OperationsError, requireOperation, type ArtifactAbsence, type ArtifactReference, type Row, type TableRows } from "./contracts";
import { extensionPrivateContext, authenticateExtensionNested } from "./extension-private";
import { assertExtensionPrivateLineage } from "./extension-lineage";
import { CURRENT_TABLES } from "./current-registry";
import { openOriginal } from "./crypto";
import { findOriginal, keyHash, type OriginalRows } from "./lineage";

export interface ArtifactNeed { key: string; hash: string; size: number | null; contentType: string; bindings: ArtifactReference["bindings"]; absence: Omit<ArtifactAbsence, "bindings"> | null; }
const scoped = (kind: string, row: Row, id: unknown = row.id) => `${kind}:${row.tenant_id}:${row.project_id}:${id}`;
const organization = (kind: string, id: unknown) => `organization:organization-governance-v1:${kind}:${id}`;
const plainKinds: Record<string, string> = {
  fp_documents: "document", fp_recovery_invoices: "recovery-invoice", fp_payables: "payable", fp_payable_reviews: "payout-review",
  fp_plan_versions: "plan", fp_plan_reviews: "plan-review", fp_photo_alignments: "photo-alignment", fp_reviewer_qualifications: "reviewer-qualification", fp_work_signoffs: "work-signoff",
  fp_proof_derivatives: "proof-image", fp_proof_snapshots: "proof-snapshot", fp_funding_policies: "funding-policy", fp_funding_cases: "funding-case", fp_funding_choices: "funding-choice",
  fp_funding_reconciliations: "funding-reconciliation", fp_funding_reconciliation_consents: "funding-adjustment-consent", fp_funding_return_observations: "funding-return-observation",
  fp_funding_return_holds: "funding-return-hold", fp_funding_external_returns: "funding-external-return-record", fp_funding_assignments: "funding-assignment",
  fp_sample_funding_origins: "sample-funding-origin", fp_sponsor_offers: "sponsor-offer", fp_sponsor_acceptances: "sponsor-acceptance", fp_sponsor_events: "sponsor-event", fp_purpose_pledges: "purpose-pledge",
};
const orgKinds: Record<string, string> = {
  fp_org_memberships: "member", fp_org_access: "access", fp_org_library_entries: "library-entry", fp_org_commands: "command", fp_org_audit: "audit",
  fp_org_project_consents: "consent", fp_org_policies: "policy-draft", fp_org_policy_versions: "policy-version", fp_project_policy_artifacts: "policy-artifact",
  fp_project_package_revisions: "canonical-revision", fp_project_policy_subjects: "policy-subject", fp_org_portfolios: "portfolio",
};
/** Every current encrypted column has an explicit versioned AAD resolver. Future
 * columns/families must provide a qualified codec; guessing context is forbidden. */
export function privateContext(table: string, column: string, row: Row, rows: OriginalRows): string {
  if (plainKinds[table]) return scoped(plainKinds[table], row);
  if (orgKinds[table]) return organization(orgKinds[table], row.id);
  switch (table) {
    case "fp_recipient_accounts": return `${row.tenant_id}:${row.actor_id}`;
    case "fp_conditional_consents": return `conditional-wallet:${row.tenant_id}:${row.actor_id}:${row.id}`;
    case "fp_invoice_payment_observations": { const invoice = findOriginal(rows, "fp_recovery_invoices", { id: row.invoice_id }); return `invoice-payment:${invoice.tenant_id}:${invoice.id}:${row.payment_identity_hash}`; }
    case "fp_ai_runs": return scoped(column === "encrypted_input" ? "ai-input" : "ai-run", row);
    case "fp_ai_attempts": return scoped("ai-run", findOriginal(rows, "fp_ai_runs", { id: row.run_id }));
    case "fp_claims": return `${scoped("claim", row)}:v${row.version}`;
    case "fp_claim_revisions": return `${scoped("claim", findOriginal(rows, "fp_claims", { id: row.claim_id }))}:v${row.version}`;
    case "fp_receipt_comparison_decisions": return `receipt-comparison:${row.tenant_id}:${row.id}`;
    case "fp_balance_observations": return `balance:${row.merchant_scope}:${row.id}`;
    case "fp_payout_observations": { const payable = findOriginal(rows, "fp_payables", { id: row.payable_id }); return `${scoped("payout-observation", payable)}:${row.id}`; }
    case "fp_transfer_webhook_archive": return `transfer-webhook:${row.tenant_id}:${row.project_id}:${row.bundle_id}:${row.id}`;
    case "fp_board_packs": return `board-pack:${row.tenant_id}:${row.project_id}:${row.scope_hash}:${row.id}`;
    case "fp_workspace_library_entries": return `workspace-library:${row.library_id}:${row.session_id}`;
    case "fp_community_actions": return `community-action:${row.tenant_id}:${row.actor_id}:${row.intent_id}`;
    case "fp_community_snapshots": return scoped("community-snapshot", row);
    case "fp_community_drafts": return scoped("community-draft", row);
    case "fp_community_translations": return scoped("community-translation", row);
    case "fp_community_backtranslations": return `community-backtranslation:${row.translation_id}:${row.id}`;
    case "fp_community_translation_reviews": return `community-review:${row.translation_id}:${row.id}`;
    case "fp_community_runs": return scoped(column === "encrypted_input" ? "community-run-input" : column === "encrypted_output" ? "community-run-output" : "community-response-id", row);
    case "fp_community_model_observations": return `community-model-observation:${row.run_id}:${row.id}`;
    case "fp_funding_deductions": return scoped("funding-deduction", row, `${row.receipt_id}:${row.receipt_version}`);
    case "fp_sample_funding_use_evidence": return scoped("sample-funding-use", row, row.allocation_id);
    case "fp_org_invitations": return organization(column === "encrypted_token" ? "invitation-token" : "invitation-label", row.id);
    case "fp_project_policy_adoptions": return organization(`project-rule:${row.tenant_id}:${row.project_id}`, row.id);
    case "fp_planning_actions": return `planning-action:${row.tenant_id}:${row.project_id}:${row.actor_id}:${row.intent_id}`;
    case "fp_plan_runs": return column === "encrypted_checkpoint" ? `${scoped("plan-run", row)}:checkpoint:${row.attempt}` : scoped(column === "encrypted_input" ? "plan-run-input" : "plan-run", row);
    case "fp_plan_run_attempts": return scoped("plan-run", findOriginal(rows, "fp_plan_runs", { id: row.run_id }));
    case "fp_plan_provider_observations": return `${scoped("plan-run", findOriginal(rows, "fp_plan_runs", { id: row.run_id }))}:observation:${row.id}`;
    case "fp_reviewer_invites": return scoped("reviewer-invite", row) + (column === "encrypted_session_token" ? ":session" : "");
    case "fp_studio_snapshots": return `studio-snapshot:${row.scope_hash}:${row.id}`;
    case "fp_studio_reports": return `studio-report:${row.scope_hash}:v${row.revision}`;
    case "fp_studio_layout_events": return `studio-layout-event:${findOriginal(rows, "fp_studio_reports", { id: row.report_id }).scope_hash}:v${row.revision}`;
    case "fp_studio_agent_runs": return `${column === "encrypted_input" ? "studio-agent-input" : "studio-agent-transcript"}:${row.scope_hash}:${row.id}`;
    case "fp_studio_tool_receipts": return `studio-tool-receipt:${row.run_id}:${row.call_id}`;
    case "fp_studio_chat_threads": return `studio-chat:${row.scope_hash}:${row.thread_id}:v${row.revision}` + (column === "encrypted_summary" ? ":summary" : "");
    case "fp_supporter_invites": return scoped("supporter-invite", row) + (column === "encrypted_token" ? ":token" : "");
    case "fp_supporter_access": return scoped("supporter-access", row) + ({ encrypted_identity: ":identity", encrypted_acceptance: ":acceptance", encrypted_session_token: ":session", encrypted_recovery_token: ":recovery" }[column] ?? ":unsupported");
    case "fp_supporter_commands": return `supporter-command:${row.tenant_id}:${row.project_id}:${row.actor_id}:${row.intent_id}`;
    case "fp_supporter_access_audit": return scoped("supporter-audit", row);
    default: { const context = extensionPrivateContext(table, column, row, rows); requireOperation(context !== null, "PRIVATE_LINEAGE", "An original private value has no qualified source codec."); return context; }
  }
}
function ciphers(value: unknown, result = new Set<string>()): Set<string> {
  if (typeof value === "string" && /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) result.add(value);
  else if (Array.isArray(value)) for (const item of value) ciphers(item, result);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) ciphers(item, result);
  return result;
}
function parseObject(value: unknown): Row {
  requireOperation(value !== null && typeof value === "object" && !Array.isArray(value), "PRIVATE_LINEAGE", "An original private source has an unsupported encoding.");
  return value as Row;
}

export function inspectPrivateLineage(rows: OriginalRows, tables: readonly TableRows[], secret: string): {
  fields: number; ciphertextHash: string; artifactBindingsHash: string; needs: ArtifactNeed[]; decrypted: Map<string, unknown>; paymentOperations: Row[];
} {
  const authenticated = new Set<string>(), fingerprints: string[] = [], needs = new Map<string, ArtifactNeed>(), decrypted = new Map<string, unknown>(), paymentOperations: Row[] = [];
  let fields = 0;
  const nestedSources: unknown[] = [];
  const read = (cipher: unknown, context: string, recipient = false) => {
    const value = openOriginal(cipher, context, secret, recipient); authenticated.add(String(cipher)); fingerprints.push(digest([context, hash(String(cipher))])); fields++;
    return value;
  };
  const addArtifact = (table: string, row: Row, field: string, key: unknown, expectedHash: unknown, size: number | null, contentType: string, absence: ArtifactNeed["absence"] = null) => {
    requireOperation(typeof key === "string" && /^fieldproof\/[a-f0-9-]{36}\/[a-zA-Z0-9_./-]+$/.test(key) && !key.includes("..") && typeof expectedHash === "string" && /^[a-f0-9]{64}$/.test(expectedHash), "PRIVATE_LINEAGE", "An original private artifact is missing its immutable path or content hash.");
    requireOperation(key.startsWith(`fieldproof/${table === "fp_documents" ? row.id : row.document_id}/`), "PRIVATE_LINEAGE", "A private artifact path crosses its original document identity.");
    const binding = { table, keyHash: keyHash(table, row), field }, prior = needs.get(key);
    if (prior) {
      requireOperation(prior.hash === expectedHash && prior.contentType === contentType && (size === null || prior.size === null || prior.size === size), "PRIVATE_LINEAGE", "Original artifact bindings disagree about the same private path.");
      prior.bindings.push(binding); if (prior.size === null) prior.size = size;
    } else needs.set(key, { key, hash: expectedHash, size, contentType, bindings: [binding], absence });
  };
  for (const contract of CURRENT_TABLES) for (const row of rows.get(contract.name)!) {
    const opened: Row = {};
    for (const column of contract.privateColumns) {
      if (!column.startsWith("encrypted_") || row[column] === null) continue;
      opened[column] = read(row[column], privateContext(contract.name, column, row, rows), contract.name === "fp_recipient_accounts");
      decrypted.set(`${keyHash(contract.name, row)}:${column}`, opened[column]);
    }
    authenticateExtensionNested(contract.name, row, opened, read);
    for (const [column, value] of Object.entries(opened)) decrypted.set(`${keyHash(contract.name,row)}:${column}`, value);
    if (contract.name === "fp_payment_commands") {
      const command = parseObject(row.command), scope = parseObject(command.scope), action = parseObject(command.action);
      requireOperation(command.operationId === row.operation_id && scope.tenantId === row.tenant_id && scope.projectId === row.project_id, "PRIVATE_LINEAGE", "An original stored command crosses its operation identity.");
      if (action.kind === "create_order" && action.savedWallet) read(parseObject(action.savedWallet).vaultId, `payment-wallet:${scope.tenantId}:${scope.projectId}:${command.operationId}`);
    }
    if (contract.name === "fp_funding_case_events") {
      const data = parseObject(row.data);
      if (data.encryptedReview !== undefined) read(data.encryptedReview, scoped("funding-reconciliation", findOriginal(rows, "fp_funding_cases", { id: row.case_id }), data.reviewId));
    }
    if (contract.name.startsWith("paycore_") && typeof row.document === "string") {
      let document: unknown; try { document = JSON.parse(row.document); } catch { document = null; }
      const object = parseObject(document);
      if (contract.name === "paycore_operations") {
        let operation = object;
        if (object.paycoreEncoding !== undefined) {
          requireOperation(object.paycoreEncoding === "operation-v1" && Object.keys(object).length === 2, "PRIVATE_LINEAGE", "The original payment operation codec is unsupported.");
          const text = read(object.ciphertext, scoped("paycore-operation", row));
          requireOperation(typeof text === "string", "PRIVATE_LINEAGE", "The original payment operation has an invalid private encoding.");
          try { operation = parseObject(JSON.parse(text)); } catch { requireOperation(false, "PRIVATE_LINEAGE", "The original payment operation has an invalid private encoding."); }
        }
        const command = parseObject(operation.command), scope = parseObject(command.scope), action = parseObject(command.action), money = parseObject(action.money);
        requireOperation(command.operationId === row.id && scope.tenantId === row.tenant_id && scope.projectId === row.project_id && command.payloadHash === row.payload_hash && command.businessKey === row.business_key && command.providerRequestId === row.provider_request_id && operation.status === row.status && operation.version === row.version && String(money.minor) === row.amount_minor, "PRIVATE_LINEAGE", "An original payment operation does not match its immutable SQL identity or state.");
        if (action.savedWallet && typeof parseObject(action.savedWallet).vaultId === "string" && String(parseObject(action.savedWallet).vaultId).startsWith("v1.")) read(parseObject(action.savedWallet).vaultId, scoped("payment-wallet", row));
        paymentOperations.push(operation);
        nestedSources.push(operation);
      }
      nestedSources.push(object);
    }
    if (contract.name === "fp_documents") {
      const data = parseObject(opened.encrypted_data), pages = data.pages;
      requireOperation(Array.isArray(pages) && typeof row.declared_bytes === "number", "PRIVATE_LINEAGE", "A document lacks its original page or upload binding.");
      if (row.state === "ready") requireOperation(row.sha256 === row.expected_sha256 && row.page_count === pages.length && pages.length > 0, "PRIVATE_LINEAGE", "A validated document is missing its original complete page coverage.");
      addArtifact(contract.name, row, "original", row.pathname, row.sha256 ?? row.expected_sha256, row.declared_bytes, String(row.content_type), row.state === "awaiting_upload" ? {
        key: String(row.pathname), expectedHash: String(row.expected_sha256), declaredSize: row.declared_bytes, uploadExpiresAt: String(row.upload_expires_at), reason: "original-awaiting-upload",
      } : null);
      for (const [index, page] of pages.entries()) { const p = parseObject(page); addArtifact(contract.name, row, `pages.${index}`, p.pathname, p.sha256, null, "image/png"); }
    }
    if (contract.name === "fp_photo_alignments") { const data = parseObject(opened.encrypted_data), image = parseObject(data.sharedImage); addArtifact(contract.name, row, "sharedImage", image.pathname, image.sha256, null, "image/png"); }
    if (contract.name === "fp_proof_derivatives") { const data = parseObject(opened.encrypted_data); addArtifact(contract.name, row, "redactedImage", data.pathname, row.content_hash, null, "image/png"); }
    if (["fp_plan_versions", "fp_photo_alignments", "fp_reviewer_qualifications", "fp_work_signoffs", "fp_proof_snapshots", "fp_board_packs", "fp_package_operation_events", "fp_procurement_quote_versions", "fp_lifecycle_snapshots"].includes(contract.name)) {
      for (const value of Object.values(opened)) validateCapturedSources(value, row, rows);
    }
    // Funding canonical contracts are content-addressed private source facts.
    if (contract.name.startsWith("fp_funding_") && typeof row.digest === "string" && opened.encrypted_data !== undefined)
      requireOperation(sha256(canonicalJson(opened.encrypted_data)) === row.digest, "PRIVATE_LINEAGE", "A funding source differs from its original immutable content hash.");
    nestedSources.push(row, ...Object.values(opened));
  }
  for (const source of nestedSources) for (const cipher of ciphers(source)) requireOperation(authenticated.has(cipher), "PRIVATE_LINEAGE", "An original or nested private value has no reviewed identity-binding codec.");
  try { assertExtensionPrivateLineage(rows, decrypted); }
  catch(error) { if(error instanceof OperationsError) throw error; requireOperation(false,"PRIVATE_LINEAGE","An authenticated extension source has an unsupported original contract or hash binding."); }
  // Include the exact table row digests, so a removed private row cannot pass by
  // preserving the remaining ciphertext alone.
  const list = [...needs.values()].sort((a,b) => a.key.localeCompare(b.key, "en"));
  return { fields, ciphertextHash: digest({ sources: fingerprints.sort(), tables: tables.map(table => [table.name, table.hash]) }), artifactBindingsHash: digest(list), needs: list, decrypted, paymentOperations };
}
function validateCapturedSources(value: unknown, scope: Row, rows: OriginalRows): void {
  if (Array.isArray(value)) { for (const item of value) validateCapturedSources(item, scope, rows); return; }
  if (value === null || typeof value !== "object") return;
  const object = value as Row;
  if (typeof object.documentId === "string" && /^[a-f0-9-]{36}$/.test(object.documentId)) findOriginal(rows, "fp_documents", { id: object.documentId, tenant_id: scope.tenant_id, project_id: scope.project_id });
  for (const item of Object.values(object)) validateCapturedSources(item, scope, rows);
}
