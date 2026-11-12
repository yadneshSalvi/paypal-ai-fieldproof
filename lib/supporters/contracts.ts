import { z } from "zod";

export const SUPPORTER_ACCESS_VERSION = "supporter-access-v1" as const;
export const supporterPurposeSchema = z.enum(["donor", "sponsor"]);
const scope = z.string().regex(/^[a-f0-9]{64}$/);
const token = z.string().regex(/^[A-Za-z0-9_-]{64}$/);
const name = z.string().trim().min(2).max(80).refine(value => !/[\u0000-\u001f\u007f]/.test(value), "Use a name without control characters.");
export const supporterInviteSchema = z.object({
  intentId: z.uuid(), expectedScope: scope, label: name, purpose: supporterPurposeSchema,
  expiresHours: z.number().int().min(1).max(168), acknowledged: z.literal(true),
}).strict();
export const supporterRevokeSchema = z.object({ intentId: z.uuid(), expectedScope: scope, expectedVersion: z.number().int().positive(), acknowledged: z.literal(true) }).strict();
export const supporterLinkSchema = z.object({ expectedScope: scope, expectedVersion: z.number().int().positive() }).strict();
export const supporterEntrySchema = z.object({ kind: z.enum(["invite", "access"]), token, intentId: z.uuid().optional() }).strict();
export const supporterAcceptSchema = z.object({
  token, intentId: z.uuid(), expectedScope: scope, displayName: name,
  contractVersion: z.literal(SUPPORTER_ACCESS_VERSION), acknowledged: z.literal(true),
}).strict();
export const supporterRestoreSchema = z.object({ token, intentId: z.uuid(), expectedScope: scope, acknowledged: z.literal(true) }).strict();
export const supporterLeaveSchema = z.object({ expectedScope: scope, acknowledged: z.literal(true) }).strict();

export type SupporterPurpose = z.infer<typeof supporterPurposeSchema>;
export type SupporterInviteState = "invited" | "joined" | "expired" | "revoked" | "authority_changed";
export interface SupporterInviteView {
  id: string; version: number; label: string; purpose: SupporterPurpose; role: "donor";
  state: SupporterInviteState; createdAt: string; expiresAt: string; joinedAt: string | null; revokedAt: string | null;
  recipient: { displayName: string; identityProvenance: "self_declared" } | null;
  canShare: boolean; canRevoke: boolean;
}
export interface SupporterDesk {
  projectId: string; projectTitle: string; mode: "sample" | "live_sandbox"; scope: string;
  sessionExpiresAt: string; invitations: SupporterInviteView[];
}
export type SupporterEntryState = "ready" | "issuer" | "switch_required" | "joined_here" | "used" | "expired" | "revoked" | "authority_changed" | "unavailable";
export interface SupporterEntryView {
  kind: "invite" | "access"; state: SupporterEntryState; scope: string;
  project: { title: string; mode: "sample" | "live_sandbox" } | null;
  purpose: SupporterPurpose | null; role: "donor"; expiresAt: string | null;
  current: { title: string; role: string; expiresAt: string } | null;
  recipient: { displayName: string; identityProvenance: "self_declared" } | null;
  canLeave: boolean; canAccept: boolean; canRestore: boolean;
}
export interface SupporterWelcome {
  projectId: string; projectTitle: string; purpose: SupporterPurpose; displayName: string;
  role: "donor"; expiresAt: string; identityProvenance: "self_declared";
}
