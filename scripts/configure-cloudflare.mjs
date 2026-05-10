import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const configPath = path.join(process.cwd(), "wrangler.jsonc");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const isGithubActions = process.env.GITHUB_ACTIONS === "true";
const errors = [];
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function value(name, fallback) {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : fallback;
}

function requireEnvInCi(name) {
  if (isGithubActions && !process.env[name]?.trim()) {
    errors.push(`${name} is required for GitHub Actions deployment.`);
  }
}

function runWrangler(args, options = {}) {
  const result = spawnSync(npx, ["wrangler", ...args], {
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

  if (/already exists|already been taken|exists/i.test(result.combined)) {
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

requireEnvInCi("CLOUDFLARE_ACCOUNT_ID");
requireEnvInCi("CLOUDFLARE_API_TOKEN");
requireEnvInCi("JWT_ACCESS_SECRET");
requireEnvInCi("JWT_REFRESH_SECRET");

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

const workerName = value("CF_WORKER_NAME", config.name ?? "model-gate");
const d1Database = config.d1_databases?.[0] ?? {};
const d1DatabaseName = value("CF_D1_DATABASE_NAME", d1Database.database_name ?? "model-gate");
const queueName = value("CF_LOG_QUEUE_NAME", config.queues?.producers?.[0]?.queue ?? "model-gate-chat-logs");
const dlqName = `${queueName}-dlq`;
const d1DatabaseId = ensureD1Database(d1DatabaseName);

ensureQueue(queueName);
ensureQueue(dlqName);

config.name = workerName;
config.services = (config.services ?? []).map((service) =>
  service.binding === "WORKER_SELF_REFERENCE"
    ? { ...service, service: workerName }
    : service,
);

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
      max_batch_size: 10,
      max_batch_timeout: 5,
      max_retries: 3,
    },
  ],
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
appendGithubEnv({
  CF_WORKER_NAME: workerName,
  CF_D1_DATABASE_NAME: d1DatabaseName,
  CF_LOG_QUEUE_NAME: queueName,
});
console.log(`Configured Cloudflare worker "${workerName}" with D1 "${d1DatabaseName}" and queue "${queueName}".`);
