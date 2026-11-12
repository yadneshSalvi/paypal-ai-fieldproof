import { createHash } from "node:crypto";
import type { SqlConnection } from "@fracture/paypal-core";
import type { PlanSourceBinding } from "../planning/contracts";
import * as C from "../procurement/contracts";
import { quoteArithmetic } from "../procurement/arithmetic";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { query } from "./db";
import { documentPrivate, type DocumentRow } from "./documents";
import type { DocumentStorage } from "./document-storage";
import { planningDocumentStorage } from "./planning-sources";
import { currentSourceCheck, sourceControl, sourceBindings } from "./planning-store";
import { ownsCatalogRow, quoteVersion, supplierVersion } from "./procurement-catalog";
import { procurementRead } from "./procurement-read";
import { assertOwnResponsibility, dbClock, procurementCursor, readProcurementCursor, quotePayload, requireQuote, requireSupplier, scopeValues, supplierPayload, type ProcurementAuthority, type QuoteRow, type SupplierRow, type QuoteVersionRow, type SupplierVersionRow } from "./procurement-store";

async function mayEditCatalog(tx: SqlConnection, session: Session, packages?: string[]) {
  if (session.role === "organizer") return true;
  try { for (const id of packages?.length ? packages : [undefined]) await assertOwnResponsibility(tx, session, id); return true; }
  catch (error) { if (error instanceof DomainError && error.code === "PROCUREMENT_ASSIGNMENT_REQUIRED") return false; throw error; }
}

