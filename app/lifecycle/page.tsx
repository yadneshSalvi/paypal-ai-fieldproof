import { LifecycleWorkspace } from "@/components/lifecycle/workspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "Private lifecycle inbox and scheduled drafts", referrer: "no-referrer" as const, robots: { index: false, follow: false } };
export default function LifecyclePage() { return <LifecycleWorkspace/>; }
