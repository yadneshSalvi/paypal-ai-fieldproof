import { ORG_GOVERNANCE_VERSION, orgDeskSchema } from "../organizations/contracts";
import { assertOrganizationCurrent, orgCapabilities, orgNow, organizationTransaction, requireOrganization, type OrganizationRequest } from "./organization-core";
import { organizationMemberView, organizationMembersPage, organizationInvitationsPage, organizationEventsPage } from "./organization-members";
import { organizationPoliciesPage } from "./organization-policies";
import { organizationProjectsPage } from "./organization-projects";
import { organizationAdoptionsPage } from "./organization-adoptions";

export async function readOrganizationDesk(request: OrganizationRequest) {
  return organizationTransaction(async tx => {
    const identity = await requireOrganization(tx, request, request.organizationScope);
    const members = identity.member.role === "owner" ? await organizationMembersPage(tx, identity) : null;
    const invitations = identity.member.role === "owner" ? await organizationInvitationsPage(tx, identity) : null;
    const projects = await organizationProjectsPage(tx, identity), adoptions = await organizationAdoptionsPage(tx, identity);
    const policies = await organizationPoliciesPage(tx, identity), events = await organizationEventsPage(tx, identity);
    const desk = orgDeskSchema.parse({ contractVersion: ORG_GOVERNANCE_VERSION, scope: identity.scope, checkedAt: (await orgNow(tx)).toISOString(),
      organization: { id: identity.organization.id, version: identity.organization.version, name: identity.organization.name, description: identity.organization.description,
        identityProvenance: "self_declared", createdAt: identity.organization.created_at.toISOString() },
      profile: identity.profile, capabilities: orgCapabilities(identity.member.role), ownMembership: await organizationMemberView(tx, identity, identity.member),
      roster: members && invitations ? { members: members.members, nextMemberCursor: members.nextCursor, invitations: invitations.invitations, nextInvitationCursor: invitations.nextCursor } : null,
      links: projects.projects, nextLinkCursor: projects.nextCursor, adoptions: adoptions.adoptions, nextAdoptionCursor: adoptions.nextCursor,
      policies: policies.policies, nextPolicyCursor: policies.nextCursor, events: events.events, nextEventCursor: events.nextCursor });
    JSON.stringify(desk); await assertOrganizationCurrent(tx, request, identity);
    return { desk };
  });
}
export async function readOrganizationPage(request: OrganizationRequest, page: "members" | "invitations" | "projects" | "policies" | "events", before?: string) {
  return organizationTransaction(async tx => {
    const identity = await requireOrganization(tx, request, request.organizationScope);
    const loader = { members: organizationMembersPage, invitations: organizationInvitationsPage, projects: organizationProjectsPage, policies: organizationPoliciesPage, events: organizationEventsPage }[page];
    const result = await loader(tx, identity, before);
    await assertOrganizationCurrent(tx, request, identity);
    return result;
  });
}
