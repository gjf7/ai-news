import { desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ConfigView,
  DeliveryList,
  EventDetail,
  EventList,
  EventQuery,
  FeedStatus,
  RunDetail,
  RunList,
  SourceView,
  type DeliveryView,
  type RunSummary,
} from "@ai-news/contracts";
import type { AppConfig, PublicConfig } from "../config/env.ts";
import type { DbHandle } from "../db/connection.ts";
import { deliveries, refreshRuns, sources } from "../db/schema.ts";
import { feedRevision, getEventDetail, listEvents } from "../news/queries.ts";
import { retryDelivery } from "../notifications/telegram.ts";
import { describeSchedule } from "../refresh/scheduler.ts";
import { findActiveRun, requestRefresh } from "../refresh/request.ts";

/**
 * Read and control endpoints. Everything except /health requires a session.
 * Write endpoints also verify the Origin header so a cross-site form cannot
 * trigger a refresh.
 */

export type ApiDeps = {
  handle: DbHandle;
  config: AppConfig;
  isAuthenticated: (request: FastifyRequest) => boolean;
  /** Injected so tests can observe refresh requests without a runner. */
  onRefreshRequested?: (receipt: { runId: string; disposition: string }) => void;
  publicConfig: PublicConfig;
};

const PAGE_SIZE = 20;

export function registerApiRoutes(app: FastifyInstance, deps: ApiDeps) {
  const { handle, config, isAuthenticated } = deps;

  const requireAuth = (request: FastifyRequest) => {
    if (!isAuthenticated(request)) {
      const error = new Error("Authentication required") as Error & { statusCode: number };
      error.statusCode = 401;
      throw error;
    }
  };

  const requireSameOrigin = (request: FastifyRequest) => {
    const origin = request.headers.origin;
    // Same-origin requests from the SPA carry Origin; a missing Origin means a
    // non-browser client (curl, tests), which still needs a valid session.
    if (origin && !origin.endsWith(new URL(`http://${request.headers.host}`).host)) {
      const error = new Error("Cross-origin write rejected") as Error & { statusCode: number };
      error.statusCode = 403;
      throw error;
    }
  };

  app.get("/api/events", async (request) => {
    requireAuth(request);
    const query = EventQuery.parse(request.query);
    return EventList.parse(listEvents(handle, query));
  });

  app.get("/api/events/:id", async (request, reply) => {
    requireAuth(request);
    const { id } = request.params as { id: string };
    const detail = getEventDetail(handle, id);
    if (!detail) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Event not found", requestId: request.id },
      });
    }
    return EventDetail.parse(detail);
  });

  app.get("/api/status", async (request) => {
    requireAuth(request);
    const active = findActiveRun(handle);
    const lastRun = handle.db
      .select()
      .from(refreshRuns)
      .orderBy(desc(refreshRuns.queuedAt))
      .limit(1)
      .get();
    const lastSuccess = handle.db
      .select()
      .from(refreshRuns)
      .where(eq(refreshRuns.state, "succeeded"))
      .orderBy(desc(refreshRuns.finishedAt))
      .limit(1)
      .get();

    return FeedStatus.parse({
      feedRevision: feedRevision(handle),
      activeRun: active
        ? { runId: active.id, state: active.state, progress: active.progress ?? null }
        : null,
      lastAttemptAt: lastRun?.finishedAt?.toISOString() ?? lastRun?.queuedAt?.toISOString() ?? null,
      lastSuccessAt: lastSuccess?.finishedAt?.toISOString() ?? null,
      nextScheduledAt: describeSchedule(handle, config.refresh.intervalMinutes).nextScheduledAt,
    });
  });

  app.post("/api/refresh-runs", async (request, reply) => {
    requireAuth(request);
    requireSameOrigin(request);

    // Cooldown: a manual refresh immediately after a run finished is refused
    // unless something is already in flight (which is reused, not refused).
    const active = findActiveRun(handle);
    if (!active && withinCooldown(handle, config.refresh.intervalMinutes)) {
      return reply.code(429).send({
        error: {
          code: "cooldown",
          message: "A refresh ran recently; wait for the next scheduled slot",
          requestId: request.id,
        },
      });
    }

    const receipt = requestRefresh({ trigger: "manual" }, { handle });
    deps.onRefreshRequested?.(receipt);

    // A no-op receipt has no run id; report the active run so the client polls it.
    if (!receipt.runId) {
      if (!active) {
        return reply.code(429).send({
          error: { code: "cooldown", message: "A refresh just ran", requestId: request.id },
        });
      }
      return reply.code(200).send({ ...receipt, runId: active.id, state: active.state });
    }

    return reply.code(receipt.disposition === "created" ? 202 : 200).send(receipt);
  });

  app.get("/api/refresh-runs", async (request) => {
    requireAuth(request);
    const page = Number((request.query as { page?: string }).page ?? 1) || 1;
    const rows = handle.db
      .select()
      .from(refreshRuns)
      .orderBy(desc(refreshRuns.queuedAt))
      .limit(PAGE_SIZE + 1)
      .offset((page - 1) * PAGE_SIZE)
      .all();

    return RunList.parse({
      items: rows.slice(0, PAGE_SIZE).map(toRunSummary),
      page,
      hasMore: rows.length > PAGE_SIZE,
    });
  });

  app.get("/api/refresh-runs/:id", async (request, reply) => {
    requireAuth(request);
    const { id } = request.params as { id: string };
    const run = handle.db.select().from(refreshRuns).where(eq(refreshRuns.id, id)).get();
    if (!run) {
      return reply.status(404).send({
        error: { code: "not_found", message: "Run not found", requestId: request.id },
      });
    }

    const rows = handle.sqlite
      .prepare(
        `SELECT sr.source_id AS sourceId, s.key AS key, sr.state AS state,
                sr.fetched AS fetched, sr.new_articles AS newArticles, sr.error AS error
         FROM source_runs sr JOIN sources s ON s.id = sr.source_id
         WHERE sr.run_id = ? ORDER BY s.key`,
      )
      .all(id) as {
      sourceId: string;
      key: string;
      state: string;
      fetched: number;
      newArticles: number;
      error: string | null;
    }[];

    // Events this run left in a failed analysis state, so the activity page can
    // explain what the model could not process.
    const failedEvents = handle.sqlite
      .prepare(
        `SELECT id, title, analysis_error AS error FROM events
         WHERE analysis_run_id = ? AND analysis_state = 'failed'
         ORDER BY updated_at DESC LIMIT 100`,
      )
      .all(id) as { id: string; title: string; error: string | null }[];

    return RunDetail.parse({
      ...toRunSummary(run),
      sources: rows,
      failedEvents,
    });
  });

  app.get("/api/sources", async (request) => {
    requireAuth(request);
    const rows = handle.db.select().from(sources).orderBy(sources.key).all();

    // Latest source_runs row per source, for the "last result" column.
    const latest = handle.sqlite
      .prepare(
        `SELECT source_id AS sourceId, fetched, new_articles AS newArticles
         FROM source_runs
         WHERE finished_at IS NOT NULL
         ORDER BY finished_at DESC`,
      )
      .all() as { sourceId: string; fetched: number; newArticles: number }[];
    const byId = new Map<string, { fetched: number; newArticles: number }>();
    for (const row of latest) {
      if (!byId.has(row.sourceId))
        byId.set(row.sourceId, { fetched: row.fetched, newArticles: row.newArticles });
    }

    return rows.map((row) =>
      SourceView.parse({
        id: row.id,
        key: row.key,
        adapter: row.adapter,
        enabled: row.enabled,
        analyze: row.analyze,
        topics: row.defaultTopics,
        status: row.status,
        statusReason: row.statusReason,
        lastFetched: byId.get(row.id)?.fetched ?? null,
        lastNewArticles: byId.get(row.id)?.newArticles ?? null,
      }),
    );
  });

  app.patch("/api/sources/:id", async (request, reply) => {
    requireAuth(request);
    requireSameOrigin(request);

    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { enabled?: unknown; filter?: unknown };

    // The only per-source setting any adapter supports today is `enabled`.
    // `filter` is accepted as a plain object so an adapter can expose extra
    // settings later without another migration.
    const patch: { enabled?: boolean; config?: Record<string, unknown> } = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (body.filter !== undefined) {
      if (typeof body.filter !== "object" || body.filter === null || Array.isArray(body.filter)) {
        return reply.code(400).send({
          error: {
            code: "invalid_request",
            message: "filter must be an object",
            requestId: request.id,
          },
        });
      }
      patch.config = body.filter as Record<string, unknown>;
    }

    if (patch.enabled === undefined && patch.config === undefined) {
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: "enabled must be a boolean or filter an object",
          requestId: request.id,
        },
      });
    }

    const result = handle.db.update(sources).set(patch).where(eq(sources.id, id)).run();
    if (result.changes === 0) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Source not found", requestId: request.id },
      });
    }
    return reply.code(204).send();
  });

  app.get("/api/deliveries", async (request) => {
    requireAuth(request);
    const page = Number((request.query as { page?: string }).page ?? 1) || 1;
    const rows = handle.db
      .select()
      .from(deliveries)
      .orderBy(desc(deliveries.createdAt))
      .limit(PAGE_SIZE + 1)
      .offset((page - 1) * PAGE_SIZE)
      .all();

    return DeliveryList.parse({
      items: rows.slice(0, PAGE_SIZE).map(toDeliveryView),
      page,
      hasMore: rows.length > PAGE_SIZE,
    });
  });

  app.post("/api/deliveries/:id/retry", async (request, reply) => {
    requireAuth(request);
    requireSameOrigin(request);
    const { id } = request.params as { id: string };

    if (!retryDelivery(handle, id)) {
      return reply.code(409).send({
        error: {
          code: "not_retryable",
          message: "Only failed deliveries can be retried",
          requestId: request.id,
        },
      });
    }
    return reply.code(202).send({ ok: true });
  });

  app.get("/api/config", async (request) => {
    requireAuth(request);
    return ConfigView.parse(deps.publicConfig);
  });
}

