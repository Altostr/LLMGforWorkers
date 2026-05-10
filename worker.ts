// OpenNext generates this file during `opennextjs-cloudflare build`.
// @ts-ignore
import nextWorker from "./.open-next/worker.js";
import { processChatLogQueueBatch, type QueueBatchLike, type QueueEnvLike } from "./lib/chat-log-queue";

type FetchHandlerLike = {
  fetch(request: Request, env: Record<string, unknown>, ctx: unknown): Promise<Response> | Response;
};

const handler = nextWorker as FetchHandlerLike;

export default {
  fetch(request: Request, env: Record<string, unknown>, ctx: unknown) {
    return handler.fetch(request, env, ctx);
  },
  async queue(batch: QueueBatchLike, env: QueueEnvLike) {
    await processChatLogQueueBatch(batch, env);
  },
};
