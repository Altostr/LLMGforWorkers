import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createChatLogQueueMessage, type ChatLogQueueMessage } from "@/lib/chat-log-queue";
import { createLog, type CreateLogInput } from "@/lib/data/repositories/log-repository";

export type ChatLogInput = CreateLogInput;

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

async function writeFallbackLog(input: ChatLogInput) {
  try {
    await createLog(input);
  } catch (error) {
    console.error("Failed to write fallback chat log to D1.", {
      log_event_id: input.log_event_id,
      error,
    });
  }
}

async function enqueueWithD1Fallback(queue: QueueProducerLike, input: ChatLogInput) {
  const message = createChatLogQueueMessage(input);

  await Promise.allSettled([
    enqueueChatLog(queue, message),
    writeFallbackLog(message.payload),
  ]);
}

export async function insertChatLog(input: ChatLogInput) {
  const context = getCloudflareQueueContext();
  if (context) {
    context.ctx.waitUntil(enqueueWithD1Fallback(context.queue, input));
    return;
  }

  await createLog(input);
}
