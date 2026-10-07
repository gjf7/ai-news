import type { AppConfig } from "../config/env.ts";

/**
 * Minimal OpenAI-compatible chat client. The project only needs a single
 * non-streaming completion call, so this avoids pulling in a vendor SDK.
 *
 * Every call takes an AbortSignal so a stalled request cannot outlive the
 * run's overall deadline.
 */

export type ChatMessage = { role: "system" | "user"; content: string };

export type CompleteOptions = {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal: AbortSignal;
  /** Overrides the configured model, e.g. for a cheaper classification call. */
  model?: string;
};

export type ModelClient = {
  readonly name: string;
  complete: (options: CompleteOptions) => Promise<string>;
  /** True when an API key is configured; callers degrade when it is not. */
  readonly available: boolean;
};

export type ModelError = {
  kind: "http" | "network" | "malformed";
  message: string;
  status?: number;
};

export class ModelRequestError extends Error {
  readonly kind: ModelError["kind"];
  readonly status: number | undefined;

  constructor(error: ModelError) {
    super(error.message);
    this.name = "ModelRequestError";
    this.kind = error.kind;
    this.status = error.status;
  }
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

function retryDelayMs(attempt: number, response?: Response): number {
  const retryAfter = Number(response?.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  return 1_000 * 2 ** attempt;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Builds the chat-completions URL, tolerating a base that already ends in /v1. */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

export function createModelClient(
  config: AppConfig,
  fetchImpl: typeof globalThis.fetch,
): ModelClient {
  const { baseUrl, apiKey, name } = config.model;
  const endpoint = chatCompletionsUrl(baseUrl);

  return {
    name,
    available: Boolean(apiKey),

    async complete({ messages, maxTokens = 1024, temperature = 0.2, signal, model }) {
      if (!apiKey) {
        throw new ModelRequestError({ kind: "http", message: "no API key configured" });
      }

      const body = JSON.stringify({
        model: model ?? name,
        messages,
        max_tokens: maxTokens,
        temperature,
      });

      for (let attempt = 0; ; attempt += 1) {
        let response: Response;
        try {
          response = await fetchImpl(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body,
            signal,
          });
        } catch (error) {
          if (attempt >= MAX_ATTEMPTS) {
            throw new ModelRequestError({ kind: "network", message: String(error) });
          }
          await sleep(retryDelayMs(attempt));
          continue;
        }

        if (!response.ok) {
          if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
            await sleep(retryDelayMs(attempt, response));
            continue;
          }
          throw new ModelRequestError({
            kind: "http",
            message: `model returned ${response.status}`,
            status: response.status,
          });
        }

        const payload = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.length === 0) {
          throw new ModelRequestError({ kind: "malformed", message: "empty completion" });
        }
        return content;
      }
    },
  };
}
