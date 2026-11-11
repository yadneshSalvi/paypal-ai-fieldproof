"use client";
import { workspaceFetch } from "@/lib/community/workspace-fetch";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, FileCheck2, LockKeyhole, LoaderCircle, ShieldCheck } from "lucide-react";

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await workspaceFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "The workspace could not continue yet. Your original records remain saved.");
  return value;
}
export function WorkspaceContinuation({ local, canPrepare }: { local: boolean; canPrepare: boolean }) {
  const token = useRef<string | null>(null);
  const [hasToken, setHasToken] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null), [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get("handoff");
    if (value && /^[A-Za-z0-9_-]{43}$/.test(value)) { token.current = value; setHasToken(true); }
    // The capability stays in memory; it is never sent in a URL or persisted in browser storage.
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  }, []);
  async function act() {
    setBusy(true); setError(null);
    try {
      if (local) setLink(await post("/api/workspace/prepare-continuation", { acknowledged: true }));
      else {
        if (!token.current) throw new Error("Open the one-use link prepared in your original workspace.");
        await post("/api/workspace/continue", { token: token.current });
        token.current = null;
        window.location.replace("/my-expenses");
      }
    } catch (value) { setError(value instanceof Error ? value.message : "The continuation could not finish."); }
    finally { setBusy(false); }
  }
  return <main className="continuation-page"><header><Link href="/" className="wordmark">fieldproof<span className="brand-dot">.</span></Link><span><LockKeyhole size={14}/>PRIVATE WORKSPACE</span></header>
    <section className="continuation-card"><div className="continuation-mark"><FileCheck2 size={42} strokeWidth={1.25}/><span><Check size={17}/></span></div><p className="eyebrow">PICK UP WHERE YOU LEFT OFF</p><h1>The same work.<br/>A new place to continue.</h1><p className="continuation-lede">Your source documents, reviewed expenses and confirmed contributions belong together. This continuation keeps them in the same project.</p>
      <div className="continuation-promises"><p><ShieldCheck size={19}/><span>Your existing participant and private access</span></p><p><FileCheck2 size={19}/><span>The original sources and every recorded review</span></p><p><LockKeyhole size={19}/><span>The same payment identities and collection deadline</span></p></div>
      {local ? canPrepare ? <><p className="continuation-note">An operator transfers the private project before you follow this link. Preparing a link does not copy the project or send money.</p>{!link && <label className="continuation-check"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)}/><span>Prepare a private, one-use continuation for this workspace.</span></label>}{link ? <div className="continuation-ready"><strong><Check size={17}/>Your continuation is ready.</strong><p>After the operator verifies the transfer, continue before {new Date(link.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Keep this page open until then.</p><a className="button primary" href={link.url} referrerPolicy="no-referrer">Continue in the hosted workspace<ArrowUpRight size={17}/></a></div> : <button className="button primary" disabled={busy || !acknowledged} onClick={() => void act()}>{busy ? <LoaderCircle className="spin" size={17}/> : <ArrowRight size={17}/>}Prepare continuation</button>}</> : <p className="continuation-note">Return to your original live sandbox workspace and choose the Organizer view to prepare its continuation.</p> : <><p className="continuation-note">Continuing replaces this browser’s workspace access with the original participant’s session. Its expiry and permissions stay the same.</p><button className="button primary" disabled={!hasToken || busy} onClick={() => void act()}>{busy ? <LoaderCircle className="spin" size={17}/> : <ArrowRight size={17}/>}Continue my original workspace</button>{!hasToken && <p>Open the private continuation link from your original workspace. This page alone does not grant project access.</p>}</>}
      {error && <div className="continuation-error" role="alert">{error}</div>}<footer><LockKeyhole size={13}/>The link can be used once. No payment is made by this step.</footer>
    </section><Link href="/my-expenses" className="text-button">Return to my current expenses<ArrowRight size={15}/></Link></main>;
}
