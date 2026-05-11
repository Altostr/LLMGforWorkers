# LLMG for Workers

LLMG for Workers 是一个基于 Next.js 的 LLM 网关与管理面板，支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 风格接口，并提供用户、API Key、模型别名、渠道、限流、配额和请求日志管理。

本项目移植自源项目：[https://cnb.cool/Bring/Tools/ModelGate](https://cnb.cool/Bring/Tools/ModelGate)。

## 部署模式

- 本地模式：使用 `better-sqlite3`，数据库文件为 `data/gateway.db`。
- Cloudflare Workers 模式：使用 OpenNext + Cloudflare Workers，数据库使用 D1，日志通过 Cloudflare Queues 异步写入 D1。
- GitHub Actions：推送到 `main` 自动部署到 Cloudflare Workers，也支持手动触发。

## 本地开发

```bash
npm install
npm run dev
```

打开 `http://localhost:3000`，首次注册的用户会成为管理员。

常用命令：

```bash
npm run typecheck
npm run lint
npm run build
npm run start
```

本地数据位于 `data/gateway.db`，不会自动迁移到 Cloudflare D1。

## Cloudflare 首次准备

GitHub Actions 会在首次部署时自动创建或复用 D1 数据库、Queue 和 DLQ。资源名称来自 GitHub Actions Variables；未配置时使用 `wrangler.jsonc` 中的默认值。

本地手动创建资源仍可使用：

```bash
npm install
npm run d1:create
npm run queues:create
npm run queues:create:dlq
```

本地预览 Workers：

```bash
npm run d1:migrate:local
npm run preview
```

本地手动部署 Workers：

```bash
npx wrangler secret put JWT_ACCESS_SECRET
npx wrangler secret put JWT_REFRESH_SECRET
npm run d1:migrate:remote
npm run deploy
```

`npm run deploy` and `npm run upload` run `npm run cf:configure` first, so the Worker name, D1 database, Queue, DLQ, and `WORKER_SELF_REFERENCE` binding are refreshed before the build. The current production defaults are Worker `api`, D1 `altostrapi` (`8257a3ea-5b77-4256-aa42-b7e768873110`), and Queue `altostrapi`.

生产环境入口：

- 管理面板和 API 域名：`https://api.altostr.com`
- OpenAI/Anthropic 兼容 API Base URL：`https://api.altostr.com/api/v1`
- `api.altostr.com` 通过 `wrangler.jsonc` 的 custom domain route 绑定到 Worker `api`，不要只依赖 Cloudflare 面板里的临时配置。
- 客户端如果有单独的 Base URL 配置，只填写 `https://api.altostr.com/api/v1`；客户端会自动追加 `/chat/completions`、`/responses` 或 `/models`，不要配置成重复的 `/api/v1/api/v1/...` 路径。

## GitHub Actions 自动部署

工作流文件位于 `.github/workflows/deploy-cloudflare.yml`。

触发方式：

- push 到 `main`
- GitHub Actions 页面手动运行 `workflow_dispatch`

工作流会执行：

```text
npm install
npm run cf:configure
npm run typecheck
npm run lint
npm run cf:build
npx wrangler d1 migrations apply "$CF_D1_DATABASE_NAME" --remote
wrangler deploy
```

`npm run cf:configure` 会自动：

- 读取 `CF_WORKER_NAME`、`CF_D1_DATABASE_NAME`、`CF_LOG_QUEUE_NAME`
- 创建或复用同名 D1 数据库
- 创建或复用 Queue
- 创建或复用 DLQ，名称固定为 `${CF_LOG_QUEUE_NAME}-dlq`
- 把真实 D1 `database_id` 写入 CI 工作区内的 `wrangler.jsonc`

需要配置 GitHub Actions Secrets：

| Secret | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token，需要 Workers、D1、Queues 创建和部署权限 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `JWT_ACCESS_SECRET` | Access Token 签名密钥 |
| `JWT_REFRESH_SECRET` | Refresh Token 签名密钥 |

需要配置 GitHub Actions Variables：

| Variable | 示例 |
| --- | --- |
| `CF_WORKER_NAME` | `api` |
| `CF_D1_DATABASE_NAME` | `altostrapi` |
| `CF_LOG_QUEUE_NAME` | `altostrapi` |

D1 id 会由 GitHub Actions 自动创建或查询后写入临时部署配置，不需要手动配置。

## Cloudflare 运行时说明

- D1 binding：`DB`
- Queue producer binding：`LOG_QUEUE`
- Queue consumer：由 `CF_LOG_QUEUE_NAME` 决定
- Dead letter queue：`${CF_LOG_QUEUE_NAME}-dlq`
- Worker self reference binding：`WORKER_SELF_REFERENCE`
- Production custom domain：`api.altostr.com`

Workers 模式下，请求主路径仍同步完成认证、限流、配额扣减、路由和上游请求；chat logs 会进入 Cloudflare Queue 后异步写入 D1。日志表使用 `log_event_id` 做幂等，避免 Queue 重试产生重复日志。

Dashboard 统计和请求日志只展示经过本项目网关、并写入 `altostrapi.logs` 的请求。上游平台自己的统计不会自动导入；缺失或无效 API Key 的 401 请求会在认证阶段被拒绝，不计入业务请求日志。使用 Dashboard 新建的 `sk-gw-*` key 请求 `/api/v1/*` 后，日志页和首页统计才会更新。

## API 入口

兼容 OpenAI/Anthropic 风格：

```text
Base URL: https://api.altostr.com/api/v1
GET  /api/v1/models
POST /api/v1/chat/completions
POST /api/v1/responses
POST /api/v1/messages
```

认证方式：

```text
Authorization: Bearer sk-gw-...
x-api-key: sk-gw-...
```

快速验证：

```bash
curl https://api.altostr.com/api/v1/models \
  -H "Authorization: Bearer sk-gw-..."
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `JWT_ACCESS_SECRET` | 运行时随机值 | 生产必须设置 |
| `JWT_REFRESH_SECRET` | 运行时随机值 | 生产必须设置 |
| `JWT_ACCESS_EXPIRES_SECONDS` | `900` | Access Token 有效期 |
| `JWT_REFRESH_EXPIRES_SECONDS` | `604800` | Refresh Token 有效期 |
| `AUTH_DISABLED` | 未启用 | 设置为 `1` 或 `true` 可启用免认证模式 |

免认证本地运行：

```bash
AUTH_DISABLED=1 npm run dev
```

## Wrangler Config Sync

`npm run cf:configure` rewrites `wrangler.jsonc` in the current deployment workspace before build/deploy. In GitHub Actions this is temporary workspace state only; the workflow does not commit the generated config back to the repository.

Required GitHub Actions Secrets:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account used by Wrangler |
| `CLOUDFLARE_API_TOKEN` | Token with Workers, D1, and Queues permissions |
| `JWT_ACCESS_SECRET` | Access token signing secret |
| `JWT_REFRESH_SECRET` | Refresh token signing secret |

Required GitHub Actions Variables:

| Variable | Example |
| --- | --- |
| `CF_WORKER_NAME` | `api` |
| `CF_D1_DATABASE_NAME` | `altostrapi` |
| `CF_LOG_QUEUE_NAME` | `altostrapi` |

Optional GitHub Actions Variables:

| Variable | Default source |
| --- | --- |
| `CF_D1_DATABASE_ID` | Auto-detected or created by `wrangler d1 list/create` |
| `CF_WORKERS_DEV` | `wrangler.jsonc` |
| `CF_PREVIEW_URLS` | `wrangler.jsonc` |
| `CF_COMPATIBILITY_DATE` | `wrangler.jsonc` |
| `CF_COMPATIBILITY_FLAGS` | `wrangler.jsonc`; accepts CSV or JSON array |
| `CF_CUSTOM_DOMAIN_ENABLED` | Existing custom domain route in `wrangler.jsonc` |
| `CF_CUSTOM_DOMAIN_PATTERN` | Existing custom domain route pattern |
| `CF_CUSTOM_DOMAIN_ZONE_NAME` | Existing custom domain route zone |
| `CF_LOG_QUEUE_MAX_BATCH_SIZE` | Existing queue consumer config or `10` |
| `CF_LOG_QUEUE_MAX_BATCH_TIMEOUT` | Existing queue consumer config or `5` |
| `CF_LOG_QUEUE_MAX_RETRIES` | Existing queue consumer config or `3` |

## 目录说明

```text
app/          Next.js App Router 页面与 API Routes
components/   UI 组件
lib/          网关、认证、数据库、队列、协议转换逻辑
migrations/   Cloudflare D1 migrations
scripts/      CI/部署辅助脚本
docs/         Cloudflare Workers + D1 + Queues 部署补充文档
```

## 注意事项

- `data/`、`.next/`、`.open-next/`、`.wrangler/` 都不应提交到仓库。
- 现有本地 SQLite 数据不会自动导入 D1。
- GitHub Actions 会自动创建或复用 D1、Queue、DLQ。
- 如果修改依赖，请运行 `npm install` 并提交更新后的 `package-lock.json`。
