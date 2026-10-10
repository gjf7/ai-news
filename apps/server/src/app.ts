import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { registerAuthRoutes, createLoginThrottle } from "./api/auth/routes.ts";
import { createSessionStore } from "./api/auth/session.ts";
import { registerHealthRoutes } from "./api/health.ts";
import { registerApiRoutes } from "./api/routes.ts";
import { registerStatic } from "./api/static.ts";
import { loadConfig, publicConfig, type AppConfig } from "./config/env.ts";
import { createDb, type DbHandle } from "./db/connection.ts";
import { migrate } from "./db/migrate.ts";
import { scheduleBackups } from "./db/backup.ts";
import { scheduleRetention } from "./db/retention.ts";
import { createModelClient, type ModelClient } from "./insights/model.ts";
import { createTelegramSender, type SendFn } from "./notifications/telegram.ts";
import { createRunner, type Runner } from "./refresh/runner.ts";
import { createScheduler } from "./refresh/scheduler.ts";
import { createSourceRegistry } from "./sources/registry.ts";

export type BuiltApp = {
  app: FastifyInstance;
  handle: DbHandle;
  runner: Runner;
  scheduler: ReturnType<typeof createScheduler>;
  model: ModelClient;
  close: () => Promise<void>;
};

export type BuildOptions = {
  config?: AppConfig;
  /** Injected in tests to avoid real network calls. */
  fetch?: typeof globalThis.fetch;
  send?: SendFn;
  startBackground?: boolean;
};

export async function buildApp(options: BuildOptions = {}): Promise<BuiltApp> {
  const config = options.config ?? loadConfig();
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const handle = createDb(config.databasePath);
  migrate(handle.sqlite);

  const app = Fastify({
    logger: {
      level: config.nodeEnv === "test" ? "silent" : "info",
      redact: ["req.headers.cookie", "req.headers.authorization"],
    },
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(cookie);

  const sessions = createSessionStore(handle, config);
  const throttle = createLoginThrottle();
  const isAuthenticated = (request: Parameters<typeof sessions.resolve>[0]) =>
    sessions.resolve(request);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: error.issues[0]?.message ?? "Invalid request",
          requestId: request.id,
        },
      });
    }

    // Fastify raises this for a JSON content-type with an empty body. It is a
    // malformed client request, not a server fault, so answer 400 rather than
    // letting the generic branch report a 500.
    if ((error as { code?: string }).code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: "Request body is required",
          requestId: request.id,
        },
      });
    }

    const status = (error as { statusCode?: number }).statusCode;
    if (status === 401) {
      return reply.code(401).send({
        error: { code: "unauthorized", message: "Authentication required", requestId: request.id },
      });
    }
    if (status === 403) {
      return reply.code(403).send({
        error: { code: "forbidden", message: "Cross-origin write rejected", requestId: request.id },
      });
    }

    request.log.error({ err: error }, "unhandled error");
    return reply.code(500).send({
      error: { code: "internal_error", message: "Internal server error", requestId: request.id },
    });
  });

  const model = createModelClient(config, fetchImpl);
  let stopBackups: (() => void) | undefined;
  let stopRetention: (() => void) | undefined;
  const definitions = createSourceRegistry({
    fetch: fetchImpl,
    productHuntToken: process.env.PRODUCTHUNT_API_TOKEN,
  });
  const send =
    options.send ??
    (config.notify.telegram.botToken
      ? createTelegramSender(config.notify.telegram.botToken, fetchImpl)
      : undefined);

  const runner = createRunner({ handle, config, definitions, model, send });
  const scheduler = createScheduler({
    handle,
    intervalMinutes: config.refresh.intervalMinutes,
    requestRefresh: runner.requestRefresh,
  });

  registerHealthRoutes(app, handle);
  registerAuthRoutes(app, { config, sessions, throttle, isAuthenticated });
  registerApiRoutes(app, {
    handle,
    config,
    isAuthenticated,
    publicConfig: publicConfig(config),
    onRefreshRequested: () => runner.wake(),
  });
  await registerStatic(app);

  if (options.startBackground ?? config.nodeEnv !== "test") {
    runner.start();
    scheduler.start();
    // Daily snapshot; failures are logged, never fatal.
    stopBackups = scheduleBackups(handle.sqlite, {
      databasePath: config.databasePath,
      backupDir: config.backup.directory,
      keep: config.backup.keep,
      onError: (error) => app.log.error({ err: error }, "backup failed"),
    });
    stopRetention = scheduleRetention(handle, {
      days: config.retention.days,
      onError: (error) => app.log.error({ err: error }, "retention failed"),
    });
  }

  return {
    app,
    handle,
    runner,
    scheduler,
    model,
    close: async () => {
      stopBackups?.();
      stopRetention?.();
      scheduler.stop();
      runner.stop();
      await app.close();
      handle.close();
    },
  };
}
