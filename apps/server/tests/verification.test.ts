import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { and, eq } from "drizzle-orm";
import { createDb, type DbHandle } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import {
  articles,
  deliveries,
  events,
  insights,
  refreshRuns,
  sourceRuns,
  sources,
} from "../src/db/schema.ts";
import { recordSourceOutcome, runIngest, syncSources } from "../src/refresh/ingest.ts";
import { createSourceRegistry } from "../src/sources/registry.ts";
import { deliverDue, renderMessage, runNotificationFreeze } from "../src/notifications/telegram.ts";

/**
 * The three guarantees about correctness under interruption and repetition:
 *  - a checkpoint write from a superseded attempt is rejected
 *  - a resumed run skips sources that already completed
 *  - one event version can never enter two deliveries
 */

let dir: string;
let handle: DbHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-news-verify-"));
  handle = createDb(join(dir, "app.db"));
  migrate(handle.sqlite);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function startRun(id: string, attempt: number, state = "running") {
  handle.db
    .insert(refreshRuns)
    .values({
      id,
      trigger: "manual",
      state,
      activeSlot: state === "running" || state === "queued" ? 1 : null,
      attempt,
      queuedAt: new Date(),
      startedAt: state === "running" ? new Date() : null,
    })
    .run();
}

function seedSource(key: string) {
  handle.db
    .insert(sources)
    .values({
      id: `src-${key}`,
      key,
      adapter: key,
      config: {},
      enabled: true,
      defaultTopics: [],
      analyze: true,
      status: "unknown",
      createdAt: new Date(),
    })
    .run();
}

test("a checkpoint write from a superseded attempt is rejected", () => {
  // The run is on attempt 2, but a stale execution still thinks it is attempt 1.
  startRun("run-1", 2);
  seedSource("techcrunch");
  seedSource("ft");
  // beginSourceRuns would have created both snapshot rows.
  handle.db.insert(sourceRuns).values({ runId: "run-1", sourceId: "src-techcrunch" }).run();
  handle.db.insert(sourceRuns).values({ runId: "run-1", sourceId: "src-ft" }).run();

  const accepted = recordSourceOutcome(handle, {
    runId: "run-1",
    attempt: 2,
    sourceId: "src-techcrunch",
    state: "done",
    fetched: 5,
  });
  expect(accepted).toBe(true);
  expect(
    handle.db
      .select()
      .from(sourceRuns)
      .all()
      .find((row) => row.sourceId === "src-techcrunch")?.state,
  ).toBe("done");

  // A write arriving with the stale attempt must be ignored.
  const stale = recordSourceOutcome(handle, {
    runId: "run-1",
    attempt: 1,
    sourceId: "src-ft",
    state: "done",
    fetched: 9,
  });
  expect(stale).toBe(false);
  expect(
    handle.db
      .select()
      .from(sourceRuns)
      .all()
      .find((row) => row.sourceId === "src-ft")?.state,
  ).toBe("pending");
});

test("a checkpoint write is rejected once the run is no longer running", () => {
  startRun("run-2", 1, "queued");
  seedSource("techcrunch");

  const accepted = recordSourceOutcome(handle, {
    runId: "run-2",
    attempt: 1,
    sourceId: "src-techcrunch",
    state: "done",
  });
  // The run was requeued (crash recovery), so the write belongs to a dead
  // execution and must not land.
  expect(accepted).toBe(false);
});

test("a resumed run skips sources that already completed", async () => {
  const definitions = createSourceRegistry({ fetch: globalThis.fetch });
  syncSources(handle, definitions);

  startRun("run-3", 1);
  // Seed the source snapshot the way beginSourceRuns would.
  const all = handle.db.select().from(sources).all();
  for (const source of all) {
    handle.db.insert(sourceRuns).values({ runId: "run-3", sourceId: source.id }).run();
  }

  // Mark every source done except one, and give the done ones an outcome.
  const [first, ...rest] = all;
  for (const source of rest) {
    handle.db
      .update(sourceRuns)
      .set({ state: "done", fetched: 7, finishedAt: new Date() })
      .where(eqSource("run-3", source.id))
      .run();
  }

  const calls: string[] = [];
  const spyDefinitions = definitions.map((definition) => ({
    ...definition,
    adapter: {
      key: definition.key,
      fetch: async () => {
        calls.push(definition.key);
        return { articles: [], warnings: [] };
      },
    },
  }));

  await runIngest({
    handle,
    definitions: spyDefinitions,
    runId: "run-3",
    attempt: 1,
    isCurrent: () => true,
  });

  // Only the one incomplete source was fetched.
  expect(calls).toEqual([first!.key]);
});

