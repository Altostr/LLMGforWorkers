import { gatewayDb, type GatewayDbAdapter, type SqlParam } from "@/lib/db";
import { ensureLogsSchema } from "@/lib/logs-schema";
import { asNumber } from "@/lib/utils";

type LegacyChatLogQuery = {
  db?: GatewayDbAdapter;
  userId?: number;
  limit: number;
  offset: number;
};

function scopedWhere(userId: number | undefined, prefix = "") {
  if (userId === undefined) return { sql: "", args: [] as SqlParam[] };
  return { sql: `WHERE ${prefix}user_id = ?`, args: [userId] as SqlParam[] };
}

export async function getLegacyChatLogs({
  db = gatewayDb,
  userId,
  limit,
  offset,
}: LegacyChatLogQuery) {
  await ensureLogsSchema(db);

  const where = scopedWhere(userId, "l.");
  const summaryWhere = scopedWhere(userId);

  const rows = await db.all(
    `SELECT
         l.id, l.user_id, u.username, l.key_id, l.channel_id,
         c.name AS channel_name,
         l.model_alias, l.real_model, l.stream, l.status_code,
         l.estimated_tokens, l.prompt_tokens, l.completion_tokens, l.total_tokens,
         l.latency_ms, l.first_token_latency_ms, l.output_tps, l.token_source,
         l.error_message, l.created_at
       FROM logs l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN channels c ON c.id = l.channel_id
       ${where.sql}
       ORDER BY l.id DESC
       LIMIT ? OFFSET ?`,
    ...where.args,
    limit,
    offset,
  );

  const total = await db.get<{ total: number }>(
    `SELECT COALESCE(COUNT(*), 0) AS total
       FROM logs
       ${summaryWhere.sql}`,
    ...summaryWhere.args,
  );

  const summary = await db.get<{
    total_requests: number;
    failed_requests: number;
    total_tokens: number;
    avg_latency_ms: number;
    avg_first_token_latency_ms: number;
    avg_output_tps: number;
  }>(
    `SELECT
         COALESCE(COUNT(*), 0) AS total_requests,
         COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0) AS failed_requests,
         COALESCE(SUM(COALESCE(total_tokens, 0)), 0) AS total_tokens,
         COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
         COALESCE(AVG(first_token_latency_ms), 0) AS avg_first_token_latency_ms,
         COALESCE(AVG(output_tps), 0) AS avg_output_tps
       FROM logs
       ${summaryWhere.sql}`,
    ...summaryWhere.args,
  ) ?? {
    total_requests: 0,
    failed_requests: 0,
    total_tokens: 0,
    avg_latency_ms: 0,
    avg_first_token_latency_ms: 0,
    avg_output_tps: 0,
  };

  return {
    summary: {
      total_requests: asNumber(summary.total_requests),
      failed_requests: asNumber(summary.failed_requests),
      total_tokens: asNumber(summary.total_tokens),
      avg_latency_ms: asNumber(summary.avg_latency_ms),
      avg_first_token_latency_ms: asNumber(summary.avg_first_token_latency_ms),
      avg_output_tps: asNumber(summary.avg_output_tps),
    },
    data: rows,
    paging: { limit, offset, total: asNumber(total?.total) },
  };
}
