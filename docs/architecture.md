# 架构与接口设计

状态：第二版设计，尚未实现。依赖具体版本在初始化时核验并锁定。上一版的取舍及废弃原因见 [decisions.md](decisions.md)。

## 设计原则

个人工具，单用户、每 30 分钟一轮、每轮最多 5 条推送。复杂度投入顺序：新闻质量（过滤、聚合、洞察）> 恢复正确性 > 外部副作用精确性。重复一条 Telegram 消息的代价接近零，错误合并事件或漏掉重要新闻的代价更高。

- 数据库是唯一事实来源，不引入第二套任务状态。
- 一个 Node 进程承载 API、调度与执行；数据库为同进程内的 SQLite 文件。
- 外部副作用（模型调用、Telegram 发送）采用至少一次语义，不追求恰好一次。

## 运行形态

```text
┌──────────────────── app (Node) ────────────────────┐
│ Fastify: /api/*  +  静态资源与 SPA 回退             │
│ scheduler: 每分钟检查是否到达新的调度时段           │
│ runner:    领取 queued 刷新 / 到期投递，串行执行    │
│ db: better-sqlite3（WAL）→ /data/app.db            │
└────────────────────────────────────────────────────┘
```

Docker Compose 只有一个 `app` 服务（`restart: unless-stopped`）和挂载在 `/data` 的数据卷。app 启动时先执行 Drizzle 迁移再开始服务；只有一个进程，不存在并发迁移。开发时 Vite 代理 `/api` 到本地 app。

单进程意味着 runner 崩溃即整个进程重启，启动时统一恢复；不需要心跳、租约或跨进程认领协议。若将来拆出独立 worker，`attempt` 写入保护（见下文）仍然成立，只需补充心跳超时判断。

## 对外契约

网页通过 `GET /api/events` 读取事件；点击刷新调用 `POST /api/refresh-runs` 立即得到 run ID，再轮询状态。前端不需要知道调度、来源协议或模型供应商。

```typescript
await requestRefresh({ trigger: 'manual' });
await requestRefresh({ trigger: 'schedule', slot: '2026-10-06T12:30:00Z' });

type RefreshTrigger =
  | { trigger: 'manual' }
  | { trigger: 'schedule'; slot: string };

type RefreshReceipt = {
  runId: string;
  disposition: 'created' | 'reused';
  state: 'queued' | 'running';
};

type RunStatus =
  | { state: 'queued'; queuedAt: string }
  | { state: 'running'; startedAt: string; progress: RunProgress }
  | { state: 'succeeded' | 'partial'; finishedAt: string; result: RunResult }
  | { state: 'failed'; finishedAt: string; error: PublicError };

type RunProgress = {
  phase: 'collecting' | 'filtering' | 'clustering' | 'analyzing' | 'publishing' | 'notifying';
  sourcesDone: number;
  sourcesTotal: number;
  analysesDone: number;
  analysesTotal: number;
};
type RunResult = {
  newArticles: number;
  relevantArticles: number;
  updatedEvents: number;
  failedSources: number;
  failedAnalyses: number;
  deferredAnalyses: number;
};
type PublicError = { code: string; message: string };

type Evidence =
  | { scope: 'headline'; title: string }
  | { scope: 'excerpt'; title: string; excerpt: string };
```

共享类型从 `packages/contracts` 的 Zod schema 推导，ID 使用 schema brand。API DTO 不直接暴露 Drizzle 表。

## 目录与所有权

