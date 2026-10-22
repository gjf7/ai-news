import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../src/db/connection.ts";
import { createDb } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { articles, events, insights } from "../src/db/schema.ts";
import { refreshEventScores } from "../src/news/scoring.ts";

let dir: string;
let handle: DbHandle;
const now = new Date("2026-10-22T12:00:00Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-news-tags-"));
  handle = createDb(join(dir, "app.db"));
  migrate(handle.sqlite);
  handle.db
    .insert(events)
    .values({
      id: "e1",
      title: "Nvidia unveils a new AI chip",
      topics: [],
      kind: "news",
      firstSeenAt: now,
      lastArticleAt: now,
      effectiveTime: now,
      hotScore: 0,
      notificationRevision: 0,
      notifiedRevision: 0,
      updatedAt: now,
    })
    .run();
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedArticle(overrides: Partial<typeof articles.$inferInsert> = {}) {
  handle.db
    .insert(articles)
    .values({
      id: "a1",
      canonicalUrl: "https://example.com/a1",
      publisher: "Example",
      title: "Nvidia unveils a new AI chip",
      titleNorm: "nvidia unveils a new ai chip",
      discoveredAt: now,
      scope: "headline",
      relevance: "relevant",
      topics: [],
      kind: "news",
      eventId: "e1",
      ...overrides,
    })
    .run();
}

function eventTopics(): string[] {
  return handle.db.select().from(events).where(eq(events.id, "e1")).get()!.topics;
}

test("event tags are the union of its articles' tags in registry order", () => {
  seedArticle({ id: "a1", topics: ["model", "ai"] });
  seedArticle({
    id: "a2",
    canonicalUrl: "https://example.com/a2",
    topics: ["policy"],
  });

  refreshEventScores(handle, ["e1"]);
  expect(eventTopics()).toEqual(["ai", "model", "policy"]);
});

test("an article without stored tags falls back to its title", () => {
  seedArticle({ title: "TSMC 2nm wafer capacity", topics: [] });

  refreshEventScores(handle, ["e1"]);
  expect(eventTopics()).toEqual(["semiconductor", "manufacturing"]);
});

test("the latest insight's tags refine the event", () => {
  seedArticle({ topics: ["ai"] });
  handle.db
    .insert(insights)
    .values({
      id: "i1",
      eventId: "e1",
      inputHash: "hash",
      model: "stub",
      promptVersion: "insight-v2",
      scope: "headline",
      output: { tags: ["ai", "capital"] },
      evidence: [],
      revision: 0,
      createdAt: now,
    })
    .run();
  handle.db.update(events).set({ latestInsightId: "i1" }).where(eq(events.id, "e1")).run();

  refreshEventScores(handle, ["e1"]);
  expect(eventTopics()).toEqual(["ai", "capital"]);
});

test("unknown tags are dropped instead of leaking into filters", () => {
  seedArticle({ topics: ["ai", "made-up"] });
  refreshEventScores(handle, ["e1"]);
  expect(eventTopics()).toEqual(["ai"]);
});
