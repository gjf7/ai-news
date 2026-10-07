import { and, desc, eq, inArray, isNotNull, max } from "drizzle-orm";
import type { RefreshReceipt, RefreshTrigger } from "@ai-news/contracts";
import type { DbHandle } from "../db/connection.ts";
import { newId } from "../db/ids.ts";
import { refreshRuns } from "../db/schema.ts";

/**
 * Creates or reuses the single active refresh run.
 *
 * The `one_active_run` partial unique index is the arbiter: an INSERT either
 * succeeds (no active run) or conflicts (an active run exists). This replaces
 * a queue and any cross-process claim protocol.
 *
 * A scheduled trigger additionally records which slot it covered. If a run is
 * already active, the slot is written onto that run, which is what makes
 * "a manual refresh does not move the timetable" and "several missed slots
 * collapse into one" fall out of the same mechanism.
 */

export type RequestDeps = {
  handle: DbHandle;
  /** Called after a run is created so the runner can pick it up immediately. */
  onCreated?: (runId: string) => void;
};

export function requestRefresh(
  trigger: RefreshTrigger,
  { handle, onCreated }: RequestDeps,
): RefreshReceipt {
  const slot = trigger.trigger === "schedule" ? Number(trigger.slot) : null;

  // A slot at or before the newest covered slot needs no new run. If something
  // is already running, report it; otherwise this is a no-op.
  if (slot !== null && slot <= (latestScheduledSlot(handle) ?? -Infinity)) {
    const active = findActiveRun(handle);
    if (!active) return { runId: "", disposition: "reused", state: "queued" };
    return {
      runId: active.id,
      disposition: "reused",
      state: active.state === "running" ? "running" : "queued",
    };
  }

  const inserted = handle.db
    .insert(refreshRuns)
    .values({
      id: newId(),
      trigger: trigger.trigger,
      slot,
      state: "queued",
      activeSlot: 1,
      queuedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: refreshRuns.id })
    .get();

  if (inserted) {
    onCreated?.(inserted.id);
    return { runId: inserted.id, disposition: "created", state: "queued" };
  }

  const active = findActiveRun(handle);
  if (!active) {
    // The active run finished between the INSERT and this read. Retry once.
    return requestRefresh(trigger, { handle, onCreated });
  }

  // Record the covered slot on the run that is already in flight.
  if (slot !== null && (active.slot === null || active.slot < slot)) {
    handle.db
      .update(refreshRuns)
      .set({ slot })
      .where(and(eq(refreshRuns.id, active.id), inArray(refreshRuns.state, ["queued", "running"])))
      .run();
  }

  return {
    runId: active.id,
    disposition: "reused",
    state: active.state === "running" ? "running" : "queued",
  };
}

export function findActiveRun(handle: DbHandle) {
  return handle.db
    .select()
    .from(refreshRuns)
    .where(inArray(refreshRuns.state, ["queued", "running"]))
    .limit(1)
    .get();
}

/** Most recent run that reached a terminal state; used for the first-run silence. */
export function latestFinishedRun(handle: DbHandle) {
  return handle.db
    .select()
    .from(refreshRuns)
    .where(inArray(refreshRuns.state, ["succeeded", "partial", "failed"]))
    .orderBy(desc(refreshRuns.finishedAt))
    .limit(1)
    .get();
}

export function latestScheduledSlot(handle: DbHandle): number | null {
  const row = handle.db
    .select({ value: max(refreshRuns.slot) })
    .from(refreshRuns)
    .where(isNotNull(refreshRuns.slot))
    .get();
  return row?.value ?? null;
}

/** Drops finished runs beyond `keep`, always preserving the newest slotted run. */
export function pruneRuns(handle: DbHandle, keep = 200): number {
  const newestSlotted = handle.db
    .select({ id: refreshRuns.id })
    .from(refreshRuns)
    .where(isNotNull(refreshRuns.slot))
    .orderBy(desc(refreshRuns.slot))
    .limit(1)
    .get();

  const stale = handle.db
    .select({ id: refreshRuns.id })
    .from(refreshRuns)
    .where(inArray(refreshRuns.state, ["succeeded", "partial", "failed"]))
    .orderBy(desc(refreshRuns.finishedAt))
    .all()
    .slice(keep)
    .filter((row) => row.id !== newestSlotted?.id)
    .map((row) => row.id);

  if (stale.length === 0) return 0;
  handle.db.delete(refreshRuns).where(inArray(refreshRuns.id, stale)).run();
  return stale.length;
}

/** Raw count of active runs; used by tests and the status endpoint. */
export function countActiveRuns(handle: DbHandle): number {
  const row = handle.sqlite
    .prepare("SELECT count(*) AS c FROM refresh_runs WHERE active_slot IS NOT NULL")
    .get() as { c: number };
  return row.c;
}
