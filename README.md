# AI 与半导体情报站

个人使用的英文新闻聚合与中文洞察工具。默认每 30 分钟采集，支持网站手动刷新和 Telegram 精选推送。

## 快速开始

```bash
pnpm install
cp .env.example .env
```

生成登录密码哈希，填入 `.env` 的 `LOGIN_PASSWORD_HASH`：

```bash
pnpm exec vp run server#hash-password -- 'your-password'
```

设置 `SESSION_SECRET`（至少 16 字符，例如 `openssl rand -base64 32`）。模型和 Telegram 是可选的：不配置模型密钥时洞察降级、不影响采集；不配置 Telegram 时不推送。

启动开发环境（前端 5173，API 3000，Vite 代理 `/api`）：

```bash
pnpm exec vp run server#dev   # 一个终端
pnpm exec vp -C apps/web dev  # 另一个终端
```

打开 http://localhost:5173，用设置的密码登录。

## 部署

```bash
docker compose up -d --build
```

只有一个 `app` 服务和一个数据卷。启动时自动执行迁移。数据（数据库与备份）位于 `/data`。

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm exec vp check` | 格式、lint、类型检查 |
| `pnpm exec vp run -r test` | 全部测试 |
| `pnpm exec vp run -r build` | 构建前端、类型检查后端 |
| `pnpm exec vp run ready` | 上述三项一起跑 |
| `pnpm exec vp run server#probe-sources` | 对全部来源做实时抓取验证 |

> 用项目本地的 `pnpm exec vp`，不要用 `pnpm dlx`：dlx 的 `vite-plus` 与项目内是两个实例，测试会报 "failed to find the current suite"。

## 架构

单进程 Node 应用承载 API、调度与执行，SQLite 文件是唯一事实来源。

```text
┌──────────────────── app (Node) ────────────────────┐
│ Fastify: /api/*  +  静态资源与 SPA 回退             │
│ scheduler: 每分钟检查是否到达新的调度时段           │
│ runner:    领取 queued 刷新 / 到期投递，串行执行    │
│ db: better-sqlite3（WAL）→ /data/app.db            │
└────────────────────────────────────────────────────┘
```

刷新流水线：collecting → filtering → clustering → analyzing → publishing → notifying。

设计文档在 `docs/`：[需求](docs/requirements.md)、[架构与接口](docs/architecture.md)、[实施计划](docs/plan.md)、[方案选择记录](docs/decisions.md)。

## 来源

18 个来源，全部用真实网络验证过。13 个纯 feed 来源共用一个配置化适配器（`apps/server/src/sources/feeds.ts`）。

Google News、Hacker News、Reddit、arXiv、TechCrunch、The Verge、MIT Technology Review、Hugging Face、Lobsters、Semiconductor Engineering、EE Times、SemiWiki、IEEE Spectrum、Financial Times、Wall Street Journal、The Economist、Bloomberg、Product Hunt（需 `PRODUCTHUNT_API_TOKEN`）。

几个已知特性：

- **Google News** 的 RSS 链接是不透明 token，服务端不会重定向；适配器通过抓文章页取 `data-n-a-id/ts/sg` 再调内部 RPC 还原原文链接，失败则保留 Google 链接并标记。每轮解析有上限。
- **Reddit** 未认证 RSS 约每 30 秒只允许 1 个请求，因此每轮只抓 1 个子版并轮换。
- **Bloomberg** 用公开 RSS（technology/industries/markets），带摘要，不使用订阅凭据；市场频道是全局的，噪音交由相关性过滤处理。
- **arXiv** 默认只展示标题与摘要，不生成洞察。
- 内容范围只有标题与摘要两级，**不抓取原文正文**。

## 运维

- **备份**：每天 03:00 UTC 用 better-sqlite3 的在线 backup API 生成快照到 `/data/backups`，保留最近 14 份。异地备份即同步该目录。
- **恢复**：停止 app → 用快照替换 `/data/app.db` → 启动 app。`-wal`/`-shm` 会自动重建，无需恢复。
- **配置**：全部通过环境变量，修改后重启生效；网页只读展示非敏感配置。来源开关是唯一可在网页修改的配置。
- **日志**：记录 requestId/runId/sourceId，不记录密钥、Cookie 或文章内容。

## 语义说明

外部副作用（模型调用、Telegram 发送）采用**至少一次**语义：极端情况下（发送成功后进程崩溃）可能重复一条消息，但不会漏发已冻结的投递。这是刻意的取舍——个人聊天里重复一条消息无害，而人工确认流程的成本更高。
