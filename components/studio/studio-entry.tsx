"use client";
import { adoptWorkspaceContext, workspaceFetch } from "@/lib/community/workspace-fetch";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Only rendered when the server has found no current workspace session. */
export function StudioEntry() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function openWorkspace() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      // A different tab may have opened a workspace since this page rendered.
      // Preserve that session instead of replacing it with an illustrative one.
      const current = await workspaceFetch("/api/snapshot", { cache: "no-store" });
      if (!current.ok) throw new Error("Your workspace could not be checked. Please try again.");
      const snapshot = await current.json();
      if (!snapshot.session) {
        const response = await workspaceFetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "sample" }) });
        if (!response.ok) { const result = await response.json(); throw new Error(result.error ?? "Your workspace could not be opened. Please try again."); }
        adoptWorkspaceContext((await response.json()).id);
      }
      router.refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Your workspace could not be opened. Please try again."); setBusy(false); }
  }
  return <div><button className="button primary" disabled={busy} onClick={() => void openWorkspace()}>{busy ? "Opening your workspace…" : "Open a sample workspace ↗"}</button>{error && <p role="alert">{error}</p>}<p>Explore illustrative records in your own private workspace. No payment is started.</p></div>;
}
