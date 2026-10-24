import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { createDb, type DbHandle } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { deliveries, events, insights, refreshRuns } from "../src/db/schema.ts";
import type { ModelClient } from "../src/insights/model.ts";
import { suppressDuplicateNotifications } from "../src/notifications/dedup.ts";
import { runNotificationFreeze } from "../src/notifications/telegram.ts";

/**
 * Cross-event duplicate suppression. The case that motivated it: several
 * publishers covered the same SpaceX financing and each became its own event,
 * so the chat received the same story repeatedly.
 */

let dir: string;
let handle: DbHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-news-dedup-"));
  handle = createDb(join(dir, "app.db"));
  migrate(handle.sqlite);
  handle.db
    .insert(refreshRuns)
    .values({
      id: "run-1",
      trigger: "schedule",
      state: "succeeded",
      activeSlot: null,
      attempt: 1,
      queuedAt: new Date(),
    })
    .run();
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

const config = {
  enabled: true,
  maxItems: 5,
  minImportance: 70,
  chatId: "chat-1",
  botToken: "token",
};

const signal = () => AbortSignal.timeout(5_000);

/** An event bumped by run-1 whose revision is still undelivered. */
function seedEvent(id: string, importance = 80) {
  const now = new Date();
  handle.db
    .insert(events)
    .values({
      id,
      title: id,
      topics: [],
      kind: "news",
      firstSeenAt: now,
      lastArticleAt: now,
      effectiveTime: now,
      hotScore: 500,
      analysisState: "ok",
      importance,
      notificationRevision: 1,
      revisionBumpedRunId: "run-1",
      notifiedRevision: 0,
      updatedAt: now,
    })
    .run();
}

/** Attaches an insight to an existing event and points the event at it. */
function seedInsight(id: string, eventId: string, titles: string[], fact: string) {
  handle.db
    .insert(insights)
    .values({
      id,
      eventId,
      inputHash: `hash-${id}`,
      model: "stub",
      promptVersion: "v1",
      scope: "excerpt",
      output: {
        title: titles[0],
        facts: [{ text: fact, citations: ["0"] }],
        importance: { score: 80, reason: "r" },
        impact: null,
        watch: null,
        material_update: { is: false, reason: "r" },
      },
      evidence: titles.map((title) => ({
        title,
        excerpt: null,
        publisher: "p",
        scope: "headline",
      })),
      revision: 1,
      createdAt: new Date(),
    })
    .run();
  handle.db.update(events).set({ latestInsightId: id }).where(eq(events.id, eventId)).run();
}

function seedSentDelivery(insightId: string) {
  const now = new Date();
  handle.db
    .insert(deliveries)
    .values({
      id: "del-1",
      runId: "run-1",
      chatId: "chat-1",
      items: [{ eventId: "ev-old", revision: 1, insightId }],
      text: "previous",
      state: "sent",
      attempts: 1,
      sentAt: now,
      createdAt: now,
    })
    .run();
}

const decisionModel = (duplicate: boolean): ModelClient => ({
  name: "stub",
  available: true,
  complete: async () => JSON.stringify({ duplicate }),
});

const noisyModel = (text: string): ModelClient => ({
  name: "stub",
  available: true,
  complete: async () => text,
});

const failingModel = (): ModelClient => ({
  name: "stub",
  available: true,
  complete: async () => {
    throw new Error("model exploded");
  },
});

const FINANCING_TITLE = "SpaceX in Talks to Borrow $40 Billion to Buy Nvidia Chips";
const DUPLICATE_TITLE = "SpaceX seeks $40bn to buy Nvidia chips";

test("a paraphrase of a recently sent story is suppressed", async () => {
  seedEvent("ev-sent");
  seedInsight("ins-sent", "ev-sent", [FINANCING_TITLE], "旧消息");
  seedSentDelivery("ins-sent");
  seedEvent("ev-dup");
  seedInsight("ins-dup", "ev-dup", [DUPLICATE_TITLE], "同一条融资消息");

  const suppressed = await suppressDuplicateNotifications({
    handle,
    model: decisionModel(true),
    signal: signal(),
    runId: "run-1",
    config,
    firstRun: false,
  });

  expect(suppressed?.has("ev-dup")).toBe(true);
});

