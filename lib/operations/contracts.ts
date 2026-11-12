import { createHash, timingSafeEqual } from "node:crypto";
import type { SqlConnection, SqlDatabase } from "@fracture/paypal-core";

/** This operator contract transfers a whole, held namespace. It grants no app authority. */
export const OPERATIONS_FORMAT = "fieldproof-workspace-transfer/v2" as const;
export const OPERATIONS_SOURCE_COMMIT = "ddadae2c259ce874ab760b1f9f133cf653021e85";
export const CURRENT_SCHEMA = 24;
export const SCHEMA_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24] as const;
export type Row = Record<string, unknown>;
export type FailureCode = "UNSUPPORTED_COVERAGE" | "CATALOG_CHANGED" | "INVALID_BUNDLE" | "SOURCE_CHANGED" | "SOURCE_NOT_DRAINED" | "BACKUP_REQUIRED" | "DESTINATION_NOT_FRESH" | "DESTINATION_CHANGED" | "DESTINATION_NOT_RESTRICTED" | "KEY_MISMATCH" | "PRIVATE_LINEAGE" | "ARTIFACT_MISSING" | "ARTIFACT_CONFLICT" | "REVIEW_REQUIRED" | "IMPORT_CONFLICT" | "IMPORT_FAILED" | "VERIFY_FAILED" | "INVALID_CONFIGURATION";
export class OperationsError extends Error {
  constructor(readonly code: FailureCode, message: string) { super(message); this.name = "OperationsError"; }
}
export function requireOperation(condition: unknown, code: FailureCode, message: string): asserts condition {
  if (!condition) throw new OperationsError(code, message);
}
export function hash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
export function digest(value: unknown): string { return hash(canonical(value)); }
export function equalHash(left: string, right: string): boolean {
  return /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
export function exactKeys(value: unknown, keys: readonly string[], code: FailureCode = "INVALID_BUNDLE"): asserts value is Row {
  requireOperation(value !== null && typeof value === "object" && !Array.isArray(value) && canonical(Object.keys(value as Row).sort()) === canonical([...keys].sort()), code, "The versioned object has missing or unsupported fields.");
}
export function identifier(value: string): string {
  requireOperation(/^[a-z_][a-z0-9_]{0,62}$/.test(value), "INVALID_CONFIGURATION", "Use an explicit supported SQL identifier.");
  return `"${value}"`;
}
export interface Column { name: string; type: string; notNull: boolean; default: string | null; identity: string; generated: string; collation: string | null; }
export interface ForeignKey { name: string; columns: string[]; target: string; targetColumns: string[]; deferred: boolean; initiallyDeferred: boolean; definition: string; }
export interface CatalogTable {
  name: string; kind: string; persistence: string; rowSecurity: boolean; forceRowSecurity: boolean; replicaIdentity: string;
  columns: Column[]; keys: string[]; foreignKeys: ForeignKey[]; constraints: Row[]; indexes: Row[]; triggers: Row[];
}
export interface Catalog { format: 1; postgresMajor: number; tables: CatalogTable[]; functions: Row[]; sequences: Row[]; extraRelations: Row[]; extraTypes: Row[]; }
export interface SequenceState { name: string; lastValue: string; isCalled: boolean; }
/** PostgreSQL JSON text is retained verbatim; bigint/numeric columns are encoded as decimal strings. */
export interface TableRows { name: string; rows: string[]; count: number; hash: string; }
export interface NamespaceIdentity { database: string; schema: string; role: string; endpoint: string; restrictionHash: string; }
export interface Snapshot {
  identity: NamespaceIdentity; catalog: Catalog; catalogHash: string; capturedAt: string;
  tables: TableRows[]; rowsHash: string; sequences: SequenceState[]; sequenceHash: string;
  execution: { held: boolean; version: number; activeRequests: number; activeWorkers: number };
}
export interface ArtifactReference { key: string; hash: string; size: number; contentType: string; bindings: { table: string; keyHash: string; field: string }[]; }
export interface ArtifactRecord extends ArtifactReference { bytes: string; }
export interface ArtifactAbsence { key: string; expectedHash: string; declaredSize: number; uploadExpiresAt: string; reason: "original-awaiting-upload"; bindings: ArtifactReference["bindings"]; }
/** Adapters never translate object keys. target.verify must prove that the app can read the original location. */
export interface ArtifactStore {
  readonly namespace: string;
  readonly binding: string;
  readonly kind: "private-files" | "existing-private-store";
  read(key: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  verify(key: string, hash: string, size: number, contentType: string): Promise<void>;
  /** Exclusive creation or exact-byte reuse only, after the reviewed apply. */
  stage(key: string, bytes: Uint8Array, contentType: string, bundleId: string): Promise<void>;
}
export interface TransferEndpoint {
  database: SqlDatabase; label: string; endpoint: string; schema: string;
  authSecret: string; merchantClientId: string; artifactStore: ArtifactStore;
}
export interface BackupEvidence {
  kind: "operator-verified-private-backup"; sourceIdentityHash: string; catalogHash: string; rowsHash: string;
  sequenceHash: string; bytesHash: string; byteLength: number; verifiedAt: string; verification: "operator-recovery-reviewed";
  provenance: "operator-cutover" | "synthetic-qualification";
}
export interface ActivationReview {
  execution: "held"; activation: "separate-root-review-required";
  uncertainFinancialReplay: false; records: { table: string; count: number; rowsHash: string; states: Record<string, number> }[];
}
export interface WorkspaceBundleV2 {
  format: typeof OPERATIONS_FORMAT; id: string; codeCommit: typeof OPERATIONS_SOURCE_COMMIT; schemaVersion: 24;
  scope: "whole-namespace"; source: Snapshot; configuration: { encryptionKeyHash: string; merchantHash: string; artifactNamespace: string; artifactKind: ArtifactStore["kind"]; artifactBinding: string };
  backup: BackupEvidence; privateCoverage: { fields: number; ciphertextHash: string; artifactBindingsHash: string };
  artifacts: ArtifactRecord[]; absentArtifacts: ArtifactAbsence[]; activation: ActivationReview;
}
export interface TransferPlanV2 {
  format: "fieldproof-workspace-plan/v2"; id: string; bundleId: string; bundleHash: string; sourceIdentityHash: string;
  destination: Snapshot; destinationIdentityHash: string; configurationHash: string;
  artifactHash: string; expectedHash: string; activationHash: string;
  permittedDeltas: readonly ["destination-execution-control", "destination-hold-audit", "v2-import-audit"];
  statement: "restore-originals-keep-execution-held"; operatorReason: string;
}
export interface TransferReceiptV2 {
  format: "fieldproof-workspace-receipt/v2"; bundleId: string; planHash: string; bundleHash: string;
  importedAt: string; originalRows: number; originalTables: number; originalsHash: string;
  destinationIdentityHash: string; controlVersion: number; activationHash: string;
}
export type Transaction = SqlConnection;
