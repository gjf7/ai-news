import { expect, test } from "vite-plus/test";
import type { AppConfig } from "../src/config/env.ts";
import { createModelClient, type ModelUsage } from "../src/insights/model.ts";

function config(model: Partial<AppConfig["model"]>): AppConfig {
  return {
    nodeEnv: "test",
    port: 0,
    databasePath: ":memory:",
    backup: { keep: 1 },
    retention: { days: 0 },
    session: { secret: "s", ttlHours: 1, passwordHash: "h", secureCookie: false },
    refresh: {
      intervalMinutes: 30,
      runTimeoutMinutes: 1,
      analyzeMaxEvents: 1,
      filterMaxBatches: 1,
      clusterMaxBatches: 1,
    },
    notify: {
      enabled: false,
      maxItems: 1,
      minImportance: 70,
      digest: { enabled: false, hourUtc: 0, maxItems: 1, minImportance: 50 },
      alert: { enabled: false, afterFailedRuns: 1 },
      telegram: {},
    },
    model: { baseUrl: "https://api.deepseek.com", apiKey: "k", name: "m", ...model },
  };
}

function captureFetch() {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    bodies.push(JSON.parse(raw) as Record<string, unknown>);
    return Response.json({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 30,
        prompt_cache_hit_tokens: 40,
        completion_tokens_details: { reasoning_tokens: 20 },
      },
    });
  }) as unknown as typeof globalThis.fetch;
  return { bodies, fetchImpl };
}

const messages = [{ role: "user" as const, content: "hi" }];

test("a mechanical call disables thinking on the DeepSeek endpoint", async () => {
  const { bodies, fetchImpl } = captureFetch();
  const model = createModelClient(config({}), fetchImpl);

  await model.complete({
    messages,
    thinking: "disabled",
    signal: AbortSignal.timeout(1000),
  });

  expect(bodies[0]?.thinking).toEqual({ type: "disabled" });
});

test("auto omits thinking for non-DeepSeek endpoints", async () => {
  const { bodies, fetchImpl } = captureFetch();
  const model = createModelClient(config({ baseUrl: "https://api.example.com" }), fetchImpl);

  await model.complete({
    messages,
    thinking: "disabled",
    signal: AbortSignal.timeout(1000),
  });

  expect(bodies[0]).not.toHaveProperty("thinking");
});

test("an explicit environment setting overrides the endpoint check", async () => {
  const { bodies, fetchImpl } = captureFetch();
  const model = createModelClient(
    config({ baseUrl: "https://api.example.com", thinking: "disabled" }),
    fetchImpl,
  );

  await model.complete({
    messages,
    thinking: "enabled",
    signal: AbortSignal.timeout(1000),
  });

  expect(bodies[0]?.thinking).toEqual({ type: "disabled" });
});

test("usage reports prompt, cached, completion and reasoning tokens", async () => {
  const { fetchImpl } = captureFetch();
  const usages: ModelUsage[] = [];
  const model = createModelClient(config({}), fetchImpl, (usage) => usages.push(usage));

  await model.complete({
    messages,
    label: "cluster",
    thinking: "disabled",
    signal: AbortSignal.timeout(1000),
  });

  expect(usages).toEqual([
    {
      label: "cluster",
      model: "m",
      promptTokens: 100,
      completionTokens: 30,
      cachedTokens: 40,
      reasoningTokens: 20,
    },
  ]);
});
