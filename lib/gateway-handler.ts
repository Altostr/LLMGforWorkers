import { checkApiKeyAuth } from "@/lib/api-key-auth";
import { acquireChannel } from "@/lib/channel-runtime";
import { insertChatLog } from "@/lib/chat-log";
import { gatewayDb } from "@/lib/db";
import { getEffectiveLimits } from "@/lib/effective-limits";
import { jsonError } from "@/lib/http";
import { resolveAccessibleModelAlias } from "@/lib/model-access";
import {
  adaptRequestBody,
  adaptResponseBody,
  countPromptTokensForProtocol,
  createTransformedStream,
  estimateRequestTokensForProtocol,
  extractCompletionTextFromBody,
  getStreamFlag,
  getUsageFromBody,
} from "@/lib/openai-adapter";
import { fetchUpstreamRequest } from "@/lib/proxy";
import { checkUserRateLimit } from "@/lib/ratelimit";
import { selectModelRoute, type RoutedModel } from "@/lib/router";
import { getGatewaySettings } from "@/lib/settings";
import { countTextTokens } from "@/lib/tokenizer";
import type { GatewayProtocol } from "@/lib/protocols";

type QuotaInfo = {
  remaining_requests: number | null;
  remaining_tokens: number | null;
};

type PickedRoute =
  | {
      ok: true;
      route: RoutedModel;
      upstream: Response;
      attemptedChannels: number[];
      attemptedChannelNames: string[];
      lease: { complete: (result: { ok: boolean; latencyMs: number }) => void };
    }
  | {
      ok: false;
      route: RoutedModel | null;
      attemptedChannels: number[];
      attemptedChannelNames: string[];
    };

const RETRYABLE_UPSTREAM_STATUS = new Set([401, 429, 500, 502, 503, 504]);

function appendQuotaHeaders(headers: Record<string, string>, quota: QuotaInfo) {
  if (quota.remaining_requests !== null) {
    headers["X-Quota-Limit-Requests-Remaining"] = String(quota.remaining_requests);
  }
  if (quota.remaining_tokens !== null) {
    headers["X-Quota-Limit-Tokens-Remaining"] = String(quota.remaining_tokens);
  }
}

async function checkQuota(userId: number, estimatedTokens: number): Promise<
  | { ok: false; reason: string; quota?: QuotaInfo }
  | { ok: true; quota: QuotaInfo }
> {
  const user = await gatewayDb.get<{
    id: number;
    group_id: number | null;
    quota_tokens: number | null;
    quota_requests: number | null;
    used_tokens: number;
    used_requests: number;
    rpm: number;
    qps: number;
    tpm: number;
  }>(
    `SELECT id, group_id, quota_tokens, quota_requests, used_tokens, used_requests,
            rpm, qps, tpm
     FROM users
     WHERE id = ? AND deleted_at IS NULL`,
    userId,
  );

  if (!user) return { ok: false, reason: "User does not exist." };

  const limits = await getEffectiveLimits(user as any);
  const quota: QuotaInfo = {
    remaining_requests: limits.quota_requests !== null ? Math.max(0, limits.quota_requests - user.used_requests) : null,
    remaining_tokens: limits.quota_tokens !== null ? Math.max(0, limits.quota_tokens - user.used_tokens) : null,
  };

  if (limits.quota_requests !== null && user.used_requests >= limits.quota_requests) {
    return { ok: false, reason: "Request quota exhausted.", quota };
  }

  if (limits.quota_tokens !== null && user.used_tokens + estimatedTokens > limits.quota_tokens) {
    return { ok: false, reason: "Token quota exhausted.", quota };
  }

  return { ok: true, quota };
}

