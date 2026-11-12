import { cookies } from "next/headers";
import { LIFECYCLE_ERROR_CODES, LIFECYCLE_PROJECT_SCOPE_HEADER } from "../lifecycle/contracts";
import { ORG_PROJECT_SCOPE_HEADER, ORG_SCOPE_HEADER } from "../organizations/contracts";
import { DomainError } from "../domain/money";
import { assertSameOrigin, sessionCookieName, sessionCookieSecure } from "./auth";
import { privateJson, requestJson, routeFailure } from "./http";
import { withExecutionLease } from "./maintenance";
import { orgToken, orgTokenValid, organizationBrowserCookieName, organizationCookieName, organizationLibraryCookieName } from "./organization-core";
import type { LifecycleRequest } from "./lifecycle-core";

/** Actual independent credentials only. The context bootstrap can set an
 * entry nonce, which creates no membership, session or other authority. */
export async function lifecycleHttp(request: Request, handler: (current: LifecycleRequest, raw: unknown) => Promise<unknown>, options: { personal?: boolean; bootstrap?: boolean } = {}): Promise<Response> {
  try {
    const url = new URL(request.url), write = request.method === "POST";
    if (!["GET", "POST"].includes(request.method)) throw new DomainError("INVALID_INPUT", "Use the ordinary read or reviewed decision for this lifecycle record.", 405);
    if (options.bootstrap && (write || options.personal || url.pathname !== "/api/lifecycle/context")) throw new DomainError("INVALID_INPUT", "Only the ordinary lifecycle context read initializes this browser entry.", 400);
    if (write) {
      assertSameOrigin(request);
      if (url.search) throw new DomainError("INVALID_INPUT", "Private lifecycle decisions use reviewed request fields, not URL parameters.", 400);
    }
    const jar = await cookies(), originalBrowser = jar.get(organizationBrowserCookieName())?.value;
    const browserKey = orgTokenValid(originalBrowser) ? originalBrowser as string : options.bootstrap ? orgToken() : "";
    if (!browserKey && !options.personal) throw new DomainError("LIFECYCLE_ORGANIZATION_CHANGED", "Refresh the lifecycle workspace to recover its current organization browser context.", 409);
    const current: LifecycleRequest = {
      organizationToken: jar.get(organizationCookieName())?.value ?? null, libraryToken: jar.get(organizationLibraryCookieName())?.value ?? null,
      projectToken: jar.get(sessionCookieName())?.value ?? null, browserKey,
      organizationScope: request.headers.get(ORG_SCOPE_HEADER) ?? undefined, projectScope: request.headers.get(ORG_PROJECT_SCOPE_HEADER) ?? undefined,
      personalScope: request.headers.get(LIFECYCLE_PROJECT_SCOPE_HEADER) ?? undefined,
    };
    const raw = write ? await requestJson(request) : undefined;
    const value = write ? await withExecutionLease("POST private lifecycle decision", () => handler(current, raw)) : await handler(current, raw);
    const response = privateJson(value);
    if (options.bootstrap && !orgTokenValid(originalBrowser)) response.cookies.set(organizationBrowserCookieName(), browserKey, {
      httpOnly: true, secure: sessionCookieSecure(), sameSite: "lax", path: "/", maxAge: 7 * 24 * 3600,
    });
    return response;
  } catch (error) {
    if (error instanceof DomainError) {
      const aliases: Record<string, string> = {
        ORG_COMMAND_BUSY: "LIFECYCLE_BUSY", ORG_BROWSER_CONTEXT_CHANGED: "LIFECYCLE_ORGANIZATION_CHANGED",
        ORG_RESOURCE_UNAVAILABLE: "LIFECYCLE_RESOURCE_UNAVAILABLE", ORG_PROJECT_SOURCE_CHANGED: "LIFECYCLE_SOURCE_CHANGED",
        ORG_PORTFOLIO_CHANGED: "LIFECYCLE_SOURCE_CHANGED", ORG_SOURCE_UNAVAILABLE: "LIFECYCLE_SOURCE_WITHDRAWN",
      };
      const code = aliases[error.code] ?? error.code;
      if (LIFECYCLE_ERROR_CODES.some(value => value === code)) return routeFailure(new DomainError(code, error.message, error.status));
      return routeFailure(new DomainError("REQUEST_UNAVAILABLE", "This lifecycle view could not finish. Keep the original saved request and refresh its current authority before continuing.", error.status));
    }
    return routeFailure(error);
  }
}
