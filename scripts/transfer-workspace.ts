import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { parseEnv } from "node:util";
import { PostgresDatabase } from "@fracture/paypal-core";
import { database, initializeDatabase, query } from "../lib/server/db";
import { exportWorkspace, importWorkspace, openTransfer, sealTransfer, transferManifest, type TransferEnvelope } from "../lib/server/workspace-transfer";
import { DomainError } from "../lib/domain/money";

const args = process.argv.slice(2), command = args[0];
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
let target: PostgresDatabase | null = null;
function privatePath(value: string) {
  const path = resolve(value), root = resolve(".private");
  if (relative(root, path).startsWith("..") || path === root) throw new DomainError("TRANSFER_PRIVATE_PATH_REQUIRED", "Store private snapshots inside this repository's ignored .private directory.", 400);
  return path;
}
async function save(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
try {
  if (!["export", "plan", "apply"].includes(command)) throw new DomainError("TRANSFER_USAGE", "Use export --project ID [--out .private/transfers/file.json], or plan/apply --bundle .private/transfers/file.json --target-env /private/hosted.env. Final export and apply require --writers-stopped.", 400);
  await initializeDatabase();
  if (command === "export") {
    if (!args.includes("--writers-stopped") && !args.includes("--preview")) throw new DomainError("TRANSFER_FREEZE_REQUIRED", "Stop the original application and its workers before final export, then pass --writers-stopped. Use --preview only for a preliminary manifest.", 409);
    const project = option("--project");
    if (!project || !/^[a-f0-9-]{36}$/.test(project)) throw new DomainError("TRANSFER_PROJECT_REQUIRED", "Pass the exact original project ID.", 400);
    const [row] = await query<{ tenant_id: string }>("SELECT tenant_id FROM fp_projects WHERE id=$1", [project]);
    if (!row) throw new DomainError("TRANSFER_PROJECT_MISSING", "The original project was not found.", 404);
    const bundle = await exportWorkspace(database(), { tenantId: row.tenant_id, projectId: project });
    if (!args.includes("--preview") && !bundle.sourceExecution.quiescent) throw new DomainError("TRANSFER_SOURCE_NOT_QUIESCENT", "Enable the original database execution hold and wait for all request/worker leases to drain before final export.", 409);
    const path = privatePath(option("--out") ?? `.private/transfers/${bundle.id}.json`);
    await save(path, sealTransfer(bundle));
    await save(path.replace(/\.json$/, "") + ".manifest.json", transferManifest(bundle));
    console.log(JSON.stringify({ bundle: path, manifest: transferManifest(bundle), preliminary: args.includes("--preview") }));
  } else {
    const file = option("--bundle"), targetEnv = option("--target-env");
    if (!file || !targetEnv) throw new DomainError("TRANSFER_INPUT_REQUIRED", "Pass the encrypted private bundle and the existing private hosted environment file.", 400);
    if (resolve(targetEnv) === resolve("../.env") || resolve(targetEnv) === resolve(".env")) throw new DomainError("TRANSFER_TARGET_ENV_INVALID", "Use the existing isolated hosted environment snapshot, not a personal or local environment file.", 400);
    const destination = parseEnv(await readFile(resolve(targetEnv), "utf8"));
    const names = ["DATABASE_URL", "AUTH_SECRET", "PAYPAL_CLIENT_ID", "BLOB_READ_WRITE_TOKEN"] as const;
    if (names.some(name => !destination[name] || /\[SENSITIVE\]|\[REDACTED\]|your-|placeholder/i.test(destination[name]))) throw new DomainError("TRANSFER_TARGET_ENV_INCOMPLETE", "The hosted environment snapshot is incomplete or contains redacted placeholders. Restore only its current isolated values before proceeding.", 409);
    if ((destination.APP_URL ?? "https://paypal-ai-fieldproof.vercel.app") !== "https://paypal-ai-fieldproof.vercel.app" || destination.PAYPAL_ENVIRONMENT !== "sandbox" || destination.PAYPAL_PROJECT_ISOLATED !== "true") throw new DomainError("TRANSFER_TARGET_ENV_INVALID", "The target must be the configured hosted Fieldproof sandbox.", 409);
    target = new PostgresDatabase(destination.DATABASE_URL!);
    const identitySql = "SELECT current_database() AS database,current_schema() AS schema,inet_server_addr()::text AS address,inet_server_port() AS port";
    const [from, to] = await Promise.all([database().query(identitySql), target.query(identitySql)]);
    if (JSON.stringify(from.rows[0]) === JSON.stringify(to.rows[0])) throw new DomainError("TRANSFER_SAME_DATABASE", "The original and destination resolve to the same database and schema.", 409);
    const envelope = JSON.parse(await readFile(privatePath(file), "utf8")) as TransferEnvelope;
    const bundle = openTransfer(envelope);
    if (command === "apply") {
      if (!args.includes("--writers-stopped")) throw new DomainError("TRANSFER_FREEZE_REQUIRED", "Stop the original writer and pause hosted work before applying the reviewed import.", 409);
      const grants = bundle.tables.find(table => table.name === "fp_workspace_handoffs")?.rows ?? [];
      if (!grants.some(row => !row.consumed_at && !row.revoked_at && Date.parse(String(row.expires_at)) > Date.now() + 5 * 60_000)) throw new DomainError("TRANSFER_HANDOFF_EXPIRED", "Prepare a fresh continuation in the original workspace and export again before applying this import.", 409);
    }
    const manifest = await importWorkspace(target, bundle, { authSecret: destination.AUTH_SECRET!, clientId: destination.PAYPAL_CLIENT_ID!, blobToken: destination.BLOB_READ_WRITE_TOKEN! }, command === "plan");
    const reportPath = privatePath(`.private/transfers/${bundle.id}.${command}-${Date.now()}.json`);
    await save(reportPath, manifest);
    console.log(JSON.stringify({ report: reportPath, manifest }));
  }
} catch (error) {
  console.error(JSON.stringify(error instanceof DomainError ? { code: error.code, error: error.message } : { code: "TRANSFER_UNAVAILABLE", error: "The private transfer did not finish. No provider call was made; inspect the sanitized manifest and current schema before retrying." }));
  process.exitCode = 1;
} finally { await Promise.allSettled([database().close(), target?.close()]); }
