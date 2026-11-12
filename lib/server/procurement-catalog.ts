import { randomUUID } from "node:crypto";
import type { SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import * as C from "../procurement/contracts";
import { quoteArithmetic } from "../procurement/arithmetic";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { query } from "./db";
import { requireDocument } from "./documents";
import { currentSourceCheck, packageBindings, sourceBindings } from "./planning-store";
import { assertOwnResponsibility, dbClock, openProcurement, procurementAudit, procurementCommand, procurementEvent, procurementHash, quotePayload, requireQuote, requireSupplier, scopeValues, sealProcurement, supplierPayload, type ProcurementAuthority, type QuotePayload, type QuoteRow, type QuoteVersionRow, type SupplierPayload, type SupplierRow, type SupplierVersionRow } from "./procurement-store";

async function writerScope(tx: SqlConnection, session: Session, packageIds?: string[], reducing = false) {
  if (session.role === "organizer") return;
  if (session.role !== "volunteer") throw new DomainError("PROCUREMENT_ROLE_DENIED", "This project role cannot propose or manage a supplier quote.", 403);
  if (reducing) return;
  if (!packageIds?.length) await assertOwnResponsibility(tx, session);
  else for (const packageId of packageIds) await assertOwnResponsibility(tx, session, packageId);
}
export const ownsCatalogRow = (session: Session, row: Pick<SupplierRow | QuoteRow, "created_by" | "created_role">) => session.role === "organizer" || session.role === "volunteer" && row.created_by === session.actorId && row.created_role === "volunteer";
export async function supplierVersion(tx: SqlConnection, session: Pick<Session, "tenantId" | "projectId">, row: SupplierRow, version = row.version): Promise<SupplierVersionRow> {
  const [value] = await query<SupplierVersionRow>("SELECT * FROM fp_procurement_supplier_versions WHERE supplier_id=$3 AND version=$4 AND tenant_id=$1 AND project_id=$2", [...scopeValues(session), row.id, version], tx); if (!value) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "This supplier has no matching retained source version.", 409); return value;
}
export async function quoteVersion(tx: SqlConnection, session: Pick<Session, "tenantId" | "projectId">, row: QuoteRow, version = row.version): Promise<QuoteVersionRow> {
  const [value] = await query<QuoteVersionRow>("SELECT * FROM fp_procurement_quote_versions WHERE quote_id=$3 AND version=$4 AND tenant_id=$1 AND project_id=$2", [...scopeValues(session), row.id, version], tx); if (!value) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "This quote has no matching retained source version.", 409); return value;
}
async function insertSupplierVersion(tx: SqlConnection, authority: ProcurementAuthority, payload: SupplierPayload) {
  const session = authority.session;
  await tx.query("INSERT INTO fp_procurement_supplier_versions(supplier_id,tenant_id,project_id,version,state,content_hash,encrypted_data,actor_id,actor_session_id,actor_role,membership_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [payload.supplierId, session.tenantId, session.projectId, payload.version, payload.state, procurementHash(payload), sealProcurement(session, "supplier", payload.supplierId, payload.version, payload), session.actorId, session.id, session.role, authority.membershipVersion]);
}
export async function saveProcurementSupplier(session: Session, raw: z.infer<typeof C.supplierSaveSchema>) {
  const input = C.supplierSaveSchema.parse(raw);
  return procurementCommand(session, input, "supplier_save", ["organizer", "volunteer"], async (tx, authority) => {
    await writerScope(tx, session);
    if (input.draft.provenance === "sample" && session.mode !== "sample") throw new DomainError("PROCUREMENT_SOURCE_INVALID", "Fictional supplier records belong only in a labelled Sample project.", 422);
    let id = input.supplierId, version = 1;
    if (!id) {
      id = randomUUID(); await tx.query("INSERT INTO fp_procurement_suppliers(id,tenant_id,project_id,created_by,created_role,created_session_id,created_membership_version) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, session.tenantId, session.projectId, session.actorId, session.role, session.id, authority.membershipVersion]);
    } else {
      const row = await requireSupplier(tx, session, id, true); if (!ownsCatalogRow(session, row)) throw new DomainError("PROCUREMENT_NOT_FOUND", "This supplier is outside your current editable view.", 404);
      if (row.version !== input.expectedVersion || row.state !== "active") throw new DomainError("PROCUREMENT_VERSION_CHANGED", "The supplier changed or was archived. Review the current version before editing.", 409);
      supplierPayload(await supplierVersion(tx, session, row)); version = row.version + 1; await tx.query("UPDATE fp_procurement_suppliers SET version=$4,updated_at=clock_timestamp() WHERE id=$3 AND tenant_id=$1 AND project_id=$2 AND version=$5", [...scopeValues(session), id, version, row.version]);
    }
    const payload: SupplierPayload = { contractVersion: C.PROCUREMENT_VERSION, supplierId: id, version, state: "active", draft: input.draft };
    await insertSupplierVersion(tx, authority, payload); await procurementAudit(tx, authority, "supplier_saved", id, version, { sourceHash: procurementHash(payload), provenance: input.draft.provenance }); await procurementEvent(tx, session, "supplier_saved");
    return { id, version, message: "The self-declared supplier record is saved. No identity verification, message, supplier response or purchase is established." };
  });
}
export async function changeProcurementSupplierState(session: Session, id: string, raw: z.infer<typeof C.supplierStateSchema>) {
  const input = C.supplierStateSchema.parse(raw);
  return procurementCommand(session, { ...input, resourceId: id }, "supplier_state", ["organizer", "volunteer"], async (tx, authority) => {
    await writerScope(tx, session, undefined, input.action === "archive"); const row = await requireSupplier(tx, session, id, true);
    if (!ownsCatalogRow(session, row)) throw new DomainError("PROCUREMENT_NOT_FOUND", "This supplier is outside your current editable view.", 404);
    if (row.version !== input.expectedVersion) throw new DomainError("PROCUREMENT_VERSION_CHANGED", "The supplier has a newer saved version. Review it before changing availability.", 409);
    const state = input.action === "archive" ? "archived" as const : "active" as const; if (state === row.state) return { id, version: row.version, message: "This supplier already has that availability. Its original versions remain unchanged." };
    const previous = supplierPayload(await supplierVersion(tx, session, row)), payload: SupplierPayload = { ...previous, version: row.version + 1, state };
    await tx.query("UPDATE fp_procurement_suppliers SET version=$4,state=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND version=$6", [...scopeValues(session), id, payload.version, state, row.version]);
    await insertSupplierVersion(tx, authority, payload); await procurementAudit(tx, authority, "supplier_state", id, payload.version, { action: input.action, reason: input.reason }); await procurementEvent(tx, session, "supplier_state");
    return { id, version: payload.version, message: state === "archived" ? "The supplier is archived for new procurement. Existing quotes and decisions retain their original history." : "The supplier is available for a new current quote review. Earlier source and decision deadlines are unchanged." };
  });
}
async function insertQuoteVersion(tx: SqlConnection, authority: ProcurementAuthority, payload: QuotePayload) {
  const session = authority.session, binding = payload.sourceBinding;
  await tx.query("INSERT INTO fp_procurement_quote_versions(quote_id,tenant_id,project_id,version,supplier_id,supplier_version,state,content_hash,encrypted_data,source_document_id,source_document_version,source_hash,source_control_version,actor_id,actor_session_id,actor_role,membership_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)", [payload.quoteId, session.tenantId, session.projectId, payload.version, payload.draft.supplierId, payload.draft.supplierVersion, payload.state, procurementHash(payload), sealProcurement(session, "quote", payload.quoteId, payload.version, payload), binding?.documentId ?? null, binding?.documentVersion ?? null, binding?.contentHash ?? null, binding?.controlVersion ?? null, session.actorId, session.id, session.role, authority.membershipVersion]);
}
export async function saveProcurementQuote(session: Session, raw: z.infer<typeof C.quoteSaveSchema>) {
  const input = C.quoteSaveSchema.parse(raw);
  return procurementCommand(session, input, "quote_save", ["organizer", "volunteer"], async (tx, authority) => {
    await writerScope(tx, session, input.draft.packageIds);
    const supplier = await requireSupplier(tx, session, input.draft.supplierId, true);
    if (!ownsCatalogRow(session, supplier)) throw new DomainError("PROCUREMENT_NOT_FOUND", "Choose one of the suppliers permitted in your current project view.", 404);
    if (supplier.state !== "active" || supplier.version !== input.draft.supplierVersion) throw new DomainError("PROCUREMENT_SUPPLIER_CHANGED", "The supplier availability or version changed. Review the current declaration first.", 409);
    const supplierData = supplierPayload(await supplierVersion(tx, session, supplier));
    if ((input.draft.provenance === "sample" && session.mode !== "sample") || supplierData.draft.provenance === "sample" && input.draft.provenance !== "sample") throw new DomainError("PROCUREMENT_SOURCE_INVALID", "Keep fictional supplier and quote records explicitly labelled Sample in their own project.", 422);
    const packages = await packageBindings(session.projectId, tx, true); if (input.draft.packageIds.some(id => packages.find(row => row.packageId === id)?.version !== input.expectedPackageVersions[id])) throw new DomainError("PROCUREMENT_BASIS_CHANGED", "A target package or its canonical version changed. Compare the current scope before saving.", 409);
    let binding: QuotePayload["sourceBinding"] = null;
    if (input.draft.source.kind === "document") {
      const source = input.draft.source, document = await requireDocument(session, source.documentId, tx);
      if (document.purpose !== "quote") throw new DomainError("PROCUREMENT_SOURCE_INVALID", "Select a ready quote source from this project. A receipt or credential is not a supplier quote.", 422);
      [binding] = await sourceBindings(session, [source.documentId], tx, true);
      if (source.documentVersion !== binding.documentVersion || source.contentHash !== binding.contentHash || source.controlVersion !== binding.controlVersion || !binding.pages.some(page => page.number === source.page) || source.region.x + source.region.width > 1 || source.region.y + source.region.height > 1) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "The exact original source page, content or permission version changed. Review the ready source before saving.", 409);
      if (binding.provenance === "sample_document" && input.draft.provenance !== "sample") throw new DomainError("PROCUREMENT_SOURCE_INVALID", "A fictional source document must keep its Sample provenance.", 422);
    } else if (Date.parse(input.draft.source.declaredAt) > Date.parse(await dbClock(tx))) throw new DomainError("PROCUREMENT_SOURCE_INVALID", "An entered estimate cannot claim a future observation or supplier response.", 422);
    let id = input.quoteId, version = 1;
    if (!id) { id = randomUUID(); await tx.query("INSERT INTO fp_procurement_quotes(id,tenant_id,project_id,supplier_id,package_ids,created_by,created_role,created_session_id,created_membership_version) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)", [id, session.tenantId, session.projectId, supplier.id, JSON.stringify(input.draft.packageIds), session.actorId, session.role, session.id, authority.membershipVersion]); }
    else { const row = await requireQuote(tx, session, id, true); if (!ownsCatalogRow(session, row)) throw new DomainError("PROCUREMENT_NOT_FOUND", "This quote is outside your editable current view.", 404); if (row.version !== input.expectedVersion || row.state === "retired") throw new DomainError("PROCUREMENT_VERSION_CHANGED", "This quote changed or was retired. A retired quote needs a separate new source record.", 409); quotePayload(await quoteVersion(tx, session, row)); version = row.version + 1; await tx.query("UPDATE fp_procurement_quotes SET version=$4,state='draft',supplier_id=$5,package_ids=$7::jsonb,updated_at=clock_timestamp() WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND version=$6", [...scopeValues(session), id, version, supplier.id, row.version, JSON.stringify(input.draft.packageIds)]); }
    const payload: QuotePayload = { contractVersion: C.PROCUREMENT_VERSION, quoteId: id, version, state: "draft", draft: input.draft, supplier: { id: supplier.id, version: supplier.version, name: supplierData.draft.name }, sourceBinding: binding, packageVersions: input.expectedPackageVersions, review: null };
    await insertQuoteVersion(tx, authority, payload); await procurementAudit(tx, authority, "quote_saved", id, version, { reason: input.revisionReason, contentHash: procurementHash(payload), costComplete: quoteArithmetic(input.draft).complete }); await procurementEvent(tx, session, "quote_saved");
    return { id, version, message: "The source-bound quote proposal is saved for review. Unknown fields remain unknown; no supplier response or purchase is implied." };
  });
}
export async function reviewProcurementQuote(session: Session, id: string, raw: z.infer<typeof C.quoteReviewSchema>) {
  const input = C.quoteReviewSchema.parse(raw), reducing = input.decision === "retired";
  return procurementCommand(session, { ...input, resourceId: id }, "quote_review", reducing ? ["organizer", "volunteer"] : ["organizer"], async (tx, authority) => {
    const row = await requireQuote(tx, session, id, true); if (!ownsCatalogRow(session, row)) throw new DomainError("PROCUREMENT_NOT_FOUND", "This quote is outside your current review view.", 404);
    if (row.version !== input.expectedVersion) throw new DomainError("PROCUREMENT_VERSION_CHANGED", "This quote has a newer source or decision. Review that version first.", 409);
    const previousRow = await quoteVersion(tx, session, row), previous = quotePayload(previousRow); if (previousRow.content_hash !== input.contentHash) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "The reviewed quote hash no longer matches the current retained source.", 409);
    if (row.state === "retired") { if (reducing) return { id, version: row.version, message: "This quote is already retired; its original history remains unchanged." }; throw new DomainError("PROCUREMENT_QUOTE_INVALID", "A retired quote cannot be revived through review. Create a separately reviewed source record.", 409); }
    if (!reducing) {
      const supplier = await requireSupplier(tx, session, previous.draft.supplierId); if (supplier.version !== previous.draft.supplierVersion || supplier.state !== "active") throw new DomainError("PROCUREMENT_SUPPLIER_CHANGED", "The declared supplier changed. Save a current quote revision before reviewing it.", 409);
      if (previous.sourceBinding && (await currentSourceCheck(session, [previous.sourceBinding], tx, true)).length) throw new DomainError("PROCUREMENT_SOURCE_WITHDRAWN", "The original quote source or its permission changed. Its private content is withheld.", 410);
      const packages = await packageBindings(session.projectId, tx, true); if (previous.draft.packageIds.some(id => packages.find(row => row.packageId === id)?.version !== previous.packageVersions[id])) throw new DomainError("PROCUREMENT_BASIS_CHANGED", "The original quote targets an earlier package version. Save and review a current scope.", 409);
      if (input.decision === "reviewed" && quoteArithmetic(previous.draft).errors.length) throw new DomainError("PROCUREMENT_QUOTE_INVALID", "Correct source arithmetic conflicts before marking this quote reviewed. Missing fields can remain explicit limitations.", 422);
    }
    const version = row.version + 1, payload: QuotePayload = { ...previous, version, state: input.decision, review: { decision: input.decision, note: input.note, reviewedAt: await dbClock(tx) } };
    await tx.query("UPDATE fp_procurement_quotes SET version=$4,state=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND version=$6", [...scopeValues(session), id, version, input.decision, row.version]); await insertQuoteVersion(tx, authority, payload); await procurementAudit(tx, authority, "quote_review", id, version, { decision: input.decision, note: input.note, contentHash: procurementHash(payload) }); await procurementEvent(tx, session, "quote_review");
    return { id, version, message: reducing ? "The quote is retired for new selection. Its original source, reviews and decisions remain retained." : input.decision === "needs_information" ? "The source review records what still needs clarification. No supplier message was sent." : "This exact quote version is internally reviewed. Supplier identity, acceptance, purchasing and physical work are not verified by this decision." };
  });
}