```text
apps/
  web/src/
    main.tsx  App.tsx  router.tsx  routeTree.gen.ts（生成，不手改）
    routes/        文件路由、search 参数校验、loader、登录守卫
    pages/         login/ news/ event-detail/ sources/ activity/
    components/    ui/（shadcn/ui）layout/ news/（确有跨页复用再提取）
    hooks/         useEvents、useRefresh、useFeedSync 等有实际逻辑的 hook
    api/           按资源的请求函数、响应校验、queryKey/queryOptions
    lib/           HTTP 客户端、QueryClient、日期工具
    index.css      Tailwind 入口与主题 token
  server/src/
    main.ts        唯一入口：启动 Fastify、scheduler、runner
    api/           路由、认证、错误映射、静态资源
    refresh/       requestRefresh、scheduler、runner、流水线编排与检查点
    sources/       来源适配器、URL 规范化、内容范围规则
    news/          相关性过滤、事件聚合、热度、查询
    insights/      证据选择、模型调用、输出校验
    notifications/ 精选、消息渲染、Telegram 发送与重试
    db/            Drizzle schema、迁移、连接
    config/        环境变量读取与 Zod 校验，启动时失败即退出
packages/
  contracts/       Zod 请求/响应 schema，web/server 共用
```

一个 pnpm workspace。不建立仅转发调用的 controller/service/repository 三层。contracts 不包含密钥、数据库对象或供应商 SDK 类型。

## 数据模型

SQLite 约定：

- 连接时开启 `journal_mode = WAL`、`foreign_keys = ON`、`busy_timeout = 5000`。
- 时间统一存 UTC 毫秒整数（Drizzle `integer({ mode: 'timestamp_ms' })`），接口输出 ISO 8601，网页按 Asia/Shanghai 展示。发布时间未知时保留 null，排序回退到发现时间。
- 下表标注为 json 的字段以 JSON 文本存储，由 Drizzle `text({ mode: 'json' })` 与 Zod 校验读写；需要查询时使用 SQLite JSON 函数。
- better-sqlite3 为同步驱动，事务也是同步的：事务内只做数据库读写，不能 await 网络请求。模型调用、来源请求、Telegram 发送都在事务外完成，再用短事务提交结果。

| 表 | 关键字段与约束 |
|---|---|
| sources | key 唯一、adapter、配置 json、enabled、默认主题、analyze（是否生成洞察，arXiv 默认 false）、接入状态与原因 |
| articles | canonical_url 唯一、publisher、title、title_norm、published_at、discovered_at、scope、excerpt、relevance（pending/relevant/irrelevant）、topics、kind（news/paper/discussion）、event_id 可空、community_score |
| article_sources | article_id、source_id、external_id、discovery_url；(article_id, source_id) 唯一；(source_id, external_id) 部分唯一 |
| events | title、topics、kind、first_seen_at、last_article_at、effective_time、hot_score、latest_insight_id、analysis_state（pending/ok/failed/skipped）、analysis_error、analysis_run_id、importance（0–100，来自最新洞察）、notification_revision、revision_bumped_run_id、notified_revision、updated_at |
| insights | event_id、input_hash、model、prompt_version、scope、output json、evidence json、revision、created_at；(event_id, input_hash) 唯一；(id, event_id) 唯一供复合外键 |
| refresh_runs | trigger、slot（本轮覆盖的调度时段，可空）、state、attempt、progress json、result json、error、queued/started/finished 时间 |
| source_runs | (run_id, source_id) 主键、state、fetched、new、error；完成行即恢复检查点 |
| deliveries | run_id、chat_id、items json（eventId、revision、insightId）、text、state（pending/sent/failed）、attempts、next_attempt_at、message_id、last_error、sent_at |
| sessions | token hash 主键、created_at、expires_at |

关键约束：

- 活动刷新唯一：`active_slot INTEGER` 列在 queued/running 时为 1、终态时为 NULL，`CREATE UNIQUE INDEX one_active_run ON refresh_runs (active_slot) WHERE active_slot IS NOT NULL`。状态变更时同一条 UPDATE 同步修改两列，并用 CHECK 约束二者一致。
- `events.latest_insight_id, events.id` 复合外键引用 `insights(id, event_id)`，保证洞察属于该事件。
- `events.notified_revision <= notification_revision` CHECK。
- 索引：events `(effective_time DESC, id DESC)`、events `(updated_at)`、articles `(event_id)`、articles `(discovered_at)`、deliveries `(state, next_attempt_at)`。

