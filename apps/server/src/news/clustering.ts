import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import type { DbHandle } from "../db/connection.ts";
import { newId } from "../db/ids.ts";
import { articles, events } from "../db/schema.ts";
import type { ModelClient } from "../insights/model.ts";
import { createRecallIndex, RECALL_MIN_RATIO, type RecallIndex } from "./recall.ts";
import { isReprint } from "./similarity.ts";

/**
 * Event clustering: merge multi-source coverage of the same concrete event,
 * while preferring a missed merge over a wrong one.
 *
 * 1. Candidates: events with an article in the last 72 hours, recalled by an
 *    FTS5 index (see recall.ts) so paraphrases are found without a synonym
 *    table.
 * 2. Direct: no candidate -> new event. A single candidate whose title is a
 *    near-exact reprint -> attached without the model.
 * 3. Otherwise the model decides, restricted to the candidate set; an id
 *    outside that set is treated as "new".
 *
 * The 72-hour window is a deliberate bound: it keeps the candidate set small
 * and accepts that a long-dormant event starts a new one.
 */

const CANDIDATE_WINDOW_HOURS = 72;
const CANDIDATE_THRESHOLD = RECALL_MIN_RATIO;
const MAX_CANDIDATES = 5;
const MODEL_BATCH_SIZE = 20;

const ADJUDICATE_SYSTEM = `You group news articles that report the same specific real-world event.
You are given one new article and a numbered list of existing events, each with example headlines.
Decide whether the new article covers the same specific happening as one of the events.
Same company, same topic, or same industry is NOT enough: it must be the same concrete event
(the same announcement, the same deal, the same incident).
Respond with JSON only: {"index": <event number>} or {"index": -1} for a new event.`;

export type ClusterDeps = {
  handle: DbHandle;
  model: ModelClient;
  signal: AbortSignal;
  /** Caps model adjudication batches per run. */
  maxModelBatches?: number;
};

export type ClusterResult = {
  newEvents: number;
  attachedToExisting: number;
  deferred: number;
  /** Events an article was attached to (created or grown) in this run. */
  touchedEventIds: string[];
};

type CandidateEvent = { id: string; title: string; titles: string[] };