async function addUsage(userId: number, keyId: number, tokens: number, requests = 1) {
  await gatewayDb.batch([
    {
      sql: `UPDATE users
            SET used_tokens = used_tokens + ?, used_requests = used_requests + ?
            WHERE id = ? AND deleted_at IS NULL`,
      params: [tokens, requests, userId],
    },
    {
      sql: `UPDATE keys
            SET used_tokens = used_tokens + ?, used_requests = used_requests + ?
            WHERE id = ? AND deleted_at IS NULL`,
      params: [tokens, requests, keyId],
    },
  ]);
}

function shouldRetryUpstreamStatus(status: number) {
  return RETRYABLE_UPSTREAM_STATUS.has(status);
}

function parseUpstreamError(text: string, status: number) {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error && typeof parsed.error === "object" ? parsed.error as Record<string, unknown> : null;
    const message =
      (typeof error?.message === "string" ? error.message : null)
      ?? (typeof parsed.message === "string" ? parsed.message : null)
      ?? text.trim()
      ?? `Upstream request failed (${status})`;
    const type =
      (typeof error?.type === "string" ? error.type : null)
      ?? (typeof parsed.type === "string" ? parsed.type : null)
      ?? "upstream_error";
    const code =
      (typeof error?.code === "string" || typeof error?.code === "number" ? error.code : null)
      ?? status;
    return { message, type, code };
  } catch {
    return { message: text.trim() || `Upstream request failed (${status})`, type: "upstream_error", code: status };
  }
}

