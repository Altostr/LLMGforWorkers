export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/db";
import { ensureWebUser } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";

function asNumber(value: unknown) {
  const numberValue = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function estimateConcurrency(rows: Array<{ end_ms: number; latency_ms: number }>) {
  const now = Date.now();
  const windowStart = now - 24 * 60 * 60 * 1000;
  const events: Array<{ ts: number; delta: number }> = [];

  for (const row of rows) {
    if (!Number.isFinite(row.end_ms) || !Number.isFinite(row.latency_ms) || row.latency_ms <= 0) continue;
    const end = Math.min(now, row.end_ms);
    const start = Math.max(windowStart, end - row.latency_ms);
    if (end <= start) continue;
    events.push({ ts: start, delta: 1 });
    events.push({ ts: end, delta: -1 });
  }

  if (events.length === 0) {
    return { estimated_peak_concurrency: 0, estimated_avg_concurrency: 0 };
  }

  events.sort((a, b) => (a.ts === b.ts ? a.delta - b.delta : a.ts - b.ts));

  let active = 0;
  let peak = 0;
  let weightedTotal = 0;
  let previousTs = windowStart;

  for (const event of events) {
    if (event.ts > previousTs) {
      weightedTotal += active * (event.ts - previousTs);
      previousTs = event.ts;
    }
    active += event.delta;
    if (active > peak) peak = active;
  }

  if (previousTs < now) {
    weightedTotal += active * (now - previousTs);
  }

  return {
    estimated_peak_concurrency: peak,
    estimated_avg_concurrency: Number((weightedTotal / (24 * 60 * 60 * 1000)).toFixed(2)),
  };
}

export async function GET(request: Request) {
  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  try {
    const isAdmin = guard.auth.user.role === "admin";
    const whereSql = isAdmin ? "" : "WHERE user_id = ?";
    const whereArgs = isAdmin ? [] : [guard.auth.user.id];

    const summary = await gatewayDb.get<{
      total_requests: number;
      total_tokens: number;
      failed_requests: number;
      rate_limited_requests: number;
      avg_latency_ms: number;
      avg_output_tps: number;
      retry_requests: number;
    }>(
      `SELECT
           COALESCE(COUNT(*), 0) AS total_requests,
           COALESCE(SUM(COALESCE(total_tokens, 0)), 0) AS total_tokens,
           COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0) AS failed_requests,
           COALESCE(SUM(CASE WHEN status_code = 429 THEN 1 ELSE 0 END), 0) AS rate_limited_requests,
           COALESCE(AVG(CASE WHEN status_code < 400 THEN latency_ms END), 0) AS avg_latency_ms,
           COALESCE(AVG(CASE WHEN status_code < 400 THEN output_tps END), 0) AS avg_output_tps,
           COALESCE(SUM(CASE WHEN COALESCE(route_attempts, 1) > 1 THEN 1 ELSE 0 END), 0) AS retry_requests
         FROM logs
         ${whereSql}`,
      ...whereArgs,
    ) ?? {
      total_requests: 0,
      total_tokens: 0,
      failed_requests: 0,
      rate_limited_requests: 0,
      avg_latency_ms: 0,
      avg_output_tps: 0,
      retry_requests: 0,
    };

    const activeUsers = isAdmin
      ? asNumber((await gatewayDb.get<{ active_users: number }>(
          `SELECT COALESCE(COUNT(DISTINCT user_id), 0) AS active_users
           FROM logs`,
        ))?.active_users)
      : 1;

    const keyData = await gatewayDb.get<{ total_keys: number }>(
      isAdmin
        ? "SELECT COALESCE(COUNT(*), 0) AS total_keys FROM keys WHERE deleted_at IS NULL"
        : "SELECT COALESCE(COUNT(*), 0) AS total_keys FROM keys WHERE user_id = ? AND deleted_at IS NULL",
      ...(isAdmin ? [] : [guard.auth.user.id]),
    );

    const hourlyRows = await gatewayDb.all<{ hour_bucket: string | null; tokens: number }>(
      `SELECT
           strftime('%Y-%m-%dT%H:00:00', datetime(created_at)) AS hour_bucket,
           COALESCE(SUM(COALESCE(total_tokens, 0)), 0) AS tokens
         FROM logs
         ${whereSql ? `${whereSql} AND` : "WHERE"} unixepoch(created_at) >= unixepoch('now', '-23 hours')
           AND unixepoch(created_at) IS NOT NULL
         GROUP BY hour_bucket
         ORDER BY hour_bucket ASC`,
      ...whereArgs,
    );

    const hourlyMap = new Map(
      hourlyRows
        .filter((row) => typeof row.hour_bucket === "string")
        .map((row) => [row.hour_bucket as string, asNumber(row.tokens)]),
    );
    const hourlyTokens = Array.from({ length: 24 }, (_, index) => {
      const t = new Date(Date.now() - (23 - index) * 3600 * 1000);
      const y = t.getUTCFullYear();
      const m = String(t.getUTCMonth() + 1).padStart(2, "0");
      const d = String(t.getUTCDate()).padStart(2, "0");
      const h = String(t.getUTCHours()).padStart(2, "0");
      const bucket = `${y}-${m}-${d}T${h}:00:00`;
      return {
        hour: bucket,
        tokens: hourlyMap.get(bucket) ?? 0,
      };
    });

    const topModels = await gatewayDb.all(
      `SELECT
           COALESCE(model_alias, real_model, '-') AS model_name,
           COALESCE(COUNT(*), 0) AS request_count,
           COALESCE(SUM(COALESCE(total_tokens, 0)), 0) AS total_tokens
         FROM logs
         ${whereSql}
         GROUP BY model_name
         ORDER BY total_tokens DESC, request_count DESC
         LIMIT 5`,
      ...whereArgs,
    );

    const topChannelWhereSql = isAdmin
      ? "WHERE l.status_code < 400 AND l.channel_id IS NOT NULL"
      : "WHERE l.user_id = ? AND l.status_code < 400 AND l.channel_id IS NOT NULL";

    const topChannels = await gatewayDb.all(
      `SELECT
           COALESCE(c.name, '-') AS channel_name,
           COALESCE(COUNT(*), 0) AS request_count,
           COALESCE(SUM(COALESCE(l.total_tokens, 0)), 0) AS total_tokens
         FROM logs l
         LEFT JOIN channels c ON c.id = l.channel_id
         ${topChannelWhereSql}
         GROUP BY channel_name
         ORDER BY total_tokens DESC, request_count DESC
         LIMIT 5`,
      ...whereArgs,
    );

    const recentLogs = await gatewayDb.all(
      `SELECT
           id,
           COALESCE(model_alias, real_model, '-') AS model_name,
           COALESCE(status_code, 0) AS status_code,
           COALESCE(total_tokens, 0) AS total_tokens,
           COALESCE(latency_ms, 0) AS latency_ms,
           created_at
         FROM logs
         ${whereSql}
         ORDER BY id DESC
         LIMIT 8`,
      ...whereArgs,
    );

    const concurrencyRows = await gatewayDb.all<{ end_ms: number; latency_ms: number }>(
      `SELECT
           CAST(unixepoch(created_at) * 1000 AS INTEGER) AS end_ms,
           latency_ms
         FROM logs
         ${whereSql ? `${whereSql} AND` : "WHERE"} channel_id IS NOT NULL
           AND latency_ms IS NOT NULL
           AND latency_ms > 0
           AND unixepoch(created_at) >= unixepoch('now', '-24 hours')
           AND unixepoch(created_at) IS NOT NULL`,
      ...whereArgs,
    );

    const concurrency = estimateConcurrency(concurrencyRows);
    const totalRequests = asNumber(summary.total_requests);
    const failedRequests = asNumber(summary.failed_requests);
    const rateLimitedRequests = asNumber(summary.rate_limited_requests);
    const successRateBase = Math.max(0, totalRequests - rateLimitedRequests);
    const successCount = Math.max(0, successRateBase - (failedRequests - rateLimitedRequests));

    return jsonOk({
      data: {
        total_requests: totalRequests,
        total_tokens: asNumber(summary.total_tokens),
        failed_requests: failedRequests,
        total_keys: asNumber(keyData?.total_keys),
        active_users: activeUsers,
        avg_latency_ms: asNumber(summary.avg_latency_ms),
        avg_output_tps: asNumber(summary.avg_output_tps),
        retry_requests: asNumber(summary.retry_requests),
        rate_limited_requests: rateLimitedRequests,
        success_rate: successRateBase > 0
          ? Number(((successCount / successRateBase) * 100).toFixed(2))
          : 0,
        estimated_peak_concurrency: concurrency.estimated_peak_concurrency,
        estimated_avg_concurrency: concurrency.estimated_avg_concurrency,
        hourly_tokens: hourlyTokens,
        top_models: topModels,
        top_channels: topChannels,
        recent_logs: recentLogs,
      },
    });
  } catch (error) {
    console.error("Dashboard summary query failed.", error);
    return jsonError("统计数据加载失败，请检查 D1 logs 表和日志队列写入状态。", 500);
  }
}
