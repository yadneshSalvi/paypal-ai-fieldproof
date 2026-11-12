import { fileURLToPath } from "node:url";
import path from "node:path";
import { digest, OperationsError, requireOperation, type BackupEvidence, type TransferPlanV2, type TransferReceiptV2, type WorkspaceBundleV2 } from "../lib/operations/contracts";
import { openOperatorFile, readPrivateFile, readPrivateJson, saveSealedFile, writePrivateFile } from "../lib/operations/operator-files";
import { assertDrained } from "../lib/operations/snapshot";
import { operationsCoverageV2 } from "../lib/operations/review";
import { applyWorkspaceTransferV2, captureWorkspaceV2, exportWorkspaceV2, openTransferFile, planWorkspaceTransferV2, verifyWorkspaceTransferV2 } from "../lib/server/workspace-transfer-v2";

const FLAGS: Record<string, readonly string[]> = {
  coverage: [], basis: ["config", "out"], export: ["config", "backup", "backup-review", "out"], plan: ["config", "bundle", "reason", "out"], apply: ["config", "bundle", "plan", "review-hash", "out"], verify: ["config", "bundle", "plan", "receipt"],
};
function argumentsFor(args: readonly string[]) {
  const command = args[0], allowed = FLAGS[command];
  requireOperation(allowed, "INVALID_CONFIGURATION", "Choose coverage, basis, export, plan, apply or verify.");
  const flags: Record<string, string> = {};
  requireOperation((args.length - 1) % 2 === 0, "INVALID_CONFIGURATION", "Every operator option requires an explicit value.");
  for (let i = 1; i < args.length; i += 2) { const name = args[i].startsWith("--") ? args[i].slice(2) : ""; requireOperation(allowed.includes(name) && !Object.hasOwn(flags, name) && typeof args[i + 1] === "string" && args[i + 1].length > 0, "INVALID_CONFIGURATION", "An operator option is unknown, repeated or missing."); flags[name] = args[i + 1]; }
  requireOperation(allowed.every(name => Object.hasOwn(flags, name)), "INVALID_CONFIGURATION", "Supply every explicit versioned operator option.");
  return { command, flags };
}
/** Exported for the transport-denying in-process CLI qualification. No env-file,
 * global application database, initializer, HTTP endpoint or scheduler is used. */
export async function runWorkspaceTransferV2(args: readonly string[], output: (value: unknown) => void = value => console.log(JSON.stringify(value))) {
  const { command, flags } = argumentsFor(args);
  if (command === "coverage") { const coverage = operationsCoverageV2(); output(coverage); return coverage; }
  const endpoints = await openOperatorFile(flags.config);
  try {
    const { source, destination } = endpoints;
    if (command === "basis") {
      const snapshot = await captureWorkspaceV2(source); assertDrained(snapshot);
      const basis = { format: "fieldproof-workspace-backup-basis/v2", sourceIdentityHash: digest(snapshot.identity), catalogHash: snapshot.catalogHash, rowsHash: snapshot.rowsHash, sequenceHash: snapshot.sequenceHash, capturedAt: snapshot.capturedAt, held: true, scope: "whole-namespace" };
      await writePrivateFile(flags.out, JSON.stringify(basis, null, 2)); output({ ok: true, command, sourceIdentityHash: basis.sourceIdentityHash, catalogHash: basis.catalogHash, rowsHash: basis.rowsHash, sequenceHash: basis.sequenceHash }); return basis;
    }
    if (command === "export") {
      const [backup, bytes] = await Promise.all([readPrivateJson<BackupEvidence>(flags["backup-review"]), readPrivateFile(flags.backup)]), bundle = await exportWorkspaceV2(source, backup, bytes);
      await saveSealedFile(flags.out, "bundle", bundle.id, bundle, source.authSecret);
      const result = { ok: true, command, bundleHash: digest(bundle), tables: bundle.source.tables.length, rows: bundle.source.tables.reduce((sum, table) => sum + table.count, 0), artifacts: bundle.artifacts.length, explicitlyAbsentUploads: bundle.absentArtifacts.length, execution: "held", backupProvenance: bundle.backup.provenance };
      output(result); return result;
    }
    const bundle = openTransferFile<WorkspaceBundleV2>((await readPrivateFile(flags.bundle)).toString("utf8"), "bundle", source.authSecret);
    if (command === "plan") {
      const plan = await planWorkspaceTransferV2(source, destination, bundle, flags.reason); await saveSealedFile(flags.out, "plan", plan.id, plan, source.authSecret);
      const result = { ok: true, command, reviewHash: digest(plan), bundleHash: plan.bundleHash, destinationIdentityHash: plan.destinationIdentityHash, tables: 137, originalRowFamilies: 136, unchangedTables: 134, execution: "held", activation: "separate-root-review-required" };
      output(result); return result;
    }
    const plan = openTransferFile<TransferPlanV2>((await readPrivateFile(flags.plan)).toString("utf8"), "plan", source.authSecret);
    if (command === "apply") {
      const receipt = await applyWorkspaceTransferV2(source, destination, bundle, plan, flags["review-hash"]); await saveSealedFile(flags.out, "receipt", bundle.id, receipt, source.authSecret);
      const result = { ok: true, command, receiptHash: digest(receipt), planHash: receipt.planHash, originalRows: receipt.originalRows, originalRowFamilies: 136, unchangedTables: 134, execution: "held", activation: "separate-root-review-required" };
      output(result); return result;
    }
    const receipt = openTransferFile<TransferReceiptV2>((await readPrivateFile(flags.receipt)).toString("utf8"), "receipt", destination.authSecret), result = await verifyWorkspaceTransferV2(destination, bundle, plan, receipt);
    output({ ok: true, command, ...result }); return result;
  } finally { await endpoints.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runWorkspaceTransferV2(process.argv.slice(2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, code: error instanceof OperationsError ? error.code : "OPERATION_STOPPED", message: error instanceof OperationsError ? error.message : "The private operation stopped. Preserve both namespaces and the original reviewed files; no execution activation was requested." })); process.exitCode = 1; }
}
