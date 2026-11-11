import { z } from "zod";

export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENT_PAGES = 12;
export const RECEIPT_PROMPT_VERSION = "receipt-review-v2";
export const documentPurposeSchema = z.enum(["receipt", "photo", "signoff", "quote", "sketch"]);
export const documentContentTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export const newDocumentSchema = z.object({
  intentId: z.uuid(),
  filename: z.string().trim().min(1).max(180).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
  contentType: z.enum(documentContentTypes),
  size: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  purpose: documentPurposeSchema,
  permissionConfirmed: z.literal(true),
}).strict();

export interface DocumentView {
  id: string;
  filename: string;
  purpose: z.infer<typeof documentPurposeSchema>;
  provenance: "user_upload" | "sample_document";
  state: "awaiting_upload" | "validating" | "ready" | "rejected";
  version: number;
  contentType: string;
  size: number;
  contentHash: string;
  uploadPathname: string | null;
  pageCount: number | null;
  code: string | null;
  createdAt: string;
  pages: { number: number; width: number; height: number; previewUrl: string }[];
}

const region = z.object({
  page: z.number().int().min(1).max(MAX_DOCUMENT_PAGES),
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1),
}).strict();
// All amounts are integer minor units. Null means unreadable, never an inferred zero.
export const extractedReceiptSchema = z.object({
  vendor: z.string().max(180).nullable(),
  receiptDate: z.string().max(80).nullable(),
  receiptNumber: z.string().max(120).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  subtotalMinor: z.number().int().min(-100000000).max(100000000).nullable(),
  taxMinor: z.number().int().min(-100000000).max(100000000).nullable(),
  totalMinor: z.number().int().min(0).max(100000000).nullable(),
  lineAmountsIncludeTax: z.boolean().nullable(),
  isReceipt: z.boolean(),
  documentWarnings: z.array(z.string().max(400)).max(20),
  lines: z.array(z.object({
    description: z.string().min(1).max(240),
    quantity: z.number().positive().max(100000).nullable(),
    unitMinor: z.number().int().min(-100000000).max(100000000).nullable(),
    totalMinor: z.number().int().min(-100000000).max(100000000).nullable(),
    kind: z.enum(["item", "tax", "discount", "fee", "unknown"]),
    sourceText: z.string().max(600),
    sourceRegion: region.nullable(),
    suggestedPackageId: z.string().max(64).nullable(),
    needsReview: z.boolean(),
    reviewReason: z.string().max(400).nullable(),
    confidence: z.number().min(0).max(1),
  }).strict()).max(120),
}).strict();
export type ExtractedReceipt = z.infer<typeof extractedReceiptSchema>;
export interface ExtractionValidation {
  codes: string[];
  lineTotalMinor: number | null;
  totalDifferenceMinor: number | null;
  uncertainLineCount: number;
  payable: false;
}
export function validateExtraction(extraction: ExtractedReceipt, packageIds: string[], pageCount: number): ExtractionValidation {
  const codes = new Set<string>();
  if (!extraction.isReceipt) codes.add("DOCUMENT_NOT_RECEIPT");
  if (extraction.currency !== "USD") codes.add(extraction.currency ? "CURRENCY_REQUIRES_REVIEW" : "CURRENCY_UNREADABLE");
  if (extraction.totalMinor === null) codes.add("TOTAL_UNREADABLE");
  if (!extraction.vendor) codes.add("VENDOR_UNREADABLE");
  if (!extraction.receiptDate) codes.add("DATE_UNREADABLE");
  if (!extraction.lines.length) codes.add("LINES_UNREADABLE");
  for (const line of extraction.lines) {
    const r = line.sourceRegion;
    if (r && (r.page > pageCount || r.x + r.width > 1.000001 || r.y + r.height > 1.000001)) codes.add("SOURCE_REGION_INVALID");
    if (line.suggestedPackageId && !packageIds.includes(line.suggestedPackageId)) codes.add("PACKAGE_UNKNOWN");
    if (line.totalMinor === null) codes.add("LINE_AMOUNT_UNREADABLE");
    if (line.kind === "discount") codes.add("DISCOUNT_ALLOCATION_REVIEW");
  }
  const lineTotalMinor = extraction.lines.length && extraction.lines.every(line => line.totalMinor !== null)
    ? extraction.lines.reduce((sum, line) => sum + line.totalMinor!, 0) : null;
  const totalDifferenceMinor = lineTotalMinor !== null && extraction.totalMinor !== null ? extraction.totalMinor - lineTotalMinor : null;
  if (totalDifferenceMinor !== null && totalDifferenceMinor !== 0) codes.add("LINE_TOTAL_DIFFERENCE");
  if (extraction.lineAmountsIncludeTax === null) codes.add("TAX_TREATMENT_REVIEW");
  return { codes: [...codes], lineTotalMinor, totalDifferenceMinor,
    uncertainLineCount: extraction.lines.filter(line => line.needsReview || line.totalMinor === null || !line.suggestedPackageId).length,
    payable: false };
}

export function perceptualDistance(a: string, b: string): number | null {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return null;
  let xor = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), count = 0;
  while (xor) { count += Number(xor & 1n); xor >>= 1n; }
  return count;
}
