import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import type { DbHandle } from "../db/connection.ts";
import { newId } from "../db/ids.ts";
import { articles, deliveries, events, insights } from "../db/schema.ts";

/**
 * Telegram delivery.
 *
 * Candidates are the events whose notification revision increased in this run,
 * are unread by the chat, and reach the importance threshold. The freeze step
 * advances `notified_revision` for every event whose version increased —
 * including ones that did not make the cut — so nothing accumulates and the
 * same version can never enter two deliveries.
 *
 * Coalescing sits on top: a push is only built when the coalescing window has
 * elapsed since the previous one, so several runs' news arrives as a single
 * message. Events held back keep `notification_revision > notified_revision`,
 * which is what makes them visible to the next run and to the periodic flush.
 * An urgent event bypasses the window.
 *
 * Semantics are at-least-once: a crash after sending but before recording the
 * message can repeat one message, which is harmless in a personal chat.
 */

export type NotifyConfig = {
  enabled: boolean;
  maxItems: number;
  minImportance: number;
  /**
   * Minimum gap between pushes. A run that has content but lands inside the
   * window leaves it queued instead of sending, so several runs' worth of news
   * arrives as one message. 0 disables coalescing (one message per run).
   */
  coalesceMinutes: number;
  /** At or above this importance, the window is ignored and the item goes out now. */
  urgentImportance: number;
  chatId?: string;
  botToken?: string;
};

export type NotifyDeps = {
  handle: DbHandle;
  runId: string;
  config: NotifyConfig;
  /** True when no run has ever finished; the first run stays silent. */
  firstRun: boolean;
  now?: Date;
  /**
   * Event ids to keep out of this delivery because the chat already received
   * the same development from a different event (see notifications/dedup.ts).
   * Their revisions are still advanced, so nothing accumulates.
   */
  suppressed?: ReadonlySet<string>;
};

export type NotifyResult = {
  created: number;
  frozen: number;
  reason?: string;
};

export type Candidate = {
  id: string;
  title: string;
  importance: number | null;
  notificationRevision: number;
  notifiedRevision: number;
  latestInsightId: string | null;
  hotScore: number;
};

/** Every event with an unreported version: candidates for the next push. */
export function unnotifiedCandidates(handle: DbHandle): Candidate[] {
  return handle.db
    .select()
    .from(events)
    .where(gt(events.notificationRevision, events.notifiedRevision))
    .all() as Candidate[];
}

/** Every event whose version increased in this run and is still unsent. */
export function bumpedNotificationCandidates(handle: DbHandle, runId: string): Candidate[] {
  return handle.db
    .select()
    .from(events)
    .where(
      and(
        eq(events.revisionBumpedRunId, runId),
        gt(events.notificationRevision, events.notifiedRevision),
      ),
    )
    .all() as Candidate[];
}

/**
 * Last instant a push was sent to this chat, or null when none ever was.
 * Coalescing is measured against this rather than against the previous run, so
 * the window holds across restarts and manual refreshes.
 */
export function lastPushAt(handle: DbHandle, chatId: string): Date | null {
  const row = handle.db
    .select({ sentAt: deliveries.sentAt, createdAt: deliveries.createdAt })
    .from(deliveries)
    .where(and(eq(deliveries.chatId, chatId), eq(deliveries.kind, "refresh")))
    .orderBy(desc(deliveries.createdAt))
    .limit(1)
    .get();
  if (!row) return null;
  return row.sentAt ?? row.createdAt;
}

export type FreezeOptions = {
  /** When set, sends immediately regardless of the coalescing window. */
  urgent?: boolean;
};

/**
 * Decides what to send now and records it.
 *
 * With coalescing on, a run whose window has not elapsed leaves its events
 * unreported: `notified_revision` is not advanced, so they are picked up by the
 * next run that does send. That is what turns 17-21 single-item messages a day
 * into a handful of multi-item ones without dropping anything.
 *
 * An urgent item (importance at or above `urgentImportance`) opens a window
 * early, so a major story is never held back by the batching.
 */
