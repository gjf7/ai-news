import { eq, gte } from "drizzle-orm";
import { TAG_IDS } from "@ai-news/contracts";
import type { DbHandle } from "../db/connection.ts";
import { events, insights } from "../db/schema.ts";
import { keywordTags, normalizeTags, parseTagJson } from "./tags.ts";

/**
 * Hotness and topics.
 *
 * Hotness answers "what is being discussed right now". The weights are product
 * parameters, not an objective measure: recency 30%, distinct publishers 25%,
 * normalized community score 45%. Topic match is not part of the score because
 * the feed is already filtered to AI and semiconductors, so it would add a
 * nearly constant 30% to every event. `importance` (from the model) is the
 * separate "does this matter" signal.
 *
 * Recency decays with time, so a stored score goes stale even when nothing
 * about the event changes. `refreshEventScores` is therefore run for the recent
 * window on every refresh, not only for events that received a new article.
 */
export const HOT_SCORE_WEIGHTS = {
  recency: 0.3,
  publishers: 0.25,
  community: 0.45,
} as const;

const RECENCY_HALF_LIFE_HOURS = 18;

/** Events this old are already near the bottom of the decay curve. */
export const RESCORE_WINDOW_HOURS = 7 * 24;

export type HotScoreInput = {
  effectiveTime: Date;
  publisherCount: number;
  /** Raw community scores paired with the source they came from. */
  communityScores: { source: string; score: number }[];
  now?: Date;
};

export function computeHotScore({
  effectiveTime,
  publisherCount,
  communityScores,
  now = new Date(),
}: HotScoreInput): number {
  const ageHours = Math.max(0, (now.getTime() - effectiveTime.getTime()) / 3_600_000);
  const recency = Math.pow(0.5, ageHours / RECENCY_HALF_LIFE_HOURS);

  // Three or more independent outlets is treated as fully corroborated.
  const publishers = Math.min(1, publisherCount / 3);

  const community = normalizeCommunity(communityScores);

  const score =
    recency * HOT_SCORE_WEIGHTS.recency +
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
 * not an objective measure.
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

/**
 * Events that still have meaningful recency: everything inside the rescore
 * window. The runner unions this with the events it touched, because an older
 * event can receive a new article and must be scored too.
 */
export function recentEventIds(handle: DbHandle, now = new Date()): string[] {
  const since = new Date(now.getTime() - RESCORE_WINDOW_HOURS * 3_600_000);
  return handle.db
    .select({ id: events.id })
    .from(events)
    .where(gte(events.effectiveTime, since))
    .all()
    .map((row) => row.id);
}

/** Recomputes topics and hot score for the given events. */
export function refreshEventScores(handle: DbHandle, eventIds: string[], now = new Date()): void {
  for (const eventId of eventIds) {
    const event = handle.db.select().from(events).where(eq(events.id, eventId)).get();
    if (!event) continue;

    const rows = handle.sqlite
      .prepare(
        `SELECT a.title AS title, a.excerpt AS excerpt, a.topics AS topics,
                a.publisher AS publisher,
                a.community_score AS communityScore, s.key AS sourceKey
         FROM articles a
         LEFT JOIN article_sources asrc ON asrc.article_id = a.id
         LEFT JOIN sources s ON s.id = asrc.source_id
         WHERE a.event_id = ?`,
      )
      .all(eventId) as {
      title: string;
      excerpt: string | null;
      topics: string | null;
      publisher: string;
      communityScore: number | null;
      sourceKey: string | null;
    }[];

    if (rows.length === 0) continue;

    const topics = new Set<string>();
    for (const row of rows) {
      // Articles classified before article-level tagging existed have no tags;
      // fall back to the title so a rescore does not regress them to nothing.
      const articleTags = parseTagJson(row.topics);
      for (const tag of articleTags.length > 0
        ? articleTags
        : keywordTags(row.title, row.excerpt)) {
        topics.add(tag);
      }
    }

    // The insight sees the whole event, so its tags refine the per-article
    // keyword tags. They live in the insight output and are unioned here;
    // nothing has to be backfilled into the article rows.
    const insight = event.latestInsightId
      ? handle.db
          .select({ output: insights.output })
          .from(insights)
          .where(eq(insights.id, event.latestInsightId))
          .get()
      : undefined;
    for (const tag of normalizeTags((insight?.output as { tags?: unknown } | null)?.tags)) {
      topics.add(tag);
    }

    const publishers = new Set(rows.map((row) => row.publisher));
    const hotScore = computeHotScore({
      effectiveTime: event.effectiveTime,
      publisherCount: publishers.size,
      // Keep the originating source so community heat can be normalized
      // within each channel rather than across incomparable scales.
      communityScores: rows.flatMap((row) =>
        row.communityScore === null
          ? []
          : [{ source: row.sourceKey ?? row.publisher, score: row.communityScore }],
      ),
      now,
    });

    handle.db
      .update(events)
      // Registry order keeps badges stable and puts the broad beat first.
      .set({ topics: TAG_IDS.filter((id) => topics.has(id)), hotScore })
      .where(eq(events.id, eventId))
      .run();
  }
}
