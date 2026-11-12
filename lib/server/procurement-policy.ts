import type { AlignmentView } from "../planning/contracts";
import type { PlanPayload } from "./planning-store";
import { projectPolicyPlanIssues, type ActiveProjectRule } from "./project-policy";

/** Prospective compatibility only. This never marks a policy applied, creates
 * a consumer binding or reinterprets an original funding/physical approval. */
export function procurementPolicyIssues(packageId: string, payload: PlanPayload | null, rules: ActiveProjectRule[], alignments: AlignmentView[], decisions: { packageId: string; sourceProvenance: ("user_upload" | "sample_document")[] }[]): string[] {
  const relevant = rules.filter(rule => rule.document.compiled.packageIds.includes(packageId));
  if (!relevant.length) return [];
  if (!payload) return ["Current project-owned rules need a current reviewed plan before this new operational decision."];
  const issues = projectPolicyPlanIssues(payload.plan, relevant).map(issue => issue.message);
  for (const rule of relevant) {
    const definition = rule.document.rule.definition;
    if (definition.kind !== "evidence_policy") continue;
    const sources = new Set([payload.plan.sourceDocumentId, ...payload.plan.packages.filter(pkg => pkg.packageId === packageId).flatMap(pkg => pkg.quoteCitationIds).map(id => payload.plan.citations.find(citation => citation.id === id)?.documentId).filter((id): id is string => !!id)]);
    if (payload.sources.some(source => sources.has(source.documentId) && !definition.allowedSourceProvenance.includes(source.provenance))) issues.push("The current plan source classes do not meet a prospective copied project evidence rule. Review a compliant new plan; old source history is retained.");
    if (alignments.some(image => image.packageId === packageId && image.state === "reviewed" && (!definition.allowedSourceProvenance.includes(image.sourceClass === "sample_illustration" ? "sample_document" : "user_upload") || definition.maximumImageSharing === "reviewers_only" && image.imageSharing === "project_members"))) issues.push("A recorded image association does not meet the current project-owned source or sharing rule for a new decision. Its original review remains history.");
    if (decisions.some(decision => decision.packageId === packageId && decision.sourceProvenance.some(source => !definition.allowedSourceProvenance.includes(source)))) issues.push("A recorded physical decision uses source classes outside a current project-owned rule for a new decision. Keep its original history and obtain a compliant current review.");
  }
  return [...new Set(issues)];
}
