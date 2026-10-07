import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { eventQueryOptions } from "../../../api/events.ts";
import { Badge, Card, ErrorNotice, Spinner } from "../../../components/ui/primitives.tsx";
import { formatShanghai, relativeTime } from "../../../lib/format.ts";

export const Route = createFileRoute("/_authenticated/events/$eventId")({
  component: EventDetailPage,
});

function EventDetailPage() {
  const { eventId } = Route.useParams();
  const event = useQuery(eventQueryOptions(eventId));

  if (event.isPending) return <Spinner label="加载中…" />;
  if (event.error || !event.data) return <ErrorNotice message="事件不存在或加载失败" />;

  const detail = event.data;

  return (
    <div className="space-y-6">
      <Link to="/" className="text-xs text-neutral-500 hover:text-neutral-900">
        ← 返回列表
      </Link>

      <div>
        <h1 className="text-lg font-semibold leading-snug">
          {detail.insight?.title ?? detail.title}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-400">
          {detail.topics.map((topic) => (
            <Badge key={topic} tone="accent">
              {topic === "ai" ? "AI" : "半导体"}
            </Badge>
          ))}
          <span>{detail.articleCount} 篇报道</span>
          <span>· {detail.publisherCount} 个来源</span>
          <span>· {formatShanghai(detail.effectiveTime)}</span>
        </div>
      </div>

      {detail.insight ? (
        <Card>
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium">洞察</h2>
            <span className="text-xs text-neutral-400">
              重要性 {detail.insight.importanceScore} · {detail.insight.model}
            </span>
          </div>

          <p className="mt-2 text-xs text-neutral-500">{detail.insight.importanceReason}</p>

          <h3 className="mt-4 text-xs font-medium text-neutral-500">事实</h3>
          <ul className="mt-1.5 space-y-1.5">
            {detail.insight.facts.map((fact) => (
              <li key={fact.text} className="text-sm text-neutral-800">
                {fact.text}
                <span className="ml-1 text-xs text-neutral-400">[{fact.citations.join(",")}]</span>
              </li>
            ))}
          </ul>

          {detail.insight.impact ? (
            <>
              <h3 className="mt-4 text-xs font-medium text-neutral-500">可能影响</h3>
              <p className="mt-1.5 text-sm text-neutral-800">{detail.insight.impact}</p>
            </>
          ) : null}

          {detail.insight.watch ? (
            <>
              <h3 className="mt-4 text-xs font-medium text-neutral-500">观察点</h3>
              <p className="mt-1.5 text-sm text-neutral-800">{detail.insight.watch}</p>
            </>
          ) : null}

          <p className="mt-4 text-xs text-neutral-400">
            依据范围：{detail.insight.scope === "excerpt" ? "标题与摘要" : "仅标题"}
          </p>
        </Card>
      ) : (
        <Card>
          <h2 className="text-sm font-medium">
            {detail.analysisState === "pending"
              ? "待分析"
              : detail.analysisState === "failed"
                ? "分析失败"
                : "仅展示标题"}
          </h2>
          <p className="mt-1 text-xs text-neutral-500">
            {detail.analysisState === "pending"
              ? "这一事件尚未生成洞察，下一轮会自动处理。"
              : detail.analysisState === "failed"
                ? (detail.analysisError ?? "模型调用失败，下一轮会重试。")
                : "该来源默认只展示标题与摘要，不生成洞察。"}
          </p>
        </Card>
      )}

      <div>
        <h2 className="text-sm font-medium">报道（{detail.articles.length}）</h2>
        <div className="mt-3 space-y-3">
          {detail.articles.map((article, index) => (
            <div key={article.id} className="rounded-lg border border-neutral-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <a
                  href={article.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-sm font-medium text-neutral-900 hover:underline"
                >
                  [{index}] {article.title}
                </a>
                <Badge tone={article.scope === "excerpt" ? "accent" : "muted"}>
                  {article.scope === "excerpt" ? "摘要" : "标题"}
                </Badge>
                {article.unresolved ? <Badge tone="warn">链接未解析</Badge> : null}
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs text-neutral-400">
                <span>{article.publisher}</span>
                {article.publishedAt ? <span>· {relativeTime(article.publishedAt)}</span> : null}
              </div>
              {article.excerpt ? (
                <p className="mt-2 text-sm text-neutral-600">{article.excerpt}</p>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
