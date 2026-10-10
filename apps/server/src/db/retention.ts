import { and, isNull, lt, ne } from "drizzle-orm";
import type { DbHandle } from "./connection.ts";
import { articles, deliveries, events } from "./schema.ts";

/**
 * Age-based retention for the unbounded tables.
 *
 * Only `refresh_runs` was pruned before; `events`, `insights`, `articles` and
 * `deliveries` grew forever. The policy is deliberately conservative:
 * - An event is removed only once nothing has touched it for `days`.
 * - An article is removed only when it is no longer attached to any event and
 *   is old enough, so the evidence behind a retained event survives.
 * - A pending delivery is never removed, however old, so nothing in flight is
 *   dropped. The daily snapshot is the safety net for anything pruned.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type RetentionOptions = {
  /** Age in days; 0 disables pruning. */
  days: number;
  now?: Date;
};

export type RetentionResult = {
  events: number;
  articles: number;
  deliveries: number;
};

/** Deletes rows older than the cutoff in one transaction. Idempotent. */
export function pruneOldData(
  handle: DbHandle,
  { days, now = new Date() }: RetentionOptions,
): RetentionResult {
  if (days <= 0) return { events: 0, articles: 0, deliveries: 0 };

  const cutoff = new Date(now.getTime() - days * DAY_MS);

  return handle.sqlite.transaction(() => {
    // events.latest_insight_id -> insights(id, event_id) is a plain (non-
    // cascading) reference, so clear it first; deleting the event then cascades
    // its insights. Without this the cascade could trip the foreign key while
    // the event row still points at an insight being removed.
    handle.db
      .update(events)
      .set({ latestInsightId: null })
      .where(lt(events.updatedAt, cutoff))
      .run();

    const removedEvents = handle.db
      .delete(events)
      .where(lt(events.updatedAt, cutoff))
      .run().changes;

    // Articles of a removed event had their event_id set to NULL by the
    // ON DELETE SET NULL rule; the old ones are pruned here, while an article
    // still held by a retained event keeps its event_id and is left alone.
    const removedArticles = handle.db
      .delete(articles)
      .where(and(isNull(articles.eventId), lt(articles.discoveredAt, cutoff)))
      .run().changes;

    const removedDeliveries = handle.db
      .delete(deliveries)
      .where(and(ne(deliveries.state, "pending"), lt(deliveries.createdAt, cutoff)))
      .run().changes;

    return {
      events: removedEvents,
      articles: removedArticles,
      deliveries: removedDeliveries,
    };
  })();
}

/**
 * Runs retention daily at `hourUtc:30` UTC (half an hour after the 03:00
 * backup). Unref'd so it never keeps the process alive; failures are reported
 * through `onError` and never fatal.
 */
export function scheduleRetention(
  handle: DbHandle,
  options: RetentionOptions & { onError?: (error: unknown) => void; hourUtc?: number },
): () => void {
  const run = () => {
    try {
      pruneOldData(handle, options);
    } catch (error) {
      options.onError?.(error);
    }
  };

  const now = Date.now();
  const next = new Date(now);
  next.setUTCHours(options.hourUtc ?? 3, 30, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);

  let interval: NodeJS.Timeout | undefined;
  const timeout = setTimeout(() => {
    run();
    interval = setInterval(run, DAY_MS);
    interval.unref?.();
  }, next.getTime() - now);
  timeout.unref?.();

  return () => {
    clearTimeout(timeout);
    if (interval) clearInterval(interval);
  };
}
