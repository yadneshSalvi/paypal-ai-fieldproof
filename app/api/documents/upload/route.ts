import { guardedApi } from "@/lib/server/maintenance";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { after } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireSession } from "@/lib/server/auth";
import { initializeDatabase, query } from "@/lib/server/db";
import { documentUploadGrant, validateStoredDocument } from "@/lib/server/documents";
import { privateJson, requestJson, routeFailure } from "@/lib/server/http";
import { DomainError } from "@/lib/domain/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
async function POSTImplementation(request: Request) {
  try {
    const body = await requestJson(request);
    const event = z.object({ type: z.enum(["blob.generate-client-token", "blob.upload-completed"]), payload: z.unknown() }).parse(body);
    await initializeDatabase();
    const result = await handleUpload({ request, body: event as HandleUploadBody,
      async onBeforeGenerateToken(pathname, clientPayload) {
        assertSameOrigin(request);
        const session = await requireSession(["volunteer", "organizer"]);
        const { documentId } = z.object({ documentId: z.uuid() }).strict().parse(JSON.parse(clientPayload ?? "{}"));
        return documentUploadGrant(session, documentId, pathname);
      },
      async onUploadCompleted({ blob, tokenPayload }) {
        // The SDK verifies x-vercel-signature before invoking this callback.
        const token = z.object({ documentId: z.uuid(), tenantId: z.uuid() }).strict().parse(JSON.parse(tokenPayload ?? "{}"));
        const [document] = await query<{ pathname: string }>("SELECT pathname FROM fp_documents WHERE id=$1 AND tenant_id=$2", [token.documentId, token.tenantId]);
        if (!document || document.pathname !== blob.pathname) throw new DomainError("UPLOAD_SCOPE", "The upload callback does not match its original document.", 403);
        await query("UPDATE fp_documents SET validation_code='UPLOAD_OBSERVED',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND state='awaiting_upload'", [token.documentId, token.tenantId]);
        after(() => validateStoredDocument(token.documentId, token.tenantId).catch(() => undefined));
      },
    });
    return privateJson(result);
  } catch (error) { return routeFailure(error); }
}

export const POST = (...args: Parameters<typeof POSTImplementation>) => guardedApi(args[0], () => POSTImplementation(...args));
