import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { createDb, type DbHandle } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { articleSources, articles, events, sources } from "../src/db/schema.ts";
import type { ModelClient } from "../src/insights/model.ts";
import { ANALYSIS_MAX_ATTEMPTS, runAnalysis } from "../src/refresh/analyze.ts";

/**
 * The retry policy is a cost control: before it existed, an event whose
 * evidence reliably broke the model was re-billed on every refresh, forever.
 */

let dir: string;
let handle: DbHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-news-retry-"));
  handle = createDb(join(dir, "app.db"));
  migrate(handle.sqlite);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

/** An event with one analyzable article, so it is never skipped as arXiv-only. */
function seedEvent(id = "e1"): void {
  const now = new Date();
  // A source row is required: an event whose articles have no source is
  // treated as "no source wants insights" and skipped, not failed.
  handle.db
    .insert(sources)
    .values({
      id: "s1",
      key: "example",
      adapter: "rss",
      analyze: true,
      createdAt: now,
    })
    .run();
  handle.db
    .insert(events)
    .values({
      id,
      title: "Nvidia ships a new GPU",
      firstSeenAt: now,
      lastArticleAt: now,
      effectiveTime: now,
      hotScore: 100,
      analysisState: "pending",
      updatedAt: now,
    })
    .run();
  handle.db
    .insert(articles)
    .values({
      id: `${id}-a1`,
      canonicalUrl: `https://example.com/${id}`,
      publisher: "Example",
      title: "Nvidia ships a new GPU",
      titleNorm: "nvidia ships a new gpu",
      discoveredAt: now,
      scope: "excerpt",
      excerpt: "The chip is aimed at inference.",
      relevance: "relevant",
      eventId: id,
    })
    .run();
  handle.db
    .insert(articleSources)
    .values({ articleId: `${id}-a1`, sourceId: "s1" })
    .run();
}

/** Always returns an empty completion, which analysis treats as a failure. */
function failingModel(calls: { count: number }): ModelClient {
  return {
    name: "test-model",
    available: true,
    complete: async () => {
      calls.count += 1;
      return "";
    },
  };
}

async function analyze(model: ModelClient, now: Date) {
  return runAnalysis({
    handle,
    model,
    runId: "run",
    signal: AbortSignal.timeout(5_000),
    now,
  });
}

test("a failing event is not retried before its backoff elapses", async () => {
  seedEvent();
  const calls = { count: 0 };
  const start = new Date("2026-10-20T00:00:00Z");

  await analyze(failingModel(calls), start);
  expect(calls.count).toBe(1);

  // Ten minutes later: still inside the 1h backoff, so no second call.
  await analyze(failingModel(calls), new Date(start.getTime() + 10 * 60_000));
  expect(calls.count).toBe(1);

  // Past the backoff it is retried exactly once.
  await analyze(failingModel(calls), new Date(start.getTime() + 61 * 60_000));
  expect(calls.count).toBe(2);
});

test("retries stop after the attempt cap instead of billing forever", async () => {
  seedEvent();
  const calls = { count: 0 };
  let now = new Date("2026-10-20T00:00:00Z");

  // Walk well past every backoff window; the cap, not the clock, must stop it.
  for (let round = 0; round < 20; round += 1) {
    await analyze(failingModel(calls), now);
    now = new Date(now.getTime() + 24 * 3_600_000);
  }

  expect(calls.count).toBe(ANALYSIS_MAX_ATTEMPTS);
  const event = handle.db.select().from(events).where(eq(events.id, "e1")).get();
  expect(event?.analysisState).toBe("failed");
});

test("a new article resets the retry budget", async () => {
  seedEvent();
  const calls = { count: 0 };
  let now = new Date("2026-10-20T00:00:00Z");

  for (let round = 0; round < 20; round += 1) {
    await analyze(failingModel(calls), now);
    now = new Date(now.getTime() + 24 * 3_600_000);
  }
  expect(calls.count).toBe(ANALYSIS_MAX_ATTEMPTS);

  // Clustering resets the counter when a fresh article joins the event; the
  // failure may have been about the old evidence, so one more try is fair.
  handle.db
    .update(events)
    .set({ analysisState: "pending", analysisAttempts: 0, analysisNextAttemptAt: null })
    .where(eq(events.id, "e1"))
    .run();

  await analyze(failingModel(calls), now);
  expect(calls.count).toBe(ANALYSIS_MAX_ATTEMPTS + 1);
});
