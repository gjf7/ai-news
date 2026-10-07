/** Formats an ISO timestamp for display in Asia/Shanghai. */
export function formatShanghai(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Relative time in Chinese, e.g. "5 分钟前". */
export function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const deltaMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export const PHASE_LABELS: Record<string, string> = {
  collecting: "采集来源",
  filtering: "相关性过滤",
  clustering: "事件聚合",
  analyzing: "生成洞察",
  publishing: "发布",
  notifying: "推送",
};

export const STATE_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  succeeded: "成功",
  partial: "部分成功",
  failed: "失败",
  pending: "待处理",
  ok: "已分析",
  skipped: "仅标题",
  sent: "已发送",
  irrelevant: "已过滤",
};

export function labelFor(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}
