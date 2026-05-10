export const dynamic = "force-dynamic";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createLog } from "@/lib/data/repositories/log-repository";
import { gatewayDb } from "@/lib/db";
import { ensureAdmin } from "@/lib/guards";
import { jsonOk } from "@/lib/http";
import { ensureLogsSchema, REQUIRED_LOG_COLUMNS } from "@/lib/logs-schema";

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

type LogWriteMode = "queue_with_d1_fallback" | "direct_d1" | "binding_missing";

const DIAGNOSTIC_PROBE_MODEL = "__diagnostic_probe__";

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

function getLogWriteMode(bindings: ReturnType<typeof getBindingDiagnostics>): LogWriteMode {
  if (!bindings.cloudflare_context) return "direct_d1";
  if (!bindings.d1_binding_visible) return "binding_missing";
  return bindings.log_queue_binding_visible ? "queue_with_d1_fallback" : "direct_d1";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createProbeEventId() {
  const cryptoLike = globalThis.crypto as (Crypto & { randomUUID?: () => string }) | undefined;
  return `diagnostic-${cryptoLike?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

export async function GET(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const bindings = getBindingDiagnostics();
  const logWriteMode = getLogWriteMode(bindings);

  try {
    const repair = await ensureLogsSchema(gatewayDb);
    const columns = repair.columns as TableColumn[];
    const missingColumns = repair.missing_columns;
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
      missing_columns: missingColumns,
      repaired_columns: repair.repaired_columns,
      created_table: repair.created_table,
      log_write_mode: logWriteMode,
      write_probe_available: true,
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
      missing_columns: REQUIRED_LOG_COLUMNS,
      repaired_columns: [],
      created_table: false,
      log_write_mode: logWriteMode,
      write_probe_available: true,
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

export async function POST(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const probeEventId = createProbeEventId();
  let d1InsertOk = false;
  let d1ReadbackOk = false;
  let cleanupOk = false;
  let probeError: string | null = null;

  try {
    await ensureLogsSchema(gatewayDb);
    await createLog({
      user_id: guard.auth.user.id,
      key_id: 0,
      channel_id: null,
      model_alias: DIAGNOSTIC_PROBE_MODEL,
      real_model: null,
      stream: false,
      status_code: 204,
      estimated_tokens: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      latency_ms: 0,
      first_token_latency_ms: null,
      output_tps: null,
      route_attempts: 1,
      attempted_channels: null,
      error_message: null,
      client_ip: null,
      log_event_id: probeEventId,
      created_at: new Date().toISOString(),
    });
    d1InsertOk = true;

    const readback = await gatewayDb.get<{ id: number }>(
      "SELECT id FROM logs WHERE log_event_id = ? LIMIT 1",
      probeEventId,
    );
    d1ReadbackOk = Boolean(readback);
  } catch (error) {
    probeError = errorMessage(error);
    console.error("Dashboard diagnostics log write probe failed.", {
      probe_event_id: probeEventId,
      error,
    });
  } finally {
    try {
      await gatewayDb.run("DELETE FROM logs WHERE log_event_id = ?", probeEventId);
      cleanupOk = true;
    } catch (error) {
      const cleanupError = errorMessage(error);
      probeError = probeError ? `${probeError}; cleanup: ${cleanupError}` : `cleanup: ${cleanupError}`;
      console.error("Dashboard diagnostics log write probe cleanup failed.", {
        probe_event_id: probeEventId,
        error,
      });
    }
  }

  return jsonOk({
    ok: d1InsertOk && d1ReadbackOk && cleanupOk && !probeError,
    d1_insert_ok: d1InsertOk,
    d1_readback_ok: d1ReadbackOk,
    cleanup_ok: cleanupOk,
    probe_event_id: probeEventId,
    probe_error: probeError,
  });
}
