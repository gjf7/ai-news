import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { configQueryOptions, sourcesQueryOptions } from "../../api/monitoring.ts";
import { Badge, Card, Spinner } from "../../components/ui/primitives.tsx";
import { request } from "../../lib/http.ts";

export const Route = createFileRoute("/_authenticated/sources")({
  component: SourcesPage,
});

function SourcesPage() {
  const sources = useQuery(sourcesQueryOptions);
  const config = useQuery(configQueryOptions);
  const client = useQueryClient();

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      request<void>(`/api/sources/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["sources"] }),
  });

  if (sources.isPending) return <Spinner label="加载中…" />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">来源</h1>
        <p className="mt-1 text-xs text-neutral-500">
          来源开关是唯一可以在网页修改的配置；其他配置通过环境变量设置。
        </p>
      </div>

      <div className="rounded-lg border border-neutral-200 bg-white">
        {(sources.data ?? []).map((source) => (
          <div
            key={source.id}
            className="flex items-center justify-between border-b border-neutral-100 px-4 py-3 last:border-b-0"
          >
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{source.key}</span>
                {!source.analyze ? <Badge tone="muted">不生成洞察</Badge> : null}
              </div>
              <div className="mt-0.5 text-xs text-neutral-400">
                {source.lastFetched !== null
                  ? `最近抓取 ${source.lastFetched} 条，新增 ${source.lastNewArticles ?? 0} 条`
                  : "尚未抓取"}
                {source.statusReason ? ` · ${source.statusReason}` : ""}
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-500">
              <input
                type="checkbox"
                checked={source.enabled}
                disabled={toggle.isPending}
                onChange={(event) =>
                  toggle.mutate({ id: source.id, enabled: event.target.checked })
                }
              />
              {source.enabled ? "已启用" : "已停用"}
            </label>
          </div>
        ))}
        {(sources.data ?? []).length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-neutral-400">
            还没有来源记录。执行一次刷新后会自动登记。
          </p>
        ) : null}
      </div>

      <Card>
        <h2 className="text-sm font-medium">运行配置（只读）</h2>
        {config.data ? (
          <dl className="mt-3 grid grid-cols-2 gap-y-2 text-xs">
            <Row label="环境" value={config.data.nodeEnv} />
            <Row label="刷新间隔" value={`${config.data.refreshIntervalMinutes} 分钟`} />
            <Row label="推送" value={config.data.notify.enabled ? "已启用" : "已停用"} />
            <Row label="每轮最多" value={`${config.data.notify.maxItems} 条`} />
            <Row label="重要性阈值" value={String(config.data.notify.minImportance)} />
            <Row label="模型" value={config.data.model.name} />
            <Row
              label="模型密钥"
              value={config.data.configured.modelApiKey ? "已配置" : "未配置"}
            />
            <Row label="Telegram" value={config.data.configured.telegram ? "已配置" : "未配置"} />
          </dl>
        ) : (
          <p className="mt-2 text-xs text-neutral-400">加载中…</p>
        )}
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-neutral-400">{label}</dt>
      <dd className="text-neutral-800">{value}</dd>
    </>
  );
}
