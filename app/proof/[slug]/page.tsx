import { readPublicProof } from "@/lib/server/proof";
import { PublicProofPage } from "@/components/proof/proof-page";
import "../proof.css";
export const dynamic = "force-dynamic";
export const metadata = { title: "A public proof record", referrer: "no-referrer" as const, robots: { index: false, follow: false } };
export default async function Page({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ revision?: string }> }) {
  const { slug } = await params, { revision } = await searchParams;
  const parsed = revision && /^[1-9][0-9]{0,5}$/.test(revision) ? Number(revision) : undefined;
  const proof = await readPublicProof(slug, parsed), base = process.env.APP_URL ?? "http://localhost:4102";
  return <PublicProofPage proof={proof} publicUrl={new URL(`/proof/${encodeURIComponent(slug)}`, base).href}/>;
}
