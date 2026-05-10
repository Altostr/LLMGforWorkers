import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createChatLogQueueMessage, type ChatLogQueueMessage } from "@/lib/chat-log-queue";
import { createLog, type CreateLogInput } from "@/lib/data/repositories/log-repository";

export type ChatLogInput = CreateLogInput;
export type ChatLogPersistence = "background" | "confirmed_d1";

type InsertChatLogOptions = {
  persistence?: ChatLogPersistence;
};

type InsertChatLogResult = {
  log_event_id: string;
  created_at: string;
  d1_write_ok: boolean | null;
};

type QueueProducerLike = {
  send(message: ChatLogQueueMessage): Promise<unknown>;
};

type WaitUntilContextLike = {
  waitUntil(promise: Promise<unknown>): void;
};

type CloudflareQueueContextLike = {
  env?: {
    LOG_QUEUE?: QueueProducerLike;
  };
  ctx?: WaitUntilContextLike;
};

function getCloudflareQueueContext(): { queue: QueueProducerLike; ctx: WaitUntilContextLike } | null {
  try {
    const context = getCloudflareContext() as CloudflareQueueContextLike;
    const queue = context.env?.LOG_QUEUE;
    const ctx = context.ctx;
    if (!queue || !ctx) return null;
    return { queue, ctx };
  } catch {
    return null;
  }
}

async function enqueueChatLog(queue: QueueProducerLike, message: ChatLogQueueMessage) {
  try {
    await queue.send(message);
  } catch (error) {
    console.error("Failed to enqueue chat log.", {
      event_id: message.event_id,
      error,
    });
  }
}

async function writeD1Log(input: ChatLogInput, failureMessage: string) {
  try {
    await createLog(input);
    return true;
  } catch (error) {
    console.error(failureMessage, {
      log_event_id: input.log_event_id,
      error,
    });
    return false;
  }
}

async function enqueueWithD1Fallback(queue: QueueProducerLike, message: ChatLogQueueMessage) {
  await Promise.allSettled([
    enqueueChatLog(queue, message),
    writeD1Log(message.payload, "Failed to write fallback chat log to D1."),
  ]);
}

export async function insertChatLog(
  input: ChatLogInput,
  options: InsertChatLogOptions = {},
): Promise<InsertChatLogResult> {
  const message = createChatLogQueueMessage(input);
  const context = getCloudflareQueueContext();
  const persistence = options.persistence ?? "background";

  if (persistence === "confirmed_d1") {
    const d1WriteOk = await writeD1Log(message.payload, "Failed to write confirmed chat log to D1.");
    if (context) {
      context.ctx.waitUntil(enqueueChatLog(context.queue, message));
    }
    return {
      log_event_id: message.event_id,
      created_at: message.created_at,
      d1_write_ok: d1WriteOk,
    };
  }

  if (context) {
    context.ctx.waitUntil(enqueueWithD1Fallback(context.queue, message));
    return {
      log_event_id: message.event_id,
      created_at: message.created_at,
      d1_write_ok: null,
    };
  }

  const d1WriteOk = await writeD1Log(message.payload, "Failed to write direct chat log to D1.");
  return {
    log_event_id: message.event_id,
    created_at: message.created_at,
    d1_write_ok: d1WriteOk,
  };
}
