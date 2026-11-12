import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { WorkspaceRole } from "../contracts";
import { DomainError } from "../domain/money";
import { database, initializeDatabase, query } from "./db";
import { createProject } from "./seed";
import { requireMembership } from "./membership";
import { communityQaEnabled, fundingQaEnabled, supporterQaEnabled, supporterQaProfile } from "./provider-access";
import { boardPackReviewEnabled } from "./board-pack-review";
import { onboardingReviewEnabled, onboardingReviewProfile } from "./onboarding-review";
import { organizationReviewEnabled } from "./organization-review";

export function sessionCookieName(): string {
  if (organizationReviewEnabled()) return "fieldproof_governance_stage13_project_session";
  if (boardPackReviewEnabled()) return "fieldproof_boardpack_stage12_session";
  if (onboardingReviewEnabled()) return onboardingReviewProfile().cookie;
  if(supporterQaEnabled())return supporterQaProfile().cookie;
  if(fundingQaEnabled())return "fieldproof_funding_lifecycle_qa_session";
  if (process.env.NODE_ENV === "production") return "fieldproof_session";
  if (communityQaEnabled()) return "fieldproof_community_qa_session";
  if (process.env.FIELDPROOF_PLANNING_QA === "true") {
    const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/fp_planning_qa_[a-z0-9_]+$/.test(url.pathname))
      throw new DomainError("QA_STORAGE_ISOLATION", "The isolated planning review requires its own local database.", 503);
    return "fieldproof_planning_qa_session";
  }
  if (process.env.FIELDPROOF_STUDIO_QA !== "true") return "fieldproof_session";
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/fp_studio_qa_[a-z0-9_]+$/.test(url.pathname))
    throw new DomainError("QA_STORAGE_ISOLATION", "The isolated Studio review requires its own local database.", 503);
  // Browser cookies are shared across localhost ports. Keep the original source cookie
  // intact while this explicitly isolated review process uses port 4202.
  return "fieldproof_studio_qa_session";
}
export const sessionCookieSecure=()=>process.env.NODE_ENV==="production"&&!organizationReviewEnabled()&&!boardPackReviewEnabled()&&!onboardingReviewEnabled()&&!fundingQaEnabled()&&!supporterQaEnabled();
export interface Session {
  id: string; tenantId: string; projectId: string; actorId: string;
  role: WorkspaceRole; expiresAt: string; mode: "sample" | "live_sandbox";
}
export function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export async function sessionForToken(token: string): Promise<Session | null> {
  await initializeDatabase();
  const [row] = await query<{id:string;tenant_id:string;project_id:string;actor_id:string;role:WorkspaceRole;expires_at:Date;mode:Session["mode"]}>(
    "SELECT s.*,t.mode FROM fp_sessions s JOIN fp_tenants t ON t.id=s.tenant_id JOIN fp_memberships m ON m.tenant_id=s.tenant_id AND m.project_id=s.project_id AND m.actor_id=s.actor_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND m.state='active' AND m.roles ? s.role", [tokenHash(token)]);
  return row ? {id:row.id,tenantId:row.tenant_id,projectId:row.project_id,actorId:row.actor_id,role:row.role,expiresAt:row.expires_at.toISOString(),mode:row.mode} : null;
}
export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(sessionCookieName())?.value;
  return token ? sessionForToken(token) : null;
}
export async function writeSessionCookie(token: string, expiresAt: string): Promise<void> {
  (await cookies()).set(sessionCookieName(), token, { httpOnly: true, sameSite: "lax", secure: sessionCookieSecure(), path: "/", maxAge: Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)) });
}
export async function requireSession(roles?: WorkspaceRole[]): Promise<Session> {
  const session = await getSession();
  if (!session) throw new DomainError("SESSION_REQUIRED", "Start your own workspace to continue.", 401);
  if (roles && !roles.includes(session.role)) throw new DomainError("ROLE_DENIED", "This view cannot make that change.", 403);
  return session;
}
export async function startSession(mode: Session["mode"] = "sample"): Promise<Session> {
  await initializeDatabase();
  const { rememberWorkspaceCookie } = await import("./community-workspaces");
  await rememberWorkspaceCookie();
  // This deployment-wide backstop bounds anonymous workspace creation even after cookie resets.
  const bucket=`session:${new Date().toISOString().slice(0,13)}`;
  const claimed=await query("INSERT INTO fp_request_buckets(bucket_key,request_count) VALUES($1,1) ON CONFLICT(bucket_key) DO UPDATE SET request_count=fp_request_buckets.request_count+1 WHERE fp_request_buckets.request_count<200 RETURNING request_count",[bucket]);
  if(!claimed.length)throw new DomainError("WORKSPACE_LIMIT","New test workspaces are temporarily busy. Existing workspaces still work; please try again in the next hour.",429);
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID(), tenantId = randomUUID(), projectId = randomUUID(), actorId = randomUUID();
  const expiresAt = new Date(Date.now() + 12*60*60*1000).toISOString();
  await database().transaction(async tx => {
    await createProject(tx,tenantId,projectId,`eastside-${id.slice(0,8)}`,mode);
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'donor',$6)", [id,tokenHash(token),tenantId,projectId,actorId,expiresAt]);
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,$4::jsonb)", [tenantId,projectId,actorId,JSON.stringify(["donor","volunteer","organizer","auditor"])]);
  });
  await rememberWorkspaceCookie(token);
  (await cookies()).set(sessionCookieName(),token,{httpOnly:true,sameSite:"lax",secure:sessionCookieSecure(),path:"/",maxAge:12*60*60});
  return {id,tenantId,projectId,actorId,role:"donor",expiresAt,mode};
}
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const organization = organizationReviewEnabled();
  const boardPack = boardPackReviewEnabled();
  const onboarding = onboardingReviewEnabled();
  const allowed = organization ? ["http://localhost:4592"] : boardPack ? ["http://localhost:4595"] : onboarding ? [onboardingReviewProfile().origin] : ["http://localhost:4102","https://paypal-ai-fieldproof.vercel.app"];
  // Vercel supplies the exact immutable deployment hostname. This permits
  // pre-promotion qualification without trusting sibling or caller-supplied hosts.
  const deploymentHost = process.env.VERCEL_URL;
  if (!organization && !boardPack && !onboarding && process.env.VERCEL === "1" && deploymentHost && /^[a-z0-9][a-z0-9-]*\.vercel\.app$/.test(deploymentHost))
    allowed.push(`https://${deploymentHost}`);
  // The isolated Studio review process never runs on the retired source writer's port.
  if (!organization && !boardPack && !onboarding) {
    if (process.env.NODE_ENV !== "production") allowed.push("http://localhost:4202");
    if (process.env.NODE_ENV !== "production" && process.env.FIELDPROOF_PLANNING_QA === "true") allowed.push("http://localhost:4502");
    if (communityQaEnabled()) allowed.push("http://localhost:4512");
    if (fundingQaEnabled()) allowed.push("http://localhost:4535");
    if (supporterQaEnabled()) allowed.push(supporterQaProfile().origin);
  }
  const host=request.headers.get("host");
  if (!origin || !allowed.includes(origin) || new URL(origin).host !== host) throw new DomainError("ORIGIN_DENIED", "Refresh this page before trying again.", 403);
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new DomainError("ORIGIN_DENIED", "This action must start in Fieldproof.",403);
}
export async function setRole(session: Session, role: WorkspaceRole): Promise<void> {
  await requireMembership(session.tenantId,session.projectId,session.actorId,role);
  await query("UPDATE fp_sessions SET role=$1 WHERE id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()",[role,session.id]);
}
