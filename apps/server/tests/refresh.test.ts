import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { createDb, type DbHandle } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { countActiveRuns, findActiveRun, requestRefresh } from "../src/refresh/request.ts";
import { currentSlot, nextScheduledAt } from "../src/refresh/scheduler.ts";

let dir: string;
let handle: DbHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-news-refresh-"));
  handle = createDb(join(dir, "app.db"));
  migrate(handle.sqlite);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a manual refresh creates exactly one active run", () => {
  const first = requestRefresh({ trigger: "manual" }, { handle });
  expect(first.disposition).toBe("created");
  expect(first.state).toBe("queued");
  expect(countActiveRuns(handle)).toBe(1);
});

test("a second manual refresh reuses the active run", () => {
  const first = requestRefresh({ trigger: "manual" }, { handle });
  const second = requestRefresh({ trigger: "manual" }, { handle });
  expect(second.disposition).toBe("reused");
  expect(second.runId).toBe(first.runId);
  expect(countActiveRuns(handle)).toBe(1);
});

test("concurrent refreshes still produce a single active run", () => {
  const results = Array.from({ length: 20 }, () =>
    requestRefresh({ trigger: "manual" }, { handle }),
  );
  expect(results.filter((result) => result.disposition === "created")).toHaveLength(1);
  expect(countActiveRuns(handle)).toBe(1);
});

test("a scheduled trigger records its slot on the new run", () => {
  requestRefresh({ trigger: "schedule", slot: "42" }, { handle });
  const run = findActiveRun(handle);
  expect(run?.slot).toBe(42);
});

test("a scheduled trigger merges into an active run and records the slot", () => {
  requestRefresh({ trigger: "manual" }, { handle });
  const receipt = requestRefresh({ trigger: "schedule", slot: "7" }, { handle });
  expect(receipt.disposition).toBe("reused");
  expect(findActiveRun(handle)?.slot).toBe(7);
});

test("an already covered slot does not create a run", () => {
  requestRefresh({ trigger: "schedule", slot: "10" }, { handle });
  // Finish the run so nothing is active.
  handle.sqlite
    .prepare("UPDATE refresh_runs SET state='succeeded', active_slot=NULL, finished_at=?")
    .run(Date.now());

  const receipt = requestRefresh({ trigger: "schedule", slot: "10" }, { handle });
  expect(receipt.runId).toBe("");
  expect(countActiveRuns(handle)).toBe(0);
});

test("a newer slot creates a new run after the previous one finished", () => {
  requestRefresh({ trigger: "schedule", slot: "10" }, { handle });
  handle.sqlite
    .prepare("UPDATE refresh_runs SET state='succeeded', active_slot=NULL, finished_at=?")
    .run(Date.now());

  const receipt = requestRefresh({ trigger: "schedule", slot: "11" }, { handle });
  expect(receipt.disposition).toBe("created");
});

test("currentSlot is stable within an interval and advances across one", () => {
  const interval = 30;
  const base = new Date("2026-10-06T12:00:00Z");
  const sameSlot = new Date("2026-10-06T12:29:00Z");
  const nextSlot = new Date("2026-10-06T12:31:00Z");

  expect(currentSlot(base, interval)).toBe(currentSlot(sameSlot, interval));
  expect(currentSlot(nextSlot, interval)).toBe(currentSlot(base, interval) + 1);
});

test("nextScheduledAt lands on the next interval boundary", () => {
  const next = nextScheduledAt(new Date("2026-10-06T12:05:00Z"), 30);
  expect(next.toISOString()).toBe("2026-10-06T12:30:00.000Z");
});
