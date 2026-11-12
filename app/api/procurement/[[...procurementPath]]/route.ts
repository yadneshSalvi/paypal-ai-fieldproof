import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";
import * as C from "@/lib/procurement/contracts";
import * as A from "@/lib/procurement/access-contracts";
import { MAX_DOCUMENT_BYTES } from "@/lib/domain/evidence";
import { procurementUploadInputSchema, procurementUploadActionSchema } from "@/lib/procurement/uploads";
import { DomainError } from "@/lib/domain/money";
import { assertSameOrigin, getSession, requireSession, sessionCookieName, sessionCookieSecure, tokenHash, writeSessionCookie } from "@/lib/server/auth";
import { PRIVATE_HEADERS, privateJson, requestJson, routeFailure } from "@/lib/server/http";
import { guardedApi } from "@/lib/server/maintenance";
import { rememberWorkspaceCookie } from "@/lib/server/community-workspaces";
import { query } from "@/lib/server/db";
import { documentUploadGrant } from "@/lib/server/documents";
import { planningDocumentStorage, planningQaEnabled } from "@/lib/server/planning-sources";
import { actOnProcurementUpload, ownProcurementUpload, readProcurementUpload, saveProcurementUpload } from "@/lib/server/procurement-uploads";
import { readProcurementCollection, readProcurementContext, readProcurementDesk, readProcurementDetail, readProcurementHistory, readProcurementHistoryDetail, readProcurementExpenseCandidates } from "@/lib/server/procurement-projection";
import { saveProcurementSupplier, changeProcurementSupplierState, saveProcurementQuote, reviewProcurementQuote } from "@/lib/server/procurement-catalog";
import { selectProcurementQuote, prepareProcurementTransition, commitProcurementTransition, recordProcurementProgress, openProcurementException, resolveProcurementException, linkProcurementExpense } from "@/lib/server/procurement-commands";
import { proposeProcurementResponsibility, actOnProcurementResponsibility } from "@/lib/server/procurement-responsibility";
import { readProcurementQuoteSource, readProcurementQuotePreview, readProcurementRevisions } from "@/lib/server/procurement-sources";
import { acceptVolunteerInvitation, createVolunteerInvitation, restoreVolunteerProfile, reviewVolunteerEntry, revokeVolunteerInvitation, volunteerInvitationLink, validateVolunteerLeave, readVolunteerInvitations, type VolunteerEntryContext } from "@/lib/server/procurement-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Context = { params: Promise<{ procurementPath?: string[] }> };
const id = z.uuid(), packageId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), positive = z.coerce.number().int().positive();
function expectedScope(request: Request) { return z.string().regex(/^[a-f0-9]{64}$/).parse(request.headers.get(C.PROCUREMENT_SCOPE_HEADER)); }
function boundScope(request: Request, body: unknown) { const scope = expectedScope(request); if (!body || typeof body !== "object" || !("expectedScope" in body) || body.expectedScope !== scope) throw new DomainError("PROCUREMENT_CONTEXT_CHANGED", "The exact reviewed project or entry scope changed. Reload the current profile before continuing.", 409); }
async function browserKey() {
  const jar = await cookies(), name = `${sessionCookieName()}_procurement_entry`, saved = jar.get(name)?.value;
  if (saved && /^[A-Za-z0-9_-]{43}$/.test(saved)) return saved;
  const value = randomBytes(32).toString("base64url"); jar.set(name, value, { httpOnly: true, sameSite: "strict", secure: sessionCookieSecure(), path: "/", maxAge: 7 * 86400 }); return value;
}
async function entryContext(): Promise<VolunteerEntryContext> { const token = (await cookies()).get(sessionCookieName())?.value; return { session: await getSession(), credentialHash: token ? tokenHash(token) : null, browserKey: await browserKey() }; }
async function entryRateLimit(key: string) { const bucket = `procurement-entry:${tokenHash(key)}:${new Date().toISOString().slice(0, 16)}`, rows = await query("INSERT INTO fp_request_buckets(bucket_key,request_count) VALUES($1,1) ON CONFLICT(bucket_key) DO UPDATE SET request_count=fp_request_buckets.request_count+1 WHERE fp_request_buckets.request_count<90 RETURNING request_count", [bucket]); if (!rows.length) throw new DomainError("VOLUNTEER_ENTRY_BUSY", "This browser checked several private invitations. Wait a minute and retain the same original request.", 429); }

