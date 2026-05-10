import type { SqlParam } from "./db";

export type LogsTableColumn = {
  name: string;
  type?: string;
  notnull?: number;
  dflt_value?: string | number | null;
  pk?: number;
};

export type LogsSchemaDatabase = {
  all<T = unknown>(sql: string, ...params: SqlParam[]): Promise<T[]>;
  run(sql: string, ...params: SqlParam[]): Promise<unknown>;
};

type D1Result<T = unknown> = {
  results?: T[];
};

type D1PreparedStatement = {
  bind(...values: SqlParam[]): D1PreparedStatement;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
};

export type D1DatabaseForLogsSchema = {
  prepare(sql: string): D1PreparedStatement;
};

export type LogsSchemaRepairResult = {
  table_exists: boolean;
  created_table: boolean;
  repaired_columns: string[];
  missing_columns: string[];
  columns: LogsTableColumn[];
};

export const REQUIRED_LOG_COLUMNS = [
  "id",
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
  "token_source",
  "route_attempts",
  "attempted_channels",
  "error_message",
  "client_ip",
  "created_at",
] as const;

const LOGS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY,
  log_event_id TEXT,
  user_id INTEGER NOT NULL,
  key_id INTEGER NOT NULL,
  channel_id INTEGER,
  model_alias TEXT,
  real_model TEXT,
  stream INTEGER DEFAULT 0,
  status_code INTEGER,
  estimated_tokens INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  latency_ms INTEGER,
  first_token_latency_ms INTEGER,
  output_tps REAL,
  token_source TEXT,
  route_attempts INTEGER DEFAULT 1,
  attempted_channels TEXT,
  error_message TEXT,
  client_ip TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`;

const ADDABLE_LOG_COLUMNS: Array<{ name: (typeof REQUIRED_LOG_COLUMNS)[number]; ddl: string }> = [
  { name: "log_event_id", ddl: "log_event_id TEXT" },
  { name: "user_id", ddl: "user_id INTEGER" },
  { name: "key_id", ddl: "key_id INTEGER" },
  { name: "channel_id", ddl: "channel_id INTEGER" },
  { name: "model_alias", ddl: "model_alias TEXT" },
  { name: "real_model", ddl: "real_model TEXT" },
  { name: "stream", ddl: "stream INTEGER DEFAULT 0" },
  { name: "status_code", ddl: "status_code INTEGER" },
  { name: "estimated_tokens", ddl: "estimated_tokens INTEGER" },
  { name: "prompt_tokens", ddl: "prompt_tokens INTEGER" },
  { name: "completion_tokens", ddl: "completion_tokens INTEGER" },
  { name: "total_tokens", ddl: "total_tokens INTEGER" },
  { name: "latency_ms", ddl: "latency_ms INTEGER" },
  { name: "first_token_latency_ms", ddl: "first_token_latency_ms INTEGER" },
  { name: "output_tps", ddl: "output_tps REAL" },
  { name: "token_source", ddl: "token_source TEXT" },
  { name: "route_attempts", ddl: "route_attempts INTEGER DEFAULT 1" },
  { name: "attempted_channels", ddl: "attempted_channels TEXT" },
  { name: "error_message", ddl: "error_message TEXT" },
  { name: "client_ip", ddl: "client_ip TEXT" },
  { name: "created_at", ddl: "created_at DATETIME" },
];

const LOGS_INDEX_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_logs_user_id ON logs(user_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_log_event_id ON logs(log_event_id) WHERE log_event_id IS NOT NULL",
];

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isDuplicateColumnError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return message.includes("duplicate column name") || message.includes("already exists");
}

function columnNameSet(columns: LogsTableColumn[]) {
  return new Set(columns.map((column) => column.name));
}

export function createD1LogsSchemaDatabase(db: D1DatabaseForLogsSchema): LogsSchemaDatabase {
  return {
    async all<T>(sql: string, ...params: SqlParam[]) {
      const result = await db.prepare(sql).bind(...params).all<T>();
      return result.results ?? [];
    },
    async run(sql: string, ...params: SqlParam[]) {
      return db.prepare(sql).bind(...params).run();
    },
  };
}

export async function getLogsTableColumns(db: LogsSchemaDatabase) {
  return db.all<LogsTableColumn>("PRAGMA table_info(logs)");
}

export async function ensureLogsSchema(db: LogsSchemaDatabase): Promise<LogsSchemaRepairResult> {
  const initialColumns = await getLogsTableColumns(db);
  const tableExists = initialColumns.length > 0;
  let createdTable = false;

  if (!tableExists) {
    await db.run(LOGS_TABLE_SQL);
    createdTable = true;
  }

  let columns = tableExists ? initialColumns : await getLogsTableColumns(db);
  let names = columnNameSet(columns);
  const repairedColumns: string[] = [];
  let sawConcurrentRepair = false;

  for (const column of ADDABLE_LOG_COLUMNS) {
    if (names.has(column.name)) continue;

    try {
      await db.run(`ALTER TABLE logs ADD COLUMN ${column.ddl}`);
      repairedColumns.push(column.name);
      names.add(column.name);
    } catch (error) {
      if (!isDuplicateColumnError(error)) throw error;
      sawConcurrentRepair = true;
    }
  }

  if (createdTable || repairedColumns.length > 0 || sawConcurrentRepair) {
    columns = await getLogsTableColumns(db);
    names = columnNameSet(columns);
  }

  const missingColumns = REQUIRED_LOG_COLUMNS.filter((column) => !names.has(column));
  if (missingColumns.length === 0) {
    for (const sql of LOGS_INDEX_SQL) {
      await db.run(sql);
    }
  }

  return {
    table_exists: tableExists,
    created_table: createdTable,
    repaired_columns: repairedColumns,
    missing_columns: missingColumns,
    columns,
  };
}
