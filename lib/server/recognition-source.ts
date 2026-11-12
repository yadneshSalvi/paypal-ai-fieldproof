import { createHmac } from "node:crypto";
import { canonicalJson, type SqlConnection } from "@fracture/paypal-core";
import { DomainError } from "../domain/money";
import { recognitionTargetSchema, type RecognitionAccess, type RecognitionTarget } from "../recognition/contracts";
import { tokenHash, type Session } from "./auth";
import { query } from "./db";
import { readOrganizationProjectAuthority } from "./organization-projects";
import { readCurrentPublicProofWithin } from "./proof";

export const preciseTimestamp = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export interface RecognitionRequest { projectToken: string | null; }
export interface RecognitionEntry { kind: "supporter" | "reviewer" | "procurement"; id: string; expiresAt: string; }
export interface RecognitionAuthority { session: Session; membershipVersion: number; tokenHash: string; access: RecognitionAccess; entry: RecognitionEntry | null; }
export interface RecognitionSource { tenantId: string; projectId: string; snapshotId: string; target: RecognitionTarget; }
export const changedRecognition = () => new DomainError("RECOGNITION_CONTEXT_CHANGED", "Your original project access changed. Reload this private view before making another decision.", 409);
export function recognitionDigest(purpose: string, value: unknown): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("Recognition requires the configured private-value key.");
  return createHmac("sha256", secret).update(`fieldproof-recognition:${purpose}:`).update(canonicalJson(value)).digest("hex");
}
export async function recognitionNow(tx: SqlConnection): Promise<string> {
  return (await query<{ at: string }>(`SELECT ${preciseTimestamp("clock_timestamp()")} at`, [], tx))[0].at;
}

/** Never reads private names, contact data, payments, receipts or profile ciphertext. */
async function independentEntry(tx: SqlConnection, scope: { tenantId: string; projectId: string; actorId: string; id: string; role: Session["role"] }, version: number): Promise<RecognitionEntry | null> {
  const values = [scope.tenantId, scope.projectId, scope.actorId, scope.id, version];
  if (scope.role === "donor") {
    const [row] = await query<{ id: string; expires_at: string }>(`SELECT a.id,${preciseTimestamp("a.expires_at")} expires_at
      FROM fp_supporter_access a JOIN fp_supporter_invites i ON i.id=a.invitation_id
      WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.actor_id=$3 AND a.session_id=$4 AND a.membership_version=$5
        AND i.state='joined' AND i.version=2 AND i.tenant_id=a.tenant_id AND i.project_id=a.project_id
        AND a.expires_at=i.expires_at AND a.expires_at>clock_timestamp() FOR SHARE OF a,i`, values, tx);
    return row ? { kind: "supporter", id: row.id, expiresAt: row.expires_at } : null;
  }
  if (scope.role === "volunteer") {
    const [row] = await query<{ id: string; expires_at: string }>(`SELECT i.id,${preciseTimestamp("i.expires_at")} expires_at
      FROM fp_reviewer_invites i JOIN fp_memberships m ON m.tenant_id=i.tenant_id AND m.project_id=i.project_id AND m.actor_id=i.issuer_id
      WHERE i.tenant_id=$1 AND i.project_id=$2 AND i.actor_id=$3 AND i.session_id=$4 AND $5=1
        AND i.state='joined' AND i.version=2 AND i.expires_at>clock_timestamp() AND m.state='active' AND m.roles ? 'organizer'
        AND m.version=i.issuer_membership_version FOR SHARE OF i,m`, values, tx);
    if (row) return { kind: "reviewer", id: row.id, expiresAt: row.expires_at };
    const [available] = await query<{ ready: boolean }>(`SELECT count(*)=2 ready FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relname IN ('fp_procurement_access','fp_procurement_invites') AND c.relkind='r'`, [], tx);
    if (available.ready) {
      const [access] = await query<{ id: string; expires_at: string }>(`SELECT a.id,${preciseTimestamp("a.expires_at")} expires_at
        FROM fp_procurement_access a JOIN fp_procurement_invites i ON i.id=a.invitation_id AND i.tenant_id=a.tenant_id AND i.project_id=a.project_id
        JOIN fp_sessions s ON s.id=a.session_id AND s.tenant_id=a.tenant_id AND s.project_id=a.project_id AND s.actor_id=a.actor_id
        JOIN fp_memberships m ON m.tenant_id=a.tenant_id AND m.project_id=a.project_id AND m.actor_id=a.actor_id
        WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.actor_id=$3 AND a.session_id=$4 AND a.membership_version=$5 AND $5=1
          AND i.state='joined' AND i.version=2 AND i.role='volunteer' AND a.expires_at=i.expires_at AND a.expires_at>clock_timestamp()
          AND s.role='volunteer' AND s.revoked_at IS NULL AND s.expires_at=a.expires_at
          AND m.state='active' AND m.version=a.membership_version AND m.roles='["volunteer"]'::jsonb FOR SHARE OF a,i,s,m`, values, tx);
      if (access) return { kind: "procurement", id: access.id, expiresAt: access.expires_at };
    }
  }
  return null;
}

