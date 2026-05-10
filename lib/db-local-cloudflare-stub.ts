import type { GatewayDbAdapter } from "@/lib/db";

export function createLocalGatewayDb(): GatewayDbAdapter {
  throw new Error("D1 binding DB is required when running on Cloudflare Workers.");
}
