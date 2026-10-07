import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { createDb, type DbHandle } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { backupDirectory, createBackup, pruneBackups } from "../src/db/backup.ts";
import { events } from "../src/db/schema.ts";

let dir: string;
let handle: DbHandle;
let databasePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-news-backup-"));
  databasePath = join(dir, "app.db");
  handle = createDb(databasePath);
  migrate(handle.sqlite);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedEvent(id: string) {
  const now = new Date();
  handle.db
    .insert(events)
    .values({
      id,
      title: `Event ${id}`,
      topics: [],
      kind: "news",
      firstSeenAt: now,
      lastArticleAt: now,
      effectiveTime: now,
      hotScore: 0,
      analysisState: "pending",
      notificationRevision: 0,
      notifiedRevision: 0,
      updatedAt: now,
    })
    .run();
}

test("a backup is written next to the database by default", async () => {
  seedEvent("e1");
  const target = await createBackup(handle.sqlite, { databasePath });

  expect(existsSync(target)).toBe(true);
  expect(target.startsWith(backupDirectory(databasePath))).toBe(true);
});

test("the snapshot contains the data written before it", async () => {
  seedEvent("e1");
  const target = await createBackup(handle.sqlite, { databasePath });

  // Open the snapshot as an independent database and read it back.
  const restored = createDb(target);
  const rows = restored.db.select().from(events).all();
  expect(rows.map((row) => row.id)).toEqual(["e1"]);
  restored.close();
});

test("a backup taken while a write happens is still consistent", async () => {
  seedEvent("e1");
  // The online backup API copies a consistent view even with an open WAL.
  const target = await createBackup(handle.sqlite, { databasePath });
  seedEvent("e2");

  const restored = createDb(target);
  expect(restored.db.select().from(events).all()).toHaveLength(1);
  restored.close();

  // The live database still has both.
  expect(handle.db.select().from(events).all()).toHaveLength(2);
});

test("only the newest snapshots are kept", async () => {
  const backupDir = join(dir, "backups");
  // Create the snapshots through the real path so pruning sees real files.
  for (let index = 0; index < 5; index += 1) {
    await createBackup(handle.sqlite, {
      databasePath,
      backupDir,
      keep: 100,
      now: new Date(Date.UTC(2026, 0, index + 1, 0, 0, 0)),
    });
  }
  expect(readdirSync(backupDir)).toHaveLength(5);

  const removed = pruneBackups(backupDir, 2);
  expect(removed).toBe(3);
  expect(readdirSync(backupDir)).toHaveLength(2);
});

test("pruning a missing directory is a no-op", () => {
  expect(pruneBackups(join(dir, "nope"), 5)).toBe(0);
});

test("creating backups keeps only the configured number", async () => {
  const backupDir = join(dir, "snapshots");
  for (let index = 0; index < 4; index += 1) {
    await createBackup(handle.sqlite, {
      databasePath,
      backupDir,
      keep: 2,
      now: new Date(Date.UTC(2026, 0, index + 1, 0, 0, 0)),
    });
  }
  expect(readdirSync(backupDir).length).toBe(2);
});
