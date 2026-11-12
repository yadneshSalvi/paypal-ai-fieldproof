import { randomUUID } from "node:crypto";
import type { SqlConnection } from "@fracture/paypal-core";
import {
  OPERATIONS_FORMAT, OPERATIONS_SOURCE_COMMIT, OperationsError, canonical, digest, equalHash, exactKeys, hash, identifier, requireOperation,
  type BackupEvidence, type Row, type Snapshot, type TableRows, type TransferEndpoint, type TransferPlanV2, type TransferReceiptV2, type WorkspaceBundleV2,
} from "../operations/contracts";
import { assertCatalog, assertRegistry } from "../operations/current-registry";
import { readCatalog, readRows, readSequences } from "../operations/catalog";
import { encryptionKeyHash } from "../operations/crypto";
import { assertOriginalLineage, insertionOrder, keyHash, originalRows, timestampMicros } from "../operations/lineage";
import { inspectPrivateLineage } from "../operations/private-lineage";
import { captureArtifacts, inspectDestinationArtifacts, stageArtifacts, verifyArtifacts } from "../operations/artifacts";
import { activationReview, assertDrained, assertFreshDestination, beginSnapshot, snapshotIn } from "../operations/snapshot";

export { captureWorkspaceV2 } from "../operations/snapshot";
export { sealTransferFile, openTransferFile } from "../operations/crypto";
export type { BackupEvidence, TransferEndpoint, TransferPlanV2, TransferReceiptV2, WorkspaceBundleV2 } from "../operations/contracts";

