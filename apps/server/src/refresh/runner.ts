import { and, eq } from "drizzle-orm";
import type { RunProgress, RunResult } from "@ai-news/contracts";
import type { AppConfig } from "../config/env.ts";
import type { DbHandle } from "../db/connection.ts";
import { refreshRuns, sourceRuns } from "../db/schema.ts";
import type { ModelClient } from "../insights/model.ts";
import { runAnalysis } from "./analyze.ts";
import { runClustering } from "../news/clustering.ts";
import { runFiltering } from "../news/filtering.ts";
import { allEventIds, refreshEventScores } from "../news/scoring.ts";
import { deliverDue, runNotificationFreeze, type SendFn } from "../notifications/telegram.ts";
import { beginSourceRuns, runIngest, syncSources } from "./ingest.ts";
import { latestFinishedRun, pruneRuns, requestRefresh } from "./request.ts";
import type { SourceDefinition } from "../sources/registry.ts";

/**
 * The refresh runner. One process owns the database, so runs execute serially
 * and there is no claim protocol beyond the active-run index.
 *
 * Every checkpoint write carries `attempt` and `state` guards: if the run was
 * superseded (a restart reset it to queued, or another attempt took over), the
 * write affects no rows and the runner stops instead of committing stale work.
 */

export type RunnerDeps = {
  handle: DbHandle;
  config: AppConfig;
  definitions: SourceDefinition[];
  model: ModelClient;
  send?: SendFn;
  /** Overall deadline for one run. */
  timeoutMs?: number;
};

export type Runner = {
  /** Wakes the runner for a specific run, or the next queued one. */
  wake: (runId?: string) => void;
  /** Runs one queued run synchronously (used by tests and manual refresh). */
  runOnce: () => Promise<void>;
  start: () => void;
  stop: () => void;
  /** Exposed for the scheduler: creates or reuses the active run. */
  requestRefresh: (slot: number) => void;
};

