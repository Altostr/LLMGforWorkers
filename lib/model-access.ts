import { gatewayDb, type DbUser } from "@/lib/db";
import { getUserGroup } from "@/lib/effective-limits";

export function parseAllowedModelAliases(raw: string | null | undefined) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function stringifyAllowedModelAliases(aliases: string[]) {
  const normalized = [...new Set(aliases.map((item) => item.trim()).filter(Boolean))].sort();
  return JSON.stringify(normalized);
}

export async function getEffectiveAllowedAliases(user: Pick<DbUser, "group_id" | "allowed_model_aliases">): Promise<string[]> {
  const userAliases = parseAllowedModelAliases(user.allowed_model_aliases);
  const group = await getUserGroup(user.group_id ?? null);
  if (!group) return userAliases;
  const groupAliases = parseAllowedModelAliases(group.allowed_model_aliases);
  return [...new Set([...userAliases, ...groupAliases])];
}

export async function canUserAccessModelAlias(user: Pick<DbUser, "role" | "group_id" | "allowed_model_aliases">, alias: string) {
  if (user.role === "admin") return true;

  const model = await gatewayDb.get<{ is_public: number }>(
    `SELECT is_public
     FROM models
     WHERE alias = ? AND enabled = 1 AND deleted_at IS NULL
     LIMIT 1`,
    alias,
  );

  if (!model) return false;
  if (model.is_public === 1) return true;

  return (await getEffectiveAllowedAliases(user)).includes(alias);
}

export async function hasEnabledModelAlias(alias: string) {
  const row = await gatewayDb.get<{ 1: number }>(
    `SELECT 1
     FROM models m
     JOIN channels c ON c.id = m.channel_id
     WHERE m.alias = ?
       AND m.enabled = 1
       AND c.enabled = 1
       AND m.deleted_at IS NULL
     LIMIT 1`,
    alias,
  );

  return Boolean(row);
}

export async function resolveAccessibleModelAlias(
  user: Pick<DbUser, "role" | "group_id" | "allowed_model_aliases">,
  requestedAlias: string,
): Promise<{ ok: true; alias: string } | { ok: false; reason: "not_found" | "forbidden" }> {
  const requestedAliasExists = await hasEnabledModelAlias(requestedAlias);
  if (requestedAliasExists && (await canUserAccessModelAlias(user, requestedAlias))) {
    return { ok: true, alias: requestedAlias };
  }

  const wildcardAliasExists = await hasEnabledModelAlias("*");
  if (wildcardAliasExists && (await canUserAccessModelAlias(user, "*"))) {
    return { ok: true, alias: "*" };
  }

  return requestedAliasExists ? { ok: false, reason: "forbidden" } : { ok: false, reason: "not_found" };
}

export async function listAccessibleModelAliases(user: Pick<DbUser, "role" | "group_id" | "allowed_model_aliases">) {
  const rows = await gatewayDb.all<{ alias: string; is_public: number }>(
    `SELECT DISTINCT m.alias, m.is_public
     FROM models m
     JOIN channels c ON c.id = m.channel_id
     WHERE m.enabled = 1
       AND c.enabled = 1
       AND m.deleted_at IS NULL
       AND m.alias != '*'
     ORDER BY m.alias ASC`,
  );

  if (user.role === "admin") {
    return rows.map((row) => row.alias);
  }

  const allowed = new Set(await getEffectiveAllowedAliases(user));
  return rows.filter((row) => row.is_public === 1 || allowed.has(row.alias)).map((row) => row.alias);
}
