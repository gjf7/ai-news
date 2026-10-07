# 实施计划

设计阶段已完成（见 [architecture.md](architecture.md)、[decisions.md](decisions.md)）。以下单元按顺序实施，每个单元完成后把实际偏离写回 architecture.md。

状态：**全部 9 步已完成**。验证结果见 [todo.md](../todo.md)。

1. **工程骨架**
   - pnpm workspace，Vite+ React TS 前端：TanStack Router 文件路由、TanStack Query、Tailwind，全局样式入口为 src/index.css。
   - 单入口 Node 服务：Fastify 与配置校验。
   - SQLite（better-sqlite3、WAL）、Drizzle 迁移（启动时执行）、健康检查、个人登录。
   - 使用 `vp create`，先核验 Vite+ 当前指南与 CLI help。锁定版本与 lockfile。
2. **来源可行性验证**：Hacker News 与 Google News RSS 各写一个适配器，用保存的真实样本测试解析。重点确认 Google News 原文链接解析是否可行，结果写回架构文档。
   - 结论：两者均可接入。Google News 原文链接解析可行（抓文章页取 `data-n-a-id/ts/sg` → POST `batchexecute` 取 `garturlres`），实测 8/8 成功、无限流，但每篇 2 个请求且接口未公开，因此限制每轮解析条数并允许降级。详见 architecture.md「URL 与来源」与 decisions.md D16。
3. **刷新骨架**
   - requestRefresh、scheduler、runner、来源检查点、手动刷新与状态页、文章列表。
   - 用临时 SQLite 文件测试并发触发、过期 attempt 拒绝写入、重启恢复、错过多轮只补一轮。
4. **新闻质量**
   - 相关性过滤与事件聚合。
   - 建立样本集：转载、改写、同公司不同事件、真实进展。
   - 调整阈值和提示，记录误判率。
5. **洞察**：DeepSeek 调用、证据选择（标题与来源摘要）、Zod 输出校验、input_hash 复用、每轮上限、material_update 与通知版本。
6. **前端完善**：筛选分页、事件详情与证据、更新提示、来源页与只读配置展示、错误展示。
7. **Telegram**：精选、冻结投递、重试、手动重试，并对个人聊天做一次真实发送。
8. **其余来源**：逐个验证接入方式；不可用的来源标注原因。
   - 已完成：覆盖参考实现 madeye/ai-dashboard 的全部 17 个来源，另加 Bloomberg，共 18 个。除 Product Hunt（需 `PRODUCTHUNT_API_TOKEN`）外均实测可接入。13 个纯 feed 来源共用配置化 RSS 适配器（D17）。Reddit 因限流改为每轮抓 1 个子版轮换（D18）。Bloomberg 用公开 RSS，带摘要（D19）。详见 architecture.md「已接入来源」。
9. **部署**：Docker Compose（单个 app 服务与数据卷）、每日备份与恢复演练、运行说明，并完成需求验收。

前端运行 vp check、vp test、vp build；后端测试覆盖事务、恢复和推送边界。具体命令以初始化后的配置为准。
