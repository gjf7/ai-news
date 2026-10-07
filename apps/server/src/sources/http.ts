/**
 * Shared HTTP helper for source adapters.
 *
 * The design requires "单请求超时与有限重试" for every source, not just the RSS
 * ones, so the retry policy lives here and all adapters go through it.
 *
 * The default user-agent stays descriptive: Reddit rate-limits browser-like
 * user agents harder than descriptive ones, and a descriptive agent is also
 * what the aggregator-friendly feeds expect.
 */

export const DEFAULT_USER_AGENT = "ai-news/0.1 (news aggregator)";

const RETRIES = 4;
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Delay before retrying a 429. Reddit answers with `x-ratelimit-reset`
 * (seconds until the window resets) rather than `retry-after`, so both are
 * honoured; otherwise the delay doubles.
 */
export function rateLimitDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;

  const reset = Number(response.headers.get("x-ratelimit-reset"));
  // Add a small margin so the retry does not land just before the reset.
  if (Number.isFinite(reset) && reset > 0) return (reset + 1) * 1000;

  return BASE_DELAY_MS * 2 ** attempt;
}

export type FetchWithRetryOptions = {
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
  userAgent?: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Retry on 5xx as well as 429. On by default: feeds are idempotent GETs. */
  retryServerErrors?: boolean;
  /** Overrides the base backoff. Tests set 0 to avoid real waiting. */
  backoffMs?: number;
};

/**
 * Performs a request, retrying 429 (and optionally 5xx) with backoff. Network
 * errors are retried too; an AbortSignal abort is not, since the run is over.
 */
export async function fetchWithRetry(
  url: string,
  {
    fetch,
    signal,
    userAgent = DEFAULT_USER_AGENT,
    method = "GET",
    headers = {},
    body,
    retryServerErrors = true,
    backoffMs = BASE_DELAY_MS,
  }: FetchWithRetryOptions,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { "user-agent": userAgent, ...headers },
        body,
        signal,
      });
    } catch (error) {
      if (signal.aborted || attempt >= RETRIES) throw error;
      await sleep(Math.min(backoffMs * 2 ** attempt, MAX_DELAY_MS));
      continue;
    }

    const retryable = response.status === 429 || (retryServerErrors && response.status >= 500);
    if (!retryable || attempt >= RETRIES) return response;

    const delay =
      backoffMs === BASE_DELAY_MS
        ? rateLimitDelayMs(response, attempt)
        : Math.min(backoffMs * 2 ** attempt, MAX_DELAY_MS);
    await sleep(Math.min(delay, MAX_DELAY_MS));
  }
}
