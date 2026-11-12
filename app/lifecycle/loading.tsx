import { LifecycleShell } from "@/components/lifecycle/shared";

export default function LifecycleLoading() { return <LifecycleShell><section className="lc-empty" role="status" aria-busy="true"><span className="lc-kicker">Private lifecycle</span><h1>Checking the current profiles…</h1><p>Your private sources appear only after their current authority is checked.</p></section></LifecycleShell>; }
