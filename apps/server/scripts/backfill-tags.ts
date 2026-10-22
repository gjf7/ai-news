/**
 * Recomputes the derived tags for existing rows.
 *
 * Usage: pnpm --filter @ai-news/server backfill-tags [database-path]
 *
 * Articles classified before article-level tagging existed have no tags.
 * Keyword tags are filled in for those, then every event's topics are rebuilt
 * as the union of its articles' tags and its latest insight's tags. Safe to
 * rerun: it only writes derived metadata.
 */
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { articles, events } from "../src/db/schema.ts";
import { refreshEventScores } from "../src/news/scoring.ts";
import { keywordTags } from "../src/news/tags.ts";

const databasePath = process.argv[2] ?? process.env.DATABASE_PATH ?? "./data/app.db";
const handle = createDb(databasePath);

try {
  migrate(handle.sqlite);

  const rows = handle.db.select().from(articles).all();
  let changed = 0;
  handle.sqlite.transaction(() => {
    for (const row of rows) {
      if (row.topics.length > 0) continue;
      const tags = keywordTags(row.title, row.excerpt);
      if (tags.length === 0) continue;
      handle.db.update(articles).set({ topics: tags }).where(eq(articles.id, row.id)).run();
      changed += 1;
    }
  })();

  const eventIds = handle.db.select({ id: events.id }).from(events).all();
  refreshEventScores(
    handle,
    eventIds.map((row) => row.id),
  );

  const distribution = new Map<string, number>();
  for (const event of handle.db.select({ topics: events.topics }).from(events).all()) {
    for (const tag of event.topics) {
      distribution.set(tag, (distribution.get(tag) ?? 0) + 1);
    }
  }

  console.log(`Tagged ${changed} of ${rows.length} articles.`);
  console.log(`Rescored ${eventIds.length} events.`);
  console.log(
    [...distribution.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([tag, count]) => `${tag}=${count}`)
      .join(" "),
  );
} finally {
  handle.close();
}
