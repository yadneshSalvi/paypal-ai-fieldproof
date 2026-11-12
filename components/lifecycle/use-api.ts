"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import * as C from "@/lib/lifecycle/contracts";
import { announceLifecycleChange, createLifecycleBoundary, createLifecyclePending, lifecycleCommandPath, lifecycleCurrentStorageKeys, lifecycleErrorRecovery, lifecyclePendingStorageKey, lifecycleRequest, LifecycleRequestError, listenForLifecycleChanges, readLifecyclePending, saveLifecyclePending, type LifecycleDomain, type LifecyclePending } from "@/lib/lifecycle/client-boundary";

type Domain = Exclude<LifecycleDomain, "context">;
type Callbacks = { changed: (domain: Domain) => void; committed: (domain: Domain, receipt: C.LifecycleReceipt) => void };
type Saved = { key: string; packet: LifecyclePending | null; rejected: boolean };
const receiptSchema = z.object({ receipt: C.lifecycleReceiptSchema }).strict();
const intersects = (a: Domain, b: Domain) => a === "dual" || b === "dual" || a === b;
const contextKey = (context: C.LifecycleContext | null) => context ? `${context.project.state}:${context.project.scope}:${context.organization.state}:${context.organization.scope}` : "none";
export const lifecycleErrorText = (error: unknown): string => error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join(".") || "Review"}: ${issue.message}`).join(" ") : error instanceof LifecycleRequestError ? error.message : "This step could not finish. Review the current profile and check the same saved request.";

/** Browser epochs prevent late rendering. Only the server grants authority. */
export function useLifecycleApi(context: C.LifecycleContext | null, callbacks: Callbacks) {
  const [boundary] = useState(createLifecycleBoundary), latest = useRef(callbacks), current = useRef(context); latest.current = callbacks; current.current = context;
  const [saved, setSaved] = useState<Saved[]>([]), savedRef = useRef<Saved[]>([]), [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [error, setError] = useState<unknown>(null), [receipt, setReceipt] = useState<C.LifecycleReceipt | null>(null), [storageWarning, setStorageWarning] = useState("");
  const [recoveredKey, setRecoveredKey] = useState(""), recoveredRef = useRef("");
  const update = useCallback((values: Saved[]) => { savedRef.current = values; setSaved(values); }, []);
  const scopeKey = contextKey(context);
  useEffect(() => {
    let active = true;
    if (!context) { update([]); recoveredRef.current = scopeKey; setRecoveredKey(scopeKey); return; }
    const keys = lifecycleCurrentStorageKeys(context);
    void Promise.all(keys.map(async key => {
      const memory = savedRef.current.find(value => value.key === key);
      try {
        const raw = sessionStorage.getItem(key);
        if (!raw) return memory ?? null;
        const packet = await readLifecyclePending(raw, context, new Date().toISOString());
        return { key, packet, rejected: memory?.rejected ?? false };
      } catch { if (active) setStorageWarning("Per-tab recovery storage is unavailable. A new decision will not be sent until its original request can be saved."); return memory ?? null; }
    })).then(values => { if (active) { update(values.filter((value): value is Saved => value !== null)); recoveredRef.current = scopeKey; setRecoveredKey(scopeKey); } });
    return () => { active = false; };
    // Context changes are deliberately keyed by the two independent scopes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, update]);
  useEffect(() => {
    const close = listenForLifecycleChanges(boundary, { projectChanged: () => latest.current.changed("project"), organizationChanged: () => latest.current.changed("organization") });
    return () => { close(); boundary.invalidate("all"); };
  }, [boundary]);
  const changed = useCallback((caught: unknown, domain: LifecycleDomain) => {
    if (domain === "context") return;
    const recovery = lifecycleErrorRecovery(caught);
    if (recovery === "project" || recovery === "organization") { boundary.invalidate(recovery); latest.current.changed(recovery); }
    else if (recovery === "source" || caught instanceof LifecycleRequestError && (caught.status === 401 || caught.status === 403 || ["LIFECYCLE_AUTHORITY_ENDED", "LIFECYCLE_EXPIRED"].includes(caught.code))) {
      boundary.invalidate(domain);
      latest.current.changed(domain);
    }
  }, [boundary]);
  const read = useCallback(async <T,>(path: string, schema: z.ZodType<T>, domain: LifecycleDomain, body?: unknown): Promise<T | null> => {
    const ticket = boundary.start(domain), ctx = current.current;
    try {
      const result = await lifecycleRequest(path, schema, body, { domain, projectScope: ctx?.project.scope, organizationScope: ctx?.organization.scope, signal: ticket.signal });
      return ticket.current() ? result : null;
    } catch (caught) { if (!ticket.current()) return null; changed(caught, domain); throw caught; }
    finally { ticket.finish(); }
  }, [boundary, changed]);
  const execute = useCallback(async (packet: LifecyclePending): Promise<boolean> => {
    const ctx = current.current, key = lifecyclePendingStorageKey(packet);
    if (!ctx || !await readLifecyclePending(JSON.stringify(packet), ctx, new Date().toISOString())) { setError(new LifecycleRequestError("The original profile or fixed deadline ended. Restore that exact profile while it remains valid, or inspect its recorded history.", "LIFECYCLE_AUTHORITY_ENDED", 403)); return false; }
    boundary.invalidate(packet.domain);
    const ticket = boundary.start(packet.domain);
    try {
      saveLifecyclePending(sessionStorage, packet);
      const result = await lifecycleRequest(lifecycleCommandPath(packet.command), receiptSchema, packet.command.input, { domain: packet.domain, projectScope: packet.projectScope ?? undefined, organizationScope: packet.organizationScope ?? undefined, signal: ticket.signal });
      if (!ticket.current()) return false;
      const expectedResource = "resourceId" in packet.command ? packet.command.resourceId : null;
      if (result.receipt.intentId !== packet.command.input.intentId || result.receipt.kind !== packet.command.kind || expectedResource && result.receipt.resourceId !== expectedResource) throw new LifecycleRequestError("The response did not confirm this exact original request. Check it again.", "REQUEST_UNAVAILABLE", 502);
      try { if (sessionStorage.getItem(key) === JSON.stringify(packet)) sessionStorage.removeItem(key); } catch { setStorageWarning("The request is confirmed. This tab could not clear its recovery copy; checking it again returns the same receipt."); }
      update(savedRef.current.filter(value => value.key !== key)); setError(null); setReceipt(result.receipt);
      if (packet.domain !== "organization") announceLifecycleChange("project");
      if (packet.domain !== "project") announceLifecycleChange("organization");
      latest.current.committed(packet.domain, result.receipt); return true;
    } catch (caught) {
      if (!ticket.current()) return false;
      setError(caught); changed(caught, packet.domain);
      const rejected = caught instanceof LifecycleRequestError && caught.status >= 400 && caught.status < 500 && ["LIFECYCLE_VERSION_CHANGED", "LIFECYCLE_REVIEW_REQUIRED", "LIFECYCLE_OCCURRENCE_CHANGED", "LIFECYCLE_INTENT_CHANGED", "LIFECYCLE_RETRY_NOT_ALLOWED", "INVALID_INPUT", "INPUT_TOO_LARGE"].includes(caught.code);
      update(savedRef.current.map(value => value.key === key ? { ...value, rejected } : value)); return false;
    } finally { ticket.finish(); }
  }, [boundary, changed, update]);
  const command = useCallback(async (command: C.LifecycleCommand, deadline: string): Promise<boolean> => {
    if (busyRef.current || !current.current || recoveredRef.current !== contextKey(current.current)) return false;
    busyRef.current = true; setBusy(true); setError(null); setReceipt(null);
    try {
      const packet = await createLifecyclePending(command, current.current, deadline, new Date().toISOString()), key = lifecyclePendingStorageKey(packet);
      if (savedRef.current.some(value => !value.packet || intersects(value.packet.domain, packet.domain))) throw new LifecycleRequestError("Resolve the existing saved request for this profile before making another decision.", "LIFECYCLE_BUSY", 409);
      update([...savedRef.current, { key, packet, rejected: false }]);
      return await execute(packet);
    } catch (caught) { setError(caught); return false; }
    finally { busyRef.current = false; setBusy(false); }
  }, [changed, execute, update]);
  const retry = useCallback(async (key: string) => {
    if (busyRef.current) return;
    const packet = savedRef.current.find(value => value.key === key)?.packet; if (!packet) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await execute(packet); } finally { busyRef.current = false; setBusy(false); }
  }, [execute]);
  const dismiss = useCallback((key: string) => {
    if (busyRef.current) return;
    const value = savedRef.current.find(value => value.key === key); if (!value || value.packet && !value.rejected) return;
    try { sessionStorage.removeItem(key); if (sessionStorage.getItem(key)) throw new Error("not cleared"); update(savedRef.current.filter(item => item.key !== key)); setError(null); }
    catch { setStorageWarning("The recovery record could not be cleared. Check browser storage before starting another decision."); }
  }, [update]);
  return { read, command, retry, dismiss, boundary, saved, busy, error, receipt, storageWarning, recovering: recoveredKey !== scopeKey, clearError: () => setError(null), blocked: (domain: Domain) => recoveredKey !== scopeKey || busy || saved.some(value => !value.packet || intersects(value.packet.domain, domain)) };
}
export type LifecycleApi = ReturnType<typeof useLifecycleApi>;

export function useLifecycleResource<T>(key: string, load: () => Promise<T | null>) {
  const latest = useRef(load); latest.current = load;
  const [revision, setRevision] = useState(0), [result, setResult] = useState<{ key: string; value: T | null; error: unknown; busy: boolean }>({ key, value: null, error: null, busy: true });
  useEffect(() => { let active = true; setResult({ key, value: null, error: null, busy: true }); void latest.current().then(value => { if (active) setResult({ key, value, error: null, busy: false }); }, error => { if (active) setResult({ key, value: null, error, busy: false }); }); return () => { active = false; }; }, [key, revision]);
  return { value: result.key === key ? result.value : null, error: result.key === key ? result.error : null, busy: result.key !== key || result.busy, refresh: useCallback(() => setRevision(value => value + 1), []) };
}
export function useLifecycleDeadline(deadline: string | null | undefined, expire: () => void) {
  const latest = useRef(expire); latest.current = expire;
  useEffect(() => {
    if (!deadline) return;
    let timer: ReturnType<typeof setTimeout>, ended = false;
    const check = () => { clearTimeout(timer); const remaining = Date.parse(deadline) - Date.now(); if (remaining <= 0) { if (!ended) { ended = true; latest.current(); } } else timer = setTimeout(check, Math.min(remaining + 5, 2_147_483_647)); };
    check(); window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { clearTimeout(timer); window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, [deadline]);
}
