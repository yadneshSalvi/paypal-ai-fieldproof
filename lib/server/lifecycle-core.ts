import { randomUUID } from "node:crypto";
import * as C from "../lifecycle/contracts";
import { DomainError } from "../domain/money";
import { query } from "./db";
import { openPrivate, sealPrivate } from "./private-values";
import { assertOrganizationCurrent, orgHash, orgNow, organizationTransaction, readOrganizationContext, requireOrganization, type OrgIdentity, type OrgTx, type OrganizationRequest } from "./organization-core";
import { organizationProjectSummary, readOrganizationProjectAuthority, type OrganizationProjectAuthority } from "./organization-projects";
import { lockRuntimeControl, runtimeControl } from "./runtime-control";

export interface LifecycleRequest extends OrganizationRequest { personalScope?: string; }
export const lifecyclePrivateContext = (kind: string, id: string) => `lifecycle:${C.LIFECYCLE_VERSION}:${kind}:${id}`;
export const lifecycleHash = orgHash;
export const lifecycleNow = orgNow;
export const lifecycleTx = organizationTransaction;
export const lifecycleUnavailable = () => new DomainError("LIFECYCLE_RESOURCE_UNAVAILABLE", "This private lifecycle record is unavailable for the exact current profile and role.", 404);
export const lifecycleActor = (identity: OrgIdentity) => `org:${identity.organization.id}:${identity.session.id}:${identity.member.id}:${identity.member.version}:${identity.member.role}`;
export const lifecycleProjectActor = (authority: OrganizationProjectAuthority) => `project:${authority.session.tenantId}:${authority.session.projectId}:${authority.session.actorId}:${authority.session.id}:${authority.membershipVersion}:${authority.session.role}`;
export const lifecycleRecipient = (authority: OrganizationProjectAuthority) => orgHash({ tenantId: authority.session.tenantId, projectId: authority.session.projectId, actorId: authority.session.actorId, role: authority.session.role });
export async function lifecycleWritable(tx: OrgTx) {
  await lockRuntimeControl(tx);
  if ((await runtimeControl(tx)).held) throw new DomainError("WORKSPACE_MAINTENANCE", "Lifecycle drafts are paused by the current execution hold. Original records and deadlines remain unchanged.", 503);
}
export async function lifecycleCutoff(tx: OrgTx): Promise<string> { return (await query<{ at: Date }>("SELECT transaction_timestamp() AS at", [], tx))[0].at.toISOString(); }
export function lifecycleCredential(request: OrganizationRequest, project: boolean): OrganizationRequest {
  if (!request.organizationToken || !request.browserKey || project && !request.projectToken) throw new DomainError("LIFECYCLE_AUTH_REQUIRED", "Review with the independently held original profile before delegating a private schedule.", 401);
  return { organizationToken: request.organizationToken, browserKey: request.browserKey, libraryToken: null, projectToken: project ? request.projectToken : null };
}
export interface LifecycleProgramRow {
  id: string; organization_id: string; version: number; state: "enabled" | "disabled"; issuer_session_id: string;
  issuer_membership_id: string; issuer_membership_version: number; issuer_role: "owner" | "coordinator";
  expires_at: Date; encrypted_grant: string; content_hash: string; created_at: Date;
}
export interface LifecycleProgramGrant { request: OrganizationRequest; originalSessionId: string; originalMembershipId: string; originalMembershipVersion: number; originalRole: "owner" | "coordinator"; expiresAt: string; }
export interface LifecycleScheduleHead {
  id: string; organization_id: string; owner_membership_id: string; version: number; current_definition_version: number;
  state: "enabled" | "paused" | "disabled"; created_at: Date; updated_at: Date;
}
export interface LifecycleDefinition {
  id: string; schedule_id: string; organization_id: string; definition_version: number; definition_hash: string; review_hash: string;
  audience: "project_treasurer" | "organization_aggregate"; issuer_session_id: string; issuer_membership_id: string;
  issuer_membership_version: number; issuer_role: "owner" | "coordinator"; project_session_id: string | null; program_version: number;
  first_due_at: Date; interval_minutes: number; expires_at: Date; encrypted_data: string; created_at: Date;
}
export interface LifecycleDelegation {
  request: OrganizationRequest; review: C.LifecycleScheduleReview; organizationSessionId: string; organizationMembershipId: string;
  projectSessionId: string | null; bindingHash: string;
}
export interface LifecycleOccurrenceRow {
  id: string; organization_id: string; schedule_id: string; definition_id: string; definition_version: number; occurrence_key: string;
  audience: C.LifecycleSchedule["audience"]; due_at: Date; expires_at: Date; version: number; state: C.LifecycleOccurrence["state"];
  read_state: C.LifecycleReadState; review_state: "unreviewed" | "reviewed_private" | "changes_requested";
  captured_at: Date | null; snapshot_hash: string | null; content_hash: string | null; attempt_count: number;
  lease_token: string | null; lease_until: Date | null; next_retry_at: Date | null; last_code: string | null; created_at: Date; updated_at: Date;
}
export interface LifecycleAttemptRow {
  id: string; occurrence_id: string; ordinal: number; lease_token: string; stage: C.LifecycleAttempt["stage"];
  outcome: C.LifecycleAttempt["outcome"]; code: string | null; next_retry_at: Date | null; started_at: Date; completed_at: Date | null;
}
export interface LifecyclePreferenceRow {
  id: string; head_id: string; version: number; session_id: string; membership_version: number; recipient_binding_hash: string;
  enabled: boolean; categories: C.LifecycleCategory[]; email_previews: boolean; history_mode: "future_only" | "current_records";
  opted_in_at: Date; expires_at: Date; encrypted_grant: string; content_hash: string; created_at: Date;
}
export interface LifecyclePreferenceHead { id: string; tenant_id: string; project_id: string; actor_id: string; role: "donor" | "volunteer"; version: number; current_version_id: string; created_at: Date; updated_at: Date; }
export interface LifecyclePersonalGrant { projectToken: string; sessionId: string; tenantId: string; projectId: string; actorId: string; role: "donor" | "volunteer"; membershipVersion: number; expiresAt: string; scope: string; }
export interface LifecycleInboxRow {
  id: string; tenant_id: string; project_id: string; actor_id: string; role: "donor" | "volunteer"; session_id: string; membership_version: number;
  preference_version_id: string; recipient_binding_hash: string; event_key: string; version: number; read_state: C.LifecycleReadState;
  source_hash: string; snapshot_hash: string; content_hash: string; occurred_at: Date; captured_at: Date; expires_at: Date;
  encrypted_data: string; created_at: Date; updated_at: Date;
}
export async function requireLifecycleOrganization(tx: OrgTx, request: LifecycleRequest, expected: string | undefined = request.organizationScope, write = false) {
  if (!expected || request.organizationScope !== expected) throw new DomainError("LIFECYCLE_ORGANIZATION_CHANGED", "Use the exact current organization header and reviewed decision scope.", 409);
  return requireOrganization(tx, request, expected, ["owner", "coordinator"], write);
}
export async function requireLifecyclePersonal(tx: OrgTx, request: LifecycleRequest, expected: string | undefined = request.personalScope) {
  const current = await readOrganizationProjectAuthority(tx, request, true);
  if (!current.authority) throw new DomainError(current.state === "none" ? "LIFECYCLE_AUTH_REQUIRED" : "LIFECYCLE_AUTHORITY_ENDED", "Open the original current donor or volunteer profile to read its own lifecycle records.", current.state === "none" ? 401 : 410);
  if (!expected || expected !== current.scope || request.personalScope !== expected) throw new DomainError("LIFECYCLE_PROJECT_CHANGED", "The active project profile changed. Refresh its exact current header and reviewed scope before continuing.", 409);
  if (!["donor", "volunteer"].includes(current.authority.session.role)) throw new DomainError("LIFECYCLE_AUTH_REQUIRED", "Personal lifecycle records belong to the independently held donor or volunteer role.", 403);
  return current.authority;
}
export async function assertLifecyclePersonal(tx: OrgTx, request: LifecycleRequest, authority: OrganizationProjectAuthority) {
  const current = await readOrganizationProjectAuthority(tx, request);
  if (!current.authority || current.scope !== authority.scope || current.authority.session.id !== authority.session.id || current.authority.session.role !== authority.session.role) throw new DomainError("LIFECYCLE_PROJECT_CHANGED", "Original project authority changed while this view was prepared. Its private content is withheld.", 409);
}
export async function lifecycleContext(request: LifecycleRequest) {
  return lifecycleTx(async tx => {
    const organization = await readOrganizationContext(tx, request, "share"), project = await readOrganizationProjectAuthority(tx, request, true), authority = project.authority;
    const personal = !!authority && ["donor", "volunteer"].includes(authority.session.role), writer = !!organization.identity && ["owner", "coordinator"].includes(organization.identity.member.role);
    const value = C.lifecycleContextSchema.parse({ contractVersion: C.LIFECYCLE_VERSION, checkedAt: (await orgNow(tx)).toISOString(),
      project: { scope: project.scope, state: project.state, profile: authority ? { project: await organizationProjectSummary(tx, authority.session), role: authority.session.role,
        label: `${authority.session.role[0].toUpperCase()}${authority.session.role.slice(1)} profile · ${authority.session.id.slice(-6)}`, membershipVersion: authority.membershipVersion, expiresAt: authority.session.expiresAt, identityProvenance: "workspace_session" } : null,
      canReadInbox: personal, canChangePreferences: personal, canPrepareTreasurer: authority?.session.role === "organizer", reasons: !authority ? ["Choose an independently current project profile for its own lifecycle records."] : [] },
      organization: organization.context, canManageProgram: writer, canPrepareAggregate: writer, deliveryMode: "private_drafts_and_email_previews" });
    if (organization.identity) await assertOrganizationCurrent(tx, request, organization.identity);
    if (authority) await assertLifecyclePersonal(tx, request, authority);
    return { context: value };
  });
}
export async function findLifecycleCommand(tx: OrgTx, actorKey: string, input: { intentId: string }, kind: C.LifecycleReceipt["kind"], binding: unknown = input): Promise<C.LifecycleReceipt | null> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`lifecycle-command:${actorKey}:${input.intentId}`]);
  const [row] = await query<{ kind: C.LifecycleReceipt["kind"]; input_hash: string; result: unknown }>("SELECT kind,input_hash,result FROM fp_lifecycle_commands WHERE actor_key=$1 AND intent_id=$2", [actorKey, input.intentId], tx);
  if (!row) return null;
  if (row.kind !== kind || row.input_hash !== orgHash(binding)) throw new DomainError("LIFECYCLE_INTENT_CHANGED", "This original intent has different reviewed values. Recover its exact saved request before starting another decision.", 409);
  return C.lifecycleReceiptSchema.parse(row.result);
}
export async function saveLifecycleCommand(tx: OrgTx, actorKey: string, input: { intentId: string }, kind: C.LifecycleReceipt["kind"], result: Pick<C.LifecycleReceipt,"resourceId"|"resourceVersion"|"message">, binding: unknown = input) {
  const receipt = C.lifecycleReceiptSchema.parse({ intentId: input.intentId, kind, recordedAt: (await orgNow(tx)).toISOString(), ...result });
  await tx.query("INSERT INTO fp_lifecycle_commands(id,actor_key,intent_id,kind,input_hash,result) VALUES($1,$2,$3,$4,$5,$6::jsonb)", [randomUUID(), actorKey, input.intentId, kind, orgHash(binding), JSON.stringify(receipt)]);
  return receipt;
}
export async function lifecycleAudit(tx: OrgTx, scope: { organizationId?: string; tenantId?: string; projectId?: string }, actorKey: string, kind: string, resourceId: string | null, data: unknown) {
  const id = randomUUID();
  await tx.query("INSERT INTO fp_lifecycle_audit(id,organization_id,tenant_id,project_id,actor_key,kind,resource_id,encrypted_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id, scope.organizationId ?? null, scope.tenantId ?? null, scope.projectId ?? null, actorKey, kind, resourceId, sealPrivate(data, lifecyclePrivateContext("audit", id))]);
}
export function lifecycleProgramGrant(row: LifecycleProgramRow): LifecycleProgramGrant {
  const value = openPrivate<LifecycleProgramGrant>(row.encrypted_grant, lifecyclePrivateContext("program", row.id));
  if (orgHash(value) !== row.content_hash || value.originalSessionId !== row.issuer_session_id || value.originalMembershipId !== row.issuer_membership_id || value.originalMembershipVersion !== row.issuer_membership_version || value.originalRole !== row.issuer_role || value.expiresAt !== row.expires_at.toISOString()) throw lifecycleUnavailable();
  return value;
}
export async function readLifecycleProgram(tx: OrgTx, identity: OrgIdentity, lock = false) {
  const [head] = await query<{ version: number; current_version_id: string; state: "enabled"|"disabled" }>(`SELECT version,current_version_id,state FROM fp_lifecycle_program_heads WHERE organization_id=$1${lock ? " FOR UPDATE" : ""}`, [identity.organization.id], tx);
  const [row] = head ? await query<LifecycleProgramRow>("SELECT * FROM fp_lifecycle_program_versions WHERE id=$1 AND organization_id=$2 AND version=$3", [head.current_version_id, identity.organization.id, head.version], tx) : [];
  const at = await orgNow(tx), writer = ["owner","coordinator"].includes(identity.member.role);
  let state: C.LifecycleProgram["state"] = row?.state ?? "disabled", reasons: string[] = [];
  if (row && state === "enabled") {
    const grant = lifecycleProgramGrant(row), original = await readOrganizationContext(tx, grant.request, "share");
    if (row.expires_at <= at) { state = "expired"; reasons = ["The original organization opt-in deadline ended."]; }
    else if (!original.identity || original.identity.session.id !== row.issuer_session_id || original.identity.member.id !== row.issuer_membership_id || original.identity.member.version !== row.issuer_membership_version || original.identity.member.role !== row.issuer_role) { state = "authority_changed"; reasons = ["The original opt-in authorizer's authority changed. A new explicit organization opt-in and schedule review is required."]; }
  }
  const view = C.lifecycleProgramSchema.parse({ version: head?.version ?? 0, state, expiresAt: row?.expires_at.toISOString() ?? null, maxExpiresAt: new Date(Math.min(identity.session.expires_at.getTime(), identity.member.expires_at.getTime())).toISOString(),
    canEnable: writer && state !== "enabled", canDisable: writer && head?.state === "enabled", reasons });
  return { head, row: row ?? null, view };
}
export function lifecycleVersion(actual: number, expected: number, label = "record") {
  if (actual !== expected) throw new DomainError("LIFECYCLE_VERSION_CHANGED", `The current ${label} changed. Review its current version before a new decision.`, 409);
}
