import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * Serves the built SPA and falls back to index.html for client-side routes.
 * Only registered when a build is present, so development (Vite dev server
 * proxying /api) and tests are unaffected.
 */
export async function registerStatic(app: FastifyInstance): Promise<boolean> {
  const root = fileURLToPath(new URL("../../../web/dist", import.meta.url));
  if (!existsSync(root)) return false;

  await app.register(fastifyStatic, { root, wildcard: false });

  // SPA fallback: any non-API GET that is not a real file returns index.html.
  app.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET" || request.url.startsWith("/api/")) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Not found", requestId: request.id },
      });
    }
    return reply.sendFile("index.html");
  });

  return true;
}
