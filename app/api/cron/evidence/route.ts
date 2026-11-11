import { guardedApi } from "@/lib/server/maintenance";
import { timingSafeEqual } from "node:crypto";
import { initializeDatabase, query } from "@/lib/server/db";
import { validateStoredDocument } from "@/lib/server/documents";
import { runReceiptExtraction } from "@/lib/server/receipt-extraction";
import { DomainError } from "@/lib/domain/money";
import { privateJson, routeFailure } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
async function GETImplementation(request: Request) {
  try {
    const supplied = request.headers.get("authorization") ?? "", expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
    if (!process.env.CRON_SECRET || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new DomainError("FORBIDDEN", "Scheduler authorization is required.", 403);
    await initializeDatabase();
    const [run] = await query<{ id: string }>("SELECT id FROM fp_ai_runs WHERE kind='receipt' AND (status='queued' OR (status='running' AND lease_until<now())) ORDER BY created_at LIMIT 1");
    if (run) { await runReceiptExtraction(run.id); return privateJson({ runs: 1, documents: 0 }); }
    const [document] = await query<{ id: string; tenant_id: string }>("SELECT id,tenant_id FROM fp_documents WHERE (state='validating' AND lease_until<now()) OR (state='awaiting_upload' AND validation_code IN ('UPLOAD_OBSERVED','DOCUMENT_PROCESSING_UNAVAILABLE')) ORDER BY updated_at LIMIT 1");
    if (document) await validateStoredDocument(document.id, document.tenant_id).catch(() => undefined);
    return privateJson({ runs: 0, documents: document ? 1 : 0 });
  } catch (error) { return routeFailure(error); }
}

export const GET = (...args: Parameters<typeof GETImplementation>) => guardedApi(args[0], () => GETImplementation(...args));