test("a materially new development is kept", async () => {
  seedEvent("ev-sent");
  seedInsight("ins-sent", "ev-sent", [FINANCING_TITLE], "旧消息");
  seedSentDelivery("ins-sent");
  seedEvent("ev-new");
  seedInsight(
    "ins-new",
    "ev-new",
    ["SpaceX credit risk jumps on its $40 billion Nvidia chip borrowing"],
    "信用风险上升",
  );

  const suppressed = await suppressDuplicateNotifications({
    handle,
    model: decisionModel(false),
    signal: signal(),
    runId: "run-1",
    config,
    firstRun: false,
  });

  expect(suppressed?.has("ev-new") ?? false).toBe(false);
});

test("an unreadable decision fails open and keeps the item", async () => {
  seedEvent("ev-sent");
  seedInsight("ins-sent", "ev-sent", [FINANCING_TITLE], "旧消息");
  seedSentDelivery("ins-sent");
  seedEvent("ev-dup");
  seedInsight("ins-dup", "ev-dup", [DUPLICATE_TITLE], "同一条融资消息");

  const noisy = await suppressDuplicateNotifications({
    handle,
    model: noisyModel("I am not JSON"),
    signal: signal(),
    runId: "run-1",
    config,
    firstRun: false,
  });
  expect(noisy?.has("ev-dup") ?? false).toBe(false);

  const broken = await suppressDuplicateNotifications({
    handle,
    model: failingModel(),
    signal: signal(),
    runId: "run-1",
    config,
    firstRun: false,
  });
  expect(broken?.has("ev-dup") ?? false).toBe(false);
});

test("duplicates within one batch are suppressed too", async () => {
  // Nothing was sent before, but two bumped events this run report one story.
  seedEvent("ev-a", 90);
  seedInsight("ins-a", "ev-a", [FINANCING_TITLE], "甲");
  seedEvent("ev-b", 85);
  seedInsight("ins-b", "ev-b", [DUPLICATE_TITLE], "乙");

  const suppressed = await suppressDuplicateNotifications({
    handle,
    model: decisionModel(true),
    signal: signal(),
    runId: "run-1",
    config,
    firstRun: false,
  });

  // The first (higher importance) is kept, the later one is dropped.
  expect(suppressed?.has("ev-a") ?? false).toBe(false);
  expect(suppressed?.has("ev-b")).toBe(true);
});

test("suppression is skipped on the first run and when notifications are off", async () => {
  seedEvent("ev-sent");
  seedInsight("ins-sent", "ev-sent", [FINANCING_TITLE], "旧消息");
  seedSentDelivery("ins-sent");
  seedEvent("ev-dup");
  seedInsight("ins-dup", "ev-dup", [DUPLICATE_TITLE], "同一条融资消息");

  const model = decisionModel(true);
  expect(
    await suppressDuplicateNotifications({
      handle,
      model,
      signal: signal(),
      runId: "run-1",
      config,
      firstRun: true,
    }),
  ).toBeUndefined();

  expect(
    await suppressDuplicateNotifications({
      handle,
      model,
      signal: signal(),
      runId: "run-1",
      config: { ...config, enabled: false },
      firstRun: false,
    }),
  ).toBeUndefined();
});

test("the freeze drops a suppressed event but still advances its revision", () => {
  seedEvent("ev-dup");
  seedInsight("ins-dup", "ev-dup", [DUPLICATE_TITLE], "同一条融资消息");

  const notify = runNotificationFreeze({
    handle,
    runId: "run-1",
    config,
    firstRun: false,
    suppressed: new Set(["ev-dup"]),
  });

  expect(notify.created).toBe(0);
  expect(handle.db.select().from(deliveries).all()).toHaveLength(0);

  // The revision is advanced, so the same version can never be delivered later.
  const row = handle.db.select().from(events).where(eq(events.id, "ev-dup")).get()!;
  expect(row.notifiedRevision).toBe(row.notificationRevision);
});
