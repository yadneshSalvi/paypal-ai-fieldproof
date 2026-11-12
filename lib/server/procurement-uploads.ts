import type { z } from "zod";
import { DomainError } from "../domain/money";
import { procurementUploadActionSchema, procurementUploadInputSchema } from "../procurement/uploads";
import type { Session } from "./auth";
import { procurementAuthority, expectProcurementScope } from "./procurement-store";
import { createUploadDocument, documentView, finalizeDocument, renewDocumentUpload, requireDocument } from "./documents";
import { planningDocumentStorage } from "./planning-sources";

export async function procurementUploadAuthority(session: Session, expectedScope: string) { const authority = await procurementAuthority(session, undefined, ["organizer", "volunteer"]); expectProcurementScope(authority, expectedScope); return authority; }
export async function ownProcurementUpload(session: Session, id: string, expectedScope: string, contentHash?: string) { await procurementUploadAuthority(session, expectedScope); const row = await requireDocument(session, id); if (row.purpose !== "quote" || row.actor_id !== session.actorId || row.provenance !== "user_upload") throw new DomainError("PROCUREMENT_NOT_FOUND", "Only your exact original private quote upload can be resumed through this form.", 404); if (contentHash && row.expected_sha256 !== contentHash) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "Choose the same original file; its retained content hash changed.", 409); return row; }
export async function saveProcurementUpload(session: Session, raw: z.infer<typeof procurementUploadInputSchema>) {
  const input = procurementUploadInputSchema.parse(raw); await procurementUploadAuthority(session, input.expectedScope); const { expectedScope, ...file } = input, result = await createUploadDocument(session, file); await ownProcurementUpload(session, result.document.id, expectedScope, input.sha256); await procurementUploadAuthority(session, expectedScope); return { document: result.document };
}
export async function readProcurementUpload(session: Session, scope: string, id: string) { const row = await ownProcurementUpload(session, id, scope), value = documentView(row); await procurementUploadAuthority(session, scope); return { document: value }; }
export async function actOnProcurementUpload(session: Session, id: string, action: "renew" | "finalize", raw: z.infer<typeof procurementUploadActionSchema>) {
  const input = procurementUploadActionSchema.parse(raw); await ownProcurementUpload(session, id, input.expectedScope, input.contentHash); const document = action === "renew" ? await renewDocumentUpload(session, id) : await finalizeDocument(session, id, planningDocumentStorage()); await procurementUploadAuthority(session, input.expectedScope); return { document };
}
