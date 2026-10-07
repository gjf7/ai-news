/**
 * Resolves a Google News RSS link to the original publisher URL.
 *
 * Google News is a discovery channel: its RSS `<link>` points at
 * `news.google.com/rss/articles/CBMi...`, an opaque token that is NOT plain
 * base64 and does not contain the publisher URL. Following the link over HTTP
 * does not redirect to the article either — the redirect is performed by
 * JavaScript in the browser. Server-side we must reproduce that flow:
 *
 *   1. GET the Google News article page.
 *   2. Read `data-n-a-id`, `data-n-a-ts` and `data-n-a-sg` from the markup.
 *   3. POST them to the internal `batchexecute` RPC (`Fbv4je`), which returns
 *      `garturlres` carrying the original URL.
 *
 * This is an undocumented internal API. It can change without notice, so every
 * failure degrades to keeping the Google URL and marking the article
 * unresolved rather than failing the run. Verified against live traffic on
 * 2026-10-06: 8/8 links resolved, no rate limiting at 20 requests.
 *
 * See docs/architecture.md "URL 与来源".
 */

import { fetchWithRetry } from "./http.ts";

const BATCHEXECUTE_URL = "https://news.google.com/_/DotsSplashUi/data/batchexecute";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export type ArticleSignature = {
  id: string;
  timestamp: string;
  signature: string;
};

const SIGNATURE_PATTERNS = {
  id: /data-n-a-id="([^"]+)"/,
  timestamp: /data-n-a-ts="([^"]+)"/,
  signature: /data-n-a-sg="([^"]+)"/,
};

/** Extracts the three attributes the resolver RPC requires. */
export function parseArticleSignature(html: string): ArticleSignature | null {
  const id = SIGNATURE_PATTERNS.id.exec(html)?.[1];
  const timestamp = SIGNATURE_PATTERNS.timestamp.exec(html)?.[1];
  const signature = SIGNATURE_PATTERNS.signature.exec(html)?.[1];
  if (!id || !timestamp || !signature) return null;
  return { id, timestamp, signature };
}

/**
 * Builds the `f.req` payload. The nested shape mirrors what the Google News
 * page itself sends; the placeholder values are what the endpoint accepts.
 */
export function buildBatchExecuteBody(sig: ArticleSignature): string {
  const inner = JSON.stringify([
    "garturlreq",
    [
      [
        "X",
        "X",
        ["X", "X"],
        null,
        null,
        1,
        1,
        "US:en",
        null,
        1,
        null,
        null,
        null,
        null,
        null,
        0,
        1,
      ],
      "X",
      "X",
      1,
      [1, 1, 1],
      1,
      1,
      null,
      0,
      0,
      null,
      0,
    ],
    sig.id,
    Number(sig.timestamp),
    sig.signature,
  ]);
  const request = JSON.stringify([[["Fbv4je", inner, null, "generic"]]]);
  return new URLSearchParams({ "f.req": request }).toString();
}

/**
 * Pulls the publisher URL out of the RPC response. The payload is a JSON array
 * wrapped in an anti-XSSI prefix and carries `["garturlres","<url>",1]`.
 */
export function parseBatchExecuteResponse(body: string): string | null {
  const match = /\\"garturlres\\",\\"(https?:[^"\\]+)/.exec(body);
  if (!match) return null;
  try {
    return new URL(match[1].replace(/\\\//g, "/")).toString();
  } catch {
    return null;
  }
}

export type ResolverDeps = {
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
};

/**
 * Resolves one Google News URL. Returns null when any step fails, which the
 * caller treats as "keep the Google URL and mark unresolved".
 */
export async function resolveGoogleNewsUrl(
  googleUrl: string,
  { fetch, signal }: ResolverDeps,
): Promise<string | null> {
  const page = await fetchWithRetry(googleUrl, {
    fetch,
    signal,
    userAgent: USER_AGENT,
  });
  if (!page.ok) return null;

  const signature = parseArticleSignature(await page.text());
  if (!signature) return null;

  const response = await fetchWithRetry(BATCHEXECUTE_URL, {
    fetch,
    signal,
    method: "POST",
    userAgent: USER_AGENT,
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: buildBatchExecuteBody(signature),
  });
  if (!response.ok) return null;

  return parseBatchExecuteResponse(await response.text());
}
