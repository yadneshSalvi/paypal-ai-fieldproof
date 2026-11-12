import { lstat, open, readFile, realpath, link, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PostgresDatabase } from "@fracture/paypal-core";
import { digest, exactKeys, OperationsError, requireOperation, type Row, type TransferEndpoint } from "./contracts";
import { privateFileArtifacts } from "./artifacts";
import { openTransferFile, sealTransferFile } from "./crypto";

export interface OperatorEndpointFile { databaseUrl: string; schema: string; label: string; authSecret: string; merchantClientId: string; artifacts: { kind: "private-files"; directory: string; namespace: string }; }
export interface OperatorFile { format: "fieldproof-workspace-operator/v2"; source: OperatorEndpointFile; destination: OperatorEndpointFile; }
export function scopedConnectionUrl(raw: string, schema: string): URL {
  requireOperation(/^[a-z_][a-z0-9_]{0,62}$/.test(schema), "INVALID_CONFIGURATION", "Use an explicit supported namespace identifier.");
  let url: URL; try { url = new URL(raw); } catch { throw new OperationsError("INVALID_CONFIGURATION", "An operator connection must be an explicit PostgreSQL URL."); }
  requireOperation(["postgres:", "postgresql:"].includes(url.protocol) && !!url.hostname && !!url.username && !!url.password && /^\/[^/]+$/.test(url.pathname) && !url.hash && [...url.searchParams.keys()].every(key => ["options", "sslmode"].includes(key)), "INVALID_CONFIGURATION", "Use only the reviewed PostgreSQL connection fields; environment or shell options are not accepted.");
  const options = `-c search_path=${schema}`;
  requireOperation(!url.searchParams.has("options") || url.searchParams.get("options") === options, "INVALID_CONFIGURATION", "The connection search_path must name only its explicit original namespace.");
  url.searchParams.set("options", options); url.port ||= "5432";
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), ssl = url.searchParams.get("sslmode");
  requireOperation(loopback ? ssl === null || ssl === "disable" || ssl === "verify-full" : ssl === "verify-full", "INVALID_CONFIGURATION", "Remote operator connections require explicit verified TLS; no inherited SSL override is accepted.");
  return url;
}
export function endpointFingerprint(url: URL): string {
  return digest({ protocol: url.protocol, host: url.hostname, port: url.port, database: url.pathname, role: decodeURIComponent(url.username), schemaOptions: url.searchParams.get("options"), sslMode: url.searchParams.get("sslmode") });
}
export async function readPrivateFile(filename: string, maximum = 256 * 1024 * 1024): Promise<Buffer> {
  requireOperation(path.isAbsolute(filename), "INVALID_CONFIGURATION", "Private operator file paths must be absolute.");
  const parent = path.dirname(filename);
  try {
    const [directory, file] = await Promise.all([lstat(parent), lstat(filename)]);
    requireOperation(directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o777) === 0o700 && await realpath(parent) === parent && file.isFile() && !file.isSymbolicLink() && (file.mode & 0o777) === 0o600 && file.size <= maximum, "INVALID_CONFIGURATION", "Use only bounded private0600 files within an explicit symlink-free0700 directory.");
    return await readFile(filename);
  } catch (error) { if (error instanceof OperationsError) throw error; throw new OperationsError("INVALID_CONFIGURATION", "The original private operator file is unavailable."); }
}
export async function writePrivateFile(filename: string, text: string): Promise<void> {
  requireOperation(path.isAbsolute(filename), "INVALID_CONFIGURATION", "Private operator outputs require absolute paths.");
  const directory = path.dirname(filename), stat = await lstat(directory);
  requireOperation(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700 && await realpath(directory) === directory, "INVALID_CONFIGURATION", "Create the explicit private0700 output directory before the operation.");
  const temporary = path.join(directory, `.fieldproof-writing-${randomUUID()}`), file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(text, "utf8"); await file.sync(); await file.close(); await link(temporary, filename); }
  catch { throw new OperationsError("IMPORT_CONFLICT", "The private output already exists or could not be saved exclusively. Inspect its original identity before retrying."); }
  finally { await file.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
}
export async function saveSealedFile(filename: string, purpose: "bundle" | "plan" | "receipt", id: string, value: unknown, secret: string): Promise<void> {
  try {
    const existing = await lstat(filename);
    requireOperation(existing.isFile() && !existing.isSymbolicLink(), "IMPORT_CONFLICT", "The original private output path conflicts with another artifact.");
    const previous = openTransferFile((await readPrivateFile(filename)).toString("utf8"), purpose, secret);
    requireOperation(digest(previous) === digest(value), "IMPORT_CONFLICT", "The existing private output belongs to a different original payload. It will not be overwritten.");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") await writePrivateFile(filename, sealTransferFile(value, purpose, id, secret));
    else throw error;
  }
}
export async function readPrivateJson<T>(filename: string, maximum = 1024 * 1024): Promise<T> {
  try { return JSON.parse((await readPrivateFile(filename, maximum)).toString("utf8")) as T; }
  catch (error) { if (error instanceof OperationsError) throw error; throw new OperationsError("INVALID_CONFIGURATION", "The versioned private JSON file is invalid."); }
}
function endpointFile(value: unknown): OperatorEndpointFile {
  exactKeys(value, ["databaseUrl", "schema", "label", "authSecret", "merchantClientId", "artifacts"], "INVALID_CONFIGURATION");
  requireOperation(["databaseUrl", "schema", "label", "authSecret", "merchantClientId"].every(key => typeof value[key] === "string") && String(value.authSecret).length >= 32 && String(value.merchantClientId).length > 0, "INVALID_CONFIGURATION", "The operator configuration requires explicit compatible original bindings.");
  exactKeys(value.artifacts, ["kind", "directory", "namespace"], "INVALID_CONFIGURATION");
  requireOperation(value.artifacts.kind === "private-files" && typeof value.artifacts.directory === "string" && typeof value.artifacts.namespace === "string", "INVALID_CONFIGURATION", "This CLI requires the qualified private-files adapter; other storage adapters require separate integration review.");
  return value as unknown as OperatorEndpointFile;
}
export async function openOperatorFile(filename: string): Promise<{ source: TransferEndpoint; destination: TransferEndpoint; close: () => Promise<void> }> {
  const config = await readPrivateJson<Row>(filename); exactKeys(config, ["format", "source", "destination"], "INVALID_CONFIGURATION");
  requireOperation(config.format === "fieldproof-workspace-operator/v2", "INVALID_CONFIGURATION", "The operator configuration format is unsupported.");
  const files = [endpointFile(config.source), endpointFile(config.destination)], opened: TransferEndpoint[] = [];
  try {
    for (const file of files) {
      const url = scopedConnectionUrl(file.databaseUrl, file.schema), artifactStore = await privateFileArtifacts(file.artifacts.directory, file.artifacts.namespace);
      opened.push({ database: new PostgresDatabase(url.href), endpoint: endpointFingerprint(url), label: file.label, schema: file.schema, authSecret: file.authSecret, merchantClientId: file.merchantClientId, artifactStore });
    }
    requireOperation(endpointFingerprint(scopedConnectionUrl(files[0].databaseUrl, files[0].schema)) !== endpointFingerprint(scopedConnectionUrl(files[1].databaseUrl, files[1].schema)), "INVALID_CONFIGURATION", "Select a separate explicitly fresh destination namespace.");
    return { source: opened[0], destination: opened[1], close: async () => { await Promise.all(opened.map(endpoint => endpoint.database.close())); } };
  } catch (error) { await Promise.all(opened.map(endpoint => endpoint.database.close())); throw error; }
}
