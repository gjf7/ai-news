import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { DbHandle } from "../db/connection.ts";
import { articles, events, insights } from "../db/schema.ts";
import type {
  EventDetail,
  EventList,
  EventQuery,
  EventSummary,
  InsightView,
} from "@ai-news/contracts";

/**
 * Read queries for the feed. Kept in one module so the route handlers stay
 * thin and the mapping from rows to API views lives in a single place.
 */

type EventRow = typeof events.$inferSelect;
type InsightRow = typeof insights.$inferSelect;

function toInsightView(row: InsightRow): InsightView {
  const output = row.output as {
    title?: string;
    facts?: { text: string; citations: string[] }[];
    importance?: { score: number; reason: string };
    impact?: string | null;
    watch?: string | null;
  };

  return {
    id: row.id,
    title: output.title ?? "",
    facts: output.facts ?? [],
    importanceScore: output.importance?.score ?? 0,
    importanceReason: output.importance?.reason ?? "",
    impact: output.impact ?? null,
    watch: output.watch ?? null,
    scope: row.scope,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
  };
}

function insightSummary(row: InsightRow | undefined): {
  title: string | null;
  summary: string | null;
} {
  if (!row) return { title: null, summary: null };
  const output = row.output as { title?: string; facts?: { text: string }[] };
  return { title: output.title ?? null, summary: output.facts?.[0]?.text ?? null };
}

export function listEvents(handle: DbHandle, query: EventQuery): EventList {
  const conditions = [];

  if (query.kind) conditions.push(eq(events.kind, query.kind));
  if (query.from) conditions.push(gte(events.effectiveTime, new Date(query.from)));
  if (query.to) conditions.push(lte(events.effectiveTime, new Date(query.to)));
  // Topic and source are SQL filters, not post-page filters: filtering after
  // pagination would return short pages and a wrong hasMore.
  if (query.topic) {
    conditions.push(
      sql`exists (select 1 from json_each(${events.topics}) where json_each.value = ${query.topic})`,
    );
  }
  if (query.source) {
    conditions.push(
      sql`exists (
        select 1 from articles a
        join article_sources asrc on asrc.article_id = a.id
        join sources s on s.id = asrc.source_id
        where a.event_id = ${events.id} and s.key = ${query.source}
      )`,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const totalRow = handle.db
    .select({ count: sql<number>`count(*)` })
    .from(events)
    .where(where)
    .get();
  const total = totalRow?.count ?? 0;

  const order =
    query.sort === "hot"
      ? [desc(events.hotScore), desc(events.effectiveTime), desc(events.id)]
      : query.sort === "importance"
        ? // Model-rated importance. SQLite sorts NULL below any number, so
          // events without an insight yet sink to the bottom.
          [
            desc(events.importance),
            desc(events.hotScore),
            desc(events.effectiveTime),
            desc(events.id),
          ]
        : [desc(events.effectiveTime), desc(events.id)];

  const rows = handle.db
    .select()
    .from(events)
    .where(where)
    .orderBy(...order)
    .limit(query.limit + 1)
    .offset((query.page - 1) * query.limit)
    .all();

  const hasMore = rows.length > query.limit;

  return {
    items: rows.slice(0, query.limit).map((event) => toSummary(handle, event)),
    page: query.page,
    hasMore,
    total,
  };
}

type EventStats = { articleCount: number; publisherCount: number; sources: string[] };

function eventStats(handle: DbHandle, eventId: string): EventStats {
  const rows = handle.sqlite
    .prepare(
      `SELECT a.publisher AS publisher, s.key AS sourceKey
       FROM articles a
       LEFT JOIN article_sources asrc ON asrc.article_id = a.id
       LEFT JOIN sources s ON s.id = asrc.source_id
       WHERE a.event_id = ?`,
    )
    .all(eventId) as { publisher: string; sourceKey: string | null }[];

  const publishers = new Set(rows.map((row) => row.publisher));
  const sources = new Set(rows.flatMap((row) => (row.sourceKey ? [row.sourceKey] : [])));
  return { articleCount: rows.length, publisherCount: publishers.size, sources: [...sources] };
}

function toSummary(handle: DbHandle, event: EventRow): EventSummary {
  const insight = event.latestInsightId
    ? handle.db.select().from(insights).where(eq(insights.id, event.latestInsightId)).get()
    : undefined;
  const { title, summary } = insightSummary(insight);
  const stats = eventStats(handle, event.id);

  return {
    id: event.id,
    title: event.title,
    insightTitle: title,
    insightSummary: summary,
    topics: event.topics,
    kind: event.kind as EventSummary["kind"],
    importance: event.importance,
    hotScore: event.hotScore,
    effectiveTime: event.effectiveTime.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
    articleCount: stats.articleCount,
    publisherCount: stats.publisherCount,
    analysisState: event.analysisState as EventSummary["analysisState"],
  };
}

export function getEventDetail(handle: DbHandle, id: string): EventDetail | null {
  const event = handle.db.select().from(events).where(eq(events.id, id)).get();
  if (!event) return null;

  const insight = event.latestInsightId
    ? handle.db.select().from(insights).where(eq(insights.id, event.latestInsightId)).get()
    : undefined;

  const rows = handle.db
    .select()
    .from(articles)
    .where(eq(articles.eventId, id))
    .orderBy(desc(articles.publishedAt))
    .all();

  // A Google News link that could not be resolved is recorded with its
  // discovery URL set; that flag is what the UI shows as "unresolved".
  const unresolvedIds = new Set(
    (
      handle.sqlite
        .prepare(
          `SELECT DISTINCT article_id AS id FROM article_sources
           WHERE discovery_url IS NOT NULL AND article_id IN (
             SELECT id FROM articles WHERE event_id = ?
           )`,
        )
        .all(id) as { id: string }[]
    ).map((row) => row.id),
  );

  return {
    ...toSummary(handle, event),
    insight: insight ? toInsightView(insight) : null,
    analysisError: event.analysisError,
    articles: rows.map((article) => ({
      id: article.id,
      title: article.title,
      url: article.canonicalUrl,
      publisher: article.publisher,
      scope: article.scope,
      publishedAt: article.publishedAt?.toISOString() ?? null,
      excerpt: article.excerpt,
      unresolved: unresolvedIds.has(article.id),
    })),
  };
}

/** `feedRevision` is max(events.updated_at): no separate counter table. */
export function feedRevision(handle: DbHandle): string | null {
  const row = handle.db
    .select({ value: sql<number | null>`max(updated_at)` })
    .from(events)
    .get();
  return row?.value ? new Date(row.value).toISOString() : null;
}