const DELTAS = ["destination-execution-control", "destination-hold-audit", "v2-import-audit"] as const;
const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const merchantHash = (value: string) => { requireOperation(typeof value === "string" && value.trim().length > 0, "KEY_MISMATCH", "The original and destination merchant binding must be explicit."); return hash(`fieldproof-transfer-merchant:${value}`); };
const configuration = (endpoint: TransferEndpoint) => ({ encryptionKeyHash: encryptionKeyHash(endpoint.authSecret), merchantHash: merchantHash(endpoint.merchantClientId), artifactNamespace: endpoint.artifactStore.namespace, artifactKind: endpoint.artifactStore.kind, artifactBinding: endpoint.artifactStore.binding });
function assertConfiguration(bundle: WorkspaceBundleV2, source: TransferEndpoint | null, target: TransferEndpoint): string {
  const destination = configuration(target);
  requireOperation(bundle.configuration.encryptionKeyHash === destination.encryptionKeyHash && bundle.configuration.merchantHash === destination.merchantHash, "KEY_MISMATCH", "The exact original encryption and merchant bindings must remain compatible; no secret is copied or rotated.");
  requireOperation(bundle.configuration.artifactNamespace === destination.artifactNamespace && bundle.configuration.artifactKind === destination.artifactKind, "ARTIFACT_CONFLICT", "The destination adapter must serve the same original private artifact namespace and keys.");
  if (source) requireOperation(canonical(configuration(source)) === canonical(bundle.configuration), "KEY_MISMATCH", "The reviewed original configuration binding changed.");
  return digest({ original: bundle.configuration, destination });
}
function validateBackup(backup: BackupEvidence, bytes: Uint8Array, source: Snapshot): void {
  exactKeys(backup, ["kind", "sourceIdentityHash", "catalogHash", "rowsHash", "sequenceHash", "bytesHash", "byteLength", "verifiedAt", "verification", "provenance"], "BACKUP_REQUIRED");
  requireOperation(backup.kind === "operator-verified-private-backup" && backup.verification === "operator-recovery-reviewed" && ["operator-cutover", "synthetic-qualification"].includes(backup.provenance) && backup.sourceIdentityHash === digest(source.identity) && backup.catalogHash === source.catalogHash && backup.rowsHash === source.rowsHash && backup.sequenceHash === source.sequenceHash && bytes.byteLength > 0 && backup.byteLength === bytes.byteLength && backup.bytesHash === hash(bytes) && Number.isFinite(Date.parse(backup.verifiedAt)) && timestampMicros(backup.verifiedAt) <= timestampMicros(source.capturedAt), "BACKUP_REQUIRED", "A private backup and explicit recovery review must bind this exact held original snapshot, catalog and sequence state.");
}
export async function exportWorkspaceV2(source: TransferEndpoint, backup: BackupEvidence, backupBytes: Uint8Array): Promise<WorkspaceBundleV2> {
  return source.database.transaction(async tx => {
    await beginSnapshot(tx, source);
    const snapshot = await snapshotIn(tx, source); assertDrained(snapshot); validateBackup(backup, backupBytes, snapshot);
    const rows = originalRows(snapshot.tables, snapshot.catalog), inspected = inspectPrivateLineage(rows, snapshot.tables, source.authSecret);
    requireOperation(rows.get("fp_projects")!.length > 0, "UNSUPPORTED_COVERAGE", "A whole-namespace transfer requires at least one original project audit anchor.");
    const artifacts = await captureArtifacts(inspected.needs, source.artifactStore);
    const id = randomUUID();
    requireOperation(!rows.get("fp_workspace_imports")!.some(row => row.id === id), "IMPORT_CONFLICT", "The new private bundle identity conflicts with original history.");
    return { format: OPERATIONS_FORMAT, id, codeCommit: OPERATIONS_SOURCE_COMMIT, schemaVersion: 21, scope: "whole-namespace", source: snapshot, configuration: configuration(source), backup,
      privateCoverage: { fields: inspected.fields, ciphertextHash: inspected.ciphertextHash, artifactBindingsHash: inspected.artifactBindingsHash }, ...artifacts, activation: activationReview(snapshot) };
  });
}
function validateBundle(bundle: WorkspaceBundleV2, secret: string): void {
  exactKeys(bundle, ["format", "id", "codeCommit", "schemaVersion", "scope", "source", "configuration", "backup", "privateCoverage", "artifacts", "absentArtifacts", "activation"]);
  requireOperation(bundle.format === OPERATIONS_FORMAT && uuid(bundle.id) && bundle.codeCommit === OPERATIONS_SOURCE_COMMIT && bundle.schemaVersion === 21 && bundle.scope === "whole-namespace", "UNSUPPORTED_COVERAGE", "The bundle is not the current qualified whole-namespace schema21 format.");
  const snapshot = bundle.source;
  exactKeys(snapshot, ["identity", "catalog", "catalogHash", "capturedAt", "tables", "rowsHash", "sequences", "sequenceHash", "execution"]);
  exactKeys(snapshot.identity, ["database", "schema", "role", "endpoint", "restrictionHash"]);
  exactKeys(snapshot.execution, ["held", "version", "activeRequests", "activeWorkers"]);
  exactKeys(bundle.configuration, ["encryptionKeyHash", "merchantHash", "artifactNamespace", "artifactKind", "artifactBinding"]);
  exactKeys(bundle.privateCoverage, ["fields", "ciphertextHash", "artifactBindingsHash"]);
  assertCatalog(snapshot.catalog);
  requireOperation(snapshot.catalogHash === digest(snapshot.catalog) && snapshot.rowsHash === digest(snapshot.tables) && snapshot.sequenceHash === digest(snapshot.sequences), "INVALID_BUNDLE", "The original snapshot digest changed.");
  const rows = originalRows(snapshot.tables, snapshot.catalog); assertRegistry(snapshot.catalog, rows.get("fp_schema_versions")!); assertOriginalLineage(rows, snapshot.catalog); assertDrained(snapshot);
  const inspected = inspectPrivateLineage(rows, snapshot.tables, secret);
  requireOperation(canonical(bundle.privateCoverage) === canonical({ fields: inspected.fields, ciphertextHash: inspected.ciphertextHash, artifactBindingsHash: inspected.artifactBindingsHash }) && canonical(bundle.activation) === canonical(activationReview(snapshot)), "PRIVATE_LINEAGE", "The reviewed private source or activation coverage is incomplete.");
  const keys = new Set<string>();
  requireOperation(Array.isArray(bundle.artifacts) && Array.isArray(bundle.absentArtifacts) && bundle.artifacts.length + bundle.absentArtifacts.length === inspected.needs.length, "PRIVATE_LINEAGE", "The bundle is missing exact original artifact coverage.");
  for (const artifact of bundle.artifacts) {
    exactKeys(artifact, ["key", "hash", "size", "contentType", "bindings", "bytes"]);
    const need = inspected.needs.find(item => item.key === artifact.key);
    requireOperation(need && !keys.has(artifact.key) && need.hash === artifact.hash && (need.size === null || need.size === artifact.size) && need.contentType === artifact.contentType && canonical(need.bindings) === canonical(artifact.bindings) && typeof artifact.bytes === "string" && hash(Buffer.from(artifact.bytes, "base64")) === artifact.hash && Buffer.from(artifact.bytes, "base64").byteLength === artifact.size, "PRIVATE_LINEAGE", "An original artifact has a changed byte, key, private binding or hash."); keys.add(artifact.key);
  }
  for (const absent of bundle.absentArtifacts) {
    exactKeys(absent, ["key", "expectedHash", "declaredSize", "uploadExpiresAt", "reason", "bindings"]);
    const need = inspected.needs.find(item => item.key === absent.key);
    requireOperation(need?.absence && !keys.has(absent.key) && canonical(absent) === canonical({ ...need.absence, bindings: need.bindings }), "PRIVATE_LINEAGE", "Only an original awaiting-upload draft may retain an explicitly absent artifact."); keys.add(absent.key);
  }
  requireOperation(snapshot.sequences.length === snapshot.catalog.sequences.length && snapshot.sequences.every(sequence => snapshot.catalog.sequences.some(item => item.name === sequence.name) && /^\d+$/.test(sequence.lastValue) && typeof sequence.isCalled === "boolean"), "PRIVATE_LINEAGE", "The bundle is missing an original sequence or cursor binding.");
}
function unchangedSource(actual: Snapshot, original: Snapshot): void {
  assertDrained(actual);
  requireOperation(digest(actual.identity) === digest(original.identity) && actual.catalogHash === original.catalogHash && actual.rowsHash === original.rowsHash && actual.sequenceHash === original.sequenceHash && actual.execution.version === original.execution.version, "SOURCE_CHANGED", "The source changed after its original held backup and export. No original payload or authority was renewed.");
}
function expectedPlanHash(bundle: WorkspaceBundleV2, destination: Snapshot, operatorReason: string): string {
  return digest({ originals: bundle.source.rowsHash, cursors: bundle.source.sequenceHash, destination: destination.rowsHash, bundle: bundle.id, deltas: DELTAS, operatorReason, activation: digest(bundle.activation) });
}
export async function planWorkspaceTransferV2(source: TransferEndpoint, destination: TransferEndpoint, bundle: WorkspaceBundleV2, operatorReason: string): Promise<TransferPlanV2> {
  validateBundle(bundle, source.authSecret); const configurationHash = assertConfiguration(bundle, source, destination);
  requireOperation(operatorReason.trim().length >= 8 && operatorReason.length <= 200 && !/[\r\n]/.test(operatorReason), "REVIEW_REQUIRED", "Record a bounded operator reason for this exact restore plan.");
  return source.database.transaction(async sourceTx => {
    await beginSnapshot(sourceTx, source); unchangedSource(await snapshotIn(sourceTx, source), bundle.source);
    await verifyArtifacts(bundle.artifacts, bundle.absentArtifacts, source.artifactStore);
    return destination.database.transaction(async targetTx => {
      await beginSnapshot(targetTx, destination); const target = await snapshotIn(targetTx, destination, true); assertFreshDestination(target);
      await inspectDestinationArtifacts(bundle.artifacts, bundle.absentArtifacts, destination.artifactStore);
      requireOperation(digest(target.identity) !== digest(bundle.source.identity), "DESTINATION_NOT_FRESH", "The source namespace cannot be its own restore destination.");
      const sourceRows = originalRows(bundle.source.tables, bundle.source.catalog), targetRows = originalRows(target.tables, target.catalog);
      requireOperation(!sourceRows.get("fp_runtime_control_events")!.some(row => targetRows.get("fp_runtime_control_events")!.some(other => other.id === row.id)) && !sourceRows.get("fp_runtime_control_events")!.some(row => row.id === `v2-import-hold:${bundle.id}`), "IMPORT_CONFLICT", "A destination control audit identity conflicts with original retained history.");
      return { format: "fieldproof-workspace-plan/v2", id: randomUUID(), bundleId: bundle.id, bundleHash: digest(bundle), sourceIdentityHash: digest(bundle.source.identity), destination: target, destinationIdentityHash: digest(target.identity), configurationHash,
        artifactHash: digest({ artifacts: bundle.artifacts, absent: bundle.absentArtifacts }), expectedHash: expectedPlanHash(bundle, target, operatorReason.trim()), activationHash: digest(bundle.activation), permittedDeltas: DELTAS, statement: "restore-originals-keep-execution-held", operatorReason: operatorReason.trim() };
    });
  });
}
function validatePlan(bundle: WorkspaceBundleV2, plan: TransferPlanV2, reviewedHash: string, configurationHash: string): void {
  exactKeys(plan, ["format", "id", "bundleId", "bundleHash", "sourceIdentityHash", "destination", "destinationIdentityHash", "configurationHash", "artifactHash", "expectedHash", "activationHash", "permittedDeltas", "statement", "operatorReason"]);
  requireOperation(plan.format === "fieldproof-workspace-plan/v2" && uuid(plan.id) && equalHash(digest(plan), reviewedHash) && plan.bundleId === bundle.id && plan.bundleHash === digest(bundle) && plan.sourceIdentityHash === digest(bundle.source.identity) && plan.destinationIdentityHash === digest(plan.destination.identity) && plan.configurationHash === configurationHash && plan.artifactHash === digest({ artifacts: bundle.artifacts, absent: bundle.absentArtifacts }) && plan.activationHash === digest(bundle.activation) && canonical(plan.permittedDeltas) === canonical(DELTAS) && plan.statement === "restore-originals-keep-execution-held" && plan.expectedHash === expectedPlanHash(bundle, plan.destination, plan.operatorReason), "REVIEW_REQUIRED", "Apply requires the exact reviewed original plan hash, destination, configuration and payload.");
  assertCatalog(plan.destination.catalog); assertFreshDestination(plan.destination);
}
const originalsHash = (tables: readonly TableRows[]) => digest(tables.filter(table => table.name !== "fp_runtime_control"));
function auditManifest(bundle: WorkspaceBundleV2, plan: TransferPlanV2, receipt: TransferReceiptV2): Row {
  return { format: "fieldproof-workspace-import-audit/v2", receipt, expectedHash: plan.expectedHash, originalSourceControl: bundle.source.tables.find(table => table.name === "fp_runtime_control")!.rows,
    destinationBaselineControlHash: plan.destination.tables.find(table => table.name === "fp_runtime_control")!.hash,
    destinationBaselineEventHash: plan.destination.tables.find(table => table.name === "fp_runtime_control_events")!.hash,
    permittedDeltas: DELTAS, activation: bundle.activation, backupHash: digest(bundle.backup), sourceIdentityHash: digest(bundle.source.identity), sourceCatalogHash: bundle.source.catalogHash,
    authority: "original-deadlines-no-new-grant", execution: "held-separate-activation-review-required" };
}
async function priorReceipt(tx: SqlConnection, bundle: WorkspaceBundleV2, plan: TransferPlanV2): Promise<TransferReceiptV2 | null> {
  const row = (await tx.query<{ bundle_hash: string; manifest: Row }>("SELECT bundle_hash,manifest FROM fp_workspace_imports WHERE id=$1", [bundle.id])).rows[0];
  if (!row) return null;
  const receipt = row.manifest?.receipt as TransferReceiptV2 | undefined;
  requireOperation(row.bundle_hash === digest(bundle) && row.manifest.format === "fieldproof-workspace-import-audit/v2" && receipt?.planHash === digest(plan) && receipt.bundleHash === digest(bundle) && receipt.destinationIdentityHash === plan.destinationIdentityHash && canonical(row.manifest) === canonical(auditManifest(bundle, plan, receipt)), "IMPORT_CONFLICT", "This import identity already belongs to a different original payload or reviewed plan.");
  return receipt;
}
async function insertOriginals(tx: SqlConnection, bundle: WorkspaceBundleV2): Promise<void> {
  const rows = originalRows(bundle.source.tables, bundle.source.catalog), sourceText = new Map<string, string>();
  for (const table of bundle.source.tables) for (const text of table.rows) sourceText.set(keyHash(table.name, JSON.parse(text)), text);
  const batches = insertionOrder(bundle.source.catalog, rows).filter(batch => batch.table !== "fp_runtime_control").map(batch => ({ table: batch.table, rows: batch.rows.map(row => sourceText.get(keyHash(batch.table, row))!) }));
  await tx.query("SELECT set_config('fieldproof.operations_restore_v2',$1,true)", [JSON.stringify(batches)]);
  // A single database round trip inserts all ordered tables. Only the exact
  // issuance trigger is suspended, only in this locked verified-empty target.
  // Its O mode is pinned by the catalog and restored before any comparison.
  await tx.query(`/* RESTORE ORIGINAL ROWS V2 */ DO $restore$
    DECLARE batch jsonb; original text; relation text;
    BEGIN
      SET CONSTRAINTS ALL DEFERRED;
      FOR batch IN SELECT value FROM jsonb_array_elements(current_setting('fieldproof.operations_restore_v2')::jsonb) LOOP
        relation := batch->>'table';
        IF relation='fp_schema_versions' THEN DELETE FROM fp_schema_versions; END IF;
        IF relation='fp_org_sessions' THEN
          IF EXISTS(SELECT 1 FROM fp_org_sessions) OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='fp_org_sessions'::regclass AND tgname='fp_org_session_retained' AND tgenabled='O' AND NOT tgisinternal) THEN RAISE EXCEPTION 'Original session restore target is not eligible'; END IF;
          ALTER TABLE fp_org_sessions DISABLE TRIGGER fp_org_session_retained;
        END IF;
        FOR original IN SELECT jsonb_array_elements_text(batch->'rows') LOOP
          IF relation='fp_org_sessions' AND NOT EXISTS(SELECT 1 FROM fp_org_memberships m WHERE m.organization_id=(original::jsonb->>'organization_id') AND m.id=(original::jsonb->>'membership_id') AND m.expires_at>=(original::jsonb->>'expires_at')::timestamptz) THEN RAISE EXCEPTION 'Original session membership lineage changed'; END IF;
          EXECUTE format('INSERT INTO %I SELECT * FROM jsonb_populate_record(NULL::%I,$1::jsonb)',relation,relation) USING original;
        END LOOP;
        IF relation='fp_org_sessions' THEN ALTER TABLE fp_org_sessions ENABLE TRIGGER fp_org_session_retained; END IF;
      END LOOP;
      SET CONSTRAINTS ALL IMMEDIATE;
    END $restore$`);
  for (const sequence of bundle.source.sequences) {
    const definition = bundle.source.catalog.sequences.find(item => item.name === sequence.name)!;
    requireOperation(BigInt(sequence.lastValue) >= BigInt(String(definition.min)) && BigInt(sequence.lastValue) <= BigInt(String(definition.max)), "PRIVATE_LINEAGE", "An original sequence exceeds its reviewed bounds.");
    // RESTART is transactional; setval would survive a failed import.
    await tx.query(`ALTER SEQUENCE ${identifier(sequence.name)} RESTART WITH ${sequence.lastValue}${sequence.isCalled ? `; SELECT nextval('${identifier(sequence.name)}'::regclass)` : ""}`);
  }
}
function equalRows(actual: readonly string[], expected: readonly string[]): boolean { return digest([...actual].sort()) === digest([...expected].sort()); }
function compareRestored(actual: TableRows[], sequences: Snapshot["sequences"], bundle: WorkspaceBundleV2, plan: TransferPlanV2, receipt: TransferReceiptV2): void {
  const original = originalRows(bundle.source.tables, bundle.source.catalog), current = originalRows(actual, bundle.source.catalog), baseline = originalRows(plan.destination.tables, plan.destination.catalog);
  for (const table of bundle.source.tables) if (!["fp_runtime_control", "fp_runtime_control_events", "fp_workspace_imports"].includes(table.name))
    requireOperation(equalRows(actual.find(item => item.name === table.name)!.rows, table.rows), "VERIFY_FAILED", "A restored original table differs in ID, state, hash, private binding, timestamp or row coverage.");
  const control = current.get("fp_runtime_control")!;
  requireOperation(control.length === 1 && control[0].key === "execution" && control[0].held === true && control[0].version === receipt.controlVersion && control[0].reason === plan.operatorReason && timestampMicros(String(control[0].updated_at)) === timestampMicros(receipt.importedAt), "VERIFY_FAILED", "The destination did not retain its exact reviewed execution hold.");
  const eventId = `v2-import-hold:${bundle.id}`, events = current.get("fp_runtime_control_events")!, event = events.find(item => item.id === eventId);
  requireOperation(event && event.held === true && event.version === receipt.controlVersion && event.reason === plan.operatorReason && timestampMicros(String(event.occurred_at)) === timestampMicros(receipt.importedAt), "VERIFY_FAILED", "The destination hold audit differs from its original reviewed import.");
  const expectedEvents = [...bundle.source.tables.find(item => item.name === "fp_runtime_control_events")!.rows, ...plan.destination.tables.find(item => item.name === "fp_runtime_control_events")!.rows];
  requireOperation(equalRows(actual.find(item => item.name === "fp_runtime_control_events")!.rows.filter(text => JSON.parse(text).id !== eventId), expectedEvents), "VERIFY_FAILED", "Original runtime-control history changed outside the declared destination audit delta.");
  const imports = actual.find(item => item.name === "fp_workspace_imports")!, audit = current.get("fp_workspace_imports")!.find(row => row.id === bundle.id), anchor = original.get("fp_projects")![0];
  requireOperation(audit && audit.bundle_hash === receipt.bundleHash && audit.tenant_id === anchor.tenant_id && audit.project_id === anchor.id && timestampMicros(String(audit.source_cutoff)) === timestampMicros(bundle.source.capturedAt) && canonical(audit.handoff_ids) === "[]" && timestampMicros(String(audit.imported_at)) === timestampMicros(receipt.importedAt) && canonical(audit.manifest) === canonical(auditManifest(bundle, plan, receipt)) && equalRows(imports.rows.filter(text => JSON.parse(text).id !== bundle.id), bundle.source.tables.find(item => item.name === "fp_workspace_imports")!.rows), "VERIFY_FAILED", "The original import lineage or narrowly declared v2 audit differs.");
  requireOperation(canonical(sequences) === canonical(bundle.source.sequences), "VERIFY_FAILED", "The original sequence/cursor state changed during restore.");
  requireOperation(events.length === original.get("fp_runtime_control_events")!.length + baseline.get("fp_runtime_control_events")!.length + 1, "VERIFY_FAILED", "The destination has unreviewed control history.");
}

