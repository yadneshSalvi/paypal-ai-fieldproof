import { RecognitionDesk } from "@/components/recognition/recognition-desk";
import { recognitionSlug } from "@/lib/recognition/contracts";

export const dynamic = "force-dynamic";
export default async function RecognitionPage({ searchParams }: { searchParams: Promise<{ slug?: string }> }) {
  const value = (await searchParams).slug, parsed = recognitionSlug.safeParse(value);
  return <RecognitionDesk initialSlug={parsed.success ? parsed.data : undefined}/>;
}
