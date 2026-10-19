import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { createDb, type DbHandle } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { deliveries, refreshRuns, sourceRuns, sources } from "../src/db/schema.ts";
import { detectOutage, renderOutageAlert, runAlertIfNeeded } from "../src/notifications/alerts.ts";

let dir: string;
let handle: DbHandle;

const config = { enabled: true, afterFailedRuns: 3 };
const creds = { chatId: "1", botToken: "t" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-news-alerts-"));
  handle = createDb(join(dir, "app.db"));
  migrate(handle.sqlite);
  clock = Date.parse("2026-10-19T00:00:00Z");
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

let clock = Date.parse("2026-10-19T00:00:00Z");

/** A finished run with one source that fetched `fetched` articles. */
function seedRun({
  id,
  fetched,
  sourceState = fetched > 0 ? "done" : "failed",
  error = fetched > 0 ? null : "TypeError: fetch failed",
  finishedAt = new Date((clock += 30 * 60_000)),
}: {
  id: string;
  fetched: number;
  sourceState?: "done" | "failed";
  error?: string | null;
  finishedAt?: Date;
}) {
  handle.db
    .insert(refreshRuns)
    .values({
      id,
      trigger: "schedule",
      state: fetched > 0 ? "succeeded" : "partial",
      activeSlot: null,
      attempt: 1,
      queuedAt: finishedAt,
      startedAt: finishedAt,
      finishedAt,
    })
    .run();

  const sourceId = `src-${id}`;
  handle.db
    .insert(sources)
    .values({
      id: sourceId,
      key: `feed-${id}`,
      adapter: `feed-${id}`,
      config: {},
      enabled: true,
      defaultTopics: [],
      analyze: true,
    })
    .run();
  handle.db
    .insert(sourceRuns)
    .values({
      runId: id,
      sourceId,
      state: sourceState,
      fetched,
      newArticles: fetched,
      error,
      finishedAt,
    })
    .run();
}

test("a healthy streak produces no outage", () => {
  seedRun({ id: "r1", fetched: 20 });
  seedRun({ id: "r2", fetched: 5 });

  const outage = detectOutage(handle);
  expect(outage.runs).toEqual([]);
  expect(outage.lastCollectedAt).not.toBeNull();
  expect(runAlertIfNeeded(handle, { config, ...creds }).created).toBe(false);
});

test("a single empty run does not alert before the threshold", () => {
  seedRun({ id: "r1", fetched: 20 });
  seedRun({ id: "r2", fetched: 0 });
  seedRun({ id: "r3", fetched: 0 });

  expect(detectOutage(handle).runs).toHaveLength(2);
  expect(runAlertIfNeeded(handle, { config, ...creds }).created).toBe(false);
  expect(handle.db.select().from(deliveries).all()).toHaveLength(0);
});

test("an outage past the threshold creates one pending alert", () => {
  seedRun({ id: "r1", fetched: 20 });
  seedRun({ id: "r2", fetched: 0 });
  seedRun({ id: "r3", fetched: 0 });
  seedRun({ id: "r4", fetched: 0 });

  const result = runAlertIfNeeded(handle, { config, ...creds });
  expect(result.created).toBe(true);

  const rows = handle.db.select().from(deliveries).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.kind).toBe("alert");
  expect(rows[0]!.state).toBe("pending");
  expect(rows[0]!.chatId).toBe("1");
  expect(rows[0]!.text).toContain("连续 3 轮");
  expect(rows[0]!.text).toContain("fetch failed");
});

test("one alert per outage, not one per check", () => {
  for (const id of ["r1", "r2", "r3", "r4"]) seedRun({ id, fetched: 0 });

  expect(runAlertIfNeeded(handle, { config, ...creds }).created).toBe(true);
  expect(runAlertIfNeeded(handle, { config, ...creds }).created).toBe(false);
  expect(runAlertIfNeeded(handle, { config, ...creds }).created).toBe(false);
  expect(handle.db.select().from(deliveries).all()).toHaveLength(1);
});

test("a new outage after recovery alerts again", () => {
  seedRun({ id: "r1", fetched: 0 });
  seedRun({ id: "r2", fetched: 0 });
  seedRun({ id: "r3", fetched: 0 });
  expect(runAlertIfNeeded(handle, { config, ...creds }).created).toBe(true);

  // Collection recovers, then breaks again.
  seedRun({ id: "r4", fetched: 12 });
  seedRun({ id: "r5", fetched: 0 });
  seedRun({ id: "r6", fetched: 0 });
  seedRun({ id: "r7", fetched: 0 });

  expect(runAlertIfNeeded(handle, { config, ...creds }).created).toBe(true);
  expect(handle.db.select().from(deliveries).all()).toHaveLength(2);
});

test("alerts need credentials and can be switched off", () => {
  for (const id of ["r1", "r2", "r3"]) seedRun({ id, fetched: 0 });

  expect(runAlertIfNeeded(handle, { config, chatId: undefined, botToken: "t" }).created).toBe(
    false,
  );
  expect(runAlertIfNeeded(handle, { config, chatId: "1", botToken: undefined }).created).toBe(
    false,
  );
  expect(
    runAlertIfNeeded(handle, { config: { ...config, enabled: false }, ...creds }).created,
  ).toBe(false);
  expect(handle.db.select().from(deliveries).all()).toHaveLength(0);
});

test("a run that collected nothing but is called partial still counts", () => {
  // The incident this alert exists for: every source fails except the one
  // without a network dependency, so the run is "partial" yet collected nothing.
  for (const id of ["r1", "r2", "r3"]) seedRun({ id, fetched: 0 });

  const runs = handle.db.select().from(refreshRuns).all();
  expect(runs.every((run) => run.state === "partial")).toBe(true);
  expect(runAlertIfNeeded(handle, { config, ...creds }).created).toBe(true);
});

test("the alert names the most recent successful collection", () => {
  const lastGood = new Date("2026-10-16T14:30:00Z");
  seedRun({ id: "good", fetched: 605, finishedAt: lastGood });
  seedRun({ id: "r1", fetched: 0, finishedAt: new Date("2026-10-16T15:00:00Z") });
  seedRun({ id: "r2", fetched: 0, finishedAt: new Date("2026-10-16T15:30:00Z") });
  seedRun({ id: "r3", fetched: 0, finishedAt: new Date("2026-10-16T16:00:00Z") });

  const outage = detectOutage(handle);
  expect(outage.runs).toHaveLength(3);
  expect(outage.lastCollectedAt?.toISOString()).toBe(lastGood.toISOString());

  const text = renderOutageAlert(handle, outage);
  expect(text).toContain("2026-10-16 14:30 UTC");
  expect(text).toContain("2026-10-16 16:00 UTC");
});

test("runs still in flight are ignored", () => {
  seedRun({ id: "r1", fetched: 0 });
  handle.db
    .insert(refreshRuns)
    .values({
      id: "active",
      trigger: "schedule",
      state: "running",
      activeSlot: 1,
      attempt: 1,
      queuedAt: new Date(),
      startedAt: new Date(),
    })
    .run();

  // Only the finished run is counted, so the streak is 1 and no alert fires.
  expect(detectOutage(handle).runs.map((run) => run.id)).toEqual(["r1"]);
  expect(runAlertIfNeeded(handle, { config, ...creds }).created).toBe(false);
});
