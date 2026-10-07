import { and, eq, inArray } from "drizzle-orm";
import type { DbHandle } from "../db/connection.ts";
import { articleIdFromUrl, newId } from "../db/ids.ts";
import { articleSources, articles, refreshRuns, sourceRuns, sources } from "../db/schema.ts";
import { normalizeTitle } from "../sources/url.ts";
import type { FetchedArticle } from "../sources/adapter.ts";
import type { SourceDefinition } from "../sources/registry.ts";

/**
 * Collecting stage: fetch every enabled source, persist its articles, and
 * record a per-source checkpoint.
 *
 * The checkpoint is what makes a resumed run skip completed sources, so the
 * article upsert and the completion row commit in the same transaction. Every
 * write is also guarded by (runId, attempt, state) so a superseded execution
 * cannot commit stale results.
 */

/** Keeps the `sources` table in step with the code registry. */
export function syncSources(handle: DbHandle, definitions: SourceDefinition[]): void {
  const now = Date.now();
  const existing = new Set(
    handle.db
      .select({ key: sources.key })
      .from(sources)
      .all()
      .map((row) => row.key),
  );

  for (const definition of definitions) {
    if (existing.has(definition.key)) {
      handle.db
        .update(sources)
        .set({ adapter: definition.key, analyze: definition.analyze })
        .where(eq(sources.key, definition.key))
        .run();
      continue;
    }
    handle.db
      .insert(sources)
      .values({
        id: newId(),
        key: definition.key,
        adapter: definition.key,
        config: {},
        enabled: true,
        defaultTopics: definition.topics,
        analyze: definition.analyze,
        status: "unknown",
        createdAt: new Date(now),
      })
      .run();
  }
}

export type IngestDeps = {
  handle: DbHandle;
  definitions: SourceDefinition[];
  runId: string;
  attempt: number;
  /** Checkpoint guard: writes are ignored once the run is no longer current. */
  isCurrent: () => boolean;
  concurrency?: number;
};

export type IngestResult = {
  newArticles: number;
  fetched: number;
  failedSources: number;
  warnings: string[];
};

/** Inserts the source_runs snapshot for this run. Existing rows are kept so a
 * resumed run continues where it stopped. */
export function beginSourceRuns(handle: DbHandle, runId: string): void {
  const enabled = handle.db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.enabled, true))
    .all();

  for (const source of enabled) {
    handle.db
      .insert(sourceRuns)
      .values({ runId, sourceId: source.id, state: "pending" })
      .onConflictDoNothing()
      .run();
  }
}

type SourceRow = { id: string; key: string; analyze: boolean };

export async function runIngest({
  handle,
  definitions,
  runId,
  attempt,
  isCurrent,
  concurrency = 4,
}: IngestDeps): Promise<IngestResult> {
  const rows = handle.db
    .select({ id: sources.id, key: sources.key, analyze: sources.analyze })
    .from(sources)
    .where(eq(sources.enabled, true))
    .all() as SourceRow[];

  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  const completed = new Set(
    handle.db
      .select({ sourceId: sourceRuns.sourceId })
      .from(sourceRuns)
      .where(and(eq(sourceRuns.runId, runId), eq(sourceRuns.state, "done")))
      .all()
      .map((row) => row.sourceId),
  );

  const pending = rows.filter((row) => !completed.has(row.id));
  const result: IngestResult = { newArticles: 0, fetched: 0, failedSources: 0, warnings: [] };

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (cursor < pending.length) {
      if (!isCurrent()) return;
      const row = pending[cursor++];
      if (!row) return;

      const definition = byKey.get(row.key);
      if (!definition) {
        recordSourceOutcome(handle, {
          runId,
          attempt,
          sourceId: row.id,
          state: "failed",
          error: "no adapter registered",
        });
        result.failedSources += 1;
        continue;
      }

      try {
        const outcome = await definition.adapter.fetch(AbortSignal.timeout(120_000));
        if (!isCurrent()) return;

        const failed = outcome.failed === true;
        // Article upsert and the checkpoint commit together, so a crash cannot
        // leave articles recorded without the source marked complete.
        const inserted = handle.sqlite.transaction(() => {
          const count = persistArticles(handle, row, outcome.articles);
          recordSourceOutcome(handle, {
            runId,
            attempt,
            sourceId: row.id,
            state: failed ? "failed" : "done",
            fetched: outcome.articles.length,
            newArticles: count,
            error: failed ? (outcome.warnings[0] ?? "fetch failed") : undefined,
          });
          return count;
        })();

        result.newArticles += inserted;
        result.fetched += outcome.articles.length;
        result.warnings.push(...outcome.warnings.map((warning) => `${row.key}: ${warning}`));
        if (failed) result.failedSources += 1;
      } catch (error) {
        handle.sqlite.transaction(() => {
          recordSourceOutcome(handle, {
            runId,
            attempt,
            sourceId: row.id,
            state: "failed",
            error: String(error),
          });
        })();
        result.failedSources += 1;
        result.warnings.push(`${row.key}: ${String(error)}`);
      }
    }
  });
  await Promise.all(workers);

  return result;
}

