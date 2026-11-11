import Link from "next/link";
import { StudioWorkspace } from "@/components/studio/studio-workspace";
import { StudioEntry } from "@/components/studio/studio-entry";
import { getSession } from "@/lib/server/auth";
import { readStudioSnapshot } from "@/lib/server/studio-datasets";
import { readStudioReport } from "@/lib/server/studio-reports";
import { DomainError } from "@/lib/domain/money";
import "./studio.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "The proof studio" };
export default async function StudioPage() {
  const session = await getSession();
  if (!session) return <StudioUnavailable start title="A shared picture starts with your workspace." text="Explore the evidence, arrange a report, and build a shared view for the next board meeting."/>;
  try {
    const [snapshot, report] = await Promise.all([readStudioSnapshot(session), readStudioReport(session)]);
    return <StudioWorkspace initial={snapshot} report={report} license={process.env.AG_STUDIO_LICENSE_KEY ?? ""}/>;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return <StudioUnavailable title="This report needs a current workspace role." text={error.message}/>;
  }
}
function StudioUnavailable({ title, text, start = false }: { title: string; text: string; start?: boolean }) {
  return <main className="studio-entry"><Link href="/" className="wordmark">fieldproof<span className="brand-dot">.</span></Link><div><span className="eyebrow">THE PROOF STUDIO</span><h1>{title}</h1><p>{text}</p>{start ? <StudioEntry/> : <Link href="/" className="button primary">Open Fieldproof ↗</Link>}</div></main>;
}
