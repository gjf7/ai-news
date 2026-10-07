import { and, eq, gt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../../config/env.ts";
import type { DbHandle } from "../../db/connection.ts";
import { sessions } from "../../db/schema.ts";
import { createSessionToken, hashSessionToken } from "./password.ts";

export const SESSION_COOKIE = "ai_news_session";

export type SessionStore = {
  issue: (reply: FastifyReply) => string;
  resolve: (request: FastifyRequest) => boolean;
  revoke: (request: FastifyRequest, reply: FastifyReply) => void;
};

export function createSessionStore(handle: DbHandle, config: AppConfig): SessionStore {
  const { db } = handle;

  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.session.secureCookie,
    path: "/",
  };

  return {
    issue(reply) {
      const token = createSessionToken();
      const now = Date.now();
      db.insert(sessions)
        .values({
          tokenHash: hashSessionToken(token),
          createdAt: new Date(now),
          expiresAt: new Date(now + config.session.ttlHours * 60 * 60 * 1000),
        })
        .run();

      reply.setCookie(SESSION_COOKIE, token, {
        ...cookieOptions,
        maxAge: config.session.ttlHours * 60 * 60,
      });
      return token;
    },

    resolve(request) {
      const token = request.cookies[SESSION_COOKIE];
      if (!token) return false;

      // Use the core builder with `.get()`: better-sqlite3 is synchronous, and
      // the relational `db.query.*` API returns a thenable that would always be
      // truthy when checked without awaiting.
      const row = db
        .select({ tokenHash: sessions.tokenHash })
        .from(sessions)
        .where(
          and(eq(sessions.tokenHash, hashSessionToken(token)), gt(sessions.expiresAt, new Date())),
        )
        .get();
      return Boolean(row);
    },

    revoke(request, reply) {
      const token = request.cookies[SESSION_COOKIE];
      if (token) {
        db.delete(sessions)
          .where(eq(sessions.tokenHash, hashSessionToken(token)))
          .run();
      }
      reply.clearCookie(SESSION_COOKIE, cookieOptions);
    },
  };
}
