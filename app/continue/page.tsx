import type { Metadata } from "next";
import { WorkspaceContinuation } from "@/components/workspace-continuation";
import { getSession } from "@/lib/server/auth";
import { applicationOrigin } from "@/lib/server/payments";
import { LOCAL_ORIGIN } from "@/lib/server/workspace-handoff";
import "./continuation.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Continue your workspace · Fieldproof", referrer: "no-referrer", robots: { index: false, follow: false } };
export default async function Page() {
  const session = await getSession();
  return <WorkspaceContinuation local={applicationOrigin() === LOCAL_ORIGIN} canPrepare={session?.role === "organizer" && session.mode === "live_sandbox"}/>;
}
