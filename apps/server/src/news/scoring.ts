import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/connection.ts";
import { events } from "../db/schema.ts";
import { AI_TERMS, SEMICONDUCTOR_TERMS } from "./filtering.ts";

/**
 * Hotness and topics.
 *
 * The weights are product parameters, not an objective measure of importance:
 * recency 40%, topic relevance 30%, distinct publishers 20%, normalized
 * community score 10%. `importance` (from the model) is a separate signal used
 * for notification selection.
 */

export const HOT_SCORE_WEIGHTS = {
  recency: 0.4,
  topic: 0.3,
  publishers: 0.2,
  community: 0.1,
} as const;

const RECENCY_HALF_LIFE_HOURS = 18;

export type Topic = "ai" | "semiconductor";

export function topicsFor(title: string, excerpt: string | null): Topic[] {
  const text = `${title} ${excerpt ?? ""}`.toLowerCase();
  const topics: Topic[] = [];

  const has = (terms: string[]) =>
    terms.some((term) => {
      if (term.includes(" ") || term.includes("-")) return text.includes(term);
      return new RegExp(
        `(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
        "i",
      ).test(text);
    });

  if (has(AI_TERMS)) topics.push("ai");
  if (has(SEMICONDUCTOR_TERMS)) topics.push("semiconductor");
  return topics;
}

export type HotScoreInput = {
  effectiveTime: Date;
  topics: string[];
  publisherCount: number;
  /** Raw community scores paired with the source they came from. */
  communityScores: { source: string; score: number }[];
  now?: Date;
};

export function computeHotScore({
  effectiveTime,
  topics,
  publisherCount,
  communityScores,
  now = new Date(),
}: HotScoreInput): number {
  const ageHours = Math.max(0, (now.getTime() - effectiveTime.getTime()) / 3_600_000);
  const recency = Math.pow(0.5, ageHours / RECENCY_HALF_LIFE_HOURS);

  const topic = topics.length > 0 ? 1 : 0;

  // Three or more independent outlets is treated as fully corroborated.
  const publishers = Math.min(1, publisherCount / 3);

  const community = normalizeCommunity(communityScores);

  const score =
    recency * HOT_SCORE_WEIGHTS.recency +
    topic * HOT_SCORE_WEIGHTS.topic +
    publishers * HOT_SCORE_WEIGHTS.publishers +
    community * HOT_SCORE_WEIGHTS.community;

  return Math.round(score * 1000);
}

/**
 * Community heat normalized *within each source*.
 *
 * Raw points are not comparable between channels: 300 points on Hacker News
 * and 300 upvotes on a small subreddit mean very different things. Each score
 * is therefore expressed as a fraction of the points that count as "hot" for
 * that source, and the best article in the event wins.
 *
 * The reference scales are tunable product parameters, like the weights above,
 * not an objective measure. See todo.md for the calibration task.
 */
export const COMMUNITY_HOT_REFERENCE: Record<string, number> = {
  "hacker-news": 300,
  reddit: 200,
  lobsters: 50,
  "product-hunt": 300,
  // Default for a source not listed: treat 100 as hot.
  default: 100,
};

export function normalizeCommunity(scores: { source: string; score: number }[]): number {
  const valid = scores.filter((entry) => Number.isFinite(entry.score) && entry.score > 0);
  if (valid.length === 0) return 0;

  const best = Math.max(
    ...valid.map((entry) => {
      const reference = COMMUNITY_HOT_REFERENCE[entry.source] ?? COMMUNITY_HOT_REFERENCE.default;
      return Math.min(1, entry.score / reference);
    }),
  );

  return best;
}

/** Recomputes topics and hot score for the given events. */
export function refreshEventScores(handle: DbHandle, eventIds: string[]): void {
  for (const eventId of eventIds) {
    const event = handle.db.select().from(events).where(eq(events.id, eventId)).get();
    if (!event) continue;

    const rows = handle.sqlite
      .prepare(
        `SELECT a.title AS title, a.excerpt AS excerpt, a.publisher AS publisher,
                a.community_score AS communityScore, s.key AS sourceKey
         FROM articles a
         LEFT JOIN article_sources asrc ON asrc.article_id = a.id
         LEFT JOIN sources s ON s.id = asrc.source_id
         WHERE a.event_id = ?`,
      )
      .all(eventId) as {
      title: string;
      excerpt: string | null;
      publisher: string;
      communityScore: number | null;
      sourceKey: string | null;
    }[];

    if (rows.length === 0) continue;

    const topics = new Set<string>();
    for (const row of rows) {
      for (const topic of topicsFor(row.title, row.excerpt)) topics.add(topic);
    }

    const publishers = new Set(rows.map((row) => row.publisher));
    const hotScore = computeHotScore({
      effectiveTime: event.effectiveTime,
      topics: [...topics],
      publisherCount: publishers.size,
      // Keep the originating source so community heat can be normalized
      // within each channel rather than across incomparable scales.
      communityScores: rows.flatMap((row) =>
        row.communityScore === null
          ? []
          : [{ source: row.sourceKey ?? row.publisher, score: row.communityScore }],
      ),
    });

    handle.db
      .update(events)
      .set({ topics: [...topics], hotScore })
      .where(eq(events.id, eventId))
      .run();
  }
}

/** All event ids currently attached to an article, used to refresh scores. */
export function allEventIds(handle: DbHandle): string[] {
  const rows = handle.sqlite
    .prepare("SELECT DISTINCT event_id AS id FROM articles WHERE event_id IS NOT NULL")
    .all() as { id: string }[];
  return rows.map((row) => row.id);
}
