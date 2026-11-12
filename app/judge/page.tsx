import type { Metadata } from "next";
import { JudgeLanding } from "@/components/judge/landing";
import { activeHeroReplay } from "@/lib/judge/hero-replay";
import { getSession } from "@/lib/server/auth";
import { judgeScenario } from "@/lib/server/judge";
import { projectSnapshot } from "@/lib/server/repository";
import "../judge.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Judge tour", description: "See Fieldproof's whole story in about a minute, in your own private Sample workspace. No signup." };

/** A missing, expired or revoked session simply renders the cold page: both buttons mint a fresh workspace. */
export default async function Page({ searchParams }: { searchParams: Promise<{ tour?: string }> }) {
  const autoStart = (await searchParams).tour === "1";
  const session = await getSession().catch(() => null);
  const scenario = await judgeScenario(session).catch(() => null);
  const shared = await projectSnapshot(null);
  const own = scenario && session ? await projectSnapshot(session).catch(() => null) : null;
  return <JudgeLanding initialScenario={scenario} packages={(own ?? shared).packages} replay={activeHeroReplay()} checkoutConfigured={shared.capabilities.checkoutConfigured} autoStart={autoStart} />;
}
