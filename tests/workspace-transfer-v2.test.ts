import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { before, test } from "node:test";
import type { SqlDatabase } from "@fracture/paypal-core";
import { SqlPaymentStore } from "@fracture/paypal-core";
import { OperationsError, digest, hash, type Row, type TransferReceiptV2, type WorkspaceBundleV2 } from "../lib/operations/contracts";
import { CURRENT_TABLES, PENDING_EXTENSIONS, assertCatalog, assertRegistry } from "../lib/operations/current-registry";
import { openOriginal, openTransferFile, sealOriginal, sealTransferFile } from "../lib/operations/crypto";
import { privateFileArtifacts } from "../lib/operations/artifacts";
import { scopedConnectionUrl } from "../lib/operations/operator-files";
import { openPrivate, paymentOperationCodec } from "../lib/server/private-values";
import { runWorkspaceTransferV2 } from "../scripts/workspace-transfer-v2";
import { runOperationsReviewV2 } from "../scripts/operations-review-v2";
import { assertOriginalLineage, originalRows, timestampMicros } from "../lib/operations/lineage";
import { privateContext } from "../lib/operations/private-lineage";
import { applyWorkspaceTransferV2, captureWorkspaceV2, exportWorkspaceV2, planWorkspaceTransferV2, verifyWorkspaceTransferV2 } from "../lib/server/workspace-transfer-v2";
import { createOperationsFixture, insertFixture, interceptDatabase, PRIVATE_DEADLINE, type OperationsFixture } from "./helpers/operations-v2-fixtures";

let f: OperationsFixture, receipt: TransferReceiptV2;
let cli: { config: string; bundle: string; plan: string; receipt: string; directory: string };
before(async () => { f = await createOperationsFixture(); });
const rejection = (code: string | string[]) => (error: unknown) => error instanceof OperationsError && (Array.isArray(code) ? code.includes(error.code) : error.code === code);
const mutate = (bundle: WorkspaceBundleV2, table: string, work: (rows: Row[]) => Row[]) => {
  const copy = structuredClone(bundle), item = copy.source.tables.find(entry => entry.name === table)!;
  item.rows = work(item.rows.map(row => JSON.parse(row))).map(row => JSON.stringify(row)); item.count = item.rows.length; item.hash = digest(item.rows); copy.source.rowsHash = digest(copy.source.tables); return copy;
};

