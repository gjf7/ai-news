import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { buildApp, type BuiltApp } from "../src/app.ts";
import { hashPassword } from "../src/api/auth/password.ts";
import type { AppConfig } from "../src/config/env.ts";
import { events, insights } from "../src/db/schema.ts";

let dir: string;
let built: BuiltApp;
let cookie: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ai-news-api2-"));
  const config: AppConfig = {
    nodeEnv: "test",
    port: 0,
    databasePath: join(dir, "app.db"),
    backup: { keep: 14 },
    retention: { days: 0 },
    session: {
      secret: "test-secret-long-enough",
      ttlHours: 1,
      passwordHash: await hashPassword("s3cret"),
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
      enabled: false,
      maxItems: 5,
      minImportance: 70,
      coalesceMinutes: 0,
      urgentImportance: 100,
      digest: { enabled: false, hourUtc: 0, maxItems: 10, minImportance: 50 },
      alert: { enabled: false, afterFailedRuns: 3 },
      telegram: {},
    },
    model: { baseUrl: "https://api.example.com", name: "deepseek-chat" },
  };
  built = await buildApp({ config, startBackground: false });
  const login = await built.app.inject({
    method: "POST",
    url: "/api/session",
    payload: { password: "s3cret" },
  });
  cookie = login.cookies[0]!.value;
});

afterEach(async () => {
  await built.close();
  rmSync(dir, { recursive: true, force: true });
});

const auth = () => ({ cookies: { ai_news_session: cookie } });

function seedEvent(overrides: Partial<typeof events.$inferInsert> = {}) {
  const now = new Date();
  built.handle.db
    .insert(events)
    .values({
      id: "ev1",
      title: "Nvidia unveils a new AI chip",
      topics: ["ai", "semiconductor"],
      kind: "news",
      firstSeenAt: now,
      lastArticleAt: now,
      effectiveTime: now,
      hotScore: 800,
      analysisState: "pending",
      notificationRevision: 0,
      notifiedRevision: 0,
      updatedAt: now,
      ...overrides,
    })
    .run();
}

test("every new endpoint requires authentication", async () => {
  for (const url of [
    "/api/events",
    "/api/events/focus",
    "/api/status",
    "/api/refresh-runs",
    "/api/sources",
    "/api/deliveries",
    "/api/config",
    "/api/blogs",
    "/api/blog-posts",
  ]) {
    const response = await built.app.inject({ method: "GET", url });
    expect(response.statusCode, url).toBe(401);
  }
});

test("GET /events returns an empty page before any content exists", async () => {
  const response = await built.app.inject({ method: "GET", url: "/api/events", ...auth() });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ items: [], page: 1, hasMore: false });
});

test("GET /events validates the query and rejects a bad page", async () => {
  const response = await built.app.inject({
    method: "GET",
    url: "/api/events?page=0",
    ...auth(),
  });
  expect(response.statusCode).toBe(400);
});

test("GET /events lists seeded events with their topics", async () => {
  seedEvent();
  const response = await built.app.inject({ method: "GET", url: "/api/events", ...auth() });
  const body = response.json();
  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({ id: "ev1", topics: ["ai", "semiconductor"] });
});

