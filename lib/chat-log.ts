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

async function enqueueOrFallback(queue: QueueProducerLike, input: ChatLogInput) {
  const message = createChatLogQueueMessage(input);
  try {
    await queue.send(message);
  } catch (error) {
    console.error("Failed to enqueue chat log; writing synchronously.", error);
    await createLog({
      ...input,
      log_event_id: message.event_id,
      created_at: message.created_at,
    });
  }
}

export async function insertChatLog(input: ChatLogInput) {
  const context = getCloudflareQueueContext();
  if (context) {
    context.ctx.waitUntil(enqueueOrFallback(context.queue, input));
    return;
  }

  await createLog(input);
}
