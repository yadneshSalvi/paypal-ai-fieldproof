import { randomBytes, randomUUID } from "node:crypto";
import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import {
  ORG_GOVERNANCE_VERSION, ORG_PAGE_SIZE, orgBrowserContextSchema, orgCommandReceiptSchema,
  orgProfileSchema, type OrgBrowserContext, type OrgCapabilities, type OrgCommandReceipt,
  type OrgProfile, type OrgRole,
} from "../organizations/contracts";
import { DomainError } from "../domain/money";
import { database, initializeDatabase, query } from "./db";
import { openPrivate, sealPrivate } from "./private-values";
import { organizationReviewEnabled } from "./organization-review";

export type OrgTx = SqlConnection;
export interface OrganizationRequest {
  organizationToken: string | null;
  libraryToken: string | null;
  browserKey: string;
  projectToken: string | null;
  organizationScope?: string;
  projectScope?: string;
}
export interface OrganizationCookie {
  kind: "session" | "library";
  token: string | null;
  expiresAt: string | null;
}
export interface OrganizationResult<T> { body: T; cookies?: OrganizationCookie[]; }
export interface OrganizationRow {
  id: string; version: number; name: string; description: string; identity_provenance: "self_declared";
  created_at: Date; updated_at: Date;
}
export interface OrgMemberRow {
  id: string; organization_id: string; role: OrgRole; version: number; state: "active" | "revoked";
  authentication_origin: "creation_capability" | "invitation_possession"; encrypted_identity: string;
  expires_at: Date; revoked_at: Date | null; created_at: Date;
}
export interface OrgSessionRow {
  id: string; organization_id: string; membership_id: string; token_hash: string;
  expires_at: Date; revoked_at: Date | null; created_at: Date;
}
export interface OrgIdentity {
  organization: OrganizationRow; member: OrgMemberRow; session: OrgSessionRow;
  profile: OrgProfile; scope: string;
}
export interface OrgContextState {
  context: OrgBrowserContext; identity: OrgIdentity | null;
  original: { organization: OrganizationRow; member: OrgMemberRow; session: OrgSessionRow } | null;
}
export interface OrgCommandRow {
  id: string; actor_key: string; intent_id: string; kind: OrgCommandReceipt["kind"]; input_hash: string;
  organization_id: string | null; session_id: string | null; membership_id: string | null;
  membership_version: number | null; browser_hash: string | null;
  result: OrgCommandReceipt; encrypted_recovery: string | null; created_at: Date;
}
export const organizationCookieName = () => organizationReviewEnabled() ? "fieldproof_governance_stage13_org_session" : "fieldproof_organization_session";
export const organizationLibraryCookieName = () => `${organizationCookieName()}_library`;
export const organizationBrowserCookieName = () => `${organizationCookieName()}_entry_browser`;
export const organizationCookieSecure = () => process.env.NODE_ENV === "production" && !organizationReviewEnabled();
export const orgHash = (value: unknown) => sha256(canonicalJson(value));
export const orgToken = () => randomBytes(48).toString("base64url");
export const orgTokenHash = (value: string) => sha256(value);
export const orgTokenValid = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{64}$/.test(value);
export const orgPrivateContext = (kind: string, id: string) => `organization:${ORG_GOVERNANCE_VERSION}:${kind}:${id}`;
export function browserHash(request: OrganizationRequest): string {
  if (!orgTokenValid(request.browserKey)) throw new DomainError("ORG_BROWSER_CONTEXT_CHANGED", "Refresh this private entry before continuing.", 409);
  return orgTokenHash(request.browserKey);
}
export async function orgNow(tx: SqlConnection): Promise<Date> {
  return (await query<{ at: Date }>("SELECT clock_timestamp() AS at", [], tx))[0].at;
}
export function orgCapabilities(role: OrgRole): OrgCapabilities {
  const owner = role === "owner", writer = owner || role === "coordinator";
  return { canEditOrganization: owner, canManageMembers: owner, canReadRoster: owner,
    canReadPolicyDrafts: writer, canWritePolicies: writer, canLinkProjects: writer, canAdoptPolicies: writer,
    canCapturePortfolio: true, canExportPortfolio: true, canPrintPortfolio: true };
}
export function orgMemberIdentity(member: OrgMemberRow) {
  return z.object({ displayName: z.string(), identityProvenance: z.literal("self_declared"), contractVersion: z.literal(ORG_GOVERNANCE_VERSION) }).strict()
    .parse(openPrivate(member.encrypted_identity, orgPrivateContext("member", member.id)));
}
function profileFor(organization: OrganizationRow, member: OrgMemberRow, session: OrgSessionRow): OrgProfile {
  return orgProfileSchema.parse({ organizationId: organization.id, organizationName: organization.name,
    membershipId: member.id, displayName: orgMemberIdentity(member).displayName, identityProvenance: "self_declared",
    authenticationOrigin: member.authentication_origin, role: member.role, membershipVersion: member.version,
    membershipExpiresAt: member.expires_at.toISOString(), sessionExpiresAt: session.expires_at.toISOString() });
}
/** Lock order is organization, then membership, then session. Current authority is
 * read after waits; a browser-selected role is never accepted as a credential. */