function buildErrorResponseBody(message: string, status: number, inboundProtocol: GatewayProtocol, type?: string, code?: string | number) {
  if (inboundProtocol === "anthropic_messages") {
    return JSON.stringify({
      type: "error",
      error: {
        type: type ?? "api_error",
        message,
      },
    });
  }

  return JSON.stringify({
    error: {
      message,
      type: type ?? (status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error"),
      param: "None",
      code: String(code ?? status),
    },
  });
}

export async function handleGatewayProtocolRequest(request: Request, inboundProtocol: GatewayProtocol) {
  const startedAt = Date.now();
  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || null;

  const authResult = await checkApiKeyAuth(request);
  if (!authResult.ok) {
    return jsonError(authResult.reason === "missing" ? "Missing API key." : "Invalid or disabled API key.", 401, {
      type: "auth_error",
      param: "None",
      code: "401",
    });
  }
  const auth = authResult.context;

  const logRejected = async (statusCode: number, message: string, alias: string | null, estimatedTokens?: number) => {
    await insertChatLog({
      user_id: auth.user.id,
      key_id: auth.key.id,
      channel_id: null,
      model_alias: alias,
      real_model: null,
      stream: false,
      status_code: statusCode,
      estimated_tokens: estimatedTokens ?? null,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      latency_ms: Date.now() - startedAt,
      error_message: message,
      client_ip: clientIp,
    });
  };

  const contentLength = parseInt(request.headers.get("content-length") || "0");
  if (contentLength > 10 * 1024 * 1024) {
    await logRejected(413, "Request body is too large.", null);
    return jsonError("Request body is too large.", 413);
  }

  const rawBody = await request.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") {
    await logRejected(400, "Invalid request body.", null);
    return jsonError("Invalid request body.", 400);
  }

  const body = rawBody as Record<string, unknown>;
  const alias = body.model;
  if (typeof alias !== "string" || alias.length === 0) {
    await logRejected(400, "Missing model parameter.", null);
    return jsonError("Missing model parameter.", 400);
  }

  const estimatedTokens = estimateRequestTokensForProtocol(body, inboundProtocol);
  const resolved = await resolveAccessibleModelAlias(auth.user, alias);
  if (!resolved.ok) {
    const message = resolved.reason === "forbidden" ? "Current user cannot access this model." : "Model alias not found or disabled.";
    await logRejected(resolved.reason === "forbidden" ? 403 : 404, message, alias, estimatedTokens);
    return jsonError(message, resolved.reason === "forbidden" ? 403 : 404);
  }

  const quotaResult = await checkQuota(auth.user.id, estimatedTokens);
  if (!quotaResult.ok) {
    await logRejected(429, quotaResult.reason, alias, estimatedTokens);
    const headers: Record<string, string> = {};
    if (quotaResult.quota) appendQuotaHeaders(headers, quotaResult.quota);
    return jsonError(quotaResult.reason, 429, undefined, headers);
  }

  const quotaHeaders: Record<string, string> = {};
  appendQuotaHeaders(quotaHeaders, quotaResult.quota);
  const withQuotaHeaders = (resp: Response): Response => {
    for (const [k, v] of Object.entries(quotaHeaders)) {
      resp.headers.set(k, v);
    }
    return resp;
  };

  const rate = await checkUserRateLimit(auth.user, estimatedTokens);
  if (!rate.ok) {
    await logRejected(429, rate.reason, alias, estimatedTokens);
    return jsonError(rate.reason, 429);
  }

  const settings = await getGatewaySettings();
  const circuitBreakerEnabled = settings.upstream_circuit_breaker_enabled === 1;
  const retryEnabled = settings.upstream_retry_enabled === 1;
  const maxRouteAttempts = retryEnabled ? Math.max(1, settings.upstream_retry_max_attempts) : 1;
  const stream = getStreamFlag(body);

  const pickRoute = async (): Promise<PickedRoute> => {
    const attemptedChannels = new Set<number>();
    const attemptedChannelNames: string[] = [];
    let lastRoute: RoutedModel | null = null;

    for (let attempt = 0; attempt < maxRouteAttempts; attempt += 1) {
      const route = await selectModelRoute(resolved.alias, {
        excludeChannelIds: [...attemptedChannels],
        circuitBreakerEnabled,
      });
      if (!route) break;

      lastRoute = route;
      attemptedChannels.add(route.channel.id);
      attemptedChannelNames.push(route.channel.name);

      const leaseResult = await Promise.resolve(
        acquireChannel(route.channel.id, route.channel.max_concurrency, request.signal, { circuitBreakerEnabled }),
      );
      if (!leaseResult.ok) continue;

      const lease = leaseResult.lease;
      try {
        const upstreamBody = adaptRequestBody(body, inboundProtocol, route.model.upstream_protocol, route.model.real_model);
        const upstream = await fetchUpstreamRequest(route, upstreamBody, route.model.upstream_protocol);
        if (shouldRetryUpstreamStatus(upstream.status) && attempt < maxRouteAttempts - 1) {
          lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
          continue;
        }

        return {
          ok: true,
          route,
          upstream,
          lease,
          attemptedChannels: [...attemptedChannels],
          attemptedChannelNames,
        };
      } catch {
        lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
      }
    }

    return {
      ok: false,
      route: lastRoute,
      attemptedChannels: [...attemptedChannels],
      attemptedChannelNames,
    };
  };

  const picked = await pickRoute();
  if (!picked.ok) {
    await insertChatLog({
      user_id: auth.user.id,
      key_id: auth.key.id,
      channel_id: picked.route?.channel.id ?? null,
      model_alias: alias,
      real_model: picked.route?.model.real_model ?? null,
      stream,
      status_code: 502,
      estimated_tokens: estimatedTokens,
      prompt_tokens: null,
      completion_tokens: 0,
      total_tokens: estimatedTokens,
      latency_ms: Date.now() - startedAt,
      first_token_latency_ms: null,
      output_tps: null,
      route_attempts: Math.max(1, picked.attemptedChannels.length),
      attempted_channels: picked.attemptedChannelNames.join(" -> "),
      error_message: "Upstream request failed.",
      client_ip: clientIp,
    });
    return withQuotaHeaders(jsonError("Upstream request failed.", 502, {
      type: "upstream_error",
      param: "None",
      code: "502",
    }));
  }

  const { route, upstream, lease, attemptedChannels, attemptedChannelNames } = picked;
  const localPromptTokens = countPromptTokensForProtocol(body, inboundProtocol, route.model.real_model);

  if (stream) {
    if (upstream.status >= 400) {
      const text = await upstream.text().catch(() => "");
      const upstreamError = parseUpstreamError(text, upstream.status);
      lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
      await insertChatLog({
        user_id: auth.user.id,
        key_id: auth.key.id,
        channel_id: route.channel.id,
        model_alias: alias,
        real_model: route.model.real_model,
        stream: true,
        status_code: upstream.status,
        estimated_tokens: estimatedTokens,
        prompt_tokens: localPromptTokens,
        completion_tokens: 0,
        total_tokens: localPromptTokens,
        latency_ms: Date.now() - startedAt,
        first_token_latency_ms: null,
        output_tps: null,
        route_attempts: Math.max(1, attemptedChannels.length),
        attempted_channels: attemptedChannelNames.join(" -> "),
        error_message: upstreamError.message,
        client_ip: clientIp,
      });
      const errorBody = route.model.upstream_protocol === inboundProtocol
        ? text
        : buildErrorResponseBody(upstreamError.message, upstream.status, inboundProtocol, upstreamError.type, upstreamError.code);
      return withQuotaHeaders(new Response(errorBody, {
        status: upstream.status,
        headers: { "content-type": "application/json" },
      }));
    }

    if (!upstream.body) {
      const rawText = await upstream.text().catch(() => "");
      const adaptedText = adaptResponseBody(rawText, route.model.upstream_protocol, inboundProtocol);
      const usage = getUsageFromBody(rawText, route.model.upstream_protocol);
      const completionText = extractCompletionTextFromBody(rawText, route.model.upstream_protocol);
      const completionTokens = usage?.completion_tokens ?? Math.max(0, countTextTokens(completionText, route.model.real_model));
      const totalTokens = usage?.total_tokens ?? localPromptTokens + completionTokens;
      const outputTps =
        completionTokens > 0 ? Number(((completionTokens * 1000) / Math.max(1, Date.now() - startedAt)).toFixed(2)) : null;

      lease.complete({ ok: true, latencyMs: Date.now() - startedAt });
      await addUsage(auth.user.id, auth.key.id, Math.max(1, totalTokens), 1);
      await insertChatLog({
        user_id: auth.user.id,
        key_id: auth.key.id,
        channel_id: route.channel.id,
        model_alias: alias,
        real_model: route.model.real_model,
        stream: true,
        status_code: upstream.status,
        estimated_tokens: estimatedTokens,
        prompt_tokens: usage?.prompt_tokens ?? localPromptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        latency_ms: Date.now() - startedAt,
        first_token_latency_ms: null,
        output_tps: outputTps,
        route_attempts: Math.max(1, attemptedChannels.length),
        attempted_channels: attemptedChannelNames.join(" -> "),
        error_message: null,
        client_ip: clientIp,
      });

      return withQuotaHeaders(new Response(adaptedText, {
        status: upstream.status,
        headers: { "content-type": "application/json" },
      }));
    }

    const transformed = createTransformedStream(upstream.body, route.model.upstream_protocol, inboundProtocol);
    let finalized = false;
    const finalize = async () => {
      if (finalized) return;
      finalized = true;
      const totalLatencyMs = Date.now() - startedAt;
      const success = upstream.status < 400;
      lease.complete({ ok: success, latencyMs: totalLatencyMs });
      const actualCompletionTokens = success ? Math.max(0, countTextTokens(transformed.completionText(), route.model.real_model)) : 0;
      const actualTotalTokens = localPromptTokens + actualCompletionTokens;
      const outputTps =
        success && actualCompletionTokens > 0
          ? Number(((actualCompletionTokens * 1000) / Math.max(1, totalLatencyMs)).toFixed(2))
          : null;
      const firstTokenAt = transformed.firstTokenAt();
      const firstTokenLatencyMs = firstTokenAt !== null ? Math.max(0, firstTokenAt - startedAt) : null;

      if (success) {
        await addUsage(auth.user.id, auth.key.id, Math.max(1, actualTotalTokens), 1);
      }

      await insertChatLog({
        user_id: auth.user.id,
        key_id: auth.key.id,
        channel_id: route.channel.id,
        model_alias: alias,
        real_model: route.model.real_model,
        stream: true,
        status_code: upstream.status,
        estimated_tokens: estimatedTokens,
        prompt_tokens: localPromptTokens,
        completion_tokens: actualCompletionTokens,
        total_tokens: actualTotalTokens,
        latency_ms: totalLatencyMs,
        first_token_latency_ms: firstTokenLatencyMs,
        output_tps: outputTps,
        route_attempts: Math.max(1, attemptedChannels.length),
        attempted_channels: attemptedChannelNames.join(" -> "),
        error_message: success ? null : `Upstream stream failed: ${upstream.status}`,
        client_ip: clientIp,
      });
    };

    const wrapped = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = transformed.stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          await finalize();
        }
      },
      cancel() {
        return finalize();
      },
    });

    return withQuotaHeaders(new Response(wrapped, {
      status: upstream.status,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": upstream.headers.get("cache-control") ?? "no-cache",
      },
    }));
  }

  const rawText = await upstream.text().catch(() => "");
  if (upstream.status >= 400) {
    const upstreamError = parseUpstreamError(rawText, upstream.status);
    lease.complete({ ok: false, latencyMs: Date.now() - startedAt });
    await insertChatLog({
      user_id: auth.user.id,
      key_id: auth.key.id,
      channel_id: route.channel.id,
      model_alias: alias,
      real_model: route.model.real_model,
      stream: false,
      status_code: upstream.status,
      estimated_tokens: estimatedTokens,
      prompt_tokens: localPromptTokens,
      completion_tokens: 0,
      total_tokens: localPromptTokens,
      latency_ms: Date.now() - startedAt,
      output_tps: null,
      route_attempts: Math.max(1, attemptedChannels.length),
      attempted_channels: attemptedChannelNames.join(" -> "),
      error_message: upstreamError.message,
      client_ip: clientIp,
    });
    const errorBody = route.model.upstream_protocol === inboundProtocol
      ? rawText
      : buildErrorResponseBody(upstreamError.message, upstream.status, inboundProtocol, upstreamError.type, upstreamError.code);
    return withQuotaHeaders(new Response(errorBody, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    }));
  }

  const adaptedText = adaptResponseBody(rawText, route.model.upstream_protocol, inboundProtocol);
  const usage = getUsageFromBody(rawText, route.model.upstream_protocol);
  const completionText = extractCompletionTextFromBody(rawText, route.model.upstream_protocol);
  const localCompletionTokens = usage?.completion_tokens ?? Math.max(0, countTextTokens(completionText, route.model.real_model));
  const localTotalTokens = usage?.total_tokens ?? localPromptTokens + localCompletionTokens;
  const outputTps =
    localCompletionTokens > 0
      ? Number(((localCompletionTokens * 1000) / Math.max(1, Date.now() - startedAt)).toFixed(2))
      : null;

  lease.complete({ ok: true, latencyMs: Date.now() - startedAt });
  await addUsage(auth.user.id, auth.key.id, Math.max(1, localTotalTokens), 1);
  await insertChatLog({
    user_id: auth.user.id,
    key_id: auth.key.id,
    channel_id: route.channel.id,
    model_alias: alias,
    real_model: route.model.real_model,
    stream: false,
    status_code: upstream.status,
    estimated_tokens: estimatedTokens,
    prompt_tokens: usage?.prompt_tokens ?? localPromptTokens,
    completion_tokens: localCompletionTokens,
    total_tokens: localTotalTokens,
    latency_ms: Date.now() - startedAt,
    output_tps: outputTps,
    route_attempts: Math.max(1, attemptedChannels.length),
    attempted_channels: attemptedChannelNames.join(" -> "),
    error_message: null,
    client_ip: clientIp,
  });

  return withQuotaHeaders(new Response(adaptedText, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    },
  }));
}