type Outcome = {
  runId: string;
  attempt: number;
  sourceId: string;
  state: "done" | "failed";
  fetched?: number;
  newArticles?: number;
  error?: string;
};

/**
 * Writes a source's terminal row, guarded by the run still being the current
 * attempt. Returns false when the write was ignored because the run was
 * superseded (a restart requeued it, or another attempt took over).
 */
export function recordSourceOutcome(handle: DbHandle, outcome: Outcome): boolean {
  const current = handle.db
    .select({ attempt: refreshRuns.attempt, state: refreshRuns.state })
    .from(refreshRuns)
    .where(eq(refreshRuns.id, outcome.runId))
    .get();
  if (current?.state !== "running" || current.attempt !== outcome.attempt) return false;

  const result = handle.db
    .update(sourceRuns)
    .set({
      state: outcome.state,
      fetched: outcome.fetched ?? 0,
      newArticles: outcome.newArticles ?? 0,
      error: outcome.error ?? null,
      finishedAt: new Date(),
    })
    .where(and(eq(sourceRuns.runId, outcome.runId), eq(sourceRuns.sourceId, outcome.sourceId)))
    .run();

  // The row must exist (beginSourceRuns created it). A zero-row update means
  // the snapshot is missing, which must not be reported as a successful write.
  if (result.changes === 0) return false;

  // The sources page shows why a source is unavailable, so the latest outcome
  // is mirrored onto the source row itself.
  handle.db
    .update(sources)
    .set({
      status: outcome.state === "done" ? "ok" : "error",
      statusReason: outcome.error ?? null,
    })
    .where(eq(sources.id, outcome.sourceId))
    .run();

  return true;
}

/**
 * Upserts fetched articles and their source links. An already-known article
 * keeps its classification; only the link is added.
 */
function persistArticles(handle: DbHandle, source: SourceRow, fetched: FetchedArticle[]): number {
  const now = new Date();
  let inserted = 0;

  for (const article of fetched) {
    const id = articleIdFromUrl(article.url);
    const existing = handle.db
      .select({ id: articles.id })
      .from(articles)
      .where(eq(articles.canonicalUrl, article.url))
      .get();

    if (!existing) {
      handle.db
        .insert(articles)
        .values({
          id,
          canonicalUrl: article.url,
          publisher: article.publisher,
          title: article.title,
          titleNorm: normalizeTitle(article.title),
          publishedAt: article.publishedAt,
          discoveredAt: now,
          scope: article.excerpt ? "excerpt" : "headline",
          excerpt: article.excerpt,
          relevance: "pending",
          topics: [],
          kind: article.kind,
          communityScore: article.communityScore,
        })
        .onConflictDoNothing()
        .run();
      inserted += 1;
    }

    handle.db
      .insert(articleSources)
      .values({
        articleId: existing?.id ?? id,
        sourceId: source.id,
        externalId: article.externalId,
        discoveryUrl: article.unresolved ? article.url : null,
      })
      .onConflictDoNothing()
      .run();
  }

  return inserted;
}

/** Sources that produced no articles and are stuck in pending (used by status). */
export function pendingSourceRuns(handle: DbHandle, runId: string) {
  return handle.db
    .select()
    .from(sourceRuns)
    .where(and(eq(sourceRuns.runId, runId), inArray(sourceRuns.state, ["pending"])))
    .all();
}
