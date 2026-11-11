"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, LayoutDashboard, LockKeyhole } from "lucide-react";
import type { StudioSnapshot } from "@/lib/studio/contracts";
import type { StudioReportRecord } from "@/lib/studio/history";

const NativeStudio = dynamic(() => import("./native-studio").then(module => module.NativeStudio), {
  ssr: false,
  loading: () => <div className="studio-loading" role="status"><span className="studio-loading-mark"><LayoutDashboard size={25}/></span><h2>Opening the whole picture.</h2><p>Connecting your packages, money, and evidence.</p><div><i/><i/><i/></div></div>,
});
export function StudioWorkspace({ initial, report, license }: { initial: StudioSnapshot; report: StudioReportRecord; license?: string }) {
  return <main className="studio-workspace"><header className="studio-masthead"><Link href="/" className="wordmark">fieldproof<span className="brand-dot">.</span></Link><nav aria-label="Workspace navigation"><Link href="/project"><ArrowLeft size={14}/>The project</Link><Link href="/community?return=/studio">Saved workspaces</Link><Link href="/board-pack">Board Pack<ArrowUpRight size={13}/></Link></nav><span className="studio-private-label"><LockKeyhole size={12}/>Private workspace</span></header>
    <NativeStudio key={initial.scope} initial={initial} report={report} license={license}/>
  </main>;
}
