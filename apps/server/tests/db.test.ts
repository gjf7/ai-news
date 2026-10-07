import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { createDb, type DbHandle } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { refreshRuns } from "../src/db/schema.ts";

let dir: string;
let handle: DbHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-news-test-"));
  handle = createDb(join(dir, "app.db"));
  migrate(handle.sqlite);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function insertRun(overrides: Partial<typeof refreshRuns.$inferInsert> = {}) {
  handle.db
    .insert(refreshRuns)
    .values({
      id: crypto.randomUUID(),
      trigger: "manual",
      state: "queued",
      activeSlot: 1,
      queuedAt: new Date(),
      ...overrides,
    })
    .run();
}

test("migrate is idempotent", () => {
  // A second run must be a no-op rather than failing on existing tables.
  expect(() => migrate(handle.sqlite)).not.toThrow();
  const tables = handle.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => (row as { name: string }).name);
  for (const table of ["sources", "articles", "events", "insights", "refresh_runs", "deliveries"]) {
    expect(tables).toContain(table);
  }
});

test("only one run may be active at a time", () => {
  insertRun();
  expect(() => insertRun()).toThrow(/one_active_run|UNIQUE/i);
});

test("a terminal run frees the active slot for the next run", () => {
  insertRun({ id: "first" });
  handle.db
    .update(refreshRuns)
    .set({ state: "succeeded", activeSlot: null, finishedAt: new Date() })
    .run();
  expect(() => insertRun({ id: "second" })).not.toThrow();
});

test("state and active_slot cannot disagree", () => {
  // Terminal state while still holding the active slot must be rejected.
  expect(() => insertRun({ state: "succeeded" })).toThrow(/active_slot|CHECK/i);
  // Active state without the slot must be rejected too.
  expect(() => insertRun({ state: "running", activeSlot: null })).toThrow(/active_slot|CHECK/i);
});

test("foreign keys are enforced", () => {
  expect(() =>
    handle.sqlite
      .prepare(
        "INSERT INTO articles (id, canonical_url, publisher, title, title_norm, discovered_at, scope, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("a1", "https://example.com/a", "Example", "t", "t", Date.now(), "headline", "missing"),
  ).toThrow(/FOREIGN KEY/i);
});
