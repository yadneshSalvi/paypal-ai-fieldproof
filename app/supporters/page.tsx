import Link from "next/link";
import { getSession } from "@/lib/server/auth";
import { supporterDesk } from "@/lib/server/supporter-access";
import { SupporterManager } from "@/components/supporters/manager";
import { SupporterShell } from "@/components/supporters/shared";
import "./supporters.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Invite your supporters", referrer: "no-referrer" as const };
export default async function Page() {
  const session = await getSession();
  if (!session || session.role !== "organizer") return <SupporterShell><section className="sp-card"><p className="sp-eyebrow">PROJECT INVITATIONS</p><h1 className="sp-entry-title">A welcome from<br/>the organizer.</h1><p>Current organizers can invite donors and sponsors into their project. If someone has invited you, open the complete private link they shared.</p><div className="sp-inline-actions"><Link className="button primary" href="/community">Open saved workspaces</Link><Link className="button secondary" href="/funding">My support</Link></div></section></SupporterShell>;
  return <SupporterManager initial={await supporterDesk(session)}/>;
}
