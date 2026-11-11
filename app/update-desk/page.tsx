import Link from "next/link";
import { getSession } from "@/lib/server/auth";
import { readCommunityDesk } from "@/lib/server/community";
import { UpdateDesk } from "@/components/community/update-desk";
import { CommunityEmpty, CommunityShell, RoleGate } from "@/components/community/shared";
export const dynamic="force-dynamic";
export default async function Page(){const session=await getSession();if(!session)return <CommunityShell projectId={null} title="THE PRIVATE UPDATE DESK" active="desk"><CommunityEmpty title="A clear update starts with your workspace."><p>Open your saved work or create a community template to draft from its exact source records.</p><Link className="button primary" href="/community?return=/update-desk">Open saved workspaces ↗</Link></CommunityEmpty></CommunityShell>;if(!["organizer","auditor"].includes(session.role))return <CommunityShell projectId={session.projectId} title="THE PRIVATE UPDATE DESK" active="desk"><RoleGate role={session.role} target="/update-desk"/></CommunityShell>;return <UpdateDesk initial={await readCommunityDesk(session)}/>;}
