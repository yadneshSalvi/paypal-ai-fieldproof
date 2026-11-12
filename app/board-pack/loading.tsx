import { BookOpen, RefreshCw } from "lucide-react";
import { BoardPackShell } from "@/components/board-pack/shared";
import "./board-pack.css";

export default function BoardPackLoading() {
  return <BoardPackShell><section className="bp-route-loading" role="status" aria-busy="true"><BookOpen size={42} strokeWidth={1}/><p className="bp-kicker">THE BOARD PACK</p><h1>Preparing your project record.</h1><p>Checking your workspace role and saved report editions.</p><span><RefreshCw size={17} className="bp-spin"/>Opening the current record…</span></section></BoardPackShell>;
}
