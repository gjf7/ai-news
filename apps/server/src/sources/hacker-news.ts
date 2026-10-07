import type { FetchedArticle, SourceAdapter } from "./adapter.ts";
import { fetchWithRetry } from "./http.ts";

/**
 * Hacker News via the Algolia search API. The official Firebase API is
 * per-item and would need one request per story; Algolia returns fresh stories
 * for a keyword in a single request.
 *
 * HN items have no excerpt, so their scope is headline-only. "Ask HN" /
 * "Show HN" posts have no external URL and link to the discussion thread.
 */

const SEARCH_URL = "https://hn.algolia.com/api/v1/search_by_date";

export type HnHit = {
  objectID?: string;
  title?: string;
  url?: string | null;
  points?: number | null;
  created_at_i?: number | null;
};

export function parseHackerNewsHits(hits: HnHit[]): FetchedArticle[] {
  return hits.flatMap((hit): FetchedArticle[] => {
    const title = hit.title?.trim();
    if (!title || !hit.objectID) return [];

    const url = hit.url?.trim() || `https://news.ycombinator.com/item?id=${hit.objectID}`;
    const created = hit.created_at_i ? new Date(hit.created_at_i * 1000) : null;

    return [
      {
        externalId: hit.objectID,
        url,
        title,
        publisher: "Hacker News",
        publishedAt: created && !Number.isNaN(created.getTime()) ? created : null,
        excerpt: null,
        kind: "discussion",
        communityScore: hit.points ?? null,
      },
    ];
  });
}

export const QUERIES = ["AI", "LLM", "semiconductor"];

export type HackerNewsOptions = {
  fetch: typeof globalThis.fetch;
  queries?: string[];
  hitsPerPage?: number;
};

export async function fetchHackerNews(
  signal: AbortSignal,
  { fetch, queries = QUERIES, hitsPerPage = 30 }: HackerNewsOptions,
): Promise<{ articles: FetchedArticle[]; warnings: string[]; failed: boolean }> {
  const warnings: string[] = [];
  const results = await Promise.allSettled(
    queries.map(async (query) => {
      const url = `${SEARCH_URL}?tags=story&hitsPerPage=${hitsPerPage}&query=${encodeURIComponent(query)}`;
      const response = await fetchWithRetry(url, { fetch, signal });
      if (!response.ok) throw new Error(`HN Algolia returned ${response.status}`);
      const data = (await response.json()) as { hits?: HnHit[] };
      return parseHackerNewsHits(data.hits ?? []);
    }),
  );

  const articles: FetchedArticle[] = [];
  let failedQueries = 0;
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      articles.push(...result.value);
    } else {
      failedQueries += 1;
      warnings.push(`query "${queries[index]}" failed: ${String(result.reason)}`);
    }
  });

  return { articles, warnings, failed: failedQueries === queries.length && queries.length > 0 };
}

export function createHackerNewsAdapter(options: HackerNewsOptions): SourceAdapter {
  return {
    key: "hacker-news",
    fetch: async (signal) => fetchHackerNews(signal, options),
  };
}
