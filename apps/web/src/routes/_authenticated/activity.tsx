import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { deliveriesQueryOptions, runQueryOptions, runsQueryOptions } from "../../api/monitoring.ts";
import { Badge, Button, Card, Spinner } from "../../components/ui/primitives.tsx";
import { request } from "../../lib/http.ts";
import { formatShanghai, labelFor, PHASE_LABELS, STATE_LABELS } from "../../lib/format.ts";

export const Route = createFileRoute("/_authenticated/activity")({
  component: ActivityPage,
});

function ActivityPage() {
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const runs = useQuery(runsQueryOptions(page));
  const deliveries = useQuery(deliveriesQueryOptions(1));
  const client = useQueryClient();

  const retry = useMutation({
    mutationFn: (id: string) =>
      request<{ ok: boolean }>(`/api/deliveries/${id}/retry`, { method: "POST" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["deliveries"] }),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">活动</h1>

      <section>
        <h2 className="text-sm font-medium">刷新记录</h2>
        {runs.isPending ? <Spinner label="加载中…" /> : null}
        <div className="mt-3 rounded-lg border border-neutral-200 bg-white">
          {(runs.data?.items ?? []).map((run) => {
            const result = run.result as { newArticles?: number; updatedEvents?: number } | null;
            const progress = run.progress as { phase?: string } | null;
            return (
              <div key={run.id} className="border-b border-neutral-100 last:border-b-0">
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === run.id ? null : run.id)}
                  className="flex w-full items-center justify-between px-4 py-3 text-left text-sm hover:bg-neutral-50"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <Badge
                        tone={
                          run.state === "succeeded"
                            ? "accent"
                            : run.state === "failed"
                              ? "warn"
                              : "neutral"
                        }
                      >
                        {labelFor(STATE_LABELS, run.state)}
                      </Badge>
                      <span className="text-xs text-neutral-500">
                        {run.trigger === "schedule" ? "自动" : "手动"}
                      </span>
                      {run.state === "running" && progress?.phase ? (
                        <span className="text-xs text-neutral-400">
                          {labelFor(PHASE_LABELS, progress.phase)}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 text-xs text-neutral-400">
                      {formatShanghai(run.queuedAt)}
                      {result
                        ? ` · 新增 ${result.newArticles ?? 0} 篇，更新 ${result.updatedEvents ?? 0} 个事件`
                        : ""}
                      {run.error ? ` · ${run.error.slice(0, 60)}` : ""}
                    </div>
                  </div>
                  <span className="text-xs text-neutral-400">
                    #{run.attempt} {expanded === run.id ? "▲" : "▼"}
                  </span>
                </button>
                {expanded === run.id ? <RunDetailPanel runId={run.id} /> : null}
              </div>
            );
          })}
          {(runs.data?.items ?? []).length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-neutral-400">还没有执行记录</p>
          ) : null}
        </div>

        {runs.data ? (
          <div className="mt-3 flex items-center justify-between">
            <Button variant="ghost" onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>
              上一页
            </Button>
            <span className="text-xs text-neutral-400">第 {page} 页</span>
            <Button
              variant="ghost"
              onClick={() => setPage((p) => p + 1)}
              disabled={!runs.data.hasMore}
            >
              下一页
            </Button>
          </div>
        ) : null}
      </section>

      <section>
        <h2 className="text-sm font-medium">推送记录</h2>
        {deliveries.isPending ? <Spinner label="加载中…" /> : null}
        <div className="mt-3 space-y-3">
          {(deliveries.data?.items ?? []).map((delivery) => (
            <Card key={delivery.id}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge
                    tone={
                      delivery.state === "sent"
                        ? "accent"
                        : delivery.state === "failed"
                          ? "warn"
                          : "neutral"
                    }
                  >
                    {labelFor(STATE_LABELS, delivery.state)}
                  </Badge>
                  <span className="text-xs text-neutral-400">
                    {formatShanghai(delivery.createdAt)} · {delivery.itemCount} 条 · 尝试{" "}
                    {delivery.attempts} 次
                  </span>
                </div>
                {delivery.state === "failed" ? (
                  <Button
                    variant="ghost"
                    onClick={() => retry.mutate(delivery.id)}
                    disabled={retry.isPending}
                  >
                    重试
                  </Button>
                ) : null}
              </div>
              <pre className="mt-2 whitespace-pre-wrap text-xs text-neutral-600">
                {delivery.text}
              </pre>
              {delivery.lastError ? (
                <p className="mt-2 text-xs text-red-600">{delivery.lastError}</p>
              ) : null}
            </Card>
          ))}
          {(deliveries.data?.items ?? []).length === 0 ? (
            <p className="rounded-lg border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-400">
              还没有推送记录
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/** Per-source results and analysis failures for one run, loaded on expand. */
function RunDetailPanel({ runId }: { runId: string }) {
  const detail = useQuery(runQueryOptions(runId, false));

  if (detail.isPending) return <p className="px-4 pb-3 text-xs text-neutral-400">加载中…</p>;
  if (!detail.data) return null;

  const failedSources = detail.data.sources.filter((source) => source.state === "failed");

  return (
    <div className="border-t border-neutral-100 bg-neutral-50 px-4 py-3 text-xs">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        {detail.data.sources.map((source) => (
          <div key={source.sourceId} className="flex items-center justify-between gap-2">
            <span className={source.state === "failed" ? "text-red-600" : "text-neutral-600"}>
              {source.key}
            </span>
            <span className="text-neutral-400">
              {source.state === "done" ? `${source.fetched} 条` : source.state}
            </span>
          </div>
        ))}
      </div>

      {failedSources.length > 0 ? (
        <div className="mt-3 space-y-1">
          <p className="text-neutral-500">来源失败：</p>
          {failedSources.map((source) => (
            <p key={source.sourceId} className="text-red-600">
              {source.key}: {(source.error ?? "").slice(0, 120)}
            </p>
          ))}
        </div>
      ) : null}

      {detail.data.failedEvents.length > 0 ? (
        <div className="mt-3 space-y-1">
          <p className="text-neutral-500">分析失败的事件（{detail.data.failedEvents.length}）：</p>
          {detail.data.failedEvents.slice(0, 10).map((event) => (
            <p key={event.id} className="text-amber-700">
              {event.title.slice(0, 60)}
              {event.error ? ` — ${event.error.slice(0, 60)}` : ""}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
