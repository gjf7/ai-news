import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { createDb, type DbHandle } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { deliveries, events, refreshRuns } from "../src/db/schema.ts";
import {
  flushNotificationQueue,
  lastPushAt,
  runNotificationFreeze,
  unnotifiedCandidates,
  type NotifyConfig,
} from "../src/notifications/telegram.ts";

/**
 * Coalescing is the answer to "too many messages": a 30-minute refresh used to
 * produce one push per run, so a day arrived as 17-21 single-item messages.
 * The window batches them into a few multi-item ones without dropping any.
 */

let dir: string;
let handle: DbHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-news-coalesce-"));
  handle = createDb(join(dir, "app.db"));
  migrate(handle.sqlite);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

const config: NotifyConfig = {
  enabled: true,
  maxItems: 10,
  minImportance: 70,
  coalesceMinutes: 120,
  urgentImportance: 88,
  chatId: "chat-1",
  botToken: "token",
};

function startRun(id: string) {
  handle.db
    .insert(refreshRuns)
    .values({
      id,
      trigger: "schedule",
      state: "succeeded",
      activeSlot: null,
      attempt: 1,
      queuedAt: new Date(),
      finishedAt: new Date(),
    })
    .onConflictDoNothing()
    .run();
}

function seedEvent({
  id,
  runId,
  importance = 75,
  revision = 1,
  notified = 0,
}: {
  id: string;
  runId: string;
  importance?: number;
  revision?: number;
  notified?: number;
}): void {
  const now = new Date();
  handle.db
    .insert(events)
    .values({
      id,
      title: `Event ${id}`,
      firstSeenAt: now,
      lastArticleAt: now,
      effectiveTime: now,
      hotScore: importance * 10,
      analysisState: "ok",
      importance,
      notificationRevision: revision,
      revisionBumpedRunId: runId,
      notifiedRevision: notified,
      updatedAt: now,
    })
    .run();
}

function sentMessages() {
  return handle.db.select().from(deliveries).all();
}

test("the first push of the day goes out immediately", () => {
  startRun("run-1");
  seedEvent({ id: "e1", runId: "run-1" });

  const result = runNotificationFreeze({
    handle,
    runId: "run-1",
    config,
    firstRun: false,
    now: new Date("2026-10-20T10:00:00Z"),
  });

  expect(result.created).toBe(1);
  expect(sentMessages()).toHaveLength(1);
});

test("a second run inside the window is held, not dropped", () => {
  startRun("run-1");
  startRun("run-2");
  seedEvent({ id: "e1", runId: "run-1" });

  const first = new Date("2026-10-20T10:00:00Z");
  runNotificationFreeze({ handle, runId: "run-1", config, firstRun: false, now: first });

  seedEvent({ id: "e2", runId: "run-2", importance: 80 });
  const second = new Date(first.getTime() + 30 * 60_000);
  const held = runNotificationFreeze({
    handle,
    runId: "run-2",
    config,
    firstRun: false,
    now: second,
  });

  expect(held.created).toBe(0);
  expect(held.reason).toContain("coalescing window");
  // The point of holding rather than dropping: the event is still queued.
  expect(unnotifiedCandidates(handle).map((event) => event.id)).toContain("e2");
});

test("the next run past the window sends one message containing both", () => {
  startRun("run-1");
  startRun("run-2");
  startRun("run-3");
  seedEvent({ id: "e1", runId: "run-1" });

  const first = new Date("2026-10-20T10:00:00Z");
  runNotificationFreeze({ handle, runId: "run-1", config, firstRun: false, now: first });

  seedEvent({ id: "e2", runId: "run-2", importance: 80 });
  runNotificationFreeze({
    handle,
    runId: "run-2",
    config,
    firstRun: false,
    now: new Date(first.getTime() + 30 * 60_000),
  });

  seedEvent({ id: "e3", runId: "run-3", importance: 85 });
  const later = new Date(first.getTime() + 121 * 60_000);
  const sent = runNotificationFreeze({
    handle,
    runId: "run-3",
    config,
    firstRun: false,
    now: later,
  });

  expect(sent.created).toBe(1);
  const messages = sentMessages();
  expect(messages).toHaveLength(2);
  const batched = messages[1]!;
  const items = batched.items as { eventId: string }[];
  // Both held events ride the same message: two runs, one notification.
  expect(items.map((item) => item.eventId).sort()).toEqual(["e2", "e3"]);
});

