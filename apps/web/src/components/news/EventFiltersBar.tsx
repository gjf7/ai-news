import type { EventFilters } from "../../api/events.ts";

const TOPICS = [
  { value: undefined, label: "全部" },
  { value: "ai", label: "AI" },
  { value: "semiconductor", label: "半导体" },
];

const SORTS = [
  { value: "latest" as const, label: "最新" },
  { value: "hot" as const, label: "热点" },
  { value: "importance" as const, label: "重要性" },
];

const KINDS = [
  { value: undefined, label: "全部" },
  { value: "news", label: "新闻" },
  { value: "paper", label: "论文" },
  { value: "discussion", label: "讨论" },
];

export function EventFiltersBar({
  filters,
  onChange,
}: {
  filters: EventFilters;
  onChange: (next: EventFilters) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-neutral-200 pb-4">
      <Group
        label="主题"
        options={TOPICS}
        value={filters.topic}
        onSelect={(topic) => onChange({ ...filters, topic, page: 1 })}
      />
      <Group
        label="类型"
        options={KINDS}
        value={filters.kind}
        onSelect={(kind) => onChange({ ...filters, kind, page: 1 })}
      />
      <Group
        label="排序"
        options={SORTS}
        value={filters.sort ?? "latest"}
        onSelect={(sort) => onChange({ ...filters, sort, page: 1 })}
      />
    </div>
  );
}

function Group<T extends string | undefined>({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onSelect: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-neutral-400">{label}</span>
      <div className="flex gap-1">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.label}
              type="button"
              onClick={() => onSelect(option.value)}
              className={`rounded px-2 py-1 ${
                active ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
