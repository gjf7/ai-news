import { BLOGS } from "../src/blogs/blogs.ts";
import { fetchFeed } from "../src/sources/rss.ts";

/**
 * Fetches every configured blog feed through the real adapter and reports how
 * many items each returned. Read-only: nothing is stored.
 *
 * Usage: vp run server#probe-blogs
 */

const results = await Promise.all(
  BLOGS.map(async (blog) => {
    try {
      const outcome = await fetchFeed(AbortSignal.timeout(20_000), {
        fetch: globalThis.fetch,
        config: { publisher: blog.name, feeds: [blog.feed], limit: blog.limit ?? 50 },
      });
      return {
        key: blog.key,
        failed: outcome.failed === true,
        count: outcome.articles.length,
        note: outcome.articles[0]?.title ?? outcome.warnings[0] ?? "",
      };
    } catch (error) {
      return { key: blog.key, failed: true, count: 0, note: String(error) };
    }
  }),
);

for (const result of results) {
  console.log(
    `${result.failed ? "FAIL" : "ok  "} ${result.key.padEnd(16)} ${String(result.count).padStart(3)}  ${result.note.slice(0, 64)}`,
  );
}

const failed = results.filter((result) => result.failed).length;
console.log(`\n${results.length - failed}/${results.length} blog feeds ok`);
process.exit(failed > 0 ? 1 : 0);
