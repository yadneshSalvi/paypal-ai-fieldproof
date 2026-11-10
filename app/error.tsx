"use client";
import Link from "next/link";
export default function ErrorPage({reset}:{error:Error&{digest?:string};reset:()=>void}){return <main className="error-page"><p className="eyebrow">THE RECORD IS STILL THERE</p><h1>We couldn't open the latest project state.</h1><p>The connection may have been interrupted. Reloading checks the existing record. It does not create or retry a payment.</p><button className="button primary" onClick={reset}>Try loading again</button><Link className="button secondary" href="/">Return to the project</Link></main>;}
