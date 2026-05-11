# LLMG for Workers

LLMG for Workers 是一个基于 Next.js 的 LLM 网关与管理面板，支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 兼容接口，并提供用户、API Key、模型别名、渠道、限流、配额和请求日志管理。

生产入口：

```text
DOMAIN=api.altostr.com
BASE_URL=https://api.altostr.com/api/v1
```

## 本地开发

```bash
npm install
npm run dev
```

打开 `http://localhost:3000`，首次注册的用户会成为管理员。本地数据位于 `data/gateway.db`，不会自动迁移到 Cloudflare D1。

常用命令：

```bash
npm run typecheck
npm run lint
npm run build
npm run start
```

免认证本地运行：

```bash
AUTH_DISABLED=1 npm run dev
```

## API 使用

兼容 OpenAI/Anthropic 风格：

```text
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
curl "$BASE_URL/models" \
  -H "Authorization: Bearer sk-gw-..."
```

客户端如果有单独的 Base URL 配置，只填写上方 `BASE_URL`；客户端会自动追加 `/chat/completions`、`/responses` 或 `/models`。

## 自动部署

推送到 `main` 会触发 `.github/workflows/deploy-cloudflare.yml`，也可以在 GitHub Actions 页面手动运行 `workflow_dispatch`。

部署流程：

```text
npm ci
npm run cf:configure
npm run typecheck
npm run lint
npm run cf:build
npx wrangler d1 migrations apply "$CF_D1_DATABASE_NAME" --remote
wrangler deploy
```

仓库里的 `wrangler.jsonc` 是模板配置，不代表生产真实资源。`npm run cf:configure` 会在当前部署工作区临时生成真实 Wrangler 配置，包括 Worker、D1、Queue、DLQ、自定义域名和 `WORKER_SELF_REFERENCE`，但不会 commit 回仓库。

## GitHub 配置

必填 Secrets：

| Secret | 说明 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `CLOUDFLARE_API_TOKEN` | 需要 Workers、D1、Queues 创建和部署权限 |
| `JWT_ACCESS_SECRET` | Access Token 签名密钥 |
| `JWT_REFRESH_SECRET` | Refresh Token 签名密钥 |

必填 Variables：

| Variable | 当前生产值 |
| --- | --- |
| `CF_WORKER_NAME` | `api` |
| `CF_D1_DATABASE_NAME` | `altostrapi` |
| `CF_LOG_QUEUE_NAME` | `altostrapi` |
| `CF_CUSTOM_DOMAIN_PATTERN` | `api.altostr.com` |
| `CF_CUSTOM_DOMAIN_ZONE_NAME` | `altostr.com` |
| `CF_CUSTOM_DOMAIN_ENABLED` | `true` |

可选 Variables：

| Variable | 推荐值或默认来源 |
| --- | --- |
| `CF_D1_DATABASE_ID` | 可不填；脚本会自动查询或创建 |
| `CF_WORKERS_DEV` | `true` |
| `CF_PREVIEW_URLS` | `true` |
| `CF_COMPATIBILITY_DATE` | `wrangler.jsonc` |
| `CF_COMPATIBILITY_FLAGS` | `wrangler.jsonc`，支持 CSV 或 JSON array |
| `CF_LOG_QUEUE_MAX_BATCH_SIZE` | `10` |
| `CF_LOG_QUEUE_MAX_BATCH_TIMEOUT` | `5` |
| `CF_LOG_QUEUE_MAX_RETRIES` | `3` |

## Cloudflare 运行时

- D1 binding：`DB`
- Queue producer binding：`LOG_QUEUE`
- Queue consumer：由 `CF_LOG_QUEUE_NAME` 决定
- Dead letter queue：`${CF_LOG_QUEUE_NAME}-dlq`
- Worker self reference binding：`WORKER_SELF_REFERENCE`
- Custom domain：由 `CF_CUSTOM_DOMAIN_*` Variables 决定

Dashboard 统计和请求日志只展示经过本项目网关并写入 D1 `logs` 表的请求；上游平台自己的统计不会自动导入。

## 手动 Workers 操作

本地首次准备或手动部署仍可使用：

```bash
npm install
npm run d1:migrate:local
npm run preview
```

```bash
npx wrangler secret put JWT_ACCESS_SECRET
npx wrangler secret put JWT_REFRESH_SECRET
npm run d1:migrate:remote
npm run deploy
```

## 目录

```text
app/          Next.js App Router 页面与 API Routes
components/   UI 组件
lib/          网关、认证、数据库、队列、协议转换逻辑
migrations/   Cloudflare D1 migrations
scripts/      CI/部署辅助脚本
docs/         Cloudflare Workers + D1 + Queues 部署补充文档
```

## 注意事项

- `data/`、`.next/`、`.open-next/`、`.wrangler/` 不应提交到仓库。
- 现有本地 SQLite 数据不会自动导入 D1。
- 修改依赖后请提交更新后的 `package-lock.json`。