async function GETImplementation(request: Request, context: Context) {
  try {
    const parts = (await context.params).procurementPath ?? [], path = parts.join("/"), url = new URL(request.url);
    if (path === "context") { const token = (await cookies()).get(sessionCookieName())?.value, current = await readProcurementContext(await getSession(), token ? tokenHash(token) : null), expected = request.headers.get(C.PROCUREMENT_SCOPE_HEADER); if (expected !== null && expected !== current.scope) throw new DomainError("PROCUREMENT_CONTEXT_CHANGED", "The original project context changed. Open the intended current profile.", 409); return privateJson({ context: current }); }
    const session = await requireSession(["organizer", "volunteer", "auditor"]), scope = expectedScope(request), before = url.searchParams.get("before");
    if (!parts.length) return privateJson({ desk: await readProcurementDesk(session, scope) });
    if (parts.length === 1 && ["suppliers", "quotes", "sources", "candidates"].includes(path)) return privateJson({ page: await readProcurementCollection(session, scope, path as "suppliers" | "quotes" | "sources" | "candidates", before, url.searchParams.has("packageId") ? packageId.parse(url.searchParams.get("packageId")) : null) });
    if (parts[0] === "sources" && parts[1] === "uploads" && parts.length === 3) return privateJson(await readProcurementUpload(session, scope, id.parse(parts[2])));
    if (path === "invitations") return privateJson({ desk: await readVolunteerInvitations(session, scope, before) });
    if (parts[0] === "packages" && parts.length === 2) return privateJson({ detail: await readProcurementDetail(session, scope, packageId.parse(parts[1])) });
    if (parts[0] === "packages" && parts[2] === "history" && parts.length === 3) return privateJson({ page: await readProcurementHistory(session, scope, packageId.parse(parts[1]), before) });
    if (parts[0] === "packages" && parts[2] === "expenses" && parts.length === 3) return privateJson({ page: await readProcurementExpenseCandidates(session, scope, packageId.parse(parts[1]), before) });
    if (parts[0] === "history" && parts.length === 2) return privateJson({ detail: await readProcurementHistoryDetail(session, scope, id.parse(parts[1])) });
    if (["quotes", "suppliers"].includes(parts[0]) && parts.length === 3 && parts[2] === "versions") return privateJson({ page: await readProcurementRevisions(session, scope, parts[0] === "quotes" ? "quote" : "supplier", id.parse(parts[1]), before) });
    if (parts[0] === "quotes" && parts.length === 3 && parts[2] === "source") return privateJson({ detail: await readProcurementQuoteSource(session, scope, id.parse(parts[1]), positive.parse(url.searchParams.get("version"))) });
    if (parts[0] === "quotes" && parts.length === 3 && parts[2] === "preview") return new Response(new Uint8Array(await readProcurementQuotePreview(session, scope, id.parse(parts[1]), positive.parse(url.searchParams.get("version")), z.coerce.number().int().min(1).max(12).parse(url.searchParams.get("page")))), { headers: { ...PRIVATE_HEADERS, "Content-Type": "image/png", "Content-Disposition": 'inline; filename="private-procurement-quote.png"', "Content-Security-Policy": "default-src 'none'; sandbox" } });
    throw new DomainError("PROCUREMENT_NOT_FOUND", "This procurement view is unavailable.", 404);
  } catch (error) { return routeFailure(error); }
}
async function POSTImplementation(request: Request, context: Context) {
  try {
    assertSameOrigin(request); const parts = (await context.params).procurementPath ?? [], path = parts.join("/");
    if (parts[0] === "sources" && parts[1] === "uploads" && parts[3] === "content" && parts.length === 4) {
      const session = await requireSession(["organizer", "volunteer"]), scope = expectedScope(request), sourceId = id.parse(parts[2]);
      if (!planningQaEnabled()) throw new DomainError("PROCUREMENT_NOT_FOUND", "Use the original private upload service for this profile.", 404);
      const document = await ownProcurementUpload(session, sourceId, scope); await documentUploadGrant(session, document.id, document.pathname);
      if (Number(request.headers.get("content-length") ?? 0) > MAX_DOCUMENT_BYTES) throw new DomainError("INPUT_TOO_LARGE", "Choose a private quote source of at most 8 MB.", 413);
      const reader = request.body?.getReader(); if (!reader) throw new DomainError("INVALID_INPUT", "Choose the same original file to resume this upload.", 400); const chunks: Uint8Array[] = []; let length = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > document.declared_bytes || length > MAX_DOCUMENT_BYTES) { await reader.cancel(); throw new DomainError("INPUT_TOO_LARGE", "This file exceeds its original retained upload size.", 413); } chunks.push(next.value); } } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks); if (length !== document.declared_bytes || request.headers.get("content-type") !== document.content_type || createHash("sha256").update(bytes).digest("hex") !== document.expected_sha256) throw new DomainError("PROCUREMENT_SOURCE_CHANGED", "Choose the exact original file; the content does not match its retained upload draft.", 409);
      await planningDocumentStorage().write(document.pathname, bytes, document.content_type); await ownProcurementUpload(session, sourceId, scope, document.expected_sha256); return privateJson({ received: true });
    }
    const body = await requestJson(request, 192 * 1024);
    if (path.startsWith("entry/")) {
      const current = await entryContext(); await entryRateLimit(current.browserKey);
      if (path === "entry/review") return privateJson({ entry: await reviewVolunteerEntry(A.volunteerEntryInputSchema.parse(body), current) });
      boundScope(request, body);
      if (path === "entry/leave") { const input = A.volunteerLeaveSchema.parse(body); await validateVolunteerLeave(input.expectedScope, current); await rememberWorkspaceCookie(); (await cookies()).set(sessionCookieName(), "", { httpOnly: true, sameSite: "lax", secure: sessionCookieSecure(), path: "/", expires: new Date(0) }); return privateJson({ left: true }); }
      if (["entry/accept", "entry/restore"].includes(path)) { const joined = path === "entry/accept" ? await acceptVolunteerInvitation(A.volunteerAcceptSchema.parse(body), current) : await restoreVolunteerProfile(A.volunteerRestoreSchema.parse(body), current); await writeSessionCookie(joined.sessionToken, joined.session.expiresAt); await rememberWorkspaceCookie(joined.sessionToken); return privateJson(joined.result); }
      throw new DomainError("PROCUREMENT_NOT_FOUND", "This private entry action is unavailable.", 404);
    }
    boundScope(request, body); const session = await requireSession(["organizer", "volunteer"]);
    if (path === "sources/uploads") return privateJson(await saveProcurementUpload(session, procurementUploadInputSchema.parse(body)), 201);
    if (parts[0] === "sources" && parts[1] === "uploads" && parts.length === 4 && ["renew", "finalize"].includes(parts[3])) return privateJson(await actOnProcurementUpload(session, id.parse(parts[2]), parts[3] as "renew" | "finalize", procurementUploadActionSchema.parse(body)));
    if (path === "invitations") return privateJson(await createVolunteerInvitation(session, await browserKey(), A.volunteerInviteInputSchema.parse(body)), 201);
    if (parts[0] === "invitations" && parts.length === 3) { const invitationId = id.parse(parts[1]); if (parts[2] === "link") return privateJson(await volunteerInvitationLink(session, invitationId, A.volunteerInviteLinkSchema.parse(body))); if (parts[2] === "revoke") return privateJson({ receipt: await revokeVolunteerInvitation(session, await browserKey(), invitationId, A.volunteerInviteActionSchema.parse(body)) }); }
    if (path === "suppliers") return privateJson({ receipt: await saveProcurementSupplier(session, C.supplierSaveSchema.parse(body)) });
    if (parts[0] === "suppliers" && parts[2] === "state" && parts.length === 3) return privateJson({ receipt: await changeProcurementSupplierState(session, id.parse(parts[1]), C.supplierStateSchema.parse(body)) });
    if (path === "quotes") return privateJson({ receipt: await saveProcurementQuote(session, C.quoteSaveSchema.parse(body)) });
    if (parts[0] === "quotes" && parts[2] === "review" && parts.length === 3) return privateJson({ receipt: await reviewProcurementQuote(session, id.parse(parts[1]), C.quoteReviewSchema.parse(body)) });
    if (path === "quotes/select") return privateJson({ receipt: await selectProcurementQuote(session, C.quoteSelectionInputSchema.parse(body)) });
    if (path === "responsibilities") return privateJson({ receipt: await proposeProcurementResponsibility(session, C.responsibilityProposeSchema.parse(body)) });
    if (parts[0] === "responsibilities" && parts[2] === "state" && parts.length === 3) return privateJson({ receipt: await actOnProcurementResponsibility(session, id.parse(parts[1]), C.responsibilityActionSchema.parse(body)) });
    if (path === "transitions/prepare") return privateJson({ review: await prepareProcurementTransition(session, C.procurementTransitionPrepareSchema.parse(body)) });
    if (path === "transitions/commit") return privateJson({ receipt: await commitProcurementTransition(session, C.procurementTransitionCommitSchema.parse(body)) });
    if (path === "progress") return privateJson({ receipt: await recordProcurementProgress(session, C.procurementProgressInputSchema.parse(body)) });
    if (path === "exceptions") return privateJson({ receipt: await openProcurementException(session, C.procurementExceptionInputSchema.parse(body)) });
    if (parts[0] === "exceptions" && parts[2] === "resolve" && parts.length === 3) return privateJson({ receipt: await resolveProcurementException(session, id.parse(parts[1]), C.procurementExceptionResolveSchema.parse(body)) });
    if (path === "expenses") return privateJson({ receipt: await linkProcurementExpense(session, C.procurementExpenseLinkInputSchema.parse(body)) });
    throw new DomainError("PROCUREMENT_NOT_FOUND", "This procurement action is unavailable.", 404);
  } catch (error) { return routeFailure(error); }
}
export const GET = (request: Request, context: Context) => guardedApi(request, () => GETImplementation(request, context));
export const POST = (request: Request, context: Context) => guardedApi(request, () => POSTImplementation(request, context));
