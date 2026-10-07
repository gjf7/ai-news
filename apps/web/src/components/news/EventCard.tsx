import { Link } from "@tanstack/react-router";
import type { EventSummary } from "@ai-news/contracts";
import { Badge } from "../ui/primitives.tsx";
import { relativeTime } from "../../lib/format.ts";

const TOPIC_LABELS: Record<string, string> = {
  ai: "AI",
  semiconductor: "半导体",
};

export function EventCard({ event }: { event: EventSummary }) {
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
          {event.importance !== null ? (
            <span className="shrink-0 text-xs tabular-nums text-neutral-400">
              {event.importance}
            </span>
          ) : null}
        </div>

        {event.insightSummary ? (
          <p className="mt-1.5 line-clamp-2 text-sm text-neutral-600">{event.insightSummary}</p>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-400">
          {event.topics.map((topic) => (
            <Badge key={topic} tone="accent">
              {TOPIC_LABELS[topic] ?? topic}
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
