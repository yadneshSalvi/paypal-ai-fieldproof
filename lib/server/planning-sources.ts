import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import type { SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import { MAX_DOCUMENT_BYTES } from "../domain/evidence";
import { DomainError } from "../domain/money";
import { sourcePermissionSchema, type PlanSourceView } from "../planning/contracts";
import type { Session } from "./auth";
import { database } from "./db";
import { createUploadDocument, documentPreview, finalizeDocument, requireDocument } from "./documents";
import { privateDocumentStorage, type DocumentStorage } from "./document-storage";
import { lockPlanningAuthority, planningAction, sourceControl, sourcesView } from "./planning-store";
import { appendEvent } from "./repository";
import { communityQaEnabled, supporterQaEnabled, supporterQaProfile } from "./provider-access";
import { communityTemplate, type TemplateId } from "../community/templates";
import { query } from "./db";
import { boardPackReviewEnabled } from "./board-pack-review";
import { organizationReviewEnabled } from "./organization-review";
import { lifecycleReviewEnabled } from "./lifecycle-review";

export function planningQaEnabled(): boolean {
  if (lifecycleReviewEnabled()) return true;
  if (organizationReviewEnabled()) return true;
  if (boardPackReviewEnabled()) return true;
  if (supporterQaEnabled()) return true;
  if (communityQaEnabled()) return true;
  if (process.env.NODE_ENV === "production" || process.env.FIELDPROOF_PLANNING_QA !== "true") return false;
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !/^\/fp_planning_qa_[a-z0-9_]+$/.test(url.pathname))
    throw new DomainError("QA_STORAGE_ISOLATION", "The planning review requires its own local database.", 503);
  return true;
}
function localPath(pathname: string): string {
  if (!planningQaEnabled() || !/^fieldproof\/[0-9a-f-]{36}\/[a-zA-Z0-9._/-]+$/.test(pathname) || pathname.includes("..")) throw new DomainError("DOCUMENT_PATH", "This private source location is unavailable.", 409);
  return resolve(lifecycleReviewEnabled() ? ".local/lifecycle-unit/documents" : organizationReviewEnabled() ? ".local/governance-unit/documents" : boardPackReviewEnabled() ? ".local/board-pack-unit/documents" : supporterQaEnabled() ? supporterQaProfile().documents : communityQaEnabled() ? ".local/community-qa/documents" : ".local/planning-qa/documents", pathname);
}
const localPlanningStorage: DocumentStorage = {
  async read(pathname, maxBytes = MAX_DOCUMENT_BYTES) {
    const path = localPath(pathname);
    try {
      if ((await stat(path)).size > maxBytes) throw new DomainError("DOCUMENT_SIZE", "The private source is too large.", 413);
      const bytes = await readFile(path), metadata = JSON.parse(await readFile(`${path}.json`, "utf8")) as { contentType: string; hash: string };
      if (bytes.length > maxBytes || createHash("sha256").update(bytes).digest("hex") !== metadata.hash) throw new DomainError("DOCUMENT_CONTENT_CHANGED", "The private source no longer matches its saved version.", 409);
      return { bytes, contentType: metadata.contentType, pathname };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("UPLOAD_NOT_AVAILABLE", "The source has not arrived yet. Retry the same upload draft.", 409);
    }
  },
  async write(pathname, bytes, contentType) {
    const path = localPath(pathname), hash = createHash("sha256").update(bytes).digest("hex");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
      await writeFile(`${path}.json`, JSON.stringify({ contentType, hash }), { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      const previous = await localPlanningStorage.read(pathname, Math.max(bytes.length, MAX_DOCUMENT_BYTES));
      if (previous.contentType !== contentType || createHash("sha256").update(previous.bytes).digest("hex") !== hash) throw new DomainError("DOCUMENT_CONTENT_CHANGED", "A different source already occupies this immutable location.", 409);
    }
  },
};
export function planningDocumentStorage(): DocumentStorage { return planningQaEnabled() ? localPlanningStorage : privateDocumentStorage; }
export async function planningSourcePreview(session: Session, id: string, page: number): Promise<Buffer> {
  const row = await requireDocument(session, id);
  const control = await sourceControl(row);
  if (control.permission !== "allowed" || !["sketch", "quote", "photo", "signoff"].includes(row.purpose)) throw new DomainError("SOURCE_PERMISSION_WITHDRAWN", "This source is unavailable for planning review.", 404);
  return documentPreview(session, id, page, planningDocumentStorage());
}
export async function setPlanningSourcePermission(session: Session, id: string, raw: z.infer<typeof sourcePermissionSchema>): Promise<void> {
  const input = sourcePermissionSchema.parse(raw);
  await database().transaction(async tx => {
    await lockPlanningAuthority(session, ["organizer", "volunteer"], tx);
    await planningAction(session, input.intentId, "source-permission", { id, ...input }, tx, async () => {
      const row = await requireDocument(session, id, tx);
      if (!["sketch", "quote", "photo", "signoff"].includes(row.purpose)) throw new DomainError("SOURCE_KIND", "Use this control only for planning and physical evidence sources.", 422);
      const control = await sourceControl(row, tx, true);
      const result = await tx.query("UPDATE fp_plan_source_controls SET version=version+1,permission=$4,updated_at=now() WHERE document_id=$1 AND tenant_id=$2 AND project_id=$3 AND version=$5 RETURNING version", [id, session.tenantId, session.projectId, input.permission, input.expectedVersion]);
      if (!result.rows.length || control.version !== input.expectedVersion) throw new DomainError("SOURCE_VERSION_CHANGED", "The source permission changed. Refresh before reviewing it again.", 409);
      await appendEvent(tx, session, "planning.source_permission_changed", input.permission === "withdrawn" ? "A planning source was withdrawn" : "A planning source can be reviewed again", "Dependent plan versions, image alignments and sign-offs must be checked against the new source permission version.");
      return { documentId: id, version: input.expectedVersion + 1, permission: input.permission };
    });
  });
}
function derivedIntent(intent: string, name: string): string {
  const value = createHash("sha256").update(`${intent}:${name}`).digest("hex").slice(0, 32).split(""); value[12] = "4"; value[16] = "8";
  const hex = value.join(""); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function importSamplePlanningSources(session: Session, intentId: string, storage: DocumentStorage = planningDocumentStorage()): Promise<PlanSourceView[]> {
  if (session.mode !== "sample" || session.role !== "organizer") throw new DomainError("SAMPLE_ONLY", "Open an organizer view in a sample workspace to use the illustrated planning pack.", 403);
  const [project] = await query<{ metadata: { templateId?: TemplateId } }>("SELECT metadata FROM fp_projects WHERE id=$1 AND tenant_id=$2", [session.projectId, session.tenantId]);
  const template = communityTemplate(project?.metadata.templateId);
  const assets = [
    { name: `${template.assetPrefix}-sketch`, purpose: "sketch" as const, title: `Sample · ${template.name} sketch.png` },
    { name: `${template.assetPrefix}-quotes`, purpose: "quote" as const, title: `Sample · ${template.name} supplier quotes.png` },
    { name: `${template.assetPrefix}-alignment`, purpose: "photo" as const, title: `Sample · ${template.name} alignment illustration.png` },
    { name: `${template.assetPrefix}-review-scope`, purpose: "signoff" as const, title: `Sample · ${template.name} reviewer scope exercise.png` },
  ];
  for (const asset of assets) {
    const svg = await readFile(resolve(`public/samples/outlined/${asset.name}.svg`)), bytes = await sharp(svg, { density: 128 }).png().toBuffer();
    const draft = await createUploadDocument(session, { intentId: derivedIntent(intentId, asset.name), filename: asset.title, purpose: asset.purpose,
      contentType: "image/png", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), permissionConfirmed: true }, "sample_document");
    if (draft.document.state === "awaiting_upload") await storage.write(draft.pathname, bytes, "image/png");
    await finalizeDocument(session, draft.document.id, storage);
    await database().transaction(async tx => { await lockPlanningAuthority(session, ["organizer"], tx); await sourceControl(await requireDocument(session, draft.document.id, tx), tx, true); });
  }
  return sourcesView(session);
}
export async function assertPlanningSourceOwner(session: Session, id: string, tx: SqlConnection) {
  const row = await requireDocument(session, id, tx);
  if (row.actor_id !== session.actorId) throw new DomainError("SOURCE_OWNER_REQUIRED", "Use a source you submitted for your reviewer credentials or sign-off.", 403);
  return row;
}
