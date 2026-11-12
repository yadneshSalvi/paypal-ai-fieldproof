import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ORG_PAGE_SIZE, orgLinkCommitSchema, orgLinkReviewInputSchema, orgLinkReviewSchema, orgLinkSchema, orgLinkWithdrawSchema,
  orgProjectBasisSchema, orgProjectContextSchema, orgProjectSummarySchema,
  type OrgDisclosureSection, type OrgLink, type OrgLinkReview, type OrgProjectBasis, type OrgProjectContext,
} from "../organizations/contracts";
import { defaultRequirements } from "../planning/contracts";
import { DomainError } from "../domain/money";
import { type Session, tokenHash } from "./auth";
import { projectClaimLock } from "./claims";
import { query } from "./db";
import { documentPrivate, type DocumentRow } from "./documents";
import { requireCurrentRole } from "./membership";
import { packageBindings, planPayload, planningHead, requirePlan, sourceControl } from "./planning-store";
import { openPrivate, sealPrivate } from "./private-values";
import { appendEvent } from "./repository";
import {
  assertOrganizationCurrent, findOrgCommand, orgCapabilities, orgCursor, orgHash, orgNow, orgPage, orgPrivateContext,
  organizationAudit, organizationCommand, organizationTransaction, requireOrganization, saveOrgCommand,
  type OrgIdentity, type OrgMemberRow, type OrgSessionRow, type OrgTx, type OrganizationRequest,
} from "./organization-core";

export interface OrganizationProjectAuthority { session: Session; membershipVersion: number; scope: string; }
interface ProjectSessionRow { id: string; tenant_id: string; project_id: string; actor_id: string; role: Session["role"]; token_hash: string; expires_at: Date; revoked_at: Date | null; mode: Session["mode"]; }
interface ProjectMemberRow { version: number; state: string; roles: Session["role"][]; }
export interface OrgLinkRow {
  id: string; organization_id: string; tenant_id: string; project_id: string; version: number;
  state: "active" | "withdrawn"; current_consent_id: string; withdrawn_at: Date | null; created_at: Date; updated_at: Date;
}
export interface OrgConsentRow {
  id: string; link_id: string; organization_id: string; tenant_id: string; project_id: string;
  revision: number; disclosure: OrgDisclosureSection[]; content_hash: string;
  org_membership_id: string; org_membership_version: number; org_session_id: string; org_session_expires_at: Date;
  project_actor_id: string; project_membership_version: number; project_session_id: string; project_session_expires_at: Date;
  expires_at: Date; encrypted_data: string; approved_at: Date;
}
export interface CurrentOrgLink { row: OrgLinkRow; consent: OrgConsentRow; state: OrgLink["state"]; reasons: string[]; }