function seedBumpedEvent() {
  const now = new Date();
  handle.db
    .insert(events)
    .values({
      id: "ev1",
      title: "Nvidia unveils a chip",
      topics: ["ai"],
      kind: "news",
      firstSeenAt: now,
      lastArticleAt: now,
      effectiveTime: now,
      hotScore: 900,
      analysisState: "ok",
      importance: 95,
      notificationRevision: 1,
      revisionBumpedRunId: "run-a",
      notifiedRevision: 0,
      updatedAt: now,
    })
    .run();
}

const notifyConfig = { enabled: true, maxItems: 5, minImportance: 70, chatId: "1", botToken: "t" };

test("one event version cannot enter two deliveries", () => {
  // The delivery row references its run, so the run must exist.
  startRun("run-a", 1, "succeeded");
  seedBumpedEvent();

  // First freeze: the bumped event enters a delivery.
  const first = runNotificationFreeze({
    handle,
    runId: "run-a",
    config: notifyConfig,
    firstRun: false,
  });
  expect(first.created).toBe(1);
  expect(handle.db.select().from(deliveries).all()).toHaveLength(1);

  // Second freeze for the same run: the revision is already notified, so the
  // same version must not produce another delivery.
  const second = runNotificationFreeze({
    handle,
    runId: "run-a",
    config: notifyConfig,
    firstRun: false,
  });
  expect(second.created).toBe(0);
  expect(handle.db.select().from(deliveries).all()).toHaveLength(1);
});

test("a later revision of the same event does produce a new delivery", () => {
  startRun("run-a", 1, "succeeded");
  startRun("run-b", 1, "succeeded");
  seedBumpedEvent();

  runNotificationFreeze({ handle, runId: "run-a", config: notifyConfig, firstRun: false });

  // The event advances: revision 2, bumped by a later run.
  handle.db
    .update(events)
    .set({ notificationRevision: 2, revisionBumpedRunId: "run-b" })
    .where(eqId("ev1"))
    .run();

  const second = runNotificationFreeze({
    handle,
    runId: "run-b",
    config: notifyConfig,
    firstRun: false,
  });
  expect(second.created).toBe(1);
  expect(handle.db.select().from(deliveries).all()).toHaveLength(2);
});

test("a due delivery is retried after its backoff expires", async () => {
  const past = new Date(Date.now() - 60_000);
  handle.db
    .insert(refreshRuns)
    .values({
      id: "run-c",
      trigger: "manual",
      state: "succeeded",
      activeSlot: null,
      attempt: 1,
      queuedAt: past,
    })
    .run();
  handle.db
    .insert(deliveries)
    .values({
      id: "del-1",
      runId: "run-c",
      chatId: "1",
      items: [],
      text: "hello",
      state: "pending",
      attempts: 1,
      nextAttemptAt: past,
      createdAt: past,
    })
    .run();

  let attempts = 0;
  const outcome = await deliverDue(handle, async () => {
    attempts += 1;
    return { ok: true, messageId: "42" };
  });

  expect(outcome.sent).toBe(1);
  expect(attempts).toBe(1);
  expect(handle.db.select().from(deliveries).all()[0]!.state).toBe("sent");
});

