import { and, desc, eq, gte } from "drizzle-orm";
import type { DbHandle } from "../db/connection.ts";
import { newId } from "../db/ids.ts";
import { deliveries, events } from "../db/schema.ts";
import { latestFinishedRun } from "../refresh/request.ts";
import { renderEventBlock, truncateMessage } from "./telegram.ts";

/**
 * Daily digest: one summary of the last 24 hours, sent at a fixed UTC hour.
 *
 * It is deliberately independent of the per-run push. The digest does not read
 * or advance `notification_revision`/`notified_revision`, so the two channels
 * never interfere: a high-importance item can be pushed immediately and still
 * appear in the morning recap.
 *
 * Idempotency has no separate state table: a digest is due when the current
 * hour boundary has passed and no digest delivery was created since that
 * boundary. Restarting the process therefore cannot send a second digest for
 * the same day, and a window with no qualifying events sends nothing (and is
 * retried on the next tick, so a late-developing story still gets summarized).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_HOURS = 24;

export type DigestConfig = {
  enabled: boolean;
  /** UTC hour (0-23) at which the digest is sent. */
  hourUtc: number;
  maxItems: number;
  minImportance: number;
};

export type DigestDeps = {
  config: DigestConfig;
  chatId?: string;
  botToken?: string;
  now?: Date;
};

export type DigestResult =
  | { created: true; deliveryId: string; count: number }
  | { created: false; reason: string };

/** Most recent instant at `hourUtc` UTC that is not in the future. */
export function digestBoundary(now: Date, hourUtc: number): Date {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hourUtc,
    0,
    0,
    0,
  );
  return new Date(today <= now.getTime() ? today : today - DAY_MS);
}

/** Next instant the digest will be sent at. */
export function nextDigestAt(now: Date, hourUtc: number): Date {
  return new Date(digestBoundary(now, hourUtc).getTime() + DAY_MS);
}

/** True when a digest for the current window has not been created yet. */
export function isDigestDue(
  handle: DbHandle,
  { config, chatId, botToken, now = new Date() }: DigestDeps,
): boolean {
  if (!config.enabled || !chatId || !botToken) return false;

  const boundary = digestBoundary(now, config.hourUtc);
  const existing = handle.db
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(and(eq(deliveries.kind, "digest"), gte(deliveries.createdAt, boundary)))
    .limit(1)
    .get();
  return !existing;
}

export type DigestSelection = { since: Date; minImportance: number; maxItems: number };

/**
 * The events a digest would list, ordered the way the digest presents them:
 * most important first, then hottest, then most recent. `since` is explicit so
 * the same function serves the 24h window and the preview script.
 */
export function digestCandidates(
  handle: DbHandle,
  { since, minImportance, maxItems }: DigestSelection,
) {
  return handle.db
    .select()
    .from(events)
    .where(and(gte(events.importance, minImportance), gte(events.effectiveTime, since)))
    .orderBy(desc(events.importance), desc(events.hotScore), desc(events.effectiveTime))
    .limit(maxItems)
    .all();
}

/** Renders the digest text; shared by the sender and the preview script. */
export function renderDigest(
  handle: DbHandle,
  selected: ReturnType<typeof digestCandidates>,
): string {
  const blocks = selected.map((event) => renderEventBlock(handle, event));
  return truncateMessage(`📰 每日摘要 · ${selected.length} 条\n\n${blocks.join("\n\n---\n\n")}`);
}

/**
 * Creates the digest delivery when one is due, otherwise returns why not. The
 * delivery is picked up by the same `deliverDue` sweep as pushes, so retry and
 * at-least-once semantics are shared.
 */
export function runDigestIfDue(handle: DbHandle, deps: DigestDeps): DigestResult {
  const now = deps.now ?? new Date();
  if (!isDigestDue(handle, deps)) return { created: false, reason: "not due" };

  // A delivery row is tied to a refresh run; digest content is published by the
  // most recent finished run, so an empty database (no run yet) has nothing to
  // summarize.
  const run = latestFinishedRun(handle);
  if (!run) return { created: false, reason: "no finished run" };

  const selected = digestCandidates(handle, {
    since: new Date(now.getTime() - WINDOW_HOURS * 60 * 60 * 1000),
    minImportance: deps.config.minImportance,
    maxItems: deps.config.maxItems,
  });

  if (selected.length === 0) return { created: false, reason: "no candidates" };

  const text = renderDigest(handle, selected);

  const items = selected.map((event) => ({
    eventId: event.id,
    revision: event.notificationRevision,
    insightId: event.latestInsightId,
  }));

  const deliveryId = newId();
  handle.db
    .insert(deliveries)
    .values({
      id: deliveryId,
      runId: run.id,
      chatId: deps.chatId!,
      kind: "digest",
      items: items as never,
      text,
      state: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    })
    .run();

  return { created: true, deliveryId, count: selected.length };
}
