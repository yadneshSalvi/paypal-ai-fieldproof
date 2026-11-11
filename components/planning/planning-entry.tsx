"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
export function PlanningEntry() {
  const router = useRouter(), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  async function open() {
    setBusy(true); setError(null);
    try {
      const existing = await fetch("/api/snapshot", { cache: "no-store" }); if (!existing.ok) throw new Error("The current workspace could not be checked.");
      const state = await existing.json();
      if (!state.session) {
        const created = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "sample" }) });
        if (!created.ok) { const value = await created.json(); throw new Error(value.error ?? "The sample workspace could not be opened."); }
        const role = await fetch("/api/session/role", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "organizer" }) });
        if (!role.ok) throw new Error("The organizer view could not be selected. Open your workspace and choose a current role.");
      }
      router.refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "This workspace could not be opened."); setBusy(false); }
  }
  return <div className="pl-entry-action"><button className="pl-button primary" disabled={busy} onClick={() => void open()}>{busy ? "Opening the planning desk…" : "Open a sample organizer desk"}<ArrowRight size={17}/></button><p>Explore a fictional source pack in your own private workspace. No payment is started.</p>{error && <p className="pl-warning" role="alert">{error}</p>}</div>;
}
