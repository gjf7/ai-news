import { expect, test } from "vite-plus/test";
import { resolveRangeStart, startOfShanghaiDay } from "../src/news/queries.ts";

test("today starts at midnight in Asia/Shanghai", () => {
  // 17:30 UTC is 01:30 the next day in Shanghai.
  const now = new Date("2026-10-22T17:30:00.000Z");
  expect(startOfShanghaiDay(now).toISOString()).toBe("2026-10-22T16:00:00.000Z");
  expect(resolveRangeStart("today", now)?.toISOString()).toBe("2026-10-22T16:00:00.000Z");
});

test("24h and 7d are rolling windows; all has no lower bound", () => {
  const now = new Date("2026-10-22T17:30:00.000Z");
  expect(resolveRangeStart("24h", now)?.toISOString()).toBe("2026-10-21T17:30:00.000Z");
  expect(resolveRangeStart("7d", now)?.toISOString()).toBe("2026-10-15T17:30:00.000Z");
  expect(resolveRangeStart("all", now)).toBeNull();
});
