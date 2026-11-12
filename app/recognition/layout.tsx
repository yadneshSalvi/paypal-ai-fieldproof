import type { Metadata } from "next";

export const metadata: Metadata = { title: "Public recognition, by choice", description: "A personal choice to share a self-declared label alongside currently permitted public project proof.", referrer: "no-referrer", robots: { index: false, follow: false } };
export default function RecognitionLayout({ children }: { children: React.ReactNode }) { return children; }