test("a delivery scheduled in the future is not sent yet", async () => {
  const future = new Date(Date.now() + 60_000);
  handle.db
    .insert(refreshRuns)
    .values({
      id: "run-d",
      trigger: "manual",
      state: "succeeded",
      activeSlot: null,
      attempt: 1,
      queuedAt: new Date(),
    })
    .run();
  handle.db
    .insert(deliveries)
    .values({
      id: "del-2",
      runId: "run-d",
      chatId: "1",
      items: [],
      text: "later",
      state: "pending",
      attempts: 1,
      nextAttemptAt: future,
      createdAt: new Date(),
    })
    .run();

  const outcome = await deliverDue(handle, async () => ({ ok: true, messageId: "1" }));
  expect(outcome.sent).toBe(0);
});

test("the notification includes the original article link", () => {
  startRun("run-e", 1, "succeeded");
  seedBumpedEvent();

  // The insight cites evidence index 0; that article's URL must be the link.
  const citedUrl = "https://example.com/the-original-report";
  const otherUrl = "https://example.com/a-later-reprint";
  handle.db
    .insert(articles)
    .values({
      id: "art-cited",
      canonicalUrl: citedUrl,
      publisher: "Example",
      title: "Original report",
      titleNorm: "original report",
      publishedAt: new Date("2026-01-01"),
      discoveredAt: new Date(),
      scope: "excerpt",
      relevance: "relevant",
      topics: [],
      kind: "news",
      eventId: "ev1",
    })
    .run();
  handle.db
    .insert(articles)
    .values({
      id: "art-newer",
      canonicalUrl: otherUrl,
      publisher: "Reprint",
      title: "Reprint",
      titleNorm: "reprint",
      publishedAt: new Date("2026-02-01"),
      discoveredAt: new Date(),
      scope: "excerpt",
      relevance: "relevant",
      topics: [],
      kind: "news",
      eventId: "ev1",
    })
    .run();

  handle.db
    .insert(insights)
    .values({
      id: "ins-1",
      eventId: "ev1",
      inputHash: "h1",
      model: "stub",
      promptVersion: "v1",
      scope: "excerpt",
      output: {
        title: "中文标题",
        facts: [{ text: "事实", citations: ["0"] }],
        importance: { score: 95, reason: "r" },
        impact: null,
        watch: null,
        material_update: { is: true, reason: "r" },
      },
      evidence: [
        { id: "art-cited", title: "Original report", excerpt: null, publisher: "Example" },
      ],
      revision: 1,
      createdAt: new Date(),
    })
    .run();
  handle.db.update(events).set({ latestInsightId: "ins-1" }).where(eqId("ev1")).run();

  const message = renderMessage(handle, [
    {
      id: "ev1",
      title: "Nvidia unveils a chip",
      importance: 95,
      notificationRevision: 1,
      notifiedRevision: 0,
      latestInsightId: "ins-1",
      hotScore: 900,
    },
  ]);

  // The cited article wins over the more recent one.
  expect(message).toContain(citedUrl);
  expect(message).not.toContain(otherUrl);
  expect(message.startsWith("【95】中文标题")).toBe(true);
});

test("the notification falls back to the newest article when no citation resolves", () => {
  startRun("run-f", 1, "succeeded");
  seedBumpedEvent();

  handle.db
    .insert(articles)
    .values({
      id: "art-only",
      canonicalUrl: "https://example.com/only-article",
      publisher: "Example",
      title: "Only",
      titleNorm: "only",
      publishedAt: new Date("2026-03-01"),
      discoveredAt: new Date(),
      scope: "excerpt",
      relevance: "relevant",
      topics: [],
      kind: "news",
      eventId: "ev1",
    })
    .run();

  const message = renderMessage(handle, [
    {
      id: "ev1",
      title: "Nvidia unveils a chip",
      importance: 95,
      notificationRevision: 1,
      notifiedRevision: 0,
      latestInsightId: null,
      hotScore: 900,
    },
  ]);

  expect(message).toContain("https://example.com/only-article");
});

// Local helpers so the test reads clearly without repeating drizzle predicates.
function eqSource(runId: string, sourceId: string) {
  return and(eq(sourceRuns.runId, runId), eq(sourceRuns.sourceId, sourceId));
}
function eqId(id: string) {
  return eq(events.id, id);
}