export function runNotificationFreeze({
  handle,
  runId,
  config,
  firstRun,
  now = new Date(),
  suppressed,
  options = {},
}: NotifyDeps & { options?: FreezeOptions }): NotifyResult {
  // Every event whose version increased in this run.
  const bumped = bumpedNotificationCandidates(handle, runId);

  if (firstRun) {
    // First deployment: advance the pointers without sending, so historical
    // content does not arrive as a flood.
    markNotified(handle, bumped);
    return { created: 0, frozen: bumped.length, reason: "first run is silent" };
  }

  if (!config.enabled) {
    markNotified(handle, bumped);
    return { created: 0, frozen: bumped.length, reason: "notifications disabled" };
  }

  if (!config.chatId || !config.botToken) {
    return { created: 0, frozen: 0, reason: "telegram credentials not configured" };
  }

  if (bumped.length === 0) {
    // Nothing new, but an earlier run may have left events queued while the
    // window was closed. A quiet period must still flush them, otherwise a
    // queued story waits for the next busy run, which could be hours away.
    return flushNotificationQueue({ handle, runId, config, now, suppressed, options });
  }

  const passing = bumped.filter(
    (event) => (event.importance ?? 0) >= config.minImportance && !suppressed?.has(event.id),
  );

  // Below the threshold: drop them (advance the pointer) so they do not
  // accumulate and get re-evaluated forever.
  if (passing.length === 0) {
    markNotified(handle, bumped);
    return { created: 0, frozen: bumped.length };
  }

  // Everything unreported, not just this run's, is what a coalesced message
  // contains. Bumped-but-suppressed events stay out.
  const queued = unnotifiedCandidates(handle).filter(
    (event) => (event.importance ?? 0) >= config.minImportance && !suppressed?.has(event.id),
  );

  const urgent = queued.some((event) => (event.importance ?? 0) >= config.urgentImportance);

  if (!options.urgent && !urgent && !windowElapsed(handle, config, now)) {
    // Hold: leave these events unreported so the next run includes them.
    return { created: 0, frozen: 0, reason: "waiting for the coalescing window" };
  }

  return sendQueued({ handle, runId, config, now, queued, alsoFreeze: bumped });
}

/**
 * Flushes events an earlier run queued while the window was closed. Returns
 * without sending when the window is still closed or nothing qualifies.
 */
export function flushNotificationQueue({
  handle,
  runId,
  config,
  now = new Date(),
  suppressed,
  options = {},
}: {
  handle: DbHandle;
  runId: string;
  config: NotifyConfig;
  now?: Date;
  suppressed?: ReadonlySet<string>;
  options?: FreezeOptions;
}): NotifyResult {
  const queued = unnotifiedCandidates(handle).filter(
    (event) => (event.importance ?? 0) >= config.minImportance && !suppressed?.has(event.id),
  );

  if (queued.length === 0) return { created: 0, frozen: 0 };

  const urgent = queued.some((event) => (event.importance ?? 0) >= config.urgentImportance);
  if (!options.urgent && !urgent && !windowElapsed(handle, config, now)) {
    return { created: 0, frozen: 0, reason: "waiting for the coalescing window" };
  }

  return sendQueued({ handle, runId, config, now, queued, alsoFreeze: [] });
}

