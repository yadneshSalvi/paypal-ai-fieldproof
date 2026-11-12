import type { NextConfig } from "next";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import toolkitTrace from "./config/toolkit-runtime-trace.json";

// Native Toolkit dispatch uses a private CommonJS factory. Next cannot infer
// its requires, so retain the qualified complete closure for this route only.
const root = realpathSync(process.cwd());
const digest = (filename: string) => createHash("sha256").update(readFileSync(resolve(root, filename))).digest("hex");
if (toolkitTrace.format !== "fieldproof.toolkit-native-trace/v1" || digest("package-lock.json") !== toolkitTrace.packageLockSha256
  || digest(toolkitTrace.toolkit.entry) !== toolkitTrace.toolkit.entrySha256
  || new Set(toolkitTrace.files).size !== toolkitTrace.files.length || !toolkitTrace.files.includes(toolkitTrace.toolkit.entry)) {
  throw new Error("The qualified Toolkit dependency trace changed. Regenerate and qualify its exact locked closure before building.");
}
const toolkitFiles = toolkitTrace.files.map(filename => {
  if (!filename.startsWith("node_modules/") || filename.includes("\\") || filename.split("/").some(part => part === ".." || !part)
    || /[*?\[\]{}!]/.test(filename) || !statSync(resolve(root, filename)).isFile()
    || !realpathSync(resolve(root, filename)).startsWith(root + sep + "node_modules" + sep)) {
    throw new Error("The Toolkit dependency trace must contain only exact installed package files.");
  }
  return `./${filename}`;
});

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
    "/api/studio/**": toolkitFiles,
  },
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
      { key: "X-Frame-Options", value: "DENY" },
    ] }, { source: "/proof/:slug", headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }, { key: "Referrer-Policy", value: "no-referrer" }] },
      ...["/api/community/:path*", "/api/snapshot", "/api/session/:path*", "/api/pledges", "/api/tour", "/updates", "/my-contribution", "/supporter-qa", "/api/supporter-qa", "/supporters", "/join", "/api/supporters/:path*", "/organizations/:path*", "/api/organizations/:path*", "/lifecycle/:path*", "/api/lifecycle/:path*", "/procurement/:path*", "/api/procurement/:path*", "/recognition/:path*", "/api/recognition/:path*", "/api/public-recognition/:path*", "/funding", "/api/funding/:path*", "/studio", "/api/planning/:path*"].map(source=>({source,headers:[{key:"Cache-Control",value:"private, no-store, max-age=0"},{key:"Referrer-Policy",value:"no-referrer"}]}))];
  },
};
export default config;
