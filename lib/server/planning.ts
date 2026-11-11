import { randomUUID } from "node:crypto";
import type { SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import { DomainError } from "../domain/money";
import { packagePositionTotals } from "../domain/funding-positions";
import { publishPlanSchema, reviewPlanSchema, savePlanSchema, type PlanningWorkspace, type ProposedPlan } from "../planning/contracts";
import { validatePlan } from "../planning/geometry";
import { solveScenario, type FundingPool } from "../planning/solver";
import type { Session } from "./auth";
import { database, query } from "./db";
import { requireCurrentRole } from "./membership";
import { readFundingProjection } from "./funding-positions";
import { sealPrivate } from "./private-values";
import { appendEvent } from "./repository";
import { alignmentViews, packageReadiness, qualificationViews, signoffViews } from "./planning-evidence";
import { planRuns, requireModelProposal } from "./planning-extraction";
import { planningQaEnabled } from "./planning-sources";
import { permittedReviewerScopes, reviewerAccessViews } from "./planning-reviewer-access";
import { currentSourceCheck, expectedHead, insertPlan, lockPlanningAuthority, packageBindings, planPayload, planReviewContext, planVersionView, planningAction, planningHash,
  planningHead, publishedPlan, requirePlan, sourcesView, type PlanReviewRow, type PlanRow } from "./planning-store";

export async function planningFunding(session: Pick<Session, "tenantId" | "projectId" | "mode">, tx: SqlConnection) {
  const packages = await packageBindings(session.projectId, tx);
  const funding = await readFundingProjection({tenantId:session.tenantId,projectId:session.projectId,provenance:session.mode},tx);
  const closedPackages=new Set((await query<{id:string}>("SELECT id FROM fp_packages WHERE project_id=$1 AND data->>'fundingState'='cancelled'",[session.projectId],tx)).map(p=>p.id));
  const rounds = await query<{ package_id: string; package_version: number; state: string }>("SELECT package_id,package_version,state FROM fp_collection_rounds WHERE tenant_id=$1 AND project_id=$2 ORDER BY collection_started_at DESC", [session.tenantId, session.projectId], tx);
  return packages.map(pkg => {
    const totals = packagePositionTotals(funding.positions,pkg.packageId,pkg.budgetMinor);
    const round = rounds.find(r => r.package_id === pkg.packageId && r.package_version === pkg.version);
    const complete = !closedPackages.has(pkg.packageId) && !["compensating","cancelled"].includes(round?.state??"") && totals.shortfallMinor === 0 && (session.mode === "sample" || round?.state === "funded");
    return { packageId: pkg.packageId, collectedMinor: totals.collectedMinor, eligibleMinor: complete ? funding.positions.filter(p=>p.packageId===pkg.packageId).reduce((sum,p)=>sum+p.availableMinor,0) : 0, complete };
  });
}
export async function readPlanningWorkspace(session: Session): Promise<PlanningWorkspace> {
  return database().transaction(async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { membershipVersion } = await requireCurrentRole(session, session.role, tx);
    const [membership] = await query<{ roles: Session["role"][] }>("SELECT roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3", [session.tenantId, session.projectId, session.actorId], tx);
    const [project] = await query<{ title: string; projection_version: number; as_of: Date; template_id: import("../community/templates").TemplateId; mode: Session["mode"] }>("SELECT p.metadata->>'subtitle' AS title,COALESCE(p.metadata->>'templateId','makerspace') AS template_id,p.projection_version,transaction_timestamp() AS as_of,t.mode FROM fp_projects p JOIN fp_tenants t ON t.id=p.tenant_id WHERE p.id=$1 AND p.tenant_id=$2", [session.projectId, session.tenantId], tx);
    if (!project || project.mode !== session.mode) throw new DomainError("PROJECT_NOT_FOUND", "This planning workspace is unavailable.", 404);
    const head = await planningHead(session, tx), publication = await publishedPlan(session, tx);
    const current = session.role === "organizer" && head.current_plan_id ? await planVersionView(await requirePlan(session, head.current_plan_id, tx), tx) : null;
    const allAlignments = await alignmentViews(session, tx, true), allSignoffs = await signoffViews(session, tx, true);
    const funding = await planningFunding(session, tx);
    const rows = session.role === "organizer" ? await query<PlanRow & { reviewed: boolean }>("SELECT p.*,EXISTS(SELECT 1 FROM fp_plan_reviews r WHERE r.plan_id=p.id) AS reviewed FROM fp_plan_versions p WHERE tenant_id=$1 AND project_id=$2 ORDER BY revision DESC LIMIT 100", [session.tenantId, session.projectId], tx) : [];
    return { role: session.role, allowedRoles: membership.roles, mode: session.mode, projectId: session.projectId, projectTitle: project.title, templateId: project.template_id, headVersion: head.version, projectionVersion: project.projection_version, asOf: project.as_of.toISOString(),
      scope: planningHash({ tenantId: session.tenantId, projectId: session.projectId, actorId: session.actorId, role: session.role, membershipVersion }),
      sources: await sourcesView(session, tx), current, published: publication?.view ?? null,
      history: rows.map(row => ({ id: row.id, revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at.toISOString(), origin: row.origin, reviewed: row.reviewed })),
      packages: await packageBindings(session.projectId, tx), runs: await planRuns(session, tx),
      alignments: allAlignments.filter(a => a.documentId !== null || (a.state === "reviewed" && a.imageSharing === "project_members" && a.previewUrl !== null)),
      qualifications: await qualificationViews(session, tx), signoffs: session.role === "donor" ? [] : allSignoffs,
      reviewerAccess: await reviewerAccessViews(session, tx), permittedReviewScopes: ["organizer", "volunteer"].includes(session.role) ? await permittedReviewerScopes(session, tx) : [],
      readiness: packageReadiness(publication?.payload ?? null, publication?.view.state === "current", allAlignments, allSignoffs, funding.filter(f => f.complete).map(f => f.packageId)),
      modelConfigured: { openai: Boolean(process.env.OPENAI_API_KEY && (process.env.OPENAI_LAYOUT_MODEL || process.env.OPENAI_MODEL)), gemini: Boolean(process.env.GEMINI_API_KEY && (process.env.GEMINI_LAYOUT_MODEL || process.env.GEMINI_MODEL)) },
      storageConfigured: Boolean(process.env.BLOB_READ_WRITE_TOKEN) || planningQaEnabled(), uploadMode: planningQaEnabled() ? "isolated_local" : "private_blob" };
  });
}
export async function readPlanningVersion(session: Session, id: string) {
  return database().transaction(async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await requireCurrentRole(session, "organizer", tx);
    return planVersionView(await requirePlan(session, id, tx), tx);
  });
}
export async function savePlan(session: Session, raw: z.infer<typeof savePlanSchema>): Promise<{ id: string; headVersion: number }> {
  const input = savePlanSchema.parse(raw);
  return database().transaction(async tx => {
    await lockPlanningAuthority(session, ["organizer"], tx);
    return planningAction(session, input.intentId, "plan-save", input, tx, async () => {
      const head = await planningHead(session, tx, true); expectedHead(head, input.expectedVersion);
      if (input.origin === "sample" && session.mode !== "sample") throw new DomainError("SAMPLE_PLAN_ONLY", "Use a sample workspace for the illustrated template.", 422);
      if (input.origin === "model" && !input.sourceRunId) throw new DomainError("MODEL_LINEAGE_REQUIRED", "A model proposal needs its actual completed run.", 422);
      if (input.sourceRunId) {
        const proposal = await requireModelProposal(session, input.sourceRunId, tx);
        if (input.origin === "model" && planningHash(proposal.proposal) !== planningHash(input.plan)) throw new DomainError("MODEL_PROPOSAL_CHANGED", "Label the edited version as your manual review of the model proposal.", 422);
        if (input.plan.sourceDocumentId !== proposal.proposal.sourceDocumentId) throw new DomainError("MODEL_SOURCE_CHANGED", "This edited version must retain the model's original sketch. Use a new manual draft for another source.", 422);
      }
      const row = await insertPlan(session, head, input.plan, input.origin, input.sourceRunId, tx);
      await appendEvent(tx, session, "planning.draft_saved", "A new plan revision was saved", `Revision ${row.revision} preserves its source and geometry hashes. Existing package payment commitments are unchanged.`);
      return { id: row.id, headVersion: head.version + 1 };
    });
  });
}
export async function reviewPlan(session: Session, raw: z.infer<typeof reviewPlanSchema>): Promise<{ reviewId: string; headVersion: number }> {
  const input = reviewPlanSchema.parse(raw);
  return database().transaction(async tx => {
    const membershipVersion = await lockPlanningAuthority(session, ["organizer"], tx);
    return planningAction(session, input.intentId, "plan-review", input, tx, async () => {
      const head = await planningHead(session, tx, true); expectedHead(head, input.expectedVersion);
      if (head.current_plan_id !== input.planId) throw new DomainError("PLAN_VERSION_CHANGED", "Only the current saved revision can be reviewed.", 409);
      const row = await requirePlan(session, input.planId, tx), data = planPayload(row);
      if (row.content_hash !== input.contentHash) throw new DomainError("PLAN_HASH_CHANGED", "The review must name the exact plan contents.", 409);
      const sourcesChanged = await currentSourceCheck(session, data.sources, tx, true), packages = await packageBindings(session.projectId, tx, true);
      if (sourcesChanged.length || planningHash(packages) !== row.package_hash) throw new DomainError("PLAN_CONTEXT_CHANGED", "A source or package changed. Save a new revision against the current plan before review.", 409);
      if (input.decision === "approved") {
        const validation = validatePlan(data.plan, data.sources, packages.map(p => p.packageId), true);
        if (!validation.publishable) throw new DomainError("PLAN_REVIEW_INCOMPLETE", "Resolve the geometry, source links, and package reviews before approving this version.", 422);
        assertBudgetUnchanged(data.plan, packages);
      }
      const id = randomUUID();
      const [prior] = await query<{ id: string }>("SELECT id FROM fp_plan_reviews WHERE plan_id=$1", [row.id], tx);
      if (prior) throw new DomainError("PLAN_REVIEW_RECORDED", "This revision already has a review. Save a new revision to make another decision.", 409);
      await tx.query("INSERT INTO fp_plan_reviews(id,plan_id,tenant_id,project_id,actor_id,membership_version,decision,content_hash,encrypted_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [id, row.id, session.tenantId, session.projectId, session.actorId, membershipVersion, input.decision, row.content_hash, sealPrivate({ note: input.note }, planReviewContext({ id, tenant_id: session.tenantId, project_id: session.projectId }))]);
      await tx.query("UPDATE fp_planning_heads SET version=version+1,updated_at=now() WHERE project_id=$1 AND tenant_id=$2", [session.projectId, session.tenantId]);
      await appendEvent(tx, session, "planning.plan_reviewed", input.decision === "approved" ? "The source plan passed its review" : "The plan needs another pass", `Revision ${row.revision} has a recorded organizer decision. This reviews the plan; it does not certify installed work.`);
      return { reviewId: id, headVersion: head.version + 1 };
    });
  });
}
function assertBudgetUnchanged(plan: ProposedPlan, packages: Awaited<ReturnType<typeof packageBindings>>) {
  if (plan.packages.some(p => packages.find(b => b.packageId === p.packageId)?.budgetMinor !== p.budgetMinor)) throw new DomainError("PACKAGE_BUDGET_REVIEW_REQUIRED", "A quote differs from an approved package budget. Keep the proposal for comparison; a separate package and donor-consent revision is required before that amount can replace the current plan.", 409);
}
export async function publishReviewedPlan(session: Session, raw: z.infer<typeof publishPlanSchema>): Promise<{ publicationId: string; headVersion: number }> {
  const input = publishPlanSchema.parse(raw);
  return database().transaction(async tx => {
    await lockPlanningAuthority(session, ["organizer"], tx);
    return planningAction(session, input.intentId, "plan-publication", input, tx, async () => {
      const head = await planningHead(session, tx, true); expectedHead(head, input.expectedVersion);
      if (head.current_plan_id !== input.planId) throw new DomainError("PLAN_VERSION_CHANGED", "Review the current saved revision before making it the shared plan.", 409);
      const row = await requirePlan(session, input.planId, tx), data = planPayload(row);
      if (row.content_hash !== input.contentHash) throw new DomainError("PLAN_HASH_CHANGED", "This publication does not match the reviewed contents.", 409);
      const [review] = await query<PlanReviewRow>("SELECT * FROM fp_plan_reviews WHERE id=$1 AND plan_id=$2 AND tenant_id=$3 AND project_id=$4", [input.reviewId, row.id, session.tenantId, session.projectId], tx);
      if (!review || review.decision !== "approved" || review.content_hash !== row.content_hash) throw new DomainError("PLAN_APPROVAL_REQUIRED", "An organizer must approve this exact saved revision first.", 409);
      const [reviewer] = await query<{ state: string; version: number; roles: string[] }>("SELECT state,version,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 FOR SHARE", [session.tenantId, session.projectId, review.actor_id], tx);
      if (!reviewer || reviewer.state !== "active" || reviewer.version !== review.membership_version || !reviewer.roles.includes("organizer")) throw new DomainError("PLAN_REVIEW_AUTHORITY_CHANGED", "The organizer's authority changed after review. Save and review a current revision.", 403);
      const packages = await packageBindings(session.projectId, tx, true);
      if ((await currentSourceCheck(session, data.sources, tx, true)).length || planningHash(packages) !== row.package_hash) throw new DomainError("PLAN_CONTEXT_CHANGED", "A source or package changed after review. A new revision is required.", 409);
      if (!validatePlan(data.plan, data.sources, packages.map(p => p.packageId), true).publishable) throw new DomainError("PLAN_REVIEW_INCOMPLETE", "The reviewed plan no longer passes its deterministic checks.", 422);
      assertBudgetUnchanged(data.plan, packages);
      const id = randomUUID();
      await tx.query("UPDATE fp_plan_publications SET state='superseded' WHERE tenant_id=$1 AND project_id=$2 AND state='active'", [session.tenantId, session.projectId]);
      await tx.query("INSERT INTO fp_plan_publications(id,tenant_id,project_id,plan_id,review_id,actor_id,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, session.tenantId, session.projectId, row.id, review.id, session.actorId, row.content_hash]);
      await tx.query("UPDATE fp_planning_heads SET publication_id=$3,version=version+1,updated_at=now() WHERE project_id=$1 AND tenant_id=$2", [session.projectId, session.tenantId, id]);
      await appendEvent(tx, session, "planning.plan_published", "The workspace has a reviewed shared plan", `Plan revision ${row.revision} is current for this project's members. Originals remain private. Public Proof Page publication is a separate redaction review.`);
      return { publicationId: id, headVersion: head.version + 1 };
    });
  });
}
export const revokePlanSchema = z.object({ intentId: z.uuid(), expectedVersion: z.number().int().min(1), publicationId: z.uuid(), reason: z.string().trim().min(8).max(1000) }).strict();
export async function revokePublishedPlan(session: Session, raw: z.infer<typeof revokePlanSchema>): Promise<void> {
  const input = revokePlanSchema.parse(raw);
  await database().transaction(async tx => {
    await lockPlanningAuthority(session, ["organizer"], tx);
    await planningAction(session, input.intentId, "plan-revoke", input, tx, async () => {
      const head = await planningHead(session, tx, true); expectedHead(head, input.expectedVersion);
      if (head.publication_id !== input.publicationId) throw new DomainError("PLAN_PUBLICATION_CHANGED", "The shared plan changed. Refresh before withdrawing it.", 409);
      await tx.query("UPDATE fp_plan_publications SET state='revoked',revoked_at=now() WHERE id=$1 AND tenant_id=$2 AND project_id=$3", [input.publicationId, session.tenantId, session.projectId]);
      await tx.query("UPDATE fp_planning_heads SET version=version+1,updated_at=now() WHERE project_id=$1 AND tenant_id=$2", [session.projectId, session.tenantId]);
      await appendEvent(tx, session, "planning.plan_withdrawn", "The shared plan was withdrawn for review", "Its immutable history remains private. Dependent image associations and physical reviews no longer count as current.");
      return { publicationId: input.publicationId };
    });
  });
}
export const scenarioSchema = z.object({ planId: z.uuid(), requestedIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).min(1).max(20),
  basis: z.enum(["prospective", "observed"]), prospectiveBudgetMinor: z.number().int().min(0).max(100000000).nullable() }).strict();
export async function planningScenario(session: Session, raw: z.infer<typeof scenarioSchema>) {
  const input = scenarioSchema.parse(raw);
  return database().transaction(async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await requireCurrentRole(session, session.role, tx);
    const head = await planningHead(session, tx), publication = await publishedPlan(session, tx);
    const isDraft = session.role === "organizer" && input.planId === head.current_plan_id;
    if (!isDraft && (publication?.row.id !== input.planId || publication.view.state !== "current")) throw new DomainError("SCENARIO_PLAN_UNAVAILABLE", "Choose the current shared plan for this scenario.", 403);
    const row = isDraft ? await requirePlan(session, input.planId, tx) : publication!.row, payload = planPayload(row);
    const sourcesChanged = await currentSourceCheck(session, payload.sources, tx);
    if (sourcesChanged.length || planningHash(await packageBindings(session.projectId, tx)) !== row.package_hash) throw new DomainError("SCENARIO_PLAN_STALE", "Refresh the source plan before comparing what it can deliver.", 409);
    const funding = await planningFunding(session, tx);
    if (input.basis === "prospective" && input.prospectiveBudgetMinor === null) throw new DomainError("SCENARIO_BUDGET_REQUIRED", "Enter a budget for this prospective scenario.", 422);
    const ids = payload.plan.packages.map(p => p.packageId);
    const pools: FundingPool[] = input.basis === "observed" ? funding.map(f => ({ id: f.packageId, amountMinor: f.eligibleMinor, allowedPackageIds: [f.packageId] }))
      : [{ id: "prospective-budget", amountMinor: input.prospectiveBudgetMinor!, allowedPackageIds: ids }];
    let result: ReturnType<typeof solveScenario>;
    try { result = solveScenario(payload.plan.packages.map(p => ({ id: p.packageId, title: p.title, costMinor: p.budgetMinor, capabilities: p.capabilities, available: true })), payload.plan.dependencies, input.requestedIds, pools); }
    catch (error) { throw new DomainError("SCENARIO_GRAPH_INVALID", error instanceof Error ? error.message : "This dependency graph cannot be solved.", 422); }
    const [clock] = await query<{ as_of: Date }>("SELECT transaction_timestamp() AS as_of", [], tx);
    const asOf = clock.as_of.toISOString();
    return { ...result, planId: row.id, planRevision: row.revision, planHash: row.content_hash, asOf, basis: input.basis, planReviewed: !!publication && publication.row.id === row.id && publication.view.state === "current",
      sourceHash: planningHash({ input, planHash: row.content_hash, pools, asOf }), providerLiquidity: "not_checked" as const,
      notice: input.basis === "prospective" ? "A proposed budget comparison. It does not change commitments, collect money, or approve spending." : "Eligible support stays with its current packages. Provider available funds and a separate spending approval are still required." };
  });
}
