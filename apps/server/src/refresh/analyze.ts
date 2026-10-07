import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbHandle } from "../db/connection.ts";
import { newId } from "../db/ids.ts";
import { articleSources, articles, events, insights, sources } from "../db/schema.ts";
import type { ModelClient } from "../insights/model.ts";
import {
  buildPrompt,
  computeInputHash,
  parseInsightOutput,
  PROMPT_VERSION,
  selectEvidence,
  shouldBumpNotificationRevision,
  type EvidenceArticle,
} from "../insights/insight.ts";

/**
 * Analysis and publishing.
 *
 * Each insight is published in its own transaction, so it becomes visible
 * immediately rather than waiting for the whole run. The notification revision
 * is bumped in that same transaction, and only when this insight genuinely
 * advances the event (see shouldBumpNotificationRevision).
 */

const DEFAULT_MAX_EVENTS = 40;

export type AnalyzeDeps = {
  handle: DbHandle;
  model: ModelClient;
  runId: string;
  signal: AbortSignal;
  maxEvents?: number;
};

export type AnalyzeResult = {
  analyzed: number;
  reused: number;
  skipped: number;
  failed: number;
  deferred: number;
  /** Events whose notification revision increased in this run. */
  bumped: string[];
};

export async function runAnalysis({
  handle,
  model,
  runId,
  signal,
  maxEvents = DEFAULT_MAX_EVENTS,
}: AnalyzeDeps): Promise<AnalyzeResult> {
  const result: AnalyzeResult = {
    analyzed: 0,
    reused: 0,
    skipped: 0,
    failed: 0,
    deferred: 0,
    bumped: [],
  };

  const candidates = handle.db
    .select()
    .from(events)
    .where(inArray(events.analysisState, ["pending", "failed"]))
    .orderBy(desc(events.hotScore), desc(events.updatedAt))
    .all();

  if (candidates.length === 0) return result;

  // Events built only from sources that opt out of analysis (arXiv) are
  // skipped: they show title and abstract, cost no model calls, and never
  // notify. If a analysable source later joins, clustering resets them to
  // pending. See decisions.md D13.
  const skippedIds: string[] = [];
  const analyzable: typeof candidates = [];
  for (const event of candidates) {
    if (eventArticles(handle, event.id).every((article) => !article.analyze)) {
      skippedIds.push(event.id);
    } else {
      analyzable.push(event);
    }
  }

  for (const id of skippedIds) {
    handle.db
      .update(events)
      .set({ analysisState: "skipped", analysisRunId: runId })
      .where(eq(events.id, id))
      .run();
    result.skipped += 1;
  }

  const batch = analyzable.slice(0, maxEvents);
  result.deferred += analyzable.length - batch.length;

  if (!model.available) {
    result.deferred += batch.length;
    return result;
  }

  for (const event of batch) {
    if (signal.aborted) break;

    const evidence = selectEvidence(
      eventArticles(handle, event.id).map((article): EvidenceArticle => ({
        id: article.id,
        title: article.title,
        excerpt: article.excerpt,
        publisher: article.publisher,
        scope: article.scope,
        publishedAt: article.publishedAt,
      })),
    );

    const inputHash = computeInputHash(evidence, { model: model.name });

    const existing = handle.db
      .select()
      .from(insights)
      .where(and(eq(insights.eventId, event.id), eq(insights.inputHash, inputHash)))
      .get();

    if (existing) {
      // Same evidence, same model, same prompt: reuse without calling the model.
      publishPointer(handle, event.id, existing.id, event.importance, existing.output as never);
      handle.db
        .update(events)
        .set({ analysisState: "ok", analysisRunId: runId })
        .where(eq(events.id, event.id))
        .run();
      result.reused += 1;
      continue;
    }

    const previous = latestInsight(handle, event.id);
    const previousArticleIds = previous ? evidenceIdsOf(previous.evidence) : [];

    const prompt = buildPrompt({
      eventTitle: event.title,
      evidence,
      previousArticleIds,
    });

    try {
      const content = await model.complete({
        signal,
        temperature: 0.2,
        // Generous headroom: a reasoning model spends part of this budget on its
        // reasoning tokens before writing the JSON answer.
        maxTokens: 8000,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      });

      const parsed = parseInsightOutput(content, evidence);
      if (!parsed.ok) {
        markFailed(handle, event.id, runId, parsed.reason);
        result.failed += 1;
        continue;
      }

      const evidenceArticleIds = evidence.articles.map((article) => article.id);
      const bump = shouldBumpNotificationRevision({
        previousInsightExists: Boolean(previous),
        output: parsed.output,
        evidenceArticleIds,
        previousArticleIds,
      });

      publishInsight({
        handle,
        eventId: event.id,
        runId,
        inputHash,
        model: model.name,
        evidence,
        output: parsed.output,
        bump,
      });

      if (bump) result.bumped.push(event.id);
      result.analyzed += 1;
    } catch (error) {
      // The model is an external dependency: a failure marks this event failed
      // and the run continues with the remaining events.
      markFailed(handle, event.id, runId, String(error));
      result.failed += 1;
    }
  }

  return result;
}

