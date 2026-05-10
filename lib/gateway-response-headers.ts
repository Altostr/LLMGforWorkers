import type { GatewayProtocol } from "@/lib/protocols";

type GatewayResponseProtocol = GatewayProtocol | "models";

export function createGatewayRequestId() {
  const cryptoLike = globalThis.crypto as (Crypto & { randomUUID?: () => string }) | undefined;
  return cryptoLike?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function withGatewayResponseHeaders(
  response: Response,
  options: { protocol?: GatewayResponseProtocol; requestId?: string | null } = {},
) {
  response.headers.set("X-Model-Gate", "api");
  if (options.protocol) response.headers.set("X-Model-Gate-Protocol", options.protocol);
  if (options.requestId) response.headers.set("X-Model-Gate-Request-Id", options.requestId);
  return response;
}
