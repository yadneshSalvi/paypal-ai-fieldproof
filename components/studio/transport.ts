"use client";
import { workspaceFetch } from "@/lib/community/workspace-fetch";

export class StudioRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
export async function studioRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await workspaceFetch(`/api/studio/${path}`, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", credentials: "same-origin", signal });
  let result: { error?: string; code?: string };
  try { result = await response.json(); } catch { throw new StudioRequestError("The report request ended without a readable response. Its earlier saved work is still available.", response.status, "STUDIO_RESPONSE_UNCONFIRMED"); }
  if (!response.ok) throw new StudioRequestError(result.error ?? "The report request did not finish.", response.status, result.code ?? "STUDIO_UNAVAILABLE");
  return result as T;
}
export const studioAccessFailure = (error: unknown) => error instanceof StudioRequestError && ["SESSION_REQUIRED", "ROLE_DENIED", "MEMBERSHIP_DENIED", "STUDIO_SCOPE_CHANGED", "STUDIO_RUN_DENIED"].includes(error.code);