export async function applyWorkspaceTransferV2(source: TransferEndpoint, destination: TransferEndpoint, bundle: WorkspaceBundleV2, plan: TransferPlanV2, reviewedHash: string): Promise<TransferReceiptV2> {
  validateBundle(bundle, source.authSecret); const configurationHash = assertConfiguration(bundle, source, destination); validatePlan(bundle, plan, reviewedHash, configurationHash);
  try {
    // An exact lost-response retry returns its original immutable receipt. It
    // does not restage files, rewrite originals or issue a replacement grant.
    const previous = await destination.database.transaction(async tx => {
      await beginSnapshot(tx, destination); const identity = await snapshotIn(tx, destination, true);
      requireOperation(digest(identity.identity) === plan.destinationIdentityHash, "DESTINATION_CHANGED", "The reviewed destination connection changed.");
      return priorReceipt(tx, bundle, plan);
    });
    if (previous) return previous;
    return await source.database.transaction(async sourceTx => {
      await beginSnapshot(sourceTx, source); unchangedSource(await snapshotIn(sourceTx, source), bundle.source);
      await verifyArtifacts(bundle.artifacts, bundle.absentArtifacts, source.artifactStore);
      return destination.database.transaction(async tx => {
        await beginSnapshot(tx, destination, true);
        const current = await snapshotIn(tx, destination, true), raced = await priorReceipt(tx, bundle, plan);
        if (raced) return raced;
        assertFreshDestination(current);
        requireOperation(digest(current.identity) === plan.destinationIdentityHash && current.catalogHash === plan.destination.catalogHash && current.rowsHash === plan.destination.rowsHash && current.sequenceHash === plan.destination.sequenceHash, "DESTINATION_CHANGED", "The fresh destination changed after the exact reviewed plan.");
        await stageArtifacts(bundle.artifacts, bundle.absentArtifacts, destination.artifactStore, bundle.id);
        await insertOriginals(tx, bundle);
        const importedAt = (await tx.query<{ value: string }>(`SELECT to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') value`)).rows[0].value;
        const controlVersion = Math.max(bundle.source.execution.version, current.execution.version) + 1;
        const receipt: TransferReceiptV2 = { format: "fieldproof-workspace-receipt/v2", bundleId: bundle.id, planHash: digest(plan), bundleHash: digest(bundle), importedAt, originalRows: bundle.source.tables.filter(table => table.name !== "fp_runtime_control").reduce((sum, table) => sum + table.count, 0), originalTables: 136, originalsHash: originalsHash(bundle.source.tables), destinationIdentityHash: plan.destinationIdentityHash, controlVersion, activationHash: digest(bundle.activation) };
        const anchor = originalRows(bundle.source.tables, bundle.source.catalog).get("fp_projects")![0];
        await tx.query(`UPDATE fp_runtime_control SET held=true,version=$1,reason=$2,updated_at=$3::timestamptz WHERE key='execution';`, [controlVersion, plan.operatorReason, importedAt]);
        await tx.query("INSERT INTO fp_runtime_control_events(id,held,version,reason,occurred_at) VALUES($1,true,$2,$3,$4::timestamptz)", [`v2-import-hold:${bundle.id}`, controlVersion, plan.operatorReason, importedAt]);
        await tx.query("INSERT INTO fp_workspace_imports(id,bundle_hash,tenant_id,project_id,source_cutoff,handoff_ids,manifest,imported_at) VALUES($1,$2,$3,$4,$5::timestamptz,'[]'::jsonb,$6::jsonb,$7::timestamptz)", [bundle.id, receipt.bundleHash, anchor.tenant_id, anchor.id, bundle.source.capturedAt, JSON.stringify(auditManifest(bundle, plan, receipt)), importedAt]);
        assertCatalog(await readCatalog(tx)); // Includes restored trigger mode.
        compareRestored(await readRows(tx, bundle.source.catalog), await readSequences(tx, bundle.source.catalog), bundle, plan, receipt);
        await verifyArtifacts(bundle.artifacts, bundle.absentArtifacts, destination.artifactStore);
        return receipt;
      });
    });
  } catch (error) {
    if (error instanceof OperationsError) throw error;
    // PostgreSQL diagnostics may contain original private rows. Never propagate
    // them through the CLI/operator result; keep the transaction rolled back.
    throw new OperationsError("IMPORT_FAILED", "The reviewed restore did not complete. Keep both namespaces held and retry only its exact original bundle and plan after inspecting the private failure evidence.");
  }
}
export async function verifyWorkspaceTransferV2(destination: TransferEndpoint, bundle: WorkspaceBundleV2, plan: TransferPlanV2, receipt: TransferReceiptV2): Promise<{ verified: true; rows: number; originalFamilies: 136; unchangedTables: 134; execution: "held" }> {
  validateBundle(bundle, destination.authSecret); const configurationHash = assertConfiguration(bundle, null, destination); validatePlan(bundle, plan, receipt.planHash, configurationHash);
  requireOperation(receipt.bundleId === bundle.id && receipt.bundleHash === digest(bundle) && receipt.destinationIdentityHash === plan.destinationIdentityHash && receipt.originalsHash === originalsHash(bundle.source.tables), "VERIFY_FAILED", "The original restore receipt does not match this bundle and destination.");
  return destination.database.transaction(async tx => {
    await beginSnapshot(tx, destination); const restored = await snapshotIn(tx, destination, true);
    requireOperation(digest(restored.identity) === plan.destinationIdentityHash, "VERIFY_FAILED", "The restore receipt belongs to a different destination.");
    compareRestored(restored.tables, restored.sequences, bundle, plan, receipt); await verifyArtifacts(bundle.artifacts, bundle.absentArtifacts, destination.artifactStore);
    return { verified: true, rows: receipt.originalRows, originalFamilies: 136, unchangedTables: 134, execution: "held" };
  });
}
