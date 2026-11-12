"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowLeft, Check, Copy, HeartHandshake, Link2, LockKeyhole, Share2, X } from "lucide-react";
import { workspaceTabIdentity } from "@/lib/community/workspace-fetch";

export const accessDate = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)) + " UTC";
export class SupporterRequestError extends Error { constructor(message: string, readonly code: string, readonly status: number) { super(message); } }
export async function supporterRequest<T>(path: string, body?: unknown, options: { signal?: AbortSignal; scope?: string } = {}): Promise<T> {
  const response = await fetch(`/api/supporters${path ? `/${path}` : ""}`, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", signal: options.signal,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(options.scope ? { "X-Fieldproof-Supporter-Scope": options.scope } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new SupporterRequestError(value.error ?? "This step could not finish. Check its saved status before trying again.", value.code ?? "REQUEST_UNAVAILABLE", response.status);
  return value as T;
}
/** Abort rendering work when another tab changes identity, including within the same project. */
export function useEntryBoundary(onChange: () => void) {
  const epoch = useRef(0), controllers = useRef(new Set<AbortController>()), callback = useRef(onChange); callback.current = onChange;
  useEffect(() => {
    const channel = new BroadcastChannel("fieldproof-workspace-changed");
    channel.onmessage = event => { if (event.data?.origin === workspaceTabIdentity()) return; epoch.current++; controllers.current.forEach(controller => controller.abort()); controllers.current.clear(); callback.current(); };
    return () => { epoch.current++; controllers.current.forEach(controller => controller.abort()); controllers.current.clear(); channel.close(); };
  }, []);
  return {
    invalidate() { epoch.current++; controllers.current.forEach(controller => controller.abort()); controllers.current.clear(); },
    start() { const controller = new AbortController(), current = epoch.current; controllers.current.add(controller); return { signal: controller.signal, current: () => !controller.signal.aborted && epoch.current === current, finish: () => controllers.current.delete(controller) }; },
  };
}
export function SupporterShell({ children, organizer = false }: { children: ReactNode; organizer?: boolean }) {
  return <div className="sp-shell"><a className="sp-skip" href="#supporter-content">Skip to content</a><header className="sp-header"><Link href="/" className="wordmark">fieldproof<span className="brand-dot">.</span></Link><span className="sp-header-caption">A place for people.<br/>A purpose for every contribution.</span><Link className="sp-back" href={organizer ? "/organizer" : "/community"}><ArrowLeft size={16}/>{organizer ? "Project desk" : "Saved workspaces"}</Link></header><main id="supporter-content" className="sp-main">{children}</main><footer className="sp-footer"><HeartHandshake size={19}/><span>Good work, shared carefully.</span><span>Fieldproof · community project journal</span></footer></div>;
}
export function SupporterNotice({ title, children, error = false, headingRef }: { title: string; children?: ReactNode; error?: boolean; headingRef?: RefObject<HTMLHeadingElement | null> }) {
  return <div className={`sp-notice${error ? " is-error" : ""}`} role={error ? "alert" : "status"}><h2 ref={headingRef} tabIndex={-1}>{title}</h2>{children && <p>{children}</p>}</div>;
}
export function PrivateLink({ path, label = "Private invitation link", note }: { path: string; label?: string; note: string }) {
  const [url, setUrl] = useState(path), [message, setMessage] = useState(""), [shareable, setShareable] = useState(false), field = useRef<HTMLInputElement>(null);
  useEffect(() => { setUrl(new URL(path, window.location.origin).href); setShareable(typeof navigator.share === "function"); setMessage(""); }, [path]);
  async function copy() {
    try { if (!navigator.clipboard) throw new Error("Clipboard unavailable"); await navigator.clipboard.writeText(url); setMessage("Private link copied."); }
    catch { field.current?.focus(); field.current?.select(); setMessage("The complete link is selected. Copy it with your keyboard or device’s Copy command."); }
  }
  async function share() {
    try { await navigator.share({ title: "Your private Fieldproof invitation", url }); setMessage("Your device’s sharing panel has closed."); }
    catch (error) { if (!(error instanceof Error) || error.name !== "AbortError") setMessage("Sharing could not open. Copy the private link instead."); }
  }
  return <section className="sp-private-link" aria-label={label}><div className="sp-private-link-title"><Link2 size={18}/><strong>{label}</strong></div><input ref={field} aria-label={label} value={url} readOnly spellCheck={false} autoComplete="off" onFocus={event => event.currentTarget.select()}/><div className="sp-link-actions"><button type="button" className="button primary" onClick={() => void copy()}>{message === "Private link copied." ? <Check size={16}/> : <Copy size={16}/>}Copy link</button>{shareable && <button type="button" className="button secondary" onClick={() => void share()}><Share2 size={16}/>Share privately</button>}</div><p className="sp-link-note"><LockKeyhole size={15}/>{note}</p><span className="sp-copy-status" role="status" aria-live="polite">{message}</span></section>;
}
export function AccessDialog({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null, element = dialog.current;
    element?.showModal(); heading.current?.focus();
    return () => { element?.close(); if (opener?.isConnected && (document.activeElement === document.body || element?.contains(document.activeElement))) opener.focus(); };
  }, []);
  return <dialog className="sp-dialog" ref={dialog} aria-labelledby="supporter-dialog-title" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}><div className="sp-dialog-body"><header><h2 id="supporter-dialog-title" ref={heading} tabIndex={-1}>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={close}><X size={21}/></button></header>{children}</div></dialog>;
}
