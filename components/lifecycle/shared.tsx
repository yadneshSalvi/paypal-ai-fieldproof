"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, Bell, FileText, LockKeyhole, X } from "lucide-react";
import { z } from "zod";
import * as C from "@/lib/lifecycle/contracts";
import { LifecycleRequestError, type LifecycleDomain } from "@/lib/lifecycle/client-boundary";
import { lifecycleDate, lifecycleEmailPreview, lifecycleProvenanceLabels, lifecycleValueText, renderLifecycleStatement } from "@/lib/lifecycle/presentation";
import { lifecycleErrorText, type LifecycleApi } from "./use-api";

export const lcDate = (value: string | null | undefined) => value ? lifecycleDate(value) : "Not recorded";
export const lcLabel = (value: string) => value.replaceAll("_", " ");
export const lcIntent = () => crypto.randomUUID();
export const lcUtcInput = (value: string) => value.slice(0, 16);
export function lcUtcValue(value: string) { if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) throw new TypeError("Enter a complete UTC date and time."); const iso = `${value}:00.000Z`; if (!Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString() !== iso) throw new TypeError("Enter a valid UTC date and time."); return iso; }
export const lcOrganizationDeadline = (context: C.LifecycleContext) => {
  const profile = context.organization.profile; return profile ? new Date(Math.min(Date.parse(profile.membershipExpiresAt), Date.parse(profile.sessionExpiresAt))).toISOString() : null;
};
export function LifecycleShell({ children }: { children: ReactNode }) {
  return <div className="lc-shell"><a className="lc-skip" href="#lifecycle-content">Skip to lifecycle</a><header className="lc-header"><a className="wordmark" href="/">fieldproof<span className="brand-dot">.</span></a><span className="lc-header-note">A useful record.<br/>At the right moment.</span><nav aria-label="Lifecycle navigation"><a href="/community?return=/lifecycle"><ArrowLeft size={15}/>Saved project workspaces</a><a href="/recognition">Public name choices</a><a href="/organizations">Organizations<ArrowUpRight size={14}/></a></nav></header><main className="lc-main" id="lifecycle-content" tabIndex={-1}>{children}</main><footer className="lc-footer"><Bell size={19}/><span>Clear updates, kept private.</span><span>Fieldproof · community project journal</span></footer></div>;
}
export function Notice({ title, children, error = false }: { title: string; children?: ReactNode; error?: boolean }) { return <section className={`lc-notice${error ? " is-error" : ""}`} role={error ? "alert" : "status"}><strong>{title}</strong>{children ? <div>{children}</div> : null}</section>; }
export function Reasons({ values }: { values: readonly string[] }) { return values.length ? <ul className="lc-reasons">{values.map((value, index) => <li key={`${index}:${value}`}>{value}</li>)}</ul> : null; }
export function Empty({ title, children }: { title: string; children: ReactNode }) { return <section className="lc-empty"><FileText size={25}/><h3>{title}</h3><div>{children}</div></section>; }
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) { return <label className="lc-field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>; }
export function Check({ checked, change, children, disabled = false }: { checked: boolean; change: (value: boolean) => void; children: ReactNode; disabled?: boolean }) { return <label className="lc-check"><input type="checkbox" checked={checked} onChange={event => change(event.target.checked)} disabled={disabled}/><span>{children}</span></label>; }
export function FormError({ error }: { error: unknown }) { return error ? <div className="lc-form-error" role="alert">{lifecycleErrorText(error)}</div> : null; }
export function ResourceState({ busy, error, retry }: { busy: boolean; error: unknown; retry: () => void }) { return busy ? <p role="status" className="lc-loading">Checking current permission and records…</p> : error ? <Notice title="This view could not be checked" error><p>{lifecycleErrorText(error)}</p><button type="button" className="lc-button secondary" onClick={retry}>Check current view</button></Notice> : null; }
export function LifecycleRequestStatus({ api }: { api: LifecycleApi }) {
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  return <div className="lc-request-status">{api.recovering ? <p className="lc-loading" role="status">Checking this tab’s original request records…</p> : null}{api.storageWarning ? <Notice title="Recovery storage needs attention">{api.storageWarning}</Notice> : null}{api.saved.map(value => <Notice key={value.key} title={api.busy ? "Checking the original decision…" : value.packet ? "An original request is retained" : "An older recovery record needs review"}><p>{value.packet ? `The ${lcLabel(value.packet.command.kind)} intent and reviewed values are saved in this tab. An interrupted response may already have committed. Closing a review does not cancel that original request.` : "This record is expired, damaged or does not match the current request contract. It will not be replayed. Inspect recorded history before clearing this tab’s copy."}</p>{value.packet ? <p>Original deadline: {lcDate(value.packet.expiresAt)}. Profile scope: {value.packet.domain === "dual" ? "organization and independent project organizer" : value.packet.domain}.</p> : <Check checked={acknowledged.includes(value.key)} change={checked => setAcknowledged(previous => checked ? [...previous, value.key] : previous.filter(key => key !== value.key))}>I checked recorded history. Clearing this copy does not cancel or undo an action.</Check>}<div className="lc-actions">{value.packet ? <button type="button" className="lc-button" disabled={api.busy} onClick={() => void api.retry(value.key)}>Check the same saved request</button> : null}{value.rejected || !value.packet ? <button type="button" className="lc-button secondary" disabled={api.busy || !value.packet && !acknowledged.includes(value.key)} onClick={() => api.dismiss(value.key)}>{value.packet ? "Dismiss rejected request" : "Clear reviewed recovery copy"}</button> : null}</div></Notice>)}{api.error ? <Notice title="This step needs attention" error>{lifecycleErrorText(api.error)}</Notice> : null}{api.receipt ? <Notice title="Original request confirmed"><p>{api.receipt.message}</p><small>{lcDate(api.receipt.recordedAt)}</small></Notice> : null}</div>;
}

/** A native modal with explicit initial focus, wrap and focus containment. The
 * listener remains correct when errors add controls after the modal opens. */
export function LifecycleDialog({ title, children, close, focusKey }: { title: string; children: ReactNode; close: () => void; focusKey?: string }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), id = useId(), closeRef = useRef(close); closeRef.current = close;
  useLayoutEffect(() => {
    const node = dialog.current, opener = document.activeElement instanceof HTMLElement ? document.activeElement : null; if (!node) return;
    // Successful decisions refresh the record list while this modal stays open.
    // Keep the record's stable opener identity, not only its replaced DOM node.
    const openerId = opener?.id;
    let last: HTMLElement | null = heading.current, recovering = false;
    const visible = (element: HTMLElement) => {
      if (!element.isConnected || element.matches(":disabled,input[type=hidden]") || element.closest("[hidden],[inert]")) return false;
      for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) { const style = window.getComputedStyle(parent); if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility)) return false; if (parent === node) break; }
      return true;
    };
    const key = (event: KeyboardEvent) => {
      if (!node.open) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
      const controls = [...node.querySelectorAll<HTMLElement>("button,a[href],input,select,textarea,[tabindex],[contenteditable=true]")].filter(element => element.tabIndex >= 0 && visible(element)), first = controls[0], end = controls.at(-1), active = document.activeElement;
      if (!first) { event.preventDefault(); heading.current?.focus(); }
      else if (!controls.includes(active as HTMLElement) || (event.shiftKey ? active === first : active === end)) { event.preventDefault(); (event.shiftKey ? end : first)?.focus(); }
    };
    const focus = (event: FocusEvent) => { if (!node.open || recovering) return; if (event.target instanceof HTMLElement && node.contains(event.target)) { last = event.target; return; } recovering = true; (last && visible(last) ? last : heading.current)?.focus({ preventScroll: true }); recovering = false; };
    document.addEventListener("keydown", key, true); document.addEventListener("focusin", focus, true); node.showModal(); heading.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", key, true); document.removeEventListener("focusin", focus, true);
      const returnFocus = document.activeElement === document.body || node.contains(document.activeElement);
      node.close();
      if (!returnFocus) return;
      const currentOpener = opener?.isConnected ? opener : openerId ? document.getElementById(openerId) : null;
      const target = currentOpener && visible(currentOpener) ? currentOpener : document.querySelector<HTMLElement>('.lc-tabs [role="tab"][aria-selected="true"]') ?? document.getElementById("lifecycle-content");
      if (target && visible(target)) target.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => { heading.current?.focus({ preventScroll: true }); }, [focusKey]);
  return <dialog ref={dialog} className="lc-dialog" aria-modal="true" aria-labelledby={id} onCancel={event => { event.preventDefault(); closeRef.current(); }}><div className="lc-dialog-body"><header><h2 id={id} ref={heading} tabIndex={-1}>{title}</h2><button className="lc-icon-button" type="button" aria-label="Close review" onClick={close}><X size={23}/></button></header>{children}</div></dialog>;
}

