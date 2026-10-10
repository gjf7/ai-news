/**
 * Calibration harness for the tunable per-run limits.
 *
 * Usage: vp run server#calibrate [runs]
 *
 * Runs the pipeline repeatedly against real sources with a stubbed model and
 * reports, per run, how much work actually arrives. The first run is an initial
 * burst; later runs approximate steady state (one interval's worth of news),
 * which is what `maxEvents` and `maxModelBatches` have to cover.
 *
 * It also reports keyword-filter outcomes so the term list can be judged
 * against real headlines.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config/env.ts";
import { createDb } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { articles, events, insights, refreshRuns } from "../src/db/schema.ts";
import type { ModelClient } from "../src/insights/model.ts";
import { classifyByKeywords } from "../src/news/filtering.ts";
import { requestRefresh } from "../src/refresh/request.ts";
import { createRunner } from "../src/refresh/runner.ts";
import { createSourceRegistry } from "../src/sources/registry.ts";

const runs = Number(process.argv[2] ?? 2);

let modelCalls = 0;
const stubModel: ModelClient = {
  name: "stub",
  available: true,
  complete: async ({ messages }) => {
    modelCalls += 1;
    const system = messages[0]?.content ?? "";
    const user = messages[1]?.content ?? "";
    if (system.includes("You classify news items")) {
      const count = user.split("\n").length;
      return JSON.stringify({
        results: Array.from({ length: count }, (_, index) => ({ index, relevant: true })),
      });
    }
    if (system.includes("You group news articles")) return '{"index": -1}';
    const headlineOnly = user.includes("本次材料全部只有标题");
    return JSON.stringify({
      title: "中文标题（校准桩）",
      facts: [{ text: "事实摘要", citations: ["0"] }],
      importance: { score: 75, reason: "calibration" },
      impact: headlineOnly ? null : "可能影响",
      watch: null,
      material_update: { is: true, reason: "首次" },
    });
  },
};

const dir = mkdtempSync(join(tmpdir(), "ai-news-cal-"));
const config: AppConfig = {
  nodeEnv: "test",
  port: 0,
  databasePath: join(dir, "app.db"),
  backup: { keep: 14 },
  retention: { days: 0 },
  session: {
    secret: "calibration-secret-value",
    ttlHours: 1,
    passwordHash: "",
    secureCookie: false,
  },
  refresh: {
    intervalMinutes: 30,
    runTimeoutMinutes: 20,
    // Overridable so the effect of each limit can be measured directly.
    analyzeMaxEvents: Number(process.env.ANALYZE_MAX_EVENTS ?? 40),
    filterMaxBatches: Number(process.env.FILTER_MAX_BATCHES ?? 8),
    clusterMaxBatches: Number(process.env.CLUSTER_MAX_BATCHES ?? 4),
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

const definitions = createSourceRegistry({ fetch: globalThis.fetch });
const runner = createRunner({ handle, config, definitions, model: stubModel });

console.log(`calibrating over ${runs} run(s) against live sources\n`);
console.log(
  `${"run".padStart(3)}${"articles".padStart(10)}${"newEvents".padStart(11)}${"insights".padStart(10)}${"modelCalls".padStart(12)}${"ms".padStart(8)}  state`,
);

for (let index = 1; index <= runs; index += 1) {
  const before = {
    articles: handle.db.select().from(articles).all().length,
    events: handle.db.select().from(events).all().length,
    insights: handle.db.select().from(insights).all().length,
  };
  modelCalls = 0;

  requestRefresh({ trigger: "manual" }, { handle });
  const started = Date.now();
  await runner.runOnce();
  const elapsed = Date.now() - started;

  const after = {
    articles: handle.db.select().from(articles).all().length,
    events: handle.db.select().from(events).all().length,
    insights: handle.db.select().from(insights).all().length,
  };
  const run = handle.db.select().from(refreshRuns).all().at(-1);

  console.log(
    `${String(index).padStart(3)}${String(after.articles - before.articles).padStart(10)}${String(
      after.events - before.events,
    ).padStart(
      11,
    )}${String(after.insights - before.insights).padStart(10)}${String(modelCalls).padStart(12)}${String(
      elapsed,
    ).padStart(8)}  ${run?.state}`,
  );
}

// Keyword filter outcomes over the collected headlines.
const rows = handle.db.select().from(articles).all();
const buckets = { relevant: 0, irrelevant: 0, unknown: 0 };
for (const row of rows) {
  buckets[classifyByKeywords(row.title, row.excerpt)] += 1;
}

console.log(`\nkeyword filter over ${rows.length} collected articles:`);
console.log(`  relevant:   ${buckets.relevant}`);
console.log(`  irrelevant: ${buckets.irrelevant}`);
console.log(`  undecided:  ${buckets.unknown}  (these need the model)`);

const eventRows = handle.db.select().from(events).all();
const byState = eventRows.reduce<Record<string, number>>((acc, row) => {
  acc[row.analysisState] = (acc[row.analysisState] ?? 0) + 1;
  return acc;
}, {});
console.log(`\nevents by analysis state: ${JSON.stringify(byState)}`);

handle.close();
