import { canonicalJson, sha256 } from "@fracture/paypal-core";
import { PROCUREMENT_VERSION, supplierDraftSchema, quoteDraftSchema } from "../procurement/contracts";
import { procurementBasisHash } from "../procurement/state";
import { LIFECYCLE_VERSION } from "../lifecycle/contracts";
import { lifecycleEventKey, lifecycleEventFactSchema } from "../lifecycle/inbox";
import { lifecycleDefinitionHash } from "../lifecycle/schedule";
import type { LifecycleScheduleProposal } from "../lifecycle/contracts";
import type { LifecycleContent, LifecycleSnapshot } from "../lifecycle/contracts";
import { verifyLifecycleDraft, verifyLifecycleSnapshot } from "../lifecycle/inbox";
import { canonical, hash, requireOperation, type Row } from "./contracts";
import { findOriginal, keyHash, timestampMicros, type OriginalRows } from "./lineage";

const items = (rows: OriginalRows, table: string): Row[] => rows.get(table) ?? [];
const sameInstant = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && timestampMicros(a) === timestampMicros(b);
const noLater = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && timestampMicros(a) <= timestampMicros(b);
function historicMember(rows: OriginalRows, scope: Row, actor: unknown, version: unknown): Row {
  const member = findOriginal(rows, "fp_memberships", { tenant_id: scope.tenant_id, project_id: scope.project_id, actor_id: actor });
  requireOperation(Number.isSafeInteger(version) && Number(version) > 0 && Number(version) <= Number(member.version), "PRIVATE_LINEAGE", "A historical member version is outside the preserved original identity history.");
  return member;
}
function historicSession(rows: OriginalRows, scope: Row, id: unknown, actor: unknown): Row {
  // Core session role and membership eligibility are mutable. They are never
  // substituted for the recorded immutable role/version of a past decision.
  return findOriginal(rows, "fp_sessions", { id, tenant_id: scope.tenant_id, project_id: scope.project_id, actor_id: actor });
}
function dense(versions: readonly unknown[], maximum: unknown, first = 1): void {
  requireOperation(Number.isSafeInteger(maximum) && Number(maximum) >= first - 1 && versions.length === Number(maximum) - first + 1 && versions.map(Number).sort((a,b) => a-b).every((value,index) => value === index + first), "PRIVATE_LINEAGE", "An original immutable version or attempt history is incomplete or duplicated.");
}
function reviewHash(review: Row): string {
  const { checkedAt: _at, reviewHash: _hash, ...stable } = review;
  return sha256(canonicalJson({ contract: LIFECYCLE_VERSION, ...stable }));
}
function scopedPackage(rows: OriginalRows, row: Row): void { findOriginal(rows, "fp_packages", { project_id: row.project_id, id: row.package_id }); }

/** Static original joins only. Wall-clock expiry, current roles/state, current
 * proof publication and a latest-head-only INSERT rule are issuance checks. */
