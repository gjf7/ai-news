/**
 * The shared tag vocabulary. Ids are stored in `articles.topics` and
 * `events.topics`, so they are part of the API and the URL search params.
 * Labels live here too so the server prompts and the web UI cannot drift.
 *
 * The first two are the broad beats; the rest subdivide them. An event can
 * carry several tags at once.
 */
export const TAG_IDS = [
  "ai",
  "semiconductor",
  "model",
  "agent",
  "infra",
  "design",
  "manufacturing",
  "memory",
  "research",
  "capital",
  "policy",
  "safety",
] as const;

export type TagId = (typeof TAG_IDS)[number];

/** Display order is the array order above. */
export const TAG_LABELS: Record<TagId, string> = {
  ai: "AI",
  semiconductor: "半导体",
  model: "大模型",
  agent: "AI 应用",
  infra: "算力",
  design: "芯片设计",
  manufacturing: "制造与设备",
  memory: "存储",
  research: "研究",
  capital: "资本与市场",
  policy: "政策监管",
  safety: "安全与风险",
};

export const TAG_LIST: { id: TagId; label: string }[] = TAG_IDS.map((id) => ({
  id,
  label: TAG_LABELS[id],
}));

export function isTagId(value: unknown): value is TagId {
  return typeof value === "string" && (TAG_IDS as readonly string[]).includes(value);
}
