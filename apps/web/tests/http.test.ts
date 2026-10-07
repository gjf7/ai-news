import { expect, test } from "vite-plus/test";
import { HttpError, request } from "../src/lib/http.ts";

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("request returns parsed JSON on success", async () => {
  mockFetch(() => Response.json({ authenticated: true }));
  await expect(request("/api/session")).resolves.toEqual({ authenticated: true });
});

test("request always sends JSON content-type and same-origin credentials", async () => {
  let seen: RequestInit | undefined;
  mockFetch((_url, init) => {
    seen = init;
    return Response.json({});
  });
  await request("/api/session");
  expect(new Headers(seen?.headers).get("content-type")).toBe("application/json");
  expect(seen?.credentials).toBe("same-origin");
});

test("a non-2xx response becomes an HttpError carrying the API error", async () => {
  mockFetch(
    () =>
      new Response(
        JSON.stringify({ error: { code: "invalid_credentials", message: "no", requestId: "r1" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
  );

  const error = await request("/api/session").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(401);
  expect((error as HttpError).code).toBe("invalid_credentials");
});

test("204 responses resolve to undefined rather than throwing on empty body", async () => {
  mockFetch(() => new Response(null, { status: 204 }));
  await expect(request("/api/session", { method: "DELETE" })).resolves.toBeUndefined();
});
