import { DomainError } from "../domain/money";

/** The community QA process cannot acquire a provider merely by loading a .env file. */
export function assertProviderAccess(): void {
  if (process.env.FIELDPROOF_PROVIDER_ACCESS === "disabled" || process.env.FIELDPROOF_COMMUNITY_QA === "true")
    throw new DomainError("PROVIDERS_DISABLED", "Provider access is disabled in this isolated workspace. Your sources and manual drafts remain available.", 503);
}
export function communityQaEnabled(): boolean {
  if (process.env.FIELDPROOF_COMMUNITY_QA !== "true" || process.env.NODE_ENV === "production") return false;
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.port !== "5432" || !/^\/fp_community_qa_[a-z0-9_]+$/.test(url.pathname))
    throw new DomainError("QA_STORAGE_ISOLATION", "The community review requires its own local database.", 503);
  return true;
}