test("current coverage is exactly 137 tables and pending22/23/24 hooks cannot silently enable themselves", () => {
  assert.equal(CURRENT_TABLES.length, 137); assert.equal(new Set(CURRENT_TABLES.map(table => table.name)).size, 137);
  assert.deepEqual(PENDING_EXTENSIONS.map(item => [item.schemaVersion, item.status]), [[22, "unintegrated-unqualified"], [23, "unintegrated-unqualified"], [24, "unintegrated-unqualified"]]);
  assertCatalog(f.bundle.source.catalog);
  assertRegistry(f.bundle.source.catalog, originalRows(f.bundle.source.tables, f.bundle.source.catalog).get("fp_schema_versions")!);
});
test("export and planning perform no writes and leave source rows, original deadlines, target baseline and sequences exact", async () => {
  const sourceBefore = await captureWorkspaceV2(f.source), targetBefore = await captureWorkspaceV2(f.target, true), statements: string[] = [];
  const observed = { ...f.source, database: interceptDatabase(f.source.database, async (sql, _params, next) => { statements.push(sql); assert(!/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE)\b/i.test(sql)); return next(); }) };
  const exported = await exportWorkspaceV2(observed, f.backup, f.backupBytes);
  await planWorkspaceTransferV2(observed, f.target, exported, "Read only synthetic plan with exact unchanged originals");
  const [sourceAfter, targetAfter] = await Promise.all([captureWorkspaceV2(f.source), captureWorkspaceV2(f.target, true)]);
  assert.equal(sourceAfter.rowsHash, sourceBefore.rowsHash); assert.equal(sourceAfter.sequenceHash, sourceBefore.sequenceHash);
  assert.equal(targetAfter.rowsHash, targetBefore.rowsHash); assert.equal(targetAfter.sequenceHash, targetBefore.sequenceHash);
  assert(statements.some(sql => sql.includes("READ ONLY"))); assert(statements.filter(sql => sql.includes("all_rows")).length <= 2);
});
test("whole namespace capture retains both projects and cross-project library originals", () => {
  const rows = originalRows(f.bundle.source.tables, f.bundle.source.catalog);
  assert.equal(rows.get("fp_projects")!.length, 2); assert.equal(rows.get("fp_workspace_library_entries")!.length, 2);
  assert.equal(rows.get("fp_workspace_switch_events")!.length, 1); assert.equal(f.bundle.source.tables.length, 137);
  assert.equal(f.bundle.configuration.encryptionKeyHash.length, 64); assert(!JSON.stringify(f.bundle).includes(f.secret));
});
test("the operator CLI performs guarded basis/export/plan with private files and a concrete review hash", async () => {
  const directory = path.join(f.owned.artifactRoot, "operator-cli"); await mkdir(directory, { mode: 0o700 });
  cli = { directory, config: path.join(directory, "operator.private.json"), bundle: path.join(directory, "bundle.sealed.json"), plan: path.join(directory, "plan.sealed.json"), receipt: path.join(directory, "receipt.sealed.json") };
  const local = JSON.parse(await readFile(path.resolve(process.cwd(), ".local/operations-v2-unit/private.json"), "utf8")) as { DATABASE_URL: string };
  const endpointFile = (endpoint: typeof f.source, directory: string) => ({ databaseUrl: local.DATABASE_URL, schema: endpoint.schema, label: endpoint.label, authSecret: f.secret, merchantClientId: endpoint.merchantClientId, artifacts: { kind: "private-files", directory, namespace: endpoint.artifactStore.namespace } });
  await writeFile(cli.config, JSON.stringify({ format: "fieldproof-workspace-operator/v2", source: endpointFile(f.source, f.sourceDirectory), destination: endpointFile(f.target, f.targetDirectory) }), { mode: 0o600 });
  const backupFile = path.join(directory, "synthetic.backup.private"), backupReview = path.join(directory, "backup-review.private.json");
  await writeFile(backupFile, f.backupBytes, { mode: 0o600 }); await writeFile(backupReview, JSON.stringify(f.backup), { mode: 0o600 });
  const output: unknown[] = [];
  await runWorkspaceTransferV2(["basis", "--config", cli.config, "--out", path.join(directory, "basis.private.json")], value => output.push(value));
  await runWorkspaceTransferV2(["export", "--config", cli.config, "--backup", backupFile, "--backup-review", backupReview, "--out", cli.bundle], value => output.push(value));
  f.bundle = openTransferFile<WorkspaceBundleV2>(await readFile(cli.bundle, "utf8"), "bundle", f.secret);
  await runWorkspaceTransferV2(["plan", "--config", cli.config, "--bundle", cli.bundle, "--reason", "Restore exact synthetic originals; retain the execution hold", "--out", cli.plan], value => output.push(value));
  f.plan = openTransferFile(await readFile(cli.plan, "utf8"), "plan", f.secret);
  assert.equal((output.at(-1) as Row).reviewHash, digest(f.plan)); assert.equal((await lstat(cli.bundle)).mode & 0o777, 0o600); assert.equal((await lstat(cli.plan)).mode & 0o777, 0o600);
  const sanitized = JSON.stringify(output); for (const privateValue of [f.secret, local.DATABASE_URL, f.id.session, "synthetic-private-source.png", "synthetic-private-vault"]) assert(!sanitized.includes(privateValue));
});
test("closed CLI options and sole search paths reject env injection before any database work", async () => {
  await assert.rejects(runWorkspaceTransferV2(["coverage", "--env-file", "unexpected"], () => undefined), rejection("INVALID_CONFIGURATION"));
  assert.throws(() => scopedConnectionUrl("postgres://synthetic:synthetic@127.0.0.1:55571/fp_governance_stage13?options=-c%20search_path=public", f.owned.schemas.target), rejection("INVALID_CONFIGURATION"));
  assert.throws(() => scopedConnectionUrl("postgres://synthetic:synthetic@unqualified.example:5432/test?sslmode=disable", "private_target"), rejection("INVALID_CONFIGURATION"));
});
test("a concrete private backup must bind exact original rows, catalog, sequence and actual backup bytes", async () => {
  await assert.rejects(exportWorkspaceV2(f.source, { ...f.backup, sequenceHash: hash("different-sequence") }, f.backupBytes), rejection("BACKUP_REQUIRED"));
  await assert.rejects(exportWorkspaceV2(f.source, f.backup, Buffer.from("different-backup")), rejection("BACKUP_REQUIRED"));
});
test("review binds the original plan, reason, destination and full payload without replacement intent or renewal", async () => {
  await assert.rejects(applyWorkspaceTransferV2(f.source, f.target, f.bundle, f.plan, hash("unreviewed-plan")), rejection("REVIEW_REQUIRED"));
  await assert.rejects(applyWorkspaceTransferV2(f.source, f.target, f.bundle, { ...f.plan, operatorReason: "A changed operator reason" }, digest(f.plan)), rejection("REVIEW_REQUIRED"));
});
test("unknown future catalog, missing table, missing key and missing private column coverage refuse explicitly", () => {
  for (const alteration of [(c: typeof f.bundle.source.catalog) => { c.tables.push({ ...c.tables[0], name: "fp_unqualified_lifecycle22" }); }, (c: typeof f.bundle.source.catalog) => { c.tables.pop(); }, (c: typeof f.bundle.source.catalog) => { c.tables[0].keys = []; }, (c: typeof f.bundle.source.catalog) => { c.tables.find(t => t.name === "fp_documents")!.columns = c.tables.find(t => t.name === "fp_documents")!.columns.filter(column => column.name !== "encrypted_data"); }]) {
    const changed = structuredClone(f.bundle.source.catalog); alteration(changed); assert.throws(() => assertCatalog(changed), rejection("CATALOG_CHANGED"));
  }
});
test("schema marker22 and an unknown target table are refused without initialization or a global marker", async () => {
  await f.target.database.query("INSERT INTO fp_schema_versions(version) VALUES(22)");
  try { await assert.rejects(planWorkspaceTransferV2(f.source, f.target, f.bundle, "Refuse unqualified schema22 synthetic target"), rejection("UNSUPPORTED_COVERAGE")); }
  finally { await f.target.database.query("DELETE FROM fp_schema_versions WHERE version=22"); }
  await f.target.database.query("CREATE TABLE fp_unqualified_future_family(id text PRIMARY KEY)");
  try { await assert.rejects(planWorkspaceTransferV2(f.source, f.target, f.bundle, "Refuse unqualified future synthetic family"), rejection("CATALOG_CHANGED")); }
  finally { await f.target.database.query("DROP TABLE fp_unqualified_future_family"); }
});
test("missing, duplicated and unsupported bundle table families cannot be omitted silently", async () => {
  for (const change of [(b: WorkspaceBundleV2) => { b.source.tables.pop(); }, (b: WorkspaceBundleV2) => { b.source.tables.push(b.source.tables[0]); }, (b: WorkspaceBundleV2) => { b.source.tables.push({ name: "fp_unknown", rows: [], count: 0, hash: digest([]) }); }]) {
    const copy = structuredClone(f.bundle); change(copy); copy.source.rowsHash = digest(copy.source.tables);
    await assert.rejects(planWorkspaceTransferV2(f.source, f.target, copy, "Refuse incomplete original table coverage"), rejection("UNSUPPORTED_COVERAGE"));
  }
});
test("missing original dependencies and duplicate immutable row keys are rejected before target mutation", async () => {
  const missing = mutate(f.bundle, "fp_obligations", () => []);
  await assert.rejects(planWorkspaceTransferV2(f.source, f.target, missing, "Missing synthetic original obligation"), rejection("PRIVATE_LINEAGE"));
  const duplicate = mutate(f.bundle, "fp_sessions", rows => [...rows, rows[0]]);
  await assert.rejects(planWorkspaceTransferV2(f.source, f.target, duplicate, "Duplicated synthetic original session"), rejection("PRIVATE_LINEAGE"));
});
test("private ciphertext must authenticate its original project and resource identity", async () => {
  const crossed = mutate(f.bundle, "fp_documents", rows => rows.map(row => row.id === f.id.document ? { ...row, encrypted_data: sealOriginal({ pages: [] }, `document:${f.id.tenant}:${f.id.otherProject}:${f.id.document}`, f.secret) } : row));
  await assert.rejects(planWorkspaceTransferV2(f.source, f.target, crossed, "Reject crossed original private project binding"), rejection("PRIVATE_LINEAGE"));
  const body = mutate(f.bundle, "fp_documents", rows => rows.map(row => row.id === f.id.document ? { ...row, encrypted_data: "v1.invalid.invalid.invalid" } : row));
  await assert.rejects(planWorkspaceTransferV2(f.source, f.target, body, "Reject damaged original private source body"), rejection("PRIVATE_LINEAGE"));
});
test("crossed organization members, mismatched payment documents and unregistered nested private fields cannot pass lineage", async () => {
  const crossedMember = mutate(f.bundle, "fp_org_sessions", rows => rows.map(row => row.id === f.id.expiredSession ? { ...row, membership_id: randomUUID() } : row));
  await assert.rejects(planWorkspaceTransferV2(f.source, f.target, crossedMember, f.plan.operatorReason), rejection("PRIVATE_LINEAGE"));
  const wrongPayment = mutate(f.bundle, "paycore_operations", rows => rows.map(row => {
    const wrapper = JSON.parse(String(row.document)), operation = JSON.parse(openOriginal<string>(wrapper.ciphertext, `paycore-operation:${row.tenant_id}:${row.project_id}:${row.id}`, f.secret));
    operation.command.scope.projectId = f.id.otherProject;
    return { ...row, document: JSON.stringify({ ...wrapper, ciphertext: sealOriginal(JSON.stringify(operation), `paycore-operation:${row.tenant_id}:${row.project_id}:${row.id}`, f.secret) }) };
  }));
  await assert.rejects(planWorkspaceTransferV2(f.source, f.target, wrongPayment, f.plan.operatorReason), rejection("PRIVATE_LINEAGE"));
  const uncovered = mutate(f.bundle, "fp_outbox", rows => rows.map(row => ({ ...row, data: { ...(row.data as Row), unregisteredPrivateSource: sealOriginal("synthetic-private-body", "unqualified-context", f.secret) } })));
  await assert.rejects(planWorkspaceTransferV2(f.source, f.target, uncovered, f.plan.operatorReason), rejection("PRIVATE_LINEAGE"));
});
test("a destination key or merchant change cannot make original ciphertext or payment lineage appear compatible", async () => {
  await assert.rejects(planWorkspaceTransferV2(f.source, { ...f.target, authSecret: "different-synthetic-secret-at-least-thirty-two-characters" }, f.bundle, "Changed synthetic destination encryption binding"), rejection("KEY_MISMATCH"));
  await assert.rejects(planWorkspaceTransferV2(f.source, { ...f.target, merchantClientId: "other-synthetic-merchant" }, f.bundle, "Changed synthetic destination merchant binding"), rejection("KEY_MISMATCH"));
});
test("the original private artifact namespace, paths, content type, bytes and complete bindings are mandatory", async () => {
  await assert.rejects(planWorkspaceTransferV2(f.source, { ...f.target, artifactStore: { ...f.target.artifactStore, namespace: "different-private-namespace" } }, f.bundle, "Reject unrelated private artifact namespace"), rejection("ARTIFACT_CONFLICT"));
  const omitted = structuredClone(f.bundle); omitted.artifacts.pop();
  await assert.rejects(planWorkspaceTransferV2(f.source, f.target, omitted, "Reject omitted private artifact bytes"), rejection("PRIVATE_LINEAGE"));
  const changed = structuredClone(f.bundle); changed.artifacts[0].bytes = Buffer.from("changed-private-original").toString("base64");
  await assert.rejects(planWorkspaceTransferV2(f.source, f.target, changed, "Reject changed private artifact bytes"), rejection("PRIVATE_LINEAGE"));
});
test("a missing original source artifact blocks planning and keeps both snapshots unchanged", async () => {
  const missing = { ...f.source, artifactStore: { ...f.source.artifactStore, async verify(key: string, hash: string, size: number, contentType: string) { if (key === f.originalPath) throw new OperationsError("ARTIFACT_MISSING", "Synthetic missing original source artifact."); await f.source.artifactStore.verify(key, hash, size, contentType); } } };
  await assert.rejects(planWorkspaceTransferV2(missing, f.target, f.bundle, f.plan.operatorReason), rejection("ARTIFACT_MISSING"));
  assert.equal((await captureWorkspaceV2(f.source)).rowsHash, f.bundle.source.rowsHash); assert.equal((await captureWorkspaceV2(f.target, true)).rowsHash, f.plan.destination.rowsHash);
});
test("expired awaiting-upload drafts retain explicit absence instead of fabricated bytes or a new upload deadline", () => {
  assert.equal(f.bundle.absentArtifacts.length, 1); const absent = f.bundle.absentArtifacts[0];
  assert.equal(absent.reason, "original-awaiting-upload"); assert.equal(timestampMicros(absent.uploadExpiresAt), timestampMicros(PRIVATE_DEADLINE));
  assert(!f.bundle.artifacts.some(artifact => artifact.key === absent.key));
});
test("original session/member lineage is enforced without requiring a historical member to be currently active", async () => {
  const rows = originalRows(f.bundle.source.tables, f.bundle.source.catalog); assertOriginalLineage(rows, f.bundle.source.catalog);
  const expired = rows.get("fp_org_sessions")!.find(row => row.id === f.id.expiredSession)!;
  assert.equal((await f.source.database.query<{ expired: boolean }>("SELECT expires_at<clock_timestamp() expired FROM fp_org_sessions WHERE id=$1", [expired.id])).rows[0].expired, true);
  assert.equal(rows.get("fp_org_memberships")!.find(row => row.id === f.id.revokedMember)!.state, "revoked");
  const invalid = new Map(rows); invalid.set("fp_org_sessions", rows.get("fp_org_sessions")!.map(row => row.id === f.id.expiredSession ? { ...row, expires_at: "2031-01-01T00:00:00.123456Z" } : row));
  assert.throws(() => assertOriginalLineage(invalid, f.bundle.source.catalog), rejection("PRIVATE_LINEAGE"));
});
test("public access to the private destination is refused before reading its domain rows", async () => {
  const schema = `"${f.owned.schemas.target}"`; await f.target.database.query(`GRANT USAGE ON SCHEMA ${schema} TO PUBLIC`);
  try { await assert.rejects(planWorkspaceTransferV2(f.source, f.target, f.bundle, "Refuse a public synthetic destination namespace"), rejection("DESTINATION_NOT_RESTRICTED")); }
  finally { await f.target.database.query(`REVOKE USAGE ON SCHEMA ${schema} FROM PUBLIC`); }
});
test("a nonempty restricted destination is refused and its conflicting original row is untouched", async () => {
  await insertFixture(f.target.database, "fp_tenants", { id: "synthetic-conflict", mode: "sample" });
  try {
    await assert.rejects(planWorkspaceTransferV2(f.source, f.target, f.bundle, "Refuse a nonempty synthetic destination"), rejection("DESTINATION_NOT_FRESH"));
    assert.equal((await f.target.database.query("SELECT id FROM fp_tenants WHERE id='synthetic-conflict'")).rows.length, 1);
  } finally { await f.target.database.query("DELETE FROM fp_tenants WHERE id='synthetic-conflict'"); }
});
test("an empty target with an advanced cursor is refused instead of reusing authority or event sequence", async () => {
  await f.target.database.query("SELECT nextval('fp_events_sequence_seq')");
  try { await assert.rejects(planWorkspaceTransferV2(f.source, f.target, f.bundle, "Refuse a consumed synthetic destination cursor"), rejection("DESTINATION_NOT_FRESH")); }
  finally { await f.target.database.query("ALTER SEQUENCE fp_events_sequence_seq RESTART WITH 1"); }
});
test("active source worker leases and still-valid upload grants block export without changing their deadlines", async () => {
  const old = (await f.source.database.query<{ id: string; original: string }>("SELECT id,to_jsonb(lease_until)#>>'{}' original FROM fp_outbox LIMIT 1")).rows[0];
  await f.source.database.query("UPDATE fp_outbox SET lease_until=clock_timestamp()+interval '1 minute' WHERE id=$1", [old.id]);
  try { await assert.rejects(exportWorkspaceV2(f.source, f.backup, f.backupBytes), rejection("SOURCE_NOT_DRAINED")); }
  finally { await f.source.database.query("UPDATE fp_outbox SET lease_until=$2::timestamptz WHERE id=$1", [old.id, old.original]); }
  await f.source.database.query("UPDATE fp_documents SET upload_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1", [f.id.pendingDocument]);
  try { await assert.rejects(exportWorkspaceV2(f.source, f.backup, f.backupBytes), rejection("SOURCE_NOT_DRAINED")); }
  finally { await f.source.database.query("UPDATE fp_documents SET upload_expires_at=$2::timestamptz WHERE id=$1", [f.id.pendingDocument, PRIVATE_DEADLINE]); }
});
test("a source change after backup/export blocks apply and preserves the reviewed fresh destination", async () => {
  const id = randomUUID(); await insertFixture(f.source.database, "fp_evidence", { id, tenant_id: f.id.tenant, project_id: f.id.project, data: { provenance: "synthetic-change-after-plan" } });
  try { await assert.rejects(applyWorkspaceTransferV2(f.source, f.target, f.bundle, f.plan, digest(f.plan)), rejection("SOURCE_CHANGED")); }
  finally { await f.source.database.query("DELETE FROM fp_evidence WHERE id=$1", [id]); }
  assert.equal((await captureWorkspaceV2(f.target, true)).rowsHash, f.plan.destination.rowsHash);
});
test("a destination change after review blocks apply with its original payload and row intact", async () => {
  await f.target.database.query("UPDATE fp_runtime_control SET reason='A changed synthetic target hold reason' WHERE key='execution'");
  try { await assert.rejects(applyWorkspaceTransferV2(f.source, f.target, f.bundle, f.plan, digest(f.plan)), rejection(["DESTINATION_NOT_FRESH", "DESTINATION_CHANGED"])); }
  finally { await f.target.database.query("UPDATE fp_runtime_control SET reason=$1 WHERE key='execution'", [JSON.parse(f.plan.destination.tables.find(table => table.name === "fp_runtime_control")!.rows[0]).reason]); }
});
test("a failed import while the exact org issuance trigger is suspended rolls back rows and original trigger mode", async () => {
  // Keep the database transaction owner real, but inject one server failure
  // immediately after that transaction suspends its named issuance guard.
  const db: SqlDatabase = { dialect: f.target.database.dialect, query: f.target.database.query.bind(f.target.database), close: async () => undefined,
    transaction: work => f.target.database.transaction(tx => work({ dialect: tx.dialect, query: (sql, params = []) => tx.query(sql.includes("RESTORE ORIGINAL ROWS V2") ? sql.replace("ALTER TABLE fp_org_sessions DISABLE TRIGGER fp_org_session_retained;", "ALTER TABLE fp_org_sessions DISABLE TRIGGER fp_org_session_retained; RAISE EXCEPTION 'synthetic interrupted original-session restore';") : sql, params) })) };
  await assert.rejects(applyWorkspaceTransferV2(f.source, { ...f.target, database: db }, f.bundle, f.plan, digest(f.plan)), rejection("IMPORT_FAILED"));
  assert.equal((await captureWorkspaceV2(f.target, true)).rowsHash, f.plan.destination.rowsHash);
  assert.equal((await f.target.database.query<{ enabled: string }>("SELECT tgenabled enabled FROM pg_trigger WHERE tgrelid='fp_org_sessions'::regclass AND tgname='fp_org_session_retained'")).rows[0].enabled, "O");
});
test("failure after transactional sequence restart restores the fresh sequence and all original-row insertions", async () => {
  const broken = { ...f.target, database: interceptDatabase(f.target.database, async (sql, _params, next) => { const result = await next(); if (sql.startsWith("ALTER SEQUENCE")) throw new Error("Synthetic crash after sequence restart"); return result; }) };
  await assert.rejects(applyWorkspaceTransferV2(f.source, broken, f.bundle, f.plan, digest(f.plan)), rejection("IMPORT_FAILED"));
  const after = await captureWorkspaceV2(f.target, true); assert.equal(after.rowsHash, f.plan.destination.rowsHash); assert.deepEqual(after.sequences, f.plan.destination.sequences);
});
test("a lost commit response is recovered by the original plan and stable receipt with no second restore or renewal", async () => {
  let committed = false, queries = 0, batches = 0;
  const targetDatabase: SqlDatabase = { dialect: f.target.database.dialect, query: f.target.database.query.bind(f.target.database), close: async () => undefined,
    async transaction(work) {
      let insertsAudit = false;
      const result = await f.target.database.transaction(tx => work({ dialect: tx.dialect, async query(sql, params = []) { queries++; if (sql.includes("RESTORE ORIGINAL ROWS V2")) batches++; if (sql.startsWith("INSERT INTO fp_workspace_imports")) insertsAudit = true; return tx.query(sql, params); } }));
      if (insertsAudit && !committed) { committed = true; throw new Error("Synthetic lost commit response"); } return result;
    } };
  const sourceBefore = await captureWorkspaceV2(f.source);
  await assert.rejects(applyWorkspaceTransferV2(f.source, { ...f.target, database: targetDatabase }, f.bundle, f.plan, digest(f.plan)), rejection("IMPORT_FAILED"));
  assert(committed); assert.equal(batches, 1); assert(queries < 60, `Expected batched catalog/rows, observed ${queries} target round trips.`);
  receipt = await applyWorkspaceTransferV2(f.source, f.target, f.bundle, f.plan, digest(f.plan));
  const again = await applyWorkspaceTransferV2(f.source, f.target, f.bundle, f.plan, digest(f.plan)); assert.deepEqual(again, receipt);
  const sourceAfter = await captureWorkspaceV2(f.source); assert.equal(sourceAfter.rowsHash, sourceBefore.rowsHash); assert.deepEqual(sourceAfter.sequences, sourceBefore.sequences);
});
test("verification preserves exact originals across 136 families, with only 134 whole tables unchanged and declared control/import deltas", async () => {
  const result = await verifyWorkspaceTransferV2(f.target, f.bundle, f.plan, receipt);
  assert.deepEqual(result, { verified: true, rows: receipt.originalRows, originalFamilies: 136, unchangedTables: 134, execution: "held" });
  assert.equal(receipt.originalTables, 136); assert.equal(f.bundle.source.tables.length, 137);
  const imported = (await f.target.database.query<{ manifest: Row }>("SELECT manifest FROM fp_workspace_imports WHERE id=$1", [f.bundle.id])).rows[0].manifest;
  assert.equal(imported.authority, "original-deadlines-no-new-grant"); assert.equal(imported.execution, "held-separate-activation-review-required");
});
test("bigint IDs, nested JSON numbers, original event cursor and microsecond deadlines remain exact", async () => {
  const result = (await f.target.database.query<{ budget: string; sequence: string; nested: string; deadline: string }>(`SELECT (SELECT budget_minor::text FROM fp_packages LIMIT 1) budget,(SELECT sequence::text FROM fp_events LIMIT 1) sequence,(SELECT data->>'originalBig' FROM fp_events LIMIT 1) nested,(SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM fp_sessions WHERE id=$1) deadline`, [f.id.donorSession])).rows[0];
  assert.equal(result.budget, "9007199254740993"); assert.equal(result.sequence, "9007199254740993"); assert.equal(result.nested, "9007199254740993"); assert.equal(timestampMicros(result.deadline), timestampMicros(PRIVATE_DEADLINE));
  assert.equal(timestampMicros("2000-01-01T00:00:00.123457Z") - timestampMicros("2000-01-01T00:00:00.123456Z"), 1n);
});
test("pending financial, outbox, webhook and original expired lease records retain their source status and attempts", async () => {
  const actual = await captureWorkspaceV2(f.target, true);
  for (const name of ["paycore_operations", "paycore_attempts", "paycore_webhook_events", "paycore_webhook_deliveries", "fp_provider_operations", "fp_outbox", "fp_webhook_jobs", "fp_request_leases", "fp_conditional_consents", "fp_funding_choices", "fp_recovery_invoices"]) assert.deepEqual(actual.tables.find(table => table.name === name), f.bundle.source.tables.find(table => table.name === name));
  assert.equal(f.bundle.activation.uncertainFinancialReplay, false); assert.equal(f.bundle.activation.activation, "separate-root-review-required");
});
test("old expired and revoked-member org sessions restore byte-for-byte, while ordinary issuance remains denied", async () => {
  for (const membership of [f.id.expiredMember, f.id.revokedMember]) {
    const deadline = (await f.target.database.query<{ value: string }>(`SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') value FROM fp_org_memberships WHERE id=$1`, [membership])).rows[0].value;
    const unexpected = new Error("The original issuance guard unexpectedly admitted a historical session");
    // Even an unexpected admission is rolled back before the assertion reports
    // failure, so later independent verification is not contaminated.
    await assert.rejects(f.target.database.transaction(async tx => { await insertFixture(tx, "fp_org_sessions", { id: randomUUID(), organization_id: f.id.organization, membership_id: membership, token_hash: hash(randomUUID()), expires_at: deadline, created_at: "2000-01-01T00:00:00.123456Z" }); throw unexpected; }), (error: unknown) => error !== unexpected && error instanceof Error && "code" in error && error.code === "23514" && error.message === "Session must use the original current membership deadline");
  }
  const actual = await captureWorkspaceV2(f.target, true);
  for (const name of ["fp_org_sessions", "fp_org_memberships", "fp_org_access", "fp_org_library_entries", "fp_supporter_access", "fp_supporter_invites"]) assert.deepEqual(actual.tables.find(table => table.name === name), f.bundle.source.tables.find(table => table.name === name));
});
test("restored ciphertext opens under the exact original key and AAD, including withdrawn private sources", async () => {
  const restored = await captureWorkspaceV2(f.target, true), rows = originalRows(restored.tables, restored.catalog), document = rows.get("fp_documents")!.find(row => row.id === f.id.document)!;
  const original = originalRows(f.bundle.source.tables, f.bundle.source.catalog).get("fp_documents")!.find(row => row.id === f.id.document)!;
  assert.equal(document.encrypted_data, original.encrypted_data);
  const context = privateContext("fp_documents", "encrypted_data", document, rows), data = openOriginal<Row>(document.encrypted_data, context, f.secret); assert.equal(data.filename, "synthetic-private-source.png");
  assert.deepEqual(openPrivate(document.encrypted_data as string, context), data);
  const actualPayment = await new SqlPaymentStore(f.target.database, { operationDocumentCodec: paymentOperationCodec }).get({ tenantId: f.id.tenant, projectId: f.id.project }, f.id.operation);
  assert.equal(actualPayment?.status, "pending_reconciliation"); assert.equal(actualPayment?.command.providerRequestId, "synthetic-provider-request-no-network"); assert.equal(actualPayment?.receipt, null);
  assert.equal(rows.get("fp_plan_source_controls")![0].permission, "withdrawn");
  await f.target.artifactStore.verify(f.originalPath, f.imageHash, f.png.length, "image/png");
  for (const key of [f.originalPath, f.pagePath, f.derivativePath, f.alignmentPath]) assert.equal((await lstat(path.join(f.targetDirectory, key))).mode & 0o777, 0o600);
  assert.equal((await lstat(f.targetDirectory)).mode & 0o777, 0o700);
});
test("the same reviewed CLI apply and verify recover the stable receipt privately without another import", async () => {
  const output: unknown[] = [];
  await runWorkspaceTransferV2(["apply", "--config", cli.config, "--bundle", cli.bundle, "--plan", cli.plan, "--review-hash", digest(f.plan), "--out", cli.receipt], value => output.push(value));
  const bytesBefore = await readFile(cli.receipt), statBefore = await lstat(cli.receipt, { bigint: true });
  await runWorkspaceTransferV2(["apply", "--config", cli.config, "--bundle", cli.bundle, "--plan", cli.plan, "--review-hash", digest(f.plan), "--out", cli.receipt], value => output.push(value));
  assert.deepEqual(await readFile(cli.receipt), bytesBefore); assert.equal((await lstat(cli.receipt, { bigint: true })).mtimeNs, statBefore.mtimeNs);
  await runWorkspaceTransferV2(["verify", "--config", cli.config, "--bundle", cli.bundle, "--plan", cli.plan, "--receipt", cli.receipt], value => output.push(value));
  assert.deepEqual(openTransferFile(bytesBefore.toString("utf8"), "receipt", f.secret), receipt);
  assert(!JSON.stringify(output).includes(f.id.session)); assert(!JSON.stringify(output).includes(f.secret));
});
test("offline dependency, provenance, coverage and retention review is finite and cannot authorize cleanup", async () => {
  const filename = path.join(cli.directory, "operations-review.private.json"), output: unknown[] = [];
  await runOperationsReviewV2(["--out", filename], value => output.push(value));
  const report = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(report.tables, 137); assert.equal(report.families.length, 14); assert.equal(report.cleanupAuthorized, false); assert.equal(report.configuration.valuesRead, false);
  assert(report.dependencies.lockedPackages > 400); assert.equal(report.validation.liveProviderCalls, false); assert.equal(report.validation.productionBackupRestore, "root-owned-external-gate");
  assert(!JSON.stringify(report).includes(f.secret)); assert.equal((await lstat(filename)).mode & 0o777, 0o600);
});
test("an exact receipt cannot be replayed for a different reviewed payload or target connection", async () => {
  const changed = { ...f.plan, id: randomUUID() };
  await assert.rejects(applyWorkspaceTransferV2(f.source, f.target, f.bundle, changed, digest(changed)), rejection("IMPORT_CONFLICT"));
  await assert.rejects(applyWorkspaceTransferV2(f.source, { ...f.target, endpoint: hash("other-target") }, f.bundle, f.plan, digest(f.plan)), rejection("DESTINATION_CHANGED"));
});
test("verification detects a changed original artifact instead of treating a stored file or row count as sufficient", async () => {
  const filename = path.join(f.targetDirectory, f.originalPath); await writeFile(filename, Buffer.from("synthetic-corrupted-original"), { mode: 0o600 });
  try { await assert.rejects(verifyWorkspaceTransferV2(f.target, f.bundle, f.plan, receipt), rejection("ARTIFACT_CONFLICT")); }
  finally { await writeFile(filename, f.png, { mode: 0o600 }); }
});
test("private bundle, plan and receipt envelopes authenticate purpose, identity and bytes without carrying configuration secrets", () => {
  for (const [purpose, value, id] of [["bundle", f.bundle, f.bundle.id], ["plan", f.plan, f.plan.id], ["receipt", receipt, f.bundle.id]] as const) {
    const file = sealTransferFile(value, purpose, id, f.secret); assert(!file.includes(f.secret)); assert(!file.includes("synthetic-private-source.png")); assert.deepEqual(openTransferFile(file, purpose, f.secret), value);
    assert.throws(() => openTransferFile(file, purpose === "bundle" ? "plan" : "bundle", f.secret), rejection("INVALID_BUNDLE"));
  }
});
test("private artifact staging resumes only its own interrupted journal and refuses different bytes", async () => {
  const directory = path.join(f.owned.artifactRoot, "interrupted-stage"); await mkdir(directory, { mode: 0o700 }); const store = await privateFileArtifacts(directory, "synthetic-interrupted-private-store"), bundleId = randomUUID(), key = `fieldproof/${randomUUID()}/original.png`;
  await writeFile(path.join(directory, `.artifact-${hash(key)}.json`), JSON.stringify({ format: "fieldproof-artifact-stage/v2", key, hash: f.imageHash, size: f.png.length, contentType: "image/png", bundleId }), { mode: 0o600 });
  await writeFile(path.join(directory, `.stage-${bundleId}-${hash(key)}`), Buffer.from("partial-own-stage"), { mode: 0o600 });
  await store.stage(key, f.png, "image/png", bundleId); await store.verify(key, f.imageHash, f.png.length, "image/png");
  await assert.rejects(store.stage(key, Buffer.from("other-original"), "image/png", randomUUID()), rejection("ARTIFACT_CONFLICT"));
});
test("private artifact roots and symlink-free 0600 files are an enforced input contract", async () => {
  const directory = path.join(f.owned.artifactRoot, "nonprivate-directory"); await mkdir(directory, { mode: 0o755 });
  await assert.rejects(privateFileArtifacts(directory, "synthetic-nonprivate-store"), rejection("INVALID_CONFIGURATION"));
  assert.equal(hash(await readFile(path.join(f.targetDirectory, f.originalPath))), f.imageHash);
});