export async function recognitionAuthority(tx: SqlConnection, request: RecognitionRequest, expected?: { accessId: string; sessionExpiresAt: string }): Promise<RecognitionAuthority> {
  const current = await readOrganizationProjectAuthority(tx, { projectToken: request.projectToken, organizationToken: null, libraryToken: null, browserKey: "" }, true);
  if (!current.authority || !request.projectToken) throw new DomainError("RECOGNITION_ACCESS_ENDED", "Open your own current project profile to manage public recognition. This view does not extend access.", 410);
  const { session, membershipVersion } = current.authority;
  if (!["donor", "volunteer", "organizer"].includes(session.role)) throw new DomainError("RECOGNITION_ROLE_DENIED", "This project role cannot consent to or moderate public recognition.", 403);
  const [raw] = await query<{ expires_at: string; roles: string[] }>(`SELECT ${preciseTimestamp("s.expires_at")} expires_at,m.roles
    FROM fp_sessions s JOIN fp_memberships m ON m.tenant_id=s.tenant_id AND m.project_id=s.project_id AND m.actor_id=s.actor_id
    WHERE s.id=$1 AND s.token_hash=$2 AND s.revoked_at IS NULL AND s.role=$3 AND s.expires_at>clock_timestamp()
      AND m.version=$4 AND m.state='active' FOR SHARE OF s,m`, [session.id, tokenHash(request.projectToken), session.role, membershipVersion], tx);
  if (!raw) throw changedRecognition();
  let entry: RecognitionEntry | null = null;
  if (session.role !== "organizer") {
    if (raw.roles.length !== 1 || raw.roles[0] !== session.role) throw new DomainError("RECOGNITION_INDEPENDENT_ENTRY_REQUIRED", "Use your independently entered supporter or volunteer profile. An organizer's role switch cannot give consent for a participant.", 403);
    entry = await independentEntry(tx, session, membershipVersion);
    if (!entry) throw new DomainError("RECOGNITION_INDEPENDENT_ENTRY_REQUIRED", "This profile has no current independent supporter or volunteer entry for this project.", 403);
  }
  const credentialHash = tokenHash(request.projectToken);
  const accessId = recognitionDigest("access", { credentialHash, sessionId: session.id, tenantId: session.tenantId, projectId: session.projectId,
    actorId: session.actorId, role: session.role, mode: session.mode, membershipVersion, sessionExpiresAt: raw.expires_at, entry });
  if (expected && (expected.accessId !== accessId || expected.sessionExpiresAt !== raw.expires_at)) throw changedRecognition();
  return { session, membershipVersion, tokenHash: credentialHash, entry, access: { accessId, role: session.role as RecognitionAccess["role"],
    sessionExpiresAt: raw.expires_at, validUntil: entry && entry.expiresAt < raw.expires_at ? entry.expiresAt : raw.expires_at } };
}
export async function assertRecognitionAuthority(tx: SqlConnection, request: RecognitionRequest, original: RecognitionAuthority) {
  return recognitionAuthority(tx, request, original.access);
}

