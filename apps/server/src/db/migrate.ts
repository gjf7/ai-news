import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Applies the SQL migration files in filename order, recording each in
 * `_migrations` so re-running is a no-op. A single process owns the database,
 * so there is no concurrent-migration race to guard against.
 *
 * Each file runs inside its own transaction: either the whole migration is
 * recorded as applied, or nothing is. Statements are executed one by one
 * because better-sqlite3's `exec` does not report partial progress.
 */
export function migrate(sqlite: Database.Database): string[] {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );

  const applied = new Set(
    sqlite
      .prepare("SELECT name FROM _migrations")
      .all()
      .map((row) => (row as { name: string }).name),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const justApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), "utf8");
    const run = sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite
        .prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)")
        .run(file, Date.now());
    });
    run();
    justApplied.push(file);
  }

  return justApplied;
}
