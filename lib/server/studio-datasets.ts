import { randomUUID } from "node:crypto";
import { canonicalJson, sha256, type SqlConnection, type SqlDatabase } from "@fracture/paypal-core";
import type { EvidenceItem, PackageView, SettlementReceipt, WorkspaceRole } from "../contracts";
import { assertMinor, DomainError } from "../domain/money";
import { packagePositionTotals } from "../domain/funding-positions";
import { assessPackageFunding } from "../domain/package-funding";
import { STUDIO_FIELDS, STUDIO_POSITION_VERSION, STUDIO_SEMANTIC_VERSION, STUDIO_TABLES, type FundingPositionRow, type AllocationRow, type EvidenceRow, type ExceptionRow, type PackageRow, type SettlementRow, type StudioData, type StudioSnapshot } from "../studio/contracts";
import type { Session } from "./auth";
import { claimPrivate, type ClaimRow } from "./claims";
import { database, query } from "./db";
import { requireCurrentRole } from "./membership";
import { readFundingProjection } from "./funding-positions";
import { openPrivate, sealPrivate } from "./private-values";
import { publishedPlan } from "./planning-store";
import { alignmentViews, packageReadiness, signoffViews } from "./planning-evidence";
import { polygonLabel } from "../planning/geometry";
import { readFundingPromises } from "./funding-promises";

const SOURCE_NOTICE = "The plan is an illustrative sample. Expense review does not certify installed work or safety.";
const FUNDING_NOTICE = "Collection includes conditional Orders and invoice receipts. Separate checkout tests and duplicate excess cannot fund a package.";
const ROLES: WorkspaceRole[] = ["donor", "volunteer", "organizer", "auditor"];
const snapshotContext = (scope: string, id: string) => `studio-snapshot:${scope}:${id}`;
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
const amount = (value: number | string) => { const result = Number(value); assertMinor(result); return result; };
const studioContentHash = (snapshot: Pick<StudioSnapshot, "scope" | "asOf" | "data" | "geometry" | "geometrySource">) => sha256(canonicalJson({
  scope: snapshot.scope, asOf: snapshot.asOf, data: snapshot.data, geometry: snapshot.geometry,
  ...(snapshot.geometrySource ? { geometrySource: snapshot.geometrySource } : {}),
}));
export const studioScope = (session: Session, membershipVersion: number) => sha256(canonicalJson({ tenant: session.tenantId, project: session.projectId, actor: session.actorId, role: session.role, membershipVersion, semanticVersion: STUDIO_SEMANTIC_VERSION }));

interface PackageSource { id: string; version: number; budget_minor: string; data: PackageView; }
interface ReceiptSource { id: string; actor_id: string; purpose: string; data: SettlementReceipt; }
interface ReviewSource {
  claim_id: string; claim_line_id: string; package_id: string | null; source_minor: string; approved_minor: string;
  decision: string; review_version: number; claim_version: number; actor_id: string; claim_state: string;
  document_id: string; document_state: string; provenance: string; reviewed_at: Date | null;
}
interface AllocationSource {
  id: string; allocation_id: string; revision: number; current_revision: number; current_state: string;
  receipt_id: string; package_id: string; purpose: string; amount_minor: string; state: string;
  reversal_of: string | null; claim_id: string; claim_line_id: string; document_id: string;
  source_kind: string; provenance: AllocationRow["provenance"]; kind: string;
}
interface WorkSource { data: EvidenceItem; }
interface PendingSource { id: string; package_id: string; state: string; amount_minor: string; observed_at: Date | null; operation_id: string | null; category: string; }

/** Fixed field allowlists are the serialization boundary. Hidden Studio columns are never access control. */
export function assertStudioProjection(data: StudioData): void {
  for (const table of STUDIO_TABLES) {
    const allowed = new Set(STUDIO_FIELDS[table].map(field => field.id));
    const ids = new Set<string>();
    for (const row of data[table] ?? []) {
      if (!row.id || ids.has(row.id)) throw new DomainError("STUDIO_IDENTITY_INVALID", "The report contains a repeated record identity.", 409);
      ids.add(row.id);
      if (Object.keys(row).some(key => !allowed.has(key))) throw new DomainError("STUDIO_FIELD_DENIED", "A report field is outside the permitted semantic model.", 403);
      for (const [key, value] of Object.entries(row)) {
        if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new DomainError("STUDIO_VALUE_INVALID", "The report contains an unsupported value.", 409);
        if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) throw new DomainError("STUDIO_AMOUNT_INVALID", "Report amounts and counts must be nonnegative safe integers.", 409);
        if (typeof value === "string" && value.length > (key === "detail" ? 1500 : 400)) throw new DomainError("STUDIO_TEXT_LIMIT", "A report field needs a shorter reviewed description.", 409);
      }
    }
  }
}

