export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb } from "@/lib/db";
import { ensureAdmin } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";
import { GATEWAY_PROTOCOLS, supportsProtocol } from "@/lib/protocols";

const createSchema = z.object({
  alias: z.string().min(1),
  real_model: z.string().min(1),
  channel_id: z.number().int().positive(),
  upstream_protocol: z.enum(GATEWAY_PROTOCOLS).optional(),
  is_public: z.boolean().optional(),
  enabled: z.boolean().optional(),
  weight: z.number().int().min(1).optional(),
});

export async function GET(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const rows = await gatewayDb.all(
    `SELECT m.*, c.name AS channel_name
       FROM models m
       JOIN channels c ON c.id = m.channel_id
       WHERE m.deleted_at IS NULL
       ORDER BY m.id DESC`,
  );

  return jsonOk({ data: rows });
}

export async function POST(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const channel = await gatewayDb.get<{ id: number; supported_protocols: string }>(
    "SELECT id, supported_protocols FROM channels WHERE id = ?",
    parsed.data.channel_id,
  );
  if (!channel) return jsonError("渠道不存在", 404);
  const upstreamProtocol = parsed.data.upstream_protocol ?? "chat_completions";
  if (!supportsProtocol(channel.supported_protocols, upstreamProtocol)) {
    return jsonError("所选渠道不支持该上游协议", 400);
  }

  const result = await gatewayDb.run(
    `INSERT INTO models (alias, real_model, channel_id, upstream_protocol, is_public, enabled, weight)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    parsed.data.alias,
    parsed.data.real_model,
    parsed.data.channel_id,
    upstreamProtocol,
    parsed.data.is_public === false ? 0 : 1,
    parsed.data.enabled === false ? 0 : 1,
    parsed.data.weight ?? 1,
  );

  const row = await gatewayDb.get("SELECT * FROM models WHERE id = ? AND deleted_at IS NULL", result.lastInsertRowid);
  return jsonOk({ message: "模型创建成功。", data: row }, 201);
}
