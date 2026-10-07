import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import { parseArxivFeed } from "../src/sources/arxiv.ts";
import { FEED_SOURCES } from "../src/sources/feeds.ts";
import { createProductHuntAdapter, parseProductHuntPosts } from "../src/sources/product-hunt.ts";
import { fetchFeed, parseFeed } from "../src/sources/rss.ts";

const read = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../src/sources/__fixtures__/${name}`, import.meta.url)),
    "utf8",
  );

/** Fetch receives a string, URL or Request; extract the URL safely. */
function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

test("parses an Atom feed where text elements are wrapped objects", () => {
  // The Verge is Atom: <title type="html"> parses to { "#text", "@_type" }.
  // Treating it as a plain string silently dropped every entry.
  const entries = parseFeed(read("the-verge.xml"), { publisher: "The Verge" });
  expect(entries.length).toBeGreaterThan(0);

  const first = entries[0]!;
  expect(typeof first.title).toBe("string");
  expect(first.title).not.toContain("[object Object]");
  expect(first.url).toMatch(/^https:\/\/www\.theverge\.com\//);
  expect(first.publisher).toBe("The Verge");
  expect(first.publishedAt).toBeInstanceOf(Date);
});

test("parses an RSS feed and extracts the excerpt", () => {
  const entries = parseFeed(read("ee-times.xml"), { publisher: "EE Times" });
  expect(entries.length).toBeGreaterThan(0);
  expect(entries[0]!.excerpt).toBeTruthy();
  expect(entries[0]!.excerpt).not.toMatch(/<[^>]+>/);
});

test("parses the Bloomberg feed, which wraps every field in CDATA", () => {
  // Bloomberg uses CDATA for title/description/creator, so the parser must
  // return the inner text rather than an empty object.
  const entries = parseFeed(read("bloomberg.xml"), { publisher: "Bloomberg" });
  expect(entries.length).toBeGreaterThan(0);

  const first = entries[0]!;
  expect(first.publisher).toBe("Bloomberg");
  expect(first.title).not.toContain("CDATA");
  expect(first.url).toMatch(/^https:\/\/www\.bloomberg\.com\/news\/articles\//);
  // Bloomberg feeds carry a real excerpt, so these are excerpt-scope, not headline.
  expect(first.excerpt).toBeTruthy();
  expect(first.excerpt).not.toContain("CDATA");
  expect(first.publishedAt).toBeInstanceOf(Date);
});

test("caps the number of entries per feed", () => {
  const entries = parseFeed(read("the-verge.xml"), { publisher: "The Verge", limit: 2 });
  expect(entries).toHaveLength(2);
});

test("parses an arXiv Atom response", () => {
  const articles = parseArxivFeed(read("arxiv.xml"));
  expect(articles.length).toBeGreaterThan(0);

  const first = articles[0]!;
  expect(first.publisher).toBe("arXiv");
  expect(first.url).toMatch(/^https:\/\/arxiv\.org\/abs\//);
  expect(first.excerpt).toBeTruthy();
});

test("every configured feed source has a publisher and at least one feed", () => {
  for (const [key, config] of Object.entries(FEED_SOURCES)) {
    expect(config.publisher, key).toBeTruthy();
    expect(config.feeds.length, key).toBeGreaterThan(0);
    for (const feed of config.feeds) {
      expect(() => new URL(feed), `${key}: ${feed}`).not.toThrow();
    }
  }
});

test("the reference project's feed sources are all present", () => {
  const expected = [
    "techcrunch",
    "the-verge",
    "mit-tech-review",
    "huggingface",
    "lobsters",
    "semi-engineering",
    "ee-times",
    "semiwiki",
    "ieee-spectrum",
    "ft",
    "wsj",
    "economist",
    "reddit",
    "bloomberg",
  ];
  expect(Object.keys(FEED_SOURCES).sort()).toEqual(expected.sort());
});

test("feed sources with several URLs fetch every one unless rotation is set", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    calls.push(urlOf(input));
    return new Response("<rss><channel></channel></rss>", { status: 200 });
  }) as typeof fetch;

  await fetchFeed(AbortSignal.timeout(1_000), {
    fetch: fakeFetch,
    config: FEED_SOURCES.ft!,
  });
  expect(calls).toHaveLength(FEED_SOURCES.ft!.feeds.length);
});

test("feedsPerRun rotates which feed is fetched", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    calls.push(urlOf(input));
    return new Response("<rss><channel></channel></rss>", { status: 200 });
  }) as typeof fetch;

  const config = FEED_SOURCES.reddit!;
  expect(config.feedsPerRun).toBe(1);

  // Different times land on different feeds, so all subreddits get covered.
  const picked = new Set<string>();
  for (let slot = 0; slot < config.feeds.length; slot += 1) {
    calls.length = 0;
    await fetchFeed(AbortSignal.timeout(1_000), {
      fetch: fakeFetch,
      config,
      now: slot * 1_800_000,
    });
    expect(calls).toHaveLength(1);
    picked.add(calls[0]!);
  }
  expect(picked.size).toBe(config.feeds.length);
});

test("a feed failure is reported and the other feeds still return", async () => {
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = urlOf(input);
    // 404 is not retried, so the failure surfaces immediately.
    if (url.includes("artificial-intelligence")) {
      return new Response("nope", { status: 404 });
    }
    return new Response(read("ee-times.xml"), { status: 200 });
  }) as typeof fetch;

  const { articles, warnings } = await fetchFeed(AbortSignal.timeout(1_000), {
    fetch: fakeFetch,
    config: {
      publisher: "Test",
      feeds: ["https://example.com/artificial-intelligence/feed/", "https://example.com/ok"],
    },
  });

  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("returned 404");
  expect(articles.length).toBeGreaterThan(0);
});

test("a 429 is retried before giving up", async () => {
  let attempts = 0;
  const fakeFetch = (async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(null, { status: 429, headers: { "retry-after": "0" } });
    }
    return new Response(read("ee-times.xml"), { status: 200 });
  }) as typeof fetch;

  const { articles, warnings } = await fetchFeed(AbortSignal.timeout(5_000), {
    fetch: fakeFetch,
    config: { publisher: "Test", feeds: ["https://example.com/feed"] },
  });

  expect(attempts).toBe(2);
  expect(warnings).toHaveLength(0);
  expect(articles.length).toBeGreaterThan(0);
});

test("parses Product Hunt posts and skips incomplete ones", () => {
  const articles = parseProductHuntPosts([
    {
      name: "Tool",
      tagline: "Does things",
      url: "https://producthunt.com/posts/tool",
      votesCount: 42,
    },
    { name: "No URL" },
    { url: "https://producthunt.com/posts/nameless" },
  ]);

  expect(articles).toHaveLength(1);
  expect(articles[0]!.title).toBe("Tool");
  expect(articles[0]!.excerpt).toBe("Does things");
  expect(articles[0]!.communityScore).toBe(42);
});

test("Product Hunt without a token warns instead of failing", async () => {
  const adapter = createProductHuntAdapter({ fetch: globalThis.fetch, token: undefined });
  const { articles, warnings } = await adapter.fetch(AbortSignal.timeout(1_000));
  expect(articles).toHaveLength(0);
  expect(warnings[0]).toContain("PRODUCTHUNT_API_TOKEN");
});
