import { cookies } from "next/headers";
import { z } from "zod";
import { DomainError } from "@/lib/domain/money";
import { ORG_PROJECT_SCOPE_HEADER, ORG_SCOPE_HEADER, orgPortfolioReviewSchema } from "@/lib/organizations/contracts";
import { assertSameOrigin, sessionCookieName, sessionCookieSecure } from "@/lib/server/auth";
import { PRIVATE_HEADERS, privateJson, requestJson, routeFailure } from "@/lib/server/http";
import { withExecutionLease } from "@/lib/server/maintenance";
import {
  assertOrganizationCurrent, orgToken, organizationBrowserCookieName, organizationCookieName, organizationLibraryCookieName,
  organizationTransaction, requireOrganization, type OrganizationCookie, type OrganizationRequest,
} from "@/lib/server/organization-core";
import { acceptOrganizationInvitation, createOrganization, organizationBootstrap, organizationLibraryAction, restoreOrganizationAccess, reviewOrganizationEntry } from "@/lib/server/organization-entry";
import { changeOrganizationMember, createOrganizationInvitation, organizationInvitationLink, revokeOrganizationInvitation, updateOrganization } from "@/lib/server/organization-members";
import { readOrganizationDesk, readOrganizationPage } from "@/lib/server/organization-desk";
import { commitOrganizationProjectLink, reviewOrganizationProjectLink, withdrawOrganizationProjectLink } from "@/lib/server/organization-projects";
import { organizationPolicyDetail, publishOrganizationPolicy, retireOrganizationPolicy, reviewOrganizationPolicyPublication, saveOrganizationPolicy } from "@/lib/server/organization-policies";
import { adoptOrganizationPolicy, deactivateProjectRule, organizationAdoptionsPage, organizationPolicyApplication, organizationProjectParticipation, replaceProjectRule, reviewOrganizationAdoption, reviewProjectRuleReplacement } from "@/lib/server/organization-adoptions";
import { captureOrganizationPortfolio, exportOrganizationPortfolio, readOrganizationPortfolio, readOrganizationPortfolioProject, readOrganizationPortfolioReport } from "@/lib/server/organization-portfolio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
type Context = { params: Promise<{ organizationPath?: string[] }> };
const exactId = (value: string) => z.uuid().parse(value);
function routeParts(parts: string[]) {
  if (parts.length > 7 || parts.some(part => !/^[a-zA-Z0-9-]{1,100}$/.test(part))) throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This organization view is unavailable.", 404);
  return parts;
}
async function currentRequest(request: Request, bootstrap: false | "organization" | "project" = false): Promise<{ current: OrganizationRequest; browserCookie: string | null }> {
  const jar = await cookies(), value = jar.get(organizationBrowserCookieName())?.value;
  const valid = value && /^[A-Za-z0-9_-]{64}$/.test(value), browserKey = valid ? value : bootstrap ? orgToken() : null;
  if (!browserKey) throw new DomainError("ORG_BROWSER_CONTEXT_CHANGED", "Refresh the organization entry before continuing in this browser.", 409);
  return { current: { organizationToken: jar.get(organizationCookieName())?.value ?? null, libraryToken: jar.get(organizationLibraryCookieName())?.value ?? null,
    projectToken: jar.get(sessionCookieName())?.value ?? null, browserKey,
    organizationScope: request.headers.get(ORG_SCOPE_HEADER) ?? undefined, projectScope: request.headers.get(ORG_PROJECT_SCOPE_HEADER) ?? undefined }, browserCookie: valid || bootstrap === "project" ? null : browserKey };
}
function resultResponse(value: unknown, browserCookie: string | null = null) {
  const result = value as { body?: unknown; cookies?: OrganizationCookie[] }, response = privateJson(result.body ?? value);
  for (const cookie of result.cookies ?? []) response.cookies.set(cookie.kind === "session" ? organizationCookieName() : organizationLibraryCookieName(), cookie.token ?? "", {
    httpOnly: true, secure: sessionCookieSecure(), sameSite: "lax", path: "/", expires: cookie.expiresAt ? new Date(cookie.expiresAt) : new Date(0),
  });
  if (browserCookie) response.cookies.set(organizationBrowserCookieName(), browserCookie, { httpOnly: true, secure: sessionCookieSecure(), sameSite: "lax", path: "/", maxAge: 7 * 24 * 3600 });
  return response;
}
export async function GET(request: Request, context: Context) {
  try {
    const parts = routeParts((await context.params).organizationPath ?? []), path = parts.join("/"), url = new URL(request.url);
    if ([...url.searchParams.keys()].some(key => !["before", "version"].includes(key))) throw new DomainError("INVALID_INPUT", "Use the original private view without additional URL fields.", 400);
    // Project context has independent authority and never writes an organization
    // browser key. Both initial reads may run together without racing cookies.
    const before = z.string().max(500).optional().parse(url.searchParams.get("before") ?? undefined), { current, browserCookie } = await currentRequest(request, path === "context" || path === "library" ? "organization" : path === "project-context" ? "project" : false);
    let value: unknown;
    if (path === "context") value = await organizationBootstrap(current);
    else if (path === "library") value = { library: (await organizationBootstrap(current)).library };
    else if (!path) value = await readOrganizationDesk(current);
    else if (parts.length === 1 && ["members", "invitations", "projects", "policies", "events"].includes(path)) value = await readOrganizationPage(current, path as "members", before);
    else if (path === "project-context") value = await organizationProjectParticipation(current, before);
    else if (parts.length === 2 && parts[0] === "policies") value = await organizationPolicyDetail(current, exactId(parts[1]), before, url.searchParams.get("version") ?? undefined);
    else if (parts.length === 3 && parts[0] === "projects" && parts[2] === "adoptions") value = await organizationTransaction(async tx => {
      const identity = await requireOrganization(tx, current, current.organizationScope), result = await organizationAdoptionsPage(tx, identity, exactId(parts[1]), before);
      await assertOrganizationCurrent(tx, current, identity); return result;
    });
    else if (parts.length === 4 && parts[0] === "projects" && parts[2] === "adoptions") value = await organizationPolicyApplication(current, exactId(parts[1]), exactId(parts[3]));
    else if (path === "portfolio") value = await readOrganizationPortfolio(current, before);
    else if (parts.length === 3 && parts[0] === "portfolio" && parts[1] === "reports") value = await readOrganizationPortfolioReport(current, exactId(parts[2]));
    else if (parts.length === 3 && parts[0] === "portfolio" && parts[1] === "projects") value = await readOrganizationPortfolioProject(current, exactId(parts[2]));
    else if (parts.length === 5 && parts[0] === "portfolio" && parts[1] === "reports" && parts[3] === "projects") value = await readOrganizationPortfolioProject(current, exactId(parts[4]), exactId(parts[2]));
    else if (parts.length === 4 && parts[0] === "portfolio" && parts[1] === "reports" && parts[3] === "export") {
      const result = await exportOrganizationPortfolio(current, exactId(parts[2]));
      return new Response(result.csv, { headers: { ...PRIVATE_HEADERS, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${result.filename}"` } });
    } else throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This organization view is unavailable.", 404);
    return resultResponse(value, browserCookie);
  } catch (error) { return routeFailure(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    if (new URL(request.url).search) throw new DomainError("INVALID_INPUT", "Private organization decisions use reviewed request fields, not URL parameters.", 400);
    const parts = routeParts((await context.params).organizationPath ?? []), path = parts.join("/"), { current } = await currentRequest(request), raw = await requestJson(request);
    return await withExecutionLease("POST organization decision", async () => {
      let value: unknown;
      if (path === "create") value = await createOrganization(current, raw);
      else if (path === "update") value = await updateOrganization(current, raw);
      else if (path === "entry/review") value = await reviewOrganizationEntry(current, raw);
      else if (path === "entry/accept") value = await acceptOrganizationInvitation(current, raw);
      else if (path === "entry/restore") value = await restoreOrganizationAccess(current, raw);
      else if (["session/leave", "entry/leave", "library/remember", "library/open", "library/clear-ended"].includes(path)) value = await organizationLibraryAction(current, path.endsWith("leave") ? "leave" : path.endsWith("remember") ? "remember" : path.endsWith("open") ? "open_profile" : "clear_ended", raw);
      else if (path === "invitations") value = await createOrganizationInvitation(current, raw);
      else if (parts.length === 3 && parts[0] === "invitations" && parts[2] === "link") value = await organizationInvitationLink(current, exactId(parts[1]), raw);
      else if (parts.length === 3 && parts[0] === "invitations" && parts[2] === "revoke") value = await revokeOrganizationInvitation(current, exactId(parts[1]), raw);
      else if (parts.length === 3 && parts[0] === "members" && ["role", "end"].includes(parts[2])) value = await changeOrganizationMember(current, exactId(parts[1]), parts[2] as "role" | "end", raw);
      else if (path === "projects/review") value = await reviewOrganizationProjectLink(current, raw);
      else if (path === "projects") value = await commitOrganizationProjectLink(current, raw);
      else if (parts.length === 3 && parts[0] === "projects" && parts[2] === "withdraw") value = await withdrawOrganizationProjectLink(current, exactId(parts[1]), raw);
      else if (path === "policies/save") value = await saveOrganizationPolicy(current, raw);
      else if (parts.length === 3 && parts[0] === "policies" && parts[2] === "review") value = await reviewOrganizationPolicyPublication(current, exactId(parts[1]), raw);
      else if (parts.length === 3 && parts[0] === "policies" && parts[2] === "publish") value = await publishOrganizationPolicy(current, exactId(parts[1]), raw);
      else if (parts.length === 3 && parts[0] === "policies" && parts[2] === "retire") value = await retireOrganizationPolicy(current, exactId(parts[1]), raw);
      else if (parts.length === 4 && parts[0] === "projects" && parts[2] === "adoptions" && parts[3] === "review") value = await reviewOrganizationAdoption(current, exactId(parts[1]), raw);
      else if (parts.length === 3 && parts[0] === "projects" && parts[2] === "adoptions") value = await adoptOrganizationPolicy(current, exactId(parts[1]), raw);
      else if (parts.length === 5 && parts[0] === "projects" && parts[2] === "adoptions" && parts[4] === "deactivate") value = await deactivateProjectRule(current, exactId(parts[1]), exactId(parts[3]), raw);
      else if (parts.length === 6 && parts[0] === "projects" && parts[2] === "adoptions" && parts[4] === "replace" && parts[5] === "review") value = await reviewProjectRuleReplacement(current, exactId(parts[1]), exactId(parts[3]), raw);
      else if (parts.length === 5 && parts[0] === "projects" && parts[2] === "adoptions" && parts[4] === "replace") value = await replaceProjectRule(current, exactId(parts[1]), exactId(parts[3]), raw);
      else if (path === "portfolio/review") value = await readOrganizationPortfolio(current, undefined, orgPortfolioReviewSchema.parse(raw).filters);
      else if (path === "portfolio/capture") value = await captureOrganizationPortfolio(current, raw);
      else throw new DomainError("ORG_RESOURCE_UNAVAILABLE", "This organization action is unavailable.", 404);
      return resultResponse(value);
    });
  } catch (error) { return routeFailure(error); }
}
