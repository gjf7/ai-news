import { XMLParser } from "fast-xml-parser";
import type { ArticleKind, FetchedArticle } from "./adapter.ts";
import { fetchWithRetry } from "./http.ts";
import { canonicalizeUrl, toExcerpt } from "./url.ts";

/**
 * Generic RSS/Atom adapter. Most sources are "a feed plus a publisher name",
 * so they are described as configuration rather than separate modules.
 *
 * One source may expose several feeds (FT has AI/technology/semiconductors);
 * their items are merged and de-duplicated by canonical URL. The publisher is
 * always the configured name: for community channels (Reddit, Lobsters) the
 * link points at the channel or a user post, never at an outlet.
 *
 * Feeds differ in shape: RSS repeats `<item>`, Atom repeats `<entry>`, and
 * Atom wraps text elements in objects (`<title type="html">` parses to
 * `{ "#text": ..., "@_type": "html" }`). All of that is normalized here.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

/** Per-feed cap. Some feeds return their whole archive (Hugging Face: ~875). */
const DEFAULT_FEED_LIMIT = 50;

export type FeedEntry = {
  externalId: string;
  title: string;
  url: string;
  publisher: string;
  publishedAt: Date | null;
  excerpt: string | null;
};

/** Atom wraps text in an object; RSS usually uses a plain string. */
type TextValue = string | { "#text"?: string | number; "@_href"?: string } | undefined;

type RawItem = {
  title?: TextValue;
  link?: TextValue;
  guid?: TextValue;
  id?: string;
  pubDate?: string;
  published?: string;
  updated?: string;
  description?: string;
  summary?: TextValue;
  "content:encoded"?: string;
  content?: TextValue;
};

function readText(value: TextValue): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (value["#text"] !== undefined) return String(value["#text"]);
  return value["@_href"];
}

function readBody(item: RawItem): string | undefined {
  const candidates = [
    item["content:encoded"],
    item.description,
    readText(item.content),
    readText(item.summary),
  ];
  return candidates.find((candidate) => Boolean(candidate));
}

function readDate(item: RawItem): Date | null {
  const raw = item.pubDate ?? item.published ?? item.updated;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Parses an RSS or Atom document into entries. Pure, so it is fixture-testable. */
export function parseFeed(
  xml: string,
  { publisher, limit = DEFAULT_FEED_LIMIT }: { publisher: string; limit?: number },
): FeedEntry[] {
  const parsed = parser.parse(xml) as {
    rss?: { channel?: { item?: unknown } };
    feed?: { entry?: unknown };
  };

  const rawItems = parsed.rss?.channel?.item ?? parsed.feed?.entry;
  if (!rawItems) return [];
  const items = (Array.isArray(rawItems) ? rawItems : [rawItems]).slice(0, limit);

  return items.flatMap((raw): FeedEntry[] => {
    const item = raw as RawItem;
    const title = readText(item.title)?.replace(/\s+/g, " ").trim();
    const rawLink = readText(item.link)?.trim();
    if (!title || !rawLink) return [];

    const url = canonicalizeUrl(rawLink);
    const guid = readText(item.guid) ?? item.id ?? url;

    return [
      {
        externalId: String(guid),
        title,
        url,
        publisher,
        publishedAt: readDate(item),
        excerpt: toExcerpt(readBody(item)),
      },
    ];
  });
}

export type FeedConfig = {
  /** Publisher name shown in the UI and used for outlet counting. */
  publisher: string;
  /** Feed URLs belonging to this source. */
  feeds: string[];
  /** Most recent items kept per feed. */
  limit?: number;
  /** Article kind; community feeds are discussions. Defaults to news. */
  kind?: ArticleKind;
  /**
   * How many feeds to fetch per run. Reddit rate-limits unauthenticated RSS to
   * roughly one request per window, so fetching all four subreddits costs
   * ~3 minutes of waiting. Fetching one per run keeps the run predictable and
   * still covers every feed within a few intervals. Omit to fetch all.
   */
  feedsPerRun?: number;
};

export type RssAdapterOptions = {
  fetch: typeof globalThis.fetch;
  config: FeedConfig;
  /** Injectable clock for deterministic feed rotation in tests. */
  now?: number;
};

export async function fetchFeed(
  signal: AbortSignal,
  { fetch, config, now = Date.now() }: RssAdapterOptions,
): Promise<{ articles: FetchedArticle[]; warnings: string[]; failed: boolean }> {
  const warnings: string[] = [];
  const entries: FeedEntry[] = [];
  let failedFeeds = 0;

  // Rotate which feeds are fetched this run, so a rate-limited source is
  // covered across successive runs instead of stalling one run.
  const feeds =
    config.feedsPerRun && config.feedsPerRun < config.feeds.length
      ? Array.from({ length: config.feedsPerRun }, (_, index) => {
          const slot = Math.floor(now / 1_800_000) + index;
          return config.feeds[slot % config.feeds.length];
        })
      : config.feeds;

  // Sequential per feed: parallel bursts are what trigger Reddit's 429s, and a
  // source's own feeds are few.
  for (const feedUrl of feeds) {
    try {
      const response = await fetchWithRetry(feedUrl, { fetch, signal });
      if (!response.ok) throw new Error(`${feedUrl} returned ${response.status}`);
      entries.push(
        ...parseFeed(await response.text(), { publisher: config.publisher, limit: config.limit }),
      );
    } catch (error) {
      failedFeeds += 1;
      warnings.push(`feed ${feedUrl} failed: ${String(error)}`);
    }
  }

  const seen = new Set<string>();
  const articles: FetchedArticle[] = entries
    .filter((entry) => {
      if (seen.has(entry.url)) return false;
      seen.add(entry.url);
      return true;
    })
    .map((entry) => ({
      externalId: entry.externalId,
      url: entry.url,
      title: entry.title,
      publisher: entry.publisher,
      publishedAt: entry.publishedAt,
      excerpt: entry.excerpt,
      kind: config.kind ?? ("news" as ArticleKind),
      communityScore: null,
    }));

  return { articles, warnings, failed: failedFeeds === feeds.length && feeds.length > 0 };
}
