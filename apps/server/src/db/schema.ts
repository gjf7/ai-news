import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** UTC milliseconds. All timestamps in the schema use this shape. */
const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

export const sources = sqliteTable("sources", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  adapter: text("adapter").notNull(),
  config: text("config", { mode: "json" }).notNull().default({}),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  defaultTopics: text("default_topics", { mode: "json" }).notNull().default([]),
  /** Whether articles from this source generate insights (arXiv defaults false). */
  analyze: integer("analyze", { mode: "boolean" }).notNull().default(true),
  status: text("status").notNull().default("unknown"),
  statusReason: text("status_reason"),
  createdAt: timestamp("created_at")
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    topics: text("topics", { mode: "json" }).$type<string[]>().notNull().default([]),
    kind: text("kind").notNull().default("news"),
    firstSeenAt: timestamp("first_seen_at").notNull(),
    lastArticleAt: timestamp("last_article_at").notNull(),
    /** coalesce(min published_at, first_seen_at); recomputed on article attach. */
    effectiveTime: timestamp("effective_time").notNull(),
    hotScore: integer("hot_score").notNull().default(0),
    latestInsightId: text("latest_insight_id"),
    analysisState: text("analysis_state").notNull().default("pending"),
    analysisError: text("analysis_error"),
    analysisRunId: text("analysis_run_id"),
    importance: integer("importance"),
    notificationRevision: integer("notification_revision").notNull().default(0),
    revisionBumpedRunId: text("revision_bumped_run_id"),
    notifiedRevision: integer("notified_revision").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    index("events_effective_time_idx").on(table.effectiveTime, table.id),
    index("events_updated_at_idx").on(table.updatedAt),
    check(
      "events_notified_revision_check",
      sql`${table.notifiedRevision} <= ${table.notificationRevision}`,
    ),
    check(
      "events_analysis_state_check",
      sql`${table.analysisState} in ('pending','ok','failed','skipped')`,
    ),
  ],
);

export const insights = sqliteTable(
  "insights",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    inputHash: text("input_hash").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    scope: text("scope").notNull(),
    output: text("output", { mode: "json" }).notNull(),
    evidence: text("evidence", { mode: "json" }).notNull(),
    /** Event notification revision at publish time. */
    revision: integer("revision").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("insights_event_input_hash_unique").on(table.eventId, table.inputHash),
    // Enables the composite foreign key from events(latest_insight_id, id).
    uniqueIndex("insights_id_event_id_unique").on(table.id, table.eventId),
  ],
);

export const articles = sqliteTable(
  "articles",
  {
    id: text("id").primaryKey(),
    canonicalUrl: text("canonical_url").notNull().unique(),
    publisher: text("publisher").notNull(),
    title: text("title").notNull(),
    titleNorm: text("title_norm").notNull(),
    publishedAt: timestamp("published_at"),
    discoveredAt: timestamp("discovered_at").notNull(),
    /** "headline" | "excerpt" — never fulltext; the body is not fetched. */
    scope: text("scope").notNull(),
    excerpt: text("excerpt"),
    relevance: text("relevance").notNull().default("pending"),
    topics: text("topics", { mode: "json" }).$type<string[]>().notNull().default([]),
    kind: text("kind").notNull().default("news"),
    eventId: text("event_id").references(() => events.id, { onDelete: "set null" }),
    communityScore: integer("community_score"),
  },
  (table) => [
    index("articles_event_id_idx").on(table.eventId),
    index("articles_discovered_at_idx").on(table.discoveredAt),
    check(
      "articles_relevance_check",
      sql`${table.relevance} in ('pending','relevant','irrelevant')`,
    ),
    check("articles_scope_check", sql`${table.scope} in ('headline','excerpt')`),
  ],
);

export const articleSources = sqliteTable(
  "article_sources",
  {
    articleId: text("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    discoveryUrl: text("discovery_url"),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.sourceId] }),
    uniqueIndex("article_sources_source_external_unique")
      .on(table.sourceId, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
  ],
);

export const refreshRuns = sqliteTable(
  "refresh_runs",
  {
    id: text("id").primaryKey(),
    trigger: text("trigger").notNull(),
    slot: integer("slot"),
    state: text("state").notNull().default("queued"),
    /**
     * Sentinel column for the single-active-run constraint: 1 while the run is
     * queued or running, NULL once it reaches a terminal state. Keeping it a
     * real column lets SQLite enforce the invariant with a partial unique index.
     */
    activeSlot: integer("active_slot"),
    attempt: integer("attempt").notNull().default(0),
    progress: text("progress", { mode: "json" }),
    result: text("result", { mode: "json" }),
    error: text("error"),
    queuedAt: timestamp("queued_at").notNull(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    uniqueIndex("one_active_run")
      .on(table.activeSlot)
      .where(sql`${table.activeSlot} IS NOT NULL`),
    index("refresh_runs_queued_idx").on(table.state, table.queuedAt),
    check(
      "refresh_runs_state_check",
      sql`${table.state} in ('queued','running','succeeded','partial','failed')`,
    ),
    // state and active_slot must agree, so no UPDATE can desynchronise them.
    check(
      "refresh_runs_active_slot_check",
      sql`(${table.state} in ('queued','running')) = (${table.activeSlot} IS NOT NULL)`,
    ),
  ],
);

export const sourceRuns = sqliteTable(
  "source_runs",
  {
    runId: text("run_id")
      .notNull()
      .references(() => refreshRuns.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("pending"),
    fetched: integer("fetched").notNull().default(0),
    newArticles: integer("new_articles").notNull().default(0),
    error: text("error"),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [primaryKey({ columns: [table.runId, table.sourceId] })],
);

export const deliveries = sqliteTable(
  "deliveries",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => refreshRuns.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull(),
    /** [{ eventId, revision, insightId }] frozen at delivery time. */
    items: text("items", { mode: "json" }).notNull(),
    text: text("text").notNull(),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at"),
    messageId: text("message_id"),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at"),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    index("deliveries_state_next_attempt_idx").on(table.state, table.nextAttemptAt),
    check("deliveries_state_check", sql`${table.state} in ('pending','sent','failed')`),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [index("sessions_expires_at_idx").on(table.expiresAt)],
);
