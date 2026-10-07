import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.ts";

export type Db = BetterSQLite3Database<typeof schema>;

export type DbHandle = {
  db: Db;
  sqlite: Database.Database;
  close: () => void;
};

/**
 * Opens the SQLite file with the pragmas the design depends on:
 * WAL for concurrent readers, foreign_keys so the composite key and cascade
 * rules are enforced, and a busy timeout so a reader waits rather than
 * throwing SQLITE_BUSY.
 */
export function createDb(databasePath: string): DbHandle {
  const absolute = databasePath === ":memory:" ? databasePath : resolve(databasePath);
  if (absolute !== ":memory:") {
    mkdirSync(dirname(absolute), { recursive: true });
  }

  const sqlite = new Database(absolute);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}
