import { and, desc, eq, sql } from "drizzle-orm";
import type { BlogList, BlogPostList, BlogPostQuery } from "@ai-news/contracts";
import type { DbHandle } from "../db/connection.ts";
import { blogPosts } from "../db/schema.ts";
import { BLOGS, blogNames } from "./blogs.ts";

/**
 * Read queries for the blogs tab. Blogs are listed from configuration (so a
 * blog with no posts yet still appears), joined with counts from `blog_posts`.
 */

export function listBlogs(handle: DbHandle): BlogList {
  const rows = handle.sqlite
    .prepare(
      `SELECT blog_key AS blogKey, COUNT(*) AS postCount,
              MAX(COALESCE(published_at, discovered_at)) AS lastPostAt
       FROM blog_posts GROUP BY blog_key`,
    )
    .all() as { blogKey: string; postCount: number; lastPostAt: number | null }[];

  const byKey = new Map(rows.map((row) => [row.blogKey, row]));

  return BLOGS.map((blog) => {
    const row = byKey.get(blog.key);
    return {
      key: blog.key,
      name: blog.name,
      postCount: row?.postCount ?? 0,
      lastPostAt: row?.lastPostAt ? new Date(row.lastPostAt).toISOString() : null,
    };
  });
}

export function listBlogPosts(handle: DbHandle, query: BlogPostQuery): BlogPostList {
  const where = query.blog ? and(eq(blogPosts.blogKey, query.blog)) : undefined;

  const total =
    handle.db
      .select({ count: sql<number>`count(*)` })
      .from(blogPosts)
      .where(where)
      .get()?.count ?? 0;

  // Newest first, using the discovery time when a feed omits a publish date.
  const rows = handle.db
    .select()
    .from(blogPosts)
    .where(where)
    .orderBy(
      desc(sql`coalesce(${blogPosts.publishedAt}, ${blogPosts.discoveredAt})`),
      desc(blogPosts.id),
    )
    .limit(query.limit + 1)
    .offset((query.page - 1) * query.limit)
    .all();

  const hasMore = rows.length > query.limit;
  const names = blogNames();

  return {
    items: rows.slice(0, query.limit).map((row) => ({
      id: row.id,
      blogKey: row.blogKey,
      blogName: names.get(row.blogKey) ?? row.blogKey,
      title: row.title,
      url: row.url,
      publishedAt: row.publishedAt?.toISOString() ?? null,
    })),
    page: query.page,
    hasMore,
    total,
  };
}