export function assertExtensionLineage(rows: OriginalRows): void {
  for (const row of items(rows, "fp_lifecycle_preference_versions")) {
    const head = findOriginal(rows, "fp_lifecycle_preference_heads", { id: row.head_id });
    const session = historicSession(rows, head, row.session_id, head.actor_id); historicMember(rows, head, head.actor_id, row.membership_version);
    requireOperation(noLater(row.expires_at, session.expires_at) && row.recipient_binding_hash === sha256(canonicalJson({ tenantId: head.tenant_id, projectId: head.project_id, actorId: head.actor_id, role: head.role })), "PRIVATE_LINEAGE", "A personal preference exceeds its original session or recipient binding.");
  }
  for (const head of items(rows, "fp_lifecycle_preference_heads")) dense(items(rows, "fp_lifecycle_preference_versions").filter(row => row.head_id === head.id).map(row => row.version), head.version);
  for (const row of items(rows, "fp_lifecycle_inbox")) {
    const preference = findOriginal(rows, "fp_lifecycle_preference_versions", { id: row.preference_version_id });
    const head = findOriginal(rows, "fp_lifecycle_preference_heads", { id: preference.head_id, tenant_id: row.tenant_id, project_id: row.project_id, actor_id: row.actor_id, role: row.role });
    requireOperation(preference.session_id === row.session_id && preference.membership_version === row.membership_version && preference.recipient_binding_hash === row.recipient_binding_hash && sameInstant(preference.expires_at, row.expires_at), "PRIVATE_LINEAGE", "A historical inbox body crosses its exact original personal grant.");
    historicSession(rows, head, row.session_id, row.actor_id);
    dense(items(rows, "fp_lifecycle_inbox_events").filter(event => event.inbox_id === row.id).map(event => event.version), row.version, 2);
  }
  for (const row of items(rows, "fp_lifecycle_program_versions")) {
    const session = findOriginal(rows, "fp_org_sessions", { organization_id: row.organization_id, id: row.issuer_session_id, membership_id: row.issuer_membership_id });
    const member = findOriginal(rows, "fp_org_memberships", { organization_id: row.organization_id, id: row.issuer_membership_id });
    requireOperation(Number(row.issuer_membership_version) <= Number(member.version) && noLater(row.expires_at, session.expires_at) && noLater(row.expires_at, member.expires_at), "PRIVATE_LINEAGE", "A historical lifecycle program widens its original organization grant.");
  }
  for (const head of items(rows, "fp_lifecycle_program_heads")) dense(items(rows, "fp_lifecycle_program_versions").filter(row => row.organization_id === head.organization_id).map(row => row.version), head.version);
  for (const head of items(rows, "fp_lifecycle_schedules")) {
    dense(items(rows, "fp_lifecycle_schedule_versions").filter(row => row.schedule_id === head.id).map(row => row.definition_version), head.current_definition_version);
    dense(items(rows, "fp_lifecycle_schedule_events").filter(row => row.schedule_id === head.id).map(row => row.schedule_version), head.version);
  }
  for (const row of items(rows, "fp_lifecycle_schedule_versions")) {
    const program = findOriginal(rows, "fp_lifecycle_program_versions", { organization_id: row.organization_id, version: row.program_version });
    const session = findOriginal(rows, "fp_org_sessions", { organization_id: row.organization_id, id: row.issuer_session_id, membership_id: row.issuer_membership_id });
    const member = findOriginal(rows, "fp_org_memberships", { organization_id: row.organization_id, id: row.issuer_membership_id });
    requireOperation(program.state === "enabled" && Number(row.issuer_membership_version) <= Number(member.version) && noLater(row.expires_at, program.expires_at) && noLater(row.expires_at, session.expires_at) && noLater(row.expires_at, member.expires_at), "PRIVATE_LINEAGE", "An original schedule definition widens its immutable delegation deadline.");
    if (row.project_session_id !== null) { const project = findOriginal(rows, "fp_sessions", { id: row.project_session_id }); requireOperation(noLater(row.expires_at, project.expires_at), "PRIVATE_LINEAGE", "An original schedule outlives its original project session."); }
  }
  for (const row of items(rows, "fp_lifecycle_occurrences")) {
    const definition = findOriginal(rows, "fp_lifecycle_schedule_versions", { id: row.definition_id, schedule_id: row.schedule_id, definition_version: row.definition_version, organization_id: row.organization_id });
    const offset = timestampMicros(String(row.due_at)) - timestampMicros(String(definition.first_due_at));
    requireOperation(offset >= 0 && offset % (BigInt(Number(definition.interval_minutes)) * 60_000_000n) === 0n && timestampMicros(String(row.due_at)) < timestampMicros(String(definition.expires_at)) && sameInstant(row.expires_at, definition.expires_at) && row.audience === definition.audience, "PRIVATE_LINEAGE", "An occurrence left its original due grid, audience or fixed deadline.");
    dense(items(rows, "fp_lifecycle_attempts").filter(attempt => attempt.occurrence_id === row.id).map(attempt => attempt.ordinal), row.attempt_count);
    if (row.snapshot_hash !== null) findOriginal(rows, "fp_lifecycle_snapshots", { occurrence_id: row.id, snapshot_hash: row.snapshot_hash });
    if (row.content_hash !== null) findOriginal(rows, "fp_lifecycle_contents", { occurrence_id: row.id, snapshot_hash: row.snapshot_hash, content_hash: row.content_hash });
  }
  for (const [table, records] of rows) if (table.startsWith("fp_procurement_") || table === "fp_package_operations" || table === "fp_package_operation_events") for (const row of records) {
    if (row.package_id !== undefined) scopedPackage(rows, row);
    if (Array.isArray(row.package_ids)) for (const id of row.package_ids) findOriginal(rows, "fp_packages", { project_id: row.project_id, id });
    if (row.actor_session_id !== undefined) { historicSession(rows, row, row.actor_session_id, row.actor_id); historicMember(rows, row, row.actor_id, row.membership_version); requireOperation(["organizer", "volunteer"].includes(String(row.actor_role)), "PRIVATE_LINEAGE", "A historical procurement decision has an unsupported recorded role."); }
    if (row.created_session_id !== undefined) { historicSession(rows, row, row.created_session_id, row.created_by); historicMember(rows, row, row.created_by, row.created_membership_version); }
    if (row.supplier_id !== undefined) findOriginal(rows, "fp_procurement_suppliers", { id: row.supplier_id, tenant_id: row.tenant_id, project_id: row.project_id });
    if (row.quote_id !== undefined) findOriginal(rows, "fp_procurement_quotes", { id: row.quote_id, tenant_id: row.tenant_id, project_id: row.project_id });
    if (row.source_document_id !== undefined && row.source_document_id !== null) findOriginal(rows, "fp_documents", { id: row.source_document_id, tenant_id: row.tenant_id, project_id: row.project_id, purpose: "quote" });
    if (row.claim_id !== undefined) { const claim = findOriginal(rows, "fp_claims", { id: row.claim_id, tenant_id: row.tenant_id, project_id: row.project_id }); requireOperation(Number(row.claim_version) <= Number(claim.version), "PRIVATE_LINEAGE", "A historic expense points beyond its original claim history."); findOriginal(rows, "fp_claim_revisions", {claim_id: row.claim_id, version: row.claim_version}); }
    if (row.exception_id !== undefined) findOriginal(rows, "fp_procurement_exceptions", { id: row.exception_id, tenant_id: row.tenant_id, project_id: row.project_id });
  }
  for (const head of items(rows, "fp_procurement_suppliers")) {
    const versions = items(rows, "fp_procurement_supplier_versions").filter(row => row.supplier_id === head.id); dense(versions.map(row => row.version), head.version);
    requireOperation(versions.find(row => row.version === head.version)?.state === head.state, "PRIVATE_LINEAGE", "The original supplier head differs from its immutable latest version.");
  }
  for (const head of items(rows, "fp_procurement_quotes")) {
    const versions = items(rows, "fp_procurement_quote_versions").filter(row => row.quote_id === head.id); dense(versions.map(row => row.version), head.version);
    const latest = versions.find(row => row.version === head.version);
    requireOperation(latest?.state === head.state && latest?.supplier_id === head.supplier_id, "PRIVATE_LINEAGE", "The original quote head differs from its immutable latest version.");
  }
  for (const head of items(rows, "fp_package_operations")) {
    const history = items(rows, "fp_package_operation_events").filter(row => row.tenant_id === head.tenant_id && row.project_id === head.project_id && row.package_id === head.package_id); dense(history.map(row => row.version), head.version);
    const latest = history.find(row => row.version === head.version);
    requireOperation(Number(head.version) === 0 || latest?.cycle === head.cycle, "PRIVATE_LINEAGE", "The original operational head has no exact final-cycle history.");
    requireOperation(history.every(row => Number(row.cycle) <= Number(head.cycle)), "PRIVATE_LINEAGE", "An immutable operational event points beyond the original final cycle.");
  }
  for (const head of items(rows, "fp_procurement_exceptions")) {
    const history = items(rows,"fp_procurement_exception_events").filter(event => event.exception_id === head.id);
    dense(history.map(event => event.version),head.version);
    requireOperation(history.find(event => event.version === head.version)?.kind === (head.state === "resolved" ? "resolved" : "opened"), "PRIVATE_LINEAGE", "The original exception state lost its exact immutable resolution history.");
  }
  for (const row of items(rows, "fp_procurement_access_audit")) findOriginal(rows,"fp_procurement_invites",{id:row.invitation_id,tenant_id:row.tenant_id,project_id:row.project_id});
  for (const row of items(rows, "fp_procurement_responsibilities")) {
    const session = historicSession(rows, row, row.responsible_session_id, row.responsible_actor_id); historicMember(rows, row, row.responsible_actor_id, row.responsible_membership_version);
    const proposer = historicSession(rows, row, row.proposed_session_id, row.proposed_by);
    requireOperation(noLater(row.expires_at, proposer.expires_at) && noLater(row.expires_at, session.expires_at), "PRIVATE_LINEAGE", "A historical responsibility widens its original recipient deadline.");
  }
  for (const row of items(rows, "fp_procurement_invites")) {
    const session = historicSession(rows, row, row.issuer_session_id, row.issuer_actor_id); historicMember(rows, row, row.issuer_actor_id, row.issuer_membership_version);
    requireOperation(sameInstant(row.issuer_session_expires_at, session.expires_at) && noLater(row.expires_at, row.issuer_session_expires_at), "PRIVATE_LINEAGE", "A historical invitation widens its original issuer deadline.");
  }
  for (const row of items(rows, "fp_procurement_access")) {
    const invitation = findOriginal(rows, "fp_procurement_invites", { id: row.invitation_id, tenant_id: row.tenant_id, project_id: row.project_id });
    const session = historicSession(rows, row, row.session_id, row.actor_id); historicMember(rows, row, row.actor_id, row.membership_version);
    requireOperation(row.actor_id !== invitation.issuer_actor_id && sameInstant(row.expires_at, invitation.expires_at) && sameInstant(row.expires_at, session.expires_at), "PRIVATE_LINEAGE", "Original independent volunteer access does not match its fixed invitation/session grant.");
  }
  for (const row of items(rows, "fp_recognition_consents")) {
    const session = historicSession(rows, row, row.session_id, row.actor_id); historicMember(rows, row, row.actor_id, row.membership_version);
    const proof = findOriginal(rows, "fp_proof_snapshots", { id: row.proof_snapshot_id, tenant_id: row.tenant_id, project_id: row.project_id, content_hash: row.proof_hash });
    findOriginal(rows, "fp_proof_heads", { tenant_id: row.tenant_id, project_id: row.project_id, package_id: proof.package_id, slug: row.slug });
    requireOperation(session.token_hash === row.session_hash && sameInstant(session.expires_at, row.session_expires_at), "PRIVATE_LINEAGE", "Historical public consent no longer binds its original token and deadline.");
    const table = ({ supporter: "fp_supporter_access", reviewer: "fp_reviewer_invites", procurement: "fp_procurement_access" } as Record<string, string>)[String(row.entry_kind)];
    requireOperation(!!table && (row.entry_kind === "supporter" ? row.role === "donor" : row.role === "volunteer"), "PRIVATE_LINEAGE", "A public consent has an unsupported original independent-entry role.");
    const entry = findOriginal(rows, table, { id: row.entry_id, tenant_id: row.tenant_id, project_id: row.project_id, actor_id: row.actor_id, session_id: row.session_id });
    requireOperation(sameInstant(entry.expires_at, row.entry_expires_at) && noLater(row.expires_at, entry.expires_at) && noLater(row.expires_at, session.expires_at), "PRIVATE_LINEAGE", "A historical recognition decision widens its original independent-entry expiry.");
  }
  for (const row of items(rows, "fp_recognition_commands")) {
    const session = historicSession(rows, row, row.session_id, row.actor_id);
    requireOperation(session.token_hash === row.session_hash, "PRIVATE_LINEAGE", "A historical recognition command no longer binds its original session token.");
  }
  for (const head of items(rows, "fp_recognition_heads")) {
    const audits = items(rows, "fp_recognition_audit").filter(row => row.head_id === head.id), commands = audits.map(audit => findOriginal(rows, "fp_recognition_commands", { id: audit.command_id, tenant_id: head.tenant_id, project_id: head.project_id }));
    dense(commands.map(command => (command.receipt as Row)?.version), head.version);
    const latest = commands.find(command => (command.receipt as Row)?.version === head.version);
    requireOperation(latest && ({ consent: "consented", withdraw: "withdrawn", suppress: "suppressed" } as Record<string, unknown>)[String(latest.action)] === head.state, "PRIVATE_LINEAGE", "The original public recognition head has incomplete immutable decision history.");
  }
}