相比上一版删除了 run_events、delivery_events、feed_state、app_settings 和 telegram 投递的多状态模型，原因见 decisions.md。

## 运行配置

刷新间隔、推送开关与条数、推送重要性阈值 `NOTIFY_MIN_IMPORTANCE`（默认 70）、Telegram chat ID、模型地址与名称、各类密钥和登录密码 hash 全部来自环境变量，启动时用 Zod 校验，进程生命周期内不变。修改方式为编辑 `.env` 后重启 app。网页设置区只读展示非敏感配置及各密钥是否已配置。来源开关是唯一在网页修改的配置，存于 sources 表。

## 刷新流水线

### 触发与调度

`requestRefresh` 执行 `INSERT … ON CONFLICT DO NOTHING RETURNING`：插入成功返回 `created`；唯一索引冲突则查询并返回现有活动 run，`reused`。插入后在进程内唤醒 runner，无需队列中间件。

`refresh_runs.slot` 表示该 run 覆盖了哪个调度时段。scheduler 每分钟计算当前时段 `slot = floor(now / interval)`，若 `max(refresh_runs.slot)` 已不小于它则跳过，否则调用 `requestRefresh({ trigger: 'schedule', slot })`：新建 run 时写入 slot；遇到活动 run 时把 slot 写到该活动 run 上，表示本时段已被覆盖。scheduler 在进程内串行执行，与手动刷新的竞争由活动 run 唯一索引裁决。由此：

- 进程停机错过多轮，恢复后只触发最近一轮。
- 手动刷新不改变时间表；定时触发遇到活动 run 时合并为 reused。
- 首次启动或停机超过一个间隔后，启动后一分钟内触发一次。
- `nextScheduledAt` 由同一公式推导。清理历史 run 时保留最近一条带 slot 的记录。

### 执行与恢复

runner 串行执行。领取时：

```sql
UPDATE refresh_runs SET state = 'running', attempt = attempt + 1, started_at = now()
WHERE state = 'queued' RETURNING *;
```

每次检查点写入都带 `WHERE id = $run AND attempt = $attempt AND state = 'running'`，影响 0 行即停止，防止过期执行提交结果。进程启动时，把 `running` 的 run 改回 `queued`（attempt ≥ 3 则标记 failed）。整轮使用 AbortSignal 设总时限（初始 20 分钟），超时标记 failed 并释放活动槽。

### 阶段

1. **collecting**：开始时为每个启用来源插入 source_runs 行，作为本轮来源快照，运行中切换来源开关不影响本轮。来源并发上限 4，单请求超时与有限重试。每个来源的文章 upsert 与 `source_runs` 完成行同事务提交；恢复时跳过已完成来源。来源只做采集与解析，不写业务库（`articles` 的 upsert 由来源检查点事务完成）；适配器契约见 `apps/server/src/sources/adapter.ts`。
2. **filtering**：对 `relevance = pending` 的新文章分类。先按来源默认主题判定（如 SemiEngineering、arXiv 指定分类直接相关）；通用来源（HN、Reddit、TechCrunch 等）先用关键词规则判定明确相关或明确无关，剩余的标题批量交给模型分类（每批约 50 条）。无关文章保留记录、不进入事件，避免下轮重复分类。
3. **clustering**：按发布时间顺序把相关文章归入事件，见下节。
4. **analyzing**：对证据集发生变化的事件生成洞察。只来自 `analyze = false` 来源的事件（如 arXiv 论文）标记为 skipped，只展示标题与摘要，不调用模型、不参与推送；同一事件后续出现可分析来源（如 HN 讨论）的文章时转为 pending。每轮分析上限（初始 40 个事件，按热度优先），超出的保持 pending 留给下一轮，计入 `deferredAnalyses`。
5. **publishing**：每个洞察单独事务：写 insight、更新 events 指针、通知版本与 updated_at。洞察发布后即可见，不等待整轮完成。
6. **notifying**：生成本轮投递（见 Telegram 一节）。