export async function procurementQuoteView(tx: SqlConnection, session: Session, row: QuoteRow, bindings: PlanSourceBinding[], requestedVersion = row.version): Promise<C.QuoteView> {
  if (!ownsCatalogRow(session, row)) throw new DomainError("PROCUREMENT_NOT_FOUND", "This quote is outside the permitted current project view.", 404);
  const version = await quoteVersion(tx, session, row, requestedVersion), data = quotePayload(version), checkedAt = await dbClock(tx), isCurrent = row.version === requestedVersion;
  if (isCurrent && [...row.package_ids].sort().join("|") !== [...data.draft.packageIds].sort().join("|")) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "The quote head no longer matches its exact original package scope.", 409);
  const sourceCurrent = !data.sourceBinding || !(await currentSourceCheck(session, [data.sourceBinding], tx)).length;
  const [supplier] = await query<SupplierRow>("SELECT * FROM fp_procurement_suppliers WHERE tenant_id=$1 AND project_id=$2 AND id=$3", [...scopeValues(session), data.draft.supplierId], tx);
  const reasons: string[] = [];
  const base = { id: row.id, version: requestedVersion, contentHash: version.content_hash, recordedState: data.state, own: row.created_by === session.actorId && row.created_role === session.role, createdAt: row.created_at.toISOString(), updatedAt: version.created_at.toISOString(), canRetire: isCurrent && row.state !== "retired" };
  if (!sourceCurrent) return C.quoteViewSchema.parse({ ...base, state: "source_withdrawn", draft: null, supplier: null, arithmetic: null, sourceAvailable: false, review: null, canEdit: false, canReview: false, canInspectSource: false, reasons: ["The original source or its permission changed. Private supplier details, notes and amounts are withheld; retained versions are unchanged."] });
  if (data.sourceBinding) bindings.push(data.sourceBinding);
  const supplierChanged = !supplier || supplier.state !== "active" || supplier.version !== data.draft.supplierVersion;
  const expired = !!data.draft.validUntil && Date.parse(data.draft.validUntil) <= Date.parse(checkedAt);
  if (supplierChanged) reasons.push("The supplier declaration changed or was archived. A new current quote revision needs review.");
  if (expired) reasons.push("The original quote deadline ended. An older selection or source review does not renew it.");
  if (!data.draft.validUntil) reasons.push("The quote deadline is unknown; it cannot establish current procurement readiness.");
  const state = data.state === "retired" ? "retired" : supplierChanged ? "supplier_changed" : expired ? "expired" : data.state;
  return C.quoteViewSchema.parse({ ...base, state, draft: data.draft, supplier: { ...data.supplier, identityVerified: false }, arithmetic: quoteArithmetic(data.draft), sourceAvailable: true, review: data.review, canEdit: isCurrent && row.state !== "retired" && await mayEditCatalog(tx, session, row.package_ids), canReview: isCurrent && session.role === "organizer" && row.state !== "retired" && !supplierChanged && !expired, canInspectSource: true, reasons });
}
export async function procurementSupplierView(tx: SqlConnection, session: Session, row: SupplierRow, requestedVersion = row.version): Promise<C.SupplierView> {
  if (!ownsCatalogRow(session, row)) throw new DomainError("PROCUREMENT_NOT_FOUND", "This supplier is outside the permitted project view.", 404);
  const saved = await supplierVersion(tx, session, row, requestedVersion), payload = supplierPayload(saved), isCurrent = requestedVersion === row.version;
  const { acknowledged: _acknowledged, ...declaration } = payload.draft;
  const editable = await mayEditCatalog(tx, session);
  return C.supplierViewSchema.parse({ id: row.id, version: requestedVersion, state: payload.state, ...declaration, identityVerified: false, own: row.created_by === session.actorId && row.created_role === session.role, createdAt: row.created_at.toISOString(), updatedAt: saved.created_at.toISOString(), canEdit: isCurrent && row.state === "active" && editable, canArchive: isCurrent && row.state === "active", canRestore: isCurrent && row.state === "archived" && editable });
}
const ownClause = "($3::boolean OR (created_by=$4 AND created_role='volunteer'))";
export async function supplierPage(tx: SqlConnection, authority: ProcurementAuthority, before?: string | null) {
  const session = authority.session, cursor = readProcurementCursor(before, "suppliers", authority.scope, null);
  const rows = await query<SupplierRow>(`SELECT * FROM fp_procurement_suppliers WHERE tenant_id=$1 AND project_id=$2 AND ${ownClause} AND ($5::timestamptz IS NULL OR (date_trunc('milliseconds',created_at),id)<($5,$6)) ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT $7`, [...scopeValues(session), session.role === "organizer", session.actorId, cursor?.at ?? null, cursor?.id ?? null, C.PROCUREMENT_PAGE_SIZE + 1], tx);
  const page = rows.slice(0, C.PROCUREMENT_PAGE_SIZE);
  return C.procurementSupplierPageSchema.parse({ scope: authority.scope, items: await Promise.all(page.map(row => procurementSupplierView(tx, session, row))), nextCursor: rows.length > page.length ? procurementCursor("suppliers", authority.scope, null, page[page.length - 1]) : null });
}
export async function quotePage(tx: SqlConnection, authority: ProcurementAuthority, packageId: string | null, before: string | null | undefined, bindings: PlanSourceBinding[]) {
  const session = authority.session, filter = { packageId }, cursor = readProcurementCursor(before, "quotes", authority.scope, filter);
  const rows = await query<QuoteRow>(`SELECT * FROM fp_procurement_quotes WHERE tenant_id=$1 AND project_id=$2 AND ${ownClause} AND ($5::text IS NULL OR package_ids ? $5) AND ($6::timestamptz IS NULL OR (date_trunc('milliseconds',created_at),id)<($6,$7)) ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT $8`, [...scopeValues(session), session.role === "organizer", session.actorId, packageId, cursor?.at ?? null, cursor?.id ?? null, C.PROCUREMENT_PAGE_SIZE + 1], tx);
  const page = rows.slice(0, C.PROCUREMENT_PAGE_SIZE), items: C.QuoteView[] = [];
  for (const row of page) items.push(await procurementQuoteView(tx, session, row, bindings));
  return C.procurementQuotePageSchema.parse({ scope: authority.scope, packageId, items, nextCursor: rows.length > page.length ? procurementCursor("quotes", authority.scope, filter, page[page.length - 1]) : null });
}
export async function sourcePage(tx: SqlConnection, authority: ProcurementAuthority, before: string | null | undefined, bindings: PlanSourceBinding[]) {
  const session = authority.session, cursor = readProcurementCursor(before, "sources", authority.scope, null);
  const rows = await query<DocumentRow>(`SELECT d.* FROM fp_documents d LEFT JOIN fp_plan_source_controls c ON c.document_id=d.id AND c.tenant_id=d.tenant_id AND c.project_id=d.project_id
    WHERE d.tenant_id=$1 AND d.project_id=$2 AND d.purpose='quote' AND d.state='ready' AND (c.permission IS NULL OR c.permission='allowed') AND ($3::boolean OR d.actor_id=$4) AND ($5::timestamptz IS NULL OR (date_trunc('milliseconds',d.created_at),d.id)<($5,$6)) ORDER BY date_trunc('milliseconds',d.created_at) DESC,d.id DESC LIMIT $7`, [...scopeValues(session), session.role === "organizer", session.actorId, cursor?.at ?? null, cursor?.id ?? null, C.PROCUREMENT_PAGE_SIZE + 1], tx);
  const page = rows.slice(0, C.PROCUREMENT_PAGE_SIZE), items: C.QuoteSourceOption[] = [];
  for (const row of page) { const data = documentPrivate(row), control = await sourceControl(row, tx); bindings.push(...await sourceBindings(session, [row.id], tx)); items.push({ documentId: row.id, version: row.version, contentHash: row.sha256!, controlVersion: control.version, label: data.filename, provenance: row.provenance, own: row.actor_id === session.actorId, pages: data.pages.map(({ number, width, height }) => ({ number, width, height })) }); }
  return C.procurementSourcePageSchema.parse({ scope: authority.scope, items, nextCursor: rows.length > page.length ? procurementCursor("sources", authority.scope, null, page[page.length - 1]) : null });
}

