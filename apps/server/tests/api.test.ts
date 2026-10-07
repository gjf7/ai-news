import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { buildApp, type BuiltApp } from "../src/app.ts";
import { hashPassword } from "../src/api/auth/password.ts";
import type { AppConfig } from "../src/config/env.ts";

let dir: string;
let built: BuiltApp;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ai-news-api-"));
  const config: AppConfig = {
    nodeEnv: "test",
    port: 0,
    databasePath: join(dir, "app.db"),
    backup: { keep: 14 },
    session: {
      secret: "test-secret-value-that-is-long-enough",
      ttlHours: 1,
      passwordHash: await hashPassword("s3cret"),
      secureCookie: false,
    },
    refresh: {
      intervalMinutes: 30,
      runTimeoutMinutes: 20,
      analyzeMaxEvents: 40,
      filterMaxBatches: 8,
      clusterMaxBatches: 4,
    },
    notify: {
      enabled: false,
      maxItems: 5,
      minImportance: 70,
      telegram: {},
    },
    model: { baseUrl: "https://api.deepseek.com", name: "deepseek-chat" },
  };
  built = await buildApp({ config, startBackground: false });
});

afterEach(async () => {
  await built.close();
  rmSync(dir, { recursive: true, force: true });
});

test("health reports ok when the database responds", async () => {
  const response = await built.app.inject({ method: "GET", url: "/api/health" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: "ok", database: "ok" });
});

test("unauthenticated session state is reported as false", async () => {
  const response = await built.app.inject({ method: "GET", url: "/api/session" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ authenticated: false });
});

test("login issues a session cookie that authenticates later requests", async () => {
  const login = await built.app.inject({
    method: "POST",
    url: "/api/session",
    payload: { password: "s3cret" },
  });
  expect(login.statusCode).toBe(201);

  const cookie = login.cookies[0];
  expect(cookie?.name).toBe("ai_news_session");
  expect(cookie?.httpOnly).toBe(true);

  const session = await built.app.inject({
    method: "GET",
    url: "/api/session",
    cookies: { ai_news_session: cookie!.value },
  });
  expect(session.json()).toEqual({ authenticated: true });
});

test("login rejects a wrong password without issuing a cookie", async () => {
  const login = await built.app.inject({
    method: "POST",
    url: "/api/session",
    payload: { password: "nope" },
  });
  expect(login.statusCode).toBe(401);
  expect(login.cookies).toHaveLength(0);
});

test("logout revokes the server-side session", async () => {
  const login = await built.app.inject({
    method: "POST",
    url: "/api/session",
    payload: { password: "s3cret" },
  });
  const token = login.cookies[0]!.value;

  const logout = await built.app.inject({
    method: "DELETE",
    url: "/api/session",
    cookies: { ai_news_session: token },
  });
  expect(logout.statusCode).toBe(204);

  const session = await built.app.inject({
    method: "GET",
    url: "/api/session",
    cookies: { ai_news_session: token },
  });
  expect(session.json()).toEqual({ authenticated: false });
});

test("login is rate limited after repeated failures", async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await built.app.inject({
      method: "POST",
      url: "/api/session",
      payload: { password: "nope" },
    });
  }
  const blocked = await built.app.inject({
    method: "POST",
    url: "/api/session",
    payload: { password: "s3cret" },
  });
  expect(blocked.statusCode).toBe(429);
});
