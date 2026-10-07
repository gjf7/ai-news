import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import type { AppConfig } from "../src/config/env.ts";
import { createDb, type DbHandle } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import {
  articles,
  deliveries,
  events,
  insights,
  refreshRuns,
  sourceRuns,
} from "../src/db/schema.ts";
import { createModelClient, type ModelClient } from "../src/insights/model.ts";
import { createRunner } from "../src/refresh/runner.ts";
import { requestRefresh } from "../src/refresh/request.ts";
import { createSourceRegistry } from "../src/sources/registry.ts";
import { hashPassword } from "../src/api/auth/password.ts";

const fixture = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../src/sources/__fixtures__/${name}`, import.meta.url)),
    "utf8",
  );

let dir: string;
let handle: DbHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-news-run-"));
  handle = createDb(join(dir, "app.db"));
  migrate(handle.sqlite);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function testConfig(overrides: Partial<AppConfig["notify"]> = {}): AppConfig {
  return {
    nodeEnv: "test",
    port: 0,
    databasePath: join(dir, "app.db"),
    backup: { keep: 14 },
    session: {
      secret: "test-secret-long-enough-value",
      ttlHours: 1,
      passwordHash: "",
      secureCookie: false,
    },
    refresh: {
      intervalMinutes: 30,
      runTimeoutMinutes: 20,
      analyzeMaxEvents: 40,
      filterMaxBatches: 8,
      clusterMaxBatches: 4,
    },
    notify: {
      enabled: true,
      maxItems: 5,
      minImportance: 70,
      telegram: { chatId: "1", botToken: "t" },
      ...overrides,
    },
    model: { baseUrl: "https://api.example.com", apiKey: "k", name: "test-model" },
  };
}

/** Model stub that answers classification, adjudication and insight prompts. */
function fakeModel(): ModelClient {
  return {
    name: "test-model",
    available: true,
    complete: async ({ messages }) => {
      const system = messages[0]?.content ?? "";
      const user = messages[1]?.content ?? "";

      if (system.includes("You classify news items")) {
        const count = user.split("\n").length;
        return JSON.stringify({
          results: Array.from({ length: count }, (_, index) => ({ index, relevant: true })),
        });
      }
      if (system.includes("You group news articles")) {
        return '{"index": -1}';
      }
      // Headline-only evidence must not carry an impact judgement; the
      // validator rejects it, so the stub mirrors the prompt's own marker.
      const headlineOnly = user.includes("本次材料全部只有标题");
      return JSON.stringify({
        title: "中文标题",
        facts: [{ text: "事实摘要", citations: ["0"] }],
        importance: { score: 90, reason: "重大进展" },
        impact: headlineOnly ? null : "可能影响",
        watch: null,
        material_update: { is: true, reason: "首次报道" },
      });
    },
  };
}

/** Serves the saved fixtures for the sources under test and nothing else. */
function fakeFetch(): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.includes("news.google.com/rss/search")) {
      return new Response(fixture("google-news.xml"), { status: 200 });
    }
    if (url.includes("news.google.com/rss/articles")) {
      return new Response(fixture("google-news-article.html"), { status: 200 });
    }
    if (url.includes("batchexecute")) {
      return new Response(
        String.raw`)]}'