export function createRunner(deps: RunnerDeps): Runner {
  const { handle, config, definitions, model, send } = deps;
  const timeoutMs = deps.timeoutMs ?? config.refresh.runTimeoutMinutes * 60_000;
  let running = false;
  let scheduled: NodeJS.Timeout | undefined;
  let deliveryTimer: NodeJS.Timeout | undefined;
  let wakeResolve: (() => void) | undefined;

  const notify = () => {
    wakeResolve?.();
    wakeResolve = undefined;
  };

  const requestRefreshWithWake = (slot: number) => {
    requestRefresh(
      { trigger: "schedule", slot: String(slot) },
      { handle, onCreated: () => notify() },
    );
  };

  const runOnce = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // Recover runs left in `running` by a crash: attempt >= 3 is a failure.
      const stranded = handle.db
        .select()
        .from(refreshRuns)
        .where(eq(refreshRuns.state, "running"))
        .all();
      for (const run of stranded) {
        if (run.attempt >= 3) {
          handle.db
            .update(refreshRuns)
            .set({
              state: "failed",
              activeSlot: null,
              error: "exceeded attempt limit",
              finishedAt: new Date(),
            })
            .where(eq(refreshRuns.id, run.id))
            .run();
        } else {
          handle.db
            .update(refreshRuns)
            .set({ state: "queued", activeSlot: 1 })
            .where(eq(refreshRuns.id, run.id))
            .run();
        }
      }

      const claimed = claimNextRun(handle);
      if (claimed) await executeRun(claimed);
    } finally {
      running = false;
    }
  };

  const executeRun = async (run: { id: string; attempt: number }): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const isCurrent = () => {
      const row = handle.db
        .select({ state: refreshRuns.state, attempt: refreshRuns.attempt })
        .from(refreshRuns)
        .where(eq(refreshRuns.id, run.id))
        .get();
      return row?.state === "running" && row.attempt === run.attempt;
    };

    const setProgress = (progress: RunProgress) => {
      handle.db
        .update(refreshRuns)
        .set({ progress: progress as never })
        .where(and(eq(refreshRuns.id, run.id), eq(refreshRuns.attempt, run.attempt)))
        .run();
    };

    try {
      syncSources(handle, definitions);
      beginSourceRuns(handle, run.id);

      setProgress({
        phase: "collecting",
        sourcesDone: 0,
        sourcesTotal: definitions.length,
        analysesDone: 0,
        analysesTotal: 0,
      });
      const ingest = await runIngest({
        handle,
        definitions,
        runId: run.id,
        attempt: run.attempt,
        isCurrent,
      });
      if (!isCurrent()) return;

      const sourcesTotal = handle.db
        .select()
        .from(sourceRuns)
        .where(eq(sourceRuns.runId, run.id))
        .all().length;

      setProgress({
        phase: "filtering",
        sourcesDone: sourcesTotal,
        sourcesTotal,
        analysesDone: 0,
        analysesTotal: 0,
      });
      await runFiltering({
        handle,
        model,
        signal: controller.signal,
        maxModelBatches: config.refresh.filterMaxBatches,
      });
      if (!isCurrent()) return;

      setProgress({
        phase: "clustering",
        sourcesDone: sourcesTotal,
        sourcesTotal,
        analysesDone: 0,
        analysesTotal: 0,
      });
      const clustered = await runClustering({
        handle,
        model,
        signal: controller.signal,
        maxModelBatches: config.refresh.clusterMaxBatches,
      });
      if (!isCurrent()) return;

      refreshEventScores(handle, allEventIds(handle));

      setProgress({
        phase: "analyzing",
        sourcesDone: sourcesTotal,
        sourcesTotal,
        analysesDone: 0,
        analysesTotal: 0,
      });
      const analysis = await runAnalysis({
        handle,
        model,
        runId: run.id,
        signal: controller.signal,
        maxEvents: config.refresh.analyzeMaxEvents,
      });
      if (!isCurrent()) return;

      setProgress({
        phase: "publishing",
        sourcesDone: sourcesTotal,
        sourcesTotal,
        analysesDone: analysis.analyzed + analysis.reused,
        analysesTotal: analysis.analyzed + analysis.reused + analysis.deferred,
      });

      setProgress({
        phase: "notifying",
        sourcesDone: sourcesTotal,
        sourcesTotal,
        analysesDone: analysis.analyzed + analysis.reused,
        analysesTotal: analysis.analyzed + analysis.reused,
      });
      const firstRun = !latestFinishedRun(handle);
      const notify = runNotificationFreeze({
        handle,
        runId: run.id,
        config: {
          ...config.notify,
          chatId: config.notify.telegram.chatId,
          botToken: config.notify.telegram.botToken,
        },
        firstRun,
      });
      if (send) await deliverDue(handle, send);

      const failed = handle.db
        .select()
        .from(sourceRuns)
        .where(and(eq(sourceRuns.runId, run.id), eq(sourceRuns.state, "failed")))
        .all().length;

      const result: RunResult = {
        newArticles: ingest.newArticles,
        relevantArticles: ingest.fetched,
        updatedEvents: clustered.newEvents + clustered.attachedToExisting,
        failedSources: failed,
        failedAnalyses: analysis.failed,
        deferredAnalyses: analysis.deferred + clustered.deferred,
      };

      const state = computeRunState({
        failedSources: failed,
        sourcesTotal,
        failedAnalyses: analysis.failed,
      });

      finishRun(handle, run, state, result, notify.reason);
      pruneRuns(handle);
    } catch (error) {
      finishRun(handle, run, "failed", undefined, String(error));
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Drains due deliveries independently of a refresh run. Backoff windows
   * expire between runs, so the notifying stage alone would leave a failed
   * delivery waiting up to a full interval.
   */
  const drainDeliveries = async () => {
    if (!send) return;
    try {
      await deliverDue(handle, send);
    } catch {
      // A delivery failure must never break the runner loop.
    }
  };

  return {
    wake: () => notify(),
    runOnce,
    requestRefresh: requestRefreshWithWake,
    start: () => {
      // Drain any queued run, then keep watching for wakes and due deliveries.
      const tick = async () => {
        await runOnce();
        await drainDeliveries();
        scheduled = setTimeout(tick, 2_000);
      };
      scheduled = setTimeout(tick, 0);

      // Delivery retries are checked once a minute, matching the schedule the
      // design describes (the notifying stage, plus a per-minute sweep).
      deliveryTimer = setInterval(() => void drainDeliveries(), 60_000);
      deliveryTimer.unref?.();
    },
    stop: () => {
      if (scheduled) clearTimeout(scheduled);
      if (deliveryTimer) clearInterval(deliveryTimer);
      scheduled = undefined;
      deliveryTimer = undefined;
    },
  };
}

/**
 * Run outcome: sources and analyses must all succeed for `succeeded`; any
 * failure with at least one source having produced results is `partial`; a
 * total source failure is `failed`.
 */
export function computeRunState({
  failedSources,
  sourcesTotal,
  failedAnalyses,
}: {
  failedSources: number;
  sourcesTotal: number;
  failedAnalyses: number;
}): "succeeded" | "partial" | "failed" {
  if (failedSources >= sourcesTotal && sourcesTotal > 0) return "failed";
  if (failedSources > 0 || failedAnalyses > 0) return "partial";
  return "succeeded";
}

/** Atomically claims the oldest queued run. */
function claimNextRun(handle: DbHandle): { id: string; attempt: number } | undefined {
  const claimed = handle.sqlite
    .prepare(
      `UPDATE refresh_runs
       SET state = 'running', attempt = attempt + 1, started_at = ?
       WHERE id = (
         SELECT id FROM refresh_runs WHERE state = 'queued' ORDER BY queued_at LIMIT 1
       )
       RETURNING id, attempt`,
    )
    .get(Date.now()) as { id: string; attempt: number } | undefined;
  return claimed;
}

function finishRun(
  handle: DbHandle,
  run: { id: string; attempt: number },
  state: "succeeded" | "partial" | "failed",
  result: RunResult | undefined,
  note: string | undefined,
): void {
  const patch: Record<string, unknown> = {
    state,
    activeSlot: null,
    finishedAt: new Date(),
    error: state === "failed" ? (note ?? null) : null,
  };
  if (result) patch.result = result;

  handle.db
    .update(refreshRuns)
    .set(patch as never)
    .where(and(eq(refreshRuns.id, run.id), eq(refreshRuns.attempt, run.attempt)))
    .run();
}
