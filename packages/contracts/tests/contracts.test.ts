import { expect, test } from "vite-plus/test";
import { Evidence, HealthStatus, RefreshTrigger } from "../src/index.ts";

test("RefreshTrigger accepts manual and scheduled triggers", () => {
  expect(RefreshTrigger.parse({ trigger: "manual" })).toEqual({ trigger: "manual" });
  expect(RefreshTrigger.parse({ trigger: "schedule", slot: "2026-10-06T12:30:00Z" })).toEqual({
    trigger: "schedule",
    slot: "2026-10-06T12:30:00Z",
  });
});

test("RefreshTrigger rejects an unknown trigger", () => {
  expect(RefreshTrigger.safeParse({ trigger: "cron" }).success).toBe(false);
});

test("Evidence has no fulltext scope", () => {
  const fulltext = { scope: "fulltext", title: "t", text: "body" };
  expect(Evidence.safeParse(fulltext).success).toBe(false);
  expect(Evidence.parse({ scope: "excerpt", title: "t", excerpt: "e" })).toEqual({
    scope: "excerpt",
    title: "t",
    excerpt: "e",
  });
});

test("HealthStatus rejects negative uptime", () => {
  expect(HealthStatus.safeParse({ status: "ok", database: "ok", uptimeSeconds: -1 }).success).toBe(
    false,
  );
});
