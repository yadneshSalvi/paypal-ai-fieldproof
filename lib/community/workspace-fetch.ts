"use client";
let pageProjectId: string | null | undefined;
let tabIdentity: string | undefined;
export function workspaceTabIdentity(){return tabIdentity??=crypto.randomUUID();}
/** A stale-tab guard, never an authorization capability. Tokens stay HttpOnly. */
export function bindWorkspaceContext(projectId: string | null) { if (typeof window!=="undefined"&&pageProjectId === undefined) pageProjectId = projectId; }
export function adoptWorkspaceContext(projectId:string|null){pageProjectId=projectId;notifyWorkspaceChange();}
function notifyWorkspaceChange(){const channel = new BroadcastChannel("fieldproof-workspace-changed");channel.postMessage({origin:workspaceTabIdentity()});channel.close();}
export function workspaceFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
  if (url.origin === window.location.origin && url.pathname.startsWith("/api/") && pageProjectId !== undefined) headers.set("X-Fieldproof-Project", pageProjectId ?? "none");
  return fetch(input, { ...init, headers, cache: init?.cache ?? "no-store" });
}
export function openWorkspace(path = "/") {
  notifyWorkspaceChange();
  window.location.assign(path.startsWith("/") && !path.startsWith("//") ? path : "/");
}