export async function readOrganizationContext(tx: SqlConnection, request: OrganizationRequest, lock: false | "share" | "update" = false): Promise<OrgContextState> {
  const tokenHash = request.organizationToken === null ? null : orgTokenHash(request.organizationToken);
  const [found] = tokenHash ? await query<OrgSessionRow>("SELECT * FROM fp_org_sessions WHERE token_hash=$1", [tokenHash], tx) : [];
  let original: OrgContextState["original"] = null;
  if (found) {
    const suffix = lock ? ` FOR ${lock === "update" ? "UPDATE" : "SHARE"}` : "";
    const [organization] = await query<OrganizationRow>(`SELECT * FROM fp_organizations WHERE id=$1${suffix}`, [found.organization_id], tx);
    const [member] = await query<OrgMemberRow>(`SELECT * FROM fp_org_memberships WHERE organization_id=$1 AND id=$2${suffix}`, [found.organization_id, found.membership_id], tx);
    const [session] = await query<OrgSessionRow>(`SELECT * FROM fp_org_sessions WHERE organization_id=$1 AND id=$2${suffix}`, [found.organization_id, found.id], tx);
    if (organization && member && session) original = { organization, member, session };
  }
  const now = await orgNow(tx);
  const current = original && !original.session.revoked_at && original.session.expires_at > now && original.member.state === "active" && !original.member.revoked_at && original.member.expires_at > now;
  const state = current ? "active" : request.organizationToken !== null ? "ended" : "none";
  const scope = orgHash({ browser: browserHash(request), credential: tokenHash, state,
    session: original?.session.id ?? null, organization: original?.organization.id ?? null,
    member: original?.member.id ?? null, version: original?.member.version ?? null, role: current && original ? original.member.role : null,
    sessionExpiresAt: original?.session.expires_at.toISOString() ?? null, membershipExpiresAt: original?.member.expires_at.toISOString() ?? null });
  const identity: OrgIdentity | null = current && original ? { ...original, profile: profileFor(original.organization, original.member, original.session), scope } : null;
  return { original, identity, context: orgBrowserContextSchema.parse({ scope, state, profile: identity?.profile ?? null,
    canCreate: state === "none", canLeave: state === "active", canClearEnded: state === "ended" }) };
}
export function assertOrganizationScope(actual: string, expected: string | undefined) {
  if (!expected || expected !== actual) throw new DomainError("ORG_CONTEXT_CHANGED", "Your organization profile changed. Refresh this view before continuing.", 409);
}
export async function requireOrganization(tx: SqlConnection, request: OrganizationRequest, expectedScope: string | undefined, roles?: readonly OrgRole[], write = false): Promise<OrgIdentity> {
  const state = await readOrganizationContext(tx, request, write ? "update" : "share");
  if (!state.identity) {
    if (state.original && state.original.session.expires_at <= await orgNow(tx)) throw new DomainError("ORG_SESSION_EXPIRED", "This original organization session has ended. Its deadline was not extended.", 410);
    throw new DomainError(state.context.state === "ended" ? "ORG_AUTHORITY_ENDED" : "ORG_AUTH_REQUIRED", "Open a current organization profile to continue.", state.context.state === "ended" ? 410 : 401);
  }
  assertOrganizationScope(state.identity.scope, expectedScope);
  if (roles && !roles.includes(state.identity.member.role)) throw new DomainError("ORG_ROLE_DENIED", "Your current organization role cannot make this decision.", 403);
  return state.identity;
}
/** Kept separate for an acknowledged self-removal: only its own minimal receipt
 * can survive that transition, and never past the original session deadline. */