function safeZone(pkg: PackageSource): PackageView["zone"] {
  const source = pkg.data.zone;
  if (!source || source.packageId !== pkg.id || !Array.isArray(source.points) || source.points.length < 3 || source.points.length > 64)
    throw new DomainError("STUDIO_GEOMETRY_INVALID", "The plan geometry needs a review before this report can load.", 409);
  const point = (value: { x: number; y: number }) => {
    if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y) || value.x < 0 || value.x > 1 || value.y < 0 || value.y > 1)
      throw new DomainError("STUDIO_GEOMETRY_INVALID", "The plan contains an invalid coordinate.", 409);
    return { x: value.x, y: value.y };
  };
  return { packageId: pkg.id, points: source.points.map(point), label: point(source.label) };
}

/** The entire input is read from one PostgreSQL snapshot, with authority checked inside it. No writes or provider reads occur here. */
export async function readStudioSnapshot(session: Session, target: SqlDatabase = database()): Promise<StudioSnapshot> {
  if (!ROLES.includes(session.role)) throw new DomainError("ROLE_DENIED", "Choose an available project view.", 403);
  return target.transaction(async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { membershipVersion } = await requireCurrentRole(session, session.role, tx);
    const [project] = await query<{ title: string; projection_version: number; mode: Session["mode"]; as_of: Date; cursor: string }>(
      `SELECT p.metadata->>'subtitle' AS title,p.projection_version,t.mode,transaction_timestamp() AS as_of,
        (SELECT COALESCE(max(sequence),0) FROM fp_events WHERE tenant_id=$1 AND project_id=$2) AS cursor
       FROM fp_projects p JOIN fp_tenants t ON t.id=p.tenant_id WHERE p.tenant_id=$1 AND p.id=$2`, [session.tenantId, session.projectId], tx);
    if (!project || project.mode !== session.mode) throw new DomainError("PROJECT_NOT_FOUND", "This report is not available in your current workspace.", 404);
    const scope = studioScope(session, membershipVersion), cutoff = project.as_of.getTime();
    const broad = ["organizer", "auditor"].includes(session.role), privateClaims = ["organizer", "volunteer"].includes(session.role);
    const params = [session.tenantId, session.projectId];
    // Queries share this transaction/connection; the PostgreSQL driver serializes them.
    const packages = await query<PackageSource>("SELECT id,version,budget_minor,data FROM fp_packages WHERE project_id=$1 ORDER BY id", [session.projectId], tx);
    const promises=await readFundingPromises(session,tx,cutoff);
    const receipts = await query<ReceiptSource>(`SELECT r.id,o.actor_id,o.purpose,r.data FROM fp_settlement_receipts r
      JOIN fp_obligations o ON o.id=r.obligation_id AND o.tenant_id=r.tenant_id AND o.project_id=r.project_id
      WHERE r.tenant_id=$1 AND r.project_id=$2 ORDER BY r.id`, params, tx);
    const reviews = await query<ReviewSource>(`SELECT l.claim_id,l.claim_line_id,l.package_id,l.source_minor,l.approved_minor,l.decision,
      l.review_version,c.version AS claim_version,c.actor_id,c.state AS claim_state,c.document_id,c.reviewed_at,d.state AS document_state,d.provenance
      FROM fp_claim_line_reviews l JOIN fp_claims c ON c.id=l.claim_id JOIN fp_documents d ON d.id=c.document_id
      WHERE c.tenant_id=$1 AND c.project_id=$2 AND l.review_version=c.version ORDER BY l.claim_id,l.claim_line_id`, params, tx);
    const work = await query<WorkSource>("SELECT data FROM fp_evidence WHERE tenant_id=$1 AND project_id=$2 ORDER BY id", params, tx);
    const funding=await readFundingProjection({tenantId:session.tenantId,projectId:session.projectId,provenance:session.mode},tx);
    const delivered = await query<{ package_id: string; paid: string }>(`SELECT l.package_id,sum(l.amount_minor) AS paid FROM fp_payable_lines l JOIN fp_payables p ON p.id=l.payable_id
      WHERE p.tenant_id=$1 AND p.project_id=$2 AND p.principal_paid_at IS NOT NULL AND p.principal_returned_at IS NULL GROUP BY l.package_id`, params, tx);
    const rounds = await query<{ id: string; package_id: string; package_version: number; state: string; recovery_ends_at: Date }>(
      "SELECT id,package_id,package_version,state,recovery_ends_at FROM fp_collection_rounds WHERE tenant_id=$1 AND project_id=$2 ORDER BY collection_started_at DESC", params, tx);
    const plan = await publishedPlan(session, tx);
    const photoReviews = plan ? await alignmentViews(session, tx, true) : [];
    const workReviews = plan ? await signoffViews(session, tx, true) : [];
    const readiness = plan ? packageReadiness(plan.payload, plan.view.state === "current", photoReviews, workReviews, []) : [];
    const packageRows: PackageRow[] = packages.map(pkg => {
      const positions=funding.positions.filter(row=>row.packageId===pkg.id);
      const total = packagePositionTotals(positions,pkg.id,amount(pkg.budget_minor));
      const allocated = positions.reduce((sum,row)=>sum+row.reservedMinor+row.paidMinor,0);
      const round = rounds.find(row => row.package_id === pkg.id && row.package_version === pkg.version) ?? rounds.find(row => row.package_id === pkg.id);
      const currentReviews = reviews.filter(row => row.package_id === pkg.id && row.decision === "approved");
      const physicallyAccepted = work.filter(row => row.data.state === "accepted" && row.data.packageIds.includes(pkg.id) && ["photo", "signoff"].includes(row.data.kind)).length;
      const reviewedWork = readiness.find(item => item.packageId === pkg.id);
      // A complete collection does not imply a funded round or permission to spend.
      const fundingPolicy=assessPackageFunding({state:pkg.data.fundingState,version:pkg.version,budgetMinor:amount(pkg.budget_minor),eligibleMinor:total.fundingEligibleMinor,provenance:project.mode,round:round?{packageVersion:round.package_version,state:round.state}:undefined});
      const allocatable = fundingPolicy.complete;
      return { id: pkg.id, packageId: pkg.id, title: pkg.data.title, shortTitle: pkg.data.shortTitle,
        budgetMinor: amount(pkg.budget_minor), pledgedMinor: promises.get(pkg.id)??0,
        ...total, completedRefundMinor: positions.reduce((sum, row) => sum + row.refundedMinor, 0),
        allocationReservedMinor: allocated, availableAllocationMinor: allocatable ? Math.max(0, total.fundingEligibleMinor - allocated) : 0,
        approvedExpenseMinor: currentReviews.reduce((sum, row) => sum + amount(row.approved_minor), 0),
        paidExpenseMinor: amount(delivered.find(row => row.package_id === pkg.id)?.paid ?? 0),
        reviewedItemCount: reviewedWork?.acceptedCount ?? physicallyAccepted, requiredItemCount: reviewedWork?.requiredCount ?? pkg.data.evidenceRequired, reviewedExpenseLineCount: currentReviews.length,
        fundingState: fundingPolicy.state,
        workState: reviewedWork ? plan?.view.state !== "current" ? "plan_review_required" : !reviewedWork.prerequisitesMet ? "prerequisites_needed" : reviewedWork.accepted ? reviewedWork.provenance === "sample" ? "sample_review_complete" : "accepted_within_scope" : "evidence_needed" : pkg.data.workState,
        geometryRef: plan ? `${pkg.id}:${plan.view.contentHash}:${plan.view.state}` : pkg.id, provenance: project.mode };
    });
    const visibleReceipts = receipts.filter(row => broad || (session.role === "donor" && row.actor_id === session.actorId));
    const settlementRows: SettlementRow[] = visibleReceipts.map(({ data: r, purpose }) => ({
      id: r.id, packageId: r.packageId, settlementReceiptId: r.id, sourceKind: r.sourceKind, purpose,
      observedState: r.authoritativeObservedState, grossMinor: r.grossSettledMinor, creditedMinor: r.creditedMinor,
      completedRefundMinor: r.completedAttributedRefundMinor, pendingRefundMinor: r.pendingAttributedRefundReserveMinor,
      fundingEligibleMinor: purpose === "conditional_pledge" && r.provenance === project.mode ? r.creditedMinor - r.completedAttributedRefundMinor - r.pendingAttributedRefundReserveMinor - r.excludedMinor : 0,
      excludedMinor: r.excludedMinor, excessLiabilityMinor: r.excessLiabilityMinor, currency: r.currency, observedAt: r.observedAt, provenance: r.provenance,
    }));
    const visibleReceiptIds = new Set(visibleReceipts.map(row => row.id));
    const positionRows: FundingPositionRow[] = funding.positions.filter(row => visibleReceiptIds.has(row.receiptId)).map(row => ({
      id: `position:${row.receiptId}:${row.packageId}`, packageId: row.packageId, semanticVersion: STUDIO_POSITION_VERSION,
      settlementReceiptId: row.receiptId, receiptVersion: row.receiptVersion, originalPackageId: row.originalPackageId, sourceKind: row.sourceKind,
      assignedMinor: row.assignedMinor, collectedMinor: row.collectedMinor, fundingEligibleMinor: row.fundingEligibleMinor,
      refundedMinor: row.refundedMinor, pendingRefundMinor: row.pendingRefundMinor, excludedMinor: row.excludedMinor,
      reservedMinor: row.reservedMinor, paidMinor: row.paidMinor, availableMinor: row.availableMinor,
      assignmentCount: row.assignmentIds.length, provenance: project.mode,
    }));
    const visibleClaims = privateClaims ? await query<ClaimRow>(`SELECT * FROM fp_claims WHERE tenant_id=$1 AND project_id=$2 AND ($3::boolean OR actor_id=$4)`, [...params, session.role === "organizer", session.actorId], tx) : [];
    const claimData = new Map(visibleClaims.map(row => [row.id, claimPrivate(row)]));
    const allocations = await query<AllocationSource>(`SELECT v.id,v.allocation_id,v.revision,a.revision AS current_revision,a.state AS current_state,
      v.receipt_id,v.package_id,v.purpose,v.amount_minor,v.state,v.reversal_of,a.claim_id,a.claim_line_id,c.document_id,a.kind,
      r.data->>'sourceKind' AS source_kind,r.provenance FROM fp_allocation_revisions v
      JOIN fp_receipt_allocations a ON a.id=v.allocation_id JOIN fp_settlement_receipts r ON r.id=v.receipt_id
      JOIN fp_obligations o ON o.id=r.obligation_id JOIN fp_claims c ON c.id=a.claim_id
      WHERE a.tenant_id=$1 AND a.project_id=$2 AND ($3::boolean OR ($4='donor' AND o.actor_id=$5) OR ($4='volunteer' AND c.actor_id=$5)) ORDER BY v.created_at,v.id`, [...params, broad, session.role, session.actorId], tx);
    const allocationRows: AllocationRow[] = allocations.map(row => ({ id: row.id, packageId: row.package_id,
      allocationId: row.allocation_id, settlementReceiptId: row.receipt_id, sourceKind: row.source_kind,
      allocationMinor: amount(row.amount_minor), activeAllocationMinor: row.revision === row.current_revision && ["reserved", "paid"].includes(row.current_state) ? amount(row.amount_minor) : 0,
      isCurrent: row.revision === row.current_revision, revision: row.revision, state: row.state, purpose: row.kind === "fee" ? "Provider fee allowance" : "Reviewed expense",
      expenseLabel: privateClaims ? claimData.get(row.claim_id)?.lines.find(line => line.id === row.claim_line_id)?.description ?? "Reviewed expense line" : "Reviewed expense line",
      reversalOf: row.reversal_of, claimId: privateClaims ? row.claim_id : null, evidenceId: privateClaims ? row.document_id : null, provenance: row.provenance }));
    const evidenceRows: EvidenceRow[] = [];
    for (const { data: item } of work) {
      if (!(broad || item.provenance === "sample" || item.state === "accepted")) continue;
      for (const packageId of item.packageIds) {
        if (!packages.some(pkg => pkg.id === packageId)) continue;
        evidenceRows.push({ id: `work:${item.id}:${packageId}`, packageId, evidenceId: item.id,
          title: item.provenance === "sample" || session.role === "organizer" ? item.title : `${item.kind === "photo" ? "Project photograph" : item.kind === "signoff" ? "Qualified signoff" : "Project evidence"} · ${item.state.replaceAll("_", " ")}`,
          sourceClass: item.kind, reviewState: plan ? "earlier_reference" : item.state, itemCount: 1, reviewedAt: item.reviewedAt,
          sourceAvailable: false, documentId: null, claimId: null, provenance: item.provenance,
          reviewScope: plan ? "Earlier project reference. It does not satisfy the reviewed plan's current physical-evidence requirements." : item.kind === "signoff" ? "Only the recorded signoff scope, if accepted." : item.kind === "quote" ? "Proposed cost; no purchase is established." : "Only the recorded evidence decision; no automatic safety or completion claim.", amountMinor: null });
      }
    }
    for (const image of photoReviews) {
      if (!broad && image.state !== "reviewed") continue;
      evidenceRows.push({ id: `planning-photo:${image.id}`, packageId: image.packageId, evidenceId: image.id,
        title: image.sourceClass === "sample_illustration" ? "Sample image association" : "Three-landmark image association",
        sourceClass: "photo_association", reviewState: image.state, itemCount: 1, reviewedAt: image.reviewedAt,
        sourceAvailable: false, documentId: null, claimId: null, provenance: image.sourceClass === "sample_illustration" ? "sample" : "reviewer_attested",
        reviewScope: "A reviewed illustration of the relationship between an image and a plan. It does not certify location, installation, completion or safety. Shared renditions are permission-checked in the planning desk.", amountMinor: null });
    }
    for (const decision of workReviews) {
      if (!broad && !decision.current) continue;
      evidenceRows.push({ id: `planning-signoff:${decision.id}`, packageId: decision.packageId, evidenceId: decision.id,
        title: `${decision.provenance === "sample" ? "Sample review" : "Scoped review"} · ${decision.scope.replaceAll("_", " ")}`,
        sourceClass: "qualified_signoff", reviewState: decision.current ? decision.decision : "no_longer_current", itemCount: 1,
        reviewedAt: decision.recordedAt, sourceAvailable: false, documentId: null, claimId: null, provenance: decision.provenance,
        reviewScope: `Only the recorded ${decision.scope.replaceAll("_", " ")} scope and exact plan version. Credentials, source permission and later decisions are checked at this cutoff. ${decision.provenance === "sample" ? "This fictional exercise establishes no physical outcome." : "Other work requirements, funding and spending approval remain separate."}`, amountMinor: null });
    }
    const claimGroups = new Map<string, ReviewSource[]>();
    for (const row of reviews) {
      if (!row.package_id || !(broad || (session.role === "volunteer" && row.actor_id === session.actorId))) continue;
      const key = `${row.claim_id}:${row.package_id}`;
      claimGroups.set(key, [...(claimGroups.get(key) ?? []), row]);
    }
    for (const [key, lines] of claimGroups) {
      const first = lines[0], sourceAccess = privateClaims && claimData.has(first.claim_id) && first.document_state === "ready";
      evidenceRows.push({ id: `claim:${key}`, packageId: first.package_id!, evidenceId: `claim-source:${first.claim_id}`,
        title: sourceAccess ? claimData.get(first.claim_id)!.title : "Reviewed expense source",
        sourceClass: "expense_receipt", reviewState: first.claim_state, itemCount: 1, reviewedAt: iso(first.reviewed_at),
        sourceAvailable: sourceAccess, documentId: sourceAccess ? first.document_id : null, claimId: sourceAccess ? first.claim_id : null,
        provenance: first.provenance, reviewScope: "Expense source and package association only. This is not physical work acceptance or a repayment.",
        amountMinor: lines.reduce((sum, line) => sum + amount(line.approved_minor), 0) });
    }
    const exceptionRows: ExceptionRow[] = [];
    if (plan && plan.view.state !== "current") for (const pkg of packages) exceptionRows.push({ id: `planning-source:${pkg.id}`, exceptionId: `planning-source:${pkg.id}`, packageId: pkg.id,
      operationId: null, category: "plan_review", severity: "blocked", status: plan.view.state, title: "The plan needs a current review",
      detail: "A plan withdrawal or changed source prevents its geometry and physical reviews from counting as current. Recheck the plan in the planning desk.", affectedMinor: 0, observedAt: null, ageMinutes: null, provenance: plan.view.provenance });
    for (const pkg of readiness.filter(item => !item.prerequisitesMet)) exceptionRows.push({ id: `planning-prerequisite:${pkg.packageId}`, exceptionId: `planning-prerequisite:${pkg.packageId}`, packageId: pkg.packageId,
      operationId: null, category: "work_prerequisite", severity: "blocked", status: "prerequisites_needed", title: "A work prerequisite is unresolved",
      detail: "The reviewed plan requires accepted predecessor work or qualified safety reviews. A purchase, collection or photograph cannot satisfy that review.", affectedMinor: 0, observedAt: null, ageMinutes: null, provenance: pkg.provenance });
    for (const pkg of packageRows) {
      if (pkg.collectedMinor > 0 && pkg.shortfallMinor > 0) exceptionRows.push({ id: `shortfall:${pkg.id}`, exceptionId: `shortfall:${pkg.id}`, packageId: pkg.id,
        operationId: null, category: "collection_shortfall", severity: "blocked", status: pkg.fundingState,
        title: "Collection is incomplete", detail: "The remaining contribution must be confirmed before this package can fund spending.", affectedMinor: pkg.shortfallMinor,
        observedAt: null, ageMinutes: null, provenance: project.mode });
    }
    const pending = await query<PendingSource>(`SELECT i.consent_id AS id,o.package_id,i.state,i.amount_minor,
      CASE WHEN i.operation_id IS NOT NULL THEN COALESCE(op.completed_at,i.wallet_checked_at,i.created_at) ELSE NULL END AS observed_at,i.operation_id,'collection' AS category
      FROM fp_collection_items i JOIN fp_obligations o ON o.id=i.obligation_id
      LEFT JOIN fp_provider_operations op ON op.id=i.operation_id
      WHERE o.tenant_id=$1 AND o.project_id=$2 AND i.state<>'collected' AND ($3::boolean OR ($4='donor' AND o.actor_id=$5))
      UNION ALL SELECT f.id,COALESCE(f.funding_package_id,r.package_id),f.state,f.amount_minor,f.observed_at,f.operation_id,'refund' FROM fp_refunds f
      JOIN fp_settlement_receipts r ON r.id=f.receipt_id JOIN fp_obligations o ON o.id=r.obligation_id
      WHERE f.tenant_id=$1 AND f.project_id=$2 AND f.state<>'completed' AND ($3::boolean OR ($4='donor' AND o.actor_id=$5))`, [...params, broad, session.role, session.actorId], tx);
    for (const row of pending) {
      const untouched = row.category === "collection" && !row.operation_id;
      exceptionRows.push({ id: `${row.category}:${row.id}`, exceptionId: `${row.category}:${row.id}`, packageId: row.package_id,
        operationId: broad ? row.operation_id : null, category: row.category, severity: "attention", status: row.state,
        title: untouched ? "Original collection awaits review" : row.category === "refund" ? "Refund is not confirmed complete" : "Check the original collection",
        detail: untouched ? "No collection operation has been created for this contribution. An absent operation is not a provider decline." : "Follow the stored original operation. A pending or unknown result does not authorize another payment channel.",
        affectedMinor: amount(row.amount_minor), observedAt: iso(row.observed_at), ageMinutes: row.observed_at ? Math.max(0, Math.floor((cutoff - row.observed_at.getTime()) / 60000)) : null, provenance: project.mode });
    }
    for (const line of reviews) {
      if (line.decision !== "hold" || !(broad || (session.role === "volunteer" && line.actor_id === session.actorId))) continue;
      exceptionRows.push({ id: `held-line:${line.claim_id}:${line.claim_line_id}`, exceptionId: `held-line:${line.claim_id}:${line.claim_line_id}`,
        packageId: line.package_id ?? "", operationId: null, category: "expense_review", severity: "attention", status: "held_for_review",
        title: "An expense line needs clarification", detail: "This reviewed line has no approved repayment amount. Resolve its source and package before spending.",
        affectedMinor: amount(line.source_minor), observedAt: iso(line.reviewed_at), ageMinutes: line.reviewed_at ? Math.max(0, Math.floor((cutoff - line.reviewed_at.getTime()) / 60000)) : null,
        provenance: line.provenance });
    }
    const data: StudioData = { packages: packageRows, settlements: settlementRows, allocations: allocationRows, funding_positions: positionRows, evidence: evidenceRows, exceptions: exceptionRows };
    assertStudioProjection(data);
    const geometry = plan ? plan.view.state === "current" ? Object.fromEntries(plan.view.zones.map(zone => [`${zone.packageId}:${plan.view.contentHash}:${plan.view.state}`, { packageId: zone.packageId, points: zone.polygon, label: polygonLabel(zone.polygon) }])) : {} : Object.fromEntries(packages.map(pkg => [pkg.id, safeZone(pkg)]));
    const geometrySource: StudioSnapshot["geometrySource"] = plan ? { revision: plan.view.revision, planHash: plan.view.contentHash, geometryHash: plan.view.geometryHash,
      state: plan.view.state, provenance: plan.view.provenance, pageAspectRatio: plan.view.pageAspectRatio, outline: plan.view.state === "current" ? plan.view.outline : [], scaleLabel: plan.view.scaleLabel } : undefined;
    const asOf = project.as_of.toISOString();
    const contentHash = studioContentHash({ scope, asOf, data, geometry, geometrySource });
    return { semanticVersion: STUDIO_SEMANTIC_VERSION, datasetVersions: { funding_positions: STUDIO_POSITION_VERSION }, scope, datasetHandle: "", role: session.role, mode: project.mode, projectTitle: project.title,
      projectionVersion: project.projection_version, eventCursor: Number(project.cursor), asOf, contentHash, data, geometry, ...(geometrySource ? { geometrySource } : {}),
      notices: [plan ? `Plan revision ${plan.view.revision} · ${plan.view.state} · ${plan.view.provenance === "sample" ? "fictional sample" : "reviewed source geometry"}. Physical acceptance counts only current required reviews; provider availability and expense approval remain separate.` : SOURCE_NOTICE, FUNDING_NOTICE, session.role === "donor" ? "Payment and allocation details include only your contributions." : session.role === "volunteer" ? "Original expense sources include only your claims." : session.role === "auditor" ? "The Auditor receives redacted financial facts. Private originals and payment destinations are excluded." : "Private source links recheck your current role when opened."] };
  });
}

