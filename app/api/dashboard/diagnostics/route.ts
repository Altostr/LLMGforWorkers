export const dynamic = "force-dynamic";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { gatewayDb } from "@/lib/db";
import { ensureAdmin } from "@/lib/guards";
import { jsonOk } from "@/lib/http";

const REQUIRED_LOG_COLUMNS = [
  "log_event_id",
  "user_id",
  "key_id",
  "channel_id",
  "model_alias",
  "real_model",
  "stream",
  "status_code",
  "estimated_tokens",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "latency_ms",
  "first_token_latency_ms",
  "output_tps",
  "route_attempts",
  "attempted_channels",
  "error_message",
  "client_ip",
  "created_at",
] as const;

type CloudflareContextLike = {
  env?: {
    DB?: unknown;
    LOG_QUEUE?: unknown;
  };
};

type TableColumn = {
  name: string;
  type?: string;
  notnull?: number;
  dflt_value?: string | number | null;
  pk?: number;
};

function getBindingDiagnostics() {
  try {
    const context = getCloudflareContext() as unknown as CloudflareContextLike;
    return {
      cloudflare_context: true,
      d1_binding_visible: Boolean(context.env?.DB),
      log_queue_binding_visible: Boolean(context.env?.LOG_QUEUE),
    };
  } catch {
    return {
      cloudflare_context: false,
      d1_binding_visible: false,
      log_queue_binding_visible: false,
    };
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function GET(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const bindings = getBindingDiagnostics();

  try {
    const columns = await gatewayDb.all<TableColumn>("PRAGMA table_info(logs)");
    const columnNames = new Set(columns.map((column) => column.name));
    const missingColumns = REQUIRED_LOG_COLUMNS.filter((column) => !columnNames.has(column));
    const tableExists = columns.length > 0;

    let counts:
      | {
          total_logs: number;
          recent_24h_logs: number;
          latest_log: { id: number; created_at: string } | null;
        }
      | null = null;
    let countsError: string | null = null;

    try {
      const total = await gatewayDb.get<{ total_logs: number }>(
        "SELECT COALESCE(COUNT(*), 0) AS total_logs FROM logs",
      );
      const recent = await gatewayDb.get<{ recent_24h_logs: number }>(
        `SELECT COALESCE(COUNT(*), 0) AS recent_24h_logs
           FROM logs
          WHERE unixepoch(created_at) >= unixepoch('now', '-24 hours')
            AND unixepoch(created_at) IS NOT NULL`,
      );
      const latest = await gatewayDb.get<{ id: number; created_at: string }>(
        `SELECT id, created_at
           FROM logs
          ORDER BY unixepoch(created_at) DESC, id DESC
          LIMIT 1`,
      );

      counts = {
        total_logs: total?.total_logs ?? 0,
        recent_24h_logs: recent?.recent_24h_logs ?? 0,
        latest_log: latest ?? null,
      };
    } catch (error) {
      countsError = errorMessage(error);
    }

    return jsonOk({
      ok: tableExists && missingColumns.length === 0 && !countsError,
      runtime: bindings,
      logs_table: {
        exists: tableExists,
        required_columns: REQUIRED_LOG_COLUMNS,
        missing_columns: missingColumns,
        columns: columns.map((column) => ({
          name: column.name,
          type: column.type ?? "",
          notnull: column.notnull ?? 0,
          default_value: column.dflt_value ?? null,
          primary_key: column.pk ?? 0,
        })),
      },
      counts,
      counts_error: countsError,
    });
  } catch (error) {
    return jsonOk({
      ok: false,
      runtime: bindings,
      logs_table: {
        exists: false,
        required_columns: REQUIRED_LOG_COLUMNS,
        missing_columns: REQUIRED_LOG_COLUMNS,
        columns: [],
      },
      counts: null,
      counts_error: errorMessage(error),
    });
  }
}