export async function runClustering({
  handle,
  model,
  signal,
  maxModelBatches = 4,
}: ClusterDeps): Promise<ClusterResult> {
  const result: ClusterResult = {
    newEvents: 0,
    attachedToExisting: 0,
    deferred: 0,
    touchedEventIds: [],
  };
  const touched = new Set<string>();

  // Oldest first so an event established earlier in the run can absorb later
  // reprints, and so published order drives grouping.
  const pending = handle.db
    .select()
    .from(articles)
    .where(and(eq(articles.relevance, "relevant"), isNull(articles.eventId)))
    .all()
    .sort((a, b) => {
      const left = (a.publishedAt ?? a.discoveredAt).getTime();
      const right = (b.publishedAt ?? b.discoveredAt).getTime();
      return left - right;
    });

  if (pending.length === 0) return result;

  let modelBatches = 0;
  const undecided: { articleId: string; candidates: CandidateEvent[] }[] = [];

  // One index per run, seeded with every event active in the window and then
  // extended as this run creates or grows events, so a paraphrase published
  // later in the same pass can still see them.
  const known = loadCandidates(handle, "");
  const index = createRecallIndex(known);
  const byId = new Map(known.map((candidate) => [candidate.id, candidate]));

  try {
    for (const article of pending) {
      if (signal.aborted) break;

      const ranked = index
        .rank(article.title, { limit: MAX_CANDIDATES, minRatio: CANDIDATE_THRESHOLD })
        .map((hit) => byId.get(hit.id))
        .filter((candidate): candidate is CandidateEvent => candidate !== undefined);

      if (ranked.length === 0) {
        const created = attachToNewEvent(handle, article.id, article.title);
        registerEvent(index, byId, created);
        touched.add(created.id);
        result.newEvents += 1;
        continue;
      }

      // A near-exact reprint skips the model; anything less waits for it.
      if (
        ranked.length === 1 &&
        ranked[0]!.titles.some((title) => isReprint(article.title, title))
      ) {
        const eventId = attachToEvent(handle, article.id, ranked[0]!.id, article.title);
        index.add({ id: eventId, titles: [article.title] });
        touched.add(eventId);
        result.attachedToExisting += 1;
        continue;
      }

      undecided.push({ articleId: article.id, candidates: ranked });
    }

    if (undecided.length === 0 || !model.available) {
      result.deferred += undecided.length;
      result.touchedEventIds = [...touched];
      return result;
    }

    const batches = Math.min(Math.ceil(undecided.length / MODEL_BATCH_SIZE), maxModelBatches);
    for (let index_ = 0; index_ < batches; index_ += 1) {
      if (signal.aborted) break;
      const batch = undecided.slice(index_ * MODEL_BATCH_SIZE, (index_ + 1) * MODEL_BATCH_SIZE);
      modelBatches += 1;

      try {
        const decisions = await adjudicateBatch(handle, model, batch, signal);
        for (const [position, entry] of batch.entries()) {
          const chosen = decisions.get(position);
          const article = handle.db
            .select()
            .from(articles)
            .where(eq(articles.id, entry.articleId))
            .get();
          if (!article) continue;

          const target = chosen === undefined ? undefined : entry.candidates[chosen];
          if (target) {
            const eventId = attachToEvent(handle, article.id, target.id, article.title);
            index.add({ id: eventId, titles: [article.title] });
            touched.add(eventId);
            result.attachedToExisting += 1;
          } else {
            // "new" is also the fallback for an out-of-range answer.
            const created = attachToNewEvent(handle, article.id, article.title);
            registerEvent(index, byId, created);
            touched.add(created.id);
            result.newEvents += 1;
          }
        }
      } catch {
        // Any model failure defers this batch rather than aborting the run.
        result.deferred += batch.length;
        continue;
      }
    }

    result.deferred += Math.max(0, undecided.length - modelBatches * MODEL_BATCH_SIZE);
    result.touchedEventIds = [...touched];
    return result;
  } finally {
    index.close();
  }
}

/** Events with activity in the window, each with the titles of its articles. */
export function loadCandidates(handle: DbHandle, excludeArticleId: string): CandidateEvent[] {
  const since = new Date(Date.now() - CANDIDATE_WINDOW_HOURS * 60 * 60 * 1000);
  const recent = handle.db
    .select({ id: events.id, title: events.title })
    .from(events)
    .where(gte(events.lastArticleAt, since))
    .orderBy(desc(events.lastArticleAt))
    .limit(400)
    .all();

  if (recent.length === 0) return [];

  const titlesByEvent = new Map<string, string[]>();
  const rows = handle.db
    .select({ eventId: articles.eventId, title: articles.title })
    .from(articles)
    .where(
      inArray(
        articles.eventId,
        recent.map((event) => event.id),
      ),
    )
    .all();

  for (const row of rows) {
    if (!row.eventId) continue;
    const list = titlesByEvent.get(row.eventId) ?? [];
    list.push(row.title);
    titlesByEvent.set(row.eventId, list);
  }

  void excludeArticleId;
  return recent.map((event) => ({
    id: event.id,
    title: event.title,
    titles: titlesByEvent.get(event.id) ?? [event.title],
  }));
}

