import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { buildApp, type BuiltApp } from "../src/app.ts";
import { hashPassword } from "../src/api/auth/password.ts";
import type { AppConfig } from "../src/config/env.ts";
import { events } from "../src/db/schema.ts";

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
      digest: { enabled: false, hourUtc: 0, maxItems: 10, minImportance: 50 },
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

function seedEvent() {
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
    })
    .run();
}

test("every new endpoint requires authentication", async () => {
  for (const url of [
    "/api/events",
    "/api/status",
    "/api/refresh-runs",
    "/api/sources",
    "/api/deliveries",
    "/api/config",
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
