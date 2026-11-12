import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";
import { assertSameOrigin, getSession, requireSession, sessionCookieName, sessionCookieSecure, tokenHash, writeSessionCookie } from "@/lib/server/auth";
import { guardedApi } from "@/lib/server/maintenance";
import { privateJson, requestJson, routeFailure } from "@/lib/server/http";
import { DomainError } from "@/lib/domain/money";
import { query } from "@/lib/server/db";
import { rememberWorkspaceCookie } from "@/lib/server/community-workspaces";
import { supporterAcceptSchema, supporterEntrySchema, supporterInviteSchema, supporterLeaveSchema, supporterLinkSchema, supporterRestoreSchema, supporterRevokeSchema } from "@/lib/supporters/contracts";
import { acceptSupporterInvite, createSupporterInvite, restoreSupporterAccess, reviewSupporterEntry, revokeSupporterInvite, supporterDesk, supporterInviteLink, validateSupporterLeave, type SupporterEntryContext } from "@/lib/server/supporter-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ supporterPath?: string[] }> };
async function browserKey(): Promise<string> {
  const jar = await cookies(), name = `${sessionCookieName()}_entry_browser`;
  const saved = jar.get(name)?.value;
  if (saved && /^[A-Za-z0-9_-]{43}$/.test(saved)) return saved;
  const value = randomBytes(32).toString("base64url");
  jar.set(name, value, { httpOnly: true, sameSite: "strict", secure: sessionCookieSecure(), path: "/", maxAge: 7 * 24 * 60 * 60 });
  return value;
}
async function entryContext(): Promise<SupporterEntryContext> {
  const token = (await cookies()).get(sessionCookieName())?.value;
  return { session: await getSession(), credentialHash: token ? tokenHash(token) : null, browserKey: await browserKey() };
}
async function limitEntry(key: string) {
  const bucket = `supporter-entry:${tokenHash(key)}:${new Date().toISOString().slice(0, 16)}`;
  const rows = await query("INSERT INTO fp_request_buckets(bucket_key,request_count) VALUES($1,1) ON CONFLICT(bucket_key) DO UPDATE SET request_count=fp_request_buckets.request_count+1 WHERE fp_request_buckets.request_count<90 RETURNING request_count", [bucket]);
  if (!rows.length) throw new DomainError("SUPPORTER_ENTRY_LIMIT", "This browser has checked several invitations. Wait a minute before trying again.", 429);
}
async function GETImplementation(request: Request, context: Context) {
  try {
    if (((await context.params).supporterPath ?? []).length) throw new DomainError("NOT_FOUND", "This supporter view is unavailable.", 404);
    const desk = await supporterDesk(await requireSession(["organizer"]));
    const expected = request.headers.get("X-Fieldproof-Supporter-Scope");
    if (expected !== null && expected !== desk.scope) throw new DomainError("SUPPORTER_CONTEXT_CHANGED", "Your organizer session changed. Reload the current workspace before continuing.", 409);
    return privateJson({ desk });
  } catch (error) { return routeFailure(error); }
}
async function POSTImplementation(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const parts = (await context.params).supporterPath ?? [], path = parts.join("/"), body = await requestJson(request, 4096);
    if (["entry/review", "entry/accept", "entry/restore", "entry/leave"].includes(path)) {
      const current = await entryContext(); await limitEntry(current.browserKey);
      if (path === "entry/review") return privateJson({ entry: await reviewSupporterEntry(supporterEntrySchema.parse(body), current) });
      if (path === "entry/leave") {
        const input = supporterLeaveSchema.parse(body);
        await validateSupporterLeave(input.expectedScope, current);
        await rememberWorkspaceCookie();
        (await cookies()).set(sessionCookieName(), "", { httpOnly: true, sameSite: "lax", secure: sessionCookieSecure(), path: "/", expires: new Date(0) });
        return privateJson({ left: true });
      }
      const result = path === "entry/accept" ? await acceptSupporterInvite(supporterAcceptSchema.parse(body), current) : await restoreSupporterAccess(supporterRestoreSchema.parse(body), current);
      await writeSessionCookie(result.sessionToken, result.session.expiresAt);
      return privateJson({ welcome: result.welcome, returnPath: `/join#access=${result.recoveryToken}` });
    }
    const session = await requireSession(["organizer"]);
    if (path === "invitations") {
      const result = await createSupporterInvite(session, await browserKey(), supporterInviteSchema.parse(body));
      return privateJson({ invitation: { id: result.id, path: `/join#invite=${result.token}`, expiresAt: result.expiresAt } }, 201);
    }
    if (parts[0] === "invitations" && parts.length === 3) {
      const id = z.uuid().parse(parts[1]);
      if (parts[2] === "link") {
        const result = await supporterInviteLink(session, id, supporterLinkSchema.parse(body));
        return privateJson({ invitation: { id: result.id, path: `/join#invite=${result.token}`, expiresAt: result.expiresAt } });
      }
      if (parts[2] === "revoke") {
        await revokeSupporterInvite(session, id, supporterRevokeSchema.parse(body));
        return privateJson({ revoked: true });
      }
    }
    throw new DomainError("NOT_FOUND", "This supporter action is unavailable.", 404);
  } catch (error) { return routeFailure(error); }
}
export const GET = (request: Request, context: Context) => guardedApi(request, () => GETImplementation(request, context));
export const POST = (request: Request, context: Context) => guardedApi(request, () => POSTImplementation(request, context));
