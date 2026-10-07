import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import { buildFeedUrl, createGoogleNewsAdapter } from "../src/sources/google-news-adapter.ts";

const read = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../src/sources/__fixtures__/${name}`, import.meta.url)),
    "utf8",
  );

const feed = read("google-news.xml");
const articlePage = read("google-news-article.html");

const rpcResponse = String.raw`)]}'

[["wrb.fr","Fbv4je","[\"garturlres\",\"https://www.cbsnews.com/news/resolved-article/\",1]",null,null,null,"generic"],["di",14]]`;

/** Fake fetch that answers feeds, article pages and the RPC endpoint. */
function fakeFetch(calls: string[]): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);

    if (url.includes("/rss/search")) {
      return new Response(feed, { status: 200 });
    }
    if (url.includes("batchexecute")) {
      return new Response(rpcResponse, { status: 200 });
    }
    // Article page: carries the signature attributes.
    return new Response(articlePage, { status: 200 });
  }) as typeof fetch;
}

test("buildFeedUrl sets the Google News locale parameters", () => {
  const url = new URL(buildFeedUrl("semiconductor"));
  expect(url.hostname).toBe("news.google.com");
  expect(url.searchParams.get("q")).toBe("semiconductor");
  expect(url.searchParams.get("hl")).toBe("en-US");
  expect(url.searchParams.get("ceid")).toBe("US:en");
});

test("adapter resolves links and reports the request cost", async () => {
  const calls: string[] = [];
  const adapter = createGoogleNewsAdapter({
    fetch: fakeFetch(calls),
    queries: ["artificial intelligence"],
    perQueryLimit: 2,
    maxResolve: 2,
  });

  const { articles } = await adapter.fetch(AbortSignal.timeout(5_000));

  expect(adapter.key).toBe("google-news");
  expect(articles).toHaveLength(2);
  // Both selected items were resolved.
  expect(articles.every((article) => article.unresolved === false)).toBe(true);
  expect(articles[0]!.url).toBe("https://www.cbsnews.com/news/resolved-article/");

  // 1 feed request + 2 requests per resolved article.
  const feedCalls = calls.filter((url) => url.includes("/rss/search"));
  const pageCalls = calls.filter((url) => url.includes("/rss/articles/"));
  const rpcCalls = calls.filter((url) => url.includes("batchexecute"));
  expect(feedCalls).toHaveLength(1);
  expect(pageCalls).toHaveLength(2);
  expect(rpcCalls).toHaveLength(2);
});

test("items beyond the resolve cap are kept but marked as not attempted", async () => {
  const calls: string[] = [];
  const adapter = createGoogleNewsAdapter({
    fetch: fakeFetch(calls),
    queries: ["artificial intelligence"],
    perQueryLimit: 5,
    maxResolve: 1,
  });

  const { articles, warnings } = await adapter.fetch(AbortSignal.timeout(5_000));

  expect(articles).toHaveLength(5);
  const attempted = articles.filter((article) => article.resolveAttempted);
  const skipped = articles.filter((article) => !article.resolveAttempted);

  expect(attempted).toHaveLength(1);
  expect(skipped).toHaveLength(4);
  // Skipped items are not reported as resolution failures.
  expect(warnings.some((warning) => warning.includes("failed"))).toBe(false);
});

test("a failed resolution keeps the Google URL and is reported", async () => {
  const calls: string[] = [];
  const failingFetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.includes("/rss/search")) return new Response(feed, { status: 200 });
    // Article page without signature attributes -> resolution cannot proceed.
    return new Response("<html><body>no signature</body></html>", { status: 200 });
  }) as typeof fetch;

  const adapter = createGoogleNewsAdapter({
    fetch: failingFetch,
    queries: ["artificial intelligence"],
    perQueryLimit: 2,
    maxResolve: 2,
  });

  const { articles, warnings } = await adapter.fetch(AbortSignal.timeout(5_000));

  expect(articles.every((article) => article.unresolved)).toBe(true);
  expect(articles.every((article) => article.url.includes("news.google.com"))).toBe(true);
  expect(warnings.some((warning) => warning.includes("attempted resolutions failed"))).toBe(true);
});

test("a feed failure is reported without throwing", async () => {
  // 404 is not retried; a 5xx would be (see http.test.ts).
  const failingFetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
  const adapter = createGoogleNewsAdapter({
    fetch: failingFetch,
    queries: ["x"],
  });

  const { articles, warnings } = await adapter.fetch(AbortSignal.timeout(5_000));
  expect(articles).toHaveLength(0);
  expect(warnings.some((warning) => warning.includes("returned 404"))).toBe(true);
});
