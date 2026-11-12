"use client";

import { RefreshCw } from "lucide-react";
import { BoardPackEntry, BoardPackShell } from "@/components/board-pack/shared";
import "./board-pack.css";

export default function BoardPackError({ retry }: { error: unknown; retry: () => void }) {
  return <BoardPackShell><BoardPackEntry recovery title="The report could not be opened."><p>The saved editions have not changed. Try opening the report again, or return to your current workspace.</p><button type="button" className="bp-button bp-primary" onClick={retry}><RefreshCw size={16}/>Try again</button></BoardPackEntry></BoardPackShell>;
}
