import { createLogStatement, type CreateLogInput, type LogSqlParam } from "./chat-log-statement";

export const CHAT_LOG_QUEUE_MESSAGE_TYPE = "chat_log";
export const CHAT_LOG_QUEUE_MESSAGE_VERSION = 1;

export type ChatLogQueueMessage = {
  type: typeof CHAT_LOG_QUEUE_MESSAGE_TYPE;
  version: typeof CHAT_LOG_QUEUE_MESSAGE_VERSION;
  event_id: string;
  created_at: string;
  payload: CreateLogInput;
};

type QueueMessageLike = {
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
};

export type QueueBatchLike = {
  messages: QueueMessageLike[];
  queue: string;
};

export type QueueEnvLike = {
  DB?: D1DatabaseLike;
};

type D1Result<T = unknown> = {
  results?: T[];
  meta?: {
    changes?: number;
    last_row_id?: number;
  };
};

type D1PreparedStatement = {
  bind(...values: LogSqlParam[]): D1PreparedStatement;
  run<T = unknown>(): Promise<D1Result<T>>;
};

type D1DatabaseLike = {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<Array<D1Result<T>>>;
};

function createEventId() {
  const cryptoLike = globalThis.crypto as (Crypto & { randomUUID?: () => string }) | undefined;
  return cryptoLike?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createChatLogQueueMessage(input: CreateLogInput): ChatLogQueueMessage {
  const eventId = input.log_event_id ?? createEventId();
  const createdAt = input.created_at ?? new Date().toISOString();

  return {
    type: CHAT_LOG_QUEUE_MESSAGE_TYPE,
    version: CHAT_LOG_QUEUE_MESSAGE_VERSION,
    event_id: eventId,
    created_at: createdAt,
    payload: {
      ...input,
      log_event_id: eventId,
      created_at: createdAt,
    },
  };
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null | undefined {
  return value === null || value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isChatLogInput(value: unknown): value is CreateLogInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;

  return (
    typeof input.user_id === "number" &&
    typeof input.key_id === "number" &&
    isNullableNumber(input.channel_id) &&
    isNullableString(input.model_alias) &&
    isNullableString(input.real_model) &&
    typeof input.stream === "boolean" &&
    typeof input.status_code === "number" &&
    isNullableNumber(input.estimated_tokens) &&
    typeof input.latency_ms === "number" &&
    isNullableNumber(input.prompt_tokens) &&
    isNullableNumber(input.completion_tokens) &&
    isNullableNumber(input.total_tokens) &&
    isNullableNumber(input.first_token_latency_ms) &&
    isNullableNumber(input.output_tps) &&
    isNullableNumber(input.route_attempts) &&
    isNullableString(input.attempted_channels) &&
    isNullableString(input.error_message) &&
    isNullableString(input.client_ip) &&
    isNullableString(input.log_event_id) &&
    isNullableString(input.created_at)
  );
}

export function parseChatLogQueueMessage(body: unknown): ChatLogQueueMessage | null {
  if (!body || typeof body !== "object") return null;
  const message = body as Record<string, unknown>;

  if (message.type !== CHAT_LOG_QUEUE_MESSAGE_TYPE) return null;
  if (message.version !== CHAT_LOG_QUEUE_MESSAGE_VERSION) return null;
  if (typeof message.event_id !== "string" || message.event_id.length === 0) return null;
  if (typeof message.created_at !== "string" || message.created_at.length === 0) return null;
  const payload = message.payload;
  if (!isChatLogInput(payload)) return null;

  return {
    type: CHAT_LOG_QUEUE_MESSAGE_TYPE,
    version: CHAT_LOG_QUEUE_MESSAGE_VERSION,
    event_id: message.event_id,
    created_at: message.created_at,
    payload: {
      ...payload,
      log_event_id: payload.log_event_id ?? message.event_id,
      created_at: payload.created_at ?? message.created_at,
    },
  };
}

export async function processChatLogQueueBatch(batch: QueueBatchLike, env: QueueEnvLike) {
  const db = env.DB;
  if (!db) {
    console.error("LOG_QUEUE consumer is missing DB binding.");
    for (const message of batch.messages) {
      message.retry();
    }
    return;
  }

  const valid: Array<{ message: QueueMessageLike; body: ChatLogQueueMessage }> = [];

  for (const message of batch.messages) {
    const parsed = parseChatLogQueueMessage(message.body);
    if (!parsed) {
      console.warn("Discarding invalid LOG_QUEUE message.");
      message.ack();
      continue;
    }
    valid.push({ message, body: parsed });
  }

  if (valid.length === 0) return;

  try {
    const statements = valid.map((item) => createLogStatement(item.body.payload));
    const prepared = statements.map((statement) => db.prepare(statement.sql).bind(...statement.params));
    await db.batch(prepared);
    for (const item of valid) {
      item.message.ack();
    }
  } catch (error) {
    console.error("Failed to write LOG_QUEUE batch.", error);
    for (const item of valid) {
      item.message.retry();
    }
  }
}
