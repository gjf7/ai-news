import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { createDb, type DbHandle } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { deliveries, events, refreshRuns } from "../src/db/schema.ts";
import {
  digestBoundary,
  isDigestDue,
  nextDigestAt,
  runDigestIfDue,
  type DigestConfig,
} from "../src/notifications/digest.ts";

let dir: string;
let handle: DbHandle;
const HOUR = 60 * 60 * 1000;

const config: DigestConfig = { enabled: true, hourUtc: 0, maxItems: 10, minImportance: 50 };
const creds = { chatId: "1", botToken: "t" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-news-digest-"));
  handle = createDb(join(dir, "app.db"));
  migrate(handle.sqlite);
  // A digest delivery is tied to the newest finished run.
  handle.db
    .insert(refreshRuns)
    .values({
      id: "run1",
      trigger: "manual",
      state: "succeeded",
      activeSlot: null,
      attempt: 1,
      queuedAt: new Date(),
      finishedAt: new Date(),
    })
    .run();
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedEvent(id: string, importance: number, effectiveTime: Date) {
  const now = new Date();
  handle.db
    .insert(events)
    .values({
      id,
      title: `Event ${id}`,
      topics: [],
      kind: "news",
      firstSeenAt: now,
      lastArticleAt: now,
      effectiveTime,
      hotScore: 0,
      analysisState: "ok",
      importance,
      notificationRevision: 0,
      notifiedRevision: 0,
      updatedAt: now,
    })
    .run();
}

test("digestBoundary is the most recent past hour mark", () => {
  const after = new Date("2026-10-10T05:00:00Z");
  expect(digestBoundary(after, 0).toISOString()).toBe("2026-10-10T00:00:00.000Z");
  // 08:00 UTC has not happened yet at 05:00, so the boundary is yesterday's.
  expect(digestBoundary(after, 8).toISOString()).toBe("2026-10-09T08:00:00.000Z");
  expect(digestBoundary(new Date("2026-10-10T09:00:00Z"), 8).toISOString()).toBe(
    "2026-10-10T08:00:00.000Z",
  );

  const before = new Date("2026-10-09T23:00:00Z");
  expect(digestBoundary(before, 0).toISOString()).toBe("2026-10-09T00:00:00.000Z");
});

test("nextDigestAt is the following day's hour mark", () => {
  const now = new Date("2026-10-10T05:00:00Z");
  expect(nextDigestAt(now, 0).toISOString()).toBe("2026-10-11T00:00:00.000Z");
});

test("a digest is not due without credentials or when disabled", () => {
  const now = new Date("2026-10-10T05:00:00Z");
  expect(isDigestDue(handle, { config, chatId: undefined, botToken: "t", now })).toBe(false);
  expect(isDigestDue(handle, { config, chatId: "1", botToken: undefined, now })).toBe(false);
  expect(isDigestDue(handle, { config: { ...config, enabled: false }, ...creds, now })).toBe(false);
  expect(isDigestDue(handle, { config, ...creds, now })).toBe(true);
});

test("a due digest summarizes the last 24h above the threshold", () => {
  const now = new Date("2026-10-10T05:00:00Z");
  seedEvent("recent-high", 80, new Date(now.getTime() - 2 * HOUR));
  seedEvent("recent-low", 40, new Date(now.getTime() - 3 * HOUR));
  seedEvent("stale", 90, new Date(now.getTime() - 30 * HOUR));

  const result = runDigestIfDue(handle, { config, ...creds, now });
  expect(result.created).toBe(true);

  const rows = handle.db.select().from(deliveries).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.kind).toBe("digest");
  expect(rows[0]!.state).toBe("pending");
  expect(rows[0]!.text).toContain("每日摘要");
  expect(rows[0]!.text).toContain("Event recent-high");
  expect(rows[0]!.text).not.toContain("Event recent-low");
  expect(rows[0]!.text).not.toContain("Event stale");
});

test("a digest does not touch the push revisions", () => {
  const now = new Date("2026-10-10T05:00:00Z");
  seedEvent("e", 80, new Date(now.getTime() - HOUR));
  runDigestIfDue(handle, { config, ...creds, now });

  const row = handle.db.select().from(events).all()[0]!;
  expect(row.notifiedRevision).toBe(0);
  expect(row.notificationRevision).toBe(0);
});

test("at most one digest per window, across repeated checks", () => {
  const now = new Date("2026-10-10T05:00:00Z");
  seedEvent("e", 80, new Date(now.getTime() - HOUR));

  expect(runDigestIfDue(handle, { config, ...creds, now }).created).toBe(true);
  expect(isDigestDue(handle, { config, ...creds, now })).toBe(false);
  expect(runDigestIfDue(handle, { config, ...creds, now }).created).toBe(false);
  expect(handle.db.select().from(deliveries).all()).toHaveLength(1);
});

test("the next day's window produces a fresh digest", () => {
  const day1 = new Date("2026-10-10T05:00:00Z");
  seedEvent("e", 80, new Date(day1.getTime() - HOUR));
  expect(runDigestIfDue(handle, { config, ...creds, now: day1 }).created).toBe(true);

  // A day later the boundary has advanced past the first delivery.
  const day2 = new Date(day1.getTime() + 24 * HOUR);
  seedEvent("e2", 75, new Date(day2.getTime() - HOUR));
  expect(isDigestDue(handle, { config, ...creds, now: day2 })).toBe(true);
  expect(runDigestIfDue(handle, { config, ...creds, now: day2 }).created).toBe(true);
  expect(handle.db.select().from(deliveries).all()).toHaveLength(2);
});

test("a window with no qualifying events sends nothing and stays due", () => {
  const now = new Date("2026-10-10T05:00:00Z");
  const result = runDigestIfDue(handle, { config, ...creds, now });
  expect(result).toEqual({ created: false, reason: "no candidates" });
  expect(handle.db.select().from(deliveries).all()).toHaveLength(0);
  // Still due: a late-developing story in the same window can still be summarized.
  expect(isDigestDue(handle, { config, ...creds, now })).toBe(true);
});

test("maxItems caps how many events the digest lists", () => {
  const now = new Date("2026-10-10T05:00:00Z");
  for (const [id, importance] of [
    ["a", 90],
    ["b", 80],
    ["c", 70],
  ] as const) {
    seedEvent(id, importance, new Date(now.getTime() - HOUR));
  }

  const result = runDigestIfDue(handle, { config: { ...config, maxItems: 2 }, ...creds, now });
  expect(result).toMatchObject({ created: true, count: 2 });
});
