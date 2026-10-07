import type { FetchedArticle, SourceAdapter } from "./adapter.ts";
import { applyResolvedUrl, parseGoogleNewsFeed, toFetchedArticle } from "./google-news.ts";
import { resolveGoogleNewsUrl } from "./google-news-resolver.ts";
import { fetchWithRetry } from "./http.ts";

/**
 * Google News is a discovery channel, not an outlet: the publisher is stored
 * separately and the original URL is resolved when possible. Unresolved items
 * keep the Google URL and are flagged, so they never count as an independent
 * outlet on their own.
 */

const FEED_URL = "https://news.google.com/rss/search";

export const QUERIES = ["artificial intelligence", "semiconductor", "LLM"];

/** Bounds the extra two requests per article the resolver needs. */
const DEFAULT_PER_QUERY_LIMIT = 30;
const DEFAULT_MAX_RESOLVE = 40;
const RESOLVE_CONCURRENCY = 4;

export type GoogleNewsOptions = {
  fetch: typeof globalThis.fetch;
  queries?: string[];
  /** Most recent items kept per query. Bounds a run before relevance filtering. */
  perQueryLimit?: number;
  /** Total resolutions attempted per run (each costs two requests). */
  maxResolve?: number;
};

export function buildFeedUrl(query: string): string {
  const params = new URLSearchParams({
    q: query,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });
  return `${FEED_URL}?${params.toString()}`;
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

export function createGoogleNewsAdapter(options: GoogleNewsOptions): SourceAdapter {
  const {
    fetch,
    queries = QUERIES,
    perQueryLimit = DEFAULT_PER_QUERY_LIMIT,
    maxResolve = DEFAULT_MAX_RESOLVE,
  } = options;

  return {
    key: "google-news",
    fetch: async (signal) => {
      const warnings: string[] = [];
      const results = await Promise.allSettled(
        queries.map(async (query) => {
          const response = await fetchWithRetry(buildFeedUrl(query), { fetch, signal });
          if (!response.ok) throw new Error(`Google News returned ${response.status}`);
          return parseGoogleNewsFeed(await response.text());
        }),
      );

      let failedQueries = 0;
      const entries = results.flatMap((result, index) => {
        if (result.status === "fulfilled") return result.value;
        failedQueries += 1;
        warnings.push(`query "${queries[index]}" failed: ${String(result.reason)}`);
        return [];
      });

      // De-duplicate across queries by the Google guid.
      const seen = new Set<string>();
      const unique = entries.filter((entry) => {
        if (seen.has(entry.externalId)) return false;
        seen.add(entry.externalId);
        return true;
      });

      // Newest first, then cap: resolution costs two requests per article and
      // the feed can return hundreds of items per query.
      const ordered = [...unique].sort(
        (a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
      );
      const selected = ordered.slice(0, perQueryLimit * queries.length);
      const toResolve = selected.slice(0, maxResolve);

      const resolvedUrls = new Map<string, string | null>();
      const failures: string[] = [];
      await mapWithConcurrency(toResolve, RESOLVE_CONCURRENCY, async (entry) => {
        try {
          resolvedUrls.set(
            entry.externalId,
            await resolveGoogleNewsUrl(entry.googleUrl, { fetch, signal }),
          );
        } catch (error) {
          resolvedUrls.set(entry.externalId, null);
          failures.push(`${entry.externalId}: ${String(error)}`);
        }
      });

      const articles: FetchedArticle[] = selected.map((entry) => {
        const attempted = resolvedUrls.has(entry.externalId);
        const resolved = resolvedUrls.get(entry.externalId) ?? null;
        return toFetchedArticle(applyResolvedUrl(entry, resolved, { attempted }));
      });

      if (failures.length > 0) {
        warnings.push(`${failures.length} resolutions errored, e.g. ${failures[0]}`);
      }
      const failed = articles.filter(
        (article) => article.unresolved && article.resolveAttempted,
      ).length;
      if (failed > 0) {
        warnings.push(`${failed} of ${toResolve.length} attempted resolutions failed`);
      }

      return { articles, warnings, failed: failedQueries === queries.length && queries.length > 0 };
    },
  };
}
