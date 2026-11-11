import { ReviewerJoin } from "@/components/planning/reviewer-join";
import "../planning.css";
export const dynamic = "force-dynamic";
export const metadata = { title: "Private reviewer invitation", referrer: "no-referrer" as const };
export default function ReviewerJoinPage() { return <ReviewerJoin/>; }
