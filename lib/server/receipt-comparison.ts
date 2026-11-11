import { perceptualDistance, type ExtractedReceipt } from "../domain/evidence";
import type { Session } from "./auth";
import { query } from "./db";
import { requireDocument, documentView, type DocumentRow } from "./documents";
import { openPrivate } from "./private-values";

export interface ReceiptComparison {
  documentId: string; filename: string; previewUrl: string | null;
  exactByteMatch: boolean; perceptualDistance: number | null;
  ocrMatches: ("vendor" | "date" | "total" | "currency" | "receipt_number")[];
  provenance: DocumentRow["provenance"]; alignment: "not_performed";
  decision: "human_review_required";
}
const normalized = (text: string | null) => text?.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 180) ?? "";
function matchingFields(a: ExtractedReceipt | null, b: ExtractedReceipt | null): ReceiptComparison["ocrMatches"] {
  if (!a || !b) return [];
  const matches: ReceiptComparison["ocrMatches"] = [];
  if (normalized(a.vendor) && normalized(a.vendor) === normalized(b.vendor)) matches.push("vendor");
  if (normalized(a.receiptDate) && normalized(a.receiptDate) === normalized(b.receiptDate)) matches.push("date");
  if (a.totalMinor !== null && b.totalMinor !== null && a.totalMinor === b.totalMinor) matches.push("total");
  if (a.currency && a.currency === b.currency) matches.push("currency");
  if (normalized(a.receiptNumber) && normalized(a.receiptNumber) === normalized(b.receiptNumber)) matches.push("receipt_number");
  return matches;
}
async function extracted(document: DocumentRow): Promise<ExtractedReceipt | null> {
  const [run] = await query<{ id: string; encrypted_output: string }>("SELECT id,encrypted_output FROM fp_ai_runs WHERE document_id=$1 AND tenant_id=$2 AND project_id=$3 AND status='succeeded' AND kind='receipt' ORDER BY completed_at DESC,id LIMIT 1", [document.id, document.tenant_id, document.project_id]);
  return run ? openPrivate<{ extraction: ExtractedReceipt }>(run.encrypted_output, `ai-run:${document.tenant_id}:${document.project_id}:${run.id}`).extraction : null;
}
export async function receiptComparisons(session: Session, documentId: string): Promise<ReceiptComparison[]> {
  const current = await requireDocument(session, documentId);
  if (current.state !== "ready" || current.purpose !== "receipt") return [];
  const rows = await query<DocumentRow>("SELECT * FROM fp_documents WHERE tenant_id=$1 AND project_id=$2 AND id<>$3 AND state='ready' AND purpose='receipt' AND ($4::boolean OR actor_id=$5) ORDER BY created_at DESC LIMIT 150", [session.tenantId, session.projectId, documentId, session.role === "organizer", session.actorId]);
  const original = await extracted(current), comparisons: ReceiptComparison[] = [];
  for (const row of rows) {
    const distance = current.perceptual_hash && row.perceptual_hash ? perceptualDistance(current.perceptual_hash, row.perceptual_hash) : null;
    const exactByteMatch = !!current.sha256 && current.sha256 === row.sha256;
    const ocrMatches = matchingFields(original, await extracted(row));
    if (!exactByteMatch && !(distance !== null && distance <= 10) && !(ocrMatches.includes("total") && ocrMatches.includes("currency") && (ocrMatches.includes("vendor") || ocrMatches.includes("receipt_number")))) continue;
    const view = documentView(row);
    comparisons.push({ documentId: row.id, filename: view.filename, previewUrl: view.pages[0]?.previewUrl ?? null,
      exactByteMatch, perceptualDistance: distance, ocrMatches, provenance: row.provenance,
      alignment: "not_performed", decision: "human_review_required" });
  }
  return comparisons.sort((a, b) => Number(b.exactByteMatch) - Number(a.exactByteMatch) || b.ocrMatches.length - a.ocrMatches.length || (a.perceptualDistance ?? 65) - (b.perceptualDistance ?? 65));
}
