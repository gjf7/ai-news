import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { LoginRequest, SessionState } from "@ai-news/contracts";
import type { AppConfig } from "../../config/env.ts";
import type { SessionStore } from "./session.ts";
import { verifyPassword } from "./password.ts";

/** Fixed-window limiter: enough to blunt brute force on a single-user login. */
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

export type LoginThrottle = {
  check: (key: string) => boolean;
  recordFailure: (key: string) => void;
  clear: (key: string) => void;
};

export function createLoginThrottle(): LoginThrottle {
  const attempts = new Map<string, { count: number; resetAt: number }>();

  const active = (key: string, now: number) => {
    const entry = attempts.get(key);
    if (!entry || entry.resetAt <= now) return undefined;
    return entry;
  };

  return {
    check(key) {
      const entry = active(key, Date.now());
      return !entry || entry.count < MAX_ATTEMPTS;
    },
    recordFailure(key) {
      const now = Date.now();
      const entry = active(key, now);
      if (entry) {
        entry.count += 1;
      } else {
        attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
      }
    },
    clear(key) {
      attempts.delete(key);
    },
  };
}

type Deps = {
  config: AppConfig;
  sessions: SessionStore;
  throttle: LoginThrottle;
  isAuthenticated: (request: FastifyRequest) => boolean;
};

export function registerAuthRoutes(
  app: FastifyInstance,
  { config, sessions, throttle, isAuthenticated }: Deps,
) {
  app.post("/api/session", async (request, reply: FastifyReply) => {
    const key = request.ip;
    if (!throttle.check(key)) {
      return reply.code(429).send({
        error: { code: "rate_limited", message: "Too many login attempts", requestId: request.id },
      });
    }

    let body: LoginRequest;
    try {
      body = LoginRequest.parse(request.body);
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.code(400).send({
          error: {
            code: "invalid_request",
            message: "Password is required",
            requestId: request.id,
          },
        });
      }
      throw error;
    }

    if (!(await verifyPassword(body.password, config.session.passwordHash))) {
      throttle.recordFailure(key);
      return reply.code(401).send({
        error: {
          code: "invalid_credentials",
          message: "Incorrect password",
          requestId: request.id,
        },
      });
    }

    throttle.clear(key);
    sessions.issue(reply);
    return reply.code(201).send(SessionState.parse({ authenticated: true }));
  });

  app.get("/api/session", async (request) => {
    return SessionState.parse({ authenticated: isAuthenticated(request) });
  });

  app.delete("/api/session", async (request, reply) => {
    sessions.revoke(request, reply);
    return reply.code(204).send();
  });
}
