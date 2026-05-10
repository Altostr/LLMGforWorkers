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
| `CF_WORKER_NAME` | `model-gate` |
| `CF_D1_DATABASE_NAME` | `model-gate` |
| `CF_LOG_QUEUE_NAME` | `model-gate-chat-logs` |

D1 id 会由 GitHub Actions 自动创建或查询后写入临时部署配置，不需要手动配置。

## Cloudflare 运行时说明

- D1 binding：`DB`
- Queue producer binding：`LOG_QUEUE`
- Queue consumer：由 `CF_LOG_QUEUE_NAME` 决定
- Dead letter queue：`${CF_LOG_QUEUE_NAME}-dlq`
- Worker self reference binding：`WORKER_SELF_REFERENCE`

Workers 模式下，请求主路径仍同步完成认证、限流、配额扣减、路由和上游请求；chat logs 会进入 Cloudflare Queue 后异步写入 D1。日志表使用 `log_event_id` 做幂等，避免 Queue 重试产生重复日志。

## API 入口

兼容 OpenAI/Anthropic 风格：

```text
推荐 Base URL: https://your-worker.example/v1

POST /v1/chat/completions
POST /v1/responses
POST /v1/messages

兼容旧路径:
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
