import type { NextConfig } from "next";

const config: NextConfig = {
  // This repository can be checked out below a larger workspace with other
  // lockfiles. Keep this project's build and dependency traces inside its root.
  outputFileTracingRoot: process.cwd(),
  turbopack: { root: process.cwd() },
  reactStrictMode: true,
  ...(process.env.NODE_ENV !== "production" && process.env.FIELDPROOF_COMMUNITY_QA === "true" ? { distDir: ".next-community-qa" } : {}),
  ...(!process.env.VERCEL && process.env.FIELDPROOF_COMMUNITY_BUILD === "true" ? { distDir: ".next-community-build" } : {}),
  ...(process.env.NODE_ENV !== "production" && process.env.FIELDPROOF_PLANNING_QA === "true" ? { distDir: ".next-planning-qa" } : {}),
  ...(!process.env.VERCEL && process.env.FIELDPROOF_PLANNING_BUILD === "true" ? { distDir: ".next-planning-build" } : {}),
  poweredByHeader: false,
  logging: { incomingRequests: { ignore: [/\/api\/auth\//, /\/sandbox/] }, browserToTerminal: false, serverFunctions: false },
  serverExternalPackages: ["@fracture/paypal-core", "paypal", "pg", "pdfjs-dist", "@napi-rs/canvas", "sharp"],
  outputFileTracingIncludes: {
    "/api/*": ["./public/samples/outlined/*.svg", "./public/proof-stamps/*.svg"],
  },
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
      { key: "X-Frame-Options", value: "DENY" },
    ] }, { source: "/proof/:slug", headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }, { key: "Referrer-Policy", value: "no-referrer" }] },
      ...["/api/community/:path*", "/api/snapshot", "/api/session/:path*", "/api/pledges", "/api/tour", "/updates", "/my-contribution", "/supporter-qa", "/api/supporter-qa", "/supporters", "/join", "/api/supporters/:path*", "/organizations/:path*", "/api/organizations/:path*"].map(source=>({source,headers:[{key:"Cache-Control",value:"private, no-store, max-age=0"},{key:"Referrer-Policy",value:"no-referrer"}]}))];
  },
};
export default config;