结果判定：来源和分析全部成功为 succeeded；有失败但至少一个来源成功为 partial；全部来源失败或系统错误为 failed。无新增内容仍是 succeeded。

### URL 与来源

- 规范化 URL 去除 utm_*、fbclid 等已知跟踪参数、fragment 与结尾斜杠，保留语义参数；按 canonical_url 去重。
- **Google News 原文链接解析（plan 第 2 步已实测）**：RSS 的 `<link>` 是不透明的 `news.google.com/rss/articles/CBMi…`，既不是明文 base64，也不会在服务端重定向（跳转由页面 JS 完成；curl 跟随只得到 Google 页面）。解析方式：抓取该 Google 文章页，读出 `data-n-a-id`、`data-n-a-ts`、`data-n-a-sg` 三个属性，POST 到内部 `batchexecute`（RPC `Fbv4je`），从返回的 `garturlres` 取出原文 URL。实测 2026-10-06：8/8 成功，20 次连续请求无 429；每篇成本 2 个请求。该接口未公开，可能随时变化，因此失败一律降级为保留 Google 链接并标记 unresolved，不影响整轮。
- Google News 是发现渠道：出版方取 RSS `<source>` 名称，独立出版方计数按出版方名而非 URL。`unresolved` 只表示"URL 未解析"，与"解析尝试过但失败"通过 `resolveAttempted` 区分。
- 解析只对最近的条目进行（每轮上限，初始 40 条），其余条目保留 Google 链接、不消耗请求。
- 内容范围只有标题与来源摘要两级：RSS/API 带摘要时 scope 为 excerpt，只有标题时为 headline。不请求原文页面（D15）。Google News 与 Hacker News 的 RSS/API 都不提供摘要，因此这两类文章恒为 headline。
- 来源请求只访问适配器配置的 RSS/API 地址；唯一例外是 Google News 原文链接解析所需的两个请求（文章页与 batchexecute），两者都指向 news.google.com，不访问出版方站点。

### 已接入来源

覆盖参考实现 madeye/ai-dashboard 的全部来源。除 Product Hunt（需凭据）外均已实测可接入。

| 来源 | 方式 | 内容范围 | 状态 |
|---|---|---|---|
| Google News | RSS 搜索 + 原文链接解析 | headline | 实测 90 条 / 72 出版方 |
| Hacker News | Algolia search API | headline | 实测 90 条 |
| Reddit | Atom feed（4 个子版轮换） | excerpt | 实测 15 条/轮；限流见下 |
| arXiv | Atom query API（cs.AI/cs.CL/cs.LG） | excerpt，不生成洞察 | 实测 36 条 |
| TechCrunch | RSS（AI 分类） | excerpt | 实测 18 条 |
| The Verge | Atom（AI 频道） | excerpt | 实测 10 条 |
| MIT Tech Review | RSS（AI topic） | excerpt | 实测 10 条 |
| Hugging Face | RSS（blog，无摘要） | headline | 实测 50 条 |
| Lobsters | RSS | excerpt | 实测 25 条 |
| Semiconductor Engineering | RSS | excerpt | 实测 10 条 |
| EE Times | RSS | excerpt | 实测 10 条 |
| SemiWiki | RSS | excerpt | 实测 5 条 |
| IEEE Spectrum | RSS（semiconductors 频道） | excerpt | 实测 30 条 |
| Financial Times | RSS ×3（AI/tech/semiconductors） | excerpt | 实测 62 条 |
| Wall Street Journal | RSS（Dow Jones 公共 feed） | excerpt | 实测 37 条 |
| The Economist | RSS（science-and-technology） | excerpt | 实测 50 条 |
| Product Hunt | GraphQL（需 `PRODUCTHUNT_API_TOKEN`） | excerpt | 未配 token 时返回空并说明原因 |
| Bloomberg | RSS ×3（technology/industries/markets，公开 feed） | excerpt | 实测 60 条，均带摘要 |

