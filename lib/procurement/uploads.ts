import { z } from "zod";
import { newDocumentSchema } from "../domain/evidence";
export const procurementUploadInputSchema = newDocumentSchema.extend({ expectedScope: z.string().regex(/^[a-f0-9]{64}$/), purpose: z.literal("quote") }).strict();
export const procurementUploadActionSchema = z.object({ expectedScope: z.string().regex(/^[a-f0-9]{64}$/), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const procurementUploadViewSchema = z.object({ id: z.uuid(), filename: z.string().min(1).max(180), purpose: z.literal("quote"), provenance: z.enum(["user_upload", "sample_document"]), state: z.enum(["awaiting_upload", "validating", "ready", "rejected"]), version: z.number().int().positive(), contentType: z.string().max(100), size: z.number().int().positive(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), uploadPathname: z.string().max(1000).nullable(), pageCount: z.number().int().positive().nullable(), code: z.string().max(100).nullable(), createdAt: z.iso.datetime(), pages: z.array(z.object({ number: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(), previewUrl: z.string().max(1000) }).strict()).max(12) }).strict();
export const procurementUploadPendingSchema = z.object({ version: z.literal(1), input: procurementUploadInputSchema, documentId: z.uuid().nullable(), expiresAt: z.iso.datetime() }).strict();
export type ProcurementUploadPending = z.infer<typeof procurementUploadPendingSchema>;
export const PROCUREMENT_UPLOAD_KEY = "fieldproof.procurement.upload.v1";
