"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, RefreshCw, Sprout } from "lucide-react";
import { recognitionPublicPageSchema, type RecognitionPublicPage } from "@/lib/recognition/contracts";
import { recognitionDate, recognitionFetch, RecognitionRequestError } from "@/lib/recognition/client";
import { PublicRecognitionLink, RecognitionNotice, RecognitionPrivacyNote, RecognitionShell } from "./shared";
import styles from "./recognition.module.css";

export function PublicRecognitionWall({ slug }: { slug: string }) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]), [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ slug: string; cursor: string | undefined; page: RecognitionPublicPage } | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(true);
  const cursor = cursors.at(-1), page = result?.slug === slug && result.cursor === cursor ? result.page : null;
  useEffect(() => {
    let disposed = false, serial = 0, reading = false, controller: AbortController | null = null;
    let poll: ReturnType<typeof setTimeout> | undefined, expiry: ReturnType<typeof setTimeout> | undefined;
    setResult(null); setError(""); setBusy(true);
    async function load() {
      if (disposed || reading || document.visibilityState === "hidden") return;
      reading = true; const current = ++serial; controller = new AbortController(); const owned = controller;
      const timeout = setTimeout(() => owned.abort(), 4_000);
      try {
        const data = await recognitionFetch(`/api/public-recognition/${slug}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, recognitionPublicPageSchema, { signal: owned.signal });
        if (disposed || current !== serial) return;
        const remaining = Math.min(5_000, Date.parse(data.validUntil) - Date.now());
        if (data.slug !== slug || remaining <= 0) throw new Error("This permission check expired before it arrived. Reload the wall.");
        setResult({ slug, cursor, page: data }); setError("");
        clearTimeout(expiry); expiry = setTimeout(() => { if (!disposed) setResult(null); }, remaining);
        poll = setTimeout(() => void load(), 4_000);
      } catch (failure) {
        if (disposed || current !== serial) return;
        setResult(null);
        if (failure instanceof RecognitionRequestError && failure.code === "RECOGNITION_PAGE_CHANGED" && cursor) setCursors([undefined]);
        else setError(failure instanceof RecognitionRequestError ? failure.message : "The current choices could not be checked. Names stay hidden until a fresh check succeeds.");
      } finally { clearTimeout(timeout); if (current === serial) { reading = false; setBusy(false); } }
    }
    function hide() { serial++; reading = false; controller?.abort(); clearTimeout(poll); clearTimeout(expiry); setResult(null); }
    function visibility() { if (document.visibilityState === "hidden") hide(); else void load(); }
    const show = () => { hide(); void load(); };
    document.addEventListener("visibilitychange", visibility); window.addEventListener("pagehide", hide); window.addEventListener("pageshow", show);
    void load();
    return () => { disposed = true; serial++; controller?.abort(); clearTimeout(poll); clearTimeout(expiry); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", show); };
  }, [slug, cursor, retry]);
  return <RecognitionShell publicView><section className={styles.hero}><span className={styles.eyebrow}>THE PEOPLE, BY CHOICE</span><h1>A little recognition.<br/><em>A personal choice.</em></h1><p>People who chose to share a label alongside this project’s public proof. Every name has its own permission.</p></section>
    <div className={styles.publicGrid}><section className={styles.wall} aria-labelledby="recognition-wall-heading" aria-busy={busy}><header className={styles.sectionHeader}><div><span className={styles.eyebrow}>SHARED WITH PERMISSION</span><h2 id="recognition-wall-heading">Room for the people behind it.</h2></div><Sprout size={32} aria-hidden="true"/></header>
      {error && <RecognitionNotice error><p>{error}</p><button className={styles.secondary} type="button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={16}/>Check current wall</button></RecognitionNotice>}
      {!error && !page && <RecognitionNotice><p>{busy ? "Checking the current public page and each original choice…" : "Checking current choices. Names stay hidden until permission is confirmed."}</p></RecognitionNotice>}
      {page?.state === "unavailable" && <div className={styles.empty}><span className={styles.emptyMark} aria-hidden="true">↗</span><h3>This space is private for now.</h3><p>The project’s public proof is unavailable or under review. Names stay hidden with it.</p></div>}
      {page?.state === "available" && !page.entries.length && <div className={styles.empty}><Sprout size={44} aria-hidden="true"/><h3>Space to join, never an obligation.</h3><p>No public labels appear on this page right now. Participation does not depend on sharing a name.</p></div>}
      {page?.state === "available" && !!page.entries.length && <ul className={styles.nameGrid} aria-label="Participants sharing a label">{page.entries.map((entry, index) => <li key={`${page.observedAt}:${index}`}><span className={styles.nameMark} aria-hidden="true">✳</span><strong>{entry.label}</strong><span>{entry.provenance === "sample_self_declared" ? "Sample · self-declared" : "Self-declared"}</span></li>)}</ul>}
      {page?.state === "available" && <nav className={styles.pagination} aria-label="Recognition wall pages"><button className={styles.secondary} type="button" disabled={busy || cursors.length < 2} onClick={() => setCursors(value => value.slice(0, -1))}><ArrowLeft size={17}/>Previous</button><span aria-live="polite">Page {cursors.length}</span><button className={styles.secondary} type="button" disabled={busy || !page.nextCursor} onClick={() => page.nextCursor && setCursors(value => [...value, page.nextCursor!])}>Next<ArrowRight size={17}/></button></nav>}
      {page && <p className={styles.timestamp}>Current choices checked {recognitionDate(page.observedAt)}. Open pages check again at least every five seconds.</p>}
    </section><aside className={styles.aside}><div className={styles.annotation}><span>01 / THE CHOICE IS YOURS</span><h2>People first.<br/>Privacy, always.</h2><p>There is no payment threshold and no ranking. A public label does not verify someone’s identity or a donation.</p><Link href={`/proof/${slug}`} className={styles.textLink}>Read the project’s public proof <ArrowRight size={17}/></Link></div><PublicRecognitionLink href={`/recognition/${slug}`}/><RecognitionPrivacyNote/></aside></div>
  </RecognitionShell>;
}
