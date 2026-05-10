export const dynamic = "force-dynamic";

import { gatewayDb, type DbUser } from "@/lib/db";
import { getEffectiveLimits } from "@/lib/effective-limits";
import { ensureUser } from "@/lib/guards";
import { jsonOk } from "@/lib/http";

export async function GET(request: Request) {
  const guard = await ensureUser(request);
  if ("error" in guard) return guard.error;

  const userId = guard.auth.user.id;
  const user = await gatewayDb.get<DbUser>(`SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`, userId);

  if (!user) {
    return jsonOk({ error: "用户不存在" }, 404);
  }

  const limits = await getEffectiveLimits(user);

  return jsonOk({
    total: {
      quota_requests: limits.quota_requests,
      quota_tokens: limits.quota_tokens,
      used_requests: user.used_requests,
      used_tokens: user.used_tokens,
      remaining_requests: limits.quota_requests !== null ? Math.max(0, limits.quota_requests - user.used_requests) : null,
      remaining_tokens: limits.quota_tokens !== null ? Math.max(0, limits.quota_tokens - user.used_tokens) : null,
    },
    rate: {
      rpm: limits.rpm,
      qps: limits.qps,
      tpm: limits.tpm,
    },
  });
}
