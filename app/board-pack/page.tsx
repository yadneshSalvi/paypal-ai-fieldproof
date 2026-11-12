import { WorkspaceScope } from "@/components/community/workspace-scope";
import { BoardPackEntry, BoardPackShell } from "@/components/board-pack/shared";
import { BoardPackWorkspace } from "@/components/board-pack/workspace";
import { DomainError } from "@/lib/domain/money";
import { getSession } from "@/lib/server/auth";
import { readBoardPackDesk } from "@/lib/server/board-packs";
import "./board-pack.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "The Board Pack", referrer: "no-referrer" as const };

export default async function BoardPackPage() {
  const session = await getSession();
  if (!session) return <BoardPackShell><BoardPackEntry title="A clear record starts with your workspace."><p>Bring the plan, support, repayments and reviewed evidence together in a private, dated report.</p><p>Open your saved project with its current role to prepare an edition or read your report history.</p></BoardPackEntry></BoardPackShell>;
  try {
    const desk = await readBoardPackDesk(session);
    return <><WorkspaceScope projectId={session.projectId}/><BoardPackWorkspace key={desk.scope} initial={desk}/></>;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return <><WorkspaceScope projectId={session.projectId}/><BoardPackShell><BoardPackEntry recovery title="This report needs a current project role."><p>{error.message}</p><p>Reopen your saved workspace to check its current access.</p></BoardPackEntry></BoardPackShell></>;
  }
}
