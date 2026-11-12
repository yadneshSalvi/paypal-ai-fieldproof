import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { after } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireSession } from "@/lib/server/auth";
import { documentUploadGrant, validateStoredDocument } from "@/lib/server/documents";
import { ownProcurementUpload, procurementUploadAuthority } from "@/lib/server/procurement-uploads";
import { initializeDatabase, query } from "@/lib/server/db";
import { privateJson, requestJson, routeFailure } from "@/lib/server/http";
import { guardedApi } from "@/lib/server/maintenance";
import { DomainError } from "@/lib/domain/money";
import { assertProviderAccess } from "@/lib/server/provider-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
async function POSTImplementation(request: Request) {
  try {
    const event = z.object({ type: z.enum(["blob.generate-client-token", "blob.upload-completed"]), payload: z.unknown() }).parse(await requestJson(request)); await initializeDatabase();
    const result = await handleUpload({ request, body: event as HandleUploadBody,
      async onBeforeGenerateToken(pathname, clientPayload) {
        assertSameOrigin(request); const session = await requireSession(["organizer", "volunteer"]), input = z.object({ documentId: z.uuid(), expectedScope: z.string().regex(/^[a-f0-9]{64}$/), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(JSON.parse(clientPayload ?? "{}"));
        await ownProcurementUpload(session, input.documentId, input.expectedScope, input.contentHash); assertProviderAccess(); const grant = await documentUploadGrant(session, input.documentId, pathname); await procurementUploadAuthority(session, input.expectedScope); return { ...grant, validUntil: Math.min(grant.validUntil, Date.parse(session.expiresAt)) };
      },
      async onUploadCompleted({ blob, tokenPayload }) {
        // handleUpload verifies its provider signature before this callback.
        // Validation stores only the original private file; it grants no role,
        // quote review, source publication or purchasing authority.
        const token = z.object({ documentId: z.uuid(), tenantId: z.uuid() }).strict().parse(JSON.parse(tokenPayload ?? "{}")), [document] = await query<{ pathname: string }>("SELECT pathname FROM fp_documents WHERE id=$1 AND tenant_id=$2 AND purpose='quote' AND provenance='user_upload'", [token.documentId, token.tenantId]);
        if (!document || document.pathname !== blob.pathname) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "The upload callback does not match its original private quote document.", 403);
        await query("UPDATE fp_documents SET validation_code='UPLOAD_OBSERVED',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND state='awaiting_upload'", [token.documentId, token.tenantId]); after(() => validateStoredDocument(token.documentId, token.tenantId).catch(() => undefined));
      },
    }); return privateJson(result);
  } catch (error) { return routeFailure(error); }
}
export const POST = (request: Request) => guardedApi(request, () => POSTImplementation(request));
