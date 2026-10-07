import { XMLParser } from "fast-xml-parser";
import type { FetchedArticle } from "./adapter.ts";

/**
 * Parses a Google News RSS document into articles. This is pure so it can be
 * tested against a saved fixture; the network lives in `fetchGoogleNews`.
 *
 * Google News titles look like "Headline - Publisher", and each item carries
 * `<source url="https://www.cbsnews.com">CBS News</source>`. The `<link>` is
 * a Google redirect, not the publisher URL — resolution happens separately.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

export type GoogleNewsEntry = {
  externalId: string;
  title: string;
  googleUrl: string;
  publisher: string;
  publishedAt: Date | null;
};

type RawSource = { "@_url"?: string; "#text"?: string } | string;

function readSource(source: RawSource | undefined): string | null {
  if (!source) return null;
  if (typeof source === "string") return source.trim() || null;
  return source["#text"]?.trim() || null;
}

export function parseGoogleNewsFeed(xml: string): GoogleNewsEntry[] {
  const parsed = parser.parse(xml) as {
    rss?: { channel?: { item?: unknown } };
  };
  const rawItems = parsed.rss?.channel?.item;
  if (!rawItems) return [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  return items.flatMap((raw): GoogleNewsEntry[] => {
    const item = raw as {
      title?: string;
      link?: string;
      guid?: string | { "#text"?: string };
      pubDate?: string;
      source?: RawSource;
    };

    const googleUrl = item.link?.trim();
    if (!googleUrl) return [];

    const guid = typeof item.guid === "string" ? item.guid : (item.guid?.["#text"] ?? googleUrl);

    const published = item.pubDate ? new Date(item.pubDate) : null;
    return [
      {
        externalId: guid,
        // Strip the trailing " - Publisher" that Google appends.
        title: stripPublisherSuffix(item.title ?? ""),
        googleUrl,
        publisher: readSource(item.source) ?? "Google News",
        publishedAt: published && !Number.isNaN(published.getTime()) ? published : null,
      },
    ];
  });
}

function stripPublisherSuffix(title: string): string {
  const index = title.lastIndexOf(" - ");
  return index > 0 ? title.slice(0, index) : title;
}

export type ResolvedEntry = GoogleNewsEntry & {
  url: string;
  unresolved: boolean;
  resolveAttempted: boolean;
};

/**
 * Applies the resolved publisher URL when available. When resolution was not
 * attempted (over the per-run cap) or failed, the Google URL is kept and the
 * article is flagged unresolved so the UI can say so. `attempted` distinguishes
 * "did not try" from "tried and failed".
 */
export function applyResolvedUrl(
  entry: GoogleNewsEntry,
  resolved: string | null,
  { attempted }: { attempted: boolean },
): ResolvedEntry {
  return resolved
    ? { ...entry, url: resolved, unresolved: false, resolveAttempted: attempted }
    : { ...entry, url: entry.googleUrl, unresolved: true, resolveAttempted: attempted };
}

export function toFetchedArticle(entry: ResolvedEntry): FetchedArticle {
  return {
    externalId: entry.externalId,
    url: entry.url,
    title: entry.title,
    publisher: entry.publisher,
    publishedAt: entry.publishedAt,
    // Google News RSS carries no article excerpt, only the title.
    excerpt: null,
    unresolved: entry.unresolved,
    resolveAttempted: entry.resolveAttempted,
    kind: "news",
    communityScore: null,
  };
}
