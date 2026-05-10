import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { GatewayProtocol } from "@/lib/protocols";

export type SqlParam = string | number | bigint | boolean | null | Uint8Array;

export type DbRunResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

export type DbBatchStatement = {
  sql: string;
  params?: SqlParam[];
};

export type GatewayDbAdapter = {
  get<T = unknown>(sql: string, ...params: SqlParam[]): Promise<T | undefined>;
  all<T = unknown>(sql: string, ...params: SqlParam[]): Promise<T[]>;
  run(sql: string, ...params: SqlParam[]): Promise<DbRunResult>;
  exec(sql: string): Promise<void>;
  batch(statements: DbBatchStatement[]): Promise<DbRunResult[]>;
};

export type D1Result<T = unknown> = {
  results?: T[];
  meta?: {
    changes?: number;
    last_row_id?: number;
  };
};

export type D1PreparedStatement = {
  bind(...values: SqlParam[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
};

export type D1DatabaseLike = {
  prepare(sql: string): D1PreparedStatement;
  exec(sql: string): Promise<unknown>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<Array<D1Result<T>>>;
};

type CloudflareContextLike = {
  env?: {
    DB?: D1DatabaseLike;
  };
};

let adapterPromise: Promise<GatewayDbAdapter> | null = null;

export function createD1GatewayDbAdapter(db: D1DatabaseLike): GatewayDbAdapter {
  const runResult = (result: D1Result): DbRunResult => ({
    changes: result.meta?.changes ?? 0,
    lastInsertRowid: result.meta?.last_row_id ?? 0,
  });

  return {
    async get<T>(sql: string, ...params: SqlParam[]) {
      return (await db.prepare(sql).bind(...params).first<T>()) ?? undefined;
    },
    async all<T>(sql: string, ...params: SqlParam[]) {
      const result = await db.prepare(sql).bind(...params).all<T>();
      return result.results ?? [];
    },
    async run(sql: string, ...params: SqlParam[]) {
      return runResult(await db.prepare(sql).bind(...params).run());
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
    async batch(statements: DbBatchStatement[]) {
      if (statements.length === 0) return [];
      const prepared = statements.map((statement) =>
        db.prepare(statement.sql).bind(...(statement.params ?? [])),
      );
      const results = await db.batch(prepared);
      return results.map(runResult);
    },
  };
}

function tryGetD1Database(): D1DatabaseLike | null {
  try {
    const context = getCloudflareContext() as CloudflareContextLike;
    return context.env?.DB ?? null;
  } catch {
    return null;
  }
}

async function createAdapter() {
  const d1 = tryGetD1Database();
  if (d1) return createD1GatewayDbAdapter(d1);

  const local = await import("@/lib/db-local");
  return local.createLocalGatewayDb();
}

function getAdapter() {
  adapterPromise ??= createAdapter();
  return adapterPromise;
}

export const gatewayDb: GatewayDbAdapter = {
  async get<T>(sql: string, ...params: SqlParam[]) {
    return (await getAdapter()).get<T>(sql, ...params);
  },
  async all<T>(sql: string, ...params: SqlParam[]) {
    return (await getAdapter()).all<T>(sql, ...params);
  },
  async run(sql: string, ...params: SqlParam[]) {
    return (await getAdapter()).run(sql, ...params);
  },
  async exec(sql: string) {
    return (await getAdapter()).exec(sql);
  },
  async batch(statements: DbBatchStatement[]) {
    return (await getAdapter()).batch(statements);
  },
};

export type DbChannel = {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  supported_protocols: string;
  enabled: number;
  weight: number;
  max_concurrency: number;
  timeout: number;
  created_at: string;
  deleted_at: string | null;
};

export type DbModel = {
  id: number;
  alias: string;
  real_model: string;
  channel_id: number;
  upstream_protocol: GatewayProtocol;
  is_public: number;
  enabled: number;
  weight: number;
  created_at: string;
  deleted_at: string | null;
};

export type DbGroup = {
  id: number;
  name: string;
  description: string | null;
  qps: number;
  rpm: number;
  tpm: number;
  quota_requests: number | null;
  quota_tokens: number | null;
  allowed_model_aliases: string;
  is_default: number;
  enabled: number;
  created_at: string;
  deleted_at: string | null;
};

export type DbUser = {
  id: number;
  username: string;
  password_hash: string;
  role: "admin" | "user";
  group_id: number | null;
  rpm: number;
  qps: number;
  tpm: number;
  quota_tokens: number | null;
  quota_requests: number | null;
  used_tokens: number;
  used_requests: number;
  allowed_model_aliases: string;
  note: string | null;
  enabled: number;
  created_at: string;
  deleted_at: string | null;
};

export type DbKey = {
  id: number;
  key: string;
  name: string;
  user_id: number;
  used_tokens: number;
  used_requests: number;
  enabled: number;
  created_at: string;
  deleted_at: string | null;
};

export type DbLog = {
  id: number;
  user_id: number;
  key_id: number;
  channel_id: number | null;
  model_alias: string | null;
  real_model: string | null;
  stream: number;
  status_code: number | null;
  estimated_tokens: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  latency_ms: number | null;
  first_token_latency_ms: number | null;
  output_tps: number | null;
  token_source: string | null;
  route_attempts: number | null;
  attempted_channels: string | null;
  error_message: string | null;
  client_ip: string | null;
  log_event_id: string | null;
  created_at: string;
};
