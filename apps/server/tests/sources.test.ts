import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import { parseHackerNewsHits } from "../src/sources/hacker-news.ts";
import { canonicalizeUrl, normalizeTitle, publisherFromUrl } from "../src/sources/url.ts";

const hnFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../src/sources/__fixtures__/hacker-news.json", import.meta.url)),
    "utf8",
  ),
) as { hits: unknown[] };

test("parses the real HN Algolia fixture", () => {
  const articles = parseHackerNewsHits(hnFixture.hits as Parameters<typeof parseHackerNewsHits>[0]);
  expect(articles.length).toBeGreaterThan(0);

  const first = articles[0]!;
  expect(first.publisher).toBe("Hacker News");
  expect(first.title.length).toBeGreaterThan(0);
  expect(first.url).toMatch(/^https?:\/\//);
  expect(first.excerpt).toBeNull();
});

test("Ask/Show HN posts without a URL link to the thread", () => {
  const articles = parseHackerNewsHits([
    { objectID: "123", title: "Ask HN: something", url: null, points: 5, created_at_i: 1700000000 },
  ]);
  expect(articles[0]!.url).toBe("https://news.ycombinator.com/item?id=123");
});

test("hits without a title are dropped", () => {
  expect(parseHackerNewsHits([{ objectID: "1", title: "  " }])).toHaveLength(0);
});

test("strips tracking parameters but keeps semantic ones", () => {
  expect(canonicalizeUrl("https://example.com/a?utm_source=x&id=7&fbclid=y")).toBe(
    "https://example.com/a?id=7",
  );
});

test("drops the fragment and trailing slash", () => {
  expect(canonicalizeUrl("https://example.com/a/#section")).toBe("https://example.com/a");
});

test("leaves an unparseable URL untouched", () => {
  expect(canonicalizeUrl("not a url")).toBe("not a url");
});

test("normalizes titles by removing the publisher suffix and punctuation", () => {
  expect(normalizeTitle("OpenAI Ships GPT-6 - The Verge")).toBe("openai ships gpt 6");
  expect(normalizeTitle("Trump announces AI 'Super Intelligence Force'")).toBe(
    "trump announces ai super intelligence force",
  );
});

test("derives a publisher name from the hostname", () => {
  expect(publisherFromUrl("https://www.theguardian.com/technology/x")).toBe("theguardian");
  expect(publisherFromUrl("https://techcrunch.com/2026/10/05/x/")).toBe("techcrunch");
});
