import { z } from "zod";
import type { DocumentView, ExtractedReceipt, ExtractionValidation } from "./evidence";
import { DomainError } from "./money";

export type ClaimState = "draft" | "submitted" | "needs_review" | "reviewed" | "approved" | "paying" | "payout_review" | "partially_paid" | "paid" | "rejected";
export interface ClaimLine {
  id: string;
  description: string;
  sourceIndex: number | null;
  sourceRegion: ExtractedReceipt["lines"][number]["sourceRegion"];
  extractedMinor: number | null;
  requestedMinor: number;
  packageId: string | null;
  needsAttention: boolean;
  attentionReason: string | null;
  decision: "unreviewed" | "approved" | "hold" | "rejected";
  reviewedSourceMinor: number | null;
  approvedMinor: number;
  receiptLineKey: string;
  reviewNote: string | null;
}
export interface ClaimPrivateData {
  title: string;
  note: string;
  sourceHash: string;
  sourceDocumentVersion: number;
  sourceOutputHash: string | null;
  extraction: ExtractedReceipt | null;
  extractionValidation: ExtractionValidation | null;
  lines: ClaimLine[];
  requesterTotalMinor: number;
  review: null | {
    sourceTotalMinor: number; note: string; reviewedAt: string; reviewerActorId: string;
    sampleAcknowledged: boolean; receiptSplit: boolean;
    currencyCorrectionNote?: string | null;
    duplicateResolutions: z.infer<typeof reviewClaimSchema>["duplicateResolutions"];
  };
}
export function claimLineAttentionReason(line: ClaimLine, extraction: ExtractedReceipt | null): string | null {
  // Earlier drafts substituted this label for a null model review reason. Keep
  // immutable revisions intact and recover the display from their original run.
  const source = line.sourceIndex === null ? null : extraction?.lines[line.sourceIndex];
  if (source && line.attentionReason === "Entered manually; compare with the source.") return source.reviewReason;
  return line.attentionReason;
}
export interface ClaimView {
  id: string; version: number; state: ClaimState; title: string; note: string;
  own: boolean; document: DocumentView; sourceRunId: string | null;
  currency: string | null; requestedMinor: number; approvedMinor: number;
  lines: ClaimLine[]; extraction: ExtractedReceipt | null; extractionValidation: ExtractionValidation | null;
  sourceOutputHash: string | null; review: ClaimPrivateData["review"];
  createdAt: string; reviewedAt: string | null;
  groupReviewedTotalMinor: number | null; groupOtherApprovedMinor: number;
}
export const draftClaimSchema = z.object({
  expectedVersion: z.number().int().positive(), title: z.string().trim().min(1).max(180), note: z.string().max(2000),
  currency: z.string().regex(/^[A-Z]{3}$/), totalMinor: z.number().int().min(0).max(100000000),
  lines: z.array(z.object({ id: z.string().regex(/^line-[0-9]{1,3}$/), description: z.string().trim().min(1).max(240),
    requestedMinor: z.number().int().min(0).max(100000000), packageId: z.string().max(64).nullable(),
  }).strict()).min(1).max(120),
}).strict();
export const reviewClaimSchema = z.object({
  expectedVersion: z.number().int().positive(), sourceTotalMinor: z.number().int().min(1).max(100000000), currency: z.literal("USD"),
  note: z.string().trim().min(8).max(2000), sourceChecked: z.literal(true), sampleAcknowledged: z.boolean(), receiptSplit: z.boolean(),
  currencyCorrectionNote: z.string().trim().min(8).max(700).optional(),
  duplicateResolutions: z.array(z.object({ documentId: z.uuid(), decision: z.enum(["same_receipt", "different_receipt"]), reason: z.string().trim().min(8).max(700) }).strict()).max(150),
  lines: z.array(z.object({ id: z.string().regex(/^line-[0-9]{1,3}$/), receiptLineKey: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    description: z.string().trim().min(1).max(240), sourceMinor: z.number().int().min(0).max(100000000),
    approvedMinor: z.number().int().min(0).max(100000000), decision: z.enum(["approved", "hold", "rejected"]),
    packageId: z.string().min(1).max(64).nullable(), reviewNote: z.string().trim().min(1).max(700), uncertaintyResolved: z.boolean(),
  }).strict()).min(1).max(120),
}).strict();

export function validateClaimReview(data: ClaimPrivateData, input: z.infer<typeof reviewClaimSchema>): number {
  const ids = new Set(input.lines.map(line => line.id)), keys = new Set(input.lines.map(line => line.receiptLineKey));
  if (ids.size !== input.lines.length || keys.size !== input.lines.length || data.lines.length !== input.lines.length || data.lines.some(line => !ids.has(line.id)))
    throw new DomainError("CLAIM_LINES_CHANGED", "Review every original claim line once. Give each purchase line its own receipt reference.", 409);
  let approved = 0, source = 0;
  for (const line of input.lines) {
    const current = data.lines.find(value => value.id === line.id)!;
    if (line.approvedMinor > line.sourceMinor) throw new DomainError("LINE_EXCEEDS_SOURCE", "A line cannot be approved for more than its reviewed source amount.", 422);
    if (line.decision === "approved" && (!line.packageId || line.approvedMinor <= 0 || !line.uncertaintyResolved)) throw new DomainError("LINE_REVIEW_REQUIRED", "Each approved line needs a package, a positive amount and an explicit resolution of uncertainty.", 422);
    if (line.decision !== "approved" && line.approvedMinor !== 0) throw new DomainError("HELD_LINE_PAYABLE", "A held or rejected line cannot carry an approved repayment amount.", 422);
    if ((current.extractedMinor !== line.sourceMinor || current.description !== line.description || current.needsAttention) && line.reviewNote.length < 8)
      throw new DomainError("CORRECTION_REASON_REQUIRED", "Explain the source correction or the uncertainty you resolved.", 422);
    source += line.sourceMinor; approved += line.approvedMinor;
  }
  if (source > input.sourceTotalMinor || approved > input.sourceTotalMinor) throw new DomainError("CLAIM_EXCEEDS_RECEIPT", "Reviewed lines cannot exceed the source receipt total. Allocate discounts and tax explicitly.", 422);
  if (new Set(input.duplicateResolutions.map(item => item.documentId)).size !== input.duplicateResolutions.length) throw new DomainError("DUPLICATE_DECISION_REPEATED", "Make one duplicate decision for each comparison.", 422);
  return approved;
}
