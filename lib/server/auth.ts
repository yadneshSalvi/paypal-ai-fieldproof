import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { WorkspaceRole } from "../contracts";
import { DomainError } from "../domain/money";
import { database, initializeDatabase, query } from "./db";
import { createProject } from "./seed";
import { requireMembership } from "./membership";

const COOKIE = "fieldproof_session";
export interface Session {
  id: string; tenantId: string; projectId: string; actorId: string;
  role: WorkspaceRole; expiresAt: string; mode: "sample" | "live_sandbox";
}
export function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export async function sessionForToken(token: string): Promise<Session | null> {
  await initializeDatabase();
  const [row] = await query<{id:string;tenant_id:string;project_id:string;actor_id:string;role:WorkspaceRole;expires_at:Date;mode:Session["mode"]}>(
    "SELECT s.*,t.mode FROM fp_sessions s JOIN fp_tenants t ON t.id=s.tenant_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()", [tokenHash(token)]);
  return row ? {id:row.id,tenantId:row.tenant_id,projectId:row.project_id,actorId:row.actor_id,role:row.role,expiresAt:row.expires_at.toISOString(),mode:row.mode} : null;
}
export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  return token ? sessionForToken(token) : null;
}
export async function requireSession(roles?: WorkspaceRole[]): Promise<Session> {
  const session = await getSession();
  if (!session) throw new DomainError("SESSION_REQUIRED", "Start your own workspace to continue.", 401);
  if (roles && !roles.includes(session.role)) throw new DomainError("ROLE_DENIED", "This view cannot make that change.", 403);
  return session;
}
export async function startSession(mode: Session["mode"] = "sample"): Promise<Session> {
  await initializeDatabase();
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
  (await cookies()).set(COOKIE,token,{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV === "production",path:"/",maxAge:12*60*60});
  return {id,tenantId,projectId,actorId,role:"donor",expiresAt,mode};
}
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const allowed=["http://localhost:4102","https://paypal-ai-fieldproof.vercel.app"];
  const host=request.headers.get("host");
  if (!origin || !allowed.includes(origin) || new URL(origin).host !== host) throw new DomainError("ORIGIN_DENIED", "Refresh this page before trying again.", 403);
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new DomainError("ORIGIN_DENIED", "This action must start in Fieldproof.",403);
}
export async function setRole(session: Session, role: WorkspaceRole): Promise<void> {
  await requireMembership(session.tenantId,session.projectId,session.actorId,role);
  await query("UPDATE fp_sessions SET role=$1 WHERE id=$2 AND revoked_at IS NULL AND expires_at>now()",[role,session.id]);
}
