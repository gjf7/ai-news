import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { createDb, type DbHandle } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { pruneOldData } from "../src/db/retention.ts";
import { articles, deliveries, events, insights, refreshRuns } from "../src/db/schema.ts";

let dir: string;
let handle: DbHandle;
const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-10T00:00:00Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-news-retention-"));
  handle = createDb(join(dir, "app.db"));
  migrate(handle.sqlite);

  handle.db
    .insert(refreshRuns)
    .values({
      id: "run1",
      trigger: "manual",
      state: "succeeded",
      activeSlot: null,
      attempt: 1,
      queuedAt: now,
      finishedAt: now,
    })
    .run();
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedEvent(id: string, updatedAt: Date) {
  handle.db
    .insert(events)
    .values({
      id,
      title: `Event ${id}`,
      topics: [],
      kind: "news",
      firstSeenAt: updatedAt,
      lastArticleAt: updatedAt,
      effectiveTime: updatedAt,
      hotScore: 0,
      analysisState: "ok",
      notificationRevision: 0,
      notifiedRevision: 0,
      updatedAt,
    })
    .run();
}

function seedArticle(id: string, eventId: string | null, discoveredAt: Date) {
  handle.db
    .insert(articles)
    .values({
      id,
      canonicalUrl: `https://example.com/${id}`,
      publisher: "Example",
      title: `Article ${id}`,
      titleNorm: `article ${id}`,
      discoveredAt,
      scope: "headline",
      relevance: "relevant",
      eventId,
    })
    .run();
}

function seedInsight(id: string, eventId: string) {
  handle.db
    .insert(insights)
    .values({
      id,
      eventId,
      inputHash: `hash-${id}`,
      model: "m",
      promptVersion: "v",
      scope: "headline",
      output: {},
      evidence: [],
      revision: 1,
      createdAt: now,
    })
    .run();
}

function seedDelivery(id: string, state: string, createdAt: Date) {
  handle.db
    .insert(deliveries)
    .values({
      id,
      runId: "run1",
      chatId: "1",
      kind: "refresh",
      items: [],
      text: "x",
      state,
      attempts: 0,
      createdAt,
    })
    .run();
}

function seedAll() {
  // Old event with an insight and an attached (old) article.
  seedEvent("old-event", new Date(now.getTime() - 100 * DAY));
  seedInsight("ins-old", "old-event");
  handle.db
    .update(events)
    .set({ latestInsightId: "ins-old" })
    .where(eq(events.id, "old-event"))
    .run();
  seedArticle("art-of-old", "old-event", new Date(now.getTime() - 100 * DAY));

  // Recent event with its own article: everything must survive.
  seedEvent("new-event", new Date(now.getTime() - 1 * DAY));
  seedArticle("art-of-new", "new-event", new Date(now.getTime() - 1 * DAY));

  // Orphans: an old one is pruned, a recent one is kept.
  seedArticle("orphan-old", null, new Date(now.getTime() - 100 * DAY));
  seedArticle("orphan-new", null, new Date(now.getTime() - 1 * DAY));

  seedDelivery("del-pending-old", "pending", new Date(now.getTime() - 100 * DAY));
  seedDelivery("del-sent-old", "sent", new Date(now.getTime() - 100 * DAY));
  seedDelivery("del-sent-new", "sent", new Date(now.getTime() - 1 * DAY));
}

test("days = 0 disables pruning", () => {
  seedAll();
  const result = pruneOldData(handle, { days: 0, now });
  expect(result).toEqual({ events: 0, articles: 0, deliveries: 0 });
  expect(handle.db.select().from(events).all()).toHaveLength(2);
});

test("old events, their insights and orphans are pruned; recent rows survive", () => {
  seedAll();
  const result = pruneOldData(handle, { days: 30, now });
  expect(result).toEqual({ events: 1, articles: 2, deliveries: 1 });

  expect(
    handle.db
      .select()
      .from(events)
      .all()
      .map((row) => row.id),
  ).toEqual(["new-event"]);
  // The old event's insight cascaded away with it.
  expect(handle.db.select().from(insights).all()).toHaveLength(0);
  // The retained event keeps its article; the recent orphan is kept.
  expect(
    handle.db
      .select()
      .from(articles)
      .all()
      .map((row) => row.id)
      .sort(),
  ).toEqual(["art-of-new", "orphan-new"]);

  // A pending delivery is never removed; the recent sent one stays.
  expect(
    handle.db
      .select()
      .from(deliveries)
      .all()
      .map((row) => row.id)
      .sort(),
  ).toEqual(["del-pending-old", "del-sent-new"]);
});

test("pruning is idempotent: a second pass removes nothing", () => {
  seedAll();
  pruneOldData(handle, { days: 30, now });
  expect(pruneOldData(handle, { days: 30, now })).toEqual({
    events: 0,
    articles: 0,
    deliveries: 0,
  });
});