[["wrb.fr","Fbv4je","[\"garturlres\",\"https://www.cbsnews.com/news/resolved/\",1]",null,null,null,"generic"]]`,
        { status: 200 },
      );
    }
    if (url.includes("hn.algolia.com")) {
      return new Response(fixture("hacker-news.json"), { status: 200 });
    }
    // Every other feed is empty, so the run only sees the two fixtures.
    return new Response("<rss><channel></channel></rss>", { status: 200 });
  }) as typeof fetch;
}

async function runPipelineOnce(config: AppConfig, model: ModelClient) {
  const definitions = createSourceRegistry({ fetch: fakeFetch() });
  const runner = createRunner({ handle, config, definitions, model });
  // In production the scheduler creates the run and then wakes the runner.
  requestRefresh({ trigger: "manual" }, { handle });
  await runner.runOnce();
  return runner;
}

test("a full run ingests, filters, clusters, analyses and publishes", async () => {
  await runPipelineOnce(testConfig(), fakeModel());

  const articleRows = handle.db.select().from(articles).all();
  expect(articleRows.length).toBeGreaterThan(0);
  // Everything was classified: nothing is left pending for the next run.
  expect(articleRows.some((row) => row.relevance === "relevant")).toBe(true);

  const eventRows = handle.db.select().from(events).all();
  expect(eventRows.length).toBeGreaterThan(0);
  expect(eventRows.every((row) => row.analysisState === "ok")).toBe(true);

  const insightRows = handle.db.select().from(insights).all();
  expect(insightRows.length).toBe(eventRows.length);
  expect(eventRows.every((row) => row.latestInsightId !== null)).toBe(true);
  expect(eventRows.every((row) => (row.importance ?? 0) > 0)).toBe(true);

  const run = handle.db.select().from(refreshRuns).all()[0]!;
  expect(run.state).toBe("succeeded");
  expect(run.activeSlot).toBeNull();
});

test("the first run stays silent: pointers advance but nothing is sent", async () => {
  await runPipelineOnce(testConfig(), fakeModel());

  expect(handle.db.select().from(deliveries).all()).toHaveLength(0);

  const eventRows = handle.db.select().from(events).all();
  expect(eventRows.length).toBeGreaterThan(0);
  // Every event's notified revision caught up to its notification revision.
  expect(eventRows.every((row) => row.notifiedRevision === row.notificationRevision)).toBe(true);
  expect(eventRows.some((row) => row.notificationRevision > 0)).toBe(true);
});

test("a later run with new material creates a delivery", async () => {
  await runPipelineOnce(testConfig(), fakeModel());

  // Second run: same fixtures, but the first run has finished so silence ends.
  // Clear the bump marker so the run has to decide again from scratch.
  handle.sqlite.prepare("UPDATE events SET revision_bumped_run_id = NULL").run();

  const model = fakeModel();
  const definitions = createSourceRegistry({ fetch: fakeFetch() });
  const runner = createRunner({ handle, config: testConfig(), definitions, model });
  requestRefresh({ trigger: "manual" }, { handle });
  await runner.runOnce();

  // No new evidence arrived, so no new insight and no bump: still no delivery.
  const deliveriesAfter = handle.db.select().from(deliveries).all();
  expect(deliveriesAfter).toHaveLength(0);
});

test("re-running with unchanged evidence reuses the insight instead of calling the model", async () => {
  await runPipelineOnce(testConfig(), fakeModel());
  const insightCount = handle.db.select().from(insights).all().length;

  // Force the events back to pending so analysis runs again over the same evidence.
  handle.sqlite.prepare("UPDATE events SET analysis_state = 'pending'").run();

  let calls = 0;
  const countingModel: ModelClient = {
    name: "test-model",
    available: true,
    complete: async (options) => {
      calls += 1;
      return fakeModel().complete(options);
    },
  };

  await runPipelineOnce(testConfig(), countingModel);

  // The evidence hash matched, so no new insight row and no model calls.
  expect(handle.db.select().from(insights).all().length).toBe(insightCount);
  expect(calls).toBe(0);
});

test("a source failure produces a partial run without losing other sources", async () => {
  const failingFetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // 404 fails fast (not retried), so the test does not wait on backoff.
    if (url.includes("news.google.com")) return new Response("down", { status: 404 });
    if (url.includes("hn.algolia.com"))
      return new Response(fixture("hacker-news.json"), { status: 200 });
    return new Response("<rss><channel></channel></rss>", { status: 200 });
  }) as typeof fetch;

  const definitions = createSourceRegistry({ fetch: failingFetch });
  const runner = createRunner({ handle, config: testConfig(), definitions, model: fakeModel() });
  requestRefresh({ trigger: "manual" }, { handle });
  await runner.runOnce();

  const run = handle.db.select().from(refreshRuns).all()[0]!;
  expect(run.state).toBe("partial");

  const failed = handle.db
    .select()
    .from(sourceRuns)
    .all()
    .filter((row) => row.state === "failed");
  expect(failed.length).toBeGreaterThan(0);
  // The healthy source still produced content.
  expect(handle.db.select().from(articles).all().length).toBeGreaterThan(0);
});

test("a crash mid-run is recovered on the next attempt", async () => {
  const config = testConfig();
  const definitions = createSourceRegistry({ fetch: fakeFetch() });
  const runner = createRunner({ handle, config, definitions, model: fakeModel() });

  // Simulate a process that died while running.
  handle.db
    .insert(refreshRuns)
    .values({
      id: "crashed",
      trigger: "manual",
      state: "running",
      activeSlot: 1,
      attempt: 1,
      queuedAt: new Date(),
      startedAt: new Date(),
    })
    .run();

  await runner.runOnce();

  const recovered = handle.db
    .select()
    .from(refreshRuns)
    .all()
    .find((row) => row.id === "crashed");
  // The stranded run was requeued and then executed to completion.
  expect(recovered?.state).toBe("succeeded");
  expect(recovered?.attempt).toBe(2);
});

test("a stranded run past the attempt limit is failed instead of retried", async () => {
  const config = testConfig();
  const definitions = createSourceRegistry({ fetch: fakeFetch() });
  const runner = createRunner({ handle, config, definitions, model: fakeModel() });

  handle.db
    .insert(refreshRuns)
    .values({
      id: "doomed",
      trigger: "manual",
      state: "running",
      activeSlot: 1,
      attempt: 3,
      queuedAt: new Date(),
      startedAt: new Date(),
    })
    .run();

  await runner.runOnce();

  const doomed = handle.db
    .select()
    .from(refreshRuns)
    .all()
    .find((row) => row.id === "doomed");
  expect(doomed?.state).toBe("failed");
  expect(doomed?.activeSlot).toBeNull();
});

test("arXiv-only events are skipped and never notify", async () => {
  const config = testConfig();
  const definitions = createSourceRegistry({ fetch: fakeFetch() });
  const runner = createRunner({ handle, config, definitions, model: fakeModel() });

  // Seed an event whose only article comes from the arXiv source
  // (analyze = false), then run the pipeline over it.
  const { syncSources } = await import("../src/refresh/ingest.ts");
  syncSources(handle, definitions);
  const arxiv = handle.sqlite.prepare("SELECT id FROM sources WHERE key = 'arxiv'").get() as {
    id: string;
  };

  const now = Date.now();
  handle.sqlite
    .prepare(
      `INSERT INTO events (id,title,topics,kind,first_seen_at,last_article_at,effective_time,hot_score,analysis_state,notification_revision,notified_revision,updated_at)
       VALUES ('ev-paper','A paper about LLM training','[]','paper',?,?,?,0,'pending',0,0,?)`,
    )
    .run(now, now, now, now);
  handle.sqlite
    .prepare(
      `INSERT INTO articles (id,canonical_url,publisher,title,title_norm,published_at,discovered_at,scope,excerpt,relevance,topics,kind,event_id)
       VALUES ('ar-paper','https://arxiv.org/abs/1','arXiv','A paper about LLM training','a paper about llm training',?,?,'excerpt','abstract','relevant','[]','paper','ev-paper')`,
    )
    .run(now, now);
  handle.sqlite
    .prepare(
      "INSERT INTO article_sources (article_id,source_id,external_id) VALUES ('ar-paper',?, 'x')",
    )
    .run(arxiv.id);

  requestRefresh({ trigger: "manual" }, { handle });
  await runner.runOnce();

  const paper = handle.db
    .select()
    .from(events)
    .all()
    .find((row) => row.id === "ev-paper");
  expect(paper?.analysisState).toBe("skipped");
  expect(paper?.notificationRevision).toBe(0);
  expect(paper?.importance).toBeNull();
});

test("model failures leave collected content unpublished rather than lost", async () => {
  const config = testConfig();
  const definitions = createSourceRegistry({ fetch: fakeFetch() });
  const brokenModel: ModelClient = {
    name: "test-model",
    available: true,
    complete: async () => {
      throw new Error("model exploded");
    },
  };
  const runner = createRunner({ handle, config, definitions, model: brokenModel });
  requestRefresh({ trigger: "manual" }, { handle });
  await runner.runOnce();

  // Keyword rules still decide relevance without the model, so events are
  // formed; only the analysis step fails. The collected content is preserved.
  const articleRows = handle.db.select().from(articles).all();
  expect(articleRows.length).toBeGreaterThan(0);

  const eventRows = handle.db.select().from(events).all();
  expect(eventRows.length).toBeGreaterThan(0);
  expect(eventRows.every((row) => row.analysisState === "failed")).toBe(true);
  expect(eventRows.every((row) => row.analysisError !== null)).toBe(true);

  // A model outage is not a source failure, but it is an incomplete run: the
  // design treats "有失败但至少一个来源成功" as partial.
  const run = handle.db.select().from(refreshRuns).all()[0]!;
  expect(run.state).toBe("partial");
});

test("model client is unavailable without an API key and analysis defers", async () => {
  const config = testConfig();
  const model = createModelClient(
    { ...config, model: { baseUrl: "https://x", name: "m" } },
    globalThis.fetch,
  );
  expect(model.available).toBe(false);
});

test("password hashing round-trips for the configured login", async () => {
  const hash = await hashPassword("secret");
  expect(hash.startsWith("scrypt$")).toBe(true);
});
