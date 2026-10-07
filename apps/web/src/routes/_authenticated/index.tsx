import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { EventSearchParams } from "@ai-news/contracts";
import { eventsQueryOptions, type EventFilters } from "../../api/events.ts";
import { EventCard } from "../../components/news/EventCard.tsx";
import { EventFiltersBar } from "../../components/news/EventFiltersBar.tsx";
import { Button, EmptyState, ErrorNotice, Spinner } from "../../components/ui/primitives.tsx";
import { useFeedSync } from "../../hooks/useFeedSync.ts";
import { useRefresh } from "../../hooks/useRefresh.ts";
import { PHASE_LABELS, labelFor } from "../../lib/format.ts";

const searchSchema = EventSearchParams;

export const Route = createFileRoute("/_authenticated/")({
  validateSearch: searchSchema,
  component: NewsPage,
});

function NewsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [atTop, setAtTop] = useState(true);
  const lastPage = useRef(search.page ?? 1);

  const filters: EventFilters = {
    topic: search.topic,
    kind: search.kind,
    sort: search.sort ?? "latest",
    page: search.page ?? 1,
  };

  const events = useQuery(eventsQueryOptions(filters));
  const { refresh, status, activeRun } = useRefresh();

  // Auto-reload only while the reader is at the top of the first page; paging
  // or scrolling shows a prompt instead so the reading position is preserved.
  const { hasNewContent, acknowledge } = useFeedSync({
    autoReload: atTop && filters.page === 1,
  });

  // Client-side dedup by event id: a page boundary can repeat an event when the
  // ordering shifts mid-refresh.
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (events.data?.items ?? []).filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    });
  }, [events.data]);

  // Page changes reset the reading position, so the next update can auto-reload.
  useEffect(() => {
    if (lastPage.current !== filters.page) {
      lastPage.current = filters.page ?? 1;
      setAtTop(true);
    }
  }, [filters.page]);

  const applyFilters = (next: EventFilters) => {
    void navigate({
      to: "/",
      search: {
        topic: next.topic,
        kind: next.kind as EventSearchParams["kind"],
        sort: next.sort,
        page: next.page,
      },
    });
  };

  const reload = () => {
    acknowledge();
    setAtTop(true);
    // "New content" always returns to the first page.
    if (filters.page !== 1) {
      applyFilters({ ...filters, page: 1 });
      return;
    }
    void events.refetch();
  };

  const progress = activeRun?.progress as
    | { phase?: string; sourcesDone?: number; sourcesTotal?: number }
    | undefined;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">新闻</h1>
        <div className="flex items-center gap-3">
          {activeRun ? (
            <span className="text-xs text-neutral-500">
              {labelFor(PHASE_LABELS, progress?.phase ?? "")}
              {progress?.sourcesTotal
                ? ` ${progress.sourcesDone ?? 0}/${progress.sourcesTotal}`
                : ""}
            </span>
          ) : null}
          <Button onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? "刷新中…" : "刷新"}
          </Button>
        </div>
      </div>

      {refresh.error ? <ErrorNotice message="刷新请求失败，请稍后再试" /> : null}

      <EventFiltersBar filters={filters} onChange={applyFilters} />

      {hasNewContent ? (
        <button
          type="button"
          onClick={reload}
          className="w-full rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700 hover:bg-blue-100"
        >
          有新内容，点击查看
        </button>
      ) : null}

      {events.isPending ? <Spinner label="加载中…" /> : null}
      {events.error ? <ErrorNotice message="加载失败，请刷新页面重试" /> : null}

      {events.data && items.length === 0 ? (
        <EmptyState
          title="还没有内容"
          hint={
            status.data?.lastSuccessAt
              ? "最近一轮没有新的相关新闻。"
              : "点「刷新」立即采集一轮，或等待下一次自动刷新。"
          }
        />
      ) : null}

      {items.length > 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white px-5 py-2">
          {items.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      ) : null}

      {events.data && (events.data.page > 1 || events.data.hasMore) ? (
        <div className="flex items-center justify-between pt-2">
          <Button
            variant="ghost"
            onClick={() => applyFilters({ ...filters, page: events.data!.page - 1 })}
            disabled={events.data.page <= 1}
          >
            上一页
          </Button>
          <span className="text-xs text-neutral-400">第 {events.data.page} 页</span>
          <Button
            variant="ghost"
            onClick={() => applyFilters({ ...filters, page: events.data!.page + 1 })}
            disabled={!events.data.hasMore}
          >
            下一页
          </Button>
        </div>
      ) : null}
    </div>
  );
}
