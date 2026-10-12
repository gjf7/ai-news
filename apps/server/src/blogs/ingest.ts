import type { DbHandle } from "../db/connection.ts";
import { articleIdFromUrl } from "../db/ids.ts";
import { blogPosts } from "../db/schema.ts";
import { fetchFeed } from "../sources/rss.ts";
import { BLOGS, DEFAULT_BLOG_LIMIT, type BlogDefinition } from "./blogs.ts";

/**
 * Blog collecting. Runs on the same schedule as the news sources but writes
 * only to `blog_posts`: it never touches articles, events, sources or the
 * model, so a blog can never affect the news feed or its notifications.
 *
 * A blog that fails to fetch is counted and skipped; it must not fail the run.
 */

export type BlogIngestDeps = {
  handle: DbHandle;
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
  blogs?: BlogDefinition[];
  concurrency?: number;
};

export type BlogIngestResult = {
  fetched: number;
  inserted: number;
  failedBlogs: number;
  warnings: string[];
};

export async function runBlogIngest({
  handle,
  fetch,
  signal,
  blogs = BLOGS,
  concurrency = 4,
}: BlogIngestDeps): Promise<BlogIngestResult> {
  const result: BlogIngestResult = { fetched: 0, inserted: 0, failedBlogs: 0, warnings: [] };
  const pending = [...blogs];

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (cursor < pending.length) {
      if (signal.aborted) return;
      const blog = pending[cursor++];
      if (!blog) return;

      try {
        // One feed per blog, so the shared RSS adapter is reused as-is.
        const outcome = await fetchFeed(signal, {
          fetch,
          config: {
            publisher: blog.name,
            feeds: [blog.feed],
            limit: blog.limit ?? DEFAULT_BLOG_LIMIT,
          },
        });
        if (outcome.failed) result.failedBlogs += 1;
        result.fetched += outcome.articles.length;
        result.inserted += persistPosts(handle, blog.key, outcome.articles);
        result.warnings.push(...outcome.warnings.map((warning) => `${blog.key}: ${warning}`));
      } catch (error) {
        result.failedBlogs += 1;
        result.warnings.push(`${blog.key}: ${String(error)}`);
      }
    }
  });
  await Promise.all(workers);

  return result;
}

/** Upserts posts, treating the canonical URL as the identity. */
function persistPosts(
  handle: DbHandle,
  blogKey: string,
  articles: { url: string; title: string; publishedAt: Date | null }[],
): number {
  const now = new Date();
  let inserted = 0;

  for (const article of articles) {
    const result = handle.db
      .insert(blogPosts)
      .values({
        id: articleIdFromUrl(article.url),
        blogKey,
        title: article.title,
        url: article.url,
        publishedAt: article.publishedAt,
        discoveredAt: now,
      })
      .onConflictDoNothing()
      .run();
    inserted += result.changes;
  }

  return inserted;
}
