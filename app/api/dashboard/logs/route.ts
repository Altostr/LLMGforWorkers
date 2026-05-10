export const dynamic = "force-dynamic";

import { gatewayDb } from "@/lib/db";
import { ensureWebUser } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";
import { ensureLogsSchema } from "@/lib/logs-schema";

const SHANGHAI_OFFSET = "+08:00";

function asNumber(value: unknown) {
  const numberValue = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function parseBoundedInt(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function parseDateParam(value: string) {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  return trimmed;
}

function toShanghaiDateBoundaryUtc(dateText: string, dayOffset: number) {
  const date = new Date(`${dateText}T00:00:00${SHANGHAI_OFFSET}`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString();
}

export async function GET(request: Request) {
  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  try {
    const schema = await ensureLogsSchema(gatewayDb);
    if (schema.missing_columns.length > 0) {
      return jsonError(`logs 表结构仍缺少字段：${schema.missing_columns.join(", ")}。请查看诊断页面。`, 500);
    }

    const isAdmin = guard.auth.user.role === "admin";
    const url = new URL(request.url);
    const limit = parseBoundedInt(url.searchParams.get("limit"), 50, 1, 200);
    const offset = parseBoundedInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const user = (url.searchParams.get("user") ?? "").trim();
    const model = (url.searchParams.get("model") ?? "").trim();
    const channel = (url.searchParams.get("channel") ?? "").trim();
    const ip = (url.searchParams.get("ip") ?? "").trim();
    const startDate = parseDateParam(url.searchParams.get("start_date") ?? "");
    const endDate = parseDateParam(url.searchParams.get("end_date") ?? "");

    const whereClauses: string[] = [];
    const whereArgs: Array<string | number> = [];

    if (!isAdmin) {
      whereClauses.push("l.user_id = ?");
      whereArgs.push(guard.auth.user.id);
    } else if (user) {
      whereClauses.push("u.username LIKE ?");
      whereArgs.push(`%${user}%`);
    }

    if (model) {
      whereClauses.push("(l.model_alias LIKE ? OR l.real_model LIKE ?)");
      whereArgs.push(`%${model}%`, `%${model}%`);
    }

    if (channel) {
      whereClauses.push("c.name LIKE ?");
      whereArgs.push(`%${channel}%`);
    }

    if (ip) {
      whereClauses.push("l.client_ip LIKE ?");
      whereArgs.push(`%${ip}%`);
    }

    if (startDate) {
      const startBoundary = toShanghaiDateBoundaryUtc(startDate, 0);
      if (startBoundary) {
        whereClauses.push("unixepoch(l.created_at) >= unixepoch(?)");
        whereArgs.push(startBoundary);
      }
    }

    if (endDate) {
      const endBoundary = toShanghaiDateBoundaryUtc(endDate, 1);
      if (endBoundary) {
        whereClauses.push("unixepoch(l.created_at) < unixepoch(?)");
        whereArgs.push(endBoundary);
      }
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const rows = await gatewayDb.all(
      `SELECT
           l.id, l.user_id, u.username, l.key_id, l.channel_id,
           c.name AS channel_name,
           l.model_alias, l.real_model, COALESCE(l.stream, 0) AS stream, COALESCE(l.status_code, 0) AS status_code,
           l.estimated_tokens, l.prompt_tokens, l.completion_tokens, l.total_tokens,
           l.latency_ms, l.first_token_latency_ms, l.output_tps, COALESCE(l.route_attempts, 1) AS route_attempts, l.attempted_channels,
           l.error_message, l.client_ip, l.created_at
         FROM logs l
         LEFT JOIN users u ON u.id = l.user_id
         LEFT JOIN channels c ON c.id = l.channel_id
         ${whereSql}
         ORDER BY l.id DESC
         LIMIT ? OFFSET ?`,
      ...whereArgs,
      limit,
      offset,
    );

    const data = isAdmin
      ? rows
      : rows.map((row) => {
          const next = { ...(row as Record<string, unknown>) };
          delete next.username;
          delete next.channel_name;
          delete next.route_attempts;
          delete next.attempted_channels;
          return next;
        });

    const total = await gatewayDb.get<{ total: number }>(
      `SELECT COALESCE(COUNT(*), 0) AS total
         FROM logs l
         LEFT JOIN users u ON u.id = l.user_id
         LEFT JOIN channels c ON c.id = l.channel_id
         ${whereSql}`,
      ...whereArgs,
    );

    const summary = await gatewayDb.get<{
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
         FROM logs l
         LEFT JOIN users u ON u.id = l.user_id
         LEFT JOIN channels c ON c.id = l.channel_id
         ${whereSql}`,
      ...whereArgs,
    ) ?? {
      total_requests: 0,
      failed_requests: 0,
      total_tokens: 0,
      avg_latency_ms: 0,
      avg_first_token_latency_ms: 0,
      avg_output_tps: 0,
    };

    return jsonOk({
      summary: {
        total_requests: asNumber(summary.total_requests),
        failed_requests: asNumber(summary.failed_requests),
        total_tokens: asNumber(summary.total_tokens),
        avg_latency_ms: asNumber(summary.avg_latency_ms),
        avg_first_token_latency_ms: asNumber(summary.avg_first_token_latency_ms),
        avg_output_tps: asNumber(summary.avg_output_tps),
      },
      data,
      paging: { limit, offset, total: asNumber(total?.total) },
    });
  } catch (error) {
    console.error("Dashboard logs query failed.", error);
    return jsonError("请求日志加载失败，请检查 D1 logs 表和日志队列写入状态。", 500);
  }
}
