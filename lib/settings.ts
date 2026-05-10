import { gatewayDb } from "@/lib/db";

const DEFAULTS = {
  registration_enabled: 1,
  upstream_retry_enabled: 1,
  upstream_retry_max_attempts: 3,
  upstream_circuit_breaker_enabled: 1,
} as const;

export type GatewaySettings = {
  registration_enabled: number;
  password_login_enabled: number;
  upstream_retry_enabled: number;
  upstream_retry_max_attempts: number;
  upstream_circuit_breaker_enabled: number;
  public_base_url: string;
};

function positiveInt(value: string | null | undefined, fallback: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(1, Math.trunc(num));
}

const GATEWAY_KEYS = [
  "registration_enabled",
  "password_login_enabled",
  "upstream_retry_enabled",
  "upstream_retry_max_attempts",
  "upstream_circuit_breaker_enabled",
  "public_base_url",
] as const;

export async function getGatewaySettings(): Promise<GatewaySettings> {
  const placeholders = GATEWAY_KEYS.map(() => "?").join(", ");
  const rows = await gatewayDb.all<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE key IN (${placeholders})`,
    ...GATEWAY_KEYS,
  );

  const map = new Map(rows.map((row) => [row.key, row.value]));

  return {
    registration_enabled: map.get("registration_enabled") === "0" ? 0 : 1,
    password_login_enabled: map.get("password_login_enabled") === "0" ? 0 : 1,
    upstream_retry_enabled: map.get("upstream_retry_enabled") === "0" ? 0 : 1,
    upstream_circuit_breaker_enabled: map.get("upstream_circuit_breaker_enabled") === "0" ? 0 : 1,
    upstream_retry_max_attempts: positiveInt(
      map.get("upstream_retry_max_attempts"),
      DEFAULTS.upstream_retry_max_attempts,
    ),
    public_base_url: map.get("public_base_url") ?? "",
  };
}

export async function setGatewaySettings(input: {
  registration_enabled: boolean;
  password_login_enabled: boolean;
  upstream_retry_enabled: boolean;
  upstream_retry_max_attempts: number;
  upstream_circuit_breaker_enabled: boolean;
  public_base_url?: string;
}) {
  const values: Record<string, string> = {
    registration_enabled: input.registration_enabled ? "1" : "0",
    password_login_enabled: input.password_login_enabled ? "1" : "0",
    upstream_retry_enabled: input.upstream_retry_enabled ? "1" : "0",
    upstream_circuit_breaker_enabled: input.upstream_circuit_breaker_enabled ? "1" : "0",
    upstream_retry_max_attempts: String(Math.max(1, Math.trunc(input.upstream_retry_max_attempts))),
  };

  if (input.public_base_url !== undefined) values.public_base_url = input.public_base_url.trim().replace(/\/+$/, "");

  const sql = `INSERT INTO settings (key, value, updated_at)
               VALUES (?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(key) DO UPDATE SET
                 value = excluded.value,
                 updated_at = CURRENT_TIMESTAMP`;

  await gatewayDb.batch(Object.entries(values).map(([key, val]) => ({
    sql,
    params: [key, val],
  })));
}