来源实现方式：13 个纯 feed 来源共用 `sources/rss.ts` 的通用适配器，只在 `sources/feeds.ts` 里配置；Google News、Hacker News、arXiv、Product Hunt 各有专门模块。`sources/registry.ts` 是唯一注册点。

需要注意的三个来源特性：

- **Reddit 限流**：未认证 RSS 约每 30 秒只允许 1 个请求（`x-ratelimit-remaining` 每次请求后即为 0）。因此每轮只抓 1 个子版并轮换（`feedsPerRun: 1`），约 12 秒完成，两小时内覆盖 4 个；若一次抓全部 4 个，需约 3 分钟等待，会挤占整轮 20 分钟预算。User-Agent 必须保持描述性，浏览器 UA 反而更容易被限流。
- **feed 条数上限**：部分 feed 返回全量历史（Hugging Face 约 875 条），每 feed 默认只取最近 50 条。
- **Atom 与 RSS 差异**：Atom 的 `<title type="html">` 会解析成对象，必须取 `#text`；漏掉这一点会让整个 feed 静默返回 0 条。

关于 Bloomberg 的市场新闻：其公开 feed 没有美股专用频道，用的是全局 `markets`（美股约占三分之一，其余为欧洲、新兴市场等）。这部分噪音交由第 4 步的相关性过滤统一处理，不在来源层写市场专用规则（D20）。

`vp run server#probe-sources [来源…]` 是对已实现适配器做实时验证的工具。

## 事件聚合

目标：同一具体事件的多源报道合并，宁可漏合并也不错合并。

1. **候选**：读取 `last_article_at` 在最近 72 小时内的事件及其文章 title_norm（数量为数百级），在内存中计算新文章与之的字符三元组 Jaccard 相似度，取相似度 ≥ 0.3 的前 5 个事件。title_norm 为小写、去除 " - Publisher" 后缀与标点。
2. **直接判定**：无候选 → 新建事件。最高相似度 ≥ 0.85 且仅一个候选 → 视为转载，直接归入。
3. **模型裁决**：其余情况批量交给模型。输入新文章标题与摘要、每个候选事件的标题及最多 3 篇文章标题；输出候选事件 ID 或 `new`。提示要求“同一具体发生的事情”，同公司或同主题不算。输出 ID 必须属于候选集，否则按 `new` 处理。
4. 同一轮内先建立的事件立即成为后续文章的候选。

首版不做事后合并已存在的两个事件；漏合并接受为已知局限。聚合判定结果写日志，用积累的误判样本调整阈值和提示。

## 洞察

- 证据选择：每个事件最多 8 篇文章，优先不同出版方，再按 scope（excerpt > headline）和时间。证据文本来自标题与来源摘要，不含原文正文（D15）。
- `input_hash` = 证据文章 ID、各条摘要文本、scope、模型地址与名称、prompt_version。证据先按文章 ID 排序再计算，保证顺序无关。相同 hash 已有洞察时直接复用，不调用模型。
- 输出 Zod 校验：中文标题、事实摘要（每条带引用）、重要性说明及 0–100 分值、可能影响、可选观察点、`material_update`。分值写入 events.importance，提示中给出分档锚点（如重大产品发布、并购、出口管制为高分，常规融资与观点文章为低分）。引用必须属于本次证据，否则视为失败。事实与推断分字段。事件全部证据都为 headline（无摘要）时不输出影响判断。
- 证据作为数据传入，其中的指令不改变系统行为。模型没有工具调用能力，也接触不到密钥。
- 写库前崩溃可能导致重复调用模型，接受该成本。
- 模型失败时 `analysis_state = failed`，事件仍以原始标题展示；旧洞察保留，并标记有新资料待分析。

### 通知版本

`notification_revision` 只在以下情况加一，与发布洞察同一事务，并记录 `revision_bumped_run_id` 为当前 run：

- 事件首个洞察发布（0 → 1）。
- 新洞察 `material_update.is = true`，且其引用包含上一洞察证据中没有的文章。