/** Builds and records the delivery for a set of queued events. */
function sendQueued({
  handle,
  runId,
  config,
  now,
  queued,
  alsoFreeze,
}: {
  handle: DbHandle;
  runId: string;
  config: NotifyConfig;
  now: Date;
  queued: Candidate[];
  /** Events to mark notified even if they fall outside the selected set. */
  alsoFreeze: Candidate[];
}): NotifyResult {
  const selected = queued
    .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || b.hotScore - a.hotScore)
    .slice(0, config.maxItems);

  let created = 0;
  handle.sqlite.transaction(() => {
    // Freeze every event this decision covers: this run's bumped events, plus
    // the queued ones the message was built from. Marking the queued overflow
    // too matches the previous behaviour — maxItems is a cap, and a capped item
    // is superseded by more important ones rather than re-sent later — and it
    // keeps `notification_revision > notified_revision` from leaking a growing
    // backlog.
    markNotified(handle, [...alsoFreeze, ...queued]);

    if (selected.length === 0) return;

    const items = selected.map((event) => ({
      eventId: event.id,
      revision: event.notificationRevision,
      insightId: event.latestInsightId,
    }));

    handle.db
      .insert(deliveries)
      .values({
        id: newId(),
        runId,
        chatId: config.chatId!,
        items: items as never,
        text: renderMessage(handle, selected),
        state: "pending",
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
      })
      .run();
    created += 1;
  })();

  return { created, frozen: alsoFreeze.length + queued.length };
}

/** True when no push has gone out within the configured window. */
function windowElapsed(handle: DbHandle, config: NotifyConfig, now: Date): boolean {
  if (config.coalesceMinutes <= 0) return true;
  const last = lastPushAt(handle, config.chatId!);
  if (!last) return true;
  return now.getTime() - last.getTime() >= config.coalesceMinutes * 60_000;
}

function markNotified(handle: DbHandle, eventsToMark: Candidate[]): void {
  for (const event of eventsToMark) {
    handle.db
      .update(events)
      .set({ notifiedRevision: event.notificationRevision })
      .where(eq(events.id, event.id))
      .run();
  }
}

/** Renders the message text from the selected events and their insights. */
export function renderMessage(handle: DbHandle, selected: Candidate[]): string {
  return selected.map((event) => renderEventBlock(handle, event)).join("\n\n---\n\n");
}

/**
 * One event block: score, Chinese heading, first fact and the original link.
 * Shared by the per-run push and the daily digest so both read identically.
 */
export function renderEventBlock(handle: DbHandle, event: Candidate): string {
  const insight = event.latestInsightId
    ? handle.db.select().from(insights).where(eq(insights.id, event.latestInsightId)).get()
    : undefined;

  const output = insight?.output as
    | { title?: string; facts?: { text: string; citations?: string[] }[] }
    | undefined;

  const heading = output?.title ?? event.title;
  const summary = output?.facts?.[0]?.text ?? "";
  const score = event.importance ?? 0;
  const url = eventArticleUrl(handle, event.id, output?.facts?.[0]?.citations);

  return [`【${score}】${heading}`, summary, url].filter(Boolean).join("\n");
}

/**
 * The original article link for an event. An insight's first fact cites the
 * evidence that supports it, so its first citation is the most faithful
 * "original source"; if that cannot be resolved, fall back to the most recent
 * article of the event.
 */
function eventArticleUrl(
  handle: DbHandle,
  eventId: string,
  citations: string[] | undefined,
): string | null {
  const insight = handle.db
    .select({ evidence: insights.evidence })
    .from(insights)
    .where(eq(insights.eventId, eventId))
    .orderBy(desc(insights.createdAt))
    .limit(1)
    .get();

  const citedId = resolveCitation(insight?.evidence, citations?.[0]);
  if (citedId) {
    const cited = handle.db
      .select({ url: articles.canonicalUrl })
      .from(articles)
      .where(eq(articles.id, citedId))
      .get();
    if (cited?.url) return cited.url;
  }

  const latest = handle.db
    .select({ url: articles.canonicalUrl })
    .from(articles)
    .where(eq(articles.eventId, eventId))
    .orderBy(desc(articles.publishedAt))
    .limit(1)
    .get();
  return latest?.url ?? null;
}

/**
 * An insight's citations are indices into its evidence array, so map a citation
 * ("0", "1", …) back to the article it refers to. The stored evidence is the
 * article array itself (an object with `articles` is also tolerated).
 */
