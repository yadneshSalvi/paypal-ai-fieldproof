"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Copy, HeartHandshake, LockKeyhole, X } from "lucide-react";
import styles from "./recognition.module.css";

export function RecognitionShell({ children, publicView = false }: { children: ReactNode; publicView?: boolean }) {
  return <div className={styles.shell}><a className={styles.skip} href="#recognition-content">Skip to content</a>
    <header className={styles.header}><Link className={styles.brand} href="/">fieldproof<span>.</span></Link><span className={styles.caption}>A place for people.<br/>Good work, shared carefully.</span>
      <Link className={styles.back} href={publicView ? "/recognition" : "/community"}><ArrowLeft size={17}/>{publicView ? "My recognition choices" : "Saved workspaces"}</Link></header>
    <main id="recognition-content" className={styles.main}>{children}</main>
    <footer className={styles.footer}><HeartHandshake size={20}/><span>Participation is personal.<br/>Sharing a name is always a choice.</span><span>Fieldproof · community project journal</span></footer>
  </div>;
}
export function RecognitionNotice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`${styles.notice}${error ? ` ${styles.error}` : ""}`} role={error ? "alert" : "status"}>{children}</div>;
}
export function RecognitionPrivacyNote() {
  return <p className={styles.privacy}><LockKeyhole size={17}/><span>Your private profile, contact details and payments stay separate. A shared label is self-declared and does not verify identity, payment or physical work.</span></p>;
}
export function RecognitionDialog({ title, children, close, busy = false }: { title: string; children: ReactNode; close: () => void; busy?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null, element = dialog.current;
    element?.showModal(); heading.current?.focus();
    return () => { element?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="recognition-dialog-title" onCancel={event => { event.preventDefault(); if (!busy) closeRef.current(); }}>
    <div className={styles.dialogInner}><header><h2 id="recognition-dialog-title" tabIndex={-1} ref={heading}>{title}</h2><button className={styles.iconButton} aria-label="Close review" type="button" disabled={busy} onClick={close}><X size={20}/></button></header>{children}</div>
  </dialog>;
}
export function PublicRecognitionLink({ href }: { href: string }) {
  const [url, setUrl] = useState(href), [notice, setNotice] = useState(""); const field = useRef<HTMLInputElement>(null);
  useEffect(() => { setUrl(new URL(href, window.location.origin).href); setNotice(""); }, [href]);
  async function copy() { try { if (!navigator.clipboard) throw Error(); await navigator.clipboard.writeText(url); setNotice("Public wall link copied."); }
    catch { field.current?.focus(); field.current?.select(); setNotice("Select and copy this public address."); } }
  return <div className={styles.share}><label htmlFor="recognition-public-link">Public wall address</label><div><input ref={field} id="recognition-public-link" readOnly value={url}/><button className={styles.secondary} onClick={() => void copy()} type="button"><Copy size={16}/>Copy link</button></div><span role="status">{notice || "This address contains no private access token."}</span></div>;
}
