"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, Check, Copy, HeartHandshake, LockKeyhole, X } from "lucide-react";
import { z } from "zod";
import { announceOrganizationChange, createOrgBoundary, listenForOrganizationChanges, orgRecoveryForError, orgRequest, OrgRequestError, type OrgRequestDomain } from "@/lib/organizations/client-boundary";
import { ORG_ATTEMPT_STORAGE, orgCommandContract, readOrgPendingAttempt, saveOrgAttempt, type OrgPendingAttempt } from "@/lib/organizations/entry-draft";
import * as C from "@/lib/organizations/contracts";

export const orgDate = (value: string | null | undefined): string => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)) + " UTC" : "Not recorded";
export const orgMoney = (value: number | null | undefined, currency = "USD"): string => value === null || value === undefined ? "Not disclosed" : new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value / 100);
export const orgLabel = (value: string): string => value.replaceAll("_", " ");
export const orgErrorText = (error: unknown): string => error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join(".") || "Review"}: ${issue.message}`).join(" ") : error instanceof Error ? error.message : "This step could not finish. Check the current view and try the same saved request.";
export const orgPolicyLabels: Record<C.OrgPolicyKind, string> = { package_library: "Package library", fund_restriction: "Funding rules", evidence_policy: "Evidence rules" };
export const orgConsumerLabels: Record<C.OrgConsumerKind, string> = {
  planning_draft: "Editable plan draft", canonical_empty_packages: "Reviewed empty-package revision", plan_review: "New plan reviews", plan_publication: "New plan publications", funding_policy: "New purpose terms", sponsor_offer: "New sponsor offers", purpose_pledge: "New donor pledges", expense_review: "New expense reviews", payable_approval: "New payable approvals", image_review: "New image reviews", physical_signoff: "New physical signoffs",
};
type RequestContext = { scope?: string; projectScope?: string; domain?: OrgRequestDomain };
function domainFor(options: RequestContext): OrgRequestDomain { return options.domain ?? (options.scope && options.projectScope ? "dual" : options.projectScope ? "project" : "organization"); }
type ApiCallbacks = { organizationChanged: () => void; projectChanged: () => void; committed: (value: unknown, path: string) => void };
export function useOrganizationApi(callbacks: ApiCallbacks) {
  const [boundary] = useState(createOrgBoundary), latest = useRef(callbacks); latest.current = callbacks;
  const [pending, setPending] = useState<OrgPendingAttempt | null>(null), pendingRef = useRef<OrgPendingAttempt | null>(null);
  const [busy, setBusy] = useState(false), busyRef = useRef(false), [error, setError] = useState<unknown>(null), [receipt, setReceipt] = useState<C.OrgCommandReceipt | null>(null), [canDismiss, setCanDismiss] = useState(false), [storageWarning, setStorageWarning] = useState("");
  useEffect(() => {
    try { const stored = readOrgPendingAttempt(sessionStorage.getItem(ORG_ATTEMPT_STORAGE)); pendingRef.current = stored; setPending(stored); if (!stored) sessionStorage.removeItem(ORG_ATTEMPT_STORAGE); }
    catch { setStorageWarning("Per-tab recovery storage is unavailable. Keep this tab open until each request is confirmed."); }
    const close = listenForOrganizationChanges(boundary, { organizationChanged: () => latest.current.organizationChanged(), projectChanged: () => latest.current.projectChanged() });
    return () => { close(); boundary.invalidate("all"); };
  }, [boundary]);
  function authorityChanged(error: unknown) {
    const recovery = orgRecoveryForError(error);
    if (recovery === "identity") { boundary.invalidate("organization"); latest.current.organizationChanged(); }
    if (recovery === "project") { boundary.invalidate("project"); latest.current.projectChanged(); }
  }
  async function read<T>(path: string, schema: z.ZodType<T>, options: RequestContext & { body?: unknown } = {}): Promise<T | null> {
    const ticket = boundary.start(domainFor(options));
    try { const value = await orgRequest(path, schema, options.body, { scope: options.scope, projectScope: options.projectScope, signal: ticket.signal }); return ticket.current() ? value : null; }
    catch (caught) { if (!ticket.current()) return null; authorityChanged(caught); throw caught; }
    finally { ticket.finish(); }
  }
  async function execute<T>(attempt: OrgPendingAttempt, schema: z.ZodType<T>): Promise<T | null> {
    if (busyRef.current) return null;
    busyRef.current = true; setBusy(true); setError(null); setCanDismiss(false);
    const options = { scope: attempt.context.organization ?? undefined, projectScope: attempt.context.project ?? undefined }, domain = domainFor(options);
    boundary.invalidate(domain); const ticket = boundary.start(domain);
    try {
      const value = await orgRequest(attempt.path, schema, attempt.body, { ...options, signal: ticket.signal });
      if (!ticket.current()) return null;
      pendingRef.current = null; setPending(null);
      try { sessionStorage.removeItem(ORG_ATTEMPT_STORAGE); } catch { /* In-memory confirmation remains authoritative. */ }
      const parsed = C.orgCommandReceiptSchema.safeParse(value && typeof value === "object" && "receipt" in value ? value.receipt : null);
      if (parsed.success) setReceipt(parsed.data);
      announceOrganizationChange(); latest.current.committed(value, attempt.path);
      return value;
    } catch (caught) {
      if (!ticket.current()) return null;
      setError(caught);
      setCanDismiss(caught instanceof OrgRequestError && caught.status >= 400 && caught.status < 500 && !["ORG_COMMAND_BUSY", "ORG_INTENT_CHANGED"].includes(caught.code));
      authorityChanged(caught); return null;
    } finally { ticket.finish(); busyRef.current = false; setBusy(false); }
  }
  async function command<T>(path: string, body: unknown, schema: z.ZodType<T>, options: RequestContext = {}): Promise<T | null> {
    try {
      const contract = orgCommandContract(path); if (!contract) throw new Error("This operation is not a supported organization command.");
      const attempt = saveOrgAttempt(path, { organization: options.scope ?? null, project: options.projectScope ?? null }, body, contract.request);
      if (pendingRef.current && JSON.stringify(pendingRef.current) !== JSON.stringify(attempt)) { setError(new Error("A previous request is still saved. Recover or dismiss its confirmed rejection before starting a different decision.")); return null; }
      pendingRef.current = attempt; setPending(attempt); setCanDismiss(false);
      try { sessionStorage.setItem(ORG_ATTEMPT_STORAGE, JSON.stringify(attempt)); }
      catch { setStorageWarning("Per-tab recovery storage is unavailable. Keep this tab open until this exact request is confirmed."); }
      return await execute(attempt, schema);
    } catch (caught) { setError(caught); return null; }
  }
  function dismiss() {
    if (!canDismiss || busyRef.current) return;
    pendingRef.current = null; setPending(null); setError(null); setCanDismiss(false);
    try { sessionStorage.removeItem(ORG_ATTEMPT_STORAGE); } catch { /* No persisted state was available. */ }
  }
  function retry() { const attempt = pendingRef.current, contract = attempt && orgCommandContract(attempt.path); if (attempt && contract) void execute(attempt, contract.response); }
  return { read, command, boundary, busy, blocked: busy || !!pending, pending, error, receipt, canDismiss, dismiss, retry, storageWarning, clearError: () => setError(null) };
}
export type OrgApi = ReturnType<typeof useOrganizationApi>;
export function useOrgResource<T>(key: string, load: () => Promise<T | null>) {
  const latest = useRef(load); latest.current = load;
  const [result, setResult] = useState<{ key: string; value: T | null; error: unknown; busy: boolean }>({ key, value: null, error: null, busy: true }), [generation, setGeneration] = useState(0);
  useEffect(() => {
    let active = true; setResult(previous => ({ key, value: previous.key === key ? previous.value : null, error: null, busy: true }));
    void latest.current().then(value => { if (active) setResult({ key, value, error: null, busy: false }); }, error => { if (active) setResult({ key, value: null, error, busy: false }); });
    return () => { active = false; };
  }, [key, generation]);
  return { value: result.key === key ? result.value : null, error: result.key === key ? result.error : null, busy: result.key !== key || result.busy, refresh: () => setGeneration(value => value + 1) };
}
export function useOrgDeadline(deadline: string | null | undefined, expire: () => void) {
  const latest = useRef(expire); latest.current = expire;
  useEffect(() => {
    if (!deadline) return;
    let timer: ReturnType<typeof setTimeout> | undefined, ended = false;
    function check() {
      if (timer) clearTimeout(timer);
      const remaining = Date.parse(deadline!) - Date.now();
      if (remaining <= 0) { if (!ended) { ended = true; latest.current(); } }
      else timer = setTimeout(check, Math.min(remaining + 10, 2_147_483_647));
    }
    check(); window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { if (timer) clearTimeout(timer); window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, [deadline]);
}
export function OrganizationShell({ children, name }: { children: ReactNode; name?: string }) {
  return <div className="og-shell"><a className="og-skip" href="#organization-content">Skip to organization</a><header className="og-header"><a className="wordmark" href="/">fieldproof<span className="brand-dot">.</span></a><span className="og-header-note">Independent projects.<br/>A clearer shared picture.</span><nav aria-label="Organization navigation"><a href="/community?return=/organizations"><ArrowLeft size={15}/>Project workspaces</a><a href="/organizations">Organizations<ArrowUpRight size={14}/></a></nav></header>{name && <div className="og-context"><LockKeyhole size={14}/><span>{name}</span><span>Private organization space</span></div>}<main id="organization-content" className="og-main" tabIndex={-1}>{children}</main><footer className="og-footer"><HeartHandshake size={19}/><span>Good work, shared carefully.</span><span>Fieldproof · community project journal</span></footer></div>;
}
export function OrgNotice({ title, children, error = false }: { title: string; children?: ReactNode; error?: boolean }) {
  return <div className={`og-notice${error ? " is-error" : ""}`} role={error ? "alert" : "status"}><strong>{title}</strong>{children && <div>{children}</div>}</div>;
}
export function OrgRequestStatus({ api }: { api: OrgApi }) {
  const label = api.pending && orgCommandContract(api.pending.path)?.label;
  return <div className="og-request-status">{api.storageWarning && <OrgNotice title="Keep this tab open">{api.storageWarning}</OrgNotice>}{api.pending && <OrgNotice title={api.busy ? `Confirming ${label ?? "saved request"}…` : `A ${label ?? "request"} is saved`}><p>The original intent and reviewed values are retained. A delayed response can mean the action already committed.</p><div className="og-actions"><button type="button" className="og-button" disabled={api.busy} onClick={api.retry}>Check the same request</button>{api.canDismiss && <button type="button" className="og-button secondary" onClick={api.dismiss}>Dismiss rejected request</button>}</div></OrgNotice>}{!!api.error && <OrgNotice title="This step needs attention" error>{orgErrorText(api.error)}</OrgNotice>}{api.receipt && !api.pending && <OrgNotice title="Request confirmed"><p>{api.receipt.message}</p><small>{orgDate(api.receipt.committedAt)} · Original request {api.receipt.intentId.slice(0, 8)}</small></OrgNotice>}</div>;
}
export function OrgIssues({ issues }: { issues: { code: string; path: string; message: string; severity: string }[] }) {
  return issues.length ? <ul className="og-issues">{issues.map((issue, index) => <li key={`${issue.code}:${issue.path}:${index}`}><span className="og-badge">{orgLabel(issue.severity)}</span> {issue.message}{issue.path && <small>{issue.path}</small>}</li>)}</ul> : null;
}
export function OrgList({ values }: { values: string[] }) { return values.length ? <ul className="og-notes">{values.map((value, index) => <li key={`${index}:${value}`}>{value}</li>)}</ul> : null; }
export function OrgEmpty({ title, children }: { title: string; children: ReactNode }) { return <section className="og-empty"><h3>{title}</h3><div>{children}</div></section>; }
export function OrgField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="og-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function OrgAck({ children, checked, change, disabled = false }: { children: ReactNode; checked: boolean; change: (value: boolean) => void; disabled?: boolean }) { return <label className="og-check"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => change(event.target.checked)}/><span>{children}</span></label>; }
export function OrgFormError({ error }: { error: unknown }) { return error ? <div className="og-inline-error" role="alert">{orgErrorText(error)}</div> : null; }
export function submitOrgForm(event: FormEvent<HTMLFormElement>, action: () => void) { event.preventDefault(); action(); }
export function OrgPrivateLink({ path, title, expiresAt }: { path: string; title: string; expiresAt?: string }) {
  const [url, setUrl] = useState(path), [message, setMessage] = useState(""), input = useRef<HTMLInputElement>(null);
  useEffect(() => { setUrl(new URL(path, window.location.origin).href); setMessage(""); }, [path]);
  async function copy() { try { await navigator.clipboard.writeText(url); setMessage("Private link copied."); } catch { input.current?.focus(); input.current?.select(); setMessage("The complete link is selected. Use your device’s Copy command."); } }
  return <section className="og-private-link"><h3><LockKeyhole size={17}/>{title}</h3><input ref={input} value={url} readOnly aria-label={title} spellCheck={false} autoComplete="off" onFocus={event => event.currentTarget.select()}/><button type="button" className="og-button" onClick={() => void copy()}>{message === "Private link copied." ? <Check size={16}/> : <Copy size={16}/>}Copy private link</button>{expiresAt && <p>Fixed deadline: {orgDate(expiresAt)}</p>}<p>Possession can authenticate the intended profile. Keep the complete link private. It does not verify a person, organization, email address or PayPal account.</p><span role="status">{message}</span></section>;
}
export function OrgDialog({ title, children, close, focusKey, api }: { title: string; children: ReactNode; close: () => void; focusKey?: string; api?: OrgApi }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), labelId = useId();
  useLayoutEffect(() => {
    const element = dialog.current, opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!element) return;
    let last: HTMLElement | null = heading.current, recovering = false;
    function visible(node: HTMLElement) {
      if (!node.isConnected || node.matches(":disabled,input[type=hidden]") || node.closest("[hidden],[inert]")) return false;
      for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) { const style = window.getComputedStyle(parent); if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false; if (parent === element) break; }
      return true;
    }
    function contain(event: KeyboardEvent) {
      if (!element?.open || event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
      const controls = Array.from(element.querySelectorAll<HTMLElement>("button,a[href],input,select,textarea,[tabindex],[contenteditable=true]")).filter(node => node.tabIndex >= 0 && visible(node));
      const active = document.activeElement, first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); heading.current?.focus(); }
      else if (!controls.includes(active as HTMLElement) || (event.shiftKey ? active === first : active === last)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
    }
    function recover(event: FocusEvent) {
      if (!element?.open || recovering) return;
      if (event.target instanceof HTMLElement && element.contains(event.target)) { last = event.target; return; }
      recovering = true; (last && visible(last) ? last : heading.current)?.focus({ preventScroll: true }); recovering = false;
    }
    document.addEventListener("keydown", contain, true); document.addEventListener("focusin", recover, true);
    if (!element.open) element.showModal(); heading.current?.focus({ preventScroll: true });
    return () => { document.removeEventListener("keydown", contain, true); document.removeEventListener("focusin", recover, true); element.close(); if (opener?.isConnected && (document.activeElement === document.body || element.contains(document.activeElement))) opener.focus({ preventScroll: true }); };
  }, []);
  useLayoutEffect(() => { heading.current?.focus({ preventScroll: true }); }, [focusKey]);
  return <dialog ref={dialog} className="og-dialog" aria-modal="true" aria-labelledby={labelId} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}><div className="og-dialog-body"><header><h2 id={labelId} ref={heading} tabIndex={-1}>{title}</h2><button type="button" className="og-icon-button" aria-label="Close dialog" onClick={close}><X size={22}/></button></header><fieldset className="og-dialog-fields" aria-label="Reviewed values" disabled={api?.blocked}>{children}</fieldset>{api?.pending && <section className="og-inline-recovery" role="status"><p>The original request and values are retained. Closing this review does not cancel a request that may already have committed.</p><div className="og-actions"><button type="button" className="og-button" disabled={api.busy} onClick={api.retry}>Check the same request</button>{api.canDismiss && <button type="button" className="og-button secondary" onClick={api.dismiss}>Dismiss rejected request</button>}</div></section>}</div></dialog>;
}
