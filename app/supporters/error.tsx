"use client";
import Link from "next/link";
import { SupporterNotice, SupporterShell } from "@/components/supporters/shared";
import "./supporters.css";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <SupporterShell organizer><h1 className="sp-entry-title">Let’s check your access.</h1><SupporterNotice title="The invitation desk could not open." error>Your access may have changed, or the project may be temporarily busy. Check the current workspace before trying again.</SupporterNotice><div className="sp-inline-actions"><button className="button primary" onClick={reset}>Check again</button><Link className="button secondary" href="/community">Saved workspaces</Link></div></SupporterShell>;
}
