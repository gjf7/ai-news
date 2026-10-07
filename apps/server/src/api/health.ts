import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { HealthStatus } from "@ai-news/contracts";
import type { DbHandle } from "../db/connection.ts";

export function registerHealthRoutes(app: FastifyInstance, handle: DbHandle) {
  app.get("/api/health", async (_request, reply) => {
    let database: "ok" | "error" = "ok";
    try {
      handle.sqlite.prepare("SELECT 1").get();
    } catch {
      database = "error";
    }

    const status = database === "ok" ? "ok" : "degraded";
    if (status !== "ok") {
      reply.code(503);
    }
    return HealthStatus.parse({
      status,
      database,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  // Touch the schema so a missing migration surfaces as a degraded health
  // check rather than as a runtime failure on the first real query.
  app.addHook("onReady", async () => {
    handle.db.get(sql`select 1`);
  });
}
