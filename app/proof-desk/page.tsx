import { WorkspaceScope } from "@/components/community/workspace-scope";
import Link from "next/link";
import { ProofDesk } from "@/components/proof/proof-desk";
import { PlanningEntry } from "@/components/planning/planning-entry";
import { getSession } from "@/lib/server/auth";
import { readProofDesk } from "@/lib/server/proof";
import { DomainError } from "@/lib/domain/money";
import "../proof/proof.css";
import "../planning/planning.css";
export const dynamic = "force-dynamic";
export const metadata = { title: "The publication desk", referrer: "no-referrer" as const };
export default async function Page() {
  const session = await getSession();
  if (!session) return <main className="pp-unavailable"><Link href="/" className="wordmark">fieldproof<span className="brand-dot">.</span></Link><div><p className="pp-kicker">THE PUBLICATION DESK</p><h1>A clear record.<br/>Carefully shared.</h1><p>Prepare redacted evidence and review the exact page before the community sees it.</p><PlanningEntry/></div></main>;
  try { return <><WorkspaceScope projectId={session.projectId}/><ProofDesk initial={await readProofDesk(session)}/></>; }
  catch (error) { if (!(error instanceof DomainError)) throw error; return <main className="pp-unavailable"><div><h1>Choose your organizer view.</h1><p>{error.message}</p><Link href="/organizer">Return to the workspace →</Link></div></main>; }
}
