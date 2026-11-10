import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  logging: { incomingRequests: { ignore: [/\/api\/auth\//, /\/sandbox/] }, browserToTerminal: false, serverFunctions: false },
  serverExternalPackages: ["@fracture/paypal-core", "paypal", "pg"],
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
      { key: "X-Frame-Options", value: "DENY" },
    ] }];
  },
};
export default config;
