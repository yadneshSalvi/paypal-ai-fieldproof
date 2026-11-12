"use client";

import { useState, type FormEvent } from "react";
import { ArrowUpRight, UserRound } from "lucide-react";
import { openWorkspace } from "@/lib/community/workspace-fetch";

type SavedActor = { key: string; label: string; detail: string };

export function SupporterQaChooser({ actors }: { actors: SavedActor[] }) {
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ actor: string; message: string } | null>(null);

  async function select(event: FormEvent<HTMLFormElement>, actor: string) {
    event.preventDefault();
    if (pending) return;
    setPending(actor);
    setFailure(null);
    try {
      const response = await fetch("/api/supporter-qa", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        body: new URLSearchParams({ actor }),
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "This saved participant could not be opened.");
      if (result.next !== "/updates") throw new Error("The saved story destination could not be confirmed.");
      openWorkspace(result.next);
    } catch (cause) {
      setFailure({ actor, message: cause instanceof Error ? cause.message : "This saved participant could not be opened. Try again." });
      setPending(null);
    }
  }

  return <div className="fd-purpose-grid">{actors.map(actor => <form className="fd-purpose-card" key={actor.key} onSubmit={event => void select(event, actor.key)} aria-busy={pending === actor.key}>
    <div className="fd-card-top"><UserRound size={25}/><span className="provenance sample">Sample actor</span></div>
    <h3>{actor.label}</h3><p>{actor.detail}</p>
    {failure?.actor === actor.key ? <p role="alert">{failure.message}</p> : null}
    <button className="button primary" style={{ marginTop: 22 }} type="submit" disabled={pending !== null}>{pending === actor.key ? "Opening this story…" : "Read this story"}<ArrowUpRight size={16}/></button>
  </form>)}</div>;
}
