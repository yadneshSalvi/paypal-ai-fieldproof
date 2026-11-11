import type {Metadata} from "next";
import "./globals.css";
import "./community.css";

export const metadata:Metadata={title:{default:"Fieldproof — Room for possibility",template:"%s · Fieldproof"},description:"A clear budget, a human review, and proof you can follow. Fieldproof connects community project contributions to their source evidence.",robots:{index:false,follow:false},icons:{icon:"/icon.svg"}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en" data-scroll-behavior="smooth"><body>{children}</body></html>;}
