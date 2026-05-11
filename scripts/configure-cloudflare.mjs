import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const configPath = path.join(process.cwd(), "wrangler.jsonc");
const config = readJsonc(configPath);
const isGithubActions = process.env.GITHUB_ACTIONS === "true";
const errors = [];

function stripJsonComments(input) {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      } else if (char === "\n" || char === "\r") {
        output += char;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function readJsonc(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(stripJsonComments(raw));
  } catch (error) {
    throw new Error(`Could not parse ${path.basename(filePath)}: ${error.message}`);
  }
}

function getWranglerInvocation(args) {
  const localWrangler = path.join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
  if (fs.existsSync(localWrangler)) {
    return { command: process.execPath, args: [localWrangler, ...args] };
  }

  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  return { command: npx, args: ["wrangler", ...args] };
}

function hasEnv(name) {
  return Boolean(process.env[name]?.trim());
}

function envString(name, fallback) {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : fallback;
}

function envBoolean(name, fallback) {
  if (!hasEnv(name)) return fallback;

  const normalized = process.env[name].trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;

  errors.push(`${name} must be a boolean value: true/false, 1/0, yes/no, or on/off.`);
  return fallback;
}

function envInteger(name, fallback, options = {}) {
  if (!hasEnv(name)) return fallback;

  const value = Number(process.env[name].trim());
  const min = options.min ?? Number.NEGATIVE_INFINITY;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  if (!Number.isInteger(value) || value < min || value > max) {
    const range = Number.isFinite(min) || Number.isFinite(max)
      ? ` between ${Number.isFinite(min) ? min : "-infinity"} and ${Number.isFinite(max) ? max : "infinity"}`
      : "";
    errors.push(`${name} must be an integer${range}.`);
    return fallback;
  }

  return value;
}

function envStringList(name, fallback) {
  if (!hasEnv(name)) return fallback;

  const raw = process.env[name].trim();
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      return parsed.map((item) => String(item).trim()).filter(Boolean);
    } catch {
      errors.push(`${name} must be a JSON string array or a comma-separated list.`);
      return fallback;
    }
  }

  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function requireEnvInCi(name) {
  if (isGithubActions && !hasEnv(name)) {
    errors.push(`${name} is required for GitHub Actions deployment.`);
  }
}

function runWrangler(args, options = {}) {
  const invocation = getWranglerInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const combined = `${stdout}\n${stderr}`.trim();

  if (result.status !== 0 && !options.allowFailure) {
    const reason = result.error?.message ? `${result.error.message}\n${combined}` : combined;
    throw new Error(`wrangler ${args.join(" ")} failed:\n${reason}`);
  }

  return {
    ok: result.status === 0,
    stdout,
    stderr,
    combined,
  };
}

function parseJsonOutput(output) {
  const trimmed = output.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {}

  const firstArray = trimmed.indexOf("[");
  const lastArray = trimmed.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) {
    try {
      return JSON.parse(trimmed.slice(firstArray, lastArray + 1));
    } catch {}
  }

  const firstObject = trimmed.indexOf("{");
  const lastObject = trimmed.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    try {
      return JSON.parse(trimmed.slice(firstObject, lastObject + 1));
    } catch {}
  }

  return null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.result)) return value.result;
  if (Array.isArray(value?.databases)) return value.databases;
  if (Array.isArray(value?.d1_databases)) return value.d1_databases;
  return [];
}

function getD1Name(row) {
  return row?.name ?? row?.database_name;
}

function getD1Id(row) {
  return row?.uuid ?? row?.id ?? row?.database_id;
}

function findD1IdInValue(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const uuid = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
    return uuid ?? null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findD1IdInValue(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    const direct = getD1Id(value);
    if (direct) return direct;
    for (const item of Object.values(value)) {
      const found = findD1IdInValue(item);
      if (found) return found;
    }
  }
  return null;
}

function parseD1CreateDatabaseId(output) {
  return findD1IdInValue(parseJsonOutput(output)) ?? findD1IdInValue(output);
}

function findD1ByName(rows, name) {
  return rows.find((row) => getD1Name(row) === name) ?? null;
}

function listD1Databases() {
  const output = runWrangler(["d1", "list", "--json"]).stdout;
  return asArray(parseJsonOutput(output));
}