export async function assertOriginalOrgDeadline(tx: SqlConnection, identity: Pick<OrgIdentity, "session" | "member">) {
  const at = await orgNow(tx);
  if (identity.session.expires_at <= at || identity.member.expires_at <= at) throw new DomainError("ORG_SESSION_EXPIRED", "The original access deadline passed while this decision waited. No new authority was granted.", 410);
}
export async function assertOrganizationCurrent(tx: SqlConnection, request: OrganizationRequest, identity: OrgIdentity) {
  const current = await readOrganizationContext(tx, request);
  if (!current.identity || current.identity.scope !== identity.scope) throw new DomainError("ORG_CONTEXT_CHANGED", "Organization access changed while this view was prepared. Its private content is withheld.", 409);
}
export async function organizationTransaction<T>(work: (tx: SqlConnection) => Promise<T>, repeatable = false): Promise<T> {
  await initializeDatabase();
  try {
    return await database().transaction(async tx => {
      if (repeatable) await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await tx.query("SET LOCAL lock_timeout='4000ms'; SET LOCAL statement_timeout='20000ms'");
      return work(tx);
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (["40001", "40P01", "55P03", "57014"].includes(code)) throw new DomainError("ORG_COMMAND_BUSY", "Another decision is finishing. Keep this exact request and check it again; do not start a second decision.", 409);
    throw error;
  }
}
export async function organizationAudit(tx: SqlConnection, organizationId: string, kind: string, identity: OrgIdentity | null,
  data: { title: string; detail: string; [key: string]: unknown }, authority?: { origin: "project_session" | "creation_capability" | "invitation_possession"; sessionId?: string; membershipId?: string; membershipVersion?: number; role?: string }) {
  const id = randomUUID();
  await tx.query(`INSERT INTO fp_org_audit(id,organization_id,kind,authority_origin,session_id,membership_id,membership_version,role,encrypted_data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, organizationId, kind, authority?.origin ?? "organization_session",
    authority?.sessionId ?? identity?.session.id ?? null, authority?.membershipId ?? identity?.member.id ?? null,
    authority?.membershipVersion ?? identity?.member.version ?? null, authority?.role ?? identity?.member.role ?? null,
    sealPrivate(data, orgPrivateContext("audit", id))]);
}
export async function orgRateLimit(tx: SqlConnection, bucket: string, limit: number) {
  const rows = await query("INSERT INTO fp_request_buckets(bucket_key,request_count) VALUES($1,1) ON CONFLICT(bucket_key) DO UPDATE SET request_count=fp_request_buckets.request_count+1 WHERE fp_request_buckets.request_count<$2 RETURNING request_count", [`organization:${orgHash(bucket)}`, limit], tx);
  if (!rows.length) throw new DomainError("ORG_RATE_LIMIT", "This private entry is temporarily busy. Existing profiles remain available; please try again later.", 429);
}
export async function findOrgCommand(tx: SqlConnection, actorKey: string, intentId: string, kind: OrgCommandReceipt["kind"], input: unknown): Promise<OrgCommandRow | null> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`organization-command:${actorKey}:${intentId}`]);
  const [row] = await query<OrgCommandRow>("SELECT * FROM fp_org_commands WHERE actor_key=$1 AND intent_id=$2", [actorKey, intentId], tx);
  if (row && (row.kind !== kind || row.input_hash !== orgHash(input))) throw new DomainError("ORG_INTENT_CHANGED", "This saved request has different details. Recover its original result before beginning a new decision.", 409);
  return row ?? null;
}
export async function saveOrgCommand(tx: SqlConnection, actorKey: string, input: { intentId: string }, kind: OrgCommandReceipt["kind"], originalInput: unknown,
  result: { resourceId: string | null; resourceVersion: number | null; message: string },
  options: { identity?: OrgIdentity; organizationId?: string; browserHash?: string; recovery?: unknown } = {}): Promise<OrgCommandReceipt> {
  const id = randomUUID(), receipt = orgCommandReceiptSchema.parse({ intentId: input.intentId, kind, outcome: "committed", committedAt: (await orgNow(tx)).toISOString(), ...result });
  await tx.query(`INSERT INTO fp_org_commands(id,actor_key,intent_id,kind,input_hash,organization_id,session_id,membership_id,membership_version,browser_hash,result,encrypted_recovery)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`, [id, actorKey, input.intentId, kind, orgHash(originalInput),
    options.identity?.organization.id ?? options.organizationId ?? null, options.identity?.session.id ?? null,
    options.identity?.member.id ?? null, options.identity?.member.version ?? null, options.browserHash ?? null, JSON.stringify(receipt),
    options.recovery === undefined ? null : sealPrivate(options.recovery, orgPrivateContext("command", id))]);
  return receipt;
}
/** Runs current-role commands with exact saved-intent recovery. A changed or
 * ended own membership receives its minimal original receipt, never private UI. */
export async function organizationCommand<T extends { intentId: string; expectedScope: string }>(request: OrganizationRequest, input: T,
  kind: OrgCommandReceipt["kind"], roles: readonly OrgRole[], work: (tx: SqlConnection, identity: OrgIdentity) => Promise<{ resourceId: string | null; resourceVersion: number | null; message: string; ownAuthorityChanged?: boolean }>, extra: unknown = null): Promise<OrgCommandReceipt> {
  return organizationTransaction(async tx => {
    const state = await readOrganizationContext(tx, request, "update");
    if (!state.original) throw new DomainError("ORG_AUTH_REQUIRED", "Open the original organization profile to recover this request.", 401);
    const actorKey = `session:${state.original.session.id}`, originalInput = { input, extra };
    const saved = await findOrgCommand(tx, actorKey, input.intentId, kind, originalInput);
    if (saved) {
      await assertOriginalOrgDeadline(tx, state.original);
      return orgCommandReceiptSchema.parse(saved.result);
    }
    const identity = await requireOrganization(tx, request, input.expectedScope, roles, true);
    if (request.organizationScope && request.organizationScope !== input.expectedScope) throw new DomainError("ORG_CONTEXT_CHANGED", "Use the original reviewed organization scope.", 409);
    const { ownAuthorityChanged, ...result } = await work(tx, identity);
    await assertOriginalOrgDeadline(tx, identity);
    if (!ownAuthorityChanged) await assertOrganizationCurrent(tx, request, identity);
    return saveOrgCommand(tx, actorKey, input, kind, originalInput, result, { identity, browserHash: browserHash(request) });
  });
}
export interface OrgCursor { at: string; id: string; }
export function orgCursor(value: string | undefined, owner: string): OrgCursor | null {
  if (!value) return null;
  try {
    const parsed = z.object({ owner: z.string(), at: z.iso.datetime(), id: z.uuid() }).strict().parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (parsed.owner !== orgHash(owner)) throw new Error();
    return parsed;
  } catch { throw new DomainError("INVALID_INPUT", "Refresh this history page; its saved position is unavailable.", 400); }
}
export function orgPage<T extends { id: string; created_at: Date }>(rows: T[], owner: string) {
  const page = rows.slice(0, ORG_PAGE_SIZE), last = page.at(-1);
  return { rows: page, nextCursor: rows.length > ORG_PAGE_SIZE && last ? Buffer.from(JSON.stringify({ owner: orgHash(owner), at: last.created_at.toISOString(), id: last.id })).toString("base64url") : null };
}
