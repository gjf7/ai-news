import { XMLParser } from "fast-xml-parser";
import type { FetchedArticle, SourceAdapter } from "./adapter.ts";
import { fetchWithRetry } from "./http.ts";
import { canonicalizeUrl, toExcerpt } from "./url.ts";

/**
 * arXiv via the Atom query API. The daily RSS feeds are empty on weekends, so
 * the API (which always lists the latest submissions) is used instead.
 *
 * Papers get an excerpt (the abstract) but no insights: `analyze = false` for
 * this source, so the pipeline marks their events as skipped.
 */

const API_URL = "https://export.arxiv.org/api/query";

export const CATEGORIES = ["cs.AI", "cs.CL", "cs.LG"];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  isArray: (name) => name === "entry" || name === "author",
});

type ArxivEntry = {
  id?: string;
  title?: string;
  summary?: string;
  published?: string;
  updated?: string;
  link?: { "@_href"?: string; "@_rel"?: string; "@_type"?: string } | Array<{ "@_href"?: string }>;
};

function pickLink(link: ArxivEntry["link"]): string | undefined {
  if (!link) return undefined;
  if (Array.isArray(link)) {
    const alternate = link.find((candidate) => candidate["@_href"]);
    return alternate?.["@_href"];
  }
  return link["@_href"];
}

export function parseArxivFeed(xml: string): FetchedArticle[] {
  const parsed = parser.parse(xml) as { feed?: { entry?: ArxivEntry[] } };
  const entries = parsed.feed?.entry ?? [];

  return entries.flatMap((entry): FetchedArticle[] => {
    const title = entry.title?.replace(/\s+/g, " ").trim();
    const link = pickLink(entry.link)?.trim();
    if (!title || !link) return [];

    const published = entry.published ?? entry.updated;
    const date = published ? new Date(published) : null;

    return [
      {
        externalId: entry.id?.trim() ?? link,
        url: canonicalizeUrl(link),
        title,
        publisher: "arXiv",
        publishedAt: date && !Number.isNaN(date.getTime()) ? date : null,
        excerpt: toExcerpt(entry.summary),
        kind: "paper",
        communityScore: null,
      },
    ];
  });
}

export function buildArxivUrl(category: string, maxResults: number): string {
  const params = new URLSearchParams({
    search_query: `cat:${category}`,
    sortBy: "submittedDate",
    sortOrder: "descending",
    start: "0",
    max_results: String(maxResults),
  });
  return `${API_URL}?${params.toString()}`;
}

export type ArxivOptions = {
  fetch: typeof globalThis.fetch;
  categories?: string[];
  maxResults?: number;
};

export function createArxivAdapter(options: ArxivOptions): SourceAdapter {
  const { fetch, categories = CATEGORIES, maxResults = 12 } = options;

  return {
    key: "arxiv",
    fetch: async (signal) => {
      const warnings: string[] = [];
      const results = await Promise.allSettled(
        categories.map(async (category) => {
          const response = await fetchWithRetry(buildArxivUrl(category, maxResults), {
            fetch,
            signal,
          });
          if (!response.ok) throw new Error(`arXiv returned ${response.status}`);
          return parseArxivFeed(await response.text());
        }),
      );

      const articles = results.flatMap((result, index) => {
        if (result.status === "fulfilled") return result.value;
        warnings.push(`category ${categories[index]} failed: ${String(result.reason)}`);
        return [];
      });

      const failedCategories = results.filter((result) => result.status === "rejected").length;
      return {
        articles,
        warnings,
        failed: failedCategories === categories.length && categories.length > 0,
      };
    },
  };
}