function ensureD1Database(name) {
  let database = findD1ByName(listD1Databases(), name);
  if (database) {
    const databaseId = getD1Id(database);
    if (!databaseId) {
      throw new Error(`Found D1 database "${name}", but could not resolve its database_id from wrangler d1 list.`);
    }
    return databaseId;
  }

  console.log(`D1 database "${name}" does not exist; creating it.`);
  const createResult = runWrangler(["d1", "create", name], { allowFailure: false });
  const createdDatabaseId = parseD1CreateDatabaseId(createResult.combined);
  if (createdDatabaseId) {
    return createdDatabaseId;
  }

  database = findD1ByName(listD1Databases(), name);
  const databaseId = getD1Id(database);
  if (!databaseId) {
    throw new Error(`Created D1 database "${name}", but could not resolve its database_id from wrangler d1 list.`);
  }
  return databaseId;
}

function ensureQueue(name) {
  const result = runWrangler(["queues", "create", name], { allowFailure: true });
  if (result.ok) {
    console.log(`Created Cloudflare Queue "${name}".`);
    return;
  }

  if (/already exists|already (?:been )?taken|exists|\bcode:\s*11009\b/i.test(result.combined)) {
    console.log(`Cloudflare Queue "${name}" already exists.`);
    return;
  }

  throw new Error(`Could not ensure Cloudflare Queue "${name}":\n${result.combined}`);
}

function appendGithubEnv(values) {
  const githubEnvPath = process.env.GITHUB_ENV;
  if (!githubEnvPath) return;

  const lines = Object.entries(values).map(([key, val]) => `${key}=${val}`);
  fs.appendFileSync(githubEnvPath, `${lines.join("\n")}\n`);
}

function findBinding(items, binding) {
  return Array.isArray(items) ? items.find((item) => item?.binding === binding) : null;
}

function upsertBinding(items, binding, value) {
  const existing = Array.isArray(items) ? items : [];
  return [
    ...existing.filter((item) => item?.binding !== binding),
    { binding, ...value },
  ];
}

