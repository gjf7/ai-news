import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";

/**
 * Daily snapshot using better-sqlite3's online backup API. This is safe to run
 * while the app is serving: it copies a consistent snapshot rather than the
 * raw file, so a concurrent WAL write cannot produce a torn backup.
 *
 * Restore: stop the app, replace app.db with a snapshot, start the app. The
 * -wal and -shm files are rebuilt automatically, so they do not need restoring.
 */

export type BackupOptions = {
  databasePath: string;
  /** Directory for snapshots; defaults to <database dir>/backups. */
  backupDir?: string;
  /** Snapshots to keep, newest first. */
  keep?: number;
  now?: Date;
};

export function backupDirectory(databasePath: string, backupDir?: string): string {
  return backupDir ?? join(dirname(databasePath), "backups");
}

function timestampSuffix(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`,
  ].join("-");
}

export async function createBackup(
  sqlite: Database.Database,
  { databasePath, backupDir, keep = 14, now = new Date() }: BackupOptions,
): Promise<string> {
  const directory = backupDirectory(databasePath, backupDir);
  mkdirSync(directory, { recursive: true });

  const target = join(directory, `app-${timestampSuffix(now)}.db`);
  await sqlite.backup(target);
  pruneBackups(directory, keep);
  return target;
}

/** Removes the oldest snapshots, keeping `keep` newest. Returns removed count. */
export function pruneBackups(directory: string, keep: number): number {
  let entries: string[];
  try {
    entries = readdirSync(directory).filter(
      (name) => name.startsWith("app-") && name.endsWith(".db"),
    );
  } catch {
    return 0;
  }

  const sorted = entries
    .map((name) => ({ name, mtime: statSync(join(directory, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const stale = sorted.slice(keep);
  for (const entry of stale) {
    rmSync(join(directory, entry.name), { force: true });
  }
  return stale.length;
}

/**
 * Schedules the backup at the next 03:00 UTC and then daily. Runs unref'd so it
 * never keeps the process alive on its own.
 */
export function scheduleBackups(
  sqlite: Database.Database,
  options: BackupOptions & { onError?: (error: unknown) => void },
): () => void {
  const run = async () => {
    try {
      await createBackup(sqlite, options);
    } catch (error) {
      options.onError?.(error);
    }
  };

  const now = Date.now();
  const next = new Date(now);
  next.setUTCHours(3, 0, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);

  const timeout = setTimeout(() => {
    void run();
    const interval = setInterval(() => void run(), 24 * 60 * 60 * 1000);
    interval.unref?.();
  }, next.getTime() - now);
  timeout.unref?.();

  return () => clearTimeout(timeout);
}
