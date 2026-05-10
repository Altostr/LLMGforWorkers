import { gatewayDb, type DbKey, type DbUser } from "@/lib/db";
import { parseBearerToken } from "@/lib/http";
import { getNoAuthContext, isAuthDisabled } from "@/lib/no-auth";

export type ApiKeyContext = {
  key: DbKey;
  user: DbUser;
};

export type ApiKeyAuthResult =
  | { ok: true; context: ApiKeyContext }
  | { ok: false; reason: "missing" | "invalid" };

export async function checkApiKeyAuth(request: Request): Promise<ApiKeyAuthResult> {
  if (isAuthDisabled()) {
    return { ok: true, context: await getNoAuthContext() };
  }

  const raw = request.headers.get("x-api-key") ?? parseBearerToken(request.headers.get("authorization"));
  if (!raw) return { ok: false, reason: "missing" };

  const key = await gatewayDb.get<DbKey>(
    "SELECT * FROM keys WHERE key = ? AND enabled = 1 AND deleted_at IS NULL",
    raw,
  );

  if (!key) return { ok: false, reason: "invalid" };

  const user = await gatewayDb.get<DbUser>(
    "SELECT * FROM users WHERE id = ? AND enabled = 1 AND deleted_at IS NULL",
    key.user_id,
  );

  if (!user) return { ok: false, reason: "invalid" };
  return { ok: true, context: { key, user } };
}

export async function requireApiKey(request: Request): Promise<ApiKeyContext | null> {
  const result = await checkApiKeyAuth(request);
  if (!result.ok) return null;
  return result.context;
}
