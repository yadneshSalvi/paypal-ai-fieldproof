import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import type { PackageView } from "../contracts";
import type { BoardPackAudience, BoardPackReport, BoardPackSource, BoardPackSourceDetail, BoardPackPackage, BoardPackExpense, BoardPackAssignment, BoardPackBalance } from "../reports/board-pack-contracts";
import { BOARD_PACK_VERSION, boardPackSourceId } from "../reports/board-pack-contracts";
import { boardPackScopedTotals } from "../reports/board-pack-projection";
import { currentPledgeCommitment } from "../funding/pledges";
import type { Session } from "./auth";
import { query } from "./db";
import { DomainError, assertMinor } from "../domain/money";
import { readStudioSnapshotWithin } from "./studio-datasets";
import { readFundingJournal, readFundingProjection } from "./funding-positions";
import { pledgeContract, type PledgeRow } from "./purpose-store";
import { claimPrivate, type ClaimRow } from "./claims";
import { publishedPlan } from "./planning-store";
import { alignmentViews, packageReadiness, signoffViews } from "./planning-evidence";
import { openPrivate } from "./private-values";
import { supporterProofRecords } from "./proof";
import type { SharedAlignmentImage } from "./planning-images";

export interface BoardPackImageBinding { kind: "alignment" | "proof"; id: string; hash: string; width: number; height: number; slug?: string; revision?: number; }
export interface BoardPackPrivateSource { detail: Omit<BoardPackSourceDetail, "reportId" | "contentHash" | "asOf" | "image">; image: BoardPackImageBinding | null; }
export interface BoardPackBindings {
  documents: { id: string; version: number; hash: string | null; controlVersion: number }[];
  publications: { id: string; hash: string }[];
  alignments: { id: string; hash: string }[];
  proofSnapshots: { id: string; packageId: string; hash: string; slug: string; revision: number }[];
  validThrough: string | null;
}
export interface BoardPackEnvelope { report: BoardPackReport; sources: Record<string, BoardPackPrivateSource>; bindings: BoardPackBindings; sourceHash: string; }
const params = (session: Session) => [session.tenantId, session.projectId];
const iso = (value: Date | string | null | undefined) => value ? new Date(value).toISOString() : null;
const minor = (value: string | number | null) => { const n = Number(value ?? 0); assertMinor(n); return n; };
const total = <T>(rows: T[], value: (row: T) => number) => { const n = rows.reduce((sum, row) => sum + value(row), 0); assertMinor(n); return n; };
const money = (value: number) => `USD ${(value / 100).toFixed(2)}`;
const words = (value: string) => value.replaceAll("_", " ");
export function boardPackAudience(role: Session["role"]): BoardPackAudience {
  if (role === "organizer") return { role, label: "Organizer · private project report", detail: "Project-wide financial and work totals, original receipts, reviewed expenses and authorized private source details. Payment destinations and account identifiers are excluded.", receiptScope: "project", expenseScope: "project_private" };
  if (role === "auditor") return { role, label: "Auditor · redacted project report", detail: "Project-wide accounting and work-review facts. Private expense originals, identities, recipient destinations and inspection details are excluded.", receiptScope: "project", expenseScope: "project_redacted" };
  if (role === "donor") return { role, label: "Supporter · your contribution report", detail: "Project totals describe the shared project. Original receipt and current-purpose detail include only your contributions. Other supporters and private expenses are excluded.", receiptScope: "own_contributions", expenseScope: "none" };
  return { role, label: "Volunteer · your expense report", detail: "Project totals describe the shared project. Expense details include only your own claims. Other people's contribution receipts and private expenses are excluded.", receiptScope: "none", expenseScope: "own_claims" };
}

/** Private source fingerprint includes all input families, never report/audit
 * writes. Every query shares the capture transaction and fixed tenant scope. */