/**
 * A manual refresh is refused for a short window after the last finished run,
 * so holding the refresh button cannot hammer the sources. An active run is
 * always reusable, which is checked before this.
 */
function withinCooldown(handle: DbHandle, intervalMinutes: number): boolean {
  const last = handle.db
    .select({ finishedAt: refreshRuns.finishedAt })
    .from(refreshRuns)
    .where(inArray(refreshRuns.state, ["succeeded", "partial", "failed"]))
    .orderBy(desc(refreshRuns.finishedAt))
    .limit(1)
    .get();

  if (!last?.finishedAt) return false;
  const cooldownMs = Math.min(intervalMinutes * 60_000, 60_000);
  return Date.now() - last.finishedAt.getTime() < cooldownMs;
}

function toRunSummary(run: typeof refreshRuns.$inferSelect): RunSummary {
  return {
    id: run.id,
    trigger: run.trigger,
    state: run.state,
    attempt: run.attempt,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    result: run.result ?? null,
    progress: run.progress ?? null,
    error: run.error,
  };
}

function toDeliveryView(row: typeof deliveries.$inferSelect): DeliveryView {
  const items = Array.isArray(row.items) ? row.items : [];
  return {
    id: row.id,
    state: row.state,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    messageId: row.messageId,
    lastError: row.lastError,
    text: row.text,
    itemCount: items.length,
  };
}