async function adjudicateBatch(
  handle: DbHandle,
  model: ModelClient,
  batch: { articleId: string; candidates: CandidateEvent[] }[],
  signal: AbortSignal,
): Promise<Map<number, number>> {
  const decisions = new Map<number, number>();

  for (const [position, entry] of batch.entries()) {
    const article = handle.db.select().from(articles).where(eq(articles.id, entry.articleId)).get();
    if (!article) continue;

    const candidateListing = entry.candidates
      .map((candidate, index) => {
        const examples = candidate.titles
          .slice(0, 3)
          .map((title) => `    - ${title}`)
          .join("\n");
        return `${index}. ${candidate.title}\n${examples}`;
      })
      .join("\n");

    const content = await model.complete({
      signal,
      temperature: 0,
      // The answer itself is tiny ({"index": n}), but a reasoning model spends
      // most of the budget reasoning first; 64 truncated before any output.
      maxTokens: 1024,
      messages: [
        { role: "system", content: ADJUDICATE_SYSTEM },
        {
          role: "user",
          content: `New article: ${article.title}${
            article.excerpt ? `\nExcerpt: ${article.excerpt.slice(0, 300)}` : ""
          }\n\nExisting events:\n${candidateListing}`,
        },
      ],
    });

    const decision = parseDecision(content, entry.candidates.length);
    if (decision !== null) decisions.set(position, decision);
  }

  return decisions;
}

/** Returns the chosen candidate index, or -1 for a new event; null when unusable. */
export function parseDecision(content: string, candidateCount: number): number | null {
  const match = /\{\s*"index"\s*:\s*(-?\d+)\s*\}/.exec(content);
  if (!match) return null;
  const index = Number(match[1]);
  if (index === -1) return -1;
  if (!Number.isInteger(index) || index < 0 || index >= candidateCount) return -1;
  return index;
}

function attachToNewEvent(handle: DbHandle, articleId: string, title: string): CandidateEvent {
  const now = new Date();
  const eventId = newId();
  const article = handle.db.select().from(articles).where(eq(articles.id, articleId)).get();

  // effective_time = coalesce(min(published_at), first_seen_at). A fresh event
  // takes the article's own publication time, not the moment we noticed it, so
  // an article published hours ago is not treated as brand new.
  const effectiveTime = article?.publishedAt ?? now;

  handle.db
    .insert(events)
    .values({
      id: eventId,
      title,
      topics: [],
      kind: article?.kind ?? "news",
      firstSeenAt: now,
      lastArticleAt: now,
      effectiveTime,
      hotScore: 0,
      analysisState: "pending",
      notificationRevision: 0,
      notifiedRevision: 0,
      updatedAt: now,
    })
    .run();
  handle.db.update(articles).set({ eventId }).where(eq(articles.id, articleId)).run();
  return { id: eventId, title, titles: [title] };
}

/** Keeps the recall index in step when a run creates an event. */
function registerEvent(
  index: RecallIndex,
  byId: Map<string, CandidateEvent>,
  event: CandidateEvent,
): void {
  index.add({ id: event.id, titles: event.titles });
  byId.set(event.id, event);
}

function attachToEvent(
  handle: DbHandle,
  articleId: string,
  eventId: string,
  title: string,
): string {
  const article = handle.db.select().from(articles).where(eq(articles.id, articleId)).get();
  const now = new Date();
  const published = article?.publishedAt;

  const event = handle.db.select().from(events).where(eq(events.id, eventId)).get();
  if (!event) {
    return attachToNewEvent(handle, articleId, title).id;
  }

  handle.db.update(articles).set({ eventId }).where(eq(articles.id, articleId)).run();

  // An event is a paper only while every article in it is a paper; a news
  // article joining a preprint event promotes it to news.
  const kind = event.kind === "paper" && article?.kind !== "paper" ? "news" : event.kind;

  handle.db
    .update(events)
    .set({
      lastArticleAt: now,
      // effective_time keeps the earliest signal seen so far.
      effectiveTime: published && published < event.effectiveTime ? published : event.effectiveTime,
      kind,
      // Evidence changed, so any existing insight is stale. A skipped event
      // (arXiv-only) becomes pending as soon as an analyzable article joins;
      // analysis re-decides skip vs. analyze from the current evidence.
      analysisState: "pending",
      updatedAt: now,
    })
    .where(eq(events.id, eventId))
    .run();

  return eventId;
}
