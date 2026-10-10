/**
 * End-to-end smoke test against real sources with a stubbed model.
 *
 * Usage: vp run server#e2e [source ...]
 *
 * Unlike the test suite this hits the live network, so it is a manual tool.
 * It exercises the whole pipeline against real data without spending model
 * tokens: classification, adjudication and insight prompts are answered
 * locally.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config/env.ts";
import { createDb } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import {
  articles,
  deliveries,
  events,
  insights,
  refreshRuns,
  sourceRuns,
} from "../src/db/schema.ts";
import type { ModelClient } from "../src/insights/model.ts";
import { requestRefresh } from "../src/refresh/request.ts";
import { createRunner } from "../src/refresh/runner.ts";
import { createSourceRegistry } from "../src/sources/registry.ts";

/** Answers the three pipeline prompts locally. */
const stubModel: ModelClient = {
  name: "stub",
  available: true,
  complete: async ({ messages }) => {
    const system = messages[0]?.content ?? "";
    const user = messages[1]?.content ?? "";

    if (system.includes("You classify news items")) {
      const count = user.split("\n").length;
      return JSON.stringify({
        results: Array.from({ length: count }, (_, index) => ({ index, relevant: true })),
      });
    }
    if (system.includes("You group news articles")) return '{"index": -1}';

    // Headline-only evidence must not carry an impact judgement.
    const headlineOnly = user.includes("本次材料全部只有标题");
    return JSON.stringify({
      title: "中文标题（e2e 桩）",
      facts: [{ text: "事实摘要", citations: ["0"] }],
      importance: { score: 75, reason: "e2e" },
      impact: headlineOnly ? null : "可能影响",
      watch: null,
      material_update: { is: true, reason: "首次" },
    });
  },
};

const dir = mkdtempSync(join(tmpdir(), "ai-news-e2e-"));
const config: AppConfig = {
  nodeEnv: "test",
  port: 0,
  databasePath: join(dir, "app.db"),
  backup: { keep: 14 },
  retention: { days: 0 },
  session: {
    secret: "e2e-secret-long-enough-value",
    ttlHours: 1,
    passwordHash: "",
    secureCookie: false,
  },
  refresh: {
    intervalMinutes: 30,
    runTimeoutMinutes: 20,
    analyzeMaxEvents: 40,
    filterMaxBatches: 8,
    clusterMaxBatches: 4,
  },
  notify: {
    enabled: false,
    maxItems: 5,
    minImportance: 70,
    digest: { enabled: false, hourUtc: 0, maxItems: 10, minImportance: 50 },
    telegram: {},
  },
  model: { baseUrl: "https://stub", apiKey: "stub", name: "stub" },
};

const handle = createDb(config.databasePath);
migrate(handle.sqlite);

const requested = process.argv.slice(2);
const registry = createSourceRegistry({ fetch: globalThis.fetch });
const definitions =
  requested.length > 0 ? registry.filter((source) => requested.includes(source.key)) : registry;

const runner = createRunner({ handle, config, definitions, model: stubModel });
requestRefresh({ trigger: "manual" }, { handle });

const started = Date.now();
await runner.runOnce();

const run = handle.db.select().from(refreshRuns).all()[0];
console.log(`\nrun: ${run?.state} in ${Date.now() - started}ms`);
console.log(`result: ${JSON.stringify(run?.result)}`);
console.log(`articles:   ${handle.db.select().from(articles).all().length}`);
console.log(`events:     ${handle.db.select().from(events).all().length}`);
console.log(`insights:   ${handle.db.select().from(insights).all().length}`);
console.log(`deliveries: ${handle.db.select().from(deliveries).all().length}`);

const failures = handle.db
  .select()
  .from(sourceRuns)
  .all()
  .filter((row) => row.state === "failed");
console.log(`failed sources: ${failures.length}`);
for (const row of failures.slice(0, 5)) {
  const source = handle.sqlite.prepare("SELECT key FROM sources WHERE id = ?").get(row.sourceId) as
    | { key: string }
    | undefined;
  console.log(`  ${source?.key ?? row.sourceId}: ${row.error?.slice(0, 90)}`);
}

for (const event of handle.db.select().from(events).all().slice(0, 3)) {
  console.log(`  [${event.analysisState}] ${event.title.slice(0, 70)}`);
}

handle.close();
