import Link from "next/link";
import { PlanningWorkspace, type PlanningSection } from "@/components/planning/planning-workspace";
import { PlanningEntry } from "@/components/planning/planning-entry";
import { getSession } from "@/lib/server/auth";
import { readPlanningWorkspace } from "@/lib/server/planning";
import { DomainError } from "@/lib/domain/money";
import "./planning.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "The planning desk", referrer: "no-referrer" as const };
export default async function PlanningPage({ searchParams }: { searchParams: Promise<{ section?: string }> }) {
  const session = await getSession();
  if (!session) return <main className="pl-entry"><Link href="/" className="wordmark">fieldproof<span className="brand-dot">.</span></Link><div className="pl-entry-body"><span className="pl-kicker">THE PLANNING DESK</span><h1>A place for<br/>every possibility<span>.</span></h1><p>Bring a rough sketch. Link the quotes. Shape a room that everyone can understand—and keep each decision attached to its source.</p><PlanningEntry/></div><div className="pl-entry-illustration" aria-hidden="true"><i/><i/><i/><i/><i/><i/><span>SKETCH → SOURCE → HUMAN REVIEW</span></div></main>;
  try {
    const workspace = await readPlanningWorkspace(session), requested = (await searchParams).section;
    const section = ["sources", "layout", "dependencies", "images", "review", "history"].includes(requested ?? "") ? requested as PlanningSection : "layout";
    return <PlanningWorkspace initial={workspace} initialSection={section}/>;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return <main className="pl-entry"><Link href="/" className="wordmark">fieldproof<span className="brand-dot">.</span></Link><div className="pl-entry-body"><span className="pl-kicker">CURRENT PROJECT ROLE REQUIRED</span><h1>This plan needs<br/>a current workspace.</h1><p>{error.message}</p><Link className="pl-button primary" href="/">Return to Fieldproof</Link></div></main>;
  }
}