function firstCustomDomainRoute() {
  if (!Array.isArray(config.routes)) return null;
  return config.routes.find((route) => route?.custom_domain === true) ?? null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

requireEnvInCi("CLOUDFLARE_ACCOUNT_ID");
requireEnvInCi("CLOUDFLARE_API_TOKEN");
requireEnvInCi("JWT_ACCESS_SECRET");
requireEnvInCi("JWT_REFRESH_SECRET");
requireEnvInCi("CF_WORKER_NAME");
requireEnvInCi("CF_D1_DATABASE_NAME");
requireEnvInCi("CF_LOG_QUEUE_NAME");

const d1Database = findBinding(config.d1_databases, "DB") ?? config.d1_databases?.[0] ?? {};
const queueProducer = findBinding(config.queues?.producers, "LOG_QUEUE") ?? config.queues?.producers?.[0] ?? {};
const queueConsumer = config.queues?.consumers?.[0] ?? {};
const customDomainRoute = firstCustomDomainRoute();
const hasCustomDomainInput = hasEnv("CF_CUSTOM_DOMAIN_PATTERN") || hasEnv("CF_CUSTOM_DOMAIN_ZONE_NAME");

const workerName = envString("CF_WORKER_NAME", config.name ?? "api");
const d1DatabaseName = envString("CF_D1_DATABASE_NAME", d1Database.database_name ?? "altostrapi");
const explicitD1DatabaseId = envString("CF_D1_DATABASE_ID", null);
const queueName = envString("CF_LOG_QUEUE_NAME", queueProducer.queue ?? "altostrapi");
const dlqName = `${queueName}-dlq`;
const workersDev = envBoolean("CF_WORKERS_DEV", typeof config.workers_dev === "boolean" ? config.workers_dev : true);
const previewUrls = envBoolean("CF_PREVIEW_URLS", typeof config.preview_urls === "boolean" ? config.preview_urls : true);
const compatibilityDate = envString("CF_COMPATIBILITY_DATE", config.compatibility_date ?? "2026-05-10");
const compatibilityFlags = envStringList(
  "CF_COMPATIBILITY_FLAGS",
  Array.isArray(config.compatibility_flags) ? config.compatibility_flags : ["nodejs_compat", "global_fetch_strictly_public"],
);
const customDomainPattern = envString("CF_CUSTOM_DOMAIN_PATTERN", customDomainRoute?.pattern ?? "");
const customDomainZoneName = envString("CF_CUSTOM_DOMAIN_ZONE_NAME", customDomainRoute?.zone_name ?? "");
const customDomainEnabled = envBoolean("CF_CUSTOM_DOMAIN_ENABLED", Boolean(customDomainRoute) || hasCustomDomainInput);
const queueMaxBatchSize = envInteger("CF_LOG_QUEUE_MAX_BATCH_SIZE", queueConsumer.max_batch_size ?? 10, { min: 1 });
const queueMaxBatchTimeout = envInteger("CF_LOG_QUEUE_MAX_BATCH_TIMEOUT", queueConsumer.max_batch_timeout ?? 5, { min: 1 });
const queueMaxRetries = envInteger("CF_LOG_QUEUE_MAX_RETRIES", queueConsumer.max_retries ?? 3, { min: 0 });

if (explicitD1DatabaseId && !isUuid(explicitD1DatabaseId)) {
  errors.push("CF_D1_DATABASE_ID must be a D1 database UUID.");
}

if (customDomainEnabled && (!customDomainPattern || !customDomainZoneName)) {
  errors.push("CF_CUSTOM_DOMAIN_PATTERN and CF_CUSTOM_DOMAIN_ZONE_NAME are required when CF_CUSTOM_DOMAIN_ENABLED is true.");
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

const d1DatabaseId = explicitD1DatabaseId ?? ensureD1Database(d1DatabaseName);

ensureQueue(queueName);
ensureQueue(dlqName);

config.name = workerName;
config.workers_dev = workersDev;
config.preview_urls = previewUrls;
config.compatibility_date = compatibilityDate;
config.compatibility_flags = compatibilityFlags;
config.routes = customDomainEnabled
  ? [
      {
        pattern: customDomainPattern,
        custom_domain: true,
        zone_name: customDomainZoneName,
      },
    ]
  : [];
config.services = upsertBinding(config.services, "WORKER_SELF_REFERENCE", { service: workerName });
config.d1_databases = [
  {
    binding: "DB",
    database_name: d1DatabaseName,
    database_id: d1DatabaseId,
  },
];
config.queues = {
  producers: [
    {
      binding: "LOG_QUEUE",
      queue: queueName,
    },
  ],
  consumers: [
    {
      queue: queueName,
      dead_letter_queue: dlqName,
      max_batch_size: queueMaxBatchSize,
      max_batch_timeout: queueMaxBatchTimeout,
      max_retries: queueMaxRetries,
    },
  ],
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
appendGithubEnv({
  CF_WORKER_NAME: workerName,
  CF_D1_DATABASE_NAME: d1DatabaseName,
  CF_D1_DATABASE_ID: d1DatabaseId,
  CF_LOG_QUEUE_NAME: queueName,
  CF_WORKERS_DEV: String(workersDev),
  CF_PREVIEW_URLS: String(previewUrls),
  CF_COMPATIBILITY_DATE: compatibilityDate,
  CF_COMPATIBILITY_FLAGS: compatibilityFlags.join(","),
  CF_CUSTOM_DOMAIN_PATTERN: customDomainPattern,
  CF_CUSTOM_DOMAIN_ZONE_NAME: customDomainZoneName,
  CF_CUSTOM_DOMAIN_ENABLED: String(customDomainEnabled),
  CF_LOG_QUEUE_MAX_BATCH_SIZE: String(queueMaxBatchSize),
  CF_LOG_QUEUE_MAX_BATCH_TIMEOUT: String(queueMaxBatchTimeout),
  CF_LOG_QUEUE_MAX_RETRIES: String(queueMaxRetries),
});

console.log("Configured Cloudflare deployment:");
console.log(`- Worker: ${workerName}`);
console.log(`- D1: ${d1DatabaseName} (${d1DatabaseId})`);
console.log(`- Queue: ${queueName}; DLQ: ${dlqName}`);
console.log(`- workers_dev: ${workersDev}; preview_urls: ${previewUrls}`);
console.log(`- compatibility_date: ${compatibilityDate}; compatibility_flags: ${compatibilityFlags.join(",") || "(none)"}`);
console.log(
  customDomainEnabled
    ? `- Custom domain: ${customDomainPattern} (zone: ${customDomainZoneName})`
    : "- Custom domain: disabled",
);
console.log(
  `- Queue consumer: max_batch_size=${queueMaxBatchSize}, max_batch_timeout=${queueMaxBatchTimeout}, max_retries=${queueMaxRetries}`,
);
console.log("Wrangler config was generated for this workspace only; it was not committed.");
