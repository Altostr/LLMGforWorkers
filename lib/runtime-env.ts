import { getCloudflareContext } from "@opennextjs/cloudflare";

type CloudflareContextLike = {
  env?: Record<string, unknown>;
};

export function getRuntimeEnvValue(key: string): string | undefined {
  const processValue = process.env[key];
  if (processValue !== undefined && processValue !== "") return processValue;

  try {
    const context = getCloudflareContext() as CloudflareContextLike;
    const value = context.env?.[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  } catch {
    return undefined;
  }

  return undefined;
}

export function getRuntimeEnvFlag(key: string) {
  const value = getRuntimeEnvValue(key)?.toLowerCase();
  return value === "1" || value === "true";
}