async function sourceForRead(tx: SqlConnection, authority: ProcurementAuthority, id: string, version: number) {
  const session = authority.session, row = await requireQuote(tx, session, id);
  if (!ownsCatalogRow(session, row)) throw new DomainError("PROCUREMENT_NOT_FOUND", "This source is outside the permitted current project view.", 404);
  const saved = await quoteVersion(tx, session, row, version), data = quotePayload(saved);
  if (data.sourceBinding && (await currentSourceCheck(session, [data.sourceBinding], tx)).length) throw new DomainError("PROCUREMENT_SOURCE_WITHDRAWN", "The exact original quote source is no longer permitted. Its private content is withheld.", 410);
  let originalDocumentAccess = false, document: DocumentRow | null = null;
  if (data.sourceBinding) { [document] = await query<DocumentRow>("SELECT * FROM fp_documents WHERE tenant_id=$1 AND project_id=$2 AND id=$3", [...scopeValues(session), data.sourceBinding.documentId], tx); originalDocumentAccess = !!document && (session.role === "organizer" || session.role === "volunteer" && document.actor_id === session.actorId); }
  return { row, saved, data, document, originalDocumentAccess };
}
export async function readProcurementQuoteSource(session: Session, expectedScope: string, id: string, version: number): Promise<C.QuoteSourceDetail> {
  return procurementRead(session, expectedScope, ["organizer", "volunteer"], async (tx, authority) => {
    const { row, saved, data, originalDocumentAccess } = await sourceForRead(tx, authority, id, version), source = data.draft.source;
    const page = source.kind === "document" ? data.sourceBinding?.pages.find(page => page.number === source.page) : null;
    return { value: C.quoteSourceDetailSchema.parse({ scope: authority.scope, quoteId: id, quoteVersion: version, contentHash: saved.content_hash, status: row.version === version ? "current" : "historical", provenance: data.draft.provenance, excerpt: source.kind === "document" ? source.excerpt : source.note, observedAt: source.kind === "entered_estimate" ? source.declaredAt : null, originalDocumentAccess, preview: originalDocumentAccess && page ? { page: page.number, width: page.width, height: page.height, contentHash: data.sourceBinding!.pageHashes[data.sourceBinding!.pages.indexOf(page)] } : null, notices: ["This is a project user's source declaration and internal review. It establishes no verified supplier identity, supplier response, purchase or physical work."] }), bindings: data.sourceBinding ? [data.sourceBinding] : [] };
  });
}
export async function readProcurementQuotePreview(session: Session, expectedScope: string, id: string, version: number, pageNumber: number, storage: DocumentStorage = planningDocumentStorage()): Promise<Buffer> {
  // Keep bytes out of any persistent client payload. The final read below runs
  // after storage I/O, so withdrawal during that await cannot disclose an image.
  const loaded = await procurementRead(session, expectedScope, ["organizer", "volunteer"], async (tx, authority) => {
    const result = await sourceForRead(tx, authority, id, version);
    if (!result.originalDocumentAccess || !result.document || result.data.draft.source.kind !== "document" || result.data.draft.source.page !== pageNumber) throw new DomainError("PROCUREMENT_NOT_FOUND", "The original source image is outside this current profile's permitted view.", 404);
    const page = documentPrivate(result.document).pages.find(page => page.number === pageNumber);
    if (!page) throw new DomainError("PROCUREMENT_NOT_FOUND", "This exact source page is unavailable.", 404);
    return { value: { pathname: page.pathname, sha256: page.sha256, binding: result.data.sourceBinding! }, bindings: [result.data.sourceBinding!] };
  });
  const image = await storage.read(loaded.pathname);
  if (image.contentType !== "image/png" || createHash("sha256").update(image.bytes).digest("hex") !== loaded.sha256) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "The image no longer matches its original reviewed page hash.", 409);
  await procurementRead(session, expectedScope, ["organizer", "volunteer"], async (tx, authority) => { await sourceForRead(tx, authority, id, version); return { value: true, bindings: [loaded.binding] }; });
  return image.bytes;
}
export async function readProcurementRevisions(session: Session, expectedScope: string, kind: "quote" | "supplier", id: string, before: string | null) {
  return procurementRead<ReturnType<typeof C.procurementQuoteRevisionPageSchema.parse> | ReturnType<typeof C.procurementSupplierRevisionPageSchema.parse>>(session, expectedScope, ["organizer", "volunteer"], async (tx, authority) => {
    const cursor = readProcurementCursor(before, `${kind}-versions`, authority.scope, { id }), bindings: PlanSourceBinding[] = [];
    if (kind === "quote") {
      const head = await requireQuote(tx, session, id); if (!ownsCatalogRow(session, head)) throw new DomainError("PROCUREMENT_NOT_FOUND", "This quote revision history is outside your current profile.", 404);
      const rows = await query<QuoteVersionRow>("SELECT * FROM fp_procurement_quote_versions WHERE tenant_id=$1 AND project_id=$2 AND quote_id=$3 AND ($4::timestamptz IS NULL OR (date_trunc('milliseconds',created_at),version)<($4,$5::integer)) ORDER BY date_trunc('milliseconds',created_at) DESC,version DESC LIMIT $6", [...scopeValues(session), id, cursor?.at ?? null, cursor ? Number(cursor.id) : null, C.PROCUREMENT_PAGE_SIZE + 1], tx), page = rows.slice(0, C.PROCUREMENT_PAGE_SIZE), items: { current: boolean; quote: C.QuoteView }[] = [];
      for (const row of page) items.push({ current: row.version === head.version, quote: await procurementQuoteView(tx, session, head, bindings, row.version) });
      const last = page.at(-1); return { value: C.procurementQuoteRevisionPageSchema.parse({ scope: authority.scope, quoteId: id, items, nextCursor: rows.length > page.length && last ? procurementCursor("quote-versions", authority.scope, { id }, { id: String(last.version), created_at: last.created_at }) : null }), bindings };
    }
    const head = await requireSupplier(tx, session, id); if (!ownsCatalogRow(session, head)) throw new DomainError("PROCUREMENT_NOT_FOUND", "This supplier declaration history is outside your current profile.", 404);
    const rows = await query<SupplierVersionRow>("SELECT * FROM fp_procurement_supplier_versions WHERE tenant_id=$1 AND project_id=$2 AND supplier_id=$3 AND ($4::timestamptz IS NULL OR (date_trunc('milliseconds',created_at),version)<($4,$5::integer)) ORDER BY date_trunc('milliseconds',created_at) DESC,version DESC LIMIT $6", [...scopeValues(session), id, cursor?.at ?? null, cursor ? Number(cursor.id) : null, C.PROCUREMENT_PAGE_SIZE + 1], tx), page = rows.slice(0, C.PROCUREMENT_PAGE_SIZE), items: { current: boolean; supplier: C.SupplierView }[] = [];
    for (const row of page) items.push({ current: row.version === head.version, supplier: await procurementSupplierView(tx, session, head, row.version) });
    const last = page.at(-1); return { value: C.procurementSupplierRevisionPageSchema.parse({ scope: authority.scope, supplierId: id, items, nextCursor: rows.length > page.length && last ? procurementCursor("supplier-versions", authority.scope, { id }, { id: String(last.version), created_at: last.created_at }) : null }), bindings };
  });
}
