import { Link } from "@tanstack/react-router";
import { FOCUS_MAX_ITEMS, FOCUS_WINDOW_HOURS, type EventSummary } from "@ai-news/contracts";
import { relativeTime } from "../../lib/format.ts";

/**
 * The handful of events worth reading now, above the feed. Renders nothing when
 * the server found none: a block that always has content stops being a signal.
 */
export function FocusBlock({ items }: { items: EventSummary[] }) {
  if (items.length === 0) return null;

  return (
    <section
      aria-labelledby="focus-heading"
      className="rounded-md border-l-2 border-blue-500 bg-blue-50 px-4 py-3"
    >
      <div className="flex items-baseline gap-2">
        <h2 id="focus-heading" className="text-sm font-medium text-blue-900">
          今日重点
        </h2>
        <span className="text-xs text-blue-800/60">
          近 {FOCUS_WINDOW_HOURS} 小时 · 最多 {FOCUS_MAX_ITEMS} 条
        </span>
      </div>

      <ul className="mt-2 space-y-2">
        {items.map((event) => (
          <li key={event.id}>
            <Link
              to="/events/$eventId"
              params={{ eventId: event.id }}
              className="group flex items-start justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="line-clamp-1 text-sm font-medium text-neutral-900 group-hover:underline">
                  {event.insightTitle ?? event.title}
                </p>
                {event.importanceReason ? (
                  <p className="mt-0.5 line-clamp-2 text-xs text-neutral-600">
                    {event.importanceReason}
                  </p>
                ) : null}
                <p className="mt-0.5 text-xs text-blue-800/60">
                  {event.publisherCount > 1 ? `${event.publisherCount} 个来源 · ` : ""}
                  {relativeTime(event.effectiveTime)}
                </p>
              </div>
              <span className="shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-xs tabular-nums text-blue-800">
                重点 {event.importance}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