export interface RecognitionConsentAuthority {
  tenant_id: string; project_id: string; actor_id: string; role: "donor" | "volunteer";
  session_id: string; session_hash: string; membership_version: number; session_deadline: string;
  entry_kind: RecognitionEntry["kind"]; entry_id: string; entry_deadline: string; deadline: string;
}
/** Public reads validate the original stored capability, never a caller-selected actor. */
export async function consentAuthorityCurrent(tx: SqlConnection, row: RecognitionConsentAuthority): Promise<boolean> {
  const [current] = await query<{ expires_at: string; roles: string[] }>(`SELECT ${preciseTimestamp("s.expires_at")} expires_at,m.roles
    FROM fp_sessions s JOIN fp_memberships m ON m.tenant_id=s.tenant_id AND m.project_id=s.project_id AND m.actor_id=s.actor_id
    WHERE s.id=$1 AND s.tenant_id=$2 AND s.project_id=$3 AND s.actor_id=$4 AND s.token_hash=$5 AND s.role=$6
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND m.state='active' AND m.version=$7 FOR SHARE OF s,m`,
    [row.session_id, row.tenant_id, row.project_id, row.actor_id, row.session_hash, row.role, row.membership_version], tx);
  if (!current || current.expires_at !== row.session_deadline || current.roles.length !== 1 || current.roles[0] !== row.role) return false;
  const entry = await independentEntry(tx, { tenantId: row.tenant_id, projectId: row.project_id, actorId: row.actor_id, id: row.session_id, role: row.role }, row.membership_version);
  return !!entry && entry.kind === row.entry_kind && entry.id === row.entry_id && entry.expiresAt === row.entry_deadline && row.deadline > await recognitionNow(tx);
}

export async function recognitionSource(tx: SqlConnection, slug: string, scope?: { tenantId: string; projectId: string }): Promise<RecognitionSource | null> {
  const proof = await readCurrentPublicProofWithin(slug, tx);
  if (proof.state !== "published" || !proof.snapshot || !proof.currentRevision) return null;
  const [head] = await query<{ tenant_id: string; project_id: string; current_snapshot_id: string; version: number }>("SELECT tenant_id,project_id,current_snapshot_id,version FROM fp_proof_heads WHERE slug=$1 AND state='published' FOR SHARE", [slug], tx);
  if (!head || head.current_snapshot_id !== proof.snapshot.id || scope && (head.tenant_id !== scope.tenantId || head.project_id !== scope.projectId)) return null;
  const reviewKey = recognitionDigest("public-target", { slug, headVersion: head.version, snapshotId: proof.snapshot.id, hash: proof.snapshot.contentHash });
  return { tenantId: head.tenant_id, projectId: head.project_id, snapshotId: proof.snapshot.id,
    target: recognitionTargetSchema.parse({ slug, title: proof.snapshot.payload.projectTitle, revision: proof.currentRevision,
      contentHash: proof.snapshot.contentHash, reviewKey, proofHref: `/proof/${slug}`, wallHref: `/recognition/${slug}` }) };
}
export async function recognitionTargets(tx: SqlConnection, authority: RecognitionAuthority): Promise<RecognitionTarget[]> {
  const rows = await query<{ slug: string }>("SELECT slug FROM fp_proof_heads WHERE tenant_id=$1 AND project_id=$2 AND state='published' ORDER BY slug LIMIT 51 FOR SHARE", [authority.session.tenantId, authority.session.projectId], tx);
  if (rows.length > 50) throw new DomainError("RECOGNITION_TARGET_LIMIT", "This project has more public pages than this view can safely review.", 409);
  const targets: RecognitionTarget[] = [];
  for (const row of rows) { const source = await recognitionSource(tx, row.slug, authority.session); if (source) targets.push(source.target); }
  return targets;
}
