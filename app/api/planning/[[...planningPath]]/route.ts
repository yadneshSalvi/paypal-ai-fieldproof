import { after } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { assertSameOrigin, getSession, requireSession, writeSessionCookie } from "@/lib/server/auth";
import { guardedApi } from "@/lib/server/maintenance";
import { privateJson, PRIVATE_HEADERS, requestJson, routeFailure } from "@/lib/server/http";
import { DomainError } from "@/lib/domain/money";
import { MAX_DOCUMENT_BYTES, newDocumentSchema } from "@/lib/domain/evidence";
import { alignmentInputSchema, alignmentReviewSchema, alignmentRevokeSchema, publishPlanSchema, qualificationInputSchema, qualificationReviewSchema, reviewPlanSchema, savePlanSchema, signoffInputSchema, sourcePermissionSchema, reviewerInviteSchema, reviewerInviteRevokeSchema, reviewerRedeemSchema } from "@/lib/planning/contracts";
import { planningScenario, publishReviewedPlan, readPlanningVersion, readPlanningWorkspace, reviewPlan, revokePlanSchema, revokePublishedPlan, savePlan, scenarioSchema } from "@/lib/server/planning";
import { importSamplePlanningSources, planningDocumentStorage, planningQaEnabled, planningSourcePreview, setPlanningSourcePermission } from "@/lib/server/planning-sources";
import { createUploadDocument, documentUploadGrant, finalizeDocument, renewDocumentUpload, requireDocument } from "@/lib/server/documents";
import { nextPlanContinuations, retryPlanExtraction, runPlanExtraction, startPlanExtraction, startPlanExtractionSchema } from "@/lib/server/planning-extraction";
import { recordWorkSignoff, requestReviewerQualification, reviewPhotoAlignment, reviewReviewerQualification, savePhotoAlignment, sharedAlignmentImage, revokePhotoAlignment } from "@/lib/server/planning-evidence";
import { createReviewerInvite, redeemReviewerInvite, revokeReviewerInvite } from "@/lib/server/planning-reviewer-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Context = { params: Promise<{ planningPath?: string[] }> };
const empty = z.object({}).strict();
async function GETImplementation(request: Request, context: Context) {
  try {
    const session = await requireSession(), parts = (await context.params).planningPath ?? [];
    if (!parts.length) {
      const workspace = await readPlanningWorkspace(session);
      // Continue only already-submitted response IDs. A workspace read cannot start an inference.
      if (session.role === "organizer") for (const id of await nextPlanContinuations(session)) after(() => runPlanExtraction(id));
      return privateJson({ workspace });
    }
    if (parts[0] === "versions" && parts.length === 2) return privateJson({ version: await readPlanningVersion(session, z.uuid().parse(parts[1])) });
    if (parts[0] === "alignments" && parts[2] === "image" && parts.length === 3) return new Response(new Uint8Array(await sharedAlignmentImage(session, z.uuid().parse(parts[1]))), { headers: { ...PRIVATE_HEADERS, "Content-Type": "image/png", "Content-Disposition": 'inline; filename="reviewed-project-image.png"', "Content-Security-Policy": "default-src 'none'; sandbox" } });
    if (parts[0] === "sources" && parts[2] === "preview" && parts.length === 3) {
      const id = z.uuid().parse(parts[1]), page = z.coerce.number().int().min(1).max(12).parse(new URL(request.url).searchParams.get("page") ?? 1);
      return new Response(new Uint8Array(await planningSourcePreview(session, id, page)), { headers: { ...PRIVATE_HEADERS, "Content-Type": "image/png", "Content-Disposition": 'inline; filename="private-planning-source.png"', "Content-Security-Policy": "default-src 'none'; sandbox" } });
    }
    throw new DomainError("NOT_FOUND", "This planning view is unavailable.", 404);
  } catch (error) { return routeFailure(error); }
}
async function POSTImplementation(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const parts = (await context.params).planningPath ?? [];
    if (parts.join("/") === "reviewers/redeem") {
      const input = reviewerRedeemSchema.parse(await requestJson(request, 2048));
      const result = await redeemReviewerInvite(input, await getSession());
      await writeSessionCookie(result.sessionToken, result.session.expiresAt);
      return privateJson({ joined: true, expiresAt: result.session.expiresAt });
    }
    const session = await requireSession();
    if (parts[0] === "sources" && parts[2] === "content" && parts.length === 3) {
      if (!planningQaEnabled()) throw new DomainError("NOT_FOUND", "Use the private upload service for this workspace.", 404);
      const document = await requireDocument(session, z.uuid().parse(parts[1]));
      await documentUploadGrant(session, document.id, document.pathname);
      if (Number(request.headers.get("content-length") ?? 0) > MAX_DOCUMENT_BYTES) throw new DomainError("DOCUMENT_SIZE", "Choose a source smaller than 8 MB.", 413);
      const reader = request.body?.getReader(); if (!reader) throw new DomainError("UPLOAD_EMPTY", "Choose the same file to resume this upload.", 400);
      const chunks: Uint8Array[] = []; let length = 0;
      try { while (true) { const result = await reader.read(); if (result.done) break; length += result.value.byteLength; if (length > document.declared_bytes || length > MAX_DOCUMENT_BYTES) { await reader.cancel(); throw new DomainError("DOCUMENT_SIZE", "This file no longer matches its upload draft.", 413); } chunks.push(result.value); } } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks);
      if (length !== document.declared_bytes || request.headers.get("content-type") !== document.content_type || createHash("sha256").update(bytes).digest("hex") !== document.expected_sha256) throw new DomainError("UPLOAD_CONTENT_CHANGED", "Choose the original file for this upload draft.", 409);
      await planningDocumentStorage().write(document.pathname, bytes, document.content_type);
      return privateJson({ received: true });
    }
    const body = await requestJson(request, 256 * 1024);
    if (parts[0] === "sources") {
      if (parts.length === 1) {
        const data = newDocumentSchema.parse(body);
        if (!["sketch", "quote", "photo", "signoff"].includes(data.purpose)) throw new DomainError("SOURCE_KIND", "Choose a sketch, quote, photograph or review document.", 422);
        return privateJson(await createUploadDocument(session, data), 201);
      }
      if (parts[1] === "sample" && parts.length === 2) {
        const data = z.object({ intentId: z.uuid(), sampleAcknowledged: z.literal(true) }).strict().parse(body);
        await importSamplePlanningSources(session, data.intentId);
      } else {
        const id = z.uuid().parse(parts[1]);
        if (parts.length !== 3) throw new DomainError("NOT_FOUND", "This source action is unavailable.", 404);
        if (parts[2] === "finalize") { empty.parse(body); await finalizeDocument(session, id, planningDocumentStorage()); }
        else if (parts[2] === "renew") { empty.parse(body); return privateJson({ document: await renewDocumentUpload(session, id) }); }
        else if (parts[2] === "permission") await setPlanningSourcePermission(session, id, sourcePermissionSchema.parse(body));
        else throw new DomainError("NOT_FOUND", "This source action is unavailable.", 404);
      }
    } else if (parts.length === 1 && parts[0] === "save") await savePlan(session, savePlanSchema.parse(body));
    else if (parts.length === 1 && parts[0] === "review") await reviewPlan(session, reviewPlanSchema.parse(body));
    else if (parts.length === 1 && parts[0] === "publish") await publishReviewedPlan(session, publishPlanSchema.parse(body));
    else if (parts.length === 1 && parts[0] === "withdraw") await revokePublishedPlan(session, revokePlanSchema.parse(body));
    else if (parts.length === 1 && parts[0] === "scenario") return privateJson({ scenario: await planningScenario(session, scenarioSchema.parse(body)) });
    else if (parts[0] === "extract" && parts.length === 1) {
      const run = await startPlanExtraction(session, startPlanExtractionSchema.parse(body));
      if (run.state === "queued") after(() => runPlanExtraction(run.id));
      return privateJson({ run, workspace: await readPlanningWorkspace(session) }, run.state === "succeeded" ? 200 : 202);
    } else if (parts[0] === "runs" && parts[2] === "retry" && parts.length === 3) {
      z.object({ acknowledged: z.literal(true) }).strict().parse(body);
      const run = await retryPlanExtraction(session, z.uuid().parse(parts[1]));
      if (run.state === "queued") after(() => runPlanExtraction(run.id));
      return privateJson({ run, workspace: await readPlanningWorkspace(session) }, 202);
    } else if (parts[0] === "alignments" && parts.length === 1) await savePhotoAlignment(session, alignmentInputSchema.parse(body));
    else if (parts[0] === "alignments" && parts[2] === "review" && parts.length === 3) await reviewPhotoAlignment(session, z.uuid().parse(parts[1]), alignmentReviewSchema.parse(body));
    else if (parts[0] === "alignments" && parts[2] === "withdraw" && parts.length === 3) await revokePhotoAlignment(session, z.uuid().parse(parts[1]), alignmentRevokeSchema.parse(body));
    else if (parts[0] === "qualifications" && parts.length === 1) await requestReviewerQualification(session, qualificationInputSchema.parse(body));
    else if (parts[0] === "qualifications" && parts[2] === "review" && parts.length === 3) await reviewReviewerQualification(session, z.uuid().parse(parts[1]), qualificationReviewSchema.parse(body));
    else if (parts[0] === "signoffs" && parts.length === 1) await recordWorkSignoff(session, signoffInputSchema.parse(body));
    else if (parts.join("/") === "reviewers/invites") {
      const invitation = await createReviewerInvite(session, reviewerInviteSchema.parse(body));
      return privateJson({ invitation, workspace: await readPlanningWorkspace(session) });
    } else if (parts[0] === "reviewers" && parts[2] === "withdraw" && parts.length === 3) await revokeReviewerInvite(session, z.uuid().parse(parts[1]), reviewerInviteRevokeSchema.parse(body));
    else throw new DomainError("NOT_FOUND", "This planning action is unavailable.", 404);
    return privateJson({ workspace: await readPlanningWorkspace(session) });
  } catch (error) { return routeFailure(error); }
}
export const GET = (...args: Parameters<typeof GETImplementation>) => guardedApi(args[0], () => GETImplementation(...args));
export const POST = (...args: Parameters<typeof POSTImplementation>) => guardedApi(args[0], () => POSTImplementation(...args));