export async function readOrganizationProjectAuthority(tx: OrgTx, request: OrganizationRequest, lock = false) {
  const hash = request.projectToken === null ? null : tokenHash(request.projectToken);
  const [session] = hash ? await query<ProjectSessionRow>(`SELECT s.*,t.mode FROM fp_sessions s JOIN fp_tenants t ON t.id=s.tenant_id WHERE s.token_hash=$1${lock ? " FOR SHARE OF s" : ""}`, [hash], tx) : [];
  const [member] = session ? await query<ProjectMemberRow>(`SELECT version,state,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3${lock ? " FOR SHARE" : ""}`, [session.tenant_id, session.project_id, session.actor_id], tx) : [];
  const at = await orgNow(tx), active = !!session && !!member && !session.revoked_at && session.expires_at > at && member.state === "active" && member.roles.includes(session.role);
  const state: OrgProjectContext["state"] = active ? "active" : request.projectToken === null ? "none" : "ended";
  const scope = orgHash({ credential: hash, state, session: session?.id ?? null, tenant: session?.tenant_id ?? null,
    project: session?.project_id ?? null, actor: session?.actor_id ?? null, role: active ? session.role : null,
    membershipVersion: member?.version ?? null, expiresAt: session?.expires_at.toISOString() ?? null });
  const authority: OrganizationProjectAuthority | null = active ? { scope, membershipVersion: member.version,
    session: { id: session.id, tenantId: session.tenant_id, projectId: session.project_id, actorId: session.actor_id, role: session.role, expiresAt: session.expires_at.toISOString(), mode: session.mode } } : null;
  return { state, scope, authority };
}
export async function requireOrganizationProject(tx: OrgTx, request: OrganizationRequest, expectedScope: string | undefined, write = false) {
  const current = await readOrganizationProjectAuthority(tx, request, true);
  if (!current.authority || current.authority.session.role !== "organizer") throw new DomainError("ORG_PROJECT_AUTHORITY_REQUIRED", "Open the separately held current project-organizer profile for this decision.", 403);
  if (!expectedScope || current.scope !== expectedScope || request.projectScope && request.projectScope !== expectedScope) throw new DomainError("ORG_PROJECT_CONTEXT_CHANGED", "The separate project profile changed. Refresh its original scope before continuing.", 409);
  if (write) {
    // Shared with financial constructors, followed by planning then governance.
    await projectClaimLock(tx, current.authority.session.projectId);
    await requireCurrentRole(current.authority.session, "organizer", tx);
  }
  return current.authority;
}
export async function assertOrganizationProjectCurrent(tx: OrgTx, request: OrganizationRequest, original: OrganizationProjectAuthority) {
  const current = await readOrganizationProjectAuthority(tx, request);
  if (!current.authority || current.scope !== original.scope || current.authority.session.role !== "organizer") throw new DomainError("ORG_PROJECT_CONTEXT_CHANGED", "Project authority changed while this decision waited. Its private result is withheld.", 409);
}
export async function organizationProjectSummary(tx: OrgTx, scope: Pick<Session, "tenantId" | "projectId">) {
  const [row] = await query<{ id: string; metadata: { title: string; templateId?: string; currency: string }; mode: Session["mode"] }>("SELECT p.id,p.metadata,t.mode FROM fp_projects p JOIN fp_tenants t ON t.id=p.tenant_id WHERE p.id=$1 AND p.tenant_id=$2", [scope.projectId, scope.tenantId], tx);
  if (!row) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This project is unavailable in the current scope.", 404);
  return orgProjectSummarySchema.parse({ id: row.id, title: row.metadata.title, templateId: row.metadata.templateId ?? "makerspace", currency: row.metadata.currency, mode: row.mode });
}
export async function lockProjectGovernanceHead(tx: OrgTx, session: Session) {
  await projectClaimLock(tx, session.projectId);
  const planning = await planningHead(session, tx, true);
  await tx.query("INSERT INTO fp_project_governance_heads(tenant_id,project_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [session.tenantId, session.projectId]);
  const [head] = await query<{ version: number }>("SELECT version FROM fp_project_governance_heads WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE", [session.tenantId, session.projectId], tx);
  return { planning, adoptionHead: head.version };
}
export async function projectPackageEncumbrances(tx: OrgTx, session: Pick<Session, "tenantId" | "projectId">, packageId: string): Promise<string[]> {
  const [row] = await query<Record<string, boolean>>(`SELECT
    EXISTS(SELECT 1 FROM fp_obligations WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3) AS obligations,
    EXISTS(SELECT 1 FROM fp_collection_rounds WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3) AS rounds,
    EXISTS(SELECT 1 FROM fp_settlement_receipts WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3) AS receipts,
    EXISTS(SELECT 1 FROM fp_funding_assignments WHERE tenant_id=$1 AND project_id=$2 AND (debit_package_id=$3 OR credit_package_id=$3)) AS assignments,
    EXISTS(SELECT 1 FROM fp_funding_deductions d JOIN fp_settlement_receipts r ON r.id=d.receipt_id WHERE d.tenant_id=$1 AND d.project_id=$2 AND r.package_id=$3) AS deductions,
    EXISTS(SELECT 1 FROM fp_purpose_pledges WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3) AS promises,
    EXISTS(SELECT 1 FROM fp_funding_cases WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3) AS cancellation,
    EXISTS(SELECT 1 FROM fp_funding_policies WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3) AS purpose_policy,
    EXISTS(SELECT 1 FROM fp_claim_line_reviews l JOIN fp_claims c ON c.id=l.claim_id WHERE c.tenant_id=$1 AND c.project_id=$2 AND l.package_id=$3) AS reviewed_claims,
    EXISTS(SELECT 1 FROM fp_receipt_allocations a JOIN fp_settlement_receipts r ON r.id=a.receipt_id WHERE r.tenant_id=$1 AND r.project_id=$2 AND a.package_id=$3) AS allocations,
    EXISTS(SELECT 1 FROM fp_evidence WHERE tenant_id=$1 AND project_id=$2 AND data->'packageIds' ? $3) AS evidence,
    EXISTS(SELECT 1 FROM fp_photo_alignments WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3) AS image_history,
    EXISTS(SELECT 1 FROM fp_work_signoffs WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3) AS work_history`, [session.tenantId, session.projectId, packageId], tx);
  const labels: Record<string, string> = { obligations: "Original contribution or pledge history", rounds: "Original collection round", receipts: "Original settlement receipt", assignments: "Funding assignment history", deductions: "Funding deduction history", promises: "Original named-purpose promise", cancellation: "Cancellation and donor-choice history", purpose_policy: "Original purpose-funding policy", reviewed_claims: "Reviewed expense history", allocations: "Payment or fee allocation history", evidence: "Recorded project evidence", image_history: "Original image-association history", work_history: "Original scoped work-review history" };
  const blockers = Object.entries(row).filter(([, present]) => present).map(([key]) => labels[key]);
  // An unreviewed private claim is also an encumbrance when its proposal names
  // this package. Its title, claimant and source never leave this helper.
  const claims = await query<{ id: string; version: number; encrypted_data: string }>("SELECT id,version,encrypted_data FROM fp_claims WHERE tenant_id=$1 AND project_id=$2", [session.tenantId, session.projectId], tx);
  if (claims.some(claim => openPrivate<{ lines: { packageId: string | null }[] }>(claim.encrypted_data, `claim:${session.tenantId}:${session.projectId}:${claim.id}:v${claim.version}`).lines.some(line => line.packageId === packageId))) blockers.push("Original expense proposal");
  return [...new Set(blockers)];
}
export async function organizationProjectBasis(tx: OrgTx, session: Session): Promise<OrgProjectBasis> {
  const [project] = await query<{ projection_version: number }>("SELECT projection_version FROM fp_projects WHERE tenant_id=$1 AND id=$2", [session.tenantId, session.projectId], tx);
  const planning = await planningHead(session, tx), packages = await packageBindings(session.projectId, tx);
  const [adoption] = await query<{ version: number }>("SELECT version FROM fp_project_governance_heads WHERE tenant_id=$1 AND project_id=$2", [session.tenantId, session.projectId], tx);
  const sources = await query("SELECT d.id,d.version,d.state,d.sha256,d.purpose,COALESCE(c.version,1) control_version,COALESCE(c.permission,'allowed') permission FROM fp_documents d LEFT JOIN fp_plan_source_controls c ON c.document_id=d.id AND c.tenant_id=d.tenant_id AND c.project_id=d.project_id WHERE d.tenant_id=$1 AND d.project_id=$2 AND d.purpose IN ('sketch','quote') ORDER BY d.id", [session.tenantId, session.projectId], tx);
  const facts = { projectionVersion: project.projection_version, planningHead: planning.version, adoptionHead: adoption?.version ?? 0, packageHash: orgHash(packages), sourceHash: orgHash(sources) };
  return orgProjectBasisSchema.parse({ ...facts, hash: orgHash(facts) });
}
export async function assertOrganizationProjectBasis(tx: OrgTx, session: Session, expected: OrgProjectBasis) {
  const current = await organizationProjectBasis(tx, session);
  if (orgHash(current) !== orgHash(expected)) throw new DomainError("ORG_PROJECT_SOURCE_CHANGED", "The project packages, sources, plan or adopted rules changed. Review the current exact project basis again.", 409);
  return current;
}
export async function organizationProjectContext(tx: OrgTx, request: OrganizationRequest): Promise<OrgProjectContext> {
  const current = await readOrganizationProjectAuthority(tx, request, true);
  const result: OrgProjectContext = { scope: current.scope, state: current.state, project: null, role: null, profileLabel: null, expiresAt: null,
    basis: null, maxLinkExpiresAt: null, packages: [], sources: [], currentPlan: null, canLink: false, canAdopt: false, canMaterialize: false, canReviseEmptyPackages: false, reasons: [] };
  if (!current.authority) return orgProjectContextSchema.parse(result);
  const session = current.authority.session;
  result.project = await organizationProjectSummary(tx, session); result.role = session.role;
  result.profileLabel = `${session.role[0].toUpperCase()}${session.role.slice(1)} profile · ${session.id.slice(-6)}`;
  result.expiresAt = session.expiresAt;
  if (session.role !== "organizer") { result.reasons = ["Project governance requires the separately held current organizer profile."]; return orgProjectContextSchema.parse(result); }
  result.basis = await organizationProjectBasis(tx, session); result.maxLinkExpiresAt = session.expiresAt;
  const packages = await query<{ id: string; version: number; budget_minor: string; data: { title: string; description: string; category: string; fundingState: string } }>("SELECT * FROM fp_packages WHERE project_id=$1 ORDER BY id", [session.projectId], tx);
  for (const pkg of packages) {
    const blockers = await projectPackageEncumbrances(tx, session, pkg.id);
    if (pkg.data.fundingState !== "open") blockers.push("This package is not an untouched open purpose");
    result.packages.push({ id: pkg.id, version: pkg.version, title: pkg.data.title, description: pkg.data.description, budgetMinor: Number(pkg.budget_minor), category: pkg.data.category,
      requirements: defaultRequirements(pkg.id), canReviseEmpty: blockers.length === 0, revisionBlockers: blockers });
  }
  const documents = await query<DocumentRow>("SELECT * FROM fp_documents WHERE tenant_id=$1 AND project_id=$2 AND state='ready' AND purpose IN ('sketch','quote') ORDER BY created_at DESC,id DESC LIMIT 151", [session.tenantId, session.projectId], tx);
  for (const document of documents.slice(0, 150)) {
    const control = await sourceControl(document, tx);
    if (control.permission !== "allowed" || !document.sha256) continue;
    const data = documentPrivate(document);
    result.sources.push({ id: document.id, filename: data.filename, purpose: document.purpose as "sketch" | "quote", provenance: document.provenance,
      pages: data.pages.map(page => page.number), version: document.version, contentHash: document.sha256, controlVersion: control.version });
  }
  if (documents.length > 150) result.reasons.push("The latest 150 validated planning sources are available in this selector. Original source history remains in Planning.");
  const head = await planningHead(session, tx);
  if (head.current_plan_id) {
    const row = await requirePlan(session, head.current_plan_id, tx), payload = planPayload(row);
    result.currentPlan = { id: row.id, revision: row.revision, contentHash: row.content_hash, sourceDocumentId: payload.plan.sourceDocumentId, sourcePage: payload.plan.sourcePage };
  }
  result.canLink = true; result.canAdopt = true; result.canMaterialize = !!result.currentPlan || result.sources.some(source => source.purpose === "sketch");
  result.canReviseEmptyPackages = result.packages.some(pkg => pkg.canReviseEmpty);
  await assertOrganizationProjectCurrent(tx, request, current.authority);
  return orgProjectContextSchema.parse(result);
}

/** This uses the original independent membership grant, not the organizer's
 * presently selected view role. Switching their own view does not revoke an
 * explicitly approved disclosure; expiry, revocation or membership change does. */
export async function currentOrganizationLink(tx: OrgTx, row: OrgLinkRow, lock = false): Promise<CurrentOrgLink> {
  const [consent] = await query<OrgConsentRow>("SELECT * FROM fp_org_project_consents WHERE link_id=$1 AND id=$2", [row.id, row.current_consent_id], tx);
  if (!consent) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This disclosure's original consent is unavailable.", 409);
  const value = openPrivate<{ input: unknown; authority: unknown; approvedAt: string }>(consent.encrypted_data, orgPrivateContext("consent", consent.id));
  if (orgHash(value) !== consent.content_hash) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This disclosure's original consent could not be verified.", 409);
  if (row.state === "withdrawn") return { row, consent, state: "withdrawn", reasons: ["One of the original authorities withdrew aggregate disclosure. Project-owned adopted rules remain independent."] };
  if (consent.expires_at <= await orgNow(tx)) return { row, consent, state: "expired", reasons: ["The original disclosure passed its fixed deadline."] };
  const suffix = lock ? " FOR SHARE" : "";
  const [orgMember] = await query<OrgMemberRow>(`SELECT * FROM fp_org_memberships WHERE organization_id=$1 AND id=$2${suffix}`, [row.organization_id, consent.org_membership_id], tx);
  const [orgSession] = await query<OrgSessionRow>(`SELECT * FROM fp_org_sessions WHERE organization_id=$1 AND membership_id=$2 AND id=$3${suffix}`, [row.organization_id, consent.org_membership_id, consent.org_session_id], tx);
  const [projectSession] = await query<ProjectSessionRow>(`SELECT * FROM fp_sessions WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND id=$4${suffix}`, [row.tenant_id, row.project_id, consent.project_actor_id, consent.project_session_id], tx);
  const [projectMember] = await query<ProjectMemberRow>(`SELECT version,state,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3${suffix}`, [row.tenant_id, row.project_id, consent.project_actor_id], tx);
  const at = await orgNow(tx), reasons: string[] = [];
  if (!orgMember || orgMember.state !== "active" || orgMember.revoked_at || orgMember.version !== consent.org_membership_version || !["owner", "coordinator"].includes(orgMember.role) || orgMember.expires_at <= at || !orgSession || orgSession.revoked_at || orgSession.expires_at <= at || orgSession.expires_at.getTime() !== consent.org_session_expires_at.getTime()) reasons.push("The original organization authorizer's authority changed or ended.");
  if (!projectMember || projectMember.state !== "active" || projectMember.version !== consent.project_membership_version || !projectMember.roles.includes("organizer") || !projectSession || projectSession.revoked_at || projectSession.expires_at <= at || projectSession.expires_at.getTime() !== consent.project_session_expires_at.getTime()) reasons.push("The independent project organizer's original authority changed or ended.");
  return { row, consent, state: reasons.length ? "suspended" : "active", reasons };
}
export async function organizationLinkById(tx: OrgTx, id: string, organizationId?: string, lock = false) {
  const [row] = await query<OrgLinkRow>(`SELECT * FROM fp_org_project_links WHERE id=$1 AND ($2::text IS NULL OR organization_id=$2)${lock ? " FOR UPDATE" : ""}`, [id, organizationId ?? null], tx);
  if (!row) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This disclosure is unavailable in your current scope.", 404);
  return row;
}
export async function organizationLinkView(tx: OrgTx, identity: OrgIdentity, row: OrgLinkRow): Promise<OrgLink> {
  const [locked] = await query<OrgLinkRow>("SELECT * FROM fp_org_project_links WHERE id=$1 AND organization_id=$2 FOR SHARE", [row.id, identity.organization.id], tx);
  if (!locked) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This project disclosure is unavailable.", 404);
  const current = await currentOrganizationLink(tx, locked, true), { consent } = current, writer = orgCapabilities(identity.member.role).canLinkProjects;
  row = locked;
  return orgLinkSchema.parse({ id: row.id, version: row.version, state: current.state,
    project: current.state === "active" ? await organizationProjectSummary(tx, { tenantId: row.tenant_id, projectId: row.project_id }) : null,
    consent: { id: consent.id, revision: consent.revision, contentHash: consent.content_hash, disclosure: consent.disclosure,
      approvedAt: consent.approved_at.toISOString(), expiresAt: consent.expires_at.toISOString(), projectMembershipVersion: consent.project_membership_version, organizationMembershipVersion: consent.org_membership_version },
    canRereview: writer, canWithdraw: writer && row.state !== "withdrawn", reasons: current.reasons });
}
export async function organizationProjectsPage(tx: OrgTx, identity: OrgIdentity, before?: string) {
  const owner = `${identity.organization.id}:projects`, cursor = orgCursor(before, owner);
  const rows = await query<OrgLinkRow>("SELECT * FROM fp_org_project_links WHERE organization_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::text)) ORDER BY created_at DESC,id DESC LIMIT $4", [identity.organization.id, cursor?.at ?? null, cursor?.id ?? null, ORG_PAGE_SIZE + 1], tx);
  const page = orgPage(rows, owner), projects: OrgLink[] = [];
  for (const row of page.rows) projects.push(await organizationLinkView(tx, identity, row));
  return { projects, nextCursor: page.nextCursor };
}
async function linkReview(tx: OrgTx, request: OrganizationRequest, identity: OrgIdentity, project: OrganizationProjectAuthority, input: z.infer<typeof orgLinkReviewInputSchema>): Promise<OrgLinkReview> {
  await assertOrganizationProjectBasis(tx, project.session, input.expectedProjectBasis);
  const [existing] = await query<OrgLinkRow>("SELECT * FROM fp_org_project_links WHERE organization_id=$1 AND project_id=$2", [identity.organization.id, project.session.projectId], tx);
  if ((existing?.id ?? null) !== input.existingLinkId || (existing?.version ?? 0) !== input.expectedLinkVersion) throw new DomainError("ORG_VERSION_CHANGED", "This project relationship changed. Review its current consent before continuing.", 409);
  const at = await orgNow(tx), maximum = Math.min(identity.session.expires_at.getTime(), identity.member.expires_at.getTime(), Date.parse(project.session.expiresAt)), proposed = Date.parse(input.proposal.expiresAt);
  const blockers: string[] = [];
  if (proposed <= at.getTime() || proposed > maximum) blockers.push("Choose a future deadline no later than either original authorizing profile's fixed expiry.");
  if (!existing) {
    const [{ count }] = await query<{ count: string }>("SELECT count(*) FROM fp_org_project_links WHERE organization_id=$1", [identity.organization.id], tx);
    if (Number(count) >= 200) blockers.push("This organization already retains 200 project relationships. Existing relationships remain available for review and withdrawal.");
  }
  const base = { input, project: await organizationProjectSummary(tx, project.session), organizationName: identity.organization.name,
    effectiveExpiresAt: input.proposal.expiresAt, scopes: [...input.proposal.disclosure].sort(),
    warnings: ["Only the selected project aggregates will be shared. Organization membership grants no project role, private source, Board edition or payment authority.", "Either authority may withdraw disclosure. Copied project rules and original financial history are retained separately."], blockers, canCommit: blockers.length === 0 };
  const reviewHash = orgHash({ ...base, organizationMembership: identity.member.version, organizationSession: identity.session.id, projectMembership: project.membershipVersion, projectSession: project.session.id });
  await assertOrganizationCurrent(tx, request, identity); await assertOrganizationProjectCurrent(tx, request, project);
  return orgLinkReviewSchema.parse({ reviewHash, ...base });
}
export async function reviewOrganizationProjectLink(request: OrganizationRequest, raw: unknown) {
  const input = orgLinkReviewInputSchema.parse(raw);
  return organizationTransaction(async tx => {
    const identity = await requireOrganization(tx, request, input.expectedScope, ["owner", "coordinator"]), project = await requireOrganizationProject(tx, request, input.expectedProjectScope);
    return { review: await linkReview(tx, request, identity, project, input) };
  }, true);
}
export async function commitOrganizationProjectLink(request: OrganizationRequest, raw: unknown) {
  const input = orgLinkCommitSchema.parse(raw);
  const receipt = await organizationCommand(request, input, "link_project", ["owner", "coordinator"], async (tx, identity) => {
    const project = await requireOrganizationProject(tx, request, input.expectedProjectScope, true);
    await lockProjectGovernanceHead(tx, project.session);
    const selection = orgLinkReviewInputSchema.parse({ expectedScope: input.expectedScope, expectedProjectScope: input.expectedProjectScope,
      expectedProjectBasis: input.expectedProjectBasis, existingLinkId: input.existingLinkId, expectedLinkVersion: input.expectedLinkVersion, proposal: input.proposal });
    const review = await linkReview(tx, request, identity, project, selection);
    if (review.reviewHash !== input.reviewHash || !review.canCommit) throw new DomainError("ORG_POLICY_REVIEW_REQUIRED", "Review the current exact aggregate disclosure and deadline before committing.", 409);
    const id = input.existingLinkId ?? randomUUID(), consentId = randomUUID(), at = await orgNow(tx);
    let revision = 1;
    if (input.existingLinkId) {
      const existing = await organizationLinkById(tx, id, identity.organization.id, true);
      const prior = await currentOrganizationLink(tx, existing); revision = prior.consent.revision + 1;
    } else await tx.query("INSERT INTO fp_org_project_links(id,organization_id,tenant_id,project_id,current_consent_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)", [id, identity.organization.id, project.session.tenantId, project.session.projectId, consentId, at]);
    const value = { input: selection, authority: { organizationSessionId: identity.session.id, organizationMembershipId: identity.member.id,
      organizationMembershipVersion: identity.member.version, organizationRole: identity.member.role, projectSessionId: project.session.id,
      projectActorId: project.session.actorId, projectMembershipVersion: project.membershipVersion }, approvedAt: at.toISOString() };
    await tx.query(`INSERT INTO fp_org_project_consents(id,link_id,organization_id,tenant_id,project_id,revision,disclosure,content_hash,org_membership_id,org_membership_version,org_session_id,org_session_expires_at,project_actor_id,project_membership_version,project_session_id,project_session_expires_at,expires_at,encrypted_data,approved_at)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`, [consentId, id, identity.organization.id, project.session.tenantId, project.session.projectId, revision,
      JSON.stringify([...input.proposal.disclosure].sort()), orgHash(value), identity.member.id, identity.member.version, identity.session.id, identity.session.expires_at,
      project.session.actorId, project.membershipVersion, project.session.id, project.session.expiresAt, input.proposal.expiresAt, sealPrivate(value, orgPrivateContext("consent", consentId)), at]);
    if (input.existingLinkId) await tx.query("UPDATE fp_org_project_links SET current_consent_id=$2,state='active',withdrawn_at=NULL,version=version+1,updated_at=$3 WHERE id=$1", [id, consentId, at]);
    await organizationAudit(tx, identity.organization.id, "organization.project_disclosure_approved", identity,
      { title: "A project approved scoped aggregate disclosure", detail: "Current organization authority and a separately held current project-organizer profile reviewed the exact sections and fixed deadline.", linkId: id, consentId, projectActorId: project.session.actorId, projectMembershipVersion: project.membershipVersion });
    await appendEvent(tx, project.session, "organization.disclosure_approved", "Project aggregates were shared with an organization", "The original dual-authority consent fixes its sections and deadline. It grants no private source or payment authority.");
    await assertOrganizationProjectCurrent(tx, request, project);
    if (Date.parse(input.proposal.expiresAt) <= (await orgNow(tx)).getTime()) throw new DomainError("ORG_LINK_EXPIRED", "The proposed disclosure deadline passed while this decision waited.", 410);
    return { resourceId: id, resourceVersion: input.expectedLinkVersion + 1, message: "The exact aggregate disclosure is active until its original fixed deadline." };
  });
  return { receipt };
}
export async function withdrawOrganizationProjectLink(request: OrganizationRequest, id: string, raw: unknown) {
  const input = orgLinkWithdrawSchema.parse(raw);
  const withdraw = async (tx: OrgTx, row: OrgLinkRow, identity: OrgIdentity | null, project?: OrganizationProjectAuthority) => {
    if (row.version !== input.expectedVersion || row.state === "withdrawn") throw new DomainError("ORG_VERSION_CHANGED", "This disclosure changed. Refresh it before deciding again.", 409);
    await tx.query("UPDATE fp_org_project_links SET state='withdrawn',withdrawn_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1", [id]);
    await organizationAudit(tx, row.organization_id, "organization.project_disclosure_withdrawn", identity,
      { title: "Project aggregate disclosure was withdrawn", detail: input.reason, linkId: id, retainedProjectRules: true },
      project ? { origin: "project_session", sessionId: project.session.id, membershipVersion: project.membershipVersion, role: "organizer" } : undefined);
    if (project) await appendEvent(tx, project.session, "organization.disclosure_withdrawn", "Organization disclosure was withdrawn", "Project-owned adopted rules, original credentials, fixed deadlines and financial history remain unchanged.");
    return { resourceId: id, resourceVersion: row.version + 1, message: "Aggregate disclosure ended. Original project rules and financial history remain retained." };
  };
  if (input.authority === "organization") return { receipt: await organizationCommand(request, input, "withdraw_project", ["owner", "coordinator"], async (tx, identity) => withdraw(tx, await organizationLinkById(tx, id, identity.organization.id, true), identity), { linkId: id }) };
  return organizationTransaction(async tx => {
    const project = await requireOrganizationProject(tx, request, input.expectedProjectScope, true), actorKey = `project:${project.session.id}`, original = { input, linkId: id };
    const saved = await findOrgCommand(tx, actorKey, input.intentId, "withdraw_project", original);
    if (saved) return { receipt: saved.result };
    const row = await organizationLinkById(tx, id, undefined, true);
    if (row.tenant_id !== project.session.tenantId || row.project_id !== project.session.projectId) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This disclosure is outside the current independent project.", 404);
    const result = await withdraw(tx, row, null, project);
    await assertOrganizationProjectCurrent(tx, request, project);
    return { receipt: await saveOrgCommand(tx, actorKey, input, "withdraw_project", original, result, { organizationId: row.organization_id }) };
  });
}
