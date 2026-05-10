# Cloudflare Workers + D1 + Queues

Local `next dev` and `next start` keep using `better-sqlite3` with `data/gateway.db`.

Workers deployment uses OpenNext, Cloudflare Workers, D1, Cloudflare Queues, and GitHub Actions.

## GitHub Actions Deployment

The workflow `.github/workflows/deploy-cloudflare.yml` deploys automatically on pushes to `main` and can also be started manually with `workflow_dispatch`.

Configure these GitHub Actions Secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`

Configure these GitHub Actions Variables:

- `CF_WORKER_NAME` (default: `model-gate`)
- `CF_D1_DATABASE_NAME` (default: `model-gate`)
- `CF_LOG_QUEUE_NAME` (default: `model-gate-chat-logs`)

The workflow runs `npm run cf:configure`, which creates or reuses the D1 database and writes the resolved `database_id` into the temporary CI `wrangler.jsonc`.

The DLQ name is derived from the queue name as `${CF_LOG_QUEUE_NAME}-dlq`.

The workflow runs:

```text
npm install
npm run cf:configure
npm run typecheck
npm run lint
npm run cf:build
npx wrangler d1 migrations apply "$CF_D1_DATABASE_NAME" --remote
wrangler deploy
```

## Local Preview And Manual Deploy

Install dependencies:

```bash
npm install
```

Local preview:

```bash
npm run d1:migrate:local
npm run preview
```

Manual remote deploy:

```bash
npm run d1:create
npm run queues:create
npm run queues:create:dlq
npx wrangler secret put JWT_ACCESS_SECRET
npx wrangler secret put JWT_REFRESH_SECRET
npm run d1:migrate:remote
npm run deploy
```

For local manual deploy, copy the D1 `database_id` returned by `wrangler d1 create` into `wrangler.jsonc`.

## Queues

Workers mode writes chat logs through the `LOG_QUEUE` binding. The queue consumer writes to D1 asynchronously and uses `log_event_id` to make retries idempotent.

Local `better-sqlite3` mode writes logs directly and does not require Queues.

D1 starts with the migrations in `migrations/`; existing local SQLite data is not imported automatically.