/** Validates authenticated payload facts after the codec pass. It checks the
 * original private version, not a new eligibility calculation. */
export function assertExtensionPrivateLineage(rows: OriginalRows, decoded: Map<string, unknown>): void {
  const value = (table: string, row: Row, column = "encrypted_data") => decoded.get(`${keyHash(table,row)}:${column}`) as Row;
  for (const row of items(rows,"fp_lifecycle_preference_versions")) {
    const grant = value("fp_lifecycle_preference_versions",row,"encrypted_grant"), head = findOriginal(rows,"fp_lifecycle_preference_heads",{id:row.head_id}), session = historicSession(rows,head,row.session_id,head.actor_id);
    requireOperation(grant && sha256(canonicalJson(grant)) === row.content_hash && grant.sessionId === row.session_id && grant.tenantId === head.tenant_id && grant.projectId === head.project_id && grant.actorId === head.actor_id && grant.role === head.role && grant.membershipVersion === row.membership_version && sameInstant(grant.expiresAt,row.expires_at) && typeof grant.projectToken === "string" && hash(grant.projectToken) === session.token_hash, "PRIVATE_LINEAGE", "An original personal opt-in grant left its exact encrypted recipient, credential or deadline binding.");
  }
  for (const row of items(rows,"fp_lifecycle_program_versions")) {
    const grant = value("fp_lifecycle_program_versions",row,"encrypted_grant"), request = grant?.request as Row, session = findOriginal(rows,"fp_org_sessions",{id:row.issuer_session_id,organization_id:row.organization_id,membership_id:row.issuer_membership_id});
    requireOperation(grant && sha256(canonicalJson(grant)) === row.content_hash && grant.originalSessionId === row.issuer_session_id && grant.originalMembershipId === row.issuer_membership_id && grant.originalMembershipVersion === row.issuer_membership_version && grant.originalRole === row.issuer_role && sameInstant(grant.expiresAt,row.expires_at) && typeof request?.organizationToken === "string" && hash(request.organizationToken) === session.token_hash, "PRIVATE_LINEAGE", "An original lifecycle program left its exact encrypted organization credential and deadline.");
  }
  for (const row of items(rows,"fp_lifecycle_schedule_versions")) {
    const grant = value("fp_lifecycle_schedule_versions",row), request = grant?.request as Row, review = grant?.review as Row, input = review?.input as Row, proposal = input?.proposal as Row, cadence = proposal?.cadence as Row, authorization = review?.authorization as Row;
    const session = findOriginal(rows,"fp_org_sessions",{id:row.issuer_session_id,organization_id:row.organization_id,membership_id:row.issuer_membership_id});
    requireOperation(grant && grant.organizationSessionId === row.issuer_session_id && grant.organizationMembershipId === row.issuer_membership_id && grant.projectSessionId === row.project_session_id && typeof request?.organizationToken === "string" && hash(request.organizationToken) === session.token_hash && review?.reviewHash === row.review_hash && reviewHash(review) === row.review_hash && authorization?.organizationMembershipVersion === row.issuer_membership_version && authorization?.organizationRole === row.issuer_role && lifecycleDefinitionHash(proposal as unknown as LifecycleScheduleProposal) === row.definition_hash && (proposal?.target as Row)?.kind === row.audience && sameInstant(cadence?.firstDueAt,row.first_due_at) && cadence?.intervalMinutes === row.interval_minutes && sameInstant(authorization?.expiresAt,row.expires_at) && authorization?.programVersion === row.program_version && sha256(canonicalJson({...grant,bindingHash:""})) === grant.bindingHash, "PRIVATE_LINEAGE", "An original schedule left its encrypted reviewed definition, credential, cadence or deadline.");
    if (row.project_session_id !== null) { const project = findOriginal(rows,"fp_sessions",{id:row.project_session_id}); requireOperation(typeof request?.projectToken === "string" && hash(request.projectToken) === project.token_hash, "PRIVATE_LINEAGE", "An original schedule lost its exact original project credential."); }
    const target = proposal.target as Row, links = target.kind === "project_treasurer" ? [target.link] : target.links;
    requireOperation(Array.isArray(links) && links.length>0, "PRIVATE_LINEAGE", "The original schedule lost its immutable disclosed source set.");
    for (const pin of links as Row[]) {
      const link = findOriginal(rows,"fp_org_project_links",{id:pin.linkId,organization_id:row.organization_id});
      const consent = findOriginal(rows,"fp_org_project_consents",{link_id:pin.linkId,revision:pin.consentRevision,content_hash:pin.consentHash,organization_id:row.organization_id});
      requireOperation(Number(pin.linkVersion)<=Number(link.version) && sameInstant(pin.expiresAt,consent.expires_at) && noLater(row.expires_at,consent.expires_at), "PRIVATE_LINEAGE", "An original delegation source pin lost its exact original consent version or deadline.");
    }
  }
  for (const row of items(rows,"fp_lifecycle_snapshots")) {
    const saved = value("fp_lifecycle_snapshots",row), snapshot = verifyLifecycleSnapshot(saved?.snapshot as LifecycleSnapshot);
    requireOperation(snapshot.snapshotHash===row.snapshot_hash && snapshot.basisHash===row.basis_hash && sameInstant(snapshot.asOf,row.captured_at), "PRIVATE_LINEAGE", "An original scheduled snapshot left its frozen hash, basis or actual capture cutoff.");
  }
  for (const row of items(rows,"fp_lifecycle_contents")) {
    const capture = findOriginal(rows,"fp_lifecycle_snapshots",{id:row.snapshot_id,occurrence_id:row.occurrence_id,snapshot_hash:row.snapshot_hash});
    const snapshot = value("fp_lifecycle_snapshots",capture)?.snapshot as LifecycleSnapshot, content = verifyLifecycleDraft(value("fp_lifecycle_contents",row) as unknown as LifecycleContent,snapshot);
    requireOperation(content.contentHash===row.content_hash && content.sourceHash===row.snapshot_hash && content.origin===row.origin, "PRIVATE_LINEAGE", "An original scheduled content version left its immutable captured source.");
  }
  for (const row of items(rows,"fp_lifecycle_inbox")) {
    const saved = value("fp_lifecycle_inbox",row), snapshot = verifyLifecycleSnapshot(saved?.snapshot as LifecycleSnapshot), content = verifyLifecycleDraft(saved?.content as LifecycleContent,snapshot), fact = (saved?.source as Row)?.fact as Row;
    requireOperation(saved?.contractVersion===LIFECYCLE_VERSION && saved.kind===fact?.kind && saved.eventKey===row.event_key && lifecycleEventKey(lifecycleEventFactSchema.parse(fact))===row.event_key && snapshot.snapshotHash===row.snapshot_hash && sameInstant(snapshot.asOf,row.captured_at) && content.contentHash===row.content_hash && fact?.sourceHash===row.source_hash && fact?.recipientBindingHash===row.recipient_binding_hash && fact?.role===row.role && (fact?.project as Row)?.id===row.project_id && sameInstant(fact?.effectiveAt,row.occurred_at), "PRIVATE_LINEAGE", "An original personal inbox lost its exact recipient, source version or captured body.");
    const source = saved.source as Row, descriptor = source.descriptor as Row;
    const table = ({ purpose_saved:"fp_purpose_pledges",purpose_withdrawn:"fp_funding_actions",purpose_expired:"fp_purpose_pledges",conditional_saved:"fp_conditional_consents",conditional_withdrawn:"fp_conditional_consents",conditional_expired:"fp_conditional_consents",receipt:"fp_settlement_receipts",refund_pending:"fp_refunds",refund_completed:"fp_refunds",sample_return:"fp_funding_choices",assignment:"fp_funding_assignments",external_return:"fp_funding_external_returns",cancellation:"fp_funding_cases",round_cancellation:"fp_collection_rounds",purpose_closed:"fp_funding_actions",payout_dispatch:"fp_payables",payout_observation:"fp_payout_observations" } as Record<string,string>)[String(descriptor?.type)];
    requireOperation(source.version==="personal-source-v1" && !!table, "PRIVATE_LINEAGE", "An original personal source family is unsupported.");
    let original: Row;
    if(table==="fp_funding_actions") original=findOriginal(rows,table,{tenant_id:row.tenant_id,project_id:row.project_id,intent_id:descriptor.id,...(descriptor.type==="purpose_withdrawn"?{actor_id:row.actor_id}:{})});
    else if(table==="fp_payout_observations") { const observation=findOriginal(rows,table,{id:descriptor.id}); original=findOriginal(rows,"fp_payables",{id:observation.payable_id,tenant_id:row.tenant_id,project_id:row.project_id}); }
    else original=findOriginal(rows,table,{id:descriptor.id,tenant_id:row.tenant_id,project_id:row.project_id});
    if(table==="fp_conditional_consents") requireOperation(original.actor_id===row.actor_id,"PRIVATE_LINEAGE","A captured pledge crosses its original recipient.");
    if(["fp_purpose_pledges","fp_funding_choices"].includes(table)) requireOperation(original.donor_actor_id===row.actor_id,"PRIVATE_LINEAGE","A captured choice crosses its original donor.");
    if(table==="fp_settlement_receipts") findOriginal(rows,"fp_obligations",{id:original.obligation_id,tenant_id:row.tenant_id,project_id:row.project_id,actor_id:row.actor_id});
    if(table==="fp_payables" || table==="fp_payout_observations") findOriginal(rows,"fp_claims",{id:original.claim_id,tenant_id:row.tenant_id,project_id:row.project_id,actor_id:row.actor_id});
    if(table==="fp_refunds" || table==="fp_funding_external_returns") { const receipt=findOriginal(rows,"fp_settlement_receipts",{id:original.receipt_id,tenant_id:row.tenant_id,project_id:row.project_id}); findOriginal(rows,"fp_obligations",{id:receipt.obligation_id,actor_id:row.actor_id}); }
    if(source.document) { const pin=source.document as Row, document=findOriginal(rows,"fp_documents",{id:pin.id,tenant_id:row.tenant_id,project_id:row.project_id}); requireOperation(pin.hash===document.sha256 && Number(pin.version)<=Number(document.version),"PRIVATE_LINEAGE","A personal source lost its original private document hash or version."); }
    const preview = saved?.emailPreview as Row | null;
    requireOperation(!preview || preview.destination===null && preview.sent===false, "PRIVATE_LINEAGE", "An original lifecycle preview cannot be converted into a delivery or recipient address.");
  }
  for (const table of ["fp_procurement_supplier_versions", "fp_procurement_quote_versions", "fp_package_operations", "fp_package_operation_events", "fp_procurement_selections", "fp_procurement_progress", "fp_procurement_expense_links", "fp_procurement_reviews"]) for (const row of items(rows,table)) {
    const payload = value(table,row); requireOperation(payload && sha256(canonicalJson(payload)) === row.content_hash, "PRIVATE_LINEAGE", "An immutable procurement private payload differs from its original content hash.");
    if (table === "fp_procurement_supplier_versions") { supplierDraftSchema.parse(payload.draft); requireOperation(payload.contractVersion===PROCUREMENT_VERSION && payload.supplierId === row.supplier_id && payload.version === row.version && payload.state === row.state, "PRIVATE_LINEAGE", "A supplier payload left its exact original version."); }
    if (table === "fp_procurement_quote_versions") { quoteDraftSchema.parse(payload.draft); const draft = payload.draft as Row, binding = payload.sourceBinding as Row | null; requireOperation(payload.contractVersion===PROCUREMENT_VERSION && payload.quoteId === row.quote_id && payload.version === row.version && payload.state === row.state && draft?.supplierId === row.supplier_id && draft?.supplierVersion === row.supplier_version && (binding?.documentId ?? null) === row.source_document_id && (binding?.documentVersion ?? null) === row.source_document_version && (binding?.contentHash ?? null) === row.source_hash && (binding?.controlVersion ?? null) === row.source_control_version, "PRIVATE_LINEAGE", "A quote private payload left its original supplier or captured source version.");
      if(binding) { const document=findOriginal(rows,"fp_documents",{id:row.source_document_id,tenant_id:row.tenant_id,project_id:row.project_id,purpose:"quote"}), control=findOriginal(rows,"fp_plan_source_controls",{document_id:document.id,tenant_id:row.tenant_id,project_id:row.project_id}); requireOperation(binding.contentHash===document.sha256 && Number(binding.documentVersion)<=Number(document.version) && Number(binding.controlVersion)<=Number(control.version),"PRIVATE_LINEAGE","A quote lost its original private document/hash/control history."); }
    }
    if (table === "fp_package_operations") requireOperation(payload.packageId === row.package_id && payload.version === row.version && payload.cycle === row.cycle && payload.state === row.state && payload.blockedFrom === row.blocked_from && sameInstant(payload.cycleStartedAt, row.cycle_started_at), "PRIVATE_LINEAGE", "The final operational payload differs from its original current head.");
    if (table === "fp_package_operation_events") { const head = payload.head as Row; requireOperation(head?.packageId === row.package_id && head?.version === row.version && head?.cycle === row.cycle && head?.state === row.to_state && procurementBasisHash(payload.basis as Parameters<typeof procurementBasisHash>[0]) === row.basis_hash, "PRIVATE_LINEAGE", "An old operational event differs from its own immutable head snapshot."); }
  }
  for (const head of items(rows,"fp_procurement_quotes")) { const latest=findOriginal(rows,"fp_procurement_quote_versions",{quote_id:head.id,version:head.version}), payload=value("fp_procurement_quote_versions",latest); requireOperation(canonical((payload.draft as Row).packageIds)===canonical(head.package_ids),"PRIVATE_LINEAGE","The final quote package set differs from its immutable latest draft."); }
  for (const head of items(rows,"fp_package_operations")) if (Number(head.version)>0) { const event = findOriginal(rows,"fp_package_operation_events",{tenant_id:head.tenant_id,project_id:head.project_id,package_id:head.package_id,version:head.version}); requireOperation(canonical(value("fp_package_operation_events",event)?.head) === canonical(value("fp_package_operations",head)), "PRIVATE_LINEAGE", "The complete operation history does not end at the preserved original head."); }
  for (const row of items(rows,"fp_procurement_invites")) if (row.encrypted_token !== null) { const token=value("fp_procurement_invites",row,"encrypted_token") as unknown; requireOperation(typeof token==="string" && hash(token) === row.token_hash, "PRIVATE_LINEAGE", "An original invitation token no longer matches its private hash."); }
  for (const row of items(rows,"fp_procurement_access")) {
    const session=historicSession(rows,row,row.session_id,row.actor_id), token=value("fp_procurement_access",row,"encrypted_session_token") as unknown, back=value("fp_procurement_access",row,"encrypted_return_token") as unknown, acceptance=value("fp_procurement_access",row,"encrypted_acceptance"), input=acceptance?.input as Row;
    requireOperation(typeof token==="string" && hash(token)===session.token_hash && typeof back==="string" && hash(back)===row.return_token_hash && input?.intentId===row.acceptance_intent_id && sha256(canonicalJson(input))===row.acceptance_hash, "PRIVATE_LINEAGE", "Restored independent access lost its original token, accepted input or immutable retry hash.");
    const invite=findOriginal(rows,"fp_procurement_invites",{id:row.invitation_id}); requireOperation(typeof input.token==="string" && hash(input.token)===invite.token_hash, "PRIVATE_LINEAGE", "The original acceptance input no longer binds its original invitation token.");
  }
  for(const table of ["fp_procurement_commands","fp_procurement_entry_commands"]) for(const row of items(rows,table)) { const input=value(table,row,"encrypted_input"), result=row.result as Row; requireOperation(input && sha256(canonicalJson(input))===row.input_hash && input.intentId===row.intent_id && result?.intentId===row.intent_id && result?.kind===row.kind,"PRIVATE_LINEAGE","An original procurement command lost its exact saved input or retry receipt."); }
  for (const row of items(rows,"fp_recognition_commands")) {
    const input = value("fp_recognition_commands",row,"encrypted_input"), receipt = row.receipt as Row;
    requireOperation(input && sha256(canonicalJson(input)) === row.input_hash && input.intentId === row.intent_id && input.accessId === row.access_id && input.action === row.action && receipt.commandId === row.id && receipt.intentId === row.intent_id && receipt.action === row.action, "PRIVATE_LINEAGE", "An original recognition command or retry receipt left its authenticated private input.");
    if(row.action==="suppress") {
      const handle = value("fp_recognition_commands",row,"suppression_handle"), head = findOriginal(rows,"fp_recognition_heads",{id:handle?.headId,tenant_id:row.tenant_id,project_id:row.project_id,slug:handle?.slug});
      findOriginal(rows,"fp_recognition_consents",{id:handle?.consentId,head_id:head.id});
      requireOperation(handle?.accessId===row.access_id && Number(handle?.version)+1===receipt.version && Number(handle.version)<=Number(head.version), "PRIVATE_LINEAGE", "A historical suppression handle left its exact original public decision and moderator credential.");
    }
  }
  for(const command of items(rows,"fp_recognition_commands")) requireOperation(items(rows,"fp_recognition_audit").filter(audit=>audit.command_id===command.id).length===1,"PRIVATE_LINEAGE","An immutable public decision has missing or duplicate audit lineage.");
  for (const row of items(rows,"fp_recognition_audit")) {
    const payload = value("fp_recognition_audit",row), command = findOriginal(rows,"fp_recognition_commands",{id:row.command_id}), session = historicSession(rows,command,command.session_id,command.actor_id);
    historicMember(rows,command,command.actor_id,payload?.membershipVersion);
    const head=findOriginal(rows,"fp_recognition_heads",{id:row.head_id,tenant_id:command.tenant_id,project_id:command.project_id});
    requireOperation(command.action==="suppress" || (head.actor_id===command.actor_id && head.role===command.role),"PRIVATE_LINEAGE","A participant command crosses the original consenting actor or recorded role.");
    if(command.action==="consent") { const consent=findOriginal(rows,"fp_recognition_consents",{head_id:head.id,version:(command.receipt as Row).version}), input=value("fp_recognition_commands",command,"encrypted_input"), label=value("fp_recognition_consents",consent); requireOperation(input.reviewKey===consent.review_key && input.slug===consent.slug && input.label===label.label && label.publicVisibilityAcknowledged===true && label.selfDeclaredAcknowledged===true,"PRIVATE_LINEAGE","The original public consent lost its exact acknowledged label or source decision."); }
    requireOperation(row.kind===command.action && payload?.actorId === command.actor_id && payload?.sessionId === command.session_id && payload?.accessId === command.access_id && sameInstant(payload?.originalSessionExpiresAt,session.expires_at), "PRIVATE_LINEAGE", "An original recognition audit left its preserved actor, original role/version credential or deadline.");
  }
}
