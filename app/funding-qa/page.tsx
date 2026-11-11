import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight, UserRound } from "lucide-react";
import { fundingQaActors } from "@/lib/server/funding-qa";
import { fundingQaEnabled } from "@/lib/server/provider-access";
import { FundingShell } from "@/components/funding/shared";
import "@/app/funding/funding.css";

export const dynamic="force-dynamic";
export const metadata={title:"Isolated funding review"};
export default function FundingQaPage(){
  if(!fundingQaEnabled())notFound();
  return <FundingShell projectId={null}><div className="fd-workspace"><section className="fd-hero"><div><p className="eyebrow">ISOLATED REVIEW · FICTIONAL RECORDS</p><h1>A shared purpose.<br/><span>A different view.</span></h1><p>Choose a participant to review the complete funding journey. Each has a separate saved identity and current permissions in this isolated Sample workspace.</p><p className="fd-small-note">Provider access is disabled. Sessions and decision windows keep their original expiry. This chooser does not exist in the hosted product.</p></div><div className="fd-blueprint"><p className="eyebrow">ONE TRAIL, SEVERAL PERSPECTIVES</p><h2 style={{fontSize:32,margin:"18px 0"}}>Donor → organizer → proof</h2><p style={{lineHeight:1.8}}>A saved promise becomes a clearly labelled Sample payment. A changed plan creates a donor decision. Every resulting purpose keeps the same original payment trail.</p></div></section><div className="fd-purpose-grid">{fundingQaActors().map(actor=><form method="post" action="/api/funding-qa" className="fd-purpose-card" key={actor.key}><input type="hidden" name="actor" value={actor.key}/><div className="fd-card-top"><UserRound size={25}/><span className="provenance sample">Sample actor</span></div><h3>{actor.label}</h3><p>{actor.detail}</p><button className="button primary" style={{marginTop:22}} type="submit">Open this view <ArrowUpRight size={16}/></button></form>)}</div><div className="fd-as-of"><Link href="/funding">Continue the active funding view ↗</Link></div></div></FundingShell>;
}