模型判断提示：新的动作、状态变化或关键数值变化才算实质进展；新增转载、措辞变化不算。没有上一洞察时不询问该字段。

## Telegram

- 候选：本轮版本有增加（`revision_bumped_run_id` = 当前 run）、`notification_revision > notified_revision` 且 `importance >= NOTIFY_MIN_IMPORTANCE` 的事件，按重要性再按热度取前 N（默认 5）。上一轮分析失败、本轮成功的事件自然包含在内。
- 冻结：同一事务中插入 deliveries（渲染好的文本与 items），并把本轮所有版本有增加的事件（无论是否入选）的 `notified_revision` 设为当前 `notification_revision`。未入选的不积压到下一轮；同一事件版本只会进入一次投递。无候选不创建投递。
- 首轮静默：没有任何已结束 run 时（首次部署），本轮只推进 notified_revision，不创建投递，避免历史内容刷屏。
- 发送：runner 在 notifying 阶段及每分钟检查到期的 pending 投递。成功记录 message_id 与 sent；429 按 retry_after，5xx、超时、断连按指数退避，最多 5 次；4xx（除 429）及超过次数记 failed。
- 语义为至少一次：发送成功但写库前崩溃，重启后可能重复发送一次。
- 单条消息超出长度时压缩摘要，保留原文链接和站内链接。
- 推送失败不影响网页内容；failed 投递可在网页手动重试。

## 热度与排序

初始加权分：时效性 40%、主题相关性 30%、独立出版方数 20%、来源内归一化社区热度 10%。这些是可调产品参数，不是重要性的客观判断。稳定 ID 作平局裁决。`effective_time = coalesce(min published_at, first_seen_at)`。

社区热度按来源归一化：各来源的原始分值不可比（HN 300 分与小社区 300 赞含义不同），因此每个分值除以该来源的"热门参考值"再取最大。参考值见 `news/scoring.ts` 的 `COMMUNITY_HOT_REFERENCE`，是可调参数。

## 可调参数与实测取值

以下参数都在环境变量或代码常量中集中定义，是产品参数而非客观结论。用 `vp run server#calibrate` 对真实来源测量后可调整。

| 参数 | 位置 | 默认 | 实测依据 |
|---|---|---|---|
| 每轮分析上限 | `ANALYZE_MAX_EVENTS` | 40 | 首次全量约 600 个事件、稳态远低于此；一轮消化不完是有意设计，按间隔逐步清完 |
| 过滤模型批数 | `FILTER_MAX_BATCHES` | 8 | 600 篇中约 37% 需模型判定，每批 50 条 |
| 聚合模型批数 | `CLUSTER_MAX_BATCHES` | 4 | 多数文章由相似度直接判定，只有"同事件不同措辞"才需模型 |
| 整轮时限 | `RUN_TIMEOUT_MINUTES` | 20 | 全来源采集实测约 14 秒，模型调用才是主要耗时 |
| 标题候选阈值 | `CANDIDATE_THRESHOLD` | 0.3 | 回归样本：改写对约 0.3–0.85，无关对 <0.3 |
| 直接合并阈值 | `DIRECT_MERGE_SIMILARITY` | 0.85 | 回归样本：转载对（含大小写、后缀差异）均 ≥0.85 |
| 每 feed 条数上限 | `DEFAULT_FEED_LIMIT` | 50 | Hugging Face 返回约 875 条全量历史 |
| Google News 解析上限 | `DEFAULT_MAX_RESOLVE` | 40 | 每篇 2 个请求，实测无限流 |
| 推送重要性阈值 | `NOTIFY_MIN_IMPORTANCE` | 70 | 按实际收到的推送数量调整 |

## HTTP 接口

统一前缀 `/api`，JSON；错误格式 `{ error: { code, message, requestId } }`。日志记录 requestId、runId、sourceId，不记录密钥、Cookie 或文章内容。

