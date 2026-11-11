import Link from "next/link";
import { getSession } from "@/lib/server/auth";
import { fundingDesk } from "@/lib/server/funding-lifecycle";
import { FundingWorkspace } from "@/components/funding/workspace";
import { FundingEmpty, FundingShell } from "@/components/funding/shared";
import "./funding.css";
export const dynamic="force-dynamic";
export const metadata={title:"Your support, your say"};
export default async function Page(){const session=await getSession();if(!session)return <FundingShell projectId={null}><FundingEmpty title="Every contribution starts with a purpose."><p>Open your saved community workspace to make a pledge, follow your support, or choose what happens when a plan changes.</p><div className="fd-actions"><Link className="button primary" href="/community?return=/funding">Open saved workspaces ↗</Link><Link className="button secondary" href="/judge">Explore a Sample project</Link></div></FundingEmpty></FundingShell>;return <FundingWorkspace initial={await fundingDesk(session)}/>;}
