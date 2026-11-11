import { guardedApi } from "@/lib/server/maintenance";
import { z } from "zod";
import { assertSameOrigin, requireSession, writeSessionCookie } from "@/lib/server/auth";
import { initializeDatabase } from "@/lib/server/db";
import { privateJson, requestJson, routeFailure } from "@/lib/server/http";
import { prepareWorkspaceHandoff, redeemWorkspaceHandoff } from "@/lib/server/workspace-handoff";
import { DomainError } from "@/lib/domain/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function POSTImplementation(request: Request, { params }: { params: Promise<{ action: string }> }) {
  try {
    assertSameOrigin(request);
    const { action } = await params;
    const input = await requestJson(request, 2048);
    await initializeDatabase();
    if (action === "prepare-continuation") {
      z.object({ acknowledged: z.literal(true) }).strict().parse(input);
      return privateJson(await prepareWorkspaceHandoff(await requireSession(["organizer"])));
    }
    if (action === "continue") {
      const { token } = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(input);
      const result = await redeemWorkspaceHandoff(token);
      await writeSessionCookie(result.token, result.session.expiresAt);
      return privateJson({ continued: true, destination: "/my-expenses", expiresAt: result.session.expiresAt });
    }
    throw new DomainError("NOT_FOUND", "This workspace action is unavailable.", 404);
  } catch (error) { return routeFailure(error); }
}

export const POST = (...args: Parameters<typeof POSTImplementation>) => guardedApi(args[0], () => POSTImplementation(...args));
