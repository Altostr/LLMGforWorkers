export type LogSqlParam = string | number | bigint | boolean | null | Uint8Array;

export type LogStatement = {
  sql: string;
  params: LogSqlParam[];
};

export type CreateLogInput = {
  user_id: number;
  key_id: number;
  channel_id: number | null;
  model_alias: string | null;
  real_model: string | null;
  stream: boolean;
  status_code: number;
  estimated_tokens: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  latency_ms: number;
  first_token_latency_ms?: number | null;
  output_tps?: number | null;
  route_attempts?: number | null;
  attempted_channels?: string | null;
  error_message?: string | null;
  client_ip?: string | null;
  log_event_id?: string | null;
  created_at?: string | null;
};

export type LogStatementMode = "modern" | "legacy";

function formatUtcSqlTimestamp(date: Date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function createUtcLogTimestamp(date = new Date()) {
  return formatUtcSqlTimestamp(date);
}

export function normalizeLogTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed;

  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const withZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);
  if (Number.isNaN(date.getTime())) return trimmed;
  return formatUtcSqlTimestamp(date);
}

function baseLogParams(input: CreateLogInput): LogSqlParam[] {
  return [
    input.user_id,
    input.key_id,
    input.channel_id,
    input.model_alias,
    input.real_model,
    input.stream ? 1 : 0,
    input.status_code,
    input.estimated_tokens,
    input.prompt_tokens ?? null,
    input.completion_tokens ?? null,
    input.total_tokens ?? null,
    input.latency_ms,
    input.first_token_latency_ms ?? null,
    input.output_tps ?? null,
    input.route_attempts ?? 1,
    input.attempted_channels ?? null,
    input.error_message ?? null,
    input.client_ip ?? null,
    normalizeLogTimestamp(input.created_at),
  ];
}

export function createModernLogStatement(input: CreateLogInput): LogStatement {
  return {
    sql: `INSERT OR IGNORE INTO logs (
         log_event_id, user_id, key_id, channel_id, model_alias, real_model,
         stream, status_code, estimated_tokens, prompt_tokens, completion_tokens, total_tokens,
         latency_ms, first_token_latency_ms, output_tps, route_attempts, attempted_channels, error_message, client_ip,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
    params: [
      input.log_event_id ?? null,
      ...baseLogParams(input),
    ],
  };
}

export function createLegacyLogStatement(input: CreateLogInput): LogStatement {
  return {
    sql: `INSERT INTO logs (
         user_id, key_id, channel_id, model_alias, real_model,
         stream, status_code, estimated_tokens, prompt_tokens, completion_tokens, total_tokens,
         latency_ms, first_token_latency_ms, output_tps, route_attempts, attempted_channels, error_message, client_ip,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
    params: baseLogParams(input),
  };
}

export function createLogStatement(input: CreateLogInput, mode: LogStatementMode = "modern"): LogStatement {
  return mode === "legacy" ? createLegacyLogStatement(input) : createModernLogStatement(input);
}

export function isMissingLogEventIdColumnError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /log_event_id/i.test(message) && /no column|no such column|has no column/i.test(message);
}
