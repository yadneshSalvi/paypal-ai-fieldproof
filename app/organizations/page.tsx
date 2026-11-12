import { OrganizationWorkspace } from "@/components/organizations/desk";

export const dynamic = "force-dynamic";
export const metadata = { title: "Organizations and portfolios", referrer: "no-referrer" as const, robots: { index: false, follow: false } };
export default function OrganizationsPage() { return <OrganizationWorkspace/>; }
