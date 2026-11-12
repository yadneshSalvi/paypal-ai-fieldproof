import { randomUUID } from "node:crypto";
import type { TemplateId } from "../../lib/community/templates";
import { samplePlan } from "../../lib/planning/templates";
import { communityFixture } from "./community";
import { memoryStorage, publishFixture } from "./planning";
import { importSamplePlanningSources } from "../../lib/server/planning-sources";
import { packageBindings } from "../../lib/server/planning-store";
import { readPlanningWorkspace } from "../../lib/server/planning";
import type { Session } from "../../lib/server/auth";
import { database, query } from "../../lib/server/db";
import { requireCurrentRole } from "../../lib/server/membership";
import { sampleReceipt } from "../../lib/server/seed";
import { recordSampleOrigin } from "../../lib/server/sample-funding-origins";

/** Ordinary Sample entry plus explicitly controlled source imports. This helper
 * creates no provider call, independent participant, credential or work claim. */
export async function procurementWorkspaceFixture(templateId: TemplateId = "makerspace", publish = true) {
  const workspace = await communityFixture(templateId), { storage, files } = memoryStorage();
  if (templateId !== "makerspace") return { workspace, storage, files, planning: null };
  await importSamplePlanningSources(workspace.session, randomUUID(), storage);
  const view = await readPlanningWorkspace(workspace.session), sources = view.sources;
  const sketch = sources.find(source => source.purpose === "sketch")!, quote = sources.find(source => source.purpose === "quote")!, photo = sources.find(source => source.purpose === "photo")!, credential = sources.find(source => source.purpose === "signoff")!;
  const plan = samplePlan(sketch.id, quote.id, await packageBindings(workspace.session.projectId));
  plan.assumptions = ["Controlled Sample planning source and internal review only. No independent human review, actual supplier response or physical work is represented."];
  plan.zones.forEach(zone => zone.reviewState = "reviewed"); plan.packages.forEach(pkg => pkg.reviewState = "reviewed");
  const planning = { session: workspace.session, storage, files, sources, sketch, quote, photo, credential, plan };
  if (publish) await publishFixture(planning);
  return { workspace, storage, files, planning };
}
/** Explicit fictional stored contribution in this test's already-created
 * Sample workspace. It is neither a provider call nor a donor-payment claim. */
export async function procurementSampleReceipt(project: Pick<Session, "tenantId" | "projectId" | "mode">, donor: Session, packageId: string, amountMinor: number) {
  if (project.mode !== "sample" || donor.mode !== "sample" || donor.tenantId !== project.tenantId || donor.projectId !== project.projectId) throw new Error("A fictional receipt needs the exact owned Sample project and donor grant.");
  const obligationId = randomUUID(), receipt = sampleReceipt(project.tenantId, project.projectId, obligationId, packageId, amountMinor, randomUUID()); receipt.observedAt = new Date().toISOString();
  await database().transaction(async tx => {
    await requireCurrentRole(donor, "donor", tx);
    const [pkg] = await query<{ version: number; data: { title: string; description: string } }>("SELECT version,data FROM fp_packages WHERE project_id=$1 AND id=$2", [project.projectId, packageId], tx); if (!pkg) throw new Error("The controlled receipt target must exist in this exact test project.");
    await tx.query("INSERT INTO fp_obligations(id,tenant_id,project_id,package_id,actor_id,amount_minor,channel,purpose,data) VALUES($1,$2,$3,$4,$5,$6,'collected','conditional_pledge',$7::jsonb)", [obligationId, project.tenantId, project.projectId, packageId, donor.actorId, amountMinor, JSON.stringify({ donorLabel: "Controlled fictional procurement funding source", consentPolicy: "Sample only; no provider authorization, independent human or actual contribution is claimed." })]);
    await recordSampleOrigin(tx, { tenantId: project.tenantId, projectId: project.projectId, obligationId, packageId, packageVersion: pkg.version, donorActorId: donor.actorId, amountMinor, title: pkg.data.title, purpose: pkg.data.description });
    await tx.query("INSERT INTO fp_settlement_receipts(id,tenant_id,project_id,obligation_id,package_id,provider_ref,provenance,data) VALUES($1,$2,$3,$4,$5,$6,'sample',$7::jsonb)", [receipt.id, project.tenantId, project.projectId, obligationId, packageId, receipt.actualProviderPaymentRef, JSON.stringify(receipt)]);
    await tx.query("INSERT INTO fp_economic_aliases(merchant_scope,alias,receipt_id) VALUES($1,$2,$3)", [project.tenantId, receipt.economicAliases[0], receipt.id]);
  }); return receipt;
}
