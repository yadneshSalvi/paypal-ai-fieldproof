"use client";

import Link from "next/link";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, BookOpen, HeartHandshake, LockKeyhole, X } from "lucide-react";
import { workspaceFetch } from "@/lib/community/workspace-fetch";
import type { BoardPackReport, BoardPackSourceDetail } from "@/lib/reports/board-pack-contracts";

export interface BoardPackImageView { state: "loading" | "ready" | "error"; contentHash: string; url: string | null; error: string | null; }

export const boardPackMoney = (minor: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(minor / 100);
export const boardPackDate = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)) + " UTC"
  : "Not recorded";
export const boardPackLabel = (value: string) => value.replaceAll("_", " ");

export class BoardPackRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); }
}
export async function boardPackFetch(path: string, options: { scope: string; signal?: AbortSignal; body?: unknown }): Promise<Response> {
  const response = await workspaceFetch(`/api/board-packs${path}`, {
    method: options.body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    headers: { "X-Fieldproof-Board-Pack-Scope": options.scope, ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
    throw new BoardPackRequestError(typeof value?.error === "string" ? value.error : "This report could not be checked. Try again from your current workspace.", typeof value?.code === "string" ? value.code : "REPORT_UNAVAILABLE", response.status);
  }
  return response;
}
export async function boardPackRequest<T>(path: string, options: { scope: string; signal?: AbortSignal; body?: unknown }): Promise<T> {
  return (await boardPackFetch(path, options)).json() as Promise<T>;
}
/** Reauthorize the exact frozen image, then verify the bytes before creating any client URL. */
export async function loadBoardPackReviewedImage(report: Pick<BoardPackReport, "id" | "contentHash">, image: BoardPackReport["reviewedImages"][number], options: { scope: string; signal?: AbortSignal }): Promise<Blob> {
  const { detail } = await boardPackRequest<{ detail: BoardPackSourceDetail }>(`/${encodeURIComponent(report.id)}/sources/${encodeURIComponent(image.sourceId)}`, options);
  if (detail.reportId !== report.id || detail.contentHash !== report.contentHash || detail.source.id !== image.sourceId || !detail.source.available || !detail.image || detail.image.contentHash !== image.contentHash || detail.image.width !== image.width || detail.image.height !== image.height)
    throw new BoardPackRequestError("The reviewed image no longer matches this report. Refresh its source review.", "BOARD_PACK_IMAGE_CHANGED", 410);
  const url = new URL(detail.image.url, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith(`/api/board-packs/${encodeURIComponent(report.id)}/`))
    throw new BoardPackRequestError("This image is outside the selected report’s source route.", "BOARD_PACK_IMAGE_CHANGED", 410);
  const response = await boardPackFetch(url.pathname.slice("/api/board-packs".length) + url.search, options), blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new BoardPackRequestError("The reviewed image could not be opened. Check the source again.", "BOARD_PACK_IMAGE_UNAVAILABLE", 422);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), value => value.toString(16).padStart(2, "0")).join("");
  if (hash !== image.contentHash.toLowerCase()) throw new BoardPackRequestError("The source image bytes changed after this report was captured. Refresh its review.", "BOARD_PACK_IMAGE_CHANGED", 410);
  return blob;
}

export function BoardPackShell({ children, projectTitle, audience }: { children: ReactNode; projectTitle?: string; audience?: string }) {
  return <div className="bp-shell">
    <a className="bp-skip" href="#board-pack-content">Skip to Board Pack</a>
    <header className="bp-header"><Link href="/" className="wordmark">fieldproof<span className="brand-dot">.</span></Link><span className="bp-header-note">A shared project.<br/>A record you can follow.</span><nav aria-label="Board Pack navigation"><Link href="/project"><ArrowLeft size={15}/>Project</Link><Link href="/studio"><BookOpen size={15}/>Studio</Link><Link href="/community?return=/board-pack">Saved workspaces<ArrowUpRight size={14}/></Link></nav></header>
    {projectTitle && <div className="bp-context"><span>{projectTitle}</span>{audience && <span><LockKeyhole size={13}/>{audience}</span>}</div>}
    <main id="board-pack-content" className="bp-main" tabIndex={-1}>{children}</main>
    <footer className="bp-footer"><HeartHandshake size={18}/><span>Good work, shared carefully.</span><span>Fieldproof · community project journal</span></footer>
  </div>;
}
export function BoardPackEntry({ title, children, recovery = false }: { title: string; children: ReactNode; recovery?: boolean }) {
  return <section className="bp-entry"><span className="bp-entry-icon"><BookOpen size={32} strokeWidth={1.2}/></span><p className="bp-kicker">THE BOARD PACK</p><h1>{title}</h1><div className="bp-entry-copy">{children}</div><div className="bp-actions"><Link className="bp-button bp-primary" href="/community?return=/board-pack">{recovery ? "Open saved workspaces" : "Choose your workspace"}<ArrowUpRight size={16}/></Link><Link className="bp-button bp-secondary" href="/project">Open project</Link></div><p className="bp-entry-note"><LockKeyhole size={15}/>Reports are private to your current project role. Opening a report never approves a payment.</p></section>;
}
export function BoardPackNotice({ title, children, error = false }: { title: string; children?: ReactNode; error?: boolean }) {
  return <div className={`bp-notice${error ? " is-error" : ""}`} role={error ? "alert" : "status"}><strong>{title}</strong>{children && <div>{children}</div>}</div>;
}
export function BoardPackDialog({ title, children, close, focusKey }: { title: string; children: ReactNode; close: () => void; focusKey?: string }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), titleId = useId();
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null, element = dialog.current;
    element?.showModal(); heading.current?.focus();
    return () => { element?.close(); if (opener?.isConnected && (document.activeElement === document.body || element?.contains(document.activeElement))) opener.focus(); };
  }, []);
  useEffect(() => { heading.current?.focus(); }, [title, focusKey]);
  return <dialog ref={dialog} className="bp-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}><div className="bp-dialog-body"><header><div><p className="bp-kicker">REPORT SOURCE</p><h2 id={titleId} ref={heading} tabIndex={-1}>{title}</h2></div><button type="button" className="bp-icon-button" aria-label="Close source details" onClick={close}><X size={22}/></button></header>{children}</div></dialog>;
}
