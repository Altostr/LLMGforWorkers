export const dynamic = "force-dynamic";

import { z } from "zod";
import { gatewayDb } from "@/lib/db";
import { ensureAdmin } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";
import { GATEWAY_PROTOCOLS, normalizeSupportedProtocols, parseSupportedProtocols, stringifySupportedProtocols } from "@/lib/protocols";

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  base_url: z.string().url().optional(),
  api_key: z.string().min(1).optional(),
  supported_protocols: z.array(z.enum(GATEWAY_PROTOCOLS)).min(1).optional(),
  enabled: z.boolean().optional(),
  weight: z.number().int().min(1).optional(),
  max_concurrency: z.number().int().min(1).optional(),
  timeout: z.number().int().min(1).optional(),
});

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  const existing = await gatewayDb.get("SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL", id);
  if (!existing) return jsonError("渠道不存在", 404);
  const nextProtocols = parsed.data.supported_protocols === undefined
    ? (existing as { supported_protocols: string }).supported_protocols
    : stringifySupportedProtocols(normalizeSupportedProtocols(parsed.data.supported_protocols));
  const nextProtocolList = parseSupportedProtocols(nextProtocols);
  const protocolPlaceholders = nextProtocolList.map(() => "?").join(", ");

  const incompatibleModel = await gatewayDb.get<{ id: number }>(
    `SELECT id
       FROM models
       WHERE channel_id = ? AND deleted_at IS NULL AND enabled = 1 AND upstream_protocol NOT IN (${protocolPlaceholders})
       LIMIT 1`,
    id,
    ...nextProtocolList,
  );
  if (incompatibleModel) {
    return jsonError("该渠道下存在使用未被保留协议的启用模型", 400);
  }

  const merged = {
    ...existing,
    ...parsed.data,
    supported_protocols:
      parsed.data.supported_protocols === undefined
        ? (existing as { supported_protocols: string }).supported_protocols
        : nextProtocols,
    enabled:
      parsed.data.enabled === undefined
        ? (existing as { enabled: number }).enabled
        : parsed.data.enabled
          ? 1
          : 0,
  };

  await gatewayDb.run(
    `UPDATE channels
       SET name = ?, base_url = ?, api_key = ?, supported_protocols = ?, enabled = ?, weight = ?, max_concurrency = ?, timeout = ?
       WHERE id = ?`,
    (merged as { name: string }).name,
    (merged as { base_url: string }).base_url,
    (merged as { api_key: string }).api_key,
    (merged as { supported_protocols: string }).supported_protocols,
    (merged as { enabled: number }).enabled,
    (merged as { weight: number }).weight,
    (merged as { max_concurrency: number }).max_concurrency,
    (merged as { timeout: number }).timeout,
    id,
  );

  const row = await gatewayDb.get("SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL", id);
  return jsonOk({ message: "渠道更新成功。", data: row });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  await gatewayDb.batch([
    {
      sql: "UPDATE models SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE channel_id = ? AND deleted_at IS NULL",
      params: [id],
    },
    {
      sql: "UPDATE channels SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL",
      params: [id],
    },
  ]);
  return jsonOk({ ok: true, message: "渠道删除成功。" });
}
