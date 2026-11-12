import * as C from "../lifecycle/contracts";
import { lifecycleDefinitionHash, lifecyclePermission, type LifecyclePermission } from "../lifecycle/schedule";
import { DomainError } from "../domain/money";
import { query } from "./db";
import { openPrivate } from "./private-values";
import { orgHash, orgNow, readOrganizationContext, type OrgIdentity, type OrgTx } from "./organization-core";
import { readOrganizationProjectAuthority } from "./organization-projects";
import { runtimeControl } from "./runtime-control";
import { lifecyclePrivateContext, lifecycleUnavailable, readLifecycleProgram, type LifecycleDefinition, type LifecycleDelegation, type LifecycleRequest, type LifecycleScheduleHead } from "./lifecycle-core";
import { lifecycleLinks, lifecyclePin } from "./lifecycle-sources";

/** Moving observation time is informational; it never changes the reviewed
 * inputs, source basis, authority bounds or original command identity. */
export function lifecycleReviewHash(value: Omit<C.LifecycleScheduleReview, "reviewHash"> | C.LifecycleScheduleReview) {
  const { checkedAt: _checkedAt, ...body } = value;
  const { reviewHash: _reviewHash, ...stable } = body as typeof body & { reviewHash?: string };
  return orgHash({ contract: C.LIFECYCLE_VERSION, ...stable });
}
export function lifecycleDelegation(row: LifecycleDefinition): LifecycleDelegation {
  const value = openPrivate<LifecycleDelegation>(row.encrypted_data, lifecyclePrivateContext("definition", row.id));
  const review = C.lifecycleScheduleReviewSchema.parse(value.review), proposal = review.input.proposal;
  if (value.bindingHash !== orgHash({ ...value, bindingHash: "" }) || lifecycleReviewHash(review) !== row.review_hash || review.reviewHash !== row.review_hash
    || lifecycleDefinitionHash(proposal) !== row.definition_hash || value.organizationSessionId !== row.issuer_session_id || value.organizationMembershipId !== row.issuer_membership_id
    || value.projectSessionId !== row.project_session_id || review.authorization.organizationMembershipVersion !== row.issuer_membership_version
    || review.authorization.organizationRole !== row.issuer_role || review.authorization.programVersion !== row.program_version
    || review.authorization.expiresAt !== row.expires_at.toISOString() || proposal.target.kind !== row.audience
    || new Date(proposal.cadence.firstDueAt).toISOString() !== row.first_due_at.toISOString() || proposal.cadence.intervalMinutes !== row.interval_minutes) throw lifecycleUnavailable();
  return { ...value, review };
}
export async function lifecycleOwnedSchedule(tx: OrgTx, identity: OrgIdentity, id: string, definitionVersion?: number, lock = false) {
  const [head] = await query<LifecycleScheduleHead>(`SELECT * FROM fp_lifecycle_schedules WHERE id=$1 AND organization_id=$2 AND owner_membership_id=$3${lock ? " FOR UPDATE" : ""}`,
    [id, identity.organization.id, identity.member.id], tx);
  if (!head) throw lifecycleUnavailable();
  const [definition] = await query<LifecycleDefinition>("SELECT * FROM fp_lifecycle_schedule_versions WHERE schedule_id=$1 AND organization_id=$2 AND definition_version=$3 AND issuer_membership_id=$4",
    [head.id, identity.organization.id, definitionVersion ?? head.current_definition_version, identity.member.id], tx);
  if (!definition) throw lifecycleUnavailable();
  return { head, definition };
}
const denied = (code: C.LifecycleProblem["code"], reason: string): LifecyclePermission => ({ allowed: false, code, reason });
export async function checkLifecycleDelegation(tx: OrgTx, head: LifecycleScheduleHead, definition: LifecycleDefinition, mode: "produce" | "read" = "produce") {
  const delegation = lifecycleDelegation(definition), current = await readOrganizationContext(tx, delegation.request, "share"), identity = current.identity;
  if (!identity || identity.organization.id !== head.organization_id || identity.session.id !== definition.issuer_session_id || identity.member.id !== definition.issuer_membership_id
    || identity.member.version !== definition.issuer_membership_version || identity.member.role !== definition.issuer_role || identity.scope !== delegation.review.input.expectedScope)
    return { permission: denied("LIFECYCLE_ORGANIZATION_CHANGED", "The original organization profile or role changed. Its private draft content is withheld."), delegation, identity: null };
  const project = definition.audience === "project_treasurer" ? await readOrganizationProjectAuthority(tx, delegation.request, true) : null;
  if (project && (!project.authority || project.authority.session.id !== definition.project_session_id))
    return { permission: denied("LIFECYCLE_PROJECT_CHANGED", "The independently held original project profile ended. Organization access supplies no replacement project authority."), delegation, identity };
  let links;
  try { links = await lifecycleLinks(tx, identity, delegation.review.authorization.links, true); }
  catch (error) {
    if (!(error instanceof DomainError) || !["LIFECYCLE_SOURCE_WITHDRAWN", "ORG_RESOURCE_UNAVAILABLE"].includes(error.code)) throw error;
    return { permission: denied("LIFECYCLE_SOURCE_WITHDRAWN", "An exact original project disclosure changed or ended. Its private draft context is withheld."), delegation, identity };
  }
  const program = await readLifecycleProgram(tx, identity), at = await orgNow(tx);
  const permission = lifecyclePermission(delegation.review, {
    observedAt: at.toISOString(), runtimeHeld: mode === "produce" && (await runtimeControl(tx)).held,
    organization: { state: "active", scope: identity.scope, role: identity.member.role, membershipVersion: identity.member.version,
      expiresAt: new Date(Math.min(identity.session.expires_at.getTime(), identity.member.expires_at.getTime())).toISOString() },
    project: project?.authority ? { state: "active", scope: project.scope, role: project.authority.session.role, membershipVersion: project.authority.membershipVersion, expiresAt: project.authority.session.expiresAt } : null,
    program: { state: program.view.state, version: program.view.version, expiresAt: program.view.expiresAt },
    links: links.map(link => ({ ...lifecyclePin(link), state: link.state as "active" })),
    scheduleState: head.current_definition_version === definition.definition_version ? head.state : "disabled",
  }, mode);
  return { permission, delegation, identity };
}
/** Organization-only lists deliberately never disclose a private project
 * definition, even when another project cookie happens to be present. */
