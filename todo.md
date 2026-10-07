# 待办

plan 第 1–9 步全部实现完毕，并按 architecture.md 做了实现审计与真实数据校准。

## 已完成

- **工程骨架**：pnpm workspace、Fastify 单入口、SQLite + Drizzle 迁移、密码登录。
- **来源**：18 个来源（参考实现 17 个 + Bloomberg），全部用真实网络验证。
- **刷新流水线**：requestRefresh、scheduler、runner、来源检查点、崩溃恢复、活动 run 唯一约束、每轮总时限。
- **新闻质量**：相关性过滤（来源主题 → 关键词 → 模型批量分类）、事件聚合（三元组相似度 → 模型裁决）。
- **洞察**：证据选择、input_hash 复用、Zod 输出校验、引用必须属于本次证据、material_update 与通知版本。
- **Telegram**：精选、冻结投递、指数退避重试、每分钟补投、手动重试、首轮静默。
- **前端**：列表筛选分页、事件详情、来源页（开关可写）、活动页（含每轮来源结果与分析失败）、更新提示。
- **部署**：Dockerfile、docker-compose、每日在线备份与恢复说明、README。

## 验证结果

- `vp check`：格式、lint、类型全部通过（97 个文件）。
- `vp run -r test`：**164 个测试**全部通过（17 个文件）。
- `vp run -r build`：前端构建与后端类型检查通过。
- 端到端：真实服务器 + 真实来源（595 篇文章 → 586 个事件 → 40 个洞察），浏览器验证登录、列表、筛选、详情、来源开关持久化、活动页。

## 实现审计（architecture.md 要求 vs 实现）

对照架构文档逐项审计后补齐的缺口：

- 来源检查点写入补上 `attempt`/`state` 守卫，过期执行无法提交结果。
- 文章 upsert 与来源完成行改为同一事务提交。
- 过滤阶段先按来源默认主题判定；跳过的事件在可分析来源加入后回到 pending。
- `effective_time` 改为 `coalesce(min published_at, first_seen_at)`。
- `articles.kind`/`events.kind` 现在真正取到 `paper`/`discussion`。
- 社区热度改为**来源内归一化**（`COMMUNITY_HOT_REFERENCE`）。
- `sources.status`/`status_reason` 在每轮写入。
- 通知版本改为按**洞察引用**判定，而非整份证据集。
- 运行结果判定纳入分析失败（有失败即 partial）。
- 每请求超时与有限重试抽到 `sources/http.ts`，所有适配器共用。
- `GET /events` 的 topic/source 过滤下推到 SQL；`unresolved` 从真实标记读取。
- `POST /refresh-runs` 补上冷却 429；`GET /refresh-runs/:id` 返回分析失败事件。
- 前端：按事件 ID 去重、有新内容回到第 1 页、活动 run 轮询到终态即停、刷新失败先查 activeRun。
- 补上架构文档「验证」一节点名的三项测试：过期 attempt 拒绝、恢复跳过已完成来源、同一事件版本不进两次投递。

## 真实数据校准

- **标题相似度阈值**：回归样本 `news/__fixtures__/clustering-cases.ts` 覆盖转载/改写/同公司不同事件/真实进展，确认 0.3 与 0.85 两个阈值。实测同公司、同主题不同事件的相似度仅 0.07–0.12，**低于候选阈值**，因此无需模型调用即直接新建事件。
- **关键词表**：实测 595 篇中 373 篇由关键词判定相关、222 篇需模型。修复了复数形式漏判（`semiconductors`/`chips`/`LLMs` 曾全部漏判，导致 41% 的文章走模型）。
- **每轮上限**：实测首次全量约 600 个事件、采集约 14 秒。三个上限（分析事件数、过滤批数、聚合批数）与整轮时限已改为环境变量，取值依据见 architecture.md「可调参数与实测取值」。
- 校准工具：`vp run server#calibrate [轮数]`，可注入 `ANALYZE_MAX_EVENTS` 等验证上限效果。

## 来源覆盖

覆盖参考实现 madeye/ai-dashboard 的全部 17 个来源，另加 Bloomberg，共 18 个。除 Product Hunt（需 token）外均实测可接入：

- 13 个纯 feed 来源共用配置化 RSS/Atom 适配器（D17），只在 `sources/feeds.ts` 配置。
- Reddit 未认证 RSS 约每 30 秒限 1 个请求，改为每轮抓 1 个子版轮换（D18）。
- Bloomberg 用公开 RSS（technology + industries + markets），带真实摘要，不使用订阅凭据（D19）；市场新闻用全球 markets feed，噪音交给相关性过滤（D20）。
- Atom 的 `<title type="html">` 解析为对象，需取 `#text`，否则整个 feed 静默返回 0 条（The Verge 曾因此为空）。
- 验证工具：`vp run server#probe-sources [来源…]`。

## 仍未验证（需要真实凭据或线上运行）

- [ ] Telegram 对个人聊天的一次真实发送（需要 `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_CHAT_ID`）。
- [ ] 用真实模型 API 跑一轮完整洞察（当前用本地桩验证了调用链；真实 key 未在此环境配置）。
- [ ] Product Hunt 适配器（需要 `PRODUCTHUNT_API_TOKEN`）。
- [ ] Docker Compose 实际构建与启动（本机未执行 docker build）。
- [ ] 备份恢复演练（备份与恢复路径已实现并有测试，但未在真实部署上演练）。
