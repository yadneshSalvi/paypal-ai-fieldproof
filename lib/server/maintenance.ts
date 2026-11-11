import { DomainError } from "../domain/money";
import { database, initializeDatabase } from "./db";
import { PRIVATE_HEADERS, routeFailure } from "./http";
import { beginExecutionLease, finishExecutionLease, runtimeControl } from "./runtime-control";

export function isMutatingApiRequest(request: Request): boolean {
  let path: string;
  try { path = decodeURIComponent(new URL(request.url).pathname).replace(/\/+$/, ""); } catch { return true; }
  if (path === "/api/workspace/continue" && request.method === "POST") return false;
  return !["GET", "HEAD", "OPTIONS"].includes(request.method) || path.startsWith("/api/cron/") || path === "/api/auth/paypal" || path.startsWith("/api/auth/paypal/");
}
export async function withExecutionLease<T>(action: string, work: () => Promise<T>): Promise<T> {
  await initializeDatabase();
  const lease = await beginExecutionLease(database(), action);
  try { return await work(); }
  finally { await finishExecutionLease(database(), lease).catch(() => undefined); }
}
export async function guardedApi(request: Request, work: () => Promise<Response>): Promise<Response> {
  if (!isMutatingApiRequest(request)) return work();
  try { return await withExecutionLease(`${request.method} ${new URL(request.url).pathname}`, work); }
  catch (error) {
    if (error instanceof DomainError && error.code === "WORKSPACE_MAINTENANCE") return Response.json({ error: error.message, code: error.code }, { status: 503, headers: { ...PRIVATE_HEADERS, "Retry-After": "30" } });
    return routeFailure(error);
  }
}
export async function assertProviderWritesAllowed(): Promise<void> {
  await initializeDatabase();
  if ((await runtimeControl(database())).held) throw new DomainError("WORKSPACE_MAINTENANCE", "Provider mutations are paused during the private workspace transfer.", 503);
}
/** Preserve the exact SDK/REST Request and signal; inspect only method and URL. */
export function guardedProviderTransport(transport: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const readSupport = ["/v1/oauth2/token", "/v1/notifications/verify-webhook-signature", "/v2/invoicing/search-invoices"].includes(url.pathname);
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !readSupport) await assertProviderWritesAllowed();
    return transport(input, init);
  };
}
