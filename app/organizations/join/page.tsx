import { OrganizationRecipient } from "@/components/organizations/entry";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your private organization invitation", referrer: "no-referrer" as const, robots: { index: false, follow: false } };
export default function OrganizationEntryPage() { return <OrganizationRecipient/>; }
