"use client";
import { workspaceFetch } from "../community/workspace-fetch";
import { ProcurementRequestError } from "./client-boundary";
import { PROCUREMENT_SCOPE_HEADER } from "./contracts";

/** The only client image URL is a transient verified blob. Original private
 * source URLs, bytes and image objects never enter persistent client storage. */
export async function loadProcurementSourceImage(quoteId: string, version: number, page: number, contentHash: string, scope: string, signal: AbortSignal, fetcher: typeof fetch = workspaceFetch): Promise<Blob> {
  const response = await fetcher(`/api/procurement/quotes/${encodeURIComponent(quoteId)}/preview?version=${version}&page=${page}`, { headers: { [PROCUREMENT_SCOPE_HEADER]: scope }, signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]), cache: "no-store", credentials: "same-origin", redirect: "error" });
  if (!response.ok) { const raw = await response.json().catch(() => null); throw new ProcurementRequestError(typeof raw?.error === "string" ? raw.error : "The original source image is no longer permitted.", typeof raw?.code === "string" ? raw.code : "PROCUREMENT_SOURCE_CHANGED", response.status); }
  const blob = await response.blob(); if (blob.type !== "image/png" || blob.size > 16 * 1024 * 1024) throw new ProcurementRequestError("The source image could not be verified within its bounded page format.", "PROCUREMENT_SOURCE_CHANGED", 422);
  const observed = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map(value => value.toString(16).padStart(2, "0")).join("");
  if (observed !== contentHash) throw new ProcurementRequestError("The image no longer matches this exact original quote page.", "PROCUREMENT_SOURCE_CHANGED", 410);
  return blob;
}
