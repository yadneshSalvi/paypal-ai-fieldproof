"use client";
import Link from "next/link";
import { SupporterNotice, SupporterShell } from "@/components/supporters/shared";
import "../supporters/supporters.css";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <SupporterShell><h1 className="sp-entry-title">One moment, please.</h1><SupporterNotice title="Your invitation page could not open." error>Try the page again. A saved acceptance will reuse its original request and access deadline.</SupporterNotice><div className="sp-inline-actions"><button className="button primary" onClick={reset}>Try again</button><Link className="button secondary" href="/community">Saved workspaces</Link></div></SupporterShell>;
}
