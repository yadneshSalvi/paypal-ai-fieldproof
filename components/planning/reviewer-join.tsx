"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { CheckField, planningRequest } from "./ui";

export function ReviewerJoin() {
  const router = useRouter(), [token, setToken] = useState<string | null>(null), [nonce, setNonce] = useState<string | null>(null), [ready, setReady] = useState(false), [acknowledged, setAcknowledged] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get("invite");
    if (value && /^[A-Za-z0-9_-]{64}$/.test(value)) {
      setToken(value);
      const key = `fieldproof-reviewer-claim:${value.slice(0, 8)}`;
      let saved = ""; try { saved = sessionStorage.getItem(key) ?? ""; } catch { /* In-memory retries still work. */ }
      const next = /^[0-9a-f-]{36}$/.test(saved) ? saved : crypto.randomUUID(); setNonce(next);
      try { sessionStorage.setItem(key, next); } catch { /* The link remains usable without browser storage. */ }
    }
    setReady(true);
  }, []);
  async function join() {
    if (!token || !nonce || !acknowledged || busy) return;
    setBusy(true); setError(null);
    try { await planningRequest("reviewers/redeem", { token, redemptionNonce: nonce, acknowledged: true }); history.replaceState(null, "", "/planning/join"); setToken(null); router.replace("/planning?section=review"); router.refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "This private invitation could not be claimed."); setBusy(false); }
  }
  return <main className="pl-entry"><Link href="/" className="wordmark">fieldproof<span className="brand-dot">.</span></Link><div className="pl-entry-body"><span className="pl-kicker">PRIVATE REVIEWER INVITATION</span><h1>A specific role.<br/>A careful review.</h1><p>This invitation opens a temporary volunteer session for one project. You can submit your own supporting sources and request the named competences; an organizer must verify them before you can sign off physical work.</p>{!ready ? <p role="status">Checking this private link…</p> : !token ? <p className="pl-warning">This invitation has no valid access fragment. Ask the organizer for the complete current link.</p> : <><div className="pl-paper pl-form"><CheckField checked={acknowledged} onChange={setAcknowledged}>I am the intended reviewer. Open this project’s 12-hour volunteer session in this browser, replacing any currently selected workspace session.</CheckField><button className="pl-button primary" disabled={busy || !acknowledged || !nonce} onClick={() => void join()}>{busy ? "Opening the reviewer workspace…" : "Join the private review workspace"}<ArrowRight size={17}/></button></div><p className="pl-private-note"><LockKeyhole size={15}/><span>The issuer cannot claim their own link. Possession of a link is not proof of professional competence; source credentials still require independent review.</span></p></>}{error && <p className="pl-warning" role="alert">{error}</p>}</div></main>;
}
