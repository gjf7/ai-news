import type { FetchedArticle, SourceAdapter } from "./adapter.ts";
import { fetchWithRetry } from "./http.ts";
import { canonicalizeUrl, toExcerpt } from "./url.ts";

/**
 * Product Hunt via its v2 GraphQL API. There is no public RSS and the API
 * requires a developer token, so this source is registered only when
 * PRODUCTHUNT_API_TOKEN is configured.
 */

const API_URL = "https://api.producthunt.com/v2/api/graphql";

const QUERY = `{
  posts(topic: "artificial-intelligence", order: NEWEST, first: 20) {
    edges {
      node { name tagline url createdAt votesCount }
    }
  }
}`;

export type ProductHuntPost = {
  name?: string;
  tagline?: string;
  url?: string;
  createdAt?: string;
  votesCount?: number;
};

export function parseProductHuntPosts(posts: ProductHuntPost[]): FetchedArticle[] {
  return posts.flatMap((post): FetchedArticle[] => {
    if (!post.name || !post.url) return [];
    const created = post.createdAt ? new Date(post.createdAt) : null;

    return [
      {
        externalId: post.url,
        url: canonicalizeUrl(post.url),
        title: post.name.trim(),
        publisher: "Product Hunt",
        publishedAt: created && !Number.isNaN(created.getTime()) ? created : null,
        excerpt: toExcerpt(post.tagline),
        kind: "news",
        communityScore: post.votesCount ?? null,
      },
    ];
  });
}

export type ProductHuntOptions = {
  fetch: typeof globalThis.fetch;
  token?: string;
};

export function createProductHuntAdapter(options: ProductHuntOptions): SourceAdapter {
  const { fetch, token } = options;

  return {
    key: "product-hunt",
    fetch: async (signal) => {
      if (!token) {
        // A missing credential is a configuration state, not a fetch failure:
        // it reports a warning but does not count as a failed source.
        return { articles: [], warnings: ["PRODUCTHUNT_API_TOKEN is not set"], failed: false };
      }

      const response = await fetchWithRetry(API_URL, {
        fetch,
        signal,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query: QUERY }),
      });
      if (!response.ok) {
        return {
          articles: [],
          warnings: [`Product Hunt returned ${response.status}`],
          failed: true,
        };
      }

      const body = (await response.json()) as {
        data?: { posts?: { edges?: { node: ProductHuntPost }[] } };
        errors?: unknown;
      };
      if (body.errors) {
        return {
          articles: [],
          warnings: [`Product Hunt API error: ${JSON.stringify(body.errors)}`],
          failed: true,
        };
      }

      const posts = body.data?.posts?.edges?.map((edge) => edge.node) ?? [];
      return { articles: parseProductHuntPosts(posts), warnings: [], failed: false };
    },
  };
}
