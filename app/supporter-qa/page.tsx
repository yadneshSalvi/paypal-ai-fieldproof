import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight, UserRound } from "lucide-react";
import { supporterQaActors } from "@/lib/server/supporter-qa";
import { supporterQaEnabled } from "@/lib/server/provider-access";
import { CommunityShell } from "@/components/community/shared";
import "@/app/funding/funding.css";

export const dynamic="force-dynamic";
export const metadata={title:"Isolated supporter story review"};
export default function SupporterQaPage(){
  if(!supporterQaEnabled())notFound();
  return <CommunityShell projectId={null} title="ISOLATED SUPPORTER REVIEW" active="updates"><div className="fd-workspace"><section className="fd-hero"><div><p className="eyebrow">ISOLATED REVIEW · FICTIONAL RECORDS</p><h1>A shared idea.<br/><span>Your place in it.</span></h1><p>Choose a saved participant to read their contribution, follow its original source, and see the scope of the available evidence.</p><p className="fd-small-note">Provider access is disabled. These fixed sessions keep their original expiry. The chooser is confined to this local Sample review.</p></div><div className="fd-blueprint"><p className="eyebrow">ONE ORIGINAL, A CONNECTED STORY</p><h2 style={{fontSize:32,margin:"18px 0"}}>Payment → purpose → proof</h2><p style={{lineHeight:1.8}}>An accounting share keeps the payment’s original rail, each saved decision, and the exact budget version. It does not claim real physical work or a fluent human review.</p></div></section><div className="fd-purpose-grid">{supporterQaActors().map(actor=><form method="post" action="/api/supporter-qa" className="fd-purpose-card" key={actor.key}><input type="hidden" name="actor" value={actor.key}/><div className="fd-card-top"><UserRound size={25}/><span className="provenance sample">Sample actor</span></div><h3>{actor.label}</h3><p>{actor.detail}</p><button className="button primary" style={{marginTop:22}} type="submit">Read this story<ArrowUpRight size={16}/></button></form>)}</div><div className="fd-as-of"><Link href="/updates">Continue the current private story ↗</Link></div></div></CommunityShell>;
}