| 方法与路径 | 行为 |
|---|---|
| POST /session | 密码登录，HttpOnly、Secure、SameSite Cookie；失败限流 |
| GET /session | 当前会话状态 |
| DELETE /session | 注销并删除服务端会话 |
| GET /events | topic、source、kind、sort、from、to、page、limit；返回 items、page、hasMore |
| GET /events/:id | 洞察、证据与范围、来源列表、分析状态 |
| GET /status | feedRevision、activeRun、最近尝试/成功时间、nextScheduledAt |
| POST /refresh-runs | 新建 202、复用 200；冷却且无活动 run 时 429 |
| GET /refresh-runs | 最近执行记录，分页 |
| GET /refresh-runs/:id | 进度、各来源结果、分析失败事件 |
| GET /sources | 来源配置、接入状态、最近结果 |
| PATCH /sources/:id | 开关及适配器支持的过滤设置 |
| GET /config | 只读：非敏感配置与各密钥是否已配置 |
| GET /deliveries | 投递记录，分页 |
| POST /deliveries/:id/retry | 仅 failed 可重试 |
| GET /health | 进程与数据库状态 |

`feedRevision` 为 `max(events.updated_at)`，不需要单独的计数表。除登录和健康检查外均需认证；写接口校验 Origin。密码 hash、模型密钥、Telegram token 来自环境变量。

## 前端约定

- TanStack Router 文件路由：routes 负责路径、Zod search 参数、beforeLoad 登录检查与 loader；pages 负责页面呈现。路由插件置于 React 插件前，开启自动代码分割。
- router context 与 QueryClientProvider 共用一个 QueryClient；loader 与页面使用 api 中同一份 queryOptions。
- 依赖方向：pages/layout → hooks/api → lib/contracts。页面不互相导入；单页专用组件与 hook 就近放在页面目录。服务端数据只放 React Query，筛选放 URL，临时 UI 状态放组件。
- 查询 key：列表 `['events', filters, page]`，详情 `['event', id]`。
- 活动 run 每 2 秒轮询，进入终态停止。可见页面每 15 秒查询 `/status`；feedRevision 变化时，首页在顶部且未展开阅读则自动重新查询，否则显示“有新内容”，点击后回到第一页。后台标签页暂停轮询。
- 普通 page/limit 分页，客户端按事件 ID 去重；更新期间翻页可能遇到排序变动，首版接受。
- 刷新 mutation 不盲目重试，网络不确定时先查询 activeRun。HTTP 层把非 2xx 转为错误。
- 样式：Tailwind，全局只有 `src/index.css`；shadcn/ui 组件按需放入 `components/ui`，新闻布局由业务组件实现。

## 验证

用真实 SQLite 文件（测试中使用临时文件）测试：

- 并发 `requestRefresh` 只产生一个活动 run。
- 过期 attempt 写入被拒绝。
- 进程中断后 run 恢复且跳过已完成来源。
- 错过多轮调度只补一轮。
- 同一事件版本不会进入两次投递。

模型相关行为（过滤、聚合、material_update）用保存的真实样本做回归：转载、改写、同公司不同事件、真实进展各若干例。外部服务用固定响应模拟超时、429 和格式错误。

数据库文件位于持久卷。app 每日用 better-sqlite3 的在线 backup API 生成快照到 `/data/backups`，保留最近 14 份；需要异地备份时同步该目录到外部存储。恢复即停止 app、替换 `app.db` 后启动，需至少演练一次。

参考：[Telegram Bot API](https://core.telegram.org/bots/api#sendmessage)、[SQLite WAL](https://www.sqlite.org/wal.html)、[Drizzle SQLite](https://orm.drizzle.team/docs/get-started-sqlite)、[Fastify Type Providers](https://fastify.dev/docs/latest/Reference/Type-Providers/)、[TanStack Router + Query 示例](https://tanstack.com/router/latest/docs/framework/react/examples/basic-react-query-file-based)、[shadcn/ui](https://ui.shadcn.com/docs)、[Vite+ 指南](https://viteplus.dev/guide)。
