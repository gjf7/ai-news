import type { DbHandle } from "../db/connection.ts";
import { latestScheduledSlot } from "./request.ts";

/**
 * The scheduler decides when a refresh is due. It runs every minute, computes
 * the current slot as `floor(now / interval)`, and triggers only when that slot
 * has not been covered yet.
 *
 * Consequences that fall out of this single rule:
 * - A process that was down for several intervals triggers once, not N times.
 * - A manual refresh does not move the timetable (it creates a run but writes
 *   no slot).
 * - A scheduled trigger arriving while a run is active merges into it.
 */

export type SchedulerDeps = {
  handle: DbHandle;
  intervalMinutes: number;
  /** Creates or reuses the run for a slot. */
  requestRefresh: (slot: number) => void;
  now?: () => Date;
};

export function currentSlot(now: Date, intervalMinutes: number): number {
  return Math.floor(now.getTime() / (intervalMinutes * 60_000));
}

export function nextScheduledAt(now: Date, intervalMinutes: number): Date {
  const intervalMs = intervalMinutes * 60_000;
  return new Date((Math.floor(now.getTime() / intervalMs) + 1) * intervalMs);
}

export function createScheduler(deps: SchedulerDeps) {
  const { handle, intervalMinutes, requestRefresh } = deps;
  const clock = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;

  const tick = () => {
    const slot = currentSlot(clock(), intervalMinutes);
    const covered = latestScheduledSlot(handle);
    if (covered === null || covered < slot) {
      requestRefresh(slot);
    }
  };

  return {
    /** Runs one check; exposed for tests. */
    tick,
    start: () => {
      // Check immediately: after a restart the first tick may be due right away.
      tick();
      timer = setInterval(tick, 60_000);
      timer.unref?.();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** Status payload helper: when the next automatic refresh is expected. */
export function describeSchedule(handle: DbHandle, intervalMinutes: number, now = new Date()) {
  return {
    nextScheduledAt: nextScheduledAt(now, intervalMinutes).toISOString(),
    lastCoveredSlot: latestScheduledSlot(handle),
  };
}