test("sort=importance orders by model importance with unscored events last", async () => {
  const now = new Date();
  const seed = (id: string, importance: number | null) =>
    built.handle.db
      .insert(events)
      .values({
        id,
        title: `Event ${id}`,
        topics: [],
        kind: "news",
        firstSeenAt: now,
        lastArticleAt: now,
        effectiveTime: now,
        hotScore: 0,
        analysisState: "ok",
        importance,
        notificationRevision: 0,
        notifiedRevision: 0,
        updatedAt: now,
      })
      .run();
  seed("low", 10);
  seed("high", 90);
  seed("unscored", null);

  const response = await built.app.inject({
    method: "GET",
    url: "/api/events?sort=importance",
    ...auth(),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().items.map((event: { id: string }) => event.id)).toEqual([
    "high",
    "low",
    "unscored",
  ]);
});

test("GET /events rejects an unknown sort", async () => {
  const response = await built.app.inject({
    method: "GET",
    url: "/api/events?sort=trending",
    ...auth(),
  });
  expect(response.statusCode).toBe(400);
});

test("range=24h drops older events before sorting, so importance stays recent", async () => {
  const now = Date.now();
  seedEvent({ id: "recent", effectiveTime: new Date(now), importance: 40, analysisState: "ok" });
  seedEvent({
    id: "old-but-important",
    effectiveTime: new Date(now - 2 * 24 * 3_600_000),
    importance: 95,
    analysisState: "ok",
  });

  const day = await built.app.inject({
    method: "GET",
    url: "/api/events?sort=importance&range=24h",
    ...auth(),
  });
  expect(day.json().items.map((event: { id: string }) => event.id)).toEqual(["recent"]);

  const week = await built.app.inject({
    method: "GET",
    url: "/api/events?sort=importance&range=7d",
    ...auth(),
  });
  expect(week.json().items.map((event: { id: string }) => event.id)).toEqual([
    "old-but-important",
    "recent",
  ]);

  const all = await built.app.inject({
    method: "GET",
    url: "/api/events?sort=importance&range=all",
    ...auth(),
  });
  expect(all.json().items.map((event: { id: string }) => event.id)).toEqual([
    "old-but-important",
    "recent",
  ]);
});

test("range=today starts at Shanghai midnight", async () => {
  const now = Date.now();
  seedEvent({ id: "today", effectiveTime: new Date(now) });
  seedEvent({ id: "before-today", effectiveTime: new Date(now - 26 * 3_600_000) });

  const response = await built.app.inject({
    method: "GET",
    url: "/api/events?range=today",
    ...auth(),
  });
  expect(response.json().items.map((event: { id: string }) => event.id)).toEqual(["today"]);
});

test("focus lists only recent, analyzed, above-threshold events, most important first", async () => {
  const now = Date.now();
  const hour = 3_600_000;
  seedEvent({
    id: "important",
    effectiveTime: new Date(now - hour),
    importance: 90,
    analysisState: "ok",
  });
  seedEvent({
    id: "second",
    effectiveTime: new Date(now - 2 * hour),
    importance: 70,
    analysisState: "ok",
  });
  seedEvent({
    id: "below",
    effectiveTime: new Date(now - hour),
    importance: 40,
    analysisState: "ok",
  });
  seedEvent({
    id: "stale",
    effectiveTime: new Date(now - 30 * hour),
    importance: 95,
    analysisState: "ok",
  });
  seedEvent({
    id: "failed",
    effectiveTime: new Date(now - hour),
    importance: 99,
    analysisState: "failed",
  });

  const response = await built.app.inject({ method: "GET", url: "/api/events/focus", ...auth() });
  expect(response.statusCode).toBe(200);
  expect(response.json().items.map((event: { id: string }) => event.id)).toEqual([
    "important",
    "second",
  ]);
});

test("focus caps at three and carries the insight's importance reason", async () => {
  const now = Date.now();
  const hour = 3_600_000;
  for (const [id, importance] of [
    ["e1", 90],
    ["e2", 80],
    ["e3", 70],
    ["e4", 65],
  ] as const) {
    seedEvent({
      id,
      effectiveTime: new Date(now - hour),
      importance,
      analysisState: "ok",
    });
  }

  // The event points at its insight through a composite foreign key, so the
  // insight has to exist before the pointer is set.
  built.handle.db
    .insert(insights)
    .values({
      id: "ins1",
      eventId: "e1",
      inputHash: "hash1",
      model: "stub",
      promptVersion: "insight-v1",
      scope: "excerpt",
      output: {
        title: "重点标题",
        facts: [{ text: "事实", citations: ["0"] }],
        importance: { score: 90, reason: "出口管制升级" },
      },
      evidence: [],
      revision: 1,
      createdAt: new Date(now - hour),
    })
    .run();
  built.handle.db.update(events).set({ latestInsightId: "ins1" }).where(eq(events.id, "e1")).run();

  const response = await built.app.inject({ method: "GET", url: "/api/events/focus", ...auth() });
  const { items } = response.json();
  expect(items.map((event: { id: string }) => event.id)).toEqual(["e1", "e2", "e3"]);
  expect(items[0].importanceReason).toBe("出口管制升级");
});

test("GET /events/:id returns detail and 404s for an unknown id", async () => {
  seedEvent();
  const found = await built.app.inject({ method: "GET", url: "/api/events/ev1", ...auth() });
  expect(found.statusCode).toBe(200);
  expect(found.json()).toMatchObject({ id: "ev1", articles: [], insight: null });

  const missing = await built.app.inject({ method: "GET", url: "/api/events/nope", ...auth() });
  expect(missing.statusCode).toBe(404);
});

test("POST /refresh-runs creates a run and reports 202", async () => {
  const response = await built.app.inject({ method: "POST", url: "/api/refresh-runs", ...auth() });
  expect(response.statusCode).toBe(202);
  expect(response.json()).toMatchObject({ disposition: "created", state: "queued" });
});

test("POST /refresh-runs reuses the active run and reports 200", async () => {
  await built.app.inject({ method: "POST", url: "/api/refresh-runs", ...auth() });
  const second = await built.app.inject({ method: "POST", url: "/api/refresh-runs", ...auth() });
  expect(second.statusCode).toBe(200);
  expect(second.json()).toMatchObject({ disposition: "reused" });
});

test("a JSON content-type with an empty body is a 400, not a 500", async () => {
  // The browser sends this shape for bodyless writes (manual refresh, logout);
  // Fastify raises FST_ERR_CTP_EMPTY_JSON_BODY for it.
  const response = await built.app.inject({
    method: "POST",
    url: "/api/refresh-runs",
    headers: { "content-type": "application/json" },
    ...auth(),
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error.code).toBe("invalid_request");
});

test("GET /refresh-runs/:id returns per-source results", async () => {
  const created = await built.app.inject({ method: "POST", url: "/api/refresh-runs", ...auth() });
  const { runId } = created.json();

  const detail = await built.app.inject({
    method: "GET",
    url: `/api/refresh-runs/${runId}`,
    ...auth(),
  });
  expect(detail.statusCode).toBe(200);
  expect(detail.json()).toMatchObject({ id: runId, sources: [] });
});

test("GET /sources is empty until a run syncs the registry", async () => {
  const response = await built.app.inject({ method: "GET", url: "/api/sources", ...auth() });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual([]);
});

test("GET /status exposes the schedule and no active run", async () => {
  const response = await built.app.inject({ method: "GET", url: "/api/status", ...auth() });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.activeRun).toBeNull();
  expect(typeof body.nextScheduledAt).toBe("string");
});

test("GET /status reports an active run after a refresh request", async () => {
  await built.app.inject({ method: "POST", url: "/api/refresh-runs", ...auth() });
  const response = await built.app.inject({ method: "GET", url: "/api/status", ...auth() });
  expect(response.json().activeRun).toMatchObject({ state: "queued" });
});

test("GET /config never returns secrets", async () => {
  const response = await built.app.inject({ method: "GET", url: "/api/config", ...auth() });
  const body = response.json();
  expect(body).toMatchObject({ refreshIntervalMinutes: 30 });
  expect(body.configured).toEqual({ modelApiKey: false, telegram: false });
  expect(JSON.stringify(body)).not.toContain("test-secret-long-enough");
});

test("PATCH /sources/:id toggles a source and validates the body", async () => {
  // Sources appear once a run syncs the registry.
  await built.app.inject({ method: "POST", url: "/api/refresh-runs", ...auth() });
  const { runIngest } = await import("../src/refresh/ingest.ts");
  const { createSourceRegistry } = await import("../src/sources/registry.ts");
  const { syncSources } = await import("../src/refresh/ingest.ts");
  syncSources(built.handle, createSourceRegistry({ fetch: globalThis.fetch }));
  void runIngest;

  const source = built.handle.sqlite.prepare("SELECT id FROM sources LIMIT 1").get() as {
    id: string;
  };
  const bad = await built.app.inject({
    method: "PATCH",
    url: `/api/sources/${source.id}`,
    payload: { enabled: "yes" },
    ...auth(),
  });
  expect(bad.statusCode).toBe(400);

  const ok = await built.app.inject({
    method: "PATCH",
    url: `/api/sources/${source.id}`,
    payload: { enabled: false },
    ...auth(),
  });
  expect(ok.statusCode).toBe(204);
});

test("a cross-origin write is rejected", async () => {
  const response = await built.app.inject({
    method: "POST",
    url: "/api/refresh-runs",
    headers: { origin: "https://evil.example" },
    ...auth(),
  });
  expect(response.statusCode).toBe(403);
});

test("POST /deliveries/:id/retry only accepts failed deliveries", async () => {
  const response = await built.app.inject({
    method: "POST",
    url: "/api/deliveries/missing/retry",
    ...auth(),
  });
  expect(response.statusCode).toBe(409);
});

test("GET /blogs lists configured blogs with their post counts", async () => {
  const now = new Date();
  built.handle.sqlite
    .prepare(
      `INSERT INTO blog_posts (id,blog_key,title,url,published_at,discovered_at)
       VALUES ('bp1','julia-evans','Hi','https://jvns.ca/1',?,?)`,
    )
    .run(now.getTime(), now.getTime());

  const response = await built.app.inject({ method: "GET", url: "/api/blogs", ...auth() });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  const jvns = body.find((blog: { key: string }) => blog.key === "julia-evans");
  expect(jvns).toMatchObject({ name: "Julia Evans", postCount: 1 });
});

test("GET /blog-posts filters by blog and paginates", async () => {
  const now = Date.now();
  const insert = built.handle.sqlite.prepare(
    `INSERT INTO blog_posts (id,blog_key,title,url,published_at,discovered_at) VALUES (?,?,?,?,?,?)`,
  );
  insert.run("b1", "julia-evans", "One", "https://jvns.ca/1", now - 1000, now);
  insert.run("b2", "julia-evans", "Two", "https://jvns.ca/2", now, now);
  insert.run("b3", "lethain", "Three", "https://lethain.com/1", now, now);

  const filtered = await built.app.inject({
    method: "GET",
    url: "/api/blog-posts?blog=julia-evans",
    ...auth(),
  });
  expect(filtered.statusCode).toBe(200);
  const body = filtered.json();
  expect(body.total).toBe(2);
  expect(body.items.map((item: { title: string }) => item.title)).toEqual(["Two", "One"]);
  expect(body.items[0].blogName).toBe("Julia Evans");

  const all = await built.app.inject({ method: "GET", url: "/api/blog-posts", ...auth() });
  expect(all.json().total).toBe(3);
});
