import { Link } from "@tanstack/react-router";
import { isTagId, TAG_LABELS, type EventSummary } from "@ai-news/contracts";
import { Badge } from "../ui/primitives.tsx";
import { relativeTime } from "../../lib/format.ts";

export function EventCard({
  event,
  sort,
  focus = false,
}: {
  event: EventSummary;
  sort?: "hot" | "importance" | "latest";
  /** True when this event is in today's focus list. */
  focus?: boolean;
}) {
  return (
    <article className="border-b border-neutral-200 py-4 first:pt-0 last:border-b-0">
      <Link
        to="/events/$eventId"
        params={{ eventId: event.id }}
        className="block rounded-md p-2 -m-2 hover:bg-neutral-50"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-sm font-medium leading-snug text-neutral-900">
            {event.insightTitle ?? event.title}
          </h2>
          <div className="shrink-0 text-right text-xs leading-5 tabular-nums">
            <div
              className={sort === "hot" ? "font-medium text-neutral-900" : "text-neutral-400"}
              title="讨论与多来源报道的热度，随时间衰减"
            >
              热度 {Math.round(event.hotScore / 10)}
            </div>
            {event.importance !== null ? (
              <div
                className={
                  sort === "importance" ? "font-medium text-neutral-900" : "text-neutral-400"
                }
                title="模型判断的事件重要性"
              >
                重要性 {event.importance}
              </div>
            ) : null}
          </div>
        </div>

        {event.insightSummary ? (
          <p className="mt-1.5 line-clamp-2 text-sm text-neutral-600">{event.insightSummary}</p>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-400">
          {focus ? <Badge tone="accent">重点</Badge> : null}
          {event.topics.map((topic) => (
            <Badge key={topic} tone="accent">
              {isTagId(topic) ? TAG_LABELS[topic] : topic}
            </Badge>
          ))}
          {event.analysisState === "pending" ? <Badge tone="muted">待分析</Badge> : null}
          {event.analysisState === "failed" ? <Badge tone="warn">分析失败</Badge> : null}
          {event.analysisState === "skipped" ? <Badge tone="muted">仅标题</Badge> : null}
          <span>{event.articleCount} 篇</span>
          {event.publisherCount > 1 ? <span>· {event.publisherCount} 个来源</span> : null}
          <span>· {relativeTime(event.effectiveTime)}</span>
        </div>
      </Link>
    </article>
  );
}