export async function checkLifecycleCaller(tx: OrgTx, request: LifecycleRequest, identity: OrgIdentity, head: LifecycleScheduleHead, definition: LifecycleDefinition, projectRequired: boolean) {
  if (identity.session.id !== definition.issuer_session_id || identity.member.id !== definition.issuer_membership_id || identity.member.version !== definition.issuer_membership_version || identity.member.role !== definition.issuer_role)
    return denied("LIFECYCLE_ORGANIZATION_CHANGED", "Use the exact original organization session and role; a later role cannot inherit this private definition.");
  if (definition.audience === "project_treasurer") {
    if (!projectRequired || !request.projectScope) return denied("LIFECYCLE_PROJECT_CHANGED", "Open this private definition with the independently held original project-organizer profile.");
    const current = await readOrganizationProjectAuthority(tx, request, true), target = lifecycleDelegation(definition).review.input.proposal.target;
    if (!current.authority || target.kind !== "project_treasurer" || current.authority.session.id !== definition.project_session_id || current.authority.session.role !== "organizer" || current.scope !== request.projectScope || current.scope !== target.expectedProjectScope)
      return denied("LIFECYCLE_PROJECT_CHANGED", "The independent original project-organizer profile is required. A different cookie or scope cannot disclose this private draft.");
  }
  return (await checkLifecycleDelegation(tx, head, definition, "read")).permission;
}