/** A stored dataset is an immutable, encrypted report cutoff, not a browser-selected tenant. */
export async function materializeStudioDataset(session: Session): Promise<StudioSnapshot> {
  const snapshot = await readStudioSnapshot(session);
  const id = randomUUID();
  snapshot.datasetHandle = id;
  await database().transaction(async tx => {
    const { membershipVersion } = await requireCurrentRole(session, session.role, tx);
    if (studioScope(session, membershipVersion) !== snapshot.scope) throw new DomainError("STUDIO_SCOPE_CHANGED", "Your report access changed. Reload this view.", 409);
    await tx.query(`INSERT INTO fp_studio_snapshots(id,tenant_id,project_id,actor_id,role,scope_hash,membership_version,projection_version,event_cursor,as_of,content_hash,encrypted_data,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()+interval '30 minutes')`,
      [id, session.tenantId, session.projectId, session.actorId, session.role, snapshot.scope, membershipVersion, snapshot.projectionVersion, snapshot.eventCursor, snapshot.asOf, snapshot.contentHash,
        sealPrivate(snapshot, snapshotContext(snapshot.scope, id))]);
  });
  return snapshot;
}

export async function requireStudioDataset(session: Session, id: string, tx: SqlConnection = database()): Promise<StudioSnapshot> {
  const { membershipVersion } = await requireCurrentRole(session, session.role, tx), scope = studioScope(session, membershipVersion);
  const [row] = await query<{ encrypted_data: string; content_hash: string }>(`SELECT encrypted_data,content_hash FROM fp_studio_snapshots
    WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND actor_id=$4 AND role=$5 AND scope_hash=$6 AND expires_at>now()`,
    [id, session.tenantId, session.projectId, session.actorId, session.role, scope], tx);
  if (!row) throw new DomainError("STUDIO_DATASET_EXPIRED", "This report cutoff is unavailable. Refresh the report before asking a new question.", 409);
  const snapshot = openPrivate<StudioSnapshot>(row.encrypted_data, snapshotContext(scope, id));
  assertStudioProjection(snapshot.data);
  if (snapshot.scope !== scope || snapshot.role !== session.role || snapshot.datasetHandle !== id || snapshot.contentHash !== row.content_hash
    || studioContentHash(snapshot) !== row.content_hash)
    throw new DomainError("STUDIO_DATASET_CHANGED", "The stored report could not be verified.", 409);
  return snapshot;
}
