import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import {
  applyResolvedUrl,
  parseGoogleNewsFeed,
  toFetchedArticle,
} from "../src/sources/google-news.ts";
import {
  buildBatchExecuteBody,
  parseArticleSignature,
  parseBatchExecuteResponse,
} from "../src/sources/google-news-resolver.ts";

const read = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../src/sources/__fixtures__/${name}`, import.meta.url)),
    "utf8",
  );

const feed = read("google-news.xml");
const articlePage = read("google-news-article.html");

test("parses the real Google News RSS fixture", () => {
  const entries = parseGoogleNewsFeed(feed);
  expect(entries).toHaveLength(5);

  const first = entries[0]!;
  expect(first.title).not.toContain(" - CBS News");
  expect(first.publisher).toBe("CBS News");
  expect(first.googleUrl).toMatch(/^https:\/\/news\.google\.com\/rss\/articles\//);
  expect(first.publishedAt).toBeInstanceOf(Date);
  expect(first.externalId.length).toBeGreaterThan(0);
});

test("every fixture entry keeps its publisher name", () => {
  for (const entry of parseGoogleNewsFeed(feed)) {
    expect(entry.publisher.length).toBeGreaterThan(0);
    expect(entry.title.length).toBeGreaterThan(0);
  }
});

test("the Google link is never mistaken for the publisher URL", () => {
  // This is the crux of the Google News design: the RSS link is a Google
  // redirect, not the article. It must be resolved, not used directly.
  for (const entry of parseGoogleNewsFeed(feed)) {
    expect(new URL(entry.googleUrl).hostname).toBe("news.google.com");
  }
});

test("extracts the resolver signature from a real article page", () => {
  const signature = parseArticleSignature(articlePage);
  expect(signature).not.toBeNull();
  expect(signature!.id).toMatch(/^CBMi/);
  expect(signature!.timestamp).toMatch(/^\d+$/);
  expect(signature!.signature.length).toBeGreaterThan(0);
});

test("returns null when the page has no signature attributes", () => {
  expect(parseArticleSignature("<html><body>nothing here</body></html>")).toBeNull();
});

test("builds an f.req body carrying the id, timestamp and signature", () => {
  const signature = parseArticleSignature(articlePage)!;
  const body = buildBatchExecuteBody(signature);
  const decoded = decodeURIComponent(body);

  expect(body.startsWith("f.req=")).toBe(true);
  expect(decoded).toContain("Fbv4je");
  expect(decoded).toContain("garturlreq");
  expect(decoded).toContain(signature.id);
  expect(decoded).toContain(signature.signature);
});

test("parses the publisher URL out of a real batchexecute response", () => {
  // Captured verbatim from the live endpoint.
  const body = String.raw`)]}'

[["wrb.fr","Fbv4je","[\"garturlres\",\"https://www.cbsnews.com/news/artificial-intelligence-trained-to-help-with-careers-60-minutes/\",1]",null,null,null,"generic"],["di",14]]`;
  expect(parseBatchExecuteResponse(body)).toBe(
    "https://www.cbsnews.com/news/artificial-intelligence-trained-to-help-with-careers-60-minutes/",
  );
});

test("returns null when the response carries no resolved url", () => {
  const body = String.raw`)]}'

[["wrb.fr","Fbv4je",null,null,null,[3],"generic"],["di",27]]`;
  expect(parseBatchExecuteResponse(body)).toBeNull();
});

test("an unresolved entry keeps the Google URL and is flagged", () => {
  const entry = parseGoogleNewsFeed(feed)[0]!;
  const unresolved = applyResolvedUrl(entry, null, { attempted: true });
  expect(unresolved.unresolved).toBe(true);
  expect(unresolved.url).toBe(entry.googleUrl);

  const article = toFetchedArticle(unresolved);
  expect(article.unresolved).toBe(true);
  expect(article.excerpt).toBeNull();
});

test("an entry skipped by the resolve cap is distinguished from a failed one", () => {
  const entry = parseGoogleNewsFeed(feed)[0]!;

  const skipped = toFetchedArticle(applyResolvedUrl(entry, null, { attempted: false }));
  expect(skipped.unresolved).toBe(true);
  expect(skipped.resolveAttempted).toBe(false);

  const failed = toFetchedArticle(applyResolvedUrl(entry, null, { attempted: true }));
  expect(failed.unresolved).toBe(true);
  expect(failed.resolveAttempted).toBe(true);
});

test("a resolved entry uses the publisher URL", () => {
  const entry = parseGoogleNewsFeed(feed)[0]!;
  const resolved = applyResolvedUrl(entry, "https://www.cbsnews.com/news/example/", {
    attempted: true,
  });
  expect(resolved.unresolved).toBe(false);
  expect(resolved.url).toBe("https://www.cbsnews.com/news/example/");
});
