import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { QueryResult, SqlConnection, SqlDatabase } from "@fracture/paypal-core";
import { canonicalJson, sha256 } from "@fracture/paypal-core";
import { digest, hash, identifier, type BackupEvidence, type Row, type TransferEndpoint } from "../../lib/operations/contracts";
import { TABLE_BY_NAME } from "../../lib/operations/current-registry";
import { privateFileArtifacts } from "../../lib/operations/artifacts";
import { sealOriginal } from "../../lib/operations/crypto";
import { endpointFingerprint, scopedConnectionUrl } from "../../lib/operations/operator-files";
import { setRuntimeHold } from "../../lib/server/runtime-control";
import { captureWorkspaceV2, exportWorkspaceV2, planWorkspaceTransferV2 } from "../../lib/server/workspace-transfer-v2";

export const PRIVATE_EPOCH = "2000-01-01T00:00:00.123456Z", PRIVATE_DEADLINE = "2000-01-03T00:00:00.123456Z";
interface OwnedState { source: SqlDatabase; target: SqlDatabase; schemas: { source: string; target: string }; artifactRoot: string; }
export function ownedState(): OwnedState {
  const state = (globalThis as typeof globalThis & { fieldproofOperationsV2Test?: OwnedState }).fieldproofOperationsV2Test;
  assert(state && /^operations_c_source_test_[a-f0-9]{32}$/.test(state.schemas.source) && /^operations_c_target_test_[a-f0-9]{32}$/.test(state.schemas.target));
  assert.equal(process.cwd(), "/Users/yadneshsalvi/code/hackathons/paypal-ai-hackathon/fieldproof/.local/operations-complete-stage14");
  return state;
}
export async function insertFixture(tx: SqlConnection, table: string, row: Row): Promise<void> {
  assert(TABLE_BY_NAME.has(table)); const entries = Object.entries(row);
  await tx.query(`INSERT INTO ${identifier(table)}(${entries.map(([key]) => identifier(key)).join(",")}) VALUES(${entries.map((_, index) => `$${index + 1}`).join(",")})`, entries.map(([, value]) => value !== null && typeof value === "object" ? JSON.stringify(value) : value));
}
export async function createCompleteOperationsFixture(extend: (base: { owned: OwnedState; source: TransferEndpoint; target: TransferEndpoint; id: Record<string,string>; secret: string; png: Buffer; imageHash: string; actor: string; donor: string }) => Promise<void>) {
  const owned = ownedState();
  for (const kind of ["source", "target"] as const) {
    const current = (await owned[kind].query<{ own: string; paths: string[] }>("SELECT current_schema() own,current_schemas(false)::text[] paths")).rows[0];
    assert.equal(current.own, owned.schemas[kind]); assert.deepEqual(current.paths, [owned.schemas[kind]]);
  }
  await mkdir(owned.artifactRoot, { mode: 0o700 });
  const sourceDirectory = path.join(owned.artifactRoot, "source"), targetDirectory = path.join(owned.artifactRoot, "destination");
  await mkdir(sourceDirectory, { mode: 0o700 }); await mkdir(targetDirectory, { mode: 0o700 });
  const namespace = "synthetic-owned-private-artifact-namespace";
  const secret = process.env.AUTH_SECRET!;
  assert(secret.length >= 32);
  const privateConfig = JSON.parse(await readFile(path.resolve(process.cwd(), ".local/operations-complete-v2-unit/private.json"), "utf8")) as { DATABASE_URL: string };
  const source: TransferEndpoint = { database: owned.source, label: "synthetic-source", endpoint: endpointFingerprint(scopedConnectionUrl(privateConfig.DATABASE_URL, owned.schemas.source)), schema: owned.schemas.source, authSecret: secret, merchantClientId: "synthetic-merchant-never-a-provider", artifactStore: await privateFileArtifacts(sourceDirectory, namespace) };
  const target: TransferEndpoint = { ...source, database: owned.target, label: "synthetic-fresh-destination", endpoint: endpointFingerprint(scopedConnectionUrl(privateConfig.DATABASE_URL, owned.schemas.target)), schema: owned.schemas.target, artifactStore: await privateFileArtifacts(targetDirectory, namespace) };
  const id = Object.fromEntries(["tenant", "project", "otherProject", "session", "otherSession", "donorSession", "obligation", "consent", "round", "receipt", "operation", "invoice", "invoiceObservation", "document", "pendingDocument", "plan", "derivative", "alignment", "library", "organization", "owner", "ownerSession", "expiredMember", "expiredSession", "revokedMember", "revokedSession", "orgAccess", "orgLibrary", "orgLibraryEntry", "invite", "supporterAccess", "fundingPolicy", "fundingCase", "fundingChoice", "fundingEvent"].map(key => [key, randomUUID()])) as Record<string, string>;
  const actor = "synthetic-owner", donor = "synthetic-donor", scope = { tenant_id: id.tenant, project_id: id.project };
  const encrypt = (value: unknown, context: string) => sealOriginal(value, context, secret);
  const token = (kind: string) => hash(`synthetic-${kind}-${id.project}`);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFzQAAAAASUVORK5CYII=", "base64"), imageHash = hash(png);
  const originalPath = `fieldproof/${id.document}/original.png`, pagePath = `fieldproof/${id.document}/pages/1.png`, derivativePath = `fieldproof/${id.document}/public-proof/${id.derivative}/redacted.png`, alignmentPath = `fieldproof/${id.document}/planning-alignment/${id.alignment}/reviewed-image.png`;
  for (const key of [originalPath, pagePath, derivativePath, alignmentPath]) await source.artifactStore.stage(key, png, "image/png", id.document);
  const documentData = { filename: "synthetic-private-source.png", permissionConfirmedAt: PRIVATE_EPOCH, uploaderRole: "organizer", pages: [{ number: 1, width: 1, height: 1, pathname: pagePath, sha256: imageHash }] };
  const sourceBinding = { documentId: id.document, documentVersion: 1, contentHash: imageHash, purpose: "photo", provenance: "sample_document", controlVersion: 2, permission: "withdrawn", pages: [{ number: 1, width: 1, height: 1 }], pageHashes: [imageHash] };
  const payloadHash = hash("synthetic-operation-payload"), providerRequestId = "synthetic-provider-request-no-network";
  const command = { operationId: id.operation, scope: { tenantId: id.tenant, projectId: id.project }, actor: { id: actor, role: "organizer" }, businessKey: "synthetic-create-order", providerRequestId, payloadHash, action: { kind: "create_order", money: { currency: "USD", minor: 777 }, savedWallet: { vaultId: "synthetic-private-vault", customerId: "synthetic-private-customer" } } };
  const operation = { command, status: "pending_reconciliation", version: 7, createdAt: PRIVATE_EPOCH, updatedAt: PRIVATE_DEADLINE, leaseUntil: PRIVATE_DEADLINE, receipt: null, error: { code: "SYNTHETIC_UNKNOWN", provenance: "synthetic-qualification" } };
  await owned.source.transaction(async tx => {
    // A literal Z formatter is valid only in this transaction-local UTC zone.
    // The server clock and every previously created deadline remain unchanged.
    await tx.query("SET LOCAL timezone='UTC'");
    await insertFixture(tx, "fp_tenants", { id: id.tenant, mode: "sample", created_at: PRIVATE_EPOCH });
    for (const project of [id.project, id.otherProject]) await insertFixture(tx, "fp_projects", { id: project, tenant_id: id.tenant, slug: `synthetic-${project}`, metadata: { title: "Synthetic transfer qualification", template: "makerspace" }, created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_packages", { project_id: id.project, id: "synthetic-package", budget_minor: "9007199254740993", data: { title: "Original synthetic scope" } });
    for (const [session, project, member, role] of [[id.session, id.project, actor, "organizer"], [id.otherSession, id.otherProject, actor, "organizer"], [id.donorSession, id.project, donor, "donor"]]) {
      await insertFixture(tx, "fp_sessions", { id: session, tenant_id: id.tenant, project_id: project, actor_id: member, role, token_hash: token(session), expires_at: PRIVATE_DEADLINE, revoked_at: PRIVATE_DEADLINE, created_at: PRIVATE_EPOCH });
      await insertFixture(tx, "fp_memberships", { tenant_id: id.tenant, project_id: project, actor_id: member, roles: [role], state: "revoked", revoked_at: PRIVATE_DEADLINE, created_at: PRIVATE_EPOCH });
    }
    await insertFixture(tx, "fp_obligations", { id: id.obligation, ...scope, package_id: "synthetic-package", actor_id: donor, amount_minor: "777", channel: "synthetic-qualification", purpose: "conditional_pledge", data: { provenance: "synthetic", fixedDeadline: PRIVATE_DEADLINE }, created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_collection_rounds", { id: id.round, ...scope, package_id: "synthetic-package", package_version: 1, target_minor: "777", collection_started_at: PRIVATE_EPOCH, recovery_ends_at: PRIVATE_DEADLINE, policy_hash: token("policy"), state: "closed", data: { provenance: "synthetic", currentWindow: false } });
    await insertFixture(tx, "fp_conditional_consents", { id: id.consent, ...scope, actor_id: donor, session_id: id.donorSession, obligation_id: id.obligation, intent_id: randomUUID(), slot_index: 0, package_id: "synthetic-package", package_version: 1, amount_minor: "777", status: "withdrawn", policy_digest: token("policy"), policy: { provenance: "synthetic", originalDeadline: PRIVATE_DEADLINE }, expires_at: PRIVATE_DEADLINE, acknowledged_at: PRIVATE_EPOCH, withdrawn_at: PRIVATE_DEADLINE, round_id: id.round, encrypted_wallet: encrypt({ tokenId: "synthetic-original-wallet" }, `conditional-wallet:${id.tenant}:${donor}:${id.consent}`), wallet_label: "Synthetic", created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_settlement_receipts", { id: id.receipt, ...scope, obligation_id: id.obligation, package_id: "synthetic-package", provider_ref: "synthetic-not-a-provider-completion", provenance: "sample", data: { amountMinor: 777, grossMinor: 777, returnedMinor: 0, provenance: "synthetic-qualification" }, created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_journal", { id: randomUUID(), ...scope, receipt_id: id.receipt, account: "synthetic-contribution", side: "credit", amount_minor: "777", currency: "USD", created_at: PRIVATE_EPOCH, operation_id: id.operation });
    const storedCommand = { ...command, action: { ...command.action, savedWallet: { ...command.action.savedWallet, vaultId: encrypt(command.action.savedWallet.vaultId, `payment-wallet:${id.tenant}:${id.project}:${id.operation}`) } } };
    await insertFixture(tx, "fp_payment_commands", { operation_id: id.operation, ...scope, obligation_id: id.obligation, session_id: id.session, business_key: command.businessKey, payload_hash: payloadHash, command: storedCommand, created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "paycore_operations", { id: id.operation, ...scope, business_key: command.businessKey, provider_request_id: providerRequestId, payload_hash: payloadHash, status: operation.status, version: 7, reservation_key: "synthetic-reservation", amount_minor: "777", document: JSON.stringify({ paycoreEncoding: "operation-v1", ciphertext: encrypt(JSON.stringify(operation), `paycore-operation:${id.tenant}:${id.project}:${id.operation}`) }) });
    await insertFixture(tx, "paycore_attempts", { id: randomUUID(), ...scope, operation_id: id.operation, document: JSON.stringify({ id: "synthetic-attempt", outcome: "unknown", requestId: providerRequestId, observedAt: PRIVATE_EPOCH, provenance: "synthetic" }) });
    await insertFixture(tx, "paycore_resource_locks", { ...scope, resource_key: "synthetic-reservation" });
    await insertFixture(tx, "paycore_webhook_events", { ...scope, event_id: "synthetic-webhook-event", body_hash: token("webhook"), status: "review", document: JSON.stringify({ provenance: "synthetic", body: { private: "synthetic-raw-webhook" } }) });
    await insertFixture(tx, "paycore_webhook_deliveries", { id: randomUUID(), ...scope, event_id: "synthetic-webhook-event", verified: 0, document: JSON.stringify({ provenance: "synthetic", verification: "unverified" }) });
    await insertFixture(tx, "fp_provider_operations", { id: randomUUID(), ...scope, actor_id: actor, resource_id: id.consent, kind: "synthetic-provider-observation", business_key: "synthetic-observation", request_id: "synthetic-provider-id", payload_hash: token("provider-payload"), status: "unknown", observation: { provenance: "synthetic", actualPayment: false }, dispatched_at: PRIVATE_EPOCH, created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_outbox", { id: randomUUID(), ...scope, kind: "synthetic-work", data: { privateSource: "synthetic-private-no-dispatch" }, status: "unknown", available_at: PRIVATE_EPOCH, lease_until: PRIVATE_DEADLINE, attempts: 4, created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_webhook_jobs", { inbox_id: "synthetic-inbox", event_id: "synthetic-webhook-event", event_type: "SYNTHETIC.TEST", resource_id: "synthetic-resource", status: "retry", attempts: 2, available_at: PRIVATE_EPOCH, lease_id: "synthetic-expired-lease", lease_until: PRIVATE_DEADLINE, owner_tenant_id: id.tenant, owner_project_id: id.project, observation: { provenance: "synthetic" }, created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_request_leases", { id: randomUUID(), action: "synthetic-original-expired", started_at: PRIVATE_EPOCH, expires_at: PRIVATE_DEADLINE });
    await insertFixture(tx, "fp_recovery_invoices", { id: id.invoice, ...scope, round_id: id.round, consent_id: id.consent, obligation_id: id.obligation, actor_id: donor, created_by: actor, creator_membership_version: 1, consent_version: 1, consent_digest: token("policy"), package_version: 1, amount_minor: "777", invoice_number: `synthetic-${id.invoice}`, reference: `synthetic-reference-${id.invoice}`, state: "payment_evidence_pending", encrypted_data: encrypt({ request: { provenance: "synthetic" }, provider: { id: "synthetic-private-invoice-id", href: "https://invalid.example/synthetic-private" } }, `recovery-invoice:${id.tenant}:${id.project}:${id.invoice}`), recipient_label: "Synthetic recipient", created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_invoice_payment_observations", { id: id.invoiceObservation, invoice_id: id.invoice, payment_identity_hash: token("invoice-payment"), state: "unknown", body_hash: token("invoice-body"), encrypted_data: encrypt({ provenance: "synthetic", approved: true, completed: false }, `invoice-payment:${id.tenant}:${id.invoice}:${token("invoice-payment")}`), observed_at: PRIVATE_DEADLINE });
    await insertFixture(tx, "fp_documents", { id: id.document, ...scope, actor_id: actor, intent_id: randomUUID(), purpose: "photo", provenance: "sample_document", content_type: "image/png", declared_bytes: png.length, expected_sha256: imageHash, pathname: originalPath, encrypted_data: encrypt(documentData, `document:${id.tenant}:${id.project}:${id.document}`), state: "ready", sha256: imageHash, page_count: 1, upload_expires_at: PRIVATE_DEADLINE, created_at: PRIVATE_EPOCH, updated_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_documents", { id: id.pendingDocument, ...scope, actor_id: actor, intent_id: randomUUID(), purpose: "receipt", provenance: "sample_document", content_type: "image/png", declared_bytes: png.length, expected_sha256: imageHash, pathname: `fieldproof/${id.pendingDocument}/original.png`, encrypted_data: encrypt({ ...documentData, pages: [] }, `document:${id.tenant}:${id.project}:${id.pendingDocument}`), upload_expires_at: PRIVATE_DEADLINE, created_at: PRIVATE_EPOCH, updated_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_plan_source_controls", { document_id: id.document, ...scope, version: 2, permission: "withdrawn", classification: "photograph", updated_at: PRIVATE_DEADLINE });
    const plan = { plan: { provenance: "synthetic" }, sources: [sourceBinding], packages: [{ id: "synthetic-package", version: 1 }] };
    await insertFixture(tx, "fp_plan_versions", { id: id.plan, ...scope, revision: 1, author_id: actor, origin: "sample", content_hash: digest(plan), geometry_hash: token("geometry"), source_hash: digest([sourceBinding]), package_hash: digest(plan.packages), encrypted_data: encrypt(plan, `plan:${id.tenant}:${id.project}:${id.plan}`), created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_photo_alignments", { id: id.alignment, ...scope, plan_id: id.plan, package_id: "synthetic-package", document_id: id.document, author_id: actor, content_hash: token("alignment"), encrypted_data: encrypt({ source: sourceBinding, sharedImage: { pathname: alignmentPath, sha256: imageHash, width: 1, height: 1 }, provenance: "synthetic" }, `photo-alignment:${id.tenant}:${id.project}:${id.alignment}`), state: "revoked", created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_proof_derivatives", { id: id.derivative, ...scope, package_id: "synthetic-package", document_id: id.document, content_hash: imageHash, encrypted_data: encrypt({ pathname: derivativePath, documentVersion: 1, documentHash: imageHash, sourcePageHash: imageHash, sample: true }, `proof-image:${id.tenant}:${id.project}:${id.derivative}`), state: "revoked", author_id: actor, created_at: PRIVATE_EPOCH });
    const funding = (kind: string, resource: string) => ({ id: resource, tenantId: id.tenant, projectId: id.project, provenance: "synthetic", kind, deadline: PRIVATE_DEADLINE });
    const policy = funding("mixed", id.fundingPolicy), cancellation = funding("cancelled", id.fundingCase), choice = { ...funding("return", id.fundingChoice), donorActorId: donor, amountMinor: 777 };
    await insertFixture(tx, "fp_funding_policies", { id: id.fundingPolicy, ...scope, package_id: "synthetic-package", package_version: 1, round_id: id.round, kind: "mixed", state: "closed", digest: sha256(canonicalJson(policy)), encrypted_data: encrypt(policy, `funding-policy:${id.tenant}:${id.project}:${id.fundingPolicy}`), expires_at: PRIVATE_DEADLINE, created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_funding_cases", { id: id.fundingCase, ...scope, package_id: "synthetic-package", package_version: 1, state: "closed", digest: sha256(canonicalJson(cancellation)), encrypted_data: encrypt(cancellation, `funding-case:${id.tenant}:${id.project}:${id.fundingCase}`), deadline: PRIVATE_DEADLINE, created_by: actor, membership_version: 1, created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_funding_choices", { id: id.fundingChoice, ...scope, case_id: id.fundingCase, receipt_id: id.receipt, donor_actor_id: donor, accepted_by: donor, membership_version: 1, version: 1, kind: "return", authority: "donor", amount_minor: "777", state: "return_pending", digest: sha256(canonicalJson(choice)), encrypted_data: encrypt(choice, `funding-choice:${id.tenant}:${id.project}:${id.fundingChoice}`), expires_at: PRIVATE_DEADLINE, created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_workspace_libraries", { id: id.library, token_hash: token("library"), expires_at: PRIVATE_DEADLINE, created_at: PRIVATE_EPOCH });
    for (const [session, project] of [[id.session, id.project], [id.otherSession, id.otherProject]]) await insertFixture(tx, "fp_workspace_library_entries", { library_id: id.library, session_id: session, tenant_id: id.tenant, project_id: project, actor_id: actor, encrypted_token: encrypt(`synthetic-session-${session}`, `workspace-library:${id.library}:${session}`), token_hash: token(session), saved_at: PRIVATE_EPOCH, ended_at: PRIVATE_DEADLINE });
    await insertFixture(tx, "fp_workspace_switch_events", { id: randomUUID(), library_id: id.library, from_session_id: id.session, to_session_id: id.otherSession, occurred_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_organizations", { id: id.organization, name: "Synthetic organization", description: "Private transfer fixture", identity_provenance: "self_declared", created_at: PRIVATE_EPOCH, updated_at: PRIVATE_EPOCH });
    for (const [member, role] of [[id.owner, "owner"], [id.revokedMember, "coordinator"]]) await insertFixture(tx, "fp_org_memberships", { id: member, organization_id: id.organization, role, authentication_origin: "creation_capability", encrypted_identity: encrypt({ displayName: "Synthetic member", identityProvenance: "self_declared", contractVersion: "organization-governance-v1" }, `organization:organization-governance-v1:member:${member}`), expires_at: "2030-01-01T00:00:00.123456Z", created_at: PRIVATE_EPOCH });
    for (const [session, member] of [[id.ownerSession, id.owner], [id.revokedSession, id.revokedMember]]) await insertFixture(tx, "fp_org_sessions", { id: session, organization_id: id.organization, membership_id: member, token_hash: token(session), expires_at: "2030-01-01T00:00:00.123456Z", created_at: PRIVATE_EPOCH });
    await tx.query("UPDATE fp_org_memberships SET state='revoked',version=version+1,revoked_at=clock_timestamp() WHERE id=$1", [id.revokedMember]);
    await tx.query("UPDATE fp_org_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [id.revokedSession]);
    // Ordinary guarded issuance first; the original fixed deadline then expires.
    const deadline = (await tx.query<{ value: string }>(`SELECT to_char(clock_timestamp()+interval '1 second','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') value`)).rows[0].value;
    await insertFixture(tx, "fp_org_memberships", { id: id.expiredMember, organization_id: id.organization, role: "auditor", authentication_origin: "invitation_possession", encrypted_identity: encrypt({ displayName: "Synthetic expired member", identityProvenance: "self_declared", contractVersion: "organization-governance-v1" }, `organization:organization-governance-v1:member:${id.expiredMember}`), expires_at: deadline, created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_org_sessions", { id: id.expiredSession, organization_id: id.organization, membership_id: id.expiredMember, token_hash: token("expired-session"), expires_at: deadline, created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_org_access", { id: id.orgAccess, organization_id: id.organization, membership_id: id.owner, session_id: id.ownerSession, authentication_origin: "creation_capability", original_browser_hash: token("browser"), acceptance_intent_id: randomUUID(), input_hash: token("acceptance"), return_token_hash: token("return-token"), encrypted_data: encrypt({ sessionToken: "synthetic-organization-session", returnToken: "synthetic-organization-return" }, `organization:organization-governance-v1:access:${id.orgAccess}`), expires_at: "2030-01-01T00:00:00.123456Z", created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_org_libraries", { id: id.orgLibrary, token_hash: token("org-library"), expires_at: "2030-01-01T00:00:00.123456Z", created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_org_library_entries", { id: id.orgLibraryEntry, library_id: id.orgLibrary, organization_id: id.organization, session_id: id.ownerSession, membership_id: id.owner, encrypted_data: encrypt({ sessionToken: "synthetic-organization-session" }, `organization:organization-governance-v1:library-entry:${id.orgLibraryEntry}`), created_at: PRIVATE_EPOCH });
    await insertFixture(tx, "fp_supporter_invites", { id: id.invite, ...scope, issuer_actor_id: actor, issuer_session_id: id.session, issuer_membership_version: 1, issuer_browser_hash: token("supporter-browser"), purpose: "donor", role: "donor", token_hash: token("supporter-invite"), encrypted_token: null, encrypted_data: encrypt({ label: "Synthetic invitation" }, `supporter-invite:${id.tenant}:${id.project}:${id.invite}`), state: "joined", joined_at: PRIVATE_EPOCH, created_at: PRIVATE_EPOCH, expires_at: PRIVATE_DEADLINE });
    await insertFixture(tx, "fp_supporter_access", { id: id.supporterAccess, invitation_id: id.invite, ...scope, actor_id: donor, session_id: id.donorSession, acceptance_intent_id: randomUUID(), acceptance_hash: token("supporter-acceptance"), browser_hash: token("supporter-browser"), encrypted_identity: encrypt({ displayName: "Synthetic donor" }, `supporter-access:${id.tenant}:${id.project}:${id.supporterAccess}:identity`), encrypted_acceptance: encrypt({ originalDeadline: PRIVATE_DEADLINE }, `supporter-access:${id.tenant}:${id.project}:${id.supporterAccess}:acceptance`), encrypted_session_token: encrypt("synthetic-expired-session", `supporter-access:${id.tenant}:${id.project}:${id.supporterAccess}:session`), recovery_token_hash: token("supporter-recovery"), encrypted_recovery_token: encrypt("synthetic-expired-recovery", `supporter-access:${id.tenant}:${id.project}:${id.supporterAccess}:recovery`), identity_provenance: "self_declared", authentication_method: "invitation_possession", created_at: PRIVATE_EPOCH, expires_at: PRIVATE_DEADLINE });
    await insertFixture(tx, "fp_events", { sequence: "9007199254740993", id: randomUUID(), ...scope, type: "synthetic.original", data: '{"provenance":"synthetic-qualification","originalBig":9007199254740993}', occurred_at: PRIVATE_EPOCH });
    await tx.query("ALTER SEQUENCE fp_events_sequence_seq RESTART WITH 9007199254740994; SELECT nextval('fp_events_sequence_seq')");
  });
  let expired = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    expired = (await owned.source.query<{ expired: boolean }>("SELECT expires_at<pg_catalog.clock_timestamp() expired FROM fp_org_sessions WHERE id=$1", [id.expiredSession])).rows[0].expired;
    if (expired) break; await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(expired, true, "The original ordinary-issued synthetic session must actually expire without a deadline write.");
  await extend({ owned, source, target, id, secret, png, imageHash, actor, donor });
  await setRuntimeHold(owned.source, true, "Synthetic original source held and drained");
  await setRuntimeHold(owned.target, true, "Synthetic fresh restricted destination held");
  const snapshot = await captureWorkspaceV2(source);
  const backupBytes = Buffer.from(JSON.stringify({ provenance: "synthetic-qualification", snapshot }));
  const backup: BackupEvidence = { kind: "operator-verified-private-backup", sourceIdentityHash: digest(snapshot.identity), catalogHash: snapshot.catalogHash, rowsHash: snapshot.rowsHash, sequenceHash: snapshot.sequenceHash, bytesHash: hash(backupBytes), byteLength: backupBytes.length, verifiedAt: snapshot.capturedAt, verification: "operator-recovery-reviewed", provenance: "synthetic-qualification" };
  const bundle = await exportWorkspaceV2(source, backup, backupBytes), plan = await planWorkspaceTransferV2(source, target, bundle, "Restore exact synthetic originals; retain the execution hold");
  return { owned, source, target, sourceDirectory, targetDirectory, id, actor, donor, secret, png, imageHash, originalPath, pagePath, alignmentPath, derivativePath, snapshot, backup, backupBytes, bundle, plan };
}
export type CompleteOperationsFixture = Awaited<ReturnType<typeof createCompleteOperationsFixture>>;
export function interceptDatabase(database: SqlDatabase, intercept: (sql: string, params: unknown[], next: () => Promise<unknown>, connection: SqlConnection) => Promise<unknown>): SqlDatabase {
  const wrap = (connection: SqlConnection): SqlConnection => ({ dialect: connection.dialect, query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
    try { return await intercept(sql, params, () => connection.query<T>(sql, params), connection) as QueryResult<T>; }
    catch(error) {
      const db=error as {code?:unknown;constraint?:unknown;table?:unknown;routine?:unknown;message?:unknown};
      if(typeof db.code==="string" && /^[A-Z0-9]{5}$/.test(db.code)) {
        const safe=(value:unknown)=>typeof value==="string"?value.replace(/v1\.[a-zA-Z0-9_.-]+/g,"[private-cipher]").replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g,"[private-id]").replace(/'[^']*'/g,"'[private-value]'").slice(0,600):null;
        await writeFile(path.resolve(process.cwd(),".local/operations-complete-v2-unit/last-sql-failure.private.json"),JSON.stringify({code:db.code,constraint:safe(db.constraint),table:safe(db.table),routine:safe(db.routine),message:safe(db.message),statementHash:hash(sql)},null,2)+"\n",{mode:0o600});
      }
      throw error;
    }
  } });
  return { ...wrap(database), transaction: work => database.transaction(tx => work(wrap(tx))), close: async () => undefined };
}