export async function boardPackSourceHash(session: Session, tx: SqlConnection): Promise<string> {
  const simple = ["fp_obligations", "fp_settlement_receipts", "fp_funding_assignments", "fp_funding_deductions", "fp_receipt_allocations", "fp_claims", "fp_payables", "fp_documents", "fp_plan_versions", "fp_plan_reviews", "fp_plan_publications", "fp_plan_source_controls", "fp_photo_alignments", "fp_work_signoffs", "fp_reviewer_qualifications", "fp_purpose_pledges", "fp_collection_rounds", "fp_conditional_consents", "fp_funding_policies", "fp_sample_funding_origins", "fp_sample_funding_use_evidence", "fp_funding_cases", "fp_funding_choices", "fp_refunds", "fp_evidence", "fp_sponsor_offers", "fp_sponsor_acceptances", "fp_sponsor_events", "fp_proof_heads", "fp_proof_derivatives", "fp_proof_snapshots"];
  const statements = simple.map(table => ({ name: table, sql: `SELECT to_jsonb(t)::text value FROM ${table} t WHERE t.tenant_id=$1 AND t.project_id=$2` }));
  statements.push({ name: "project", sql: "SELECT to_jsonb(p)::text value FROM fp_projects p WHERE p.tenant_id=$1 AND p.id=$2" },
    { name: "packages", sql: "SELECT to_jsonb(p)::text value FROM fp_packages p JOIN fp_projects t ON t.id=p.project_id WHERE t.tenant_id=$1 AND p.project_id=$2" },
    { name: "allocation_revisions", sql: "SELECT to_jsonb(v)::text value FROM fp_allocation_revisions v JOIN fp_receipt_allocations a ON a.id=v.allocation_id WHERE a.tenant_id=$1 AND a.project_id=$2" },
    { name: "claim_lines", sql: "SELECT to_jsonb(l)::text value FROM fp_claim_line_reviews l JOIN fp_claims c ON c.id=l.claim_id WHERE c.tenant_id=$1 AND c.project_id=$2" },
    { name: "payable_lines", sql: "SELECT to_jsonb(l)::text value FROM fp_payable_lines l JOIN fp_payables p ON p.id=l.payable_id WHERE p.tenant_id=$1 AND p.project_id=$2" },
    { name: "reviewer_authority", sql: "SELECT jsonb_build_object('actor',m.actor_id,'state',m.state,'roles',m.roles,'version',m.version)::text value FROM fp_memberships m WHERE m.tenant_id=$1 AND m.project_id=$2" },
    { name: "balance_observations", sql: "SELECT DISTINCT to_jsonb(b)::text value FROM fp_balance_observations b JOIN fp_payables p ON p.balance_observation_id=b.id WHERE p.tenant_id=$1 AND p.project_id=$2" });
  const hashes: Record<string, { count: number; hash: string }> = {};
  for (const source of statements) {
    const [row] = await query<{ count: string; hash: string | null }>(`SELECT count(*) count,md5(string_agg(value,E'\\n' ORDER BY value)) hash FROM (${source.sql}) source`, params(session), tx);
    if (Number(row.count) > 20000) throw new DomainError("BOARD_PACK_SIZE_LIMIT", "This project's history is too large for a single Board Pack. Keep the saved reports and contact the organizer for a scoped reporting export.", 422);
    hashes[source.name] = { count: Number(row.count), hash: row.hash ?? "empty" };
  }
  return sha256(canonicalJson(hashes));
}

