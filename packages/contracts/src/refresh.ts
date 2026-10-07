import { z } from "zod";

export const RefreshTrigger = z.discriminatedUnion("trigger", [
  z.object({ trigger: z.literal("manual") }),
  z.object({ trigger: z.literal("schedule"), slot: z.string() }),
]);

export type RefreshTrigger = z.infer<typeof RefreshTrigger>;

export const RefreshReceipt = z.object({
  runId: z.string(),
  disposition: z.enum(["created", "reused"]),
  state: z.enum(["queued", "running"]),
});

export type RefreshReceipt = z.infer<typeof RefreshReceipt>;

export const RunPhase = z.enum([
  "collecting",
  "filtering",
  "clustering",
  "analyzing",
  "publishing",
  "notifying",
]);

export type RunPhase = z.infer<typeof RunPhase>;

export const RunProgress = z.object({
  phase: RunPhase,
  sourcesDone: z.number().int().nonnegative(),
  sourcesTotal: z.number().int().nonnegative(),
  analysesDone: z.number().int().nonnegative(),
  analysesTotal: z.number().int().nonnegative(),
});

export type RunProgress = z.infer<typeof RunProgress>;

export const RunResult = z.object({
  newArticles: z.number().int().nonnegative(),
  relevantArticles: z.number().int().nonnegative(),
  updatedEvents: z.number().int().nonnegative(),
  failedSources: z.number().int().nonnegative(),
  failedAnalyses: z.number().int().nonnegative(),
  deferredAnalyses: z.number().int().nonnegative(),
});

export type RunResult = z.infer<typeof RunResult>;

export const RunStatus = z.discriminatedUnion("state", [
  z.object({ state: z.literal("queued"), queuedAt: z.string() }),
  z.object({
    state: z.literal("running"),
    startedAt: z.string(),
    progress: RunProgress,
  }),
  z.object({
    state: z.literal("succeeded"),
    finishedAt: z.string(),
    result: RunResult,
  }),
  z.object({
    state: z.literal("partial"),
    finishedAt: z.string(),
    result: RunResult,
  }),
  z.object({ state: z.literal("failed"), finishedAt: z.string(), error: z.string() }),
]);

export type RunStatus = z.infer<typeof RunStatus>;
