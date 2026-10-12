import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { createDb, type DbHandle } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { blogPosts } from "../src/db/schema.ts";
import { runBlogIngest } from "../src/blogs/ingest.ts";
import { listBlogPosts, listBlogs } from "../src/blogs/queries.ts";
import type { BlogDefinition } from "../src/blogs/blogs.ts";

const rss = (items: { title: string; link: string; date?: string }[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel>${items
    .map(
      (item) =>
        `<item><title>${item.title}</title><link>${item.link}</link>${
          item.date ? `<pubDate>${item.date}</pubDate>` : ""
        }<guid>${item.link}</guid></item>`,
    )
    .join("")}</channel></rss>`;

const signal = new AbortController().signal;

let dir: string;
let handle: DbHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-news-blogs-"));
  handle = createDb(join(dir, "app.db"));
  migrate(handle.sqlite);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Serves the configured feed bodies; anything else is a 404. */
function fakeFetch(map: Record<string, string>): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = map[url];
    if (!body) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200 });
  }) as typeof globalThis.fetch;
}

const blogA: BlogDefinition = { key: "a", name: "Blog A", feed: "https://a.example/feed" };
const blogB: BlogDefinition = { key: "b", name: "Blog B", feed: "https://b.example/feed" };

test("ingest stores posts and dedupes by url on the next run", async () => {
  const fetch = fakeFetch({
    "https://a.example/feed": rss([
      { title: "First", link: "https://a.example/1" },
      { title: "Second", link: "https://a.example/2" },
    ]),
  });

  const first = await runBlogIngest({ handle, fetch, signal, blogs: [blogA] });
  expect(first.inserted).toBe(2);
  expect(first.fetched).toBe(2);
  expect(handle.db.select().from(blogPosts).all()).toHaveLength(2);

  const second = await runBlogIngest({ handle, fetch, signal, blogs: [blogA] });
  expect(second.inserted).toBe(0);
  expect(handle.db.select().from(blogPosts).all()).toHaveLength(2);
});

test("a failing blog is isolated and does not stop the others", async () => {
  const fetch = fakeFetch({
    "https://b.example/feed": rss([{ title: "B1", link: "https://b.example/1" }]),
  });

  const result = await runBlogIngest({ handle, fetch, signal, blogs: [blogA, blogB] });
  expect(result.failedBlogs).toBe(1);
  expect(result.inserted).toBe(1);
  expect(
    handle.db
      .select()
      .from(blogPosts)
      .all()
      .map((row) => row.blogKey),
  ).toEqual(["b"]);
});

test("the per-blog limit caps how many items are stored", async () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    title: `P${index}`,
    link: `https://a.example/${index}`,
  }));
  const fetch = fakeFetch({ "https://a.example/feed": rss(items) });

  const result = await runBlogIngest({
    handle,
    fetch,
    signal,
    blogs: [{ ...blogA, limit: 2 }],
  });
  expect(result.inserted).toBe(2);
});

test("listBlogs reports counts per configured blog", () => {
  const now = new Date();
  handle.db
    .insert(blogPosts)
    .values({
      id: "x1",
      blogKey: "julia-evans",
      title: "t",
      url: "https://jvns.ca/1",
      publishedAt: now,
      discoveredAt: now,
    })
    .run();

  const blogs = listBlogs(handle);
  expect(blogs.length).toBeGreaterThan(0);
  const jvns = blogs.find((blog) => blog.key === "julia-evans");
  expect(jvns?.postCount).toBe(1);
  expect(jvns?.name).toBe("Julia Evans");
  expect(jvns?.lastPostAt).not.toBeNull();
});

test("listBlogPosts filters by blog and orders newest first", () => {
  const now = Date.now();
  handle.db
    .insert(blogPosts)
    .values([
      {
        id: "p1",
        blogKey: "julia-evans",
        title: "Older",
        url: "https://jvns.ca/1",
        publishedAt: new Date(now - 1000),
        discoveredAt: new Date(now),
      },
      {
        id: "p2",
        blogKey: "julia-evans",
        title: "Newer",
        url: "https://jvns.ca/2",
        publishedAt: new Date(now),
        discoveredAt: new Date(now),
      },
      {
        id: "p3",
        blogKey: "lethain",
        title: "Other",
        url: "https://lethain.com/1",
        publishedAt: new Date(now),
        discoveredAt: new Date(now),
      },
    ])
    .run();

  const filtered = listBlogPosts(handle, { blog: "julia-evans", page: 1, limit: 30 });
  expect(filtered.total).toBe(2);
  expect(filtered.items.map((item) => item.title)).toEqual(["Newer", "Older"]);
  expect(filtered.items.every((item) => item.blogName === "Julia Evans")).toBe(true);

  const all = listBlogPosts(handle, { page: 1, limit: 30 });
  expect(all.total).toBe(3);
});
