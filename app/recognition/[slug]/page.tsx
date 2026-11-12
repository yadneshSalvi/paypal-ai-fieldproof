import { notFound } from "next/navigation";
import { recognitionSlug } from "@/lib/recognition/contracts";
import { PublicRecognitionWall } from "@/components/recognition/public-wall";

export const dynamic = "force-dynamic";
export default async function RecognitionWallPage({ params }: { params: Promise<{ slug: string }> }) {
  const parsed = recognitionSlug.safeParse((await params).slug);
  if (!parsed.success) notFound();
  return <PublicRecognitionWall key={parsed.data} slug={parsed.data}/>;
}
