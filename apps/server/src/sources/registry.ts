import type { ArticleKind, SourceAdapter } from "./adapter.ts";
import { createArxivAdapter } from "./arxiv.ts";
import { FEED_SOURCES } from "./feeds.ts";
import { createGoogleNewsAdapter } from "./google-news-adapter.ts";
import { createHackerNewsAdapter } from "./hacker-news.ts";
import { createProductHuntAdapter } from "./product-hunt.ts";
import { fetchFeed } from "./rss.ts";

/**
 * Every known source. The database `sources` table decides which are enabled;
 * this registry only knows how to fetch them.
 *
 * Sources whose credentials are missing still appear, but fetch returns an
 * empty result plus a warning, so the sources page can explain why.
 */

export type SourceDefinition = {
  key: string;
  adapter: SourceAdapter;
  /** Sources that never generate insights (title + excerpt only). */
  analyze: boolean;
  topics: string[];
  /** Article kind this source produces. Community channels are discussions. */
  kind: ArticleKind;
  /** Credential required for the source to return anything. */
  requires?: "productHuntToken";
};

export type RegistryOptions = {
  fetch: typeof globalThis.fetch;
  productHuntToken?: string;
};

export function createSourceRegistry({
  fetch,
  productHuntToken,
}: RegistryOptions): SourceDefinition[] {
  const feedSources: SourceDefinition[] = Object.entries(FEED_SOURCES).map(([key, config]) => ({
    key,
    adapter: {
      key,
      fetch: (signal) => fetchFeed(signal, { fetch, config }),
    },
    analyze: true,
    topics: key === "reddit" || key === "lobsters" ? ["ai"] : [],
    kind: config.kind ?? "news",
  }));
  return [
    {
      key: "google-news",
      adapter: createGoogleNewsAdapter({ fetch }),
      analyze: true,
      topics: ["ai", "semiconductor"],
      kind: "news",
    },
    {
      key: "hacker-news",
      adapter: createHackerNewsAdapter({ fetch }),
      analyze: true,
      topics: ["ai"],
      kind: "discussion",
    },
    ...feedSources,
    {
      key: "arxiv",
      adapter: createArxivAdapter({ fetch }),
      // Papers show title + abstract only, never insights.
      analyze: false,
      topics: ["ai"],
      kind: "paper",
    },
    {
      key: "product-hunt",
      adapter: createProductHuntAdapter({ fetch, token: productHuntToken }),
      analyze: true,
      topics: ["ai"],
      kind: "news",
      requires: "productHuntToken",
    },
  ];
}

/** The source keys the registry knows how to fetch. */
export function registryKeys(options: RegistryOptions): string[] {
  return createSourceRegistry(options).map((definition) => definition.key);
}
