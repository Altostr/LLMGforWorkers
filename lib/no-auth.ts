import { randomBytes } from "node:crypto";
import { gatewayDb, type DbKey, type DbUser } from "@/lib/db";
import { getRuntimeEnvFlag } from "@/lib/runtime-env";

export function isAuthDisabled() {
  return getRuntimeEnvFlag("AUTH_DISABLED");
}

const NOAUTH_USERNAME = "noauth";

let cached: { user: DbUser; key: DbKey } | null = null;

export async function getNoAuthContext(): Promise<{ user: DbUser; key: DbKey }> {
  if (!isAuthDisabled()) throw new Error("AUTH_DISABLED is not set");
  if (cached) return cached;

  let user = await gatewayDb.get<DbUser>(
    "SELECT * FROM users WHERE username = ? AND deleted_at IS NULL",
    NOAUTH_USERNAME,
  );

  if (!user) {
    const defaultGroup = await gatewayDb.get<{ id: number }>(
      "SELECT id FROM groups WHERE is_default = 1 AND deleted_at IS NULL",
    );

    await gatewayDb.run(
      `INSERT INTO users (username, password_hash, role, group_id, rpm, qps, tpm, enabled)
       VALUES (?, ?, 'admin', ?, -1, -1, -1, 1)`,
      NOAUTH_USERNAME,
      "noauth-no-password-login",
      defaultGroup?.id ?? null,
    );

    user = await gatewayDb.get<DbUser>(
      "SELECT * FROM users WHERE username = ? AND deleted_at IS NULL",
      NOAUTH_USERNAME,
    ) as DbUser;
  }

  let key = await gatewayDb.get<DbKey>(
    "SELECT * FROM keys WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL",
    user.id,
  );

  if (!key) {
    const keyValue = `sk-gw-noauth-${randomBytes(16).toString("hex")}`;
    await gatewayDb.run("INSERT INTO keys (key, user_id, enabled) VALUES (?, ?, 1)", keyValue, user.id);

    key = await gatewayDb.get<DbKey>(
      "SELECT * FROM keys WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL",
      user.id,
    ) as DbKey;
  }

  cached = { user, key };
  return cached;
}
