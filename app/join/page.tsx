import { SupporterRecipient } from "@/components/supporters/recipient";
import "../supporters/supporters.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your private invitation", referrer: "no-referrer" as const, robots: { index: false, follow: false } };
export default function Page() { return <SupporterRecipient/>; }
