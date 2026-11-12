"use client";

import { LifecycleShell, Notice } from "@/components/lifecycle/shared";

export default function LifecycleError({ retry }: { error: unknown; retry: () => void }) { return <LifecycleShell><Notice title="The lifecycle view could not be opened" error><p>Check the current view again. If a prior decision had an interrupted response, keep its original saved request; refreshing does not cancel an action that already committed.</p><button type="button" className="lc-button" onClick={retry}>Try current view again</button><p><a href="/community?return=/lifecycle">Saved project workspaces</a> · <a href="/organizations">Organizations</a></p></Notice></LifecycleShell>; }
