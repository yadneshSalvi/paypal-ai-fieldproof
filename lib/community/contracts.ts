import { z } from "zod";
import type { WorkspaceRole } from "../contracts";
import { TEMPLATE_IDS, type TemplateId } from "./templates";

export const COMMUNITY_CONTRACT = "community-source-v1";
export type CommunityLocale = "en" | "es";
export type BriefAudience = "treasurer" | "supporter";
export interface WorkspaceEntry {
  sessionId: string; projectId: string; title: string; subtitle: string; templateId: TemplateId;
  mode: "sample" | "live_sandbox"; role: WorkspaceRole; expiresAt: string; current: boolean; available: boolean;
}
export interface WorkspaceLibrary { ready: boolean; currentProjectId: string | null; entries: WorkspaceEntry[]; }
export const createWorkspaceSchema = z.object({ intentId: z.uuid(), templateId: z.enum(TEMPLATE_IDS), title: z.string().trim().min(3).max(100), expectedProjectId: z.string().min(1).max(100).nullable(), acknowledged: z.literal(true) }).strict();
export const switchWorkspaceSchema = z.object({ sessionId: z.uuid(), expectedProjectId: z.string().min(1).max(100).nullable() }).strict();

export interface BriefCitation { rowId: string; rowHash: string; label: string; href: string; }
export interface BriefValue { key: string; kind: "money" | "count" | "date" | "text"; value: string | number; displayEs?: string; }
export interface BriefStatement {
  id: string; category: "project" | "funding" | "evidence" | "repayment" | "consent" | "exception" | "personal";
  english: string; spanish: string; values: BriefValue[]; citations: BriefCitation[];
}
export interface BriefSourceRow { id: string; hash: string; kind: string; label: string; href: string; fields: Record<string, string | number | boolean | null | string[]>; }
export interface BriefSource {
  contract: typeof COMMUNITY_CONTRACT; audience: BriefAudience; projectId: string; templateId: TemplateId;
  title: string; mode: "sample" | "live_sandbox"; contentHash: string; capturedAt: string; rows: BriefSourceRow[]; statements: BriefStatement[];
}
export interface BriefSnapshot extends BriefSource { id: string; snapshotHash: string; current: boolean; }
export const captureBriefSchema = z.object({ intentId: z.uuid(), audience: z.enum(["treasurer", "supporter"]) }).strict();
export const saveBriefSchema = z.object({ intentId: z.uuid(), snapshotId: z.uuid(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), statementIds: z.array(z.string().min(1).max(120)).min(1).max(40), title: z.string().trim().min(3).max(120) }).strict();
export interface BriefDraft { id: string; snapshotId: string; sourceHash: string; contentHash: string; title: string; audience: BriefAudience; createdAt: string; origin: "selected" | "model"; sourceRunId: string | null; paragraphs: BriefStatement[]; current: boolean; }
export const translationParagraphSchema = z.object({ paragraphId: z.string().min(1).max(120), text: z.string().trim().min(1).max(2000) }).strict();
export interface TranslationParagraph { paragraphId: string; text: string; }
export const translationSchema = z.object({ paragraphs: z.array(translationParagraphSchema).min(1).max(40) }).strict();
export const saveTranslationSchema = z.object({ intentId: z.uuid(), draftId: z.uuid(), expectedHead: z.number().int().min(0), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), paragraphs: translationSchema.shape.paragraphs }).strict();
export const backTranslationSchema = z.object({ intentId: z.uuid(), translationId: z.uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), paragraphs: translationSchema.shape.paragraphs, manualAcknowledged: z.literal(true) }).strict();
export const reviewTranslationSchema = z.object({ intentId: z.uuid(), translationId: z.uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), backTranslationHash: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(["approved", "needs_changes"]), kind: z.enum(["fluent_reviewer", "sample_exercise"]), note: z.string().trim().min(12).max(1400), sourceCompared: z.literal(true), amountsAndConditionsChecked: z.literal(true), fluentSpanishAttested: z.boolean() }).strict();
export const previewUpdateSchema = z.object({ intentId: z.uuid(), draftId: z.uuid(), translationId: z.uuid().nullable(), acknowledged: z.literal(true) }).strict();
export interface TranslationView {
  id: string; draftId: string; revision: number; sourceHash: string; contentHash: string; paragraphs: TranslationParagraph[];
  origin: "authored_starter" | "manual" | "model"; createdAt: string; current: boolean;
  backTranslation: { paragraphs: TranslationParagraph[]; hash: string; origin: "manual" | "model"; sourceRunId: string | null } | null;
  review: { decision: "approved" | "needs_changes"; kind: "fluent_reviewer" | "sample_exercise"; reviewedAt: string; reviewerLabel: string; note: string } | null;
  status: "review_pending" | "changes_requested" | "sample_review" | "reviewed" | "stale";
}
export const startCommunityRunSchema = z.object({ intentId: z.uuid(), task: z.enum(["brief", "translate", "backtranslate"]), snapshotId: z.uuid().nullable(), draftId: z.uuid().nullable(), translationId: z.uuid().nullable(), acknowledged: z.literal(true) }).strict();
export const modelBriefSchema = z.object({ selections: z.array(z.object({ statementId: z.string(), citationRowIds: z.array(z.string()).min(1).max(20) }).strict()).min(1).max(40), unknownStatementIds: z.array(z.string()).max(20) }).strict();
export interface CommunityRunView {
  id: string; task: "brief" | "translate" | "backtranslate"; state: "queued" | "running" | "succeeded" | "failed" | "unknown";
  model: string; inputHash: string; responseIdentityHash: string | null; outputHash: string | null; resultId: string | null;
  createdAt: string; completedAt: string | null; code: string | null; dispatchCount: number; pollCount: number;
  durationMs: number | null; inputTokens: number | null; outputTokens: number | null;
}
export interface CommunityDesk {
  projectId: string; projectTitle: string; role: WorkspaceRole; mode: "sample" | "live_sandbox";
  snapshots: BriefSnapshot[]; drafts: BriefDraft[]; translations: TranslationView[]; runs: CommunityRunView[];
  modelConfigured: boolean; scheduleEnabled: false; deliveryMode: "preview_only";
}
export interface SupporterStory {
  source: BriefSource; personal: BriefSource; translation: { status: "authored_unreviewed"; sourceHash: string }; drafts: { draft: BriefDraft; translation: TranslationView | null }[];
}
