import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  webpack(config) {
    if (process.env.MODEL_GATE_TARGET === "cloudflare") {
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        "@/lib/db-local": path.join(process.cwd(), "lib/db-local-cloudflare-stub.ts"),
      };
    }
    return config;
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