function resolveCitation(evidence: unknown, citation: string | undefined): string | null {
  if (citation === undefined) return null;
  const index = Number.parseInt(citation, 10);
  if (!Number.isInteger(index) || index < 0) return null;

  const list = Array.isArray(evidence)
    ? evidence
    : (evidence as { articles?: unknown[] } | undefined)?.articles;
  if (!Array.isArray(list)) return null;

  const entry = list[index] as { id?: unknown } | undefined;
  return typeof entry?.id === "string" ? entry.id : null;
}

/** Telegram's limit is 4096 characters; trim summaries but keep the links. */
export function truncateMessage(text: string, limit = 4096): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

export type DeliveryOutcome = "sent" | "retry" | "failed" | "skipped";

/**
 * Sends one due delivery. Retryable failures (429, 5xx, network) are retried
 * with backoff up to MAX_ATTEMPTS; other 4xx are permanent.
 */
const MAX_ATTEMPTS = 5;

export function nextAttemptDelayMs(attempts: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) return retryAfterSeconds * 1000;
  return Math.min(60_000 * 2 ** attempts, 30 * 60_000);
}

export type SendFn = (
  chatId: string,
  text: string,
) => Promise<
  | { ok: true; messageId: string }
  | { ok: false; status?: number; retryAfter?: number; error: string }
>;

export async function deliverDue(
  handle: DbHandle,
  send: SendFn,
  now = new Date(),
): Promise<{ sent: number; retried: number; failed: number }> {
  const due = handle.db
    .select()
    .from(deliveries)
    .where(
      and(
        eq(deliveries.state, "pending"),
        or(isNull(deliveries.nextAttemptAt), lte(deliveries.nextAttemptAt, now)),
      ),
    )
    .orderBy(deliveries.nextAttemptAt)
    .all();

  const result = { sent: 0, retried: 0, failed: 0 };

  for (const delivery of due) {
    const outcome = await send(delivery.chatId, truncateMessage(delivery.text));
    const attempts = delivery.attempts + 1;

    if (outcome.ok) {
      handle.db
        .update(deliveries)
        .set({
          state: "sent",
          attempts,
          messageId: outcome.messageId,
          sentAt: new Date(),
          lastError: null,
        })
        .where(eq(deliveries.id, delivery.id))
        .run();
      result.sent += 1;
      continue;
    }

    const retryable =
      outcome.status === undefined || outcome.status === 429 || outcome.status >= 500;

    if (retryable && attempts < MAX_ATTEMPTS) {
      handle.db
        .update(deliveries)
        .set({
          state: "pending",
          attempts,
          lastError: outcome.error,
          nextAttemptAt: new Date(Date.now() + nextAttemptDelayMs(attempts, outcome.retryAfter)),
        })
        .where(eq(deliveries.id, delivery.id))
        .run();
      result.retried += 1;
    } else {
      handle.db
        .update(deliveries)
        .set({ state: "failed", attempts, lastError: outcome.error })
        .where(eq(deliveries.id, delivery.id))
        .run();
      result.failed += 1;
    }
  }

  return result;
}

/** Telegram Bot API sender. */
export function createTelegramSender(botToken: string, fetchImpl: typeof globalThis.fetch): SendFn {
  return async (chatId, text) => {
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          description?: string;
          parameters?: { retry_after?: number };
        };
        return {
          ok: false,
          status: response.status,
          retryAfter: body.parameters?.retry_after,
          error: body.description ?? `HTTP ${response.status}`,
        };
      }

      const body = (await response.json()) as { result?: { message_id?: number } };
      return { ok: true, messageId: String(body.result?.message_id ?? "") };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  };
}

/** Marks a failed delivery for another attempt from the UI. */
export function retryDelivery(handle: DbHandle, deliveryId: string, now = new Date()): boolean {
  const row = handle.db.select().from(deliveries).where(eq(deliveries.id, deliveryId)).get();
  if (!row || row.state !== "failed") return false;

  handle.db
    .update(deliveries)
    .set({ state: "pending", attempts: 0, nextAttemptAt: now, lastError: null })
    .where(eq(deliveries.id, deliveryId))
    .run();
  return true;
}
