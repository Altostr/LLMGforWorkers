export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/db";
import { ensureAdmin } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";

export { PUT, DELETE } from "@/app/api/admin/channels/[id]/route";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const { id } = await context.params;
  const channel = await gatewayDb.get<Record<string, unknown>>(
    "SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL",
    id,
  );
  if (!channel) return jsonError("渠道不存在", 404);

  const models = await gatewayDb.all(
    "SELECT id, alias, real_model, channel_id, is_public, enabled, weight, created_at FROM models WHERE channel_id = ? AND deleted_at IS NULL ORDER BY id DESC",
    id,
  );

  return jsonOk({ data: { ...channel, models } });
}
