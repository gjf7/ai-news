import { expect, test } from "vite-plus/test";
import { fetchWithRetry, rateLimitDelayMs } from "../src/sources/http.ts";

test("a successful response is returned as-is", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const response = await fetchWithRetry("https://example.com", {
    fetch: fakeFetch,
    signal: AbortSignal.timeout(1_000),
  });
  expect(response.status).toBe(200);
  expect(calls).toBe(1);
});

test("a 429 is retried using retry-after", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(null, { status: 429, headers: { "retry-after": "0" } });
    }
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const response = await fetchWithRetry("https://example.com", {
    fetch: fakeFetch,
    signal: AbortSignal.timeout(5_000),
  });
  expect(response.status).toBe(200);
  expect(calls).toBe(2);
});

test("a 5xx is retried", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(null, { status: 503, headers: { "retry-after": "0" } });
    }
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const response = await fetchWithRetry("https://example.com", {
    fetch: fakeFetch,
    signal: AbortSignal.timeout(5_000),
  });
  expect(response.status).toBe(200);
  expect(calls).toBe(2);
});

test("a 4xx other than 429 is not retried", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return new Response("nope", { status: 404 });
  }) as typeof fetch;

  const response = await fetchWithRetry("https://example.com", {
    fetch: fakeFetch,
    signal: AbortSignal.timeout(5_000),
  });
  expect(response.status).toBe(404);
  expect(calls).toBe(1);
});

test("a network error is retried, then rethrown when it keeps failing", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    throw new Error("connection reset");
  }) as typeof fetch;

  await expect(
    fetchWithRetry("https://example.com", {
      fetch: fakeFetch,
      signal: AbortSignal.timeout(60_000),
      // Retries use a long backoff by design; the delay itself is covered by
      // the rateLimitDelayMs test, so skip the waiting here.
      backoffMs: 0,
    }),
  ).rejects.toThrow("connection reset");
  expect(calls).toBeGreaterThan(1);
});

test("an aborted signal is not retried", async () => {
  let calls = 0;
  const controller = new AbortController();
  const fakeFetch = (async () => {
    calls += 1;
    controller.abort();
    throw new DOMException("aborted", "AbortError");
  }) as typeof fetch;

  await expect(
    fetchWithRetry("https://example.com", { fetch: fakeFetch, signal: controller.signal }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

test("rate limit delay prefers retry-after, then x-ratelimit-reset, then backoff", () => {
  const withRetryAfter = new Response(null, {
    status: 429,
    headers: { "retry-after": "5" },
  });
  expect(rateLimitDelayMs(withRetryAfter, 0)).toBe(5_000);

  // Reddit sends x-ratelimit-reset instead of retry-after.
  const withReset = new Response(null, {
    status: 429,
    headers: { "x-ratelimit-reset": "30" },
  });
  expect(rateLimitDelayMs(withReset, 0)).toBe(31_000);

  const bare = new Response(null, { status: 429 });
  expect(rateLimitDelayMs(bare, 0)).toBe(2_000);
  expect(rateLimitDelayMs(bare, 1)).toBe(4_000);
});

test("the request carries a descriptive user-agent", async () => {
  let seenAgent: string | null = null;
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    seenAgent = new Headers(init?.headers).get("user-agent");
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  await fetchWithRetry("https://example.com", {
    fetch: fakeFetch,
    signal: AbortSignal.timeout(1_000),
  });
  // A browser-like UA is rate-limited harder by Reddit, so it must stay descriptive.
  expect(seenAgent).toContain("ai-news");
});
