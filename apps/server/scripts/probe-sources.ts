/**
 * Runs every registered source adapter against the live network and prints a
 * report. This is the tool behind plan step 2 ("来源可行性验证") and step 8
 * ("其余来源逐个验证"). It makes real requests, so it is not part of the test
 * suite.
 *
 * Usage: vp run server#probe-sources [source ...]
 */
import { createSourceRegistry } from "../src/sources/registry.ts";

const registry = createSourceRegistry({
  fetch: globalThis.fetch,
  productHuntToken: process.env.PRODUCTHUNT_API_TOKEN,
});

const requested = process.argv.slice(2);
const selected =
  requested.length > 0 ? registry.filter((source) => requested.includes(source.key)) : registry;

if (selected.length === 0) {
  console.error(`No matching sources. Available: ${registry.map((s) => s.key).join(", ")}`);
  process.exit(1);
}

type Row = {
  key: string;
  articles: number;
  publishers: number;
  failed: number;
  ms: number;
  note: string;
};

const rows: Row[] = [];

for (const source of selected) {
  const started = Date.now();
  try {
    const { articles, warnings } = await source.adapter.fetch(AbortSignal.timeout(60_000));
    const attempted = articles.filter((article) => article.resolveAttempted);
    const failed = attempted.filter((article) => article.unresolved);
    const publishers = new Set(articles.map((article) => article.publisher));
    const withExcerpt = articles.filter((article) => article.excerpt).length;

    rows.push({
      key: source.key,
      articles: articles.length,
      publishers: publishers.size,
      failed: failed.length,
      ms: Date.now() - started,
      note: `${withExcerpt} with excerpt${source.analyze ? "" : " (no insights)"}`,
    });

    console.log(`\n=== ${source.key} ===`);
    console.log(`  articles:    ${articles.length}  (${withExcerpt} with excerpt)`);
    console.log(`  publishers:  ${publishers.size}`);
    if (attempted.length > 0) {
      console.log(`  resolved:    ${attempted.length - failed.length}/${attempted.length}`);
    }
    console.log(`  elapsed:     ${Date.now() - started}ms`);
    if (warnings.length > 0) {
      console.log(`  warnings:`);
      for (const warning of warnings.slice(0, 3)) console.log(`    - ${warning}`);
    }
    for (const article of articles.slice(0, 3)) {
      console.log(`    [${article.publisher}] ${article.title.slice(0, 62)}`);
      console.log(`        ${article.url.slice(0, 96)}`);
    }
  } catch (error) {
    rows.push({
      key: source.key,
      articles: 0,
      publishers: 0,
      failed: 0,
      ms: Date.now() - started,
      note: "FAILED",
    });
    console.log(`\n=== ${source.key} ===\n  FAILED: ${String(error)}`);
  }
}

console.log("\n\n=== summary ===");
console.log(
  `${"source".padEnd(18)}${"articles".padStart(9)}${"publishers".padStart(12)}${"ms".padStart(8)}  note`,
);
for (const row of rows) {
  console.log(
    `${row.key.padEnd(18)}${String(row.articles).padStart(9)}${String(row.publishers).padStart(12)}${String(row.ms).padStart(8)}  ${row.note}`,
  );
}