export function CitedDraft({ content, sources, api, domain, basePath, scope, allowEmailPreview = false, invalidated }: { content: C.LifecycleContent; sources: C.LifecycleSourceRow[]; api: LifecycleApi; domain: Exclude<LifecycleDomain, "context">; basePath: string; scope: string; allowEmailPreview?: boolean; invalidated: () => void }) {
  const [locale, setLocale] = useState<"en" | "es">("en"), [email, setEmail] = useState(false), [source, setSource] = useState<C.LifecycleSourceDetail | null>(null), [sourceError, setSourceError] = useState<unknown>(null), [sourceBusy, setSourceBusy] = useState(false), epoch = useRef(0), sourceHeading = useRef<HTMLHeadingElement>(null);
  const bodyKey = `${content.contentHash}:${content.sourceHash}`;
  useEffect(() => { epoch.current++; setSource(null); setSourceError(null); setSourceBusy(false); setEmail(false); return () => { epoch.current++; }; }, [bodyKey]);
  let sentences: string[] = [], preview: C.LifecycleEmailPreview | null = null, contentError: unknown = null;
  try { sentences = content.statements.map(statement => renderLifecycleStatement(statement, sources, locale)); if (allowEmailPreview) preview = lifecycleEmailPreview(content, sources); } catch (caught) { contentError = caught; }
  useEffect(() => { if (contentError) invalidated(); }, [!!contentError, invalidated]);
  async function inspect(sourceId: string, sourceHash: string) {
    const sequence = ++epoch.current; setSource(null); setSourceError(null); setSourceBusy(true);
    try {
      const value = await api.read(`${basePath}/sources/${encodeURIComponent(sourceId)}`, z.object({ detail: C.lifecycleSourceDetailSchema }).strict(), domain);
      if (!value || epoch.current !== sequence) return;
      if (value.detail.scope !== scope || value.detail.source.id !== sourceId || value.detail.source.contentHash !== sourceHash || value.detail.snapshotHash !== content.sourceHash) throw new LifecycleRequestError("This source no longer matches the original private draft. Check its current permission.", "LIFECYCLE_SOURCE_CHANGED", 410);
      setSource(value.detail);
    } catch (caught) { if (epoch.current !== sequence) return; setSourceError(caught); if (caught instanceof LifecycleRequestError && (caught.status === 401 || caught.status === 403 || caught.status === 410 || /SOURCE|CONTEXT|CHANGED|ENDED/.test(caught.code))) invalidated(); }
    finally { if (epoch.current === sequence) { setSourceBusy(false); requestAnimationFrame(() => sourceHeading.current?.focus()); } }
  }
  return <div className="lc-cited-draft"><div className="lc-draft-meta"><LockKeyhole size={15}/><span>Private draft · {content.origin === "deterministic" ? "Authored factual templates" : "Explicit model selection of cited sentences"}</span><span>Source cutoff: {lcDate(content.asOf)}</span></div><div className="lc-actions lc-language" aria-label="Draft language"><button type="button" className="lc-button secondary" aria-pressed={locale === "en"} onClick={() => setLocale("en")}>English</button><button type="button" className="lc-button secondary" aria-pressed={locale === "es"} onClick={() => setLocale("es")}>Español</button>{allowEmailPreview ? <button type="button" className="lc-button secondary" aria-pressed={email} onClick={() => setEmail(value => !value)}>{email ? "Read cited draft" : "Preview email wording"}</button> : null}</div><p className="lc-fineprint">Spanish is authored and has not received a fluent-language review. No external message is authorized.</p>{contentError ? <Notice title="Source values need a fresh check" error>Private wording is withheld because its exact citations do not match.</Notice> : email && preview ? <section className="lc-email-preview" lang={locale}><span className="lc-kicker">Email preview · never sent</span><h3>{preview.subject}</h3><p>No destination is collected. This view is not delivery permission.</p>{(locale === "es" ? preview.spanish : preview.english).map((sentence, index) => <p key={index}>{sentence}</p>)}</section> : <div lang={locale} className="lc-sentences">{sentences.map((sentence, index) => <section key={content.statements[index].id}><p>{sentence}</p><div className="lc-citations">{content.statements[index].citations.map((citation, number) => <button type="button" key={citation.sourceId} onClick={() => void inspect(citation.sourceId, citation.sourceHash)} aria-label={`Inspect source ${number + 1} for sentence ${index + 1}`}>Source {number + 1}</button>)}</div></section>)}</div>}<Reasons values={content.notices}/>{sourceBusy || source || sourceError ? <section className="lc-source-detail"><h3 ref={sourceHeading} tabIndex={-1}>Captured scalar source</h3>{sourceBusy ? <p role="status">Checking original source permission…</p> : null}<FormError error={sourceError}/>{source ? <><h4>{source.source.label}</h4><p className="lc-source-value">{lifecycleValueText(source.source.value, locale)}</p>{source.source.value.kind === "unknown" ? <p>{source.source.value.reason}</p> : null}<p><span className="lc-badge">{lifecycleProvenanceLabels[source.source.provenance]}</span> {lcLabel(source.status)}</p><dl className="lc-details"><div><dt>Original cutoff</dt><dd>{lcDate(source.asOf)}</dd></div><div><dt>Observed</dt><dd>{lcDate(source.source.observedAt)}</dd></div></dl>{source.source.limitation ? <p>{source.source.limitation}</p> : null}<Reasons values={source.notices}/></> : null}</section> : null}</div>;
}
