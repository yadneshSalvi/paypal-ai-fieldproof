"use client";
import { useEffect, useState } from "react";
import { bindWorkspaceContext, workspaceTabIdentity } from "@/lib/community/workspace-fetch";
export function WorkspaceScope({ projectId }: { projectId: string | null }) {
  bindWorkspaceContext(projectId);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    const channel = new BroadcastChannel("fieldproof-workspace-changed");
    channel.onmessage = event => { if(event.data?.origin===workspaceTabIdentity())return;setChanged(true); window.location.replace("/community"); };
    return () => channel.close();
  }, []);
  return changed ? <div className="cm-workspace-changed" role="alert">The active workspace changed. Opening your saved workspaces…</div> : null;
}