export async function buildBoardPack(session: Session, id: string, label: string, tx: SqlConnection): Promise<BoardPackEnvelope> {
  const snapshot = await readStudioSnapshotWithin(session, tx), audience = boardPackAudience(session.role), cutoff = Date.parse(snapshot.asOf), scope = params(session);
  const [project] = await query<{ metadata: { title: string; subtitle?: string; templateId?: string } }>("SELECT metadata FROM fp_projects WHERE tenant_id=$1 AND id=$2", scope, tx);
  const packageRows = await query<{ id: string; version: number; data: PackageView }>("SELECT p.id,p.version,p.data FROM fp_packages p JOIN fp_projects t ON t.id=p.project_id WHERE t.tenant_id=$1 AND p.project_id=$2 ORDER BY p.id", scope, tx);
  const pledges = await query<PledgeRow>("SELECT * FROM fp_purpose_pledges WHERE tenant_id=$1 AND project_id=$2 ORDER BY id", scope, tx);
  const obligations = await query<{ id: string; package_id: string; amount_minor: string; channel: string; eligible: boolean | null; current_version: number; package_version: number | null; status: string | null; withdrawn_at: Date | null; expires_at: Date | null; round_id: string | null; paid: string; current_policy: boolean; has_receipt: boolean }>(`SELECT o.id,o.package_id,o.amount_minor,o.channel,(o.data->>'eligible')::boolean eligible,p.version current_version,c.package_version,c.status,c.withdrawn_at,c.expires_at,c.round_id,
    EXISTS(SELECT 1 FROM fp_funding_policies f WHERE f.tenant_id=o.tenant_id AND f.project_id=o.project_id AND f.package_id=o.package_id AND f.package_version=p.version) current_policy,
    EXISTS(SELECT 1 FROM fp_settlement_receipts r WHERE r.tenant_id=o.tenant_id AND r.project_id=o.project_id AND r.obligation_id=o.id) has_receipt,
    COALESCE((SELECT sum((r.data->>'creditedMinor')::bigint) FROM fp_settlement_receipts r WHERE r.tenant_id=o.tenant_id AND r.project_id=o.project_id AND r.obligation_id=o.id),0) paid
    FROM fp_obligations o JOIN fp_packages p ON p.project_id=o.project_id AND p.id=o.package_id LEFT JOIN fp_conditional_consents c ON c.obligation_id=o.id
    WHERE o.tenant_id=$1 AND o.project_id=$2 AND o.purpose='conditional_pledge' ORDER BY o.id`, scope, tx);
  const unpaid = new Map<string, number>(), sponsorUnpaid = new Map<string, number>(), deadlines: number[] = [];
  const pledgeIds = new Set(pledges.map(p => p.obligation_id));
  for (const pledge of pledges) {
    const value = pledgeContract(pledge), pkg = packageRows.find(p => p.id === pledge.package_id);
    const amount = pkg?.version === value.packageVersion ? Math.max(0, currentPledgeCommitment({ state: pledge.state, amountMinor: value.amountMinor, collectedMinor: minor(pledge.collected_minor), expiresAt: value.expiresAt, operationId: pledge.operation_id }, cutoff) - minor(pledge.collected_minor)) : 0;
    unpaid.set(pledge.package_id, (unpaid.get(pledge.package_id) ?? 0) + amount);
    if (value.kind !== "donor") sponsorUnpaid.set(pledge.package_id, (sponsorUnpaid.get(pledge.package_id) ?? 0) + amount);
    if (amount && !pledge.operation_id && Date.parse(value.expiresAt) > cutoff) deadlines.push(Date.parse(value.expiresAt));
  }
  for (const row of obligations) {
    if (pledgeIds.has(row.id)) continue;
    const eligible = session.mode === "sample" ? row.eligible !== false && !["withdrawn", "cancelled", "refunded"].includes(row.channel) && (!row.current_policy || row.has_receipt) : row.eligible && !row.withdrawn_at && row.package_version === row.current_version && ["ready", "collecting", "collected"].includes(row.status ?? "") && (row.round_id || row.expires_at && row.expires_at.getTime() > cutoff);
    if (eligible) unpaid.set(row.package_id, (unpaid.get(row.package_id) ?? 0) + Math.max(0, minor(row.amount_minor) - minor(row.paid)));
    if (eligible && !row.round_id && row.expires_at && row.expires_at.getTime() > cutoff) deadlines.push(row.expires_at.getTime());
  }
  const cases = await query<{ id: string; package_id: string; package_version: number; state: string; revision: number; deadline: Date }>("SELECT id,package_id,package_version,state,revision,deadline FROM fp_funding_cases WHERE tenant_id=$1 AND project_id=$2 AND state<>'superseded' ORDER BY created_at DESC,id", scope, tx);
  const plan = await publishedPlan(session, tx), photos = plan ? await alignmentViews(session, tx, true) : [], signoffs = plan ? await signoffViews(session, tx, true, cutoff) : [];
  const readiness = packageReadiness(plan?.payload ?? null, plan?.view.state === "current", photos, signoffs, snapshot.data.packages.filter(p => p.shortfallMinor === 0 && !["cancelled", "held"].includes(p.fundingState)).map(p => p.id));
  const sources: Record<string, BoardPackPrivateSource> = {}, documentIds = new Set<string>();
  const bindings: BoardPackBindings = { documents: [], publications: plan && plan.view.state === "current" ? [{ id: plan.view.publicationId, hash: plan.view.contentHash }] : [], alignments: [], proofSnapshots: [], validThrough: null };
  const add = (source: BoardPackSource, fields: Record<string, string | number | null>, limitations: string[] = [], relatedSourceIds: string[] = [], image: BoardPackImageBinding | null = null) => {
    if (sources[source.id]) throw new DomainError("BOARD_PACK_SOURCE_IDENTITY", "A source reference is repeated in this report.", 409);
    sources[source.id] = { detail: { source, fields: Object.entries(fields).map(([label, value]) => ({ label, value: value === null ? "Not recorded" : String(value) })), limitations, relatedSourceIds }, image };
  };
  const source = (kind: BoardPackSource["kind"], recordId: string, label: string, packageIds: string[], reviewScope: string, at: string | null = snapshot.asOf, provenance: string = session.mode): BoardPackSource => ({ id: boardPackSourceId(kind, recordId), kind, label, packageIds, provenance, observedAt: at, reviewerLabel: null, reviewedAt: null, scope: reviewScope, available: true });
  const packages: BoardPackPackage[] = packageRows.map(pkg => {
    const row = snapshot.data.packages.find(p => p.id === pkg.id)!, state = readiness.find(p => p.packageId === pkg.id), currentCase = cases.find(c => c.package_id === pkg.id && c.package_version === pkg.version);
    const ref = source("package", pkg.id, row.title, [pkg.id], "The exact package version, current-purpose accounting and work-review denominator at this cutoff.");
    add(ref, { "Package version": pkg.version, "Budget": money(row.budgetMinor), "Current net support": money(row.collectedMinor), "Eligible accounting credit": money(row.fundingEligibleMinor), "Original commitment record": money(row.pledgedMinor), "Current unpaid commitments": money(unpaid.get(pkg.id) ?? 0), "Funding state": words(row.fundingState), "Recorded lifecycle": words(pkg.data.fundingState), "Reviewed work items": `${row.reviewedItemCount} / ${row.requiredItemCount}` }, ["A promise or saved wallet is not collected money. Current assignment is not another payment.", "Accounting availability does not establish provider liquidity or spending authority."]);
    return { packageId: pkg.id, version: pkg.version, title: row.title, lifecycleState: pkg.data.fundingState, originalCommitmentRecordMinor: row.pledgedMinor, unpaidCommitmentMinor: unpaid.get(pkg.id) ?? 0, acceptedSponsorUnpaidMinor: sponsorUnpaid.get(pkg.id) ?? 0,
      currentCase: currentCase ? { id: currentCase.id, state: currentCase.state, revision: currentCase.revision, deadline: currentCase.deadline.toISOString(), packageVersion: currentCase.package_version } : null,
      requirements: state ? state.requirements.map(r => ({ ...r, scope: plan?.payload.plan.packages.find(p => p.packageId === pkg.id)?.requirements.find(item => item.id === r.id)?.scope ?? null })) : [],
      blockers: state?.blockers ?? ["No reviewed source plan is published. The existing project requirement count is a reference, not a new physical sign-off."], sourceId: ref.id };
  });
  for (const row of snapshot.data.settlements) {
    const ref = source("receipt", row.id, `${row.sourceKind === "invoice_payment" ? "Invoice payment" : "Orders payment"} · ${money(row.grossMinor)}`, [row.packageId], "Original receipt identity, observed gross and attribution. Current purpose assignments are shown separately.", row.observedAt, row.provenance);
    add(ref, { "Original receipt": row.settlementReceiptId, "Original package": row.packageId, "Rail": row.sourceKind, "Purpose": row.purpose, "Observed state": row.observedState, "Original gross": money(row.grossMinor), "Original credit": money(row.creditedMinor), "Completed returns": money(row.completedRefundMinor), "Pending returns": money(row.pendingRefundMinor), "Excluded credit": money(row.excludedMinor), "Excess liability": money(row.excessLiabilityMinor) }, ["Gross settlement is not a net merchant balance. Payment-provider account identifiers and secret references are excluded."], (snapshot.data.funding_positions ?? []).filter(p => p.settlementReceiptId === row.id).map(p => boardPackSourceId("position", p.id)));
  }
  for (const row of snapshot.data.funding_positions ?? []) {
    const ref = source("position", row.id, `Current purpose · ${packages.find(p => p.packageId === row.packageId)?.title ?? row.packageId}`, [row.packageId], "One original receipt and one current restricted purpose. Paired changes conserve credit; original payments are never counted again.");
    add(ref, { "Original receipt": row.settlementReceiptId, "Receipt version": row.receiptVersion, "Original package": row.originalPackageId, "Current package": row.packageId, "Assigned credit": money(row.assignedMinor), "Net assigned": money(row.collectedMinor), "Eligible assigned": money(row.fundingEligibleMinor), "Returned": money(row.refundedMinor), "Returns pending": money(row.pendingRefundMinor), "Excluded": money(row.excludedMinor), "Reserved uses": money(row.reservedMinor), "Paid uses": money(row.paidMinor), "Uncommitted credit": money(row.availableMinor), "Assignment records": row.assignmentCount }, ["This accounting projection does not authorize spending or prove the current provider balance."], [boardPackSourceId("receipt", row.settlementReceiptId), boardPackSourceId("package", row.packageId)]);
  }
  const journal = await readFundingJournal({ tenantId: session.tenantId, projectId: session.projectId, provenance: session.mode }, tx), visibleReceipts = new Set(snapshot.data.settlements.map(r => r.id));
  const assignments: BoardPackAssignment[] = journal.assignments.filter(a => visibleReceipts.has(a.receiptId)).map(a => {
    const ref = source("assignment", a.id, `${a.kind === "rollover" ? "Explicit renewal" : a.kind === "reversal" ? "Assignment reversal" : "Purpose change"} · ${money(a.amountMinor)}`, [a.debit.packageId, a.credit.packageId], "A paired accounting change under the original donor's consent. No additional payment occurred.", a.committedAt);
    add(ref, { "Original receipt": a.receiptId, "Sequence": a.sequence, "Kind": a.kind, "Amount": money(a.amountMinor), "From purpose": `${a.debit.packageId} v${a.debit.packageVersion}`, "To purpose": `${a.credit.packageId} v${a.credit.packageVersion}`, "Committed at": a.committedAt }, [], [boardPackSourceId("receipt", a.receiptId), boardPackSourceId("package", a.credit.packageId)]);
    return { id: a.id, receiptId: a.receiptId, kind: a.kind, amountMinor: a.amountMinor, fromPackageId: a.debit.packageId, toPackageId: a.credit.packageId, committedAt: a.committedAt, sequence: a.sequence, sourceId: ref.id };
  });
  for (const row of snapshot.data.allocations) add(source("allocation", row.id, row.expenseLabel, [row.packageId], "One immutable allocation revision. Only the active amount counts toward current uses."), { "Allocation": row.allocationId, "Revision": row.revision, "Original receipt": row.settlementReceiptId, "Revision amount": money(row.allocationMinor), "Current active amount": money(row.activeAllocationMinor), "State": row.state, "Purpose": row.purpose }, ["Do not add old and current revisions together."], [boardPackSourceId("receipt", row.settlementReceiptId), boardPackSourceId("package", row.packageId)]);
  const broad = ["organizer", "auditor"].includes(session.role), privateExpenses = ["organizer", "volunteer"].includes(session.role);
  const claimRows = await query<ClaimRow & { document_state: string; permission: string | null }>(`SELECT c.*,d.state document_state,ctrl.permission FROM fp_claims c
    JOIN fp_documents d ON d.id=c.document_id AND d.tenant_id=c.tenant_id AND d.project_id=c.project_id
    LEFT JOIN fp_plan_source_controls ctrl ON ctrl.document_id=d.id
    WHERE c.tenant_id=$1 AND c.project_id=$2 AND ($3::boolean OR ($4='volunteer' AND c.actor_id=$5)) ORDER BY c.created_at,c.id`, [...scope, broad, session.role, session.actorId], tx);
  const blockedClaimIds = new Set(claimRows.filter(c => c.document_state !== "ready" || c.permission === "withdrawn").map(c => c.id));
  // A frozen report never turns a hidden column or an earlier review into
  // continuing permission to disclose an original's title or line text.
  for (const row of snapshot.data.evidence) if (row.claimId && blockedClaimIds.has(row.claimId)) { row.title = "Expense source withdrawn"; row.documentId = null; row.claimId = null; row.sourceAvailable = false; }
  for (const row of snapshot.data.allocations) if (row.claimId && blockedClaimIds.has(row.claimId)) {
    row.expenseLabel = "Reviewed expense line"; row.claimId = null; row.evidenceId = null;
    const saved = sources[boardPackSourceId("allocation", row.id)]; if (saved) saved.detail.source.label = "Reviewed expense line";
  }
  const payableRows = await query<{ id: string; claim_id: string; state: string; amount_minor: string; fee_allowance_minor: string; actual_fee_minor: string | null; fee_state: string; principal_paid_at: Date | null; principal_returned_at: Date | null; observed_at: Date | null }>(`SELECT p.id,p.claim_id,p.state,p.amount_minor,p.fee_allowance_minor,p.actual_fee_minor,p.fee_state,p.principal_paid_at,p.principal_returned_at,p.observed_at FROM fp_payables p
    JOIN fp_claims c ON c.id=p.claim_id AND c.tenant_id=p.tenant_id AND c.project_id=p.project_id WHERE p.tenant_id=$1 AND p.project_id=$2 AND ($3::boolean OR ($4='volunteer' AND c.actor_id=$5)) ORDER BY p.created_at,p.id`, [...scope, broad, session.role, session.actorId], tx);
  const claimLines = await query<{ claim_id: string; package_id: string | null }>("SELECT l.claim_id,l.package_id FROM fp_claim_line_reviews l JOIN fp_claims c ON c.id=l.claim_id WHERE c.tenant_id=$1 AND c.project_id=$2 AND l.review_version=c.version ORDER BY l.claim_id,l.claim_line_id", scope, tx);
  const expenses: BoardPackExpense[] = claimRows.map(claim => {
    const originalAllowed = privateExpenses && !blockedClaimIds.has(claim.id), data = originalAllowed ? claimPrivate(claim) : null;
    if (originalAllowed) documentIds.add(claim.document_id);
    const packageIds = [...new Set(claimLines.filter(l => l.claim_id === claim.id && l.package_id).map(l => l.package_id!))], ref = source("expense", claim.id, data?.title ?? "Reviewed expense", packageIds, "Reviewed expense facts only. Expense approval is separate from physical acceptance and provider-confirmed repayment.", iso(claim.reviewed_at));
    ref.reviewerLabel = claim.reviewed_at ? "Project organizer · expense review" : null; ref.reviewedAt = iso(claim.reviewed_at);
    const repayments: BoardPackExpense["repayments"] = payableRows.filter(p => p.claim_id === claim.id).map(p => {
      const repaymentRef = source("expense", `repayment:${p.id}`, `Repayment · ${money(minor(p.amount_minor))}`, packageIds, "The stored original payout outcome and separately recorded fees. No payout is dispatched by this report.", iso(p.observed_at));
      add(repaymentRef, { "Repayment": p.id, "Recorded state": p.state, "Principal": money(minor(p.amount_minor)), "Delivered principal": money(p.principal_paid_at && !p.principal_returned_at ? minor(p.amount_minor) : 0), "Returned principal": money(p.principal_returned_at ? minor(p.amount_minor) : 0), "Fee allowance": money(minor(p.fee_allowance_minor)), "Actual recorded fee": p.actual_fee_minor === null ? null : money(minor(p.actual_fee_minor)), "Fee state": p.fee_state, "Provider observation": iso(p.observed_at) }, ["A pending or unknown payout is not repayment. Payment destinations and raw provider references are excluded."], [ref.id]);
      return { id: p.id, state: p.state, principalMinor: minor(p.amount_minor), deliveredMinor: p.principal_paid_at && !p.principal_returned_at ? minor(p.amount_minor) : 0, returnedMinor: p.principal_returned_at ? minor(p.amount_minor) : 0, feeAllowanceMinor: minor(p.fee_allowance_minor), actualFeeMinor: p.actual_fee_minor === null ? null : minor(p.actual_fee_minor), feeState: p.fee_state, observedAt: iso(p.observed_at), sourceId: repaymentRef.id };
    });
    add(ref, { "Expense review": claim.id, "Review version": claim.version, "State": claim.state, "Requested": money(minor(claim.requested_minor)), "Approved": money(minor(claim.approved_minor)), "Review date": iso(claim.reviewed_at), "Original access": originalAllowed ? "Authorized private description included" : "Private original excluded from this report" }, ["A reviewed claim is neither a payment nor certification of installed work."], repayments.map(r => r.sourceId));
    return { id: claim.id, packageIds, claimId: originalAllowed ? claim.id : null, title: ref.label, state: claim.state, claimVersion: claim.version, approvedMinor: minor(claim.approved_minor), requestedMinor: minor(claim.requested_minor), reviewedAt: ref.reviewedAt, reviewerLabel: ref.reviewerLabel, repayments, sourceId: ref.id };
  });
  for (const row of snapshot.data.evidence) {
    const ref = source("evidence", row.id, row.title, [row.packageId], row.reviewScope, row.reviewedAt, row.provenance);
    ref.reviewedAt = row.reviewedAt;
    const photo = photos.find(p => row.id === `planning-photo:${p.id}`), signoff = signoffs.find(s => row.id === `planning-signoff:${s.id}`);
    ref.reviewerLabel = photo?.reviewerLabel ?? (signoff?.current ? signoff.reviewerLabel : signoff ? "Scoped project reviewer" : row.reviewedAt ? "Recorded project reviewer" : null);
    const fields: Record<string, string | number | null> = { "Evidence reference": row.evidenceId, "Source class": row.sourceClass, "Review state": row.reviewState, "Reviewed at": row.reviewedAt, "Recorded scope": row.reviewScope, "Associated reviewed expense": row.amountMinor === null ? null : money(row.amountMinor) };
    let image: BoardPackImageBinding | null = null;
    if (photo?.state === "reviewed" && photo.previewUrl && photo.sharedPreviewHash) {
      const [raw] = await query<{ id: string; document_id: string; encrypted_data: string; content_hash: string }>("SELECT id,document_id,encrypted_data,content_hash FROM fp_photo_alignments WHERE id=$1 AND tenant_id=$2 AND project_id=$3", [photo.id, ...scope], tx);
      if (raw) {
        const data = openPrivate<{ sharedImage: SharedAlignmentImage }>(raw.encrypted_data, `photo-alignment:${session.tenantId}:${session.projectId}:${raw.id}`);
        if (sha256(canonicalJson(openPrivate(raw.encrypted_data, `photo-alignment:${session.tenantId}:${session.projectId}:${raw.id}`))) !== raw.content_hash || data.sharedImage.sha256 !== photo.sharedPreviewHash) throw new DomainError("BOARD_PACK_IMAGE_CHANGED", "This reviewed image changed. Reload its source review before capturing the report.", 409);
        image = { kind: "alignment", id: photo.id, hash: data.sharedImage.sha256, width: data.sharedImage.width, height: data.sharedImage.height };
        documentIds.add(raw.document_id); bindings.alignments.push({ id: raw.id, hash: raw.content_hash });
      }
    }
    if (signoff) {
      fields["Reviewer"] = ref.reviewerLabel; fields["Decision date"] = signoff.recordedAt; fields["Observed work date"] = signoff.observedAt; fields["Qualified scope"] = signoff.scope; fields["Current at cutoff"] = signoff.current ? "Yes" : "No"; fields["Statement"] = signoff.current ? signoff.statement : "Historical decision; private source details are not carried forward."; fields["Limitations"] = signoff.current ? signoff.limitations : signoff.stateReason;
      if (signoff.current) {
        const [raw] = await query<{ id: string; encrypted_data: string; document_id: string }>(`SELECT s.id,s.encrypted_data,q.document_id FROM fp_work_signoffs s
          JOIN fp_reviewer_qualifications q ON q.id=s.qualification_id AND q.tenant_id=s.tenant_id AND q.project_id=s.project_id
          WHERE s.id=$1 AND s.tenant_id=$2 AND s.project_id=$3`, [signoff.id, ...scope], tx);
        if (!raw) throw new DomainError("BOARD_PACK_SOURCE_CHANGED", "A scoped review source changed before this report could be captured.", 409);
        const details = openPrivate<{ sourceBindings: { documentId: string }[] }>(raw.encrypted_data, `work-signoff:${session.tenantId}:${session.projectId}:${raw.id}`);
        documentIds.add(raw.document_id);
        for (const bound of details.sourceBindings) documentIds.add(bound.documentId);
      }
    }
    add(ref, fields, [row.reviewScope], [boardPackSourceId("package", row.packageId)], image);
    if (row.sourceAvailable && row.documentId) documentIds.add(row.documentId);
  }
  if (plan) {
    const ref = source("plan", plan.row.id, `Reviewed plan · revision ${plan.view.revision}`, plan.view.packages.map(p => p.packageId), "Geometry and package requirements from this exact reviewed plan. It is not a survey or safety certificate.", plan.view.publishedAt, plan.view.provenance);
    ref.reviewedAt = plan.view.publishedAt; ref.reviewerLabel = "Project organizer · publication review";
    add(ref, { "Plan revision": plan.view.revision, "Plan hash": plan.view.contentHash, "Geometry hash": plan.view.geometryHash, "Publication state": plan.view.state, "Scale": plan.view.scaleLabel }, [...plan.view.staleReasons, "The recorded geometry and its source review remain distinct from physical work acceptance."]);
    if (plan.view.state === "current") for (const bound of plan.payload.sources) documentIds.add(bound.documentId);
  }
  // Only already published, privacy-reviewed derivatives can enter the shared
  // gallery. Draft originals are never substituted for missing published art.
  for (const record of await supporterProofRecords(session, tx)) {
    if (record.proof.state !== "published" || !record.proof.snapshot) continue;
    const edition = record.proof.snapshot;
    bindings.proofSnapshots.push({ id: edition.id, packageId: record.packageId, hash: edition.contentHash, slug: record.proof.slug, revision: edition.payload.revision });
    for (const image of edition.payload.evidence) {
      const recordId = `proof:${edition.id}:${image.id}`, review = record.reviews.find(r => r.id === image.id);
      const ref = source("evidence", recordId, image.label, [record.packageId], "Published redacted derivative, reviewed for this public edition. Its earlier publication cutoff is retained.", edition.payload.cutoff, image.sample ? "sample" : "reviewed_public_copy");
      ref.reviewedAt = review?.reviewedAt ?? null; ref.reviewerLabel = review?.reviewerLabel ?? null;
      add(ref, { "Public edition": edition.payload.revision, "Publication cutoff": edition.payload.cutoff, "Derivative hash": image.contentHash, "Privacy review version": image.reviewVersion }, ["This redacted copy covers only its recorded source and review scope. It does not establish a new payment or physical outcome."], [boardPackSourceId("package", record.packageId)], { kind: "proof", id: image.id, hash: image.contentHash, width: image.width, height: image.height, slug: record.proof.slug, revision: edition.payload.revision });
      snapshot.data.evidence.push({ id: recordId, packageId: record.packageId, evidenceId: image.id, title: image.label, sourceClass: `redacted_${image.kind}`, reviewState: "published_privacy_review", itemCount: 1, reviewedAt: review?.reviewedAt ?? null, sourceAvailable: false, documentId: null, claimId: null, provenance: image.sample ? "sample" : "reviewed_public_copy", reviewScope: ref.scope, amountMinor: null });
    }
  }
  for (const row of snapshot.data.exceptions) add(source("exception", row.id, row.title, row.packageId ? [row.packageId] : [], "An unresolved item at the fixed report cutoff. Affected amounts may overlap and cannot be added as a balance.", row.observedAt, row.provenance), { "Category": row.category, "Status": row.status, "Severity": row.severity, "Detail": row.detail, "Affected amount": money(row.affectedMinor), "Age at cutoff in minutes": row.ageMinutes }, ["Resolving an exception changes a later report; it does not rewrite this historical capture."]);
  const projection = await readFundingProjection({ tenantId: session.tenantId, projectId: session.projectId, provenance: session.mode }, tx);
  const fees = await query<{ state: string; amount: string }>("SELECT state,sum(amount_minor) amount FROM fp_receipt_allocations WHERE tenant_id=$1 AND project_id=$2 AND kind='fee' AND state IN ('reserved','paid') GROUP BY state", scope, tx);
  let balance: BoardPackBalance = { state: "not_recorded", observedAt: null, asOf: null, refreshedAt: null, availableMinor: null, code: null, sourceId: null, limitation: broad ? "No balance observation linked to this project's repayments is recorded. Funding totals are gross accounting facts, not verified current merchant liquidity." : "Private merchant balance evidence is outside this audience. Shared funding totals do not establish current merchant liquidity." };
  if (broad) {
    const [row] = await query<{ id: string; observed_at: Date; as_of_time: Date | null; last_refresh_time: Date | null; available_minor: string | null; code: string | null }>(`SELECT DISTINCT b.id,b.observed_at,b.as_of_time,b.last_refresh_time,b.available_minor,b.code FROM fp_balance_observations b JOIN fp_payables p ON p.balance_observation_id=b.id WHERE p.tenant_id=$1 AND p.project_id=$2 ORDER BY b.observed_at DESC,b.id DESC LIMIT 1`, scope, tx);
    if (row) {
      const ref = source("balance", row.id, "Recorded provider balance evidence", [], "An earlier merchant-balance observation linked to this project's repayment. It is separate from this report cutoff and is not current spending authority.", row.observed_at.toISOString());
      add(ref, { "Observed at": row.observed_at.toISOString(), "Provider as of": iso(row.as_of_time), "Last provider refresh": iso(row.last_refresh_time), "Available amount at observation": row.available_minor === null ? null : money(minor(row.available_minor)), "Unavailability code": row.code }, ["No provider read was made to build this report. Check current provider funds and exact authorization separately before spending."]);
      balance = { state: row.available_minor !== null && !row.code ? "observed" : "unavailable", observedAt: row.observed_at.toISOString(), asOf: iso(row.as_of_time), refreshedAt: iso(row.last_refresh_time), availableMinor: row.available_minor === null ? null : minor(row.available_minor), code: row.code, sourceId: ref.id, limitation: ref.scope };
    }
  }
  for (const documentId of [...documentIds].sort()) {
    const [doc] = await query<{ id: string; version: number; sha256: string | null; state: string; permission: string | null; control_version: number | null }>("SELECT d.id,d.version,d.sha256,d.state,c.permission,c.version control_version FROM fp_documents d LEFT JOIN fp_plan_source_controls c ON c.document_id=d.id WHERE d.id=$1 AND d.tenant_id=$2 AND d.project_id=$3", [documentId, ...scope], tx);
    if (!doc || doc.state !== "ready" || doc.permission === "withdrawn") throw new DomainError("BOARD_PACK_SOURCE_CHANGED", "A private source is no longer available. Refresh its review before capturing this report.", 409);
    bindings.documents.push({ id: doc.id, version: doc.version, hash: doc.sha256, controlVersion: doc.control_version ?? 0 });
  }
  const qualifications = await query<{ valid_until: Date }>("SELECT valid_until FROM fp_reviewer_qualifications WHERE tenant_id=$1 AND project_id=$2 AND state='verified' AND valid_until>$3", [...scope, snapshot.asOf], tx);
  deadlines.push(...qualifications.map(q => q.valid_until.getTime()));
  bindings.validThrough = deadlines.length ? new Date(Math.min(...deadlines)).toISOString() : null;
  if (Object.keys(sources).length > 12000) throw new DomainError("BOARD_PACK_SIZE_LIMIT", "This report has too many detailed records for a single Board Pack. Saved reports remain available.", 422);
  const report: BoardPackReport = {
    schemaVersion: BOARD_PACK_VERSION, id, label, contentHash: "", project: { id: session.projectId, title: project.metadata.title || snapshot.projectTitle, templateId: project.metadata.templateId ?? "makerspace", currency: "USD", mode: session.mode },
    audience, asOf: snapshot.asOf, projectionVersion: snapshot.projectionVersion, eventCursor: snapshot.eventCursor, semanticVersion: snapshot.semanticVersion, datasetVersions: snapshot.datasetVersions,
    data: snapshot.data, packages, geometry: snapshot.geometry, geometrySource: snapshot.geometrySource ?? null,
    totals: { ...boardPackScopedTotals(snapshot.data, audience), project: { budgetMinor: total(snapshot.data.packages, p => p.budgetMinor), currentCollectedMinor: total(projection.positions, p => p.collectedMinor), eligibleMinor: total(projection.positions, p => p.fundingEligibleMinor), unpaidCommitmentMinor: total(packages, p => p.unpaidCommitmentMinor), acceptedSponsorUnpaidMinor: total(packages, p => p.acceptedSponsorUnpaidMinor), returnedMinor: total(projection.positions, p => p.refundedMinor), pendingReturnMinor: total(projection.positions, p => p.pendingRefundMinor), reservedMinor: total(projection.positions, p => p.reservedMinor), paidMinor: total(projection.positions, p => p.paidMinor), availableMinor: total(projection.positions, p => p.availableMinor), approvedExpenseMinor: total(snapshot.data.packages, p => p.approvedExpenseMinor), deliveredPrincipalMinor: total(snapshot.data.packages, p => p.paidExpenseMinor), paidFeeMinor: minor(fees.find(f => f.state === "paid")?.amount ?? 0), reservedFeeMinor: minor(fees.find(f => f.state === "reserved")?.amount ?? 0), acceptedWorkItems: total(snapshot.data.packages, p => p.reviewedItemCount), requiredWorkItems: total(snapshot.data.packages, p => p.requiredItemCount), acceptedPackages: snapshot.data.packages.filter(p => p.requiredItemCount > 0 && p.reviewedItemCount >= p.requiredItemCount && ["accepted", "accepted_within_scope", "sample_review_complete"].includes(p.workState)).length, packageCount: snapshot.data.packages.length } },
    assignments, expenses, reviewedImages: Object.entries(sources).flatMap(([sourceId, entry]) => entry.image ? [{ sourceId, width: entry.image.width, height: entry.image.height, alt: entry.detail.source.label, contentHash: entry.image.hash }] : []), balance, sources: Object.values(sources).map(s => s.detail.source), notices: [audience.detail, ...snapshot.notices,
      "This is one immutable database cutoff. Source observations may be earlier; every source retains its own recorded time. A later change makes this report historical.",
      "Original receipts show observed gross, credit and returns once. Current-purpose positions show where the remaining credit belongs. Purpose changes do not create new payments; these two tables must never be added together.",
      "Project totals cover all packages. Detailed receipts and expenses are separately limited to this audience. Counts and totals over those detail tables are not project-wide for a supporter or volunteer.",
      "Unpaid commitments are calculated from the current original pledge contracts and their own collected amounts. They are not historical pledges minus current-purpose collection. Accepted sponsor promises are included in unpaid commitments, never added again as cash.",
      "Paid principal, actual recorded fees, pending uses, returns, exclusions and excess liabilities remain distinct. Gross receipt and uncommitted accounting amounts are not a verified net merchant balance or permission to spend.",
      "Work coverage counts accepted requirements against each package's recorded denominator. A receipt, image association or Sample review does not by itself establish installation, safety or community impact.",
      "Exception affected amounts can overlap. This report does not claim full financial reconciliation or a 100% provider coverage result.",
      "Private report access is rechecked when opened, printed or exported. Withdrawn source permissions can remove the report from this view; prior downloaded or printed copies cannot be recalled.",
      session.mode === "sample" ? "Sample workspace: financial and work records are fictional controlled examples. No real payment, independent person or completed physical work is established." : "Live Sandbox workspace: only stored provider observations establish sandbox payment outcomes. This report makes no new provider or model call." ],
  };
  // The hash covers the exact disclosed report and its source-detail records,
  // including asset hashes; private revocation bindings stay encrypted at rest.
  report.contentHash = sha256(canonicalJson({ report: { ...report, contentHash: undefined }, sources }));
  return { report, sources, bindings, sourceHash: await boardPackSourceHash(session, tx) };
}
