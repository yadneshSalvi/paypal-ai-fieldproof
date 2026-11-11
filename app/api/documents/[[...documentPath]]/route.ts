import { guardedApi } from "@/lib/server/maintenance";
import { after } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireSession } from "@/lib/server/auth";
import { createUploadDocument, documentOriginal, documentPreview, documentsView, documentView, finalizeDocument, importSampleReceipt, renewDocumentUpload, requireDocument } from "@/lib/server/documents";
import { privateJson, PRIVATE_HEADERS, requestJson, routeFailure } from "@/lib/server/http";
import { newDocumentSchema } from "@/lib/domain/evidence";
import { DomainError } from "@/lib/domain/money";
import { receiptRuns, retryReceiptExtraction, runReceiptExtraction, startReceiptExtraction } from "@/lib/server/receipt-extraction";
import { receiptComparisons } from "@/lib/server/receipt-comparison";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Context = { params: Promise<{ documentPath?: string[] }> };
async function GETImplementation(request: Request, context: Context) {
  try {
    const session = await requireSession(["volunteer", "organizer"]), parts = (await context.params).documentPath ?? [];
    if (!parts.length) return privateJson({ documents: await documentsView(session) });
    const id = z.uuid().parse(parts[0]);
    if (parts[1] === "original" && parts.length === 2) {
      const original = await documentOriginal(session, id);
      return new Response(new Uint8Array(original.bytes), { headers: { ...PRIVATE_HEADERS, "Content-Type": original.contentType, "Content-Disposition": `attachment; filename="source-document"; filename*=UTF-8''${encodeURIComponent(original.filename)}`, "Content-Security-Policy": "default-src 'none'; sandbox" } });
    }
    if (parts[1] === "preview" && parts.length === 2) {
      const page = z.coerce.number().int().min(1).max(12).parse(new URL(request.url).searchParams.get("page") ?? 1);
      return new Response(new Uint8Array(await documentPreview(session, id, page)), { headers: { ...PRIVATE_HEADERS, "Content-Type": "image/png", "Content-Disposition": 'inline; filename="private-preview.png"', "Content-Security-Policy": "default-src 'none'; sandbox" } });
    }
    if (parts.length === 1) return privateJson({ document: documentView(await requireDocument(session, id)), runs: await receiptRuns(session, id), comparisons: await receiptComparisons(session, id) });
    throw new DomainError("NOT_FOUND", "This document view does not exist.", 404);
  } catch (error) { return routeFailure(error); }
}
async function POSTImplementation(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const session = await requireSession(["volunteer", "organizer"]), parts = (await context.params).documentPath ?? [];
    const body = await requestJson(request);
    if (!parts.length) return privateJson(await createUploadDocument(session, newDocumentSchema.parse(body)), 201);
    if (parts[0] === "sample" && parts.length === 1) {
      const data = z.object({ intentId: z.uuid(), variant: z.enum(["original", "rotated", "cropped"]).default("original"), sampleAcknowledged: z.literal(true) }).strict().parse(body);
      return privateJson({ document: await importSampleReceipt(session, data.intentId, data.variant) }, 201);
    }
    const id = z.uuid().parse(parts[0]);
    if (parts.length !== 2) throw new DomainError("NOT_FOUND", "This document action does not exist.", 404);
    if (parts[1] === "finalize") { z.object({}).strict().parse(body); return privateJson({ document: await finalizeDocument(session, id) }); }
    if (parts[1] === "renew") { z.object({}).strict().parse(body); return privateJson({ document: await renewDocumentUpload(session, id) }); }
    if (parts[1] === "extract") {
      const { provider, acknowledged } = z.object({ provider: z.enum(["openai", "gemini"]).default("openai"), acknowledged: z.literal(true) }).strict().parse(body);
      if (!acknowledged) throw new DomainError("AI_PERMISSION_REQUIRED", "Confirm that the private source can be sent for extraction.", 422);
      const run = await startReceiptExtraction(session, id, provider);
      after(() => runReceiptExtraction(run.id));
      return privateJson({ run }, run.state === "succeeded" ? 200 : 202);
    }
    if (parts[1] === "retry-extraction") {
      const { runId } = z.object({ runId: z.uuid(), acknowledged: z.literal(true) }).strict().parse(body);
      const runs = await receiptRuns(session, id);
      if (!runs.some(run => run.id === runId)) throw new DomainError("EXTRACTION_NOT_FOUND", "This extraction belongs to a different source.", 404);
      const run = await retryReceiptExtraction(session, runId);
      after(() => runReceiptExtraction(run.id));
      return privateJson({ run }, 202);
    }
    throw new DomainError("NOT_FOUND", "This document action does not exist.", 404);
  } catch (error) { return routeFailure(error); }
}

export const GET = (...args: Parameters<typeof GETImplementation>) => guardedApi(args[0], () => GETImplementation(...args));

export const POST = (...args: Parameters<typeof POSTImplementation>) => guardedApi(args[0], () => POSTImplementation(...args));
