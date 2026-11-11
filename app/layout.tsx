import type {Metadata} from "next";
import Link from "next/link";
import { fundingQaEnabled } from "@/lib/server/provider-access";
import "./globals.css";
import "./community.css";

export const metadata:Metadata={title:{default:"Fieldproof — Room for possibility",template:"%s · Fieldproof"},description:"A clear budget, a human review, and proof you can follow. Fieldproof connects community project contributions to their source evidence.",robots:{index:false,follow:false},icons:{icon:"/icon.svg"}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en" data-scroll-behavior="smooth"><body>{fundingQaEnabled()&&<aside className="funding-qa-banner" aria-label="Isolated Sample review"><span>Isolated funding review · fictional Sample records · providers disabled</span><Link href="/funding-qa">Change participant ↗</Link></aside>}{children}</body></html>;}
