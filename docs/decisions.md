# 方案选择记录

只记录当前有效的决定及理由。最终规范以 [architecture.md](architecture.md) 为准。

## 2026-10-06 第二版重设计

第一版设计按多人生产系统的标准投入可靠性设施，而产品核心（相关性过滤、事件聚合）没有设计。本版按个人使用规模重新分配复杂度。

| # | 决定 | 替代方案 | 理由 |
|---|---|---|---|
| D1 | refresh_runs 表即任务队列，部分唯一索引保证单活动 run；移除 pg-boss | 业务表与 pg-boss 同事务双写，启动时按 queue_job_id 对账 | 双写需要事务适配器和对账逻辑，并依赖队列内部表的保留时间。单进程、并发为一的场景下，表加条件更新已足够。 |
| D2 | API、调度、执行在同一进程；Fastify 同时托管静态资源 | API、worker、反向代理分别部署 | 少两个容器和一套跨进程认领协议。保留 attempt 写入保护，将来拆分时仍然安全。 |
| D3 | 调度时段记在 `refresh_runs.slot`，重叠时写到活动 run 上 | pg-boss 命名调度、schedule_slots 表、单独状态行 | 不需要额外表即可满足“错过多轮只补一次、手动不改计划”。 |
| D4 | Telegram 至少一次：pending/sent/failed，自动重试 | 七状态机，unknown 由人工确认 | 个人聊天里重复一条消息无害；人工确认流程的成本比重复消息高。 |
| D5 | 通知版本由模型的 `material_update` 加“引用了新文章”判定 | 抽取结构化事实集合、规范化 hash 后比较 | 事实抽取输出不稳定，规范化难以收敛；新判据规则简单，同样能排除转载。 |
| D6 | 投递冻结时直接推进 events.notified_revision | delivery_events 表加唯一约束 | 同一事务内完成去重，少一张表。 |
| D7 | 新增 filtering 阶段：来源规则 → 关键词 → 模型批量分类 | 不过滤，全部进入聚合与分析 | HN、Reddit 等通用来源大部分内容无关，不过滤会让模型费用和耗时失控。 |
| D8 | 事件聚合：内存三元组相似度候选 + 高相似度直接归入 + 模型裁决；首版不做事后合并 | embedding 聚类；关键词合并 | DeepSeek 无 embedding 接口；72 小时内事件仅数百个，内存计算无需数据库扩展；模型裁决限定在候选集内，保守偏向新建事件。 |
| D9 | 每轮分析上限，超出留待下轮 | 无上限 | 控制单轮时长与费用，保证整轮总时限可设。 |
| D10 | feedRevision 取 `max(events.updated_at)` | feed_state 单行计数 | 不需要在每个事务中记得递增计数。 |
| D11 | 运行配置全部走环境变量，网页只读；移除 app_settings、设置页与 PATCH /settings | 网页可编辑设置，单行表加乐观锁与 run 设置快照 | 这些配置极少修改，编辑 .env 后重启即可；省去写接口、冲突处理和设置快照。需要时再加回，不影响其他部分。 |
| D12 | 推送需达到重要性阈值，只取本轮新增版本，未入选不积压，首轮静默 | 按热度取前 N，候选持续累积 | 否则几乎每轮推满 5 条，且首次部署及积压的旧新闻会刷屏。 |
| D13 | arXiv 等来源默认不生成洞察，只展示标题与摘要 | 所有相关文章都分析 | 论文量大，会占满每轮分析额度和首页；出现社区讨论时再分析。 |
| D14 | SQLite（better-sqlite3，WAL）替代 PostgreSQL；启动时迁移，在线 backup API 每日快照 | PostgreSQL 独立容器 | 单进程串行写入、单用户，用不上 PostgreSQL 的并发优势。少一个容器和迁移服务，备份为单文件，测试无需数据库服务。若将来拆分多个写入进程，再评估迁回。 |
| D15 | 洞察只用来源提供的内容（标题 + RSS 摘要），不抓取原文正文 | 抓取 canonical_url 的正文并用 readability 抽取，scope 升到 fulltext | 参考实现 madeye/ai-dashboard 证明标题级洞察对个人快讯够用，且省去正文抓取子系统：无 readability 依赖、无逐站抽取规则、无 robots/限速问题、无付费墙与合规风险。代价是洞察偏浅，可能影响判断依据不足。因此分析阶段不抓取原文，证据范围只有 headline 与 excerpt 两级；`articles.content`、`scope`、`content_hash` 一并移除。 |
| D16 | Google News 原文链接解析走内部 `batchexecute` RPC，只对最近的条目解析，失败降级为 unresolved | 直接用 Google 链接入库；或用无头浏览器渲染页面取跳转 | RSS 链接是不透明 token，服务端不会重定向（跳转靠页面 JS），必须复现 `data-n-a-id/ts/sg` + `Fbv4je` 流程。实测 8/8 成功、20 次请求无限流，但每篇 2 个请求且接口未公开，因此限制每轮解析条数、失败保留 Google 链接并标记，整轮不因此失败。无头浏览器成本与脆弱性都更高，个人规模不值得。 |
| D17 | 13 个纯 feed 来源共用一个配置化的 RSS/Atom 适配器，来源清单集中在 `sources/feeds.ts`；只有 Google News、Hacker News、arXiv、Product Hunt 各写模块 | 每个来源一个模块（参考实现的做法） | 这些来源的差异只是"feed 地址 + 出版方名"，17 个模块里 13 个是同一段代码。配置化后新增来源是一行配置，且 Atom/RSS 差异、429 重试、条数上限、去重只维护一处。需要专门解析或 API 的来源仍单独成模块。 |
| D18 | Reddit 每轮只抓 1 个子版并轮换 | 一次抓 4 个子版；放弃 Reddit | 未认证 RSS 约每 30 秒只允许 1 个请求，一次抓 4 个需约 3 分钟等待，会挤占整轮 20 分钟预算且时长不可预测。轮换后每轮约 12 秒、时长稳定，两小时内覆盖全部 4 个子版；Reddit 的内容是社区讨论，覆盖稍有延迟可接受。 |
| D19 | Bloomberg 只用公开 RSS（technology + industries + markets），带摘要，不使用订阅凭据 | 用数字订阅 Cookie 抓付费全文；不做 Bloomberg | `bloomberg.com/feeds/*/news.rss` 公开可用（robots.txt 为 Feedly 等阅读器列了专门规则），且 `<description>` 就是真实摘要，正好符合 D15 的 excerpt 级别。因此无需账号、Cookie 或绕过付费墙，风险最低。代价是只有摘要、不是全文——但按 D15 本就不抓正文。付费全文另行评估。 |
| D20 | Bloomberg 用全球 `markets` feed 代替美股专用频道 | 自己按关键词过滤出美股；放弃市场新闻 | Bloomberg 没有美股专用公开 feed（`us-stocks`/`stocks`/`equities`/`finance` 均 404），其公开 feed 只有 technology、markets、politics、economics、industries、business、wealth、crypto 八个。`markets` 是全局市场频道，美股内容约占三分之一，其余为欧洲、新兴市场等。接受这一噪音，交给第 4 步的相关性过滤统一处理，而不是在来源层写一套市场专用规则。 |
| D21 | 模型 base URL 兼容已含 `/v1` 的写法 | 强制要求配置不含版本段 | 端到端验证时发现真实环境里的 `OPENAI_BASE_URL` 常带 `/v1`，而客户端又拼一次 `/v1`，导致 404、每轮 40 个事件被误判失败。改为：base 已以 `/vN` 结尾则只拼 `/chat/completions`，否则拼 `/v1/chat/completions`。 |
| D22 | 模型调用失败只标记该事件 failed，不中断整轮 | 让异常冒泡使整轮 failed | 模型是外部依赖，过滤/聚合/洞察任一环节的失败都不应让整轮崩溃。关键词规则不需要模型即可判定相关性，因此模型全挂时事件仍会建立、只是 analysis_state 为 failed 并在下一轮重试。 |

## 保留的第一版决定

- 整轮刷新加来源检查点，不按来源或阶段拆分任务。
- 自动与手动共用 requestRefresh 和单活动 run。
- 文章与发现渠道分表（article_sources），Google News 不计作独立出版方。
- 洞察按 input_hash 复用，保存证据快照；事实与推断分开。
- 前端 routes/pages/components/hooks/api/lib 分工，TanStack Router 文件路由、React Query、Tailwind、shadcn/ui。
- 普通分页；revision 只用于提示更新。

## 接受的局限

- 模型调用和 Telegram 发送可能因崩溃重复一次。
- 漏合并的事件首版不会事后合并。
- 更新期间翻页可能遇到排序变动。
- 付费媒体只有元数据与摘要。
- 洞察只依据标题与来源摘要（D15），不读取原文正文，深度受限；只有标题没有摘要的文章，其洞察仅基于标题。
