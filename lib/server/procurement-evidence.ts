import type { SqlConnection } from "@fracture/paypal-core";
import type { AlignmentView, PlanSourceBinding, SignoffView } from "../planning/contracts";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { query } from "./db";
import { openPrivate } from "./private-values";
import { planningHash, type publishedPlan } from "./planning-store";
import { scopeValues } from "./procurement-store";

/** Exact positive bindings stay internal. No source/qualification/actor IDs or
 * private statements from this sidecar are added to the client fact tables. */
export async function procurementEvidenceDependencies(tx: SqlConnection, scope: Pick<Session, "tenantId" | "projectId">, publication: Awaited<ReturnType<typeof publishedPlan>>, alignments: AlignmentView[], signoffs: SignoffView[]) {
  const documents = new Map<string, PlanSourceBinding>(), images: { id: string; contentHash: string }[] = [], decisions: { id: string; packageId: string; contentHash: string; qualificationId: string; qualificationVersion: number; sourceProvenance: PlanSourceBinding["provenance"][] }[] = [];
  function add(binding: PlanSourceBinding) { const existing = documents.get(binding.documentId); if (existing && planningHash(existing) !== planningHash(binding)) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "A counted evidence source has conflicting original bindings.", 409); documents.set(binding.documentId, binding); }
  if (!publication || publication.view.state !== "current") return { documents: [], images, decisions };
  publication.payload.sources.forEach(add);
  const imageIds = alignments.filter(row => row.state === "reviewed" && publication.payload.plan.packages.some(pkg => pkg.packageId === row.packageId && pkg.requirements.some(requirement => requirement.kind === "photo_association"))).map(row => row.id);
  const imageRows = imageIds.length ? await query<{ id: string; content_hash: string; encrypted_data: string }>("SELECT id,content_hash,encrypted_data FROM fp_photo_alignments WHERE tenant_id=$1 AND project_id=$2 AND id=ANY($3::text[]) ORDER BY id", [...scopeValues(scope), imageIds], tx) : [];
  for (const row of imageRows) { const data = openPrivate<{ source: PlanSourceBinding }>(row.encrypted_data, `photo-alignment:${scope.tenantId}:${scope.projectId}:${row.id}`); if (planningHash(data) !== row.content_hash) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "A counted image association failed its original content hash.", 409); add(data.source); images.push({ id: row.id, contentHash: row.content_hash }); }
  const ids = signoffs.filter(row => row.current && row.decision === "accepted" && publication.payload.plan.packages.some(pkg => pkg.packageId === row.packageId && pkg.requirements.some(requirement => requirement.id === row.requirementId && requirement.kind !== "photo_association" && requirement.scope === row.scope))).map(row => row.id);
  const rows = ids.length ? await query<{ id: string; package_id: string; content_hash: string; encrypted_data: string; qualification_id: string; qualification_version: number }>("SELECT id,package_id,content_hash,encrypted_data,qualification_id,qualification_version FROM fp_work_signoffs WHERE tenant_id=$1 AND project_id=$2 AND id=ANY($3::text[]) ORDER BY id", [...scopeValues(scope), ids], tx) : [];
  for (const row of rows) {
    const data = openPrivate<{ sourceBindings: PlanSourceBinding[] }>(row.encrypted_data, `work-signoff:${scope.tenantId}:${scope.projectId}:${row.id}`); if (planningHash(data) !== row.content_hash) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "A counted physical decision failed its original content hash.", 409); data.sourceBindings.forEach(add);
    const [qualification] = await query<{ version: number; encrypted_data: string }>("SELECT version,encrypted_data FROM fp_reviewer_qualifications WHERE tenant_id=$1 AND project_id=$2 AND id=$3", [...scopeValues(scope), row.qualification_id], tx);
    if (!qualification || qualification.version !== row.qualification_version) throw new DomainError("PROCUREMENT_BASIS_CHANGED", "The counted physical decision's original qualification version changed.", 409);
    const qualificationData = openPrivate<{ source: PlanSourceBinding }>(qualification.encrypted_data, `reviewer-qualification:${scope.tenantId}:${scope.projectId}:${row.qualification_id}`); add(qualificationData.source); decisions.push({ id: row.id, packageId: row.package_id, contentHash: row.content_hash, qualificationId: row.qualification_id, qualificationVersion: row.qualification_version, sourceProvenance: data.sourceBindings.map(source => source.provenance) });
  }
  return { documents: [...documents.values()].sort((a, b) => a.documentId.localeCompare(b.documentId)), images, decisions };
}
