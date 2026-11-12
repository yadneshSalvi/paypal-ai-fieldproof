import { DomainError } from "../domain/money";

export function supporterQaProfile() {
  const profile=process.env.FIELDPROOF_SUPPORTER_QA_PROFILE??"story-stage8";
  if(profile==="story-stage8")return {port:"55554",database:"fp_story_stage8",origin:"http://localhost:4553",cookie:"fieldproof_supporter_story_stage8_session",documents:".local/story-unit/documents"} as const;
  if(profile==="native-repair-stage9")return {port:"55558",database:"fp_story_stage9",origin:"http://localhost:4559",cookie:"fieldproof_supporter_native_stage9_session",documents:".local/native-repair-unit/documents"} as const;
  throw new DomainError("QA_STORAGE_ISOLATION","That isolated supporter review profile is unavailable.",503);
}

/** The community QA process cannot acquire a provider merely by loading a .env file. */
export function assertProviderAccess(): void {
  if (process.env.FIELDPROOF_PROVIDER_ACCESS === "disabled" || process.env.FIELDPROOF_COMMUNITY_QA === "true" || process.env.FIELDPROOF_FUNDING_QA === "true" || process.env.FIELDPROOF_SUPPORTER_QA === "true")
    throw new DomainError("PROVIDERS_DISABLED", "Provider access is disabled in this isolated workspace. Your sources and manual drafts remain available.", 503);
}

/** Separate from every earlier fixture: a local production-build read review. */
export function supporterQaEnabled():boolean {
  if(process.env.FIELDPROOF_SUPPORTER_QA!=="true")return false;
  const url=new URL(process.env.DATABASE_URL??"postgresql://invalid/invalid"),profile=supporterQaProfile();
  if(process.env.VERCEL==="1"||!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||url.port!==profile.port||url.pathname!==`/${profile.database}`||url.username!==profile.database||process.env.APP_URL!==profile.origin)
    throw new DomainError("QA_STORAGE_ISOLATION","The supporter review requires its own local database and exact review origin.",503);
  const credentials=["OPENAI_API_KEY","GEMINI_API_KEY","GOOGLE_API_KEY","BLOB_READ_WRITE_TOKEN",...Object.keys(process.env).filter(key=>/^(PAYPAL_|NEXT_PUBLIC_PAYPAL_)/.test(key)&&!["PAYPAL_ENVIRONMENT","PAYPAL_PROJECT_ISOLATED"].includes(key))];
  if(process.env.FIELDPROOF_PROVIDER_ACCESS!=="disabled"||process.env.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED==="true"||credentials.some(key=>Boolean(process.env[key])))
    throw new DomainError("QA_PROVIDER_ISOLATION","The supporter review requires blank provider credentials and disabled external access.",503);
  return true;
}

/** Production-build review is confined to a dedicated local database, exact
 * localhost origin, separate cookies and blank credentials. A hosted process
 * cannot enable the fixture actor chooser or acquire provider access. */
export function fundingQaEnabled():boolean {
  if(process.env.FIELDPROOF_FUNDING_QA!=="true")return false;
  const url=new URL(process.env.DATABASE_URL??"postgresql://invalid/invalid"),name=url.pathname.slice(1);
  if(process.env.VERCEL==="1"||!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||url.port!=="5432"||!/^fp_lifecycle_qa_[a-z0-9_]+$/.test(name)||url.username!==name||process.env.APP_URL!=="http://localhost:4535")
    throw new DomainError("QA_STORAGE_ISOLATION","The funding review requires its own local database and exact review origin.",503);
  const credentials=["OPENAI_API_KEY","GEMINI_API_KEY","GOOGLE_API_KEY","BLOB_READ_WRITE_TOKEN",...Object.keys(process.env).filter(key=>/^(PAYPAL_|NEXT_PUBLIC_PAYPAL_)/.test(key)&&!['PAYPAL_ENVIRONMENT','PAYPAL_PROJECT_ISOLATED'].includes(key))];
  if(process.env.FIELDPROOF_PROVIDER_ACCESS!=="disabled"||process.env.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED==="true"||credentials.some(key=>Boolean(process.env[key])))
    throw new DomainError("QA_PROVIDER_ISOLATION","The funding review requires blank provider credentials and disabled external access.",503);
  return true;
}
export function communityQaEnabled(): boolean {
  if (process.env.FIELDPROOF_COMMUNITY_QA !== "true" || process.env.NODE_ENV === "production") return false;
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.port !== "5432" || !/^\/fp_community_qa_[a-z0-9_]+$/.test(url.pathname))
    throw new DomainError("QA_STORAGE_ISOLATION", "The community review requires its own local database.", 503);
  return true;
}
