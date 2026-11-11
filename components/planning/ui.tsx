"use client";

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { Check, Clock3, LockKeyhole, X } from "lucide-react";
import type { PlanningWorkspace } from "@/lib/planning/contracts";

export class PlanningRequestError extends Error { constructor(message: string, readonly code: string, readonly status: number) { super(message); } }
export async function planningRequest<T>(path = "", body?: unknown): Promise<T> {
  const response = await fetch(`/api/planning${path ? `/${path}` : ""}`, { cache: "no-store", ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new PlanningRequestError(result.error ?? "The planning workspace could not finish this step.", result.code ?? "REQUEST_UNAVAILABLE", response.status);
  return result as T;
}
export type MutationOptions = { intent?: boolean; label?: string };
export type Mutate = <T = { workspace: PlanningWorkspace }>(path: string, body: Record<string, unknown>, options?: MutationOptions) => Promise<T>;
export interface PlanningContextValue { workspace: PlanningWorkspace; busy: string | null; mutate: Mutate; reload: () => Promise<PlanningWorkspace>; notify: (message: string, error?: boolean) => void; }
export const PlanningContext = createContext<PlanningContextValue | null>(null);
export function usePlanning() { const context = useContext(PlanningContext); if (!context) throw new Error("Planning context is unavailable."); return context; }
export const usd = (minor: number | null) => minor === null ? "Cost needs review" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100);
export const dateTime = (value: string) => `${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value))} UTC`;
export const shortHash = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-6)}`;
export const zoneColors = ["#4a6fa5", "#66855c", "#b58a30", "#b77a60", "#8b7ca0", "#5b8c8b"];
export function Status({ state, children }: { state?: "good" | "warm" | "muted" | "danger"; children: ReactNode }) { return <span className={`pl-status ${state ?? "muted"}`}>{state === "good" ? <Check size={12}/> : state === "warm" ? <Clock3 size={12}/> : null}{children}</span>; }
export function EmptyState({ eyebrow, title, children, action }: { eyebrow?: string; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="pl-empty"><div className="pl-empty-mark" aria-hidden="true">+</div>{eyebrow && <span className="pl-kicker">{eyebrow}</span>}<h2>{title}</h2><div className="pl-muted">{children}</div>{action && <div className="pl-actions">{action}</div>}</div>;
}
export function PrivateNote({ children }: { children: ReactNode }) { return <p className="pl-private-note"><LockKeyhole size={14}/><span>{children}</span></p>; }
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; if (!dialog) return; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className={`pl-modal ${wide ? "wide" : ""}`} onCancel={event => { event.preventDefault(); onClose(); }} aria-label={title}>
    <div className="pl-modal-head"><h2>{title}</h2><button type="button" className="pl-icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></div>{children}
  </dialog>;
}
export function CheckField({ checked, onChange, children, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return <label className="pl-check"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)}/><span>{children}</span></label>;
}
export function HashLine({ label, value }: { label: string; value: string }) { return <div className="pl-hash"><span>{label}</span><code title={value}>{shortHash(value)}</code></div>; }
export function downloadPrivateJson(value: unknown, filename: string) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
