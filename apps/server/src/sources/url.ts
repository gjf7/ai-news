/** Tracking parameters stripped from every URL before it becomes canonical. */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
  /^ref$/i,
  /^ref_src$/i,
  /^igshid$/i,
  /^spm$/i,
];

/**
 * Produces the canonical form used for de-duplication: no fragment, no
 * tracking parameters, no trailing slash. Semantic query parameters are kept
 * because some sites identify an article through them.
 */
export function canonicalizeUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }

  url.hash = "";
  // Collect first: deleting while iterating a live URLSearchParams iterator
  // can skip entries.
  const tracked = Array.from(url.searchParams.keys()).filter((key) =>
    TRACKING_PARAMS.some((pattern) => pattern.test(key)),
  );
  for (const key of tracked) {
    url.searchParams.delete(key);
  }
  url.searchParams.sort();

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

/**
 * The comparison form of a title: lowercased, publisher suffix removed, and
 * punctuation collapsed to single spaces. Used by event clustering.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+[-–—|]\s+[^-–—|]{1,60}$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Derives a readable publisher name from a hostname: "www.theguardian.com" -> "theguardian". */
export function publisherFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const [name] = host.split(".");
    return name || host;
  } catch {
    return "unknown";
  }
}

/**
 * True when the URL points at the discovery channel itself rather than an
 * external article (an "Ask HN" thread, a Reddit self-post, ...). Used to
 * decide whether a publisher can be derived from the link.
 */
export function isSelfPost(url: string, channelHosts: string[]): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return channelHosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
  } catch {
    return false;
  }
}

/** Strips HTML tags and collapses whitespace, for turning feed HTML into text. */
export function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalizes an excerpt for storage: HTML removed, whitespace collapsed, and
 * truncated. Returns null when nothing meaningful remains, so the article's
 * scope correctly falls back to headline.
 */
export function toExcerpt(html: string | null | undefined, maxLength = 500): string | null {
  if (!html) return null;
  const text = stripHtml(html);
  if (text.length === 0) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text;
}
