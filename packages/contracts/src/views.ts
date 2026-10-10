import { z } from "zod";

/**
 * Read models exposed by the API. These are deliberately separate from the
 * Drizzle tables so storage changes do not leak into the web client.
 */

export const EventKind = z.enum(["news", "paper", "discussion"]);
export const AnalysisState = z.enum(["pending", "ok", "failed", "skipped"]);

export const InsightView = z.object({
  id: z.string(),
  title: z.string(),
  facts: z.array(z.object({ text: z.string(), citations: z.array(z.string()) })),
  importanceScore: z.number(),
  importanceReason: z.string(),
  impact: z.string().nullable(),
  watch: z.string().nullable(),
  scope: z.string(),
  model: z.string(),
  createdAt: z.string(),
});

export type InsightView = z.infer<typeof InsightView>;

export const EventSummary = z.object({
  id: z.string(),
  title: z.string(),
  insightTitle: z.string().nullable(),
  insightSummary: z.string().nullable(),
  topics: z.array(z.string()),
  kind: EventKind,
  importance: z.number().nullable(),
  hotScore: z.number(),
  effectiveTime: z.string(),
  updatedAt: z.string(),
  articleCount: z.number(),
  publisherCount: z.number(),
  analysisState: AnalysisState,
});

export type EventSummary = z.infer<typeof EventSummary>;

export const EventArticleView = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  publisher: z.string(),
  scope: z.string(),
  publishedAt: z.string().nullable(),
  excerpt: z.string().nullable(),
  unresolved: z.boolean(),
});

export type EventArticleView = z.infer<typeof EventArticleView>;

export const EventDetail = EventSummary.extend({
  insight: InsightView.nullable(),
  articles: z.array(EventArticleView),
  analysisError: z.string().nullable(),
});

export type EventDetail = z.infer<typeof EventDetail>;

export const EventList = z.object({
  items: z.array(EventSummary),
  page: z.number(),
  hasMore: z.boolean(),
  total: z.number(),
});

export type EventList = z.infer<typeof EventList>;

export const FeedStatus = z.object({
  feedRevision: z.string().nullable(),
  activeRun: z
    .object({ runId: z.string(), state: z.string(), progress: z.unknown().nullable() })
    .nullable(),
  lastAttemptAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  nextScheduledAt: z.string(),
});

export type FeedStatus = z.infer<typeof FeedStatus>;

export const RunSummary = z.object({
  id: z.string(),
  trigger: z.string(),
  state: z.string(),
  attempt: z.number(),
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  result: z.unknown().nullable(),
  progress: z.unknown().nullable(),
  error: z.string().nullable(),
});

export type RunSummary = z.infer<typeof RunSummary>;

export const SourceRunView = z.object({
  sourceId: z.string(),
  key: z.string(),
  state: z.string(),
  fetched: z.number(),
  newArticles: z.number(),
  error: z.string().nullable(),
});

export const RunDetail = RunSummary.extend({
  sources: z.array(SourceRunView),
  /** Events this run left with analysis_state = failed. */
  failedEvents: z.array(
    z.object({ id: z.string(), title: z.string(), error: z.string().nullable() }),
  ),
});

export type RunDetail = z.infer<typeof RunDetail>;

export const RunList = z.object({
  items: z.array(RunSummary),
  page: z.number(),
  hasMore: z.boolean(),
});

export type RunList = z.infer<typeof RunList>;

export const SourceView = z.object({
  id: z.string(),
  key: z.string(),
  adapter: z.string(),
  enabled: z.boolean(),
  analyze: z.boolean(),
  topics: z.array(z.string()),
  status: z.string(),
  statusReason: z.string().nullable(),
  lastFetched: z.number().nullable(),
  lastNewArticles: z.number().nullable(),
});

export type SourceView = z.infer<typeof SourceView>;

export const SourceList = z.array(SourceView);
export type SourceList = z.infer<typeof SourceList>;

export const DeliveryView = z.object({
  id: z.string(),
  /** "refresh" for the per-run push, "digest" for the daily summary. */
  kind: z.string(),
  state: z.string(),
  attempts: z.number(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  messageId: z.string().nullable(),
  lastError: z.string().nullable(),
  text: z.string(),
  itemCount: z.number(),
});

export type DeliveryView = z.infer<typeof DeliveryView>;

export const DeliveryList = z.object({
  items: z.array(DeliveryView),
  page: z.number(),
  hasMore: z.boolean(),
});

export type DeliveryList = z.infer<typeof DeliveryList>;

export const ConfigView = z.object({
  nodeEnv: z.string(),
  refreshIntervalMinutes: z.number(),
  retentionDays: z.number(),
  notify: z.object({
    enabled: z.boolean(),
    maxItems: z.number(),
    minImportance: z.number(),
    digest: z.object({
      enabled: z.boolean(),
      hourUtc: z.number(),
      maxItems: z.number(),
      minImportance: z.number(),
    }),
  }),
  model: z.object({ baseUrl: z.string(), name: z.string() }),
  configured: z.object({ modelApiKey: z.boolean(), telegram: z.boolean() }),
});

export type ConfigView = z.infer<typeof ConfigView>;

/** Query parameters accepted by GET /events. */
export const EventQuery = z.object({
  topic: z.string().optional(),
  source: z.string().optional(),
  kind: EventKind.optional(),
  sort: z.enum(["hot", "importance", "latest"]).default("latest"),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type EventQuery = z.infer<typeof EventQuery>;

/**
 * The subset the web app puts in the URL. Distinct from EventQuery because the
 * router search params must all be optional and must not apply defaults.
 */
export const EventSearchParams = z.object({
  topic: z.string().optional(),
  kind: EventKind.optional(),
  sort: z.enum(["hot", "importance", "latest"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

export type EventSearchParams = z.infer<typeof EventSearchParams>;
