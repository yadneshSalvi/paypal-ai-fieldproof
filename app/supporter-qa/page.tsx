import Link from "next/link";
import { notFound } from "next/navigation";
import { SupporterQaChooser } from "@/components/community/supporter-qa-chooser";
import { supporterQaActors } from "@/lib/server/supporter-qa";
import { supporterQaEnabled } from "@/lib/server/provider-access";
import { CommunityShell } from "@/components/community/shared";
import "@/app/funding/funding.css";

export const dynamic="force-dynamic";
export const metadata={title:"Isolated supporter story review"};
export default function SupporterQaPage(){
  if(!supporterQaEnabled())notFound();
  return <CommunityShell projectId={null} title="ISOLATED SUPPORTER REVIEW" active="updates"><div className="fd-workspace"><section className="fd-hero"><div><p className="eyebrow">ISOLATED REVIEW · FICTIONAL RECORDS</p><h1>A shared idea.<br/><span>Your place in it.</span></h1><p>Choose a saved participant to read their contribution, follow its original source, and see the scope of the available evidence.</p><p className="fd-small-note">Provider access is disabled. These fixed sessions keep their original expiry. The chooser is confined to this local Sample review.</p></div><div className="fd-blueprint"><p className="eyebrow">ONE ORIGINAL, A CONNECTED STORY</p><h2 style={{fontSize:32,margin:"18px 0"}}>Payment → purpose → proof</h2><p style={{lineHeight:1.8}}>An accounting share keeps the payment’s original rail, each saved decision, and the exact budget version. It does not claim real physical work or a fluent human review.</p></div></section><SupporterQaChooser actors={supporterQaActors().map(({key,label,detail})=>({key,label,detail}))}/><div className="fd-as-of"><Link href="/updates">Continue the current private story ↗</Link></div></div></CommunityShell>;
}