test("an urgent event ignores the window and goes out immediately", () => {
  startRun("run-1");
  startRun("run-2");
  seedEvent({ id: "e1", runId: "run-1" });

  const first = new Date("2026-10-20T10:00:00Z");
  runNotificationFreeze({ handle, runId: "run-1", config, firstRun: false, now: first });

  // 95 >= urgentImportance (88): a major story must not wait for batching.
  seedEvent({ id: "e2", runId: "run-2", importance: 95 });
  const sent = runNotificationFreeze({
    handle,
    runId: "run-2",
    config,
    firstRun: false,
    now: new Date(first.getTime() + 30 * 60_000),
  });

  expect(sent.created).toBe(1);
  expect(sentMessages()).toHaveLength(2);
});

test("a quiet period still flushes what is queued", () => {
  startRun("run-1");
  startRun("run-2");
  seedEvent({ id: "e1", runId: "run-1" });

  const first = new Date("2026-10-20T10:00:00Z");
  runNotificationFreeze({ handle, runId: "run-1", config, firstRun: false, now: first });

  seedEvent({ id: "e2", runId: "run-2", importance: 80 });
  runNotificationFreeze({
    handle,
    runId: "run-2",
    config,
    firstRun: false,
    now: new Date(first.getTime() + 30 * 60_000),
  });
  expect(sentMessages()).toHaveLength(1);

  // No run has content, but the window elapsed: the periodic maintenance flush
  // is what keeps a held story from waiting for the next busy run.
  const flushed = flushNotificationQueue({
    handle,
    runId: "run-2",
    config,
    now: new Date(first.getTime() + 121 * 60_000),
  });

  expect(flushed.created).toBe(1);
  expect(sentMessages()).toHaveLength(2);
});

test("the flush does nothing while the window is still closed", () => {
  startRun("run-1");
  startRun("run-2");
  seedEvent({ id: "e1", runId: "run-1" });

  const first = new Date("2026-10-20T10:00:00Z");
  runNotificationFreeze({ handle, runId: "run-1", config, firstRun: false, now: first });
  seedEvent({ id: "e2", runId: "run-2", importance: 80 });
  runNotificationFreeze({
    handle,
    runId: "run-2",
    config,
    firstRun: false,
    now: new Date(first.getTime() + 30 * 60_000),
  });

  const flushed = flushNotificationQueue({
    handle,
    runId: "run-2",
    config,
    now: new Date(first.getTime() + 60 * 60_000),
  });

  expect(flushed.created).toBe(0);
  expect(sentMessages()).toHaveLength(1);
});

test("coalesceMinutes 0 restores one message per run", () => {
  const perRun = { ...config, coalesceMinutes: 0 };
  startRun("run-1");
  startRun("run-2");
  seedEvent({ id: "e1", runId: "run-1" });

  const first = new Date("2026-10-20T10:00:00Z");
  runNotificationFreeze({ handle, runId: "run-1", config: perRun, firstRun: false, now: first });

  seedEvent({ id: "e2", runId: "run-2", importance: 80 });
  const second = runNotificationFreeze({
    handle,
    runId: "run-2",
    config: perRun,
    firstRun: false,
    now: new Date(first.getTime() + 60_000),
  });

  expect(second.created).toBe(1);
  expect(sentMessages()).toHaveLength(2);
});

test("the window is measured from the last push, not from the last run", () => {
  startRun("run-1");
  seedEvent({ id: "e1", runId: "run-1" });

  const at = new Date("2026-10-20T10:00:00Z");
  runNotificationFreeze({ handle, runId: "run-1", config, firstRun: false, now: at });

  expect(lastPushAt(handle, "chat-1")?.getTime()).toBe(at.getTime());
});
