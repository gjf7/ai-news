import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { createDb, type DbHandle } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { articleSources, articles, events, sources } from "../src/db/schema.ts";
import { recentEventIds, refreshEventScores } from "../src/news/scoring.ts";

let dir: string;
let handle: DbHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-news-scoring-"));
  handle = createDb(join(dir, "app.db"));
  migrate(handle.sqlite);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedEvent(id: string, effectiveTime: Date): void {
  handle.db
    .insert(events)
    .values({
      id,
      title: `Event ${id}`,
      topics: [],
      kind: "news",
      firstSeenAt: effectiveTime,
      lastArticleAt: effectiveTime,
      effectiveTime,
      hotScore: 0,
      analysisState: "ok",
      notificationRevision: 0,
      notifiedRevision: 0,
      updatedAt: effectiveTime,
    })
    .run();
}

function seedDiscussedEvent(effectiveTime: Date): void {
  handle.db
    .insert(sources)
    .values({ id: "s-hn", key: "hacker-news", adapter: "hacker-news" })
    .run();
  seedEvent("discussed", effectiveTime);
  handle.db
    .insert(articles)
    .values({
      id: "a1",
      canonicalUrl: "https://example.com/discussed",
      publisher: "Example",
      title: "AI chip breakthrough",
      titleNorm: "ai chip breakthrough",
      publishedAt: effectiveTime,
      discoveredAt: effectiveTime,
      scope: "excerpt",
      relevance: "relevant",
      kind: "news",
      eventId: "discussed",
      communityScore: 300,
    })
    .run();
  handle.db.insert(articleSources).values({ articleId: "a1", sourceId: "s-hn" }).run();
}

function readHotScore(): number {
  return handle.db.select({ hotScore: events.hotScore }).from(events).get()!.hotScore;
}

test("the rescore window keeps recent events and drops old ones", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  seedEvent("recent", new Date(now.getTime() - 2 * 24 * 3_600_000));
  seedEvent("old", new Date(now.getTime() - 8 * 24 * 3_600_000));

  expect(recentEventIds(handle, now).sort()).toEqual(["recent"]);
});

test("an event's hot score decays when the recent window is rescored later", () => {
  const createdAt = new Date("2026-10-22T00:00:00Z");
  seedDiscussedEvent(createdAt);

  refreshEventScores(handle, ["discussed"], createdAt);
  const fresh = readHotScore();

  refreshEventScores(handle, ["discussed"], new Date(createdAt.getTime() + 12 * 3_600_000));
  const aged = readHotScore();

  expect(fresh).toBeGreaterThan(0);
  expect(aged).toBeLessThan(fresh);
});