type EventArticle = {
  id: string;
  title: string;
  excerpt: string | null;
  publisher: string;
  scope: string;
  publishedAt: Date | null;
  analyze: boolean;
};

/** Articles of an event, joined with whether their source wants insights. */
function eventArticles(handle: DbHandle, eventId: string): EventArticle[] {
  const rows = handle.db
    .select({
      id: articles.id,
      title: articles.title,
      excerpt: articles.excerpt,
      publisher: articles.publisher,
      scope: articles.scope,
      publishedAt: articles.publishedAt,
      analyze: sources.analyze,
    })
    .from(articles)
    .leftJoin(articleSources, eq(articleSources.articleId, articles.id))
    .leftJoin(sources, eq(sources.id, articleSources.sourceId))
    .where(eq(articles.eventId, eventId))
    .all();

  // An article discovered via several sources yields several rows; keep one,
  // treating it as analyzable if any of its sources wants insights.
  const byId = new Map<string, EventArticle>();
  for (const row of rows) {
    const existing = byId.get(row.id);
    const analyze = Boolean(row.analyze);
    if (!existing) {
      byId.set(row.id, { ...row, analyze });
    } else if (analyze && !existing.analyze) {
      existing.analyze = true;
    }
  }
  return [...byId.values()];
}

function latestInsight(handle: DbHandle, eventId: string) {
  return handle.db
    .select()
    .from(insights)
    .where(eq(insights.eventId, eventId))
    .orderBy(desc(insights.createdAt))
    .limit(1)
    .get();
}

function evidenceIdsOf(evidence: unknown): string[] {
  if (!Array.isArray(evidence)) return [];
  return evidence.flatMap((entry) =>
    typeof entry === "object" && entry !== null && "id" in entry
      ? [String((entry as { id: unknown }).id)]
      : [],
  );
}

type PublishArgs = {
  handle: DbHandle;
  eventId: string;
  runId: string;
  inputHash: string;
  model: string;
  evidence: ReturnType<typeof selectEvidence>;
  output: { importance: { score: number } };
  bump: boolean;
};

/**
 * Writes the insight and updates the event in one transaction. The revision
 * bump is conditional: a crash-and-rerun of the same evidence reuses the
 * existing insight above and never bumps twice.
 */
function publishInsight({
  handle,
  eventId,
  runId,
  inputHash,
  model,
  evidence,
  output,
  bump,
}: PublishArgs): void {
  const now = new Date();
  const insightId = newId();

  handle.sqlite.transaction(() => {
    const event = handle.db.select().from(events).where(eq(events.id, eventId)).get();
    if (!event) return;

    const revision = bump ? event.notificationRevision + 1 : event.notificationRevision;

    handle.db
      .insert(insights)
      .values({
        id: insightId,
        eventId,
        inputHash,
        model,
        promptVersion: PROMPT_VERSION,
        scope: evidence.scope,
        output: output as never,
        evidence: evidence.articles as never,
        revision,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();

    const stored = handle.db
      .select({ id: insights.id })
      .from(insights)
      .where(and(eq(insights.eventId, eventId), eq(insights.inputHash, inputHash)))
      .get();

    handle.db
      .update(events)
      .set({
        latestInsightId: stored?.id ?? insightId,
        importance: output.importance.score,
        analysisState: "ok",
        analysisError: null,
        analysisRunId: runId,
        notificationRevision: revision,
        revisionBumpedRunId: bump ? runId : event.revisionBumpedRunId,
        updatedAt: now,
      })
      .where(eq(events.id, eventId))
      .run();
  })();
}

/** Re-points the event at an already stored insight without changing revisions. */
function publishPointer(
  handle: DbHandle,
  eventId: string,
  insightId: string,
  importance: number | null,
  output: { importance?: { score?: number } } | null,
): void {
  const now = new Date();
  const score =
    typeof output?.importance?.score === "number" ? output.importance.score : (importance ?? null);

  handle.db
    .update(events)
    .set({ latestInsightId: insightId, importance: score, updatedAt: now })
    .where(eq(events.id, eventId))
    .run();
}

function markFailed(handle: DbHandle, eventId: string, runId: string, error: string): void {
  handle.db
    .update(events)
    .set({ analysisState: "failed", analysisError: error.slice(0, 500), analysisRunId: runId })
    .where(eq(events.id, eventId))
    .run();
}
