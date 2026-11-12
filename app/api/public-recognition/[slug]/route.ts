import { publicRecognitionGet } from "@/lib/server/recognition-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  return publicRecognitionGet(request, (await context.params).slug);
}
